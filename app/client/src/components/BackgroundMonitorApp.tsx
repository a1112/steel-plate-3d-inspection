import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Filter,
  RefreshCw,
  ServerCog,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  configureBackgroundMonitor,
  hasNativeBackgroundMonitor,
  listenBackgroundMonitor,
  readBackgroundMonitor,
  refreshBackgroundMonitor,
  type BackgroundMonitorSnapshot,
} from '../lib/background-monitor';
import { getTauriWindowApi } from '../lib/tauri-window';
import { getInspectionServiceOrigin } from '../services/inspection-api';
import { Panel } from './Panel';

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
  if (normalized === 'cancelled') return 'muted';
  return 'muted';
}

function readError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
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
        <em>{detail}</em>
      </div>
    </article>
  );
}

export type BackgroundMonitorAppProps = {
  origin?: string;
  className?: string;
};

/**
 * Read-only view of the Rust-owned durable task worker. Mutating task actions
 * intentionally do not belong in this surface; operations stay in the admin
 * and capture management windows.
 */
export function BackgroundMonitorApp({
  origin = getInspectionServiceOrigin(),
  className = '',
}: BackgroundMonitorAppProps) {
  const [snapshot, setSnapshot] = useState<BackgroundMonitorSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filters, setFilters] = useState<BackgroundMonitorFilters>({ query: '', status: 'all', kind: 'all' });
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
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

  const tasks = snapshot?.tasks ?? [];
  const taskKinds = useMemo(() => {
    const values = new Set(tasks.map((task) => stringValue(task.kind, 'unknown').toLowerCase()));
    return Array.from(values).sort((left, right) => backgroundTaskKindLabel(left).localeCompare(backgroundTaskKindLabel(right), 'zh-CN'));
  }, [tasks]);
  const filteredTasks = useMemo(() => filterBackgroundTasks(tasks, filters), [tasks, filters]);
  const attentionCount = snapshot
    ? Math.max(0, numberValue(snapshot.failedTasks) + numberValue(snapshot.blockedTasks))
    : 0;
  const state = (snapshot?.state ?? 'initializing') as MonitorState;
  const tone = monitorTone(state);
  const StateIcon = monitorStateIcon(state);
  const activeTask = snapshot?.activeTaskId
    ? tasks.find((task) => task.taskId === snapshot.activeTaskId) ?? null
    : tasks.find((task) => stringValue(task.status).toLowerCase() === 'running') ?? null;

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

  const updateFilter = (key: keyof BackgroundMonitorFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <main className={`workspace-page background-monitor-page ${className}`.trim()} data-testid="background-monitor-app">
      <header className="background-monitor-header">
        <div className="background-monitor-heading">
          <span>Rust 持久任务工作线程 · Tauri 系统托盘</span>
          <h1>后台任务监控</h1>
          <p>{snapshot?.detail ?? '正在读取后台服务与任务队列状态'}</p>
        </div>
        <div className="background-monitor-header-actions" data-no-drag>
          <span className={`background-monitor-state-badge is-${tone}`}>
            <StateIcon size={15} />
            {monitorStateLabel(state)}
          </span>
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
      </header>

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
          detail={snapshot?.serviceReady ? '服务已就绪' : snapshot?.serviceAvailable ? '服务已连接但未就绪' : '等待后台服务'}
          tone={tone}
          icon={StateIcon}
        />
        <SummaryCard
          label="Worker"
          value={snapshot?.workerRunning ? '在线' : '离线'}
          detail={snapshot ? `活动 ${numberValue(snapshot.activeTasks)} 项${snapshot.activeTaskId ? ` · ${snapshot.activeTaskId}` : ''}` : '等待工作线程状态'}
          tone={snapshot?.workerRunning ? 'healthy' : 'offline'}
          icon={ServerCog}
        />
        <SummaryCard
          label="队列"
          value={snapshot ? String(numberValue(snapshot.queueDepth)) : '—'}
          detail="等待处理的持久任务"
          tone={snapshot?.queueDepth ? 'busy' : 'healthy'}
          icon={Activity}
        />
        <SummaryCard
          label="关注计数"
          value={String(attentionCount)}
          detail={snapshot ? `失败/中断 ${numberValue(snapshot.failedTasks)} · 阻塞 ${numberValue(snapshot.blockedTasks)}` : '等待任务状态'}
          tone={attentionCount > 0 ? 'degraded' : 'healthy'}
          icon={attentionCount > 0 ? AlertTriangle : CheckCircle2}
        />
      </section>

      <section className="background-monitor-content">
        <Panel title="当前活动任务" className="background-monitor-active-panel">
          {activeTask ? (
            <article className="background-monitor-active-task" data-testid="background-monitor-active-task">
              <div className="background-monitor-active-task-heading">
                <div>
                  <span>任务 ID</span>
                  <strong>{stringValue(activeTask.taskId, '-')}</strong>
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
              <div className="background-monitor-progress" role="progressbar" aria-label="活动任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={backgroundTaskProgressPercent(numberValue(activeTask.progress))}>
                <span style={{ width: `${backgroundTaskProgressPercent(numberValue(activeTask.progress))}%` }} />
              </div>
              <time>{formatBackgroundMonitorTime(stringValue(activeTask.updatedAt))}</time>
            </article>
          ) : (
            <div className="background-monitor-empty background-monitor-active-empty">
              <CheckCircle2 size={24} />
              <strong>{loading ? '正在读取活动任务' : '当前没有运行中的任务'}</strong>
              <span>{snapshot?.activeTaskId ? `工作线程报告任务 ${snapshot.activeTaskId}，但任务列表尚未同步` : '后台工作线程处于空闲状态'}</span>
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
                        <div className="background-monitor-row-progress"><span style={{ width: `${progress}%` }} /></div>
                        <em>{progress}%</em>
                      </td>
                      <td><span className={`background-monitor-status-pill is-${taskStatusTone(status)}`}>{backgroundTaskStatusLabel(status)}</span></td>
                      <td><time>{formatBackgroundMonitorTime(stringValue(task.updatedAt))}</time></td>
                      <td className={task.error ? 'has-error' : ''}>{stringValue(task.error, '-')}</td>
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

      <footer className="background-monitor-footer" data-no-drag>
        <div>
          <span>数据源</span>
          <strong>{snapshot?.origin ?? origin}</strong>
          <time>最近更新 {snapshot ? formatBackgroundMonitorTime(snapshot.updatedAtUnixMs) : '-'}</time>
        </div>
        <span className="background-monitor-runtime-boundary">独立服务器进程 · 只读监控</span>
        {operationMessage ? <span className="background-monitor-operation" role="status">{operationMessage}</span> : null}
      </footer>
    </main>
  );
}
