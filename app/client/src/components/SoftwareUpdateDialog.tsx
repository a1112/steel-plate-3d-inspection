import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Download, RefreshCw, ShieldCheck, X } from 'lucide-react';
import {
  checkSoftwareUpdate,
  formatSoftwareUpdateError,
  installSoftwareUpdate,
  readSoftwareUpdateStatus,
  type SoftwareUpdateCheckResult,
  type SoftwareUpdateEvent,
  type SoftwareUpdateStatus,
} from '../lib/software-update';

type SoftwareUpdateDialogProps = {
  onClose: () => void;
};

type UpdatePhase = 'loading' | 'checking' | 'ready' | 'downloading' | 'installing' | 'installed' | 'error';

function formatBytes(bytes: number | null) {
  if (!bytes || bytes <= 0) return '--';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SoftwareUpdateDialog({ onClose }: SoftwareUpdateDialogProps) {
  const [status, setStatus] = useState<SoftwareUpdateStatus | null>(null);
  const [result, setResult] = useState<SoftwareUpdateCheckResult | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>('loading');
  const [message, setMessage] = useState('正在读取当前软件版本…');
  const [downloaded, setDownloaded] = useState(0);
  const [contentLength, setContentLength] = useState<number | null>(null);
  const busy = phase === 'checking' || phase === 'downloading' || phase === 'installing';
  const progress = contentLength && contentLength > 0
    ? Math.min(100, Math.round((downloaded / contentLength) * 100))
    : null;

  const runCheck = useCallback(async () => {
    setPhase('checking');
    setMessage('正在连接稳定版更新通道…');
    setResult(null);
    try {
      const next = await checkSoftwareUpdate();
      setResult(next);
      setPhase('ready');
      setMessage(next.available
        ? `发现新版本 ${next.version}`
        : '当前已经是最新版本');
    } catch (error) {
      setPhase('error');
      setMessage(formatSoftwareUpdateError(error));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    readSoftwareUpdateStatus()
      .then((next) => {
        if (disposed) return;
        setStatus(next);
        if (!next.configured) {
          setPhase('ready');
          setMessage(next.reason || '当前安装包未配置软件更新通道');
          return;
        }
        void runCheck();
      })
      .catch((error) => {
        if (disposed) return;
        setPhase('error');
        setMessage(formatSoftwareUpdateError(error));
      });
    return () => {
      disposed = true;
    };
  }, [runCheck]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [busy, onClose]);

  const handleUpdateEvent = (event: SoftwareUpdateEvent) => {
    if (event.event === 'started') {
      setPhase('downloading');
      setContentLength(event.data.contentLength ?? null);
      setMessage('正在下载签名更新包…');
    } else if (event.event === 'progress') {
      setPhase('downloading');
      setDownloaded(event.data.downloaded);
    } else if (event.event === 'downloaded') {
      setDownloaded((current) => contentLength || current);
      setMessage('更新包下载完成，签名验证通过');
    } else if (event.event === 'installing') {
      setPhase('installing');
      setMessage('正在安装更新，Windows 将自动关闭当前程序…');
    }
  };

  const install = async () => {
    setDownloaded(0);
    setContentLength(null);
    setPhase('downloading');
    setMessage('正在准备签名更新包…');
    try {
      await installSoftwareUpdate(handleUpdateEvent);
      setPhase('installed');
      setMessage('更新已安装，应用即将重新启动');
    } catch (error) {
      setPhase('error');
      setMessage(formatSoftwareUpdateError(error));
    }
  };

  return createPortal((
    <div
      className="software-update-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="software-update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="software-update-title"
        data-phase={phase}
        data-no-drag
      >
        <header>
          <div className="software-update-heading-icon"><Download size={20} /></div>
          <div>
            <span>稳定版通道</span>
            <h2 id="software-update-title">软件版本更新</h2>
          </div>
          <button type="button" aria-label="关闭软件更新" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="software-update-version-grid">
          <div>
            <span>当前版本</span>
            <strong>v{status?.currentVersion ?? result?.currentVersion ?? '--'}</strong>
          </div>
          <i aria-hidden="true">→</i>
          <div className={result?.available ? 'available' : ''}>
            <span>{result?.available ? '可用版本' : status?.configured ? '更新状态' : '通道状态'}</span>
            <strong>{result?.available
              ? `v${result.version}`
              : !status
                ? '--'
                : status.configured && result
                  ? '已是最新'
                  : '不可安装'}</strong>
          </div>
        </div>

        <div className={`software-update-state ${phase}`} role="status" aria-live="polite">
          {phase === 'error' ? <AlertTriangle size={17} />
            : phase === 'ready' && !result?.available ? <CheckCircle2 size={17} />
              : <RefreshCw size={17} className={busy ? 'spinning' : ''} />}
          <span>{message}</span>
        </div>

        {phase === 'downloading' || phase === 'installing' ? (
          <div className="software-update-progress" aria-label="更新下载进度">
            <div><i style={{ width: `${progress ?? 8}%` }} /></div>
            <span>{progress == null ? '下载中' : `${progress}%`}</span>
            <small>{formatBytes(downloaded)} / {formatBytes(contentLength)}</small>
          </div>
        ) : null}

        {result?.available ? (
          <div className="software-update-notes">
            <span>版本说明{result.date ? ` · ${new Date(result.date).toLocaleDateString()}` : ''}</span>
            <p>{result.notes?.trim() || '此版本未提供额外说明。'}</p>
          </div>
        ) : null}

        <div className="software-update-trust">
          <ShieldCheck size={16} />
          <span>更新包必须通过内置公钥签名校验；校验失败时不会执行安装。</span>
        </div>

        <footer>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>稍后</button>
          {status?.configured && !result?.available ? (
            <button type="button" disabled={busy} onClick={() => void runCheck()}>
              <RefreshCw size={15} /> 重新检查
            </button>
          ) : null}
          {result?.available ? (
            <button type="button" className="primary" disabled={busy} onClick={() => void install()}>
              <Download size={15} /> 下载并安装
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  ), document.body);
}
