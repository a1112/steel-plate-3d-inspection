use super::*;
use crate::db::entities::production_task;
use std::cell::Cell;

const DEFAULT_QUEUE_CAPACITY: u64 = 128;
const MAX_QUEUE_CAPACITY: u64 = 4096;

fn queue_capacity() -> u64 {
    env::var("STEEL_PRODUCTION_TASK_QUEUE_CAPACITY")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_QUEUE_CAPACITY)
        .clamp(1, MAX_QUEUE_CAPACITY)
}

fn normalize_kind(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "capture" | "capture-once" | "capture_once" => Some("capture-once"),
        "algorithm" | "algorithm-run" | "algorithm_run" => Some("algorithm-run"),
        "steel-info" | "steel_info" | "steelinfo" | "info" => Some("steel-info"),
        "steel-in" | "steel_in" | "steelin" | "in" => Some("steel-in"),
        "steel-out" | "steel_out" | "steelout" | "out" => Some("steel-out"),
        "trigger-event" | "trigger_event" | "triggerevent" | "event" => {
            Some("trigger-event")
        }
        _ => None,
    }
}

pub(super) fn queued_kind_for_route(method: &str, path: &str) -> Option<&'static str> {
    if method != "POST" {
        return None;
    }
    match path {
        "/api/production/tasks/steel-info" => Some("steel-info"),
        "/api/production/tasks/steel-in" => Some("steel-in"),
        "/api/production/tasks/steel-out" => Some("steel-out"),
        "/api/production/tasks/trigger-event" => Some("trigger-event"),
        _ => None,
    }
}

thread_local! {
    static WORKER_EXECUTION_DEPTH: Cell<u32> = const { Cell::new(0) };
}

struct WorkerExecutionScope;

impl WorkerExecutionScope {
    fn enter() -> Self {
        WORKER_EXECUTION_DEPTH.with(|depth| depth.set(depth.get().saturating_add(1)));
        Self
    }
}

impl Drop for WorkerExecutionScope {
    fn drop(&mut self) {
        WORKER_EXECUTION_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

pub(super) fn worker_execution_scope_active() -> bool {
    WORKER_EXECUTION_DEPTH.with(|depth| depth.get() > 0)
}

fn task_json(task: &production_task::Model) -> Value {
    let result = if task.result.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&task.result).unwrap_or_else(|_| json!(task.result))
    };
    json!({
        "id": task.id,
        "taskId": task.id,
        "idempotencyKey": task.idempotency_key,
        "kind": task.kind,
        "materialId": task.material_id,
        "sessionId": task.session_id,
        "status": task.status,
        "phase": task.phase,
        "progress": task.progress,
        "attempts": task.attempts,
        "maxAttempts": task.max_attempts,
        "cancelRequested": task.cancel_requested,
        "result": result,
        "error": task.error,
        "actor": task.actor,
        "createdAt": task.created_at,
        "startedAt": task.started_at,
        "finishedAt": task.finished_at,
        "updatedAt": task.updated_at
    })
}

fn worker_json(state: &ServiceState) -> Value {
    let status = state
        .production_task_worker_status
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    let now = current_time_millis();
    json!({
        "running": status.running,
        "activeTaskId": if status.current_task_id.is_empty() { Value::Null } else { json!(status.current_task_id) },
        "lastHeartbeatAt": status.last_heartbeat_at.to_string(),
        "heartbeatAgeMs": if status.last_heartbeat_at == 0 { 0 } else { now.saturating_sub(status.last_heartbeat_at) },
        "lastError": status.last_error,
        "recoveredTasks": status.recovered_tasks,
        "capacity": queue_capacity()
    })
}

pub(super) fn status_json(state: &ServiceState) -> Value {
    let queue_depth = state
        .runtime
        .block_on(db::count_open_production_tasks(&state.database.connection))
        .unwrap_or(0);
    json!({
        "worker": worker_json(state),
        "queueDepth": queue_depth,
        "capacity": queue_capacity()
    })
}

fn notify_worker(state: &ServiceState) {
    if let Ok(mut generation) = state.production_task_wakeup_generation.lock() {
        *generation = generation.wrapping_add(1);
        state.production_task_wakeup.notify_one();
    }
}

fn task_target(state: &ServiceState, payload: &Value) -> (String, String) {
    let latest_open = state
        .runtime
        .block_on(db::latest_open_material_session(&state.database.connection))
        .ok()
        .flatten();
    let requested_material_id = material_id_from_payload(payload, "");
    let latest_task = state
        .runtime
        .block_on(db::latest_open_production_task(
            &state.database.connection,
            (!requested_material_id.is_empty()).then_some(requested_material_id.as_str()),
        ))
        .ok()
        .flatten();
    let material_id = if requested_material_id.is_empty() {
        latest_open
            .as_ref()
            .map(|session| session.material_id.clone())
            .or_else(|| latest_task.as_ref().map(|task| task.material_id.clone()))
            .unwrap_or_else(|| "unknown-material".to_string())
    } else {
        requested_material_id
    };
    let explicit_session_id = value_string(payload, &["sessionId", "session_id"]);
    let session_id = if explicit_session_id.is_empty() {
        latest_open
            .as_ref()
            .filter(|session| session.material_id == material_id)
            .map(|session| session.id.clone())
            .or_else(|| {
                latest_task
                    .as_ref()
                    .filter(|task| task.material_id == material_id)
                    .map(|task| task.session_id.clone())
            })
            .unwrap_or_else(|| session_id_from_payload(payload, &material_id))
    } else {
        explicit_session_id
    };
    (material_id, session_id)
}

fn task_admin_guard(state: &ServiceState) -> Result<std::sync::MutexGuard<'_, ()>, Vec<u8>> {
    state.production_task_admin_lock.lock().map_err(|_| {
        http_response(
            "503 Service Unavailable",
            "application/json; charset=utf-8",
            &json!({ "code": 503, "error": "production_task_admin_lock_poisoned" }).to_string(),
        )
    })
}

pub(super) fn enqueue_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let request = match serde_json::from_str::<Value>(body.trim()) {
        Ok(value) if value.is_object() => value,
        _ => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                &json!({ "code": 400, "error": "invalid_production_task_json" }).to_string(),
            );
        }
    };
    let Some(kind) = normalize_kind(&value_string(&request, &["kind", "type", "command"])) else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({
                "code": 400,
                "error": "unsupported_production_task_kind",
                "supportedKinds": [
                    "capture-once",
                    "algorithm-run",
                    "steel-info",
                    "steel-in",
                    "steel-out",
                    "trigger-event"
                ]
            })
            .to_string(),
        );
    };
    let payload = request.get("payload").cloned().unwrap_or_else(|| json!({}));
    if !payload.is_object() {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "production_task_payload_must_be_object" }).to_string(),
        );
    }
    let raw_key = value_string(
        &request,
        &["idempotencyKey", "idempotency_key", "requestId", "request_id"],
    );
    if raw_key.len() > 160 {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "idempotency_key_too_long" }).to_string(),
        );
    }
    let payload_text = payload.to_string();
    let _admin_guard = match task_admin_guard(state) {
        Ok(guard) => guard,
        Err(response) => return response,
    };
    let compound_key = if raw_key.trim().is_empty() {
        String::new()
    } else {
        format!("{kind}:{}", raw_key.trim())
    };
    if !compound_key.is_empty() {
        match state.runtime.block_on(db::find_production_task_by_idempotency_key(
            &state.database.connection,
            &compound_key,
        )) {
            Ok(Some(existing)) => {
                if existing.kind != kind || existing.payload != payload_text {
                    return http_response(
                        "409 Conflict",
                        "application/json; charset=utf-8",
                        &json!({
                            "code": 409,
                            "error": "idempotency_conflict",
                            "task": task_json(&existing)
                        })
                        .to_string(),
                    );
                }
                return http_response(
                    "200 OK",
                    "application/json; charset=utf-8",
                    &json!({ "code": 0, "duplicate": true, "task": task_json(&existing) })
                        .to_string(),
                );
            }
            Ok(None) => {}
            Err(error) => {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &json!({ "code": 500, "error": error.to_string() }).to_string(),
                );
            }
        }
    }
    // Replays must return the persisted task even if the surrounding production session has
    // since advanced. Production state is deliberately validated by the FIFO worker at execution
    // time so steel-in, capture, algorithm and steel-out can be accepted as one ordered chain.
    let open_tasks = match state
        .runtime
        .block_on(db::count_open_production_tasks(&state.database.connection))
    {
        Ok(count) => count,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            );
        }
    };
    if open_tasks >= queue_capacity() {
        return http_response(
            "429 Too Many Requests",
            "application/json; charset=utf-8",
            &json!({
                "code": 429,
                "error": "production_task_queue_full",
                "queueDepth": open_tasks,
                "capacity": queue_capacity()
            })
            .to_string(),
        );
    }
    let sequence = state
        .production_task_sequence
        .fetch_add(1, Ordering::Relaxed);
    let task_id = format!("TASK-{}-{sequence:020}", current_time_millis());
    let stored_key = if compound_key.is_empty() {
        format!("{kind}:{task_id}")
    } else {
        compound_key
    };
    let (material_id, session_id) = task_target(state, &payload);
    let max_attempts = request
        .get("maxAttempts")
        .or_else(|| request.get("max_attempts"))
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 10) as i32;
    let task = match state.runtime.block_on(db::insert_production_task(
        &state.database.connection,
        db::ProductionTaskInput {
            id: task_id,
            idempotency_key: stored_key,
            kind: kind.to_string(),
            material_id,
            session_id,
            payload: payload_text,
            actor: actor.to_string(),
            max_attempts,
        },
    )) {
        Ok(task) => task,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            );
        }
    };
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        "production.task.enqueue",
        &task.id,
        &format!("queued {} for {}", task.kind, task.material_id),
        "info",
    ));
    notify_worker(state);
    http_response(
        "202 Accepted",
        "application/json; charset=utf-8",
        &json!({ "code": 0, "duplicate": false, "task": task_json(&task) }).to_string(),
    )
}

pub(super) fn enqueue_kind_response(
    state: &ServiceState,
    kind: &str,
    body: &str,
    actor: &str,
) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(value) if value.is_object() => value,
        _ => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                &json!({ "code": 400, "error": "invalid_production_task_payload" }).to_string(),
            );
        }
    };
    let idempotency_key = value_string(
        &payload,
        &["idempotencyKey", "idempotency_key", "requestId", "request_id"],
    );
    let max_attempts = payload
        .get("maxAttempts")
        .or_else(|| payload.get("max_attempts"))
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 10);
    enqueue_response(
        state,
        &json!({
            "kind": kind,
            "idempotencyKey": idempotency_key,
            "maxAttempts": max_attempts,
            "payload": payload
        })
        .to_string(),
        actor,
    )
}

pub(super) fn list_response(state: &ServiceState, query: &str) -> Vec<u8> {
    let limit = query_value(query, "limit").and_then(|value| value.parse::<u64>().ok());
    let offset = query_value(query, "offset")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    match state.runtime.block_on(db::list_production_tasks(
        &state.database.connection,
        db::ProductionTaskFilter {
            status: query_value(query, "status"),
            kind: query_value(query, "kind"),
            limit,
            offset: Some(offset),
        },
    )) {
        Ok(page) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &json!({
                "code": 0,
                "total": page.total,
                "limit": page.limit,
                "offset": page.offset,
                "tasks": page.tasks.iter().map(task_json).collect::<Vec<_>>(),
                "taskWorker": worker_json(state)
            })
            .to_string(),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        ),
    }
}

pub(super) fn detail_response(state: &ServiceState, query: &str) -> Vec<u8> {
    let id = query_value(query, "id").unwrap_or_default();
    if id.trim().is_empty() {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "production_task_id_required" }).to_string(),
        );
    }
    match state
        .runtime
        .block_on(db::find_production_task(&state.database.connection, id.trim()))
    {
        Ok(Some(task)) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &json!({ "code": 0, "task": task_json(&task) }).to_string(),
        ),
        Ok(None) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            &json!({ "code": 404, "error": "production_task_not_found" }).to_string(),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        ),
    }
}

fn task_id_from_body(body: &str) -> Result<String, Vec<u8>> {
    let payload = serde_json::from_str::<Value>(body.trim()).map_err(|_| {
        http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "invalid_production_task_action_json" }).to_string(),
        )
    })?;
    let id = value_string(&payload, &["taskId", "task_id", "id"]);
    if id.trim().is_empty() {
        Err(http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "production_task_id_required" }).to_string(),
        ))
    } else {
        Ok(id)
    }
}

pub(super) fn cancel_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let id = match task_id_from_body(body) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let _admin_guard = match task_admin_guard(state) {
        Ok(guard) => guard,
        Err(response) => return response,
    };
    let existing = match state
        .runtime
        .block_on(db::find_production_task(&state.database.connection, &id))
    {
        Ok(Some(task)) => task,
        Ok(None) => {
            return http_response(
                "404 Not Found",
                "application/json; charset=utf-8",
                &json!({ "code": 404, "error": "production_task_not_found" }).to_string(),
            );
        }
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            );
        }
    };
    if matches!(
        existing.status.as_str(),
        "succeeded" | "failed" | "cancelled" | "interrupted"
    ) {
        return http_response(
            "409 Conflict",
            "application/json; charset=utf-8",
            &json!({
                "code": 409,
                "error": "production_task_is_terminal",
                "task": task_json(&existing)
            })
            .to_string(),
        );
    }
    match state.runtime.block_on(db::request_cancel_production_task(
        &state.database.connection,
        &id,
    )) {
        Ok(Some(task)) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "production.task.cancel",
                &task.id,
                "cancellation requested",
                "warning",
            ));
            notify_worker(state);
            http_response(
                if task.status == "running" { "202 Accepted" } else { "200 OK" },
                "application/json; charset=utf-8",
                &json!({ "code": 0, "task": task_json(&task) }).to_string(),
            )
        }
        Ok(None) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            &json!({ "code": 404, "error": "production_task_not_found" }).to_string(),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        ),
    }
}

pub(super) fn retry_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let id = match task_id_from_body(body) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let _admin_guard = match task_admin_guard(state) {
        Ok(guard) => guard,
        Err(response) => return response,
    };
    let existing = match state
        .runtime
        .block_on(db::find_production_task(&state.database.connection, &id))
    {
        Ok(Some(task)) => task,
        Ok(None) => {
            return http_response(
                "404 Not Found",
                "application/json; charset=utf-8",
                &json!({ "code": 404, "error": "production_task_not_found" }).to_string(),
            );
        }
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            );
        }
    };
    if !matches!(existing.status.as_str(), "failed" | "cancelled" | "interrupted") {
        return http_response(
            "409 Conflict",
            "application/json; charset=utf-8",
            &json!({
                "code": 409,
                "error": "production_task_not_retryable",
                "task": task_json(&existing)
            })
            .to_string(),
        );
    }
    match state
        .runtime
        .block_on(db::retry_production_task(&state.database.connection, &id))
    {
        Ok(Some(task)) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "production.task.retry",
                &task.id,
                &format!("explicit retry after {} attempt(s)", task.attempts),
                "warning",
            ));
            notify_worker(state);
            http_response(
                "202 Accepted",
                "application/json; charset=utf-8",
                &json!({ "code": 0, "task": task_json(&task) }).to_string(),
            )
        }
        Ok(None) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            &json!({ "code": 404, "error": "production_task_not_found" }).to_string(),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        ),
    }
}

pub(super) fn response_body(response: &[u8]) -> String {
    response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| String::from_utf8_lossy(&response[index + 4..]).to_string())
        .unwrap_or_else(|| String::from_utf8_lossy(response).to_string())
}

fn response_succeeded(response: &[u8], body: &str) -> bool {
    let status_ok = String::from_utf8_lossy(response)
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .map(|status| (200..300).contains(&status))
        .unwrap_or(false);
    if !status_ok {
        return false;
    }
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("code").and_then(Value::as_i64))
        .map(|code| code == 0)
        .unwrap_or(true)
}

fn response_error(response: &[u8], body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| {
            String::from_utf8_lossy(response)
                .lines()
                .next()
                .unwrap_or("production task failed")
                .to_string()
        })
}

fn production_event_payload(task: &production_task::Model) -> String {
    let mut payload = serde_json::from_str::<Value>(&task.payload).unwrap_or_else(|_| json!({}));
    let missing_material_id = material_id_from_payload(&payload, "").is_empty();
    let missing_session_id = value_string(&payload, &["sessionId", "session_id"]).is_empty();
    let Some(object) = payload.as_object_mut() else {
        return task.payload.clone();
    };
    if missing_material_id {
        object.insert("materialId".to_string(), json!(task.material_id));
    }
    if missing_session_id {
        object.insert("sessionId".to_string(), json!(task.session_id));
    }
    payload.to_string()
}

pub(super) fn execute_task(state: &ServiceState, task: &production_task::Model) -> Vec<u8> {
    let _execution_scope = WorkerExecutionScope::enter();
    match task.kind.as_str() {
        "capture-once" => write_production_capture_once_response(state, &task.payload, &task.actor),
        "algorithm-run" => {
            let payload = serde_json::from_str::<Value>(&task.payload).unwrap_or_else(|_| json!({}));
            if value_string(&payload, &["operation", "operationType"])
                == "calibration-capture-fit"
            {
                write_production_calibration_capture_fit_response(
                    state,
                    &task.payload,
                    &task.actor,
                )
            } else {
                write_production_algorithm_run_response(state, &task.payload, &task.actor)
            }
        }
        "steel-info" | "steel-in" | "steel-out" | "trigger-event" => {
            let payload = production_event_payload(task);
            write_production_event_response(state, &payload, &task.kind, &task.actor)
        }
        _ => http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "unsupported_production_task_kind" }).to_string(),
        ),
    }
}

pub(super) fn provider_terminal_outcome(
    response: &[u8],
    body: &str,
) -> (&'static str, i32, String) {
    if response_succeeded(response, body) {
        ("succeeded", 100, String::new())
    } else {
        ("failed", 100, response_error(response, body))
    }
}

fn dispatch_phase(kind: &str) -> &'static str {
    match kind {
        "capture-once" => "dispatching-capture-provider",
        "algorithm-run" => "dispatching-algorithm",
        "steel-info" => "dispatching-steel-info",
        "steel-in" => "dispatching-steel-in",
        "steel-out" => "dispatching-steel-out",
        "trigger-event" => "dispatching-trigger-event",
        _ => "dispatching-production-operation",
    }
}

fn persist_task_checkpoint(
    state: &ServiceState,
    task: &production_task::Model,
    phase: &str,
    progress: i32,
) {
    if let Err(error) = state.runtime.block_on(db::update_production_task_progress(
        &state.database.connection,
        &task.id,
        phase,
        progress,
    )) {
        set_worker_status(state, true, Some(&task.id), Some(error.to_string()));
    }
}

fn set_worker_status(
    state: &ServiceState,
    running: bool,
    current_task_id: Option<&str>,
    last_error: Option<String>,
) {
    if let Ok(mut status) = state.production_task_worker_status.lock() {
        status.running = running;
        status.last_heartbeat_at = current_time_millis();
        if let Some(id) = current_task_id {
            status.current_task_id = id.to_string();
        } else {
            status.current_task_id.clear();
        }
        if let Some(error) = last_error {
            status.last_error = error;
        }
    }
}

fn wait_for_work(state: &ServiceState) {
    if let Ok(generation) = state.production_task_wakeup_generation.lock() {
        let observed = *generation;
        let _ = state
            .production_task_wakeup
            .wait_timeout_while(generation, Duration::from_millis(500), |value| {
                *value == observed
            });
    } else {
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn worker_loop(state: Arc<ServiceState>) {
    set_worker_status(&state, true, None, None);
    loop {
        set_worker_status(&state, true, None, None);
        let claimed = state
            .runtime
            .block_on(db::claim_next_production_task(&state.database.connection));
        let task = match claimed {
            Ok(Some(task)) => task,
            Ok(None) => {
                wait_for_work(&state);
                continue;
            }
            Err(error) => {
                set_worker_status(&state, true, None, Some(error.to_string()));
                wait_for_work(&state);
                continue;
            }
        };
        set_worker_status(&state, true, Some(&task.id), None);
        persist_task_checkpoint(&state, &task, "waiting-command-lane", 10);
        let latest = state
            .runtime
            .block_on(db::find_production_task(&state.database.connection, &task.id))
            .ok()
            .flatten();
        if latest.as_ref().map(|item| item.cancel_requested).unwrap_or(false) {
            let _ = state.runtime.block_on(db::finish_production_task(
                &state.database.connection,
                &task.id,
                "cancelled",
                0,
                String::new(),
                "cancelled before dispatch".to_string(),
            ));
            continue;
        }
        let response = match state.production_command_lock.lock() {
            Ok(_command_guard) => {
                let cancelled = state
                    .runtime
                    .block_on(db::find_production_task(&state.database.connection, &task.id))
                    .ok()
                    .flatten()
                    .map(|item| item.cancel_requested)
                    .unwrap_or(false);
                if cancelled {
                    None
                } else {
                    persist_task_checkpoint(&state, &task, dispatch_phase(&task.kind), 25);
                    Some(execute_task(&state, &task))
                }
            }
            Err(_) => Some(http_response(
                "503 Service Unavailable",
                "application/json; charset=utf-8",
                &json!({ "code": 503, "error": "production_command_lock_poisoned" }).to_string(),
            )),
        };
        let Some(response) = response else {
            let _ = state.runtime.block_on(db::finish_production_task(
                &state.database.connection,
                &task.id,
                "cancelled",
                0,
                String::new(),
                "cancelled before dispatch".to_string(),
            ));
            continue;
        };
        persist_task_checkpoint(&state, &task, "finalizing-result", 90);
        let body = response_body(&response);
        let cancellation_requested = state
            .runtime
            .block_on(db::find_production_task(&state.database.connection, &task.id))
            .ok()
            .flatten()
            .map(|item| item.cancel_requested)
            .unwrap_or(false);
        // A running provider call cannot currently be interrupted. Once dispatch has crossed that
        // boundary, its real result remains authoritative; cancel_requested records the late intent
        // instead of falsely claiming that a completed camera side effect was cancelled.
        let (status, progress, error) = provider_terminal_outcome(&response, &body);
        if cancellation_requested {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                &task.actor,
                "production.task.cancel_too_late",
                &task.id,
                &format!("provider completed with terminal status {status}"),
                "warning",
            ));
        }
        if let Err(error) = state.runtime.block_on(db::finish_production_task(
            &state.database.connection,
            &task.id,
            status,
            progress,
            body,
            error,
        )) {
            set_worker_status(&state, true, Some(&task.id), Some(error.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durable_task_dispatch_phases_are_operation_specific() {
        assert_eq!(dispatch_phase("capture-once"), "dispatching-capture-provider");
        assert_eq!(dispatch_phase("algorithm-run"), "dispatching-algorithm");
        assert_eq!(dispatch_phase("steel-info"), "dispatching-steel-info");
        assert_eq!(dispatch_phase("steel-in"), "dispatching-steel-in");
        assert_eq!(dispatch_phase("steel-out"), "dispatching-steel-out");
        assert_eq!(dispatch_phase("trigger-event"), "dispatching-trigger-event");
    }

    #[test]
    fn provider_result_is_authoritative_after_dispatch_boundary() {
        let success = http_response(
            "200 OK",
            "application/json; charset=utf-8",
            r#"{"code":0}"#,
        );
        let success_body = response_body(&success);
        assert_eq!(
            provider_terminal_outcome(&success, &success_body),
            ("succeeded", 100, String::new())
        );

        let failure = http_response(
            "200 OK",
            "application/json; charset=utf-8",
            r#"{"code":503,"error":"capture_provider_offline"}"#,
        );
        let failure_body = response_body(&failure);
        let outcome = provider_terminal_outcome(&failure, &failure_body);
        assert_eq!(outcome.0, "failed");
        assert!(outcome.2.contains("capture_provider_offline"));
    }
}

pub(super) fn start_worker(state: Arc<ServiceState>) {
    let recovered = state
        .runtime
        .block_on(db::recover_incomplete_production_tasks(
            &state.database.connection,
        ))
        .unwrap_or(0);
    if let Ok(mut status) = state.production_task_worker_status.lock() {
        status.recovered_tasks = recovered;
        status.last_heartbeat_at = current_time_millis();
    }
    let worker_state = Arc::clone(&state);
    if let Err(error) = std::thread::Builder::new()
        .name("production-task-worker".to_string())
        .spawn(move || worker_loop(worker_state))
    {
        set_worker_status(&state, false, None, Some(error.to_string()));
    }
}
