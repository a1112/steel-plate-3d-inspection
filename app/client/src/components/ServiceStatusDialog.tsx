import { AlertTriangle, CheckCircle2, Play, RefreshCw, RotateCw, Server, Square, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  controlServiceSupervisor,
  readServiceSupervisorSnapshot,
  setServiceSupervisorStartupMode,
  type BackgroundMonitorService,
  type BackgroundMonitorSnapshot,
  type BackgroundServiceStartupMode,
} from '../lib/background-monitor';
import { formatBackgroundMonitorTime } from './BackgroundMonitorApp';

type ServiceStatusDialogProps = {
  onClose: () => void;
};

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function statusLabel(service: BackgroundMonitorService) {
  if (service.ok) return '运行中';
  if (service.status === 'starting') return '启动中';
  if (service.status === 'disabled') return '已禁用';
  return '已停止';
}

function modeLabel(mode: string | undefined) {
  if (mode === 'normal') return '正常 · 自动拉起';
  if (mode === 'disabled') return '禁用';
  return '手动';
}

export function ServiceStatusDialog({ onClose }: ServiceStatusDialogProps) {
  const [snapshot, setSnapshot] = useState<BackgroundMonitorSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async (signal?: AbortSignal) => {
    try {
      const next = await readServiceSupervisorSnapshot(signal);
      setSnapshot(next);
      setError(null);
    } catch (nextError) {
      if (!signal?.aborted) setError(errorText(nextError, '服务 supervisor 不可达'));
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = globalThis.setInterval(() => void refresh(controller.signal), 1_000);
    return () => {
      controller.abort();
      globalThis.clearInterval(timer);
    };
  }, []);

  const services = snapshot?.services ?? [];
  const selected = services.find((service) => service.id === selectedId) ?? services[0] ?? null;
  const events = useMemo(
    () => (snapshot?.lifecycleLogs ?? [])
      .filter((event) => !selected || event.serviceId === selected.id)
      .slice(0, 30),
    [selected, snapshot?.lifecycleLogs],
  );

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  const runAction = async (action: 'start' | 'stop' | 'restart') => {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await controlServiceSupervisor(selected.id, action);
      setMessage(result.message);
      await refresh();
    } catch (nextError) {
      setMessage(errorText(nextError, '服务操作失败'));
    } finally {
      setBusy(false);
    }
  };

  const setMode = async (mode: BackgroundServiceStartupMode) => {
    if (!selected) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await setServiceSupervisorStartupMode(selected.id, mode);
      setMessage(result.message);
      await refresh();
    } catch (nextError) {
      setMessage(errorText(nextError, '启动模式设置失败'));
    } finally {
      setBusy(false);
    }
  };

  const healthy = snapshot?.healthyServiceCount ?? services.filter((service) => service.ok).length;

  return (
    <div className="service-status-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="service-status-dialog" role="dialog" aria-modal="true" aria-labelledby="service-status-title" data-no-drag>
        <header>
          <div>
            <span>TAURI SERVICE SUPERVISOR</span>
            <h2 id="service-status-title">服务状态与生命周期</h2>
            <p>真实健康探针 {healthy}/{services.length} · 每秒刷新</p>
          </div>
          <button type="button" aria-label="关闭服务状态" onClick={onClose}><X size={18} /></button>
        </header>

        {error ? <div className="service-status-error" role="alert"><AlertTriangle size={15} />{error}</div> : null}

        <div className="service-status-layout">
          <nav aria-label="受管服务">
            {services.map((service) => (
              <button
                type="button"
                key={service.id}
                className={selected?.id === service.id ? 'active' : ''}
                aria-pressed={selected?.id === service.id}
                onClick={() => setSelectedId(service.id)}
              >
                {service.ok ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                <span><strong>{service.name || service.id}</strong><small>{modeLabel(service.startupMode)}</small></span>
                <em>{statusLabel(service)}</em>
              </button>
            ))}
            {!services.length ? <p><Server size={18} />等待 supervisor 上报服务</p> : null}
          </nav>

          <div className="service-status-detail">
            {selected ? (
              <>
                <div className="service-status-heading">
                  <div><span>{selected.id}</span><strong>{selected.name}</strong><code>{selected.origin}</code></div>
                  <b className={selected.ok ? 'online' : 'offline'}>{statusLabel(selected)}</b>
                </div>
                <div className="service-status-actions" aria-label="服务生命周期操作">
                  <button type="button" disabled={busy || selected.operations?.find((item) => item.id === 'start')?.enabled === false} onClick={() => void runAction('start')}><Play size={14} />启动</button>
                  <button type="button" disabled={busy || selected.operations?.find((item) => item.id === 'stop')?.enabled === false} onClick={() => void runAction('stop')}><Square size={13} />停止</button>
                  <button type="button" disabled={busy || selected.operations?.find((item) => item.id === 'restart')?.enabled === false} onClick={() => void runAction('restart')}><RotateCw size={14} />重启</button>
                  <button type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} />刷新</button>
                  <label><span>启动模式</span><select aria-label="主界面启动模式" value={selected.startupMode || 'manual'} disabled={busy || !selected.managed} onChange={(event) => void setMode(event.target.value as BackgroundServiceStartupMode)}><option value="normal">正常（自动拉起）</option><option value="manual">手动</option><option value="disabled">禁用</option></select></label>
                </div>
                <dl>
                  <div><dt>真实探针</dt><dd>HTTP {selected.responseStatus || '-'} · {selected.latencyMs ?? 0} ms</dd></div>
                  <div><dt>进程</dt><dd>{selected.lifecycle?.pid ? `PID ${selected.lifecycle.pid}` : '未检测到'}</dd></div>
                  <div><dt>启动模式</dt><dd>{modeLabel(selected.startupMode)}</dd></div>
                  <div><dt>控制权</dt><dd>{selected.control?.owner || 'tauri-service-supervisor'}</dd></div>
                </dl>
                {selected.reason ? <p className="service-status-reason"><AlertTriangle size={14} />{selected.reason}</p> : null}
                <section className="service-status-events" aria-label="服务监控日志">
                  <h3>服务监控日志 <span>{events.length} 条</span></h3>
                  <div>
                    {events.map((event) => (
                      <article key={event.id}>
                        <time>{formatBackgroundMonitorTime(event.timestamp)}</time>
                        <strong>{event.action}</strong>
                        <span>{event.message}</span>
                        <em>{event.source}{event.pid ? ` · PID ${event.pid}` : ''}</em>
                      </article>
                    ))}
                    {!events.length ? <p>暂无启动、停止、重启或异常退出记录</p> : null}
                  </div>
                </section>
              </>
            ) : <div className="service-status-empty"><Server size={22} />请选择服务</div>}
          </div>
        </div>
        {message ? <footer role="status">{message}</footer> : null}
      </section>
    </div>
  );
}
