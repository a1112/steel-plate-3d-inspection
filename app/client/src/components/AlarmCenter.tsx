import { BellRing, CheckCircle2, History, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  acknowledgeAlarm,
  fetchAlarmPage,
  resolveAlarm,
  type AlarmCounts,
  type AlarmLifecycleStatus,
  type AlarmListStatus,
  type AlarmPage,
  type PersistentAlarm,
} from '../services/alarm-api';

const ALARM_PAGE_SIZE = 20;

type AlarmView = 'active' | 'history';
type ActiveAlarmStatus = 'open' | 'active' | 'acknowledged';
type AlarmAction = 'acknowledge' | 'resolve';

type AlarmFilterDraft = {
  severity: string;
  source: string;
  keyword: string;
};

const emptyFilters: AlarmFilterDraft = {
  severity: '',
  source: '',
  keyword: '',
};

const emptyAlarmPage: AlarmPage = {
  code: 0,
  total: 0,
  limit: ALARM_PAGE_SIZE,
  offset: 0,
  alarms: [],
  counts: { active: 0, acknowledged: 0, resolved: 0 },
};

function formatAlarmTime(value: string) {
  if (!value) {
    return '--';
  }
  const numericValue = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  const date = new Date(Number.isFinite(numericValue) ? numericValue : value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function alarmStatusLabel(status: string) {
  if (status === 'active') {
    return '未确认';
  }
  if (status === 'acknowledged') {
    return '已确认待解除';
  }
  if (status === 'resolved') {
    return '已解除';
  }
  return status || '未知';
}

function alarmSeverityLabel(severity: string) {
  const labels: Record<string, string> = {
    critical: '紧急',
    severe: '严重',
    error: '错误',
    warning: '警告',
    review: '待复核',
    info: '提示',
    minor: '一般',
  };
  return labels[severity] ?? (severity || '未知');
}

function alarmSeverityTone(severity: string) {
  if (severity === 'critical' || severity === 'severe' || severity === 'error') {
    return 'critical';
  }
  if (severity === 'warning' || severity === 'review') {
    return 'warning';
  }
  return 'info';
}

function alarmDetailsText(details: unknown) {
  if (!details) {
    return '';
  }
  if (typeof details === 'string') {
    return details;
  }
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function isLifecycleStatus(value: string): value is AlarmLifecycleStatus {
  return value === 'active' || value === 'acknowledged' || value === 'resolved';
}

function transitionCounts(counts: AlarmCounts, previousStatus: string, nextStatus: string): AlarmCounts {
  const next = { ...counts };
  if (isLifecycleStatus(previousStatus)) {
    next[previousStatus] = Math.max(0, next[previousStatus] - 1);
  }
  if (isLifecycleStatus(nextStatus)) {
    next[nextStatus] += 1;
  }
  return next;
}

function alarmMatchesStatus(status: AlarmListStatus, alarmStatus: string) {
  if (status === 'open') {
    return alarmStatus === 'active' || alarmStatus === 'acknowledged';
  }
  if (status === 'history') {
    return alarmStatus === 'resolved';
  }
  return status === 'all' || status === alarmStatus;
}

function AlarmAuditTrail({ alarm }: { alarm: PersistentAlarm }) {
  return (
    <div className="alarm-center-audit">
      <div>
        <span>发生时间</span>
        <strong>{formatAlarmTime(alarm.createdAt)}</strong>
      </div>
      {alarm.acknowledgedBy ? (
        <div>
          <span>确认人</span>
          <strong>{alarm.acknowledgedBy}</strong>
          <time>{formatAlarmTime(alarm.acknowledgedAt)}</time>
          <p>{alarm.acknowledgeNote || '未填写确认说明'}</p>
        </div>
      ) : (
        <div className="pending">
          <span>确认状态</span>
          <strong>尚未确认</strong>
        </div>
      )}
      {alarm.resolvedBy ? (
        <div>
          <span>解除人</span>
          <strong>{alarm.resolvedBy}</strong>
          <time>{formatAlarmTime(alarm.resolvedAt)}</time>
          <p>{alarm.resolveNote || '未填写解除说明'}</p>
        </div>
      ) : null}
    </div>
  );
}

export function AlarmCenter({ pollIntervalMs = 10_000 }: { pollIntervalMs?: number }) {
  const [view, setView] = useState<AlarmView>('active');
  const [activeStatus, setActiveStatus] = useState<ActiveAlarmStatus>('open');
  const [filterDraft, setFilterDraft] = useState<AlarmFilterDraft>(emptyFilters);
  const [filters, setFilters] = useState<AlarmFilterDraft>(emptyFilters);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<AlarmPage>(emptyAlarmPage);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);
  const [actionEditor, setActionEditor] = useState<{ alarmId: string; action: AlarmAction; note: string } | null>(null);
  const [actionRequest, setActionRequest] = useState<{ alarmId: string; action: AlarmAction } | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState('');
  const requestVersion = useRef(0);

  const status: AlarmListStatus = view === 'history' ? 'history' : activeStatus;
  const pageNumber = Math.floor(offset / ALARM_PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(page.total / ALARM_PAGE_SIZE));

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    const load = async (showLoading: boolean) => {
      const version = ++requestVersion.current;
      if (showLoading) {
        setLoading(true);
      }
      try {
        const result = await fetchAlarmPage(
          {
            status,
            severity: filters.severity,
            source: filters.source,
            keyword: filters.keyword,
            limit: ALARM_PAGE_SIZE,
            offset,
          },
          controller.signal,
        );
        if (!disposed && version === requestVersion.current) {
          setPage(result);
          setLoadError('');
          setLastUpdatedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
        }
      } catch (error) {
        if (!disposed && version === requestVersion.current && !(error instanceof Error && error.name === 'AbortError')) {
          setLoadError(error instanceof Error ? error.message : '报警列表加载失败');
        }
      } finally {
        if (!disposed && version === requestVersion.current) {
          setLoading(false);
        }
      }
    };

    void load(true);
    const intervalId = pollIntervalMs > 0 ? window.setInterval(() => void load(false), pollIntervalMs) : undefined;
    return () => {
      disposed = true;
      controller.abort();
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
      }
    };
  }, [filters, offset, pollIntervalMs, refreshToken, status]);

  const visibleSummary = useMemo(
    () => ({
      open: page.counts.active + page.counts.acknowledged,
      active: page.counts.active,
      acknowledged: page.counts.acknowledged,
      resolved: page.counts.resolved,
    }),
    [page.counts],
  );

  const changeView = (next: AlarmView) => {
    setView(next);
    setOffset(0);
    setActionEditor(null);
    setActionError('');
    setActionMessage('');
  };

  const openActionEditor = (alarmId: string, action: AlarmAction) => {
    setActionEditor({ alarmId, action, note: '' });
    setActionError('');
    setActionMessage('');
  };

  const submitAlarmAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!actionEditor || actionRequest) {
      return;
    }
    const note = actionEditor.note.trim();
    if (!note) {
      setActionError('请填写处置说明，作为报警闭环审计依据。');
      return;
    }

    const { alarmId, action } = actionEditor;
    setActionRequest({ alarmId, action });
    setActionError('');
    try {
      const updated = action === 'acknowledge' ? await acknowledgeAlarm(alarmId, note) : await resolveAlarm(alarmId, note);
      setPage((current) => {
        const previous = current.alarms.find((alarm) => alarm.id === alarmId);
        const matches = alarmMatchesStatus(status, updated.status);
        const alarms = matches
          ? current.alarms.map((alarm) => (alarm.id === alarmId ? updated : alarm))
          : current.alarms.filter((alarm) => alarm.id !== alarmId);
        return {
          ...current,
          alarms,
          total: matches || !previous ? current.total : Math.max(0, current.total - 1),
          counts: previous ? transitionCounts(current.counts, previous.status, updated.status) : current.counts,
        };
      });
      setActionEditor(null);
      setActionMessage(
        action === 'acknowledge'
          ? `报警 ${alarmId} 已由 ${updated.acknowledgedBy || '当前登录用户'} 确认。`
          : `报警 ${alarmId} 已由 ${updated.resolvedBy || '当前登录用户'} 解除。`,
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : action === 'acknowledge' ? '报警确认失败' : '报警解除失败');
    } finally {
      setActionRequest(null);
    }
  };

  return (
    <main className="alarm-center-page" aria-labelledby="alarm-center-title">
      <header className="alarm-center-header">
        <div>
          <span className="alarm-center-kicker">持久报警闭环</span>
          <h1 id="alarm-center-title">报警中心</h1>
          <p>报警由 Rust 服务持久保存；确认与解除身份取自当前后台登录会话。</p>
        </div>
        <button type="button" className="alarm-center-refresh" disabled={loading} onClick={() => setRefreshToken((current) => current + 1)}>
          <RefreshCw size={16} className={loading ? 'spinning' : ''} />
          {loading ? '加载中…' : '刷新'}
        </button>
      </header>

      <section className="alarm-center-summary" aria-label="报警数量摘要">
        <div className="open">
          <BellRing size={19} />
          <span>活动报警</span>
          <strong>{visibleSummary.open}</strong>
        </div>
        <div className="active">
          <BellRing size={19} />
          <span>未确认</span>
          <strong>{visibleSummary.active}</strong>
        </div>
        <div className="acknowledged">
          <ShieldCheck size={19} />
          <span>待解除</span>
          <strong>{visibleSummary.acknowledged}</strong>
        </div>
        <div className="resolved">
          <CheckCircle2 size={19} />
          <span>历史已解除</span>
          <strong>{visibleSummary.resolved}</strong>
        </div>
      </section>

      <section className="alarm-center-toolbar">
        <div className="alarm-center-tabs" role="tablist" aria-label="报警视图">
          <button type="button" role="tab" aria-selected={view === 'active'} className={view === 'active' ? 'active' : ''} onClick={() => changeView('active')}>
            <BellRing size={16} />
            活动报警
          </button>
          <button type="button" role="tab" aria-selected={view === 'history'} className={view === 'history' ? 'active' : ''} onClick={() => changeView('history')}>
            <History size={16} />
            历史报警
          </button>
        </div>

        <form
          className="alarm-center-filters"
          aria-label="报警筛选"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters({ ...filterDraft });
            setOffset(0);
          }}
        >
          {view === 'active' ? (
            <label>
              <span>活动状态</span>
              <select
                aria-label="活动报警状态"
                value={activeStatus}
                onChange={(event) => {
                  setActiveStatus(event.target.value as ActiveAlarmStatus);
                  setOffset(0);
                }}
              >
                <option value="open">全部未解除</option>
                <option value="active">仅未确认</option>
                <option value="acknowledged">仅待解除</option>
              </select>
            </label>
          ) : null}
          <label>
            <span>级别</span>
            <select aria-label="报警级别" value={filterDraft.severity} onChange={(event) => setFilterDraft((current) => ({ ...current, severity: event.target.value }))}>
              <option value="">全部级别</option>
              <option value="critical">紧急</option>
              <option value="severe">严重</option>
              <option value="error">错误</option>
              <option value="warning">警告</option>
              <option value="review">待复核</option>
              <option value="info">提示</option>
            </select>
          </label>
          <label>
            <span>来源</span>
            <input aria-label="报警来源" value={filterDraft.source} placeholder="production-defect / camera / service" onChange={(event) => setFilterDraft((current) => ({ ...current, source: event.target.value }))} />
          </label>
          <label className="keyword">
            <span>关键词</span>
            <input aria-label="报警关键词" value={filterDraft.keyword} placeholder="材料、相机、消息或报警 ID" onChange={(event) => setFilterDraft((current) => ({ ...current, keyword: event.target.value }))} />
          </label>
          <button type="submit" className="primary">
            <Search size={15} />
            查询
          </button>
          <button
            type="button"
            onClick={() => {
              setFilterDraft(emptyFilters);
              setFilters(emptyFilters);
              setActiveStatus('open');
              setOffset(0);
            }}
          >
            重置
          </button>
        </form>
      </section>

      {lastUpdatedAt ? <div className="alarm-center-updated">最后更新：{lastUpdatedAt}</div> : null}
      {loadError ? (
        <div className="alarm-center-error" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => setRefreshToken((current) => current + 1)}>重试</button>
        </div>
      ) : null}
      {actionMessage ? <div className="alarm-center-action-message" role="status">{actionMessage}</div> : null}

      <section className="alarm-center-list" aria-label={view === 'active' ? '活动报警列表' : '历史报警列表'} aria-busy={loading}>
        {loading ? <div className="alarm-center-empty">正在从服务端加载报警…</div> : null}
        {!loading && !loadError && page.alarms.length === 0 ? (
          <div className="alarm-center-empty">
            <CheckCircle2 size={28} />
            <strong>{view === 'active' ? '当前没有符合条件的活动报警' : '暂无符合条件的历史报警'}</strong>
            <span>本页不使用静态或演示报警数据。</span>
          </div>
        ) : null}
        {!loading ? page.alarms.map((alarm) => {
          const action = alarm.status === 'active' ? 'acknowledge' : alarm.status === 'acknowledged' ? 'resolve' : null;
          const editing = actionEditor?.alarmId === alarm.id;
          const submitting = actionRequest?.alarmId === alarm.id;
          const details = alarmDetailsText(alarm.details);
          return (
            <article key={alarm.id} className={`alarm-center-card severity-${alarmSeverityTone(alarm.severity)}`}>
              <header>
                <div>
                  <span className={`alarm-center-severity ${alarmSeverityTone(alarm.severity)}`}>{alarmSeverityLabel(alarm.severity)}</span>
                  <span className={`alarm-center-status status-${alarm.status}`}>{alarmStatusLabel(alarm.status)}</span>
                  <code>{alarm.id}</code>
                </div>
                <strong>{alarm.message || alarm.type || '未命名报警'}</strong>
              </header>

              <dl className="alarm-center-context">
                <div><dt>来源</dt><dd>{alarm.source || '--'}</dd></div>
                <div><dt>类型</dt><dd>{alarm.type || '--'}</dd></div>
                <div><dt>材料</dt><dd>{alarm.materialId || '--'}</dd></div>
                <div><dt>相机</dt><dd>{alarm.cameraId || '--'}</dd></div>
                <div><dt>检测</dt><dd>{alarm.inspectionId || '--'}</dd></div>
                <div><dt>会话</dt><dd>{alarm.sessionId || '--'}</dd></div>
              </dl>
              {details ? <pre className="alarm-center-details">{details}</pre> : null}
              <AlarmAuditTrail alarm={alarm} />

              {action ? (
                <div className="alarm-center-card-actions">
                  {!editing ? (
                    <button
                      type="button"
                      className={action === 'resolve' ? 'resolve' : 'acknowledge'}
                      aria-label={`${action === 'acknowledge' ? '确认' : '解除'}报警 ${alarm.id}`}
                      onClick={() => openActionEditor(alarm.id, action)}
                    >
                      {action === 'acknowledge' ? <ShieldCheck size={15} /> : <CheckCircle2 size={15} />}
                      {action === 'acknowledge' ? '确认报警' : '解除报警'}
                    </button>
                  ) : (
                    <form className="alarm-center-action-form" aria-label={`${action === 'acknowledge' ? '确认' : '解除'}报警 ${alarm.id} 表单`} onSubmit={submitAlarmAction}>
                      <label>
                        <span>{action === 'acknowledge' ? '确认说明' : '解除说明'}</span>
                        <textarea
                          aria-label={`${action === 'acknowledge' ? '确认' : '解除'}说明 ${alarm.id}`}
                          value={actionEditor.note}
                          disabled={submitting}
                          maxLength={1000}
                          placeholder="填写判断、处置过程或解除依据"
                          onChange={(event) => {
                            setActionEditor((current) => (current ? { ...current, note: event.target.value } : current));
                            if (actionError) {
                              setActionError('');
                            }
                          }}
                        />
                      </label>
                      {actionError ? <div className="alarm-center-action-error" role="alert">{actionError}</div> : null}
                      <div>
                        <button type="submit" className="primary" disabled={submitting}>
                          {submitting ? (action === 'acknowledge' ? '正在确认…' : '正在解除…') : action === 'acknowledge' ? '提交确认' : '提交解除'}
                        </button>
                        <button type="button" disabled={submitting} onClick={() => { setActionEditor(null); setActionError(''); }}>取消</button>
                      </div>
                    </form>
                  )}
                </div>
              ) : null}
            </article>
          );
        }) : null}
      </section>

      <footer className="alarm-center-pagination">
        <span>共 {page.total} 条 · 第 {pageNumber}/{pageCount} 页</span>
        <div>
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset((current) => Math.max(0, current - ALARM_PAGE_SIZE))}>上一页</button>
          <button type="button" disabled={offset + ALARM_PAGE_SIZE >= page.total || loading} onClick={() => setOffset((current) => current + ALARM_PAGE_SIZE)}>下一页</button>
        </div>
      </footer>
    </main>
  );
}
