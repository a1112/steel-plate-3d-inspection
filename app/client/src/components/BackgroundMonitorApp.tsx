import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  FileText,
  Filter,
  Play,
  RefreshCw,
  RotateCw,
  Server,
  ServerCog,
  Square,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  configureBackgroundMonitor,
  controlBackgroundService,
  hasNativeBackgroundMonitor,
  listenBackgroundMonitor,
  readBackgroundMonitor,
  refreshBackgroundMonitor,
  setBackgroundServiceStartupMode,
  type BackgroundServiceStartupMode,
  type BackgroundMonitorSnapshot,
} from '../lib/background-monitor';
import { getTauriWindowApi } from '../lib/tauri-window';
import { DEFAULT_SYSTEM_NAME } from '../lib/system-brand';
import { getInspectionServiceOrigin } from '../services/inspection-api';
import { Panel } from './Panel';
import { StandaloneWindowTitlebar } from './StandaloneWindowTitlebar';

type BackgroundMonitorTask = NonNullable<BackgroundMonitorSnapshot['tasks']>[number];

export type BackgroundMonitorFilters = {
  query: string;
  status: string;
  kind: string;
};

type MonitorState = 'initializing' | 'healthy' | 'busy' | 'degraded' | 'offline' | string;
type MonitorTone = 'healthy' | 'busy' | 'degraded' | 'offline' | 'initializing';

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
  blocked: '已阻塞',
  unknown: '未知',
};

const KIND_LABELS: Record<string, string> = {
  'capture-once': '单轮采集',
  'algorithm-run': '算法分析',
  'steel-info': '钢材信息',
  'steel-in': '进钢',
  'steel-out': '出钢',
  'trigger-event': '触发事件',
};

const STATUS_FILTERS = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'blocked'];

function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function backgroundTaskStatusLabel(status: string) {
  const normalized = status.trim().toLowerCase();
  return STATUS_LABELS[normalized] ?? (normalized || STATUS_LABELS.unknown);
}

export function backgroundTaskKindLabel(kind: string) {
  const normalized = kind.trim().toLowerCase();
  return KIND_LABELS[normalized] ?? (normalized || '未知任务');
}

export function backgroundTaskProgressPercent(progress: number) {
  const value = Number.isFinite(progress) ? progress : 0;
  const percent = value >= 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function formatBackgroundMonitorTime(value: string | number | null | undefined) {
  if (value == null || value === '') return '-';
  const rawNumber = typeof value === 'number' ? value : Number(value);
  const timestamp = Number.isFinite(rawNumber)
    ? rawNumber > 0 && rawNumber < 1_000_000_000_000 ? rawNumber * 1000 : rawNumber
    : Date.parse(String(value));
  if (!Number.isFinite(timestamp) || timestamp <= 0) return stringValue(value, '-');
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return stringValue(value, '-');
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function filterBackgroundTasks(
  tasks: BackgroundMonitorTask[],
  filters: BackgroundMonitorFilters,
) {
  const query = filters.query.trim().toLowerCase();
  return tasks.filter((task) => {
    const status = stringValue(task.status, 'unknown').toLowerCase();
    const kind = stringValue(task.kind, 'unknown').toLowerCase();
    if (filters.status !== 'all' && status !== filters.status) return false;
    if (filters.kind !== 'all' && kind !== filters.kind) return false;
    if (!query) return true;
    return [task.taskId, task.kind, task.materialId, task.phase, task.error]
      .map((value) => stringValue(value).toLowerCase())
      .some((value) => value.includes(query));
  });
}

function monitorStateLabel(state: MonitorState) {
  switch (state) {
    case 'healthy': return '正常';
    case 'busy': return '任务运行中';
    case 'degraded': return '需要关注';
    case 'offline': return '服务离线';
    case 'initializing': return '正在连接';
    default: return state || '正在连接';
  }
}

function monitorTone(state: MonitorState): MonitorTone {
  if (state === 'healthy' || state === 'busy' || state === 'degraded' || state === 'offline') return state;
  return 'initializing';
}

function monitorStateIcon(state: MonitorState) {
  if (state === 'healthy') return CheckCircle2;
  if (state === 'busy') return Activity;
  if (state === 'initializing') return Clock3;
  if (state === 'offline') return XCircle;
  return AlertTriangle;
}

function taskStatusTone(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === 'succeeded') return 'success';
  if (normalized === 'running') return 'running';
  if (normalized === 'queued') return 'queued';
  if (normalized === 'failed' || normalized === 'interrupted' || normalized === 'blocked') return 'error';
  return 'muted';
}

function serviceStatusLabel(status: string, ok: boolean) {
  if (ok) {
    if (['running', 'ready', 'healthy'].includes(status.toLowerCase())) return '运行中';
    return '已连通';
  }
  if (['stopped', 'disabled'].includes(status.toLowerCase())) return '已停止';
  return '不可用';
}

function serviceStatusTone(ok: boolean, status: string) {
  if (ok) return 'success';
  if (['starting', 'stopping', 'degraded'].includes(status.toLowerCase())) return 'warning';
  return 'error';
}

function readError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatRuntimeDuration(value: number | null | undefined) {
  const milliseconds = numberValue(value);
  if (!milliseconds) return '-';
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

type SummaryCardProps = {
  label: string;
  value: string;
  detail: string;
  tone?: MonitorTone;
  icon: typeof Activity;
};

function SummaryCard({ label, value, detail, tone = 'initializing', icon: Icon }: SummaryCardProps) {
  return (
    <article className={`background-monitor-summary-card is-${tone}`} aria-label={label}>
      <span className="background-monitor-summary-icon"><Icon size={18} /></span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <em title={detail}>{detail}</em>
      </div>
    </article>
  );
}

export type BackgroundMonitorAppProps = {
  origin?: string;
  className?: string;
  systemName?: string;
};

export function BackgroundMonitorApp({
  origin = getInspectionServiceOrigin(),
  className = '',
  systemName = DEFAULT_SYSTEM_NAME,
}: BackgroundMonitorAppProps) {
  const [snapshot, setSnapshot] = useState<BackgroundMonitorSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [logScope, setLogScope] = useState<'service' | 'all'>('service');
  const [monitorView, setMonitorView] = useState<'tasks' | 'services'>('tasks');
  const [filters, setFilters] = useState<BackgroundMonitorFilters>({ query: '', status: 'all', kind: 'all' });
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const windowApi = useMemo(() => getTauriWindowApi(), []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const synchronize = async () => {
      setLoading(true);
      try {
        const next = hasNativeBackgroundMonitor()
          ? await readBackgroundMonitor()
          : await configureBackgroundMonitor(origin);
        if (!disposed) {
          setSnapshot(next);
          setLoadError(null);
        }
      } catch (error) {
        if (!disposed) setLoadError(readError(error, '后台监控状态读取失败'));
      } finally {
        if (!disposed) setLoading(false);
      }

      try {
        const cleanup = await listenBackgroundMonitor((next) => {
          if (disposed) return;
          setSnapshot(next);
          setLoadError(null);
          setLoading(false);
        });
        if (disposed) cleanup();
        else unlisten = cleanup;
      } catch (error) {
        if (!disposed) setLoadError(readError(error, '后台监控事件订阅失败'));
      }
    };

    void synchronize();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [origin]);

  const attentionCount = snapshot
    ? Math.max(0, numberValue(snapshot.failedTasks) + numberValue(snapshot.blockedTasks))
    : 0;
  const state = (snapshot?.state ?? 'initializing') as MonitorState;
  const tone = monitorTone(state);
  const StateIcon = monitorStateIcon(state);
  const tasks = snapshot?.tasks ?? [];
  const taskKinds = useMemo(() => {
    const values = new Set(tasks.map((task) => stringValue(task.kind, 'unknown').toLowerCase()));
    return Array.from(values).sort((left, right) => (
      backgroundTaskKindLabel(left).localeCompare(backgroundTaskKindLabel(right), 'zh-CN')
    ));
  }, [tasks]);
  const filteredTasks = useMemo(() => filterBackgroundTasks(tasks, filters), [tasks, filters]);
  const activeTask = snapshot?.activeTaskId
    ? tasks.find((task) => task.taskId === snapshot.activeTaskId) ?? null
    : tasks.find((task) => stringValue(task.status).toLowerCase() === 'running') ?? null;
  const services = snapshot?.services ?? [];
  const lifecycleLogs = snapshot?.lifecycleLogs ?? [];
  const runtime = snapshot?.runtime ?? null;
  const registry = snapshot?.registry ?? null;
  const healthyServiceCount = snapshot?.healthyServiceCount ?? services.filter((service) => service.ok).length;
  const serviceCount = snapshot?.serviceCount ?? services.length;
  const supervisorStatus = stringValue(runtime?.supervisor?.status, runtime ? '未知' : '未接入');
  const workerStatus = stringValue(runtime?.taskWorker?.status, runtime?.taskWorker?.running ? 'running' : '未知');
  const selectedService = services.find((service) => service.id === selectedServiceId) ?? services[0] ?? null;
  const visibleLogs = logScope === 'all' || !selectedService
    ? lifecycleLogs
    : lifecycleLogs.filter((log) => log.serviceId === selectedService.id);

  useEffect(() => {
    if (!services.length) {
      setSelectedServiceId(null);
      return;
    }
    if (!selectedServiceId || !services.some((service) => service.id === selectedServiceId)) {
      setSelectedServiceId(services[0].id);
    }
  }, [selectedServiceId, services]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setOperationMessage(null);
    try {
      const next = await refreshBackgroundMonitor();
      setSnapshot(next);
      setLoadError(null);
      setOperationMessage('已请求后台服务刷新，等待工作线程上报最新状态');
    } catch (error) {
      setLoadError(readError(error, '后台监控刷新失败'));
    } finally {
      setRefreshing(false);
    }
  };

  const handleHideToTray = async () => {
    try {
      await windowApi.hide();
    } catch (error) {
      setOperationMessage(readError(error, '隐藏到托盘失败'));
    }
  };

  const handleServiceAction = async (action: 'start' | 'stop' | 'restart') => {
    if (!selectedService) return;
    setOperationBusy(true);
    setOperationMessage(null);
    try {
      const result = await controlBackgroundService(selectedService.id, action);
      setOperationMessage(result.message);
      await refreshBackgroundMonitor();
    } catch (error) {
      setOperationMessage(readError(error, '服务生命周期操作失败'));
    } finally {
      setOperationBusy(false);
    }
  };

  const handleStartupModeChange = async (mode: BackgroundServiceStartupMode) => {
    if (!selectedService) return;
    setOperationBusy(true);
    setOperationMessage(null);
    try {
      const result = await setBackgroundServiceStartupMode(selectedService.id, mode);
      setOperationMessage(result.message);
      await refreshBackgroundMonitor();
    } catch (error) {
      setOperationMessage(readError(error, '启动模式设置失败'));
    } finally {
      setOperationBusy(false);
    }
  };

  const operation = (id: string) => selectedService?.operations?.find((item) => item.id === id);

  const updateFilter = (key: keyof BackgroundMonitorFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <>
      <StandaloneWindowTitlebar
        kind="monitor"
        title="后台任务监控"
        systemName={systemName}
        toolbar={(
          <div className="background-monitor-titlebar-tools">
          <span className={`background-monitor-state-badge is-${tone}`}>
            <StateIcon size={15} />
            {monitorStateLabel(state)}
          </span>
          <span className="background-monitor-title-stat">服务 <strong>{healthyServiceCount}/{serviceCount}</strong></span>
          <span className="background-monitor-title-stat">任务 <strong>{numberValue(snapshot?.activeTasks)}/{numberValue(snapshot?.queueDepth)}</strong></span>
          <span className={`background-monitor-title-stat ${attentionCount > 0 ? 'has-attention' : ''}`}>关注 <strong>{attentionCount}</strong></span>
          <button type="button" onClick={() => void handleRefresh()} disabled={refreshing} aria-label="刷新后台任务监控">
            <RefreshCw size={15} className={refreshing ? 'is-spinning' : ''} />
            {refreshing ? '刷新中' : '刷新'}
          </button>
          <button
            type="button"
            onClick={() => void handleHideToTray()}
            aria-label="隐藏到托盘"
            disabled={!windowApi.isAvailable}
            title={windowApi.isAvailable ? '隐藏窗口，后台监控继续运行' : '仅桌面客户端支持系统托盘'}
          >
            <Clock3 size={15} />
            隐藏到托盘
          </button>
          </div>
        )}
      />

      <main className={`workspace-page background-monitor-page ${className}`.trim()} data-testid="background-monitor-app">

      {loadError ? (
        <div className="background-monitor-alert" role="alert">
          <AlertTriangle size={16} />
          <span>{loadError}</span>
        </div>
      ) : null}

      <section className="background-monitor-summary" aria-label="后台监控摘要">
        <SummaryCard
          label="运行健康"
          value={snapshot ? monitorStateLabel(state) : '读取中'}
          detail={snapshot?.detail ?? '正在读取后台服务与任务队列状态'}
          tone={tone}
          icon={StateIcon}
        />
        <SummaryCard
          label="任务 Worker"
          value={snapshot?.workerRunning ? '在线' : '离线'}
          detail={snapshot ? `活动 ${numberValue(snapshot.activeTasks)} 项${snapshot.activeTaskId ? ` · ${snapshot.activeTaskId}` : ''}` : '等待工作线程状态'}
          tone={snapshot?.workerRunning ? 'healthy' : snapshot ? 'offline' : 'initializing'}
          icon={ServerCog}
        />
        <SummaryCard
          label="持久队列"
          value={snapshot ? String(numberValue(snapshot.queueDepth)) : '—'}
          detail="等待处理的后台任务"
          tone={snapshot?.queueDepth ? 'busy' : snapshot ? 'healthy' : 'initializing'}
          icon={Activity}
        />
        <SummaryCard
          label="异常关注"
          value={String(attentionCount)}
          detail={snapshot ? `失败/中断 ${numberValue(snapshot.failedTasks)} · 阻塞 ${numberValue(snapshot.blockedTasks)}` : '等待任务状态'}
          tone={attentionCount > 0 ? 'degraded' : snapshot ? 'healthy' : 'initializing'}
          icon={attentionCount > 0 ? AlertTriangle : CheckCircle2}
        />
      </section>

      <nav className="background-monitor-view-switch" aria-label="后台监控视图">
        <button
          type="button"
          className={monitorView === 'tasks' ? 'is-active' : ''}
          aria-pressed={monitorView === 'tasks'}
          onClick={() => setMonitorView('tasks')}
        >
          任务队列
          <span>{tasks.length}</span>
        </button>
        <button
          type="button"
          className={monitorView === 'services' ? 'is-active' : ''}
          aria-pressed={monitorView === 'services'}
          onClick={() => setMonitorView('services')}
        >
          服务与日志
          <span>{healthyServiceCount}/{serviceCount}</span>
        </button>
      </nav>

      {monitorView === 'tasks' ? (
        <section className="background-monitor-content" aria-label="持久任务队列">
          <Panel title="当前活动任务" className="background-monitor-active-panel">
            {activeTask ? (
              <article className="background-monitor-active-task" data-testid="background-monitor-active-task">
                <div className="background-monitor-active-task-heading">
                  <div>
                    <span>任务 ID</span>
                    <strong title={activeTask.taskId}>{stringValue(activeTask.taskId, '-')}</strong>
                  </div>
                  <span className={`background-monitor-status-pill is-${taskStatusTone(stringValue(activeTask.status, 'unknown'))}`}>
                    {backgroundTaskStatusLabel(stringValue(activeTask.status, 'unknown'))}
                  </span>
                </div>
                <dl className="background-monitor-active-facts">
                  <div><dt>类型</dt><dd>{backgroundTaskKindLabel(stringValue(activeTask.kind, 'unknown'))}</dd></div>
                  <div><dt>材料</dt><dd>{stringValue(activeTask.materialId, '-')}</dd></div>
                  <div><dt>阶段</dt><dd>{stringValue(activeTask.phase, '等待')}</dd></div>
                  <div><dt>进度</dt><dd>{backgroundTaskProgressPercent(numberValue(activeTask.progress))}%</dd></div>
                </dl>
                <div
                  className="background-monitor-progress"
                  role="progressbar"
                  aria-label="活动任务进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={backgroundTaskProgressPercent(numberValue(activeTask.progress))}
                >
                  <span style={{ width: `${backgroundTaskProgressPercent(numberValue(activeTask.progress))}%` }} />
                </div>
                <time>更新于 {formatBackgroundMonitorTime(stringValue(activeTask.updatedAt))}</time>
              </article>
            ) : (
              <div className="background-monitor-empty background-monitor-active-empty">
                <CheckCircle2 size={24} />
                <strong>{loading ? '正在读取活动任务' : '当前没有运行中的任务'}</strong>
                <span>{snapshot?.activeTaskId ? `工作线程报告任务 ${snapshot.activeTaskId}，任务列表尚未同步` : '后台工作线程处于空闲状态'}</span>
              </div>
            )}
          </Panel>

          <Panel
            title="任务列表"
            className="background-monitor-task-panel"
            action={<span className="background-monitor-task-count">显示 {filteredTasks.length} / {tasks.length}</span>}
          >
            <div className="background-monitor-task-toolbar">
              <div className="background-monitor-filter-title"><Filter size={15} /><span>筛选任务</span></div>
              <label>
                <span>搜索</span>
                <input
                  aria-label="搜索后台任务"
                  value={filters.query}
                  placeholder="任务 ID、材料号或阶段"
                  onChange={(event) => updateFilter('query', event.target.value)}
                />
              </label>
              <label>
                <span>状态</span>
                <select aria-label="任务状态过滤" value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
                  <option value="all">全部状态</option>
                  {STATUS_FILTERS.map((status) => <option key={status} value={status}>{backgroundTaskStatusLabel(status)}</option>)}
                </select>
              </label>
              <label>
                <span>类型</span>
                <select aria-label="任务类型过滤" value={filters.kind} onChange={(event) => updateFilter('kind', event.target.value)}>
                  <option value="all">全部类型</option>
                  {taskKinds.map((kind) => <option key={kind} value={kind}>{backgroundTaskKindLabel(kind)}</option>)}
                </select>
              </label>
              <button
                type="button"
                className="background-monitor-clear-filter"
                onClick={() => setFilters({ query: '', status: 'all', kind: 'all' })}
                disabled={!filters.query && filters.status === 'all' && filters.kind === 'all'}
              >
                清除
              </button>
            </div>
            <div className="background-monitor-table-wrap">
              <table className="background-monitor-task-table" data-testid="background-monitor-task-table">
                <caption className="sr-only">后台任务只读列表</caption>
                <thead>
                  <tr>
                    <th scope="col">任务</th>
                    <th scope="col">类型</th>
                    <th scope="col">材料</th>
                    <th scope="col">阶段 / 进度</th>
                    <th scope="col">状态</th>
                    <th scope="col">更新时间</th>
                    <th scope="col">异常</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTasks.length ? filteredTasks.map((task) => {
                    const status = stringValue(task.status, 'unknown').toLowerCase();
                    const progress = backgroundTaskProgressPercent(numberValue(task.progress));
                    return (
                      <tr key={task.taskId} data-testid={`background-monitor-task-${task.taskId}`}>
                        <td><strong title={task.taskId}>{stringValue(task.taskId, '-')}</strong></td>
                        <td>{backgroundTaskKindLabel(stringValue(task.kind, 'unknown'))}</td>
                        <td>{stringValue(task.materialId, '-')}</td>
                        <td>
                          <span>{stringValue(task.phase, '-')}</span>
                          <div className="background-monitor-row-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
                          <em>{progress}%</em>
                        </td>
                        <td><span className={`background-monitor-status-pill is-${taskStatusTone(status)}`}>{backgroundTaskStatusLabel(status)}</span></td>
                        <td><time>{formatBackgroundMonitorTime(stringValue(task.updatedAt))}</time></td>
                        <td className={task.error ? 'has-error' : ''} title={task.error || undefined}>{stringValue(task.error, '-')}</td>
                      </tr>
                    );
                  }) : (
                    <tr><td colSpan={7} className="background-monitor-table-empty">{loading ? '正在读取任务列表' : '没有符合当前筛选条件的任务'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </section>
      ) : null}

      {monitorView === 'services' ? <section className="background-monitor-runtime-grid" aria-label="服务运行控制台">
        <Panel
          title="运行服务"
          className="background-monitor-runtime-panel background-monitor-services-panel"
          action={<span className="background-monitor-task-count">实时探针 {healthyServiceCount} / {serviceCount}</span>}
        >
          {services.length ? (
            <div className="background-monitor-service-list" data-testid="background-monitor-services">
              {services.map((service) => {
                const status = stringValue(service.status, 'unknown');
                const tone = serviceStatusTone(service.ok, status);
                return (
                  <button
                    type="button"
                    className={`background-monitor-service-row ${selectedService?.id === service.id ? 'is-selected' : ''}`}
                    key={service.id}
                    data-testid={`background-monitor-service-${service.id}`}
                    aria-pressed={selectedService?.id === service.id}
                    onClick={() => setSelectedServiceId(service.id)}
                  >
                    <div className="background-monitor-service-heading">
                      <div>
                        <span className={`background-monitor-service-dot is-${tone}`} />
                        <strong>{stringValue(service.name, service.id)}</strong>
                        <code>{service.id}</code>
                      </div>
                      <span className={`background-monitor-status-pill is-${tone}`}>{serviceStatusLabel(status, service.ok)}</span>
                    </div>
                    <div className="background-monitor-service-facts">
                      <span>{stringValue(service.origin, '-')} · {stringValue(service.healthPath, '/api/health/live')}</span>
                      <span>{service.required ? '必需' : '可选'} · {stringValue(service.role, 'service')} · 启动模式 {service.startupMode === 'normal' ? '正常' : service.startupMode === 'disabled' ? '禁用' : '手动'}</span>
                    </div>
                    {service.reason ? <p>{service.reason}</p> : null}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="background-monitor-empty background-monitor-runtime-empty">
              <Server size={22} />
              <strong>{loading ? '正在读取服务注册' : '暂无服务注册'}</strong>
              <span>{registry?.path ?? '后台服务尚未上报运行状态'}</span>
            </div>
          )}
        </Panel>

        <Panel
          title={selectedService ? stringValue(selectedService.name, selectedService.id) : '服务信息'}
          className="background-monitor-runtime-panel background-monitor-detail-panel"
          action={selectedService ? <span className={`background-monitor-status-pill is-${serviceStatusTone(selectedService.ok, selectedService.status)}`}>{serviceStatusLabel(selectedService.status, selectedService.ok)}</span> : null}
        >
          {selectedService ? (
            <div className="background-monitor-service-detail" data-testid="background-monitor-service-detail">
              <div className="background-monitor-service-identity">
                <div>
                  <span>{selectedService.required ? '必需服务' : '可选服务'} · {stringValue(selectedService.kind, 'service')}</span>
                  <strong>{selectedService.id}</strong>
                  <code>{selectedService.origin}</code>
                </div>
                <span className={`background-monitor-service-dot is-${serviceStatusTone(selectedService.ok, selectedService.status)}`} />
              </div>

              <div className="background-monitor-quick-actions" aria-label="服务快捷操作">
                <button type="button" onClick={() => void handleServiceAction('start')} disabled={operationBusy || operation('start')?.enabled === false}>
                  <Play size={15} />启动
                </button>
                <button type="button" onClick={() => void handleServiceAction('stop')} disabled={operationBusy || operation('stop')?.enabled === false}>
                  <Square size={14} />停止
                </button>
                <button type="button" onClick={() => void handleServiceAction('restart')} disabled={operationBusy || operation('restart')?.enabled === false}>
                  <RotateCw size={15} />重启
                </button>
                <button type="button" onClick={() => void handleRefresh()} disabled={refreshing || operationBusy || operation('refresh-status')?.enabled === false}>
                  <RefreshCw size={15} />刷新状态
                </button>
                <label className="background-monitor-startup-mode">
                  <span>启动模式</span>
                  <select
                    aria-label="启动模式"
                    value={stringValue(selectedService.startupMode, 'manual')}
                    disabled={operationBusy || !selectedService.managed}
                    onChange={(event) => void handleStartupModeChange(event.target.value as BackgroundServiceStartupMode)}
                  >
                    <option value="normal">正常（自动拉起）</option>
                    <option value="manual">手动</option>
                    <option value="disabled">禁用</option>
                  </select>
                </label>
              </div>

              <dl className="background-monitor-runtime-facts" data-testid="background-monitor-runtime">
                <div><dt>角色</dt><dd>{stringValue(selectedService.role, 'service')}</dd></div>
                <div><dt>健康检查</dt><dd>{stringValue(selectedService.healthPath, '-')}</dd></div>
                <div><dt>响应 / 延迟</dt><dd>{numberValue(selectedService.responseStatus) || '-'} / {numberValue(selectedService.latencyMs)} ms</dd></div>
                <div><dt>运行时长</dt><dd>{formatRuntimeDuration(selectedService.uptimeMs)}</dd></div>
                <div><dt>生命周期</dt><dd>{stringValue(selectedService.lifecycle?.phase, selectedService.status)} · {stringValue(selectedService.lifecycle?.source, selectedService.control?.owner ?? 'unknown')}</dd></div>
                <div><dt>进程</dt><dd>{selectedService.lifecycle?.pid == null ? '-' : String(selectedService.lifecycle.pid)}</dd></div>
                <div><dt>控制边界</dt><dd>{selectedService.control?.mode === 'control' ? '允许生命周期操作' : '只读观察'} · {stringValue(selectedService.control?.owner, '未声明')}</dd></div>
                <div><dt>启动模式</dt><dd>{selectedService.startupMode === 'normal' ? '正常 · 进程退出自动拉起' : selectedService.startupMode === 'disabled' ? '禁用 · 保持停止' : '手动 · 不自动拉起'}</dd></div>
                <div><dt>监控日志</dt><dd>{lifecycleLogs.filter((log) => log.serviceId === selectedService.id).length} 条</dd></div>
              </dl>

              {selectedService.reason ? <div className="background-monitor-service-reason"><AlertTriangle size={14} />{selectedService.reason}</div> : null}

              <div className="background-monitor-host-strip">
                <span>Supervisor <strong>{supervisorStatus}</strong></span>
                <span>Task Worker <strong>{workerStatus}</strong></span>
                <span title={registry?.path ?? ''}>配置 <strong>{registry?.path ? '已加载' : '未提供'}</strong></span>
              </div>
            </div>
          ) : (
            <div className="background-monitor-empty background-monitor-runtime-empty">
              <Server size={22} />
              <strong>请选择一个运行服务</strong>
              <span>服务上报后可查看运行信息和协议能力</span>
            </div>
          )}
        </Panel>

        <Panel
          title="服务监控日志"
          className="background-monitor-runtime-panel background-monitor-logs-panel"
          action={(
            <div className="background-monitor-log-scope" aria-label="日志范围">
              <button type="button" className={logScope === 'service' ? 'is-active' : ''} onClick={() => setLogScope('service')} disabled={!selectedService}>当前服务</button>
              <button type="button" className={logScope === 'all' ? 'is-active' : ''} onClick={() => setLogScope('all')}>全部服务</button>
              <span title="启动、停止、重启、异常退出和自动拉起均由 supervisor 实时记录">实时审计 · {visibleLogs.length} 条</span>
            </div>
          )}
        >
          {visibleLogs.length ? (
            <div className="background-monitor-log-list" id="background-monitor-logs" data-testid="background-monitor-logs">
              {visibleLogs.map((log) => (
                <article className={`background-monitor-log-entry is-${log.outcome}`} key={log.id}>
                  <div className="background-monitor-lifecycle-event">
                    <span><FileText size={14} /><strong>{stringValue(log.serviceName, log.serviceId)}</strong> · {log.action}</span>
                    <time>{formatBackgroundMonitorTime(log.timestamp)}</time>
                  </div>
                  <p>{log.message}</p>
                  <div className="background-monitor-log-meta">
                    <span>来源 {log.source}</span>
                    <span>{log.pid ? `PID ${log.pid}` : '无进程号'}</span>
                    <span>{log.outcome === 'success' ? '成功' : log.outcome === 'failed' ? '失败' : '告警'}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="background-monitor-empty background-monitor-runtime-empty">
              <FileText size={22} />
              <strong>{loading ? '正在读取服务监控日志' : logScope === 'service' && selectedService ? '当前服务暂无生命周期操作记录' : '尚未产生生命周期操作记录'}</strong>
              <span>{runtime?.logRoot ?? 'supervisor 日志目录未上报'}</span>
            </div>
          )}
        </Panel>
      </section> : null}

      <footer className="background-monitor-footer" data-no-drag>
        <div>
          <span>数据源</span>
          <strong>{snapshot?.origin ?? origin}</strong>
          <time>最近更新 {snapshot ? formatBackgroundMonitorTime(snapshot.updatedAtUnixMs) : '-'}</time>
        </div>
        <span className="background-monitor-runtime-boundary">独立服务器进程 · 能力协议 {snapshot?.monitorProtocol?.version ?? 1} · {selectedService?.control?.mode === 'control' ? '受控操作' : '只读监控'}</span>
        {operationMessage ? <span className="background-monitor-operation" role="status">{operationMessage}</span> : null}
      </footer>
      </main>
    </>
  );
}
