import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  fetchProductionStatus,
  fetchProductionTasks,
  fetchRuntimeStatus,
  fetchServiceHealthDetails,
  getInspectionServiceOrigin,
  type AdminRuntimeLogStatus,
  type ProductionStatus,
  type ProductionTaskDetail,
  type ProductionTaskPage,
  type ServiceHealthDetails,
} from '../services/inspection-api';

const MONITOR_EVENT = 'background-monitor-updated';
const RECENT_FAILURE_WINDOW_MS = 30 * 60 * 1000;

export type BackgroundMonitorStateName =
  | 'initializing'
  | 'healthy'
  | 'busy'
  | 'degraded'
  | 'offline';

export type BackgroundMonitorTask = {
  taskId: string;
  kind: string;
  materialId: string;
  status: string;
  phase: string;
  progress: number;
  updatedAt: string;
  error: string;
};

export type BackgroundMonitorService = AdminRuntimeLogStatus['services'][number];
export type BackgroundMonitorLog = AdminRuntimeLogStatus['logs'][number];
export type BackgroundMonitorRuntime = AdminRuntimeLogStatus['runtime'];
export type BackgroundMonitorRegistry = NonNullable<AdminRuntimeLogStatus['registry']>;
export type BackgroundMonitorProtocol = NonNullable<AdminRuntimeLogStatus['monitorProtocol']>;

export type BackgroundMonitorSnapshot = {
  schema: 'steel.tauri-background-monitor.v1';
  state: BackgroundMonitorStateName;
  origin: string;
  serviceAvailable: boolean;
  serviceReady: boolean;
  workerRunning: boolean;
  queueDepth: number;
  activeTasks: number;
  failedTasks: number;
  blockedTasks: number;
  activeTaskId: string | null;
  detail: string;
  updatedAtUnixMs: number;
  tasks: BackgroundMonitorTask[];
  services?: BackgroundMonitorService[];
  logs?: BackgroundMonitorLog[];
  runtime?: BackgroundMonitorRuntime | null;
  registry?: BackgroundMonitorRegistry | null;
  monitorProtocol?: BackgroundMonitorProtocol | null;
  serviceCount?: number;
  healthyServiceCount?: number;
};

export type BackgroundMonitorInputs = {
  origin: string;
  health: ServiceHealthDetails;
  production?: ProductionStatus | null;
  taskPage?: ProductionTaskPage | null;
  runtimeStatus?: AdminRuntimeLogStatus | null;
  now?: number;
};

let browserOrigin = getInspectionServiceOrigin();

export function hasNativeBackgroundMonitor() {
  return isTauri();
}

export function createInitialBackgroundMonitorSnapshot(
  origin = browserOrigin,
): BackgroundMonitorSnapshot {
  return {
    schema: 'steel.tauri-background-monitor.v1',
    state: 'initializing',
    origin,
    serviceAvailable: false,
    serviceReady: false,
    workerRunning: false,
    queueDepth: 0,
    activeTasks: 0,
    failedTasks: 0,
    blockedTasks: 0,
    activeTaskId: null,
    detail: '正在连接后台检测服务',
    updatedAtUnixMs: Date.now(),
    tasks: [],
    services: [],
    logs: [],
    runtime: null,
    registry: null,
    monitorProtocol: null,
    serviceCount: 0,
    healthyServiceCount: 0,
  };
}

function taskTimestamp(value: string) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecentTask(task: BackgroundMonitorTask, now: number) {
  const updatedAt = taskTimestamp(task.updatedAt);
  return updatedAt === 0 || now - updatedAt <= RECENT_FAILURE_WINDOW_MS;
}

function toMonitorTask(task: ProductionTaskDetail): BackgroundMonitorTask {
  return {
    taskId: task.taskId || task.id || '',
    kind: task.kind || '',
    materialId: task.materialId || '',
    status: task.status || '',
    phase: task.phase || '',
    progress: Math.min(1, Math.max(0, Number(task.progress) || 0)),
    updatedAt: task.updatedAt || task.finishedAt || task.startedAt || task.createdAt || '',
    error: task.error || task.blockedReason || '',
  };
}

export function deriveBackgroundMonitorSnapshot({
  origin,
  health,
  production,
  taskPage,
  runtimeStatus,
  now = Date.now(),
}: BackgroundMonitorInputs): BackgroundMonitorSnapshot {
  const tasks = (taskPage?.tasks ?? []).slice(0, 16).map(toMonitorTask);
  const workerRunning = health.checks.taskWorker?.running
    ?? production?.tasks?.worker?.running
    ?? taskPage?.taskWorker?.running
    ?? false;
  const queueDepth = production?.tasks?.queueDepth
    ?? tasks.filter((task) => task.status === 'queued').length;
  const listedActiveTasks = tasks.filter((task) => task.status === 'running').length;
  const failedTasks = tasks.filter(
    (task) => ['failed', 'interrupted'].includes(task.status) && isRecentTask(task, now),
  ).length;
  const blockedTasks = tasks.filter(
    (task) => task.status === 'blocked' && isRecentTask(task, now),
  ).length;
  const activeTaskId = production?.tasks?.worker?.activeTaskId
    ?? taskPage?.taskWorker?.activeTaskId
    ?? tasks.find((task) => task.status === 'running')?.taskId
    ?? null;
  const activeTasks = Math.max(listedActiveTasks, activeTaskId ? 1 : 0);
  const taskDataAvailable = Boolean(production && taskPage);
  const services = runtimeStatus?.services ?? [];
  const logs = runtimeStatus?.logs ?? [];
  const failedRequiredServices = services.filter((service) => service.required && !service.ok);
  const runtimeDegraded = Boolean(
    runtimeStatus && (runtimeStatus.status === 'degraded' || failedRequiredServices.length > 0),
  );
  const state: BackgroundMonitorStateName = !health.ok
    || !workerRunning
    || !taskDataAvailable
    || failedTasks > 0
    || blockedTasks > 0
    || runtimeDegraded
    ? 'degraded'
    : activeTasks > 0 || queueDepth > 0
      ? 'busy'
      : 'healthy';
  const detail = state === 'healthy'
    ? '后台服务与生产任务队列运行正常'
    : state === 'busy'
      ? `正在执行 ${activeTasks} 项任务，队列等待 ${queueDepth} 项`
      : !health.ok
        ? health.status || '服务尚未就绪'
        : !workerRunning
          ? '生产任务工作线程未运行'
          : !taskDataAvailable
            ? '任务状态接口暂时不可用'
            : runtimeDegraded
              ? failedRequiredServices.length > 0
                ? `注册服务未就绪：${failedRequiredServices.slice(0, 3).map((service) => service.name || service.id).join('、')}`
                : '服务运行状态需要关注'
            : `最近任务异常 ${failedTasks} 项，阻塞 ${blockedTasks} 项`;

  return {
    schema: 'steel.tauri-background-monitor.v1',
    state,
    origin,
    serviceAvailable: true,
    serviceReady: health.ok,
    workerRunning,
    queueDepth,
    activeTasks,
    failedTasks,
    blockedTasks,
    activeTaskId,
    detail,
    updatedAtUnixMs: now,
    tasks,
    services,
    logs,
    runtime: runtimeStatus?.runtime ?? null,
    registry: runtimeStatus?.registry ?? null,
    monitorProtocol: runtimeStatus?.monitorProtocol ?? null,
    serviceCount: services.length,
    healthyServiceCount: services.filter((service) => service.ok).length,
  };
}

async function readBrowserBackgroundMonitor(): Promise<BackgroundMonitorSnapshot> {
  const origin = browserOrigin;
  try {
    const health = await fetchServiceHealthDetails();
    const [productionResult, tasksResult, runtimeResult] = await Promise.allSettled([
      fetchProductionStatus(),
      fetchProductionTasks(16),
      fetchRuntimeStatus(),
    ]);
    return deriveBackgroundMonitorSnapshot({
      origin,
      health,
      production: productionResult.status === 'fulfilled' ? productionResult.value : null,
      taskPage: tasksResult.status === 'fulfilled' ? tasksResult.value : null,
      runtimeStatus: runtimeResult.status === 'fulfilled' ? runtimeResult.value : null,
    });
  } catch (error) {
    return {
      ...createInitialBackgroundMonitorSnapshot(origin),
      state: 'offline',
      detail: error instanceof Error ? error.message : '后台检测服务不可达',
      updatedAtUnixMs: Date.now(),
    };
  }
}

export async function configureBackgroundMonitor(
  origin: string,
): Promise<BackgroundMonitorSnapshot> {
  browserOrigin = origin.replace(/\/$/, '');
  if (!isTauri()) return readBrowserBackgroundMonitor();
  return invoke<BackgroundMonitorSnapshot>('configure_background_monitor', { origin: browserOrigin });
}

export function readBackgroundMonitor(): Promise<BackgroundMonitorSnapshot> {
  if (!isTauri()) return readBrowserBackgroundMonitor();
  return invoke<BackgroundMonitorSnapshot>('read_background_monitor');
}

export function refreshBackgroundMonitor(): Promise<BackgroundMonitorSnapshot> {
  if (!isTauri()) return readBrowserBackgroundMonitor();
  return invoke<BackgroundMonitorSnapshot>('refresh_background_monitor');
}

export async function listenBackgroundMonitor(
  handler: (snapshot: BackgroundMonitorSnapshot) => void,
): Promise<() => void> {
  if (!isTauri()) {
    let disposed = false;
    let polling = false;
    const timer = globalThis.setInterval(() => {
      if (disposed || polling) return;
      polling = true;
      void readBrowserBackgroundMonitor()
        .then((snapshot) => {
          if (!disposed) handler(snapshot);
        })
        .finally(() => {
          polling = false;
        });
    }, 5_000);
    return () => {
      disposed = true;
      globalThis.clearInterval(timer);
    };
  }
  return listen<BackgroundMonitorSnapshot>(MONITOR_EVENT, (event) => handler(event.payload));
}
