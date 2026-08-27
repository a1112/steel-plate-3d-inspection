import { AlertTriangle, LoaderCircle, Radar, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ThemeMode } from '../data/inspection';
import {
  discoverInspectionServices,
  type ConnectionConfig,
} from '../services/inspection-api';

export function ConnectionRecoveryDialog({
  error,
  initialConnection,
  theme,
  retrying = false,
  onDismiss,
  onRetry,
}: {
  error: string;
  initialConnection: ConnectionConfig;
  theme: ThemeMode;
  retrying?: boolean;
  onDismiss: () => void;
  onRetry: (connection: ConnectionConfig) => void;
}) {
  const [draft, setDraft] = useState<ConnectionConfig>(() => ({
    mode: 'online',
    host: initialConnection.host,
    port: initialConnection.port,
    protocol: initialConnection.protocol,
  }));
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [hostEdited, setHostEdited] = useState(false);
  const hostValid = draft.host.trim().length > 0;
  const portValid = Number.isInteger(draft.port) && draft.port >= 1 && draft.port <= 65535;

  const retryDraft = useCallback(() => {
    setHostEdited(false);
    onRetry({
      mode: 'online',
      host: draft.host.trim(),
      port: draft.port,
      ...(draft.protocol ? { protocol: draft.protocol } : {}),
    });
  }, [draft.host, draft.port, draft.protocol, onRetry]);

  useEffect(() => {
    if (!hostEdited || !hostValid || !portValid || discoveryBusy || retrying) {
      return;
    }
    const timeout = window.setTimeout(() => {
      setStatus(`正在连接 ${draft.host.trim()}:${draft.port} 并刷新数据…`);
      retryDraft();
    }, 800);
    return () => window.clearTimeout(timeout);
  }, [draft.host, draft.port, discoveryBusy, hostEdited, hostValid, portValid, retryDraft, retrying]);

  const discover = async () => {
    setDiscoveryBusy(true);
    setStatus('正在自动发现局域网检测服务…');
    try {
      const result = await discoverInspectionServices(draft);
      const preferred = result.preferred ?? result.addresses[0];
      if (!preferred) {
        throw new Error('未发现可用的检测服务地址');
      }
      setDraft({
        mode: 'online',
        host: preferred.host,
        port: preferred.port,
        protocol: preferred.origin.startsWith('https://') ? 'https' : 'http',
      });
      setStatus(`已发现并填写 ${preferred.host}:${preferred.port}`);
    } catch (discoveryError) {
      setStatus(discoveryError instanceof Error ? discoveryError.message : '自动发现失败');
    } finally {
      setDiscoveryBusy(false);
    }
  };

  return (
    <div className={`connection-recovery-backdrop theme-${theme}`} role="presentation">
      <section
        className="connection-recovery-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="connection-recovery-title"
        aria-describedby="connection-recovery-detail"
        data-no-drag
      >
        <header>
          <span className="connection-recovery-icon"><AlertTriangle size={22} /></span>
          <div>
            <span>连接提示</span>
            <h2 id="connection-recovery-title">未连接到检测服务</h2>
          </div>
          <button type="button" aria-label="关闭连接提示" onClick={onDismiss}><X size={18} /></button>
        </header>

        <p id="connection-recovery-detail">{error}</p>
        <p className="connection-recovery-hint">
          系统已使用本地预览数据进入主界面。请配置检测服务的 IP 和端口后重试。
        </p>

        <div className="connection-recovery-fields">
          <label>
            <span>协议</span>
            <select
              aria-label="连接协议"
              value={draft.protocol ?? 'http'}
              onChange={(event) => setDraft((current) => ({ ...current, protocol: event.target.value as 'http' | 'https' }))}
            >
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
            </select>
          </label>
          <label>
            <span>服务端 IP</span>
            <input
              autoFocus
              aria-label="服务端 IP"
              value={draft.host}
              placeholder="例如 192.168.1.20"
              onChange={(event) => {
                setDraft((current) => ({ ...current, host: event.target.value }));
                setHostEdited(true);
                setStatus('IP 已更新，停止输入后将自动保存并刷新');
              }}
            />
          </label>
          <label>
            <span>端口</span>
            <input
              aria-label="服务端端口"
              type="number"
              min={1}
              max={65535}
              value={draft.port}
              onChange={(event) => setDraft((current) => ({ ...current, port: Number(event.target.value) }))}
            />
          </label>
        </div>

        {status ? <div className="connection-recovery-status" role="status">{status}</div> : null}

        <footer>
          <button type="button" className="secondary" onClick={onDismiss}>直接进入</button>
          <button type="button" className="secondary" disabled={discoveryBusy || retrying} onClick={() => void discover()}>
            {discoveryBusy ? <LoaderCircle className="spin" size={16} /> : <Radar size={16} />}
            {discoveryBusy ? '正在发现' : '自动发现'}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!hostValid || !portValid || discoveryBusy || retrying}
            onClick={retryDraft}
          >
            {retrying ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
            {retrying ? '正在重试' : '保存并重试'}
          </button>
        </footer>
      </section>
    </div>
  );
}
