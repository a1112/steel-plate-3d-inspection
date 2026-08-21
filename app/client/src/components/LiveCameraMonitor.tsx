import {
  Camera,
  CircleStop,
  HardDrive,
  Image as ImageIcon,
  LayoutGrid,
  Maximize2,
  Play,
  Radio,
  RefreshCw,
  Waves,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  captureStreamImageUrl,
  startCaptureStream,
  stopCaptureStream,
  type CaptureCameraStatus,
} from '../lib/capture-api';
import { CapturePlayback } from './CapturePlayback';

type PreviewKind = 'intensity' | 'depth';
type MonitorMode = 'live' | 'playback';

interface LiveMonitoringPageProps {
  statuses: CaptureCameraStatus[];
}

interface StableStreamImageProps {
  src: string;
  alt: string;
  title?: string;
  onDoubleClick?: () => void;
  onFrame: () => void;
  onError: () => void;
}

export function StableStreamImage({
  src,
  alt,
  title,
  onDoubleClick,
  onFrame,
  onError,
}: StableStreamImageProps) {
  const [displaySrc, setDisplaySrc] = useState('');
  const [pendingSrc, setPendingSrc] = useState('');
  const failedSrcRef = useRef('');

  useEffect(() => {
    if (!src) {
      setDisplaySrc('');
      setPendingSrc('');
      failedSrcRef.current = '';
      return;
    }
    if (!pendingSrc && src !== displaySrc && src !== failedSrcRef.current) {
      setPendingSrc(src);
    }
  }, [displaySrc, pendingSrc, src]);

  const commitPending = () => {
    if (!pendingSrc) return;
    failedSrcRef.current = '';
    setDisplaySrc(pendingSrc);
    setPendingSrc('');
    onFrame();
  };

  const rejectPending = () => {
    if (!pendingSrc) return;
    failedSrcRef.current = pendingSrc;
    setPendingSrc('');
    onError();
  };

  return (
    <>
      {displaySrc ? (
        <img src={displaySrc} alt={alt} title={title} onDoubleClick={onDoubleClick} />
      ) : null}
      {pendingSrc ? (
        <img
          className="live-monitor-image-preload"
          src={pendingSrc}
          alt={displaySrc ? '' : alt}
          aria-hidden={displaySrc ? true : undefined}
          title={displaySrc ? undefined : title}
          onDoubleClick={displaySrc ? undefined : onDoubleClick}
          onLoad={commitPending}
          onError={rejectPending}
        />
      ) : null}
    </>
  );
}

function cameraLabel(status: CaptureCameraStatus, index: number) {
  return status.name?.trim() || status.configId?.trim() || `C${status.deviceId || index + 1}`;
}

function formatFps(value?: number | null) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '0.0';
}

function formatFrameTime(value?: string | null) {
  if (!value) return '等待首帧';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function LiveMonitoringPage({ statuses }: LiveMonitoringPageProps) {
  const cameras = useMemo(
    () => statuses.filter((status) => status.enabled !== false),
    [statuses],
  );
  const connected = cameras.filter((status) => status.connected);
  const acquiring = cameras.filter((status) => status.continuousAcquiring);
  const [selectedIp, setSelectedIp] = useState('');
  const [focusedIp, setFocusedIp] = useState<string | null>(null);
  const [monitorMode, setMonitorMode] = useState<MonitorMode>('live');
  const [kind, setKind] = useState<PreviewKind>('intensity');
  const [playing, setPlaying] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('等待相机帧');
  const [refreshToken, setRefreshToken] = useState(0);
  const [renderedFrames, setRenderedFrames] = useState(0);
  const [renderedAt, setRenderedAt] = useState<number | null>(null);
  const [reconnectToken, setReconnectToken] = useState(0);
  const startedIpRef = useRef('');
  const startedAtRef = useRef(0);
  const pausedByUserRef = useRef(false);

  const selected = cameras.find((status) => status.ip === selectedIp)
    ?? connected[0]
    ?? cameras[0]
    ?? null;
  const selectedIndex = selected ? cameras.findIndex((status) => status.ip === selected.ip) : -1;
  const streamRunning = Boolean(selected?.streamRunning)
    || (playing && startedIpRef.current === selected?.ip);

  useEffect(() => {
    if (!selectedIp && connected[0]?.ip) setSelectedIp(connected[0].ip);
  }, [connected, selectedIp]);

  useEffect(() => {
    if (monitorMode !== 'live' || !selected?.streamRunning || playing || pausedByUserRef.current) return;
    startedIpRef.current = selected.ip;
    setPlaying(true);
    setMessage('实时帧已同步');
  }, [monitorMode, playing, selected?.ip, selected?.streamRunning]);

  useEffect(() => {
    if (monitorMode !== 'live' || !playing || !selected?.connected || startedIpRef.current === selected.ip) return undefined;
    let cancelled = false;
    setBusy(true);
    setMessage('正在接入实时采集…');
    void startCaptureStream({ ip: selected.ip, dataMode: 3, fpsLimit: 8 })
      .then((result) => {
        if (cancelled) return;
        if (result.code !== 0) throw new Error(result.error || result.message || `code ${result.code}`);
        startedIpRef.current = selected.ip;
        startedAtRef.current = Date.now();
        setRenderedFrames(0);
        setRenderedAt(null);
        setMessage('等待首帧');
      })
      .catch((error) => {
        if (cancelled) return;
        setPlaying(false);
        setMessage(error instanceof Error ? error.message : '实时采集启动失败');
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [monitorMode, playing, reconnectToken, selected?.connected, selected?.ip]);

  useEffect(() => {
    if (monitorMode !== 'live' || !playing || !selected?.connected || selected.streamRunning || startedIpRef.current !== selected.ip) {
      return undefined;
    }
    const remaining = Math.max(250, 5_000 - (Date.now() - startedAtRef.current));
    const timer = window.setTimeout(() => {
      startedIpRef.current = '';
      setReconnectToken((value) => value + 1);
      setMessage('实时流中断，正在重连…');
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [monitorMode, playing, selected?.connected, selected?.ip, selected?.streamRunning]);

  useEffect(() => {
    if (monitorMode !== 'live' || !playing || !selected?.ip) return undefined;
    const timer = window.setInterval(() => setRefreshToken((value) => value + 1), 220);
    return () => window.clearInterval(timer);
  }, [monitorMode, playing, selected?.ip]);

  const selectCamera = (ip: string) => {
    pausedByUserRef.current = false;
    startedIpRef.current = '';
    startedAtRef.current = 0;
    setSelectedIp(ip);
    setFocusedIp(ip);
    setRenderedFrames(0);
    setRenderedAt(null);
    setPlaying(true);
    setMessage('正在切换相机…');
  };

  const stop = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await stopCaptureStream(selected.ip);
      pausedByUserRef.current = true;
      startedIpRef.current = '';
      startedAtRef.current = 0;
      setPlaying(false);
      setMessage('实时播放已暂停');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '停止实时播放失败');
    } finally {
      setBusy(false);
    }
  };

  const play = () => {
    pausedByUserRef.current = false;
    startedIpRef.current = '';
    startedAtRef.current = 0;
    setPlaying(true);
    setMessage('正在接入实时采集…');
  };

  const imageUrl = selected && playing
    ? `${captureStreamImageUrl(selected.ip, kind)}&frame=${refreshToken}`
    : '';

  const handleImageLoad = () => {
    setRenderedFrames((value) => value + 1);
    setRenderedAt(Date.now());
    setMessage('实时帧已同步');
  };

  const returnToGrid = () => {
    setFocusedIp(null);
    setKind('intensity');
    setMessage('六相机实时帧已同步');
  };

  const changeMonitorMode = (next: MonitorMode) => {
    if (next === monitorMode) return;
    setMonitorMode(next);
    setFocusedIp(null);
    if (next === 'playback') {
      if (selected) void stopCaptureStream(selected.ip).catch(() => undefined);
      startedIpRef.current = '';
      setPlaying(false);
      return;
    }
    pausedByUserRef.current = false;
    setPlaying(true);
    setMessage('正在接入实时采集…');
  };

  return (
    <main className="live-monitor-page" aria-label="相机监控页面">
      <header className="live-monitor-header">
        <div className="live-monitor-title">
          <h1>相机监控</h1>
          <div className="live-monitor-mode-tabs" role="tablist" aria-label="相机监控模式">
            <button type="button" role="tab" aria-selected={monitorMode === 'live'} className={monitorMode === 'live' ? 'active' : ''} onClick={() => changeMonitorMode('live')}><Radio size={14} />实时</button>
            <button type="button" role="tab" aria-selected={monitorMode === 'playback'} className={monitorMode === 'playback' ? 'active' : ''} onClick={() => changeMonitorMode('playback')}><HardDrive size={14} />回放</button>
          </div>
        </div>
        {monitorMode === 'live' ? <div className="live-monitor-summary" aria-label="实时采集汇总">
          <span><i className={connected.length > 0 ? 'online' : ''} />相机在线 <b>{connected.length}/{cameras.length}</b></span>
          <span><Waves size={14} />连续采集 <b>{acquiring.length}/{cameras.length}</b></span>
          <span><ImageIcon size={14} />已显示 <b>{renderedFrames}</b> 帧</span>
        </div> : null}
      </header>

      {monitorMode === 'playback' ? (
        <CapturePlayback statuses={cameras} />
      ) : <section className={`live-monitor-layout ${focusedIp ? 'focused-mode' : 'grid-mode'}`}>
        {focusedIp ? (
          <>
          <article className="live-monitor-stage">
          <header className="live-monitor-stage-header">
            <div>
              <strong>{selected ? cameraLabel(selected, selectedIndex) : '未选择相机'}</strong>
              <span>{selected?.ip ?? '等待采集服务返回相机拓扑'}</span>
            </div>
            <div className="live-monitor-actions">
              <button className="live-monitor-grid-return" type="button" onClick={returnToGrid}>
                <LayoutGrid size={15} />返回六相机网格
              </button>
              <div className="live-monitor-modes" role="group" aria-label="实时图像类型">
                <button type="button" className={kind === 'intensity' ? 'active' : ''} onClick={() => setKind('intensity')}>灰度图</button>
                <button type="button" className={kind === 'depth' ? 'active' : ''} onClick={() => setKind('depth')}>深度图</button>
              </div>
              {playing ? (
                <button className="live-monitor-playback" type="button" onClick={() => void stop()} disabled={busy || !selected} aria-label="暂停相机实时播放">
                  <CircleStop size={15} />暂停播放
                </button>
              ) : (
                <button className="live-monitor-playback" type="button" onClick={play} disabled={busy || !selected?.connected} aria-label="启动相机实时播放">
                  {busy ? <RefreshCw size={15} className="spin" /> : <Play size={15} />}开始播放
                </button>
              )}
            </div>
          </header>

          <div className="live-monitor-viewport">
            {imageUrl ? (
              <StableStreamImage
                key={`${selected!.ip}:${kind}`}
                src={imageUrl}
                alt={`${cameraLabel(selected!, selectedIndex)} 实时${kind === 'intensity' ? '灰度' : '深度'}图`}
                title="双击返回六相机网格"
                onDoubleClick={returnToGrid}
                onFrame={handleImageLoad}
                onError={() => setMessage('等待相机有效帧')}
              />
            ) : (
              <div className="live-monitor-empty">
                <Camera size={54} />
                <strong>{selected ? message : '未发现采集相机'}</strong>
                <span>{selected ? '启动播放后将自动重连采集服务' : '请检查 SICK 采集服务与网络连接'}</span>
              </div>
            )}
            {selected ? (
              <div className="live-monitor-overlay">
                <span className={streamRunning ? 'running' : ''}><i />{streamRunning ? '实时播放中' : message}</span>
                <span>{kind === 'intensity' ? '灰度强度' : '深度高度'}</span>
                <span>{formatFps(selected.streamFps)} FPS</span>
                <span>流帧 {selected.streamFrames ?? renderedFrames}</span>
              </div>
            ) : null}
          </div>

          <footer className="live-monitor-stage-footer">
            <span><Radio size={13} />{message}</span>
            <span>前端最近刷新：{renderedAt ? new Date(renderedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--'}</span>
            <span>相机最近帧：{formatFrameTime(selected?.streamLastFrameAt ?? selected?.lastContinuousFrameAt)}</span>
            <span><HardDrive size={13} />{selected?.storageRoot || '采集存储根目录由服务端配置'}</span>
          </footer>
        </article>

        <aside className="live-monitor-camera-list" aria-label="实时监测相机">
          <header>
            <div>
              <span>CAMERA ARRAY</span>
              <h2>采集相机</h2>
            </div>
            <b>{connected.length} ONLINE</b>
          </header>
          <div role="tablist" aria-label="实时监测相机">
            {cameras.map((status, index) => {
              const active = status.ip === selected?.ip;
              return (
                <button
                  key={status.ip}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={active ? 'active' : ''}
                  disabled={!status.connected}
                  onClick={() => selectCamera(status.ip)}
                >
                  <span className="live-monitor-camera-index">{String(status.deviceId || index + 1).padStart(2, '0')}</span>
                  <span className="live-monitor-camera-copy">
                    <strong>{cameraLabel(status, index)}</strong>
                    <small>{status.ip}</small>
                  </span>
                  <span className="live-monitor-camera-telemetry">
                    <b className={status.connected ? 'online' : ''}>{status.connected ? '在线' : '离线'}</b>
                    <small>{formatFps(status.continuousFps)} FPS · {status.continuousFrameCount ?? 0} 帧</small>
                  </span>
                </button>
              );
            })}
          </div>
          {cameras.length === 0 ? (
            <div className="live-monitor-camera-list-empty">
              <RefreshCw size={24} className="spin" />
              <span>正在读取相机拓扑…</span>
            </div>
          ) : null}
        </aside>
          </>
        ) : (
          <article className="live-monitor-grid-stage">
            <header className="live-monitor-grid-header">
              <div>
                <strong>六相机实时画面</strong>
                <span>双击画面放大</span>
              </div>
              {playing ? (
                <button className="live-monitor-playback" type="button" onClick={() => void stop()} disabled={busy || !selected} aria-label="暂停六相机实时播放">
                  <CircleStop size={15} />暂停全部
                </button>
              ) : (
                <button className="live-monitor-playback" type="button" onClick={play} disabled={busy || !selected?.connected} aria-label="启动六相机实时播放">
                  {busy ? <RefreshCw size={15} className="spin" /> : <Play size={15} />}开始播放
                </button>
              )}
            </header>
            <div className="live-monitor-camera-grid" aria-label="六相机实时画面网格">
              {cameras.map((status, index) => {
                const label = cameraLabel(status, index);
                const gridImageUrl = status.connected && playing
                  ? `${captureStreamImageUrl(status.ip, 'intensity-grid')}&frame=${refreshToken}`
                  : '';
                return (
                  <section
                    key={status.ip}
                    className={`live-monitor-grid-card ${status.connected ? 'online' : 'offline'}`}
                    role="button"
                    tabIndex={status.connected ? 0 : -1}
                    aria-label={`放大 ${label} 实时画面`}
                    title={`双击放大 ${label}`}
                    onDoubleClick={() => status.connected && selectCamera(status.ip)}
                    onKeyDown={(event) => {
                      if (status.connected && (event.key === 'Enter' || event.key === ' ')) {
                        selectCamera(status.ip);
                      }
                    }}
                  >
                    <header>
                      <div>
                        <b>{label}</b>
                        <span>{status.ip}</span>
                      </div>
                      <span className={status.connected ? 'online' : ''}><i />{status.connected ? '在线' : '离线'}</span>
                    </header>
                    <div className="live-monitor-grid-viewport">
                      {gridImageUrl ? (
                        <StableStreamImage
                          src={gridImageUrl}
                          alt={`${label} 实时灰度图`}
                          onFrame={handleImageLoad}
                          onError={() => setMessage(`${label} 等待有效帧`)}
                        />
                      ) : (
                        <div className="live-monitor-grid-empty"><Camera size={28} /><span>{playing ? '等待相机帧' : '实时播放已暂停'}</span></div>
                      )}
                      <span className="live-monitor-grid-expand"><Maximize2 size={13} /></span>
                    </div>
                    <footer>
                      <span>{formatFps(status.streamFps ?? status.continuousFps)} FPS</span>
                      <span>实时流 {status.streamFrames ?? 0} 帧</span>
                      <span>连续采集 {status.continuousFrameCount ?? 0} 帧</span>
                    </footer>
                  </section>
                );
              })}
              {cameras.length === 0 ? (
                <div className="live-monitor-camera-list-empty">
                  <RefreshCw size={24} className="spin" />
                  <span>正在读取相机拓扑…</span>
                </div>
              ) : null}
            </div>
          </article>
        )}
      </section>}
    </main>
  );
}
