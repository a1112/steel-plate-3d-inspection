use super::{
    capture_proxy_http_response, capture_proxy_status, http_bytes_response_with_headers,
    http_response, query_value, validate_capture_device_mutation_request, CaptureProxyResponse,
    ServiceState,
};
use crate::db;
use crate::db::entities::calibration_operation;
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{json, Map, Value};
use std::fmt;
use std::time::Duration;

const APPLY_PATH: &str = "/api/calibration/apply-all";
const ROLLBACK_PATH: &str = "/api/calibration/rollback";
const OPERATION_ID_MAX_BYTES: usize = 128;

fn operation_kind(path: &str) -> Option<&'static str> {
    match path {
        APPLY_PATH => Some("apply-all"),
        ROLLBACK_PATH => Some("rollback"),
        _ => None,
    }
}

struct UniqueJsonSeed;

struct UniqueJsonVisitor;

impl<'de> DeserializeSeed<'de> for UniqueJsonSeed {
    type Value = Value;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_any(UniqueJsonVisitor)
    }
}

impl<'de> Visitor<'de> for UniqueJsonVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value without duplicate object keys")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        serde_json::Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Value::String(value.to_string()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(Value::String(value))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        UniqueJsonSeed.deserialize(deserializer)
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(UniqueJsonSeed)? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }

    fn visit_map<A>(self, mut object: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut values = Map::new();
        while let Some(key) = object.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom(format!("duplicate JSON key: {key}")));
            }
            values.insert(key, object.next_value_seed(UniqueJsonSeed)?);
        }
        Ok(Value::Object(values))
    }
}

fn parse_unique_json(body: &str) -> Result<Value, &'static str> {
    let mut deserializer = serde_json::Deserializer::from_str(body.trim());
    let value = UniqueJsonSeed
        .deserialize(&mut deserializer)
        .map_err(|_| "invalid_or_duplicate_calibration_operation_json")?;
    deserializer
        .end()
        .map_err(|_| "invalid_or_duplicate_calibration_operation_json")?;
    Ok(value)
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            let mut normalized = Map::new();
            for (key, value) in entries {
                normalized.insert(key.clone(), canonicalize(value));
            }
            Value::Object(normalized)
        }
        Value::Array(values) => Value::Array(values.iter().map(canonicalize).collect()),
        _ => value.clone(),
    }
}

fn normalized_request(body: &str) -> Result<(String, String), &'static str> {
    let mut value = parse_unique_json(body)?;
    let object = value
        .as_object_mut()
        .ok_or("calibration_operation_json_object_required")?;
    let operation_id = object
        .get("operationId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("calibration_operation_id_required")?;
    if operation_id.len() > OPERATION_ID_MAX_BYTES {
        return Err("calibration_operation_id_too_long");
    }
    if !operation_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err("calibration_operation_id_invalid");
    }
    let operation_id = operation_id.to_string();
    object.insert(
        "operationId".to_string(),
        Value::String(operation_id.clone()),
    );
    let request_json = serde_json::to_string(&canonicalize(&value))
        .map_err(|_| "calibration_operation_normalization_failed")?;
    Ok((operation_id, request_json))
}

fn valid_operation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= OPERATION_ID_MAX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

pub(super) fn apply_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let value = match parse_unique_json(body) {
        Ok(value) => value,
        Err(error) => return validation_error_response(error),
    };
    let normalized_body = match serde_json::to_string(&canonicalize(&value)) {
        Ok(value) => value,
        Err(_) => return validation_error_response("calibration_operation_normalization_failed"),
    };
    if let Err(error) = validate_capture_device_mutation_request(APPLY_PATH, &normalized_body) {
        return validation_error_response(error);
    }
    if value.get("dryRun").and_then(Value::as_bool) == Some(true) {
        return capture_proxy_http_response(
            &state.capture,
            "POST",
            APPLY_PATH,
            APPLY_PATH,
            &normalized_body,
        );
    }
    mutation_response(state, APPLY_PATH, &normalized_body, actor)
}

fn request_hash(kind: &str, request_json: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in kind
        .as_bytes()
        .iter()
        .chain(std::iter::once(&b'\n'))
        .chain(request_json.as_bytes())
    {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64-{hash:016x}")
}

fn operation_value(operation: &calibration_operation::Model, replayed: bool) -> Value {
    let request = serde_json::from_str::<Value>(&operation.request_json)
        .unwrap_or_else(|_| Value::String(operation.request_json.clone()));
    let provider_body = if operation.provider_response_body.is_empty() {
        Value::Null
    } else {
        serde_json::from_str::<Value>(&operation.provider_response_body)
            .unwrap_or_else(|_| Value::String(operation.provider_response_body.clone()))
    };
    json!({
        "schema": "steel.service.calibration-operation.v1",
        "code": 0,
        "operationId": operation.id,
        "kind": operation.kind,
        "requestHash": operation.request_hash,
        "request": request,
        "status": operation.status,
        "needsReconciliation": operation.status == "needs-reconciliation",
        "providerHttpStatus": operation.provider_http_status,
        "providerResponse": provider_body,
        "error": operation.error,
        "actor": operation.actor,
        "parentOperationId": operation.parent_operation_id,
        "reconciliationOutcome": operation.reconciliation_outcome,
        "reconciliationId": operation.reconciliation_id,
        "resolvedBy": operation.resolved_by,
        "resolvedAt": operation.resolved_at,
        "rowVersion": operation.row_version,
        "createdAt": operation.created_at,
        "dispatchStartedAt": operation.dispatch_started_at,
        "finishedAt": operation.finished_at,
        "updatedAt": operation.updated_at,
        "replayed": replayed
    })
}

fn operation_http_response(
    status: &str,
    operation: &calibration_operation::Model,
    replayed: bool,
) -> Vec<u8> {
    http_response(
        status,
        "application/json; charset=utf-8",
        &operation_value(operation, replayed).to_string(),
    )
}

fn replay_response(operation: &calibration_operation::Model) -> Vec<u8> {
    match operation.status.as_str() {
        "dispatching" => operation_http_response("202 Accepted", operation, true),
        "succeeded" | "failed"
            if operation.provider_http_status > 0
                && !operation.provider_response_body.is_empty() =>
        {
            http_bytes_response_with_headers(
                &capture_proxy_status(operation.provider_http_status as u16),
                "application/json; charset=utf-8",
                operation.provider_response_body.as_bytes(),
                &[],
            )
        }
        "needs-reconciliation" => operation_http_response("409 Conflict", operation, true),
        "succeeded" | "failed" | "reconciled" => operation_http_response("200 OK", operation, true),
        _ => operation_http_response("500 Internal Server Error", operation, true),
    }
}

fn conflict_response(operation_id: &str) -> Vec<u8> {
    http_response(
        "409 Conflict",
        "application/json; charset=utf-8",
        &json!({
            "code": 409,
            "error": "calibration_operation_id_conflict",
            "operationId": operation_id
        })
        .to_string(),
    )
}

fn operation_in_progress_response(operation_id: &str) -> Vec<u8> {
    http_response(
        "409 Conflict",
        "application/json; charset=utf-8",
        &json!({
            "code": 409,
            "error": "calibration_operation_in_progress",
            "operationId": operation_id,
            "retryable": true
        })
        .to_string(),
    )
}

fn reconciliation_required_response(
    request_target: &str,
    unresolved: &[calibration_operation::Model],
) -> Vec<u8> {
    let mut body = json!({
        "code": 423,
        "error": "calibration_reconciliation_required",
        "requestTarget": request_target,
        "unresolvedOperations": unresolved.iter().map(|item| json!({
            "operationId": &item.id,
            "kind": &item.kind,
            "status": &item.status,
            "error": &item.error,
            "expectedApplyOperationId": expected_apply_operation_id(item),
            "updatedAt": &item.updated_at
        })).collect::<Vec<_>>()
    });
    if valid_operation_id(request_target) {
        body["operationId"] = json!(request_target);
    }
    http_response(
        "423 Locked",
        "application/json; charset=utf-8",
        &body.to_string(),
    )
}

fn request_operation_id(request_json: &str, field: &str) -> String {
    serde_json::from_str::<Value>(request_json)
        .ok()
        .and_then(|value| {
            value
                .get(field)
                .and_then(Value::as_str)
                .map(str::trim)
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn expected_apply_operation_id(operation: &calibration_operation::Model) -> String {
    match operation.kind.as_str() {
        "apply" | "apply-all" => operation.id.clone(),
        "rollback" => request_operation_id(&operation.request_json, "applyOperationId"),
        _ => String::new(),
    }
}

pub(super) fn mutation_requires_reconciliation_fence(method: &str, path: &str) -> bool {
    method == "POST"
        && matches!(
            path,
            "/api/calibration/load"
                | "/api/roi/load"
                | "/api/calibration/active"
                | "/api/config/profile/save"
                | "/api/config/profile/import"
                | "/api/config/profile/apply"
                | "/api/config/camera-params/save-all"
                | "/api/config/camera-params/load-all"
                | "/api/param"
                | "/api/param/save-device"
                | "/api/param/save-to-device"
                | "/api/param/load-file"
                | "/api/param/recovery"
                | "/api/capture/preset/line-continuous"
        )
}

pub(super) fn reconciliation_fence_response(
    state: &ServiceState,
    operation_id: &str,
) -> Option<Vec<u8>> {
    match state
        .runtime
        .block_on(db::list_unresolved_calibration_operations(
            &state.database.connection,
        )) {
        Ok(unresolved) if unresolved.is_empty() => None,
        Ok(unresolved) => Some(reconciliation_required_response(operation_id, &unresolved)),
        Err(_) => Some(database_error_response(
            "calibration_operation_fence_lookup_failed",
        )),
    }
}

fn database_error_response(error: &str) -> Vec<u8> {
    http_response(
        "500 Internal Server Error",
        "application/json; charset=utf-8",
        &json!({ "code": 500, "error": error }).to_string(),
    )
}

fn validation_error_response(error: &str) -> Vec<u8> {
    http_response(
        "400 Bad Request",
        "application/json; charset=utf-8",
        &json!({ "code": 400, "error": error }).to_string(),
    )
}

fn matches_request(
    operation: &calibration_operation::Model,
    kind: &str,
    hash: &str,
    request_json: &str,
) -> bool {
    operation.kind == kind
        && operation.request_hash == hash
        && operation.request_json == request_json
}

fn provider_terminal_status(
    kind: &str,
    response: &CaptureProxyResponse,
) -> (&'static str, &'static str) {
    let Some(body) = serde_json::from_slice::<Value>(&response.body).ok() else {
        return (
            "needs-reconciliation",
            "capture_provider_response_not_decisive",
        );
    };
    if kind == "apply-all"
        && body.get("rollbackPerformed").and_then(Value::as_bool) == Some(true)
        && body.get("rollbackComplete").and_then(Value::as_bool) == Some(false)
    {
        return (
            "needs-reconciliation",
            "capture_provider_automatic_rollback_incomplete",
        );
    }
    if kind == "rollback"
        && body.get("sideEffects").and_then(Value::as_bool) == Some(false)
        && body.get("attempted").and_then(Value::as_bool) == Some(false)
    {
        return ("failed", "capture_provider_rollback_preflight_rejected");
    }
    if kind == "rollback" && body.get("complete").and_then(Value::as_bool) != Some(true) {
        return (
            "needs-reconciliation",
            "capture_provider_manual_rollback_incomplete",
        );
    }
    if matches!(response.status_code, 408 | 502 | 503 | 504) {
        return (
            "needs-reconciliation",
            "capture_provider_timeout_or_unavailable",
        );
    }
    if !(200..300).contains(&response.status_code) {
        return ("failed", "capture_provider_rejected_operation");
    }
    let Some(code) = body.get("code").and_then(Value::as_i64) else {
        return (
            "needs-reconciliation",
            "capture_provider_response_not_decisive",
        );
    };
    if code == 0 {
        ("succeeded", "")
    } else {
        ("failed", "capture_provider_operation_failed")
    }
}

pub(super) fn mutation_response(
    state: &ServiceState,
    path: &str,
    body: &str,
    actor: &str,
) -> Vec<u8> {
    mutation_response_with_dispatch(state, path, body, actor, |normalized_body| {
        state.capture.proxy_response_with_read_timeout(
            "POST",
            path,
            normalized_body,
            Duration::from_secs(120),
        )
    })
}

pub(super) fn mutation_response_with_dispatch<F>(
    state: &ServiceState,
    path: &str,
    body: &str,
    actor: &str,
    dispatch: F,
) -> Vec<u8>
where
    F: FnOnce(&str) -> Option<CaptureProxyResponse>,
{
    let Some(kind) = operation_kind(path) else {
        return validation_error_response("unsupported_calibration_operation_kind");
    };
    let (operation_id, request_json) = match normalized_request(body) {
        Ok(normalized) => normalized,
        Err(error) => return validation_error_response(error),
    };
    if let Err(error) = validate_capture_device_mutation_request(path, &request_json) {
        return validation_error_response(error);
    }
    let hash = request_hash(kind, &request_json);
    let parent_operation_id = request_operation_id(&request_json, "parentOperationId");
    let requested_apply_operation_id = request_operation_id(&request_json, "applyOperationId");
    if !parent_operation_id.is_empty() && !valid_operation_id(&parent_operation_id) {
        return validation_error_response("calibration_parent_operation_id_invalid");
    }
    if kind == "rollback" && !valid_operation_id(&requested_apply_operation_id) {
        return validation_error_response("calibration_apply_operation_id_invalid");
    }

    match state.runtime.block_on(db::find_calibration_operation(
        &state.database.connection,
        &operation_id,
    )) {
        Ok(Some(existing)) => {
            if !matches_request(&existing, kind, &hash, &request_json) {
                return conflict_response(&operation_id);
            }
            return replay_response(&existing);
        }
        Ok(None) => {}
        Err(_) => return database_error_response("calibration_operation_lookup_failed"),
    }

    let unresolved = match state
        .runtime
        .block_on(db::list_unresolved_calibration_operations(
            &state.database.connection,
        )) {
        Ok(unresolved) => unresolved,
        Err(_) => {
            return database_error_response("calibration_operation_fence_lookup_failed");
        }
    };
    let mut reconciliation_expected_apply_operation_id = String::new();
    if !unresolved.is_empty() {
        if unresolved.iter().any(|item| item.status == "dispatching") {
            return operation_in_progress_response(&operation_id);
        }
        let recovery_parent_matches = kind == "rollback"
            && !parent_operation_id.is_empty()
            && unresolved.len() == 1
            && unresolved[0].id == parent_operation_id
            && unresolved[0].status == "needs-reconciliation";
        if !recovery_parent_matches {
            return reconciliation_required_response(&operation_id, &unresolved);
        }
        reconciliation_expected_apply_operation_id = expected_apply_operation_id(&unresolved[0]);
        if reconciliation_expected_apply_operation_id.is_empty()
            || requested_apply_operation_id != reconciliation_expected_apply_operation_id
        {
            return http_response(
                "409 Conflict",
                "application/json; charset=utf-8",
                &json!({
                    "code": 409,
                    "error": "calibration_reconciliation_expected_apply_mismatch",
                    "operationId": operation_id,
                    "parentOperationId": parent_operation_id,
                    "expectedApplyOperationId": reconciliation_expected_apply_operation_id,
                    "requestedApplyOperationId": requested_apply_operation_id,
                    "needsReconciliation": true
                })
                .to_string(),
            );
        }
    }

    // Only one SDK calibration mutation may be in flight from this service.
    // Reject instead of queueing: a queued provider request can outlive the
    // Rust HTTP timeout and perform a late device write after the caller has
    // already entered reconciliation.
    let _dispatch_guard = match state.calibration_operation_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            return match state.runtime.block_on(db::find_calibration_operation(
                &state.database.connection,
                &operation_id,
            )) {
                Ok(Some(existing)) if matches_request(&existing, kind, &hash, &request_json) => {
                    replay_response(&existing)
                }
                Ok(Some(_)) => conflict_response(&operation_id),
                Ok(None) => operation_in_progress_response(&operation_id),
                Err(_) => database_error_response("calibration_operation_lookup_failed"),
            };
        }
    };

    // Close the lookup/lock race for concurrent retries of the same ID.
    match state.runtime.block_on(db::find_calibration_operation(
        &state.database.connection,
        &operation_id,
    )) {
        Ok(Some(existing)) => {
            if !matches_request(&existing, kind, &hash, &request_json) {
                return conflict_response(&operation_id);
            }
            return replay_response(&existing);
        }
        Ok(None) => {}
        Err(_) => return database_error_response("calibration_operation_lookup_failed"),
    }

    let inserted = state.runtime.block_on(db::insert_calibration_operation(
        &state.database.connection,
        db::CalibrationOperationInput {
            id: operation_id.clone(),
            kind: kind.to_string(),
            request_hash: hash.clone(),
            request_json: request_json.clone(),
            actor: actor.to_string(),
            parent_operation_id: parent_operation_id.clone(),
        },
    ));
    if inserted.is_err() {
        return match state.runtime.block_on(db::find_calibration_operation(
            &state.database.connection,
            &operation_id,
        )) {
            Ok(Some(existing)) if matches_request(&existing, kind, &hash, &request_json) => {
                replay_response(&existing)
            }
            Ok(Some(_)) => conflict_response(&operation_id),
            _ => database_error_response("calibration_operation_insert_failed"),
        };
    }

    let Some(provider_response) = dispatch(&request_json) else {
        return match state.runtime.block_on(db::finish_calibration_operation(
            &state.database.connection,
            &operation_id,
            "needs-reconciliation",
            0,
            String::new(),
            "capture_provider_timeout_or_unavailable".to_string(),
        )) {
            Ok(Some(operation)) => operation_http_response("409 Conflict", &operation, false),
            _ => database_error_response("calibration_operation_finalize_failed"),
        };
    };

    let provider_body = String::from_utf8_lossy(&provider_response.body).to_string();
    let (status, error) = provider_terminal_status(kind, &provider_response);
    let finalized = state.runtime.block_on(db::finish_calibration_operation(
        &state.database.connection,
        &operation_id,
        status,
        i32::from(provider_response.status_code),
        provider_body,
        error.to_string(),
    ));
    let operation = match finalized {
        Ok(Some(operation)) => operation,
        _ => return database_error_response("calibration_operation_finalize_failed"),
    };
    if operation.status == "needs-reconciliation" {
        return operation_http_response("409 Conflict", &operation, false);
    }
    if operation.status != status {
        return operation_http_response("409 Conflict", &operation, false);
    }
    if status == "succeeded" && kind == "rollback" && !parent_operation_id.is_empty() {
        let provider_apply_operation_id =
            serde_json::from_str::<Value>(&operation.provider_response_body)
                .ok()
                .and_then(|value| {
                    value
                        .get("applyOperationId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
        if provider_apply_operation_id != reconciliation_expected_apply_operation_id {
            return http_response(
                "409 Conflict",
                "application/json; charset=utf-8",
                &json!({
                    "code": 409,
                    "error": "calibration_reconciliation_parent_mismatch",
                    "operationId": operation_id,
                    "parentOperationId": parent_operation_id,
                    "expectedApplyOperationId": reconciliation_expected_apply_operation_id,
                    "providerApplyOperationId": provider_apply_operation_id,
                    "needsReconciliation": true
                })
                .to_string(),
            );
        }
        let reconciled = state.runtime.block_on(db::reconcile_calibration_operation(
            &state.database.connection,
            &parent_operation_id,
            &operation_id,
            "restored-to-staged-baseline",
            actor,
        ));
        match reconciled {
            Ok(Some(parent)) if parent.status == "reconciled" => {
                let _ = state.runtime.block_on(db::append_audit_log(
                    &state.database.connection,
                    actor,
                    "calibration.reconciled",
                    &parent_operation_id,
                    &format!("restored to staged baseline by rollback operation {operation_id}"),
                    "warning",
                ));
            }
            _ => {
                return http_response(
                    "409 Conflict",
                    "application/json; charset=utf-8",
                    &json!({
                        "code": 409,
                        "error": "calibration_reconciliation_finalize_failed",
                        "operationId": operation_id,
                        "parentOperationId": parent_operation_id,
                        "needsReconciliation": true
                    })
                    .to_string(),
                );
            }
        }
    }
    http_bytes_response_with_headers(
        &capture_proxy_status(provider_response.status_code),
        &provider_response.content_type,
        &provider_response.body,
        &[],
    )
}

pub(super) fn detail_response(state: &ServiceState, query: &str) -> Vec<u8> {
    let operation_id = query_value(query, "id").unwrap_or_default();
    if operation_id.trim().is_empty() {
        return validation_error_response("calibration_operation_id_required");
    }
    match state.runtime.block_on(db::find_calibration_operation(
        &state.database.connection,
        operation_id.trim(),
    )) {
        Ok(Some(operation)) => operation_http_response("200 OK", &operation, false),
        Ok(None) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            &json!({
                "code": 404,
                "error": "calibration_operation_not_found",
                "operationId": operation_id.trim()
            })
            .to_string(),
        ),
        Err(_) => database_error_response("calibration_operation_lookup_failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_request_hash_is_stable_across_object_key_order() {
        let (_, first) = normalized_request(
            r#"{"operationId":" OP-1 ","confirmation":"APPLY","nested":{"b":2,"a":1}}"#,
        )
        .expect("first request");
        let (_, second) = normalized_request(
            r#"{"nested":{"a":1,"b":2},"confirmation":"APPLY","operationId":"OP-1"}"#,
        )
        .expect("second request");
        assert_eq!(first, second);
        assert_eq!(
            request_hash("apply-all", &first),
            request_hash("apply-all", &second)
        );
    }

    #[test]
    fn duplicate_json_keys_are_rejected_before_dry_run_routing() {
        assert!(parse_unique_json(r#"{"dryRun":true}"#).is_ok());
        assert_eq!(
            parse_unique_json(r#"{"dryRun":false,"dryRun":true}"#),
            Err("invalid_or_duplicate_calibration_operation_json")
        );
        assert_eq!(
            parse_unique_json(r#"{"nested":{"expectedSn":"A","expectedSn":"B"}}"#),
            Err("invalid_or_duplicate_calibration_operation_json")
        );
    }

    #[test]
    fn operation_id_matches_the_capture_provider_identifier_contract() {
        assert!(normalized_request(r#"{"operationId":"Apply-01_test.v2:camera"}"#).is_ok());
        for invalid in [
            r#"{"operationId":"contains space"}"#,
            r#"{"operationId":"中文"}"#,
            r#"{"operationId":"slash/not-allowed"}"#,
        ] {
            assert_eq!(
                normalized_request(invalid),
                Err("calibration_operation_id_invalid")
            );
        }
    }

    #[test]
    fn incomplete_rollbacks_require_reconciliation() {
        let automatic = CaptureProxyResponse {
            status_code: 200,
            content_type: "application/json".to_string(),
            body: br#"{"code":9001,"rollbackPerformed":true,"rollbackComplete":false}"#.to_vec(),
        };
        assert_eq!(
            provider_terminal_status("apply-all", &automatic),
            (
                "needs-reconciliation",
                "capture_provider_automatic_rollback_incomplete"
            )
        );

        let manual = CaptureProxyResponse {
            status_code: 200,
            content_type: "application/json".to_string(),
            body: br#"{"code":9002,"complete":false}"#.to_vec(),
        };
        assert_eq!(
            provider_terminal_status("rollback", &manual),
            (
                "needs-reconciliation",
                "capture_provider_manual_rollback_incomplete"
            )
        );
    }

    #[test]
    fn rollback_preflight_rejection_is_decisive_without_reconciliation() {
        let response = CaptureProxyResponse {
            status_code: 200,
            content_type: "application/json".to_string(),
            body: br#"{"code":49010,"complete":false,"attempted":false,"sideEffects":false,"applyOperationId":"apply-1"}"#.to_vec(),
        };
        assert_eq!(
            provider_terminal_status("rollback", &response),
            ("failed", "capture_provider_rollback_preflight_rejected")
        );
    }
}
