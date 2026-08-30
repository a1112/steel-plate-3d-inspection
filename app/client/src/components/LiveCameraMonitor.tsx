import {
  AlertTriangle,
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
  type CaptureHealth,
} from '../lib/capture-api';
import { CapturePlayback } from './CapturePlayback';

type PreviewKind = 'intensity' | 'depth';
type MonitorMode = 'live' | 'playback';
const STREAM_IMAGE_LOAD_TIMEOUT_MS = 8_000;
const STREAM_CONTROL_TIMEOUT_MS = 8_000;
const GRID_STREAM_BATCH_SIZE = 2;
const STALE_FRAME_FAILURE_LIMIT = 3;

export function gridStreamRevision(
  refreshToken: number,
  cameraIndex: number,
  cameraCount: number,
) {
  const count = Math.max(1, Math.trunc(cameraCount));
  const index = Math.max(0, Math.min(count - 1, Math.trunc(cameraIndex)));
  const token = Math.max(0, Math.trunc(refreshToken));
  // Give every camera one quiet initial-load window, then refresh two lanes at
  // a time. This prevents decoded lanes from starving cameras still waiting
  // for their first frame on WebView's bounded per-origin connection pool.
  if (token < count) return 0;
  const batchCount = Math.ceil(count / GRID_STREAM_BATCH_SIZE);
  const cameraBatch = Math.floor(index / GRID_STREAM_BATCH_SIZE);
  const refreshStep = token - count;
  if (refreshStep < cameraBatch) return 0;
  return 1 + Math.floor((refreshStep - cameraBatch) / batchCount);
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function stopStreamBestEffort(ip: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), STREAM_CONTROL_TIMEOUT_MS);
  void stopCaptureStream(ip, controller.signal)
    .catch(() => undefined)
    .finally(() => window.clearTimeout(timeout));
}

interface LiveMonitoringPageProps {
  statuses: CaptureCameraStatus[];
  health?: CaptureHealth | null;
  error?: string | null;
}

interface StableStreamImageProps {
  src: string;
  alt: string;
  title?: string;
  waitingLabel?: string;
  onDoubleClick?: () => void;
  onFrame: () => void;
  onError: () => void;
}

interface PendingStreamImage {
  id: number;
  src: string;
}

interface PendingStreamControlRequest {
  controller: AbortController;
  timeout: number;
}

export function StableStreamImage({
  src,
  alt,
  title,
  waitingLabel = '等待实时首帧',
  onDoubleClick,
  onFrame,
  onError,
}: StableStreamImageProps) {
  const [displaySrc, setDisplaySrc] = useState('');
  const [pending, setPending] = useState<PendingStreamImage | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const failureCountRef = useRef(0);
  const retryAtRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const loadTimerRef = useRef<number | null>(null);
  const nextAttemptIdRef = useRef(0);
  const pendingRef = useRef<PendingStreamImage | null>(null);

  const clearRetryTimer = () => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  };

  const clearLoadTimer = () => {
    if (loadTimerRef.current !== null) {
      window.clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
    }
  };

  const replacePending = (next: PendingStreamImage | null) => {
    pendingRef.current = next;
    setPending(next);
  };

  useEffect(() => () => {
    clearRetryTimer();
    clearLoadTimer();
    pendingRef.current = null;
  // Timer cleanup uses refs and is intentionally registered only once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!src) {
      setDisplaySrc('');
      replacePending(null);
      setRetrying(false);
      failureCountRef.current = 0;
      retryAtRef.current = 0;
      clearRetryTimer();
      clearLoadTimer();
      return;
    }
    if (pending || src === displaySrc) return;
    const retryDelay = retryAtRef.current - Date.now();
    if (retryDelay > 0) {
      if (retryTimerRef.current === null) {
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          setRetryRevision((value) => value + 1);
        }, retryDelay);
      }
      return;
    }
    const next = { id: nextAttemptIdRef.current + 1, src };
    nextAttemptIdRef.current = next.id;
    replacePending(next);
  // Timer helpers only mutate refs; pending is the request serialization gate.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displaySrc, pending, retryRevision, src]);

  const commitPending = (candidate: PendingStreamImage) => {
    if (pendingRef.current?.id !== candidate.id) return;
    clearLoadTimer();
    clearRetryTimer();
    failureCountRef.current = 0;
    retryAtRef.current = 0;
    setRetrying(false);
    setDisplaySrc(candidate.src);
    replacePending(null);
    onFrame();
  };

  const rejectPending = (candidate: PendingStreamImage) => {
    if (pendingRef.current?.id !== candidate.id) return;
    clearLoadTimer();
    failureCountRef.current += 1;
    if (failureCountRef.current >= STALE_FRAME_FAILURE_LIMIT) {
      // A decoded frame is useful during a brief refresh race, but after
      // repeated failures it is no longer honest realtime evidence.
      setDisplaySrc('');
    }
    retryAtRef.current = Date.now() + Math.min(5_000, 500 * (2 ** Math.min(4, failureCountRef.current - 1)));
    setRetrying(true);
    replacePending(null);
    onError();
  };

  useEffect(() => {
    clearLoadTimer();
    if (!pending) return undefined;
    loadTimerRef.current = window.setTimeout(() => {
      loadTimerRef.current = null;
      rejectPending(pending);
    }, STREAM_IMAGE_LOAD_TIMEOUT_MS);
    return clearLoadTimer;
  // Each pending request owns exactly one deadline; rejectPending validates its id.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  return (
    <>
      {displaySrc ? (
        <img src={displaySrc} alt={alt} title={title} onDoubleClick={onDoubleClick} />
      ) : null}
      {!displaySrc ? (
        <div className="live-monitor-empty live-monitor-stream-wait" role="status">
          <RefreshCw size={22} className="spin" />
          <strong>{retrying ? `${waitingLabel}，正在重试` : waitingLabel}</strong>
          <span>{retrying ? '尚未收到可解码图像，旧画面不会被黑帧替换' : '正在建立实时图像通道'}</span>
        </div>
      ) : null}
      {pending ? (
        <img
          className="live-monitor-image-preload"
          key={pending.id}
          src={pending.src}
          alt={displaySrc ? '' : alt}
          aria-hidden={displaySrc ? true : undefined}
          title={displaySrc ? undefined : title}
          onDoubleClick={displaySrc ? undefined : onDoubleClick}
          onLoad={() => commitPending(pending)}
          onError={() => rejectPending(pending)}
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

function imageQualityReasonLabel(reason: string) {
  const labels: Record<string, string> = {
    'camera-frame-missing': '相机掉线/无帧',
    'camera-connection-failed': '相机连接失败',
    'image-black': '图像近黑，可能被遮挡',
    'image-low-contrast': '图像低对比度，可能被遮挡',
    'image-overexposed': '图像过曝',
    'image-signal-degraded': '灰度信号明显下降',
    'depth-signal-degraded': '深度有效信号明显下降',
  };
  return labels[reason] ?? reason;
}

function cameraQualityLabel(status: CaptureCameraStatus) {
  const quality = status.imageQuality;
  if (!status.connected || quality?.status === 'offline') return '离线';
  if (quality?.status === 'blocked') return '疑似遮挡';
  if (quality?.status === 'degraded') return '图像异常';
  if (quality?.status === 'suspect') return '质量观察中';
  if (quality?.status === 'warming') return '质量学习中';
  return '在线';
}

export function LiveMonitoringPage({ statuses, health = null, error = null }: LiveMonitoringPageProps) {
  const cameras = useMemo(
    () => statuses.filter((status) => status.enabled !== false),
    [statuses],
  );
  const connected = cameras.filter((status) => status.connected);
  const acquiring = cameras.filter((status) => status.continuousAcquiring);
  const qualityAlarms = cameras.filter((status) => status.imageQuality?.alarmActive);
  const qualitySuspects = cameras.filter((status) => status.imageQuality?.status === 'suspect');
  const synchronization = health?.provider !== 'bkv'
    ? health?.acquisitionSynchronization
    : undefined;
  const recentTransportGaps = synchronization?.transportFrameGaps
    ?? Object.values(synchronization?.transportFrameGapCounts ?? {}).reduce((total, value) => total + value, 0);
  const synchronizationDegraded = Boolean(synchronization
    && (!synchronization.synchronized
      || synchronization.status === 'degraded'
      || synchronization.incompleteRounds > 0
      || recentTransportGaps > 0));
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
  const ownedStreamIpsRef = useRef(new Set<string>());
  const startingStreamIpsRef = useRef(new Set<string>());
  const locallyStoppedStreamIpsRef = useRef(new Set<string>());
  const streamStartedAtRef = useRef(new Map<string, number>());
  const lastStreamFrameAtRef = useRef(new Map<string, number>());
  const streamStartFailureCountRef = useRef(new Map<string, number>());
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAtRef = useRef(0);
  const pausedByUserRef = useRef(false);
  const mountedRef = useRef(true);
  const liveStreamDesiredRef = useRef(true);
  const streamLifecycleGenerationRef = useRef(0);
  const startRequestsRef = useRef(new Map<string, PendingStreamControlRequest>());
  const stopRequestsRef = useRef(new Set<PendingStreamControlRequest>());
  const activeStartBatchesRef = useRef(new Set<number>());
  const nextStartBatchIdRef = useRef(0);

  const streamTopologyKey = cameras
    .map((status) => `${status.ip}:${status.connected ? 1 : 0}:${status.streamRunning ? 1 : 0}`)
    .join('|');

  const selected = cameras.find((status) => status.ip === selectedIp)
    ?? connected[0]
    ?? cameras[0]
    ?? null;
  const selectedIndex = selected ? cameras.findIndex((status) => status.ip === selected.ip) : -1;
  const streamRunning = Boolean(selected?.streamRunning)
    || Boolean(selected && playing && (
      ownedStreamIpsRef.current.has(selected.ip)
      || startingStreamIpsRef.current.has(selected.ip)
    ));
  const canRequestStreamFrame = (status: CaptureCameraStatus) => {
    // Status polling can lag behind a successful local stop.  Never use that
    // stale streamRunning=true value to request the provider's cleared cache.
    if (locallyStoppedStreamIpsRef.current.has(status.ip)) return false;
    const startedAt = streamStartedAtRef.current.get(status.ip);
    if (ownedStreamIpsRef.current.has(status.ip) && startedAt !== undefined) {
      const lastFrameAt = lastStreamFrameAtRef.current.get(status.ip);
      if ((status.streamFrames ?? 0) > 0 || (lastFrameAt !== undefined && lastFrameAt >= startedAt)) {
        return true;
      }
      // /stream/start reports the subscription as running before the async
      // seed has published an image.  Keep the image element detached during
      // that warm-up so Edge never interprets the temporary JSON 404 as ORB.
      return Date.now() - startedAt >= 4_000;
    }
    if (status.streamRunning) return true;
    // Prefer the provider's running telemetry. The four-second fallback keeps
    // older providers usable without requesting their JSON "no frame" reply
    // as an image immediately after /api/stream/start (Edge reports that as
    // ERR_BLOCKED_BY_ORB).
    return ownedStreamIpsRef.current.has(status.ip)
      && startedAt !== undefined
      && Date.now() - startedAt >= 4_000;
  };

  const scheduleReconnect = (delayMs: number) => {
    if (!mountedRef.current || !liveStreamDesiredRef.current) return;
    const boundedDelay = Math.max(250, delayMs);
    const reconnectAt = Date.now() + boundedDelay;
    if (reconnectTimerRef.current !== null && reconnectAtRef.current <= reconnectAt) return;
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
    reconnectAtRef.current = reconnectAt;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectAtRef.current = 0;
      setReconnectToken((value) => value + 1);
    }, boundedDelay);
  };

  const stopStreams = async (ips: string[]) => {
    const uniqueIps = [...new Set(ips.filter(Boolean))];
    uniqueIps.forEach((ip) => locallyStoppedStreamIpsRef.current.add(ip));
    const results = await Promise.allSettled(uniqueIps.map(async (ip) => {
      const controller = new AbortController();
      const request: PendingStreamControlRequest = {
        controller,
        timeout: window.setTimeout(() => controller.abort(), STREAM_CONTROL_TIMEOUT_MS),
      };
      stopRequestsRef.current.add(request);
      try {
        const result = await stopCaptureStream(ip, controller.signal);
        if (result.code !== 0) {
          throw new Error(result.error || result.message || `code ${result.code}`);
        }
        ownedStreamIpsRef.current.delete(ip);
        streamStartedAtRef.current.delete(ip);
        lastStreamFrameAtRef.current.delete(ip);
        streamStartFailureCountRef.current.delete(ip);
        return ip;
      } catch (error) {
        locallyStoppedStreamIpsRef.current.delete(ip);
        throw isAbortError(error) ? new Error(`${ip} 停止请求超时`) : error;
      } finally {
        window.clearTimeout(request.timeout);
        stopRequestsRef.current.delete(request);
      }
    }));
    const stopped = results.filter((result) => result.status === 'fulfilled').length;
    const errors = results.flatMap((result) => result.status === 'rejected'
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : []);
    return { requested: uniqueIps.length, stopped, errors };
  };

  useEffect(() => () => {
    mountedRef.current = false;
    liveStreamDesiredRef.current = false;
    streamLifecycleGenerationRef.current += 1;
    const cleanupIps = [...new Set([
      ...ownedStreamIpsRef.current,
      ...startingStreamIpsRef.current,
      ...startRequestsRef.current.keys(),
    ])];
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
      reconnectAtRef.current = 0;
    }
    for (const request of startRequestsRef.current.values()) {
      window.clearTimeout(request.timeout);
      request.controller.abort();
    }
    startRequestsRef.current.clear();
    for (const request of stopRequestsRef.current) {
      window.clearTimeout(request.timeout);
      request.controller.abort();
    }
    stopRequestsRef.current.clear();
    ownedStreamIpsRef.current.clear();
    startingStreamIpsRef.current.clear();
    locallyStoppedStreamIpsRef.current.clear();
    streamStartedAtRef.current.clear();
    lastStreamFrameAtRef.current.clear();
    streamStartFailureCountRef.current.clear();
    activeStartBatchesRef.current.clear();
    for (const ip of cleanupIps) stopStreamBestEffort(ip);
  }, []);

  useEffect(() => {
    if (!selectedIp && connected[0]?.ip) setSelectedIp(connected[0].ip);
  }, [connected, selectedIp]);

  useEffect(() => {
    if (monitorMode !== 'live' || !selected?.streamRunning || playing || pausedByUserRef.current) return;
    setPlaying(true);
    setMessage('实时帧已同步');
  }, [monitorMode, playing, selected?.ip, selected?.streamRunning]);

  useEffect(() => {
    const desired = monitorMode === 'live' && playing;
    liveStreamDesiredRef.current = desired;
    streamLifecycleGenerationRef.current += 1;
    if (!desired) {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
        reconnectAtRef.current = 0;
      }
      for (const request of startRequestsRef.current.values()) request.controller.abort();
      setBusy(false);
    }
  }, [monitorMode, playing]);

  useEffect(() => {
    if (monitorMode !== 'live' || !playing) return undefined;
    const generation = streamLifecycleGenerationRef.current;
    const lifecycleIsActive = () => mountedRef.current
      && liveStreamDesiredRef.current
      && streamLifecycleGenerationRef.current === generation;
    const now = Date.now();
    let nextVerificationDelay = Number.POSITIVE_INFINITY;
    const targets = cameras.filter((status) => {
      if (!status.connected) return false;
      if (locallyStoppedStreamIpsRef.current.has(status.ip)) {
        if (status.streamRunning) return false;
        // The status API has now acknowledged our stop.  A subsequent start
        // is a new generation and must pass through the normal warm-up gate.
        locallyStoppedStreamIpsRef.current.delete(status.ip);
      }
      if (status.streamRunning || startingStreamIpsRef.current.has(status.ip)) {
        if (status.streamRunning && (status.streamFrames ?? 0) > 0) {
          streamStartedAtRef.current.delete(status.ip);
        }
        return false;
      }
      if (!ownedStreamIpsRef.current.has(status.ip)) return true;
      const startedAt = streamStartedAtRef.current.get(status.ip);
      const lastFrameAt = lastStreamFrameAtRef.current.get(status.ip);
      const activeAt = lastFrameAt && (startedAt === undefined || lastFrameAt >= startedAt)
        ? lastFrameAt
        : startedAt;
      if (activeAt === undefined) {
        ownedStreamIpsRef.current.delete(status.ip);
        return true;
      }
      // A successful API response is given ten seconds to publish its first
      // image. Afterwards a decoded frame itself becomes the liveness signal,
      // so lagging status telemetry cannot cause repeated start requests.
      const remaining = 10_000 - (now - activeAt);
      if (remaining > 0) {
        nextVerificationDelay = Math.min(nextVerificationDelay, remaining);
        return false;
      }
      ownedStreamIpsRef.current.delete(status.ip);
      streamStartedAtRef.current.delete(status.ip);
      return true;
    });
    if (Number.isFinite(nextVerificationDelay)) scheduleReconnect(nextVerificationDelay);
    if (targets.length === 0) return undefined;

    const batchId = nextStartBatchIdRef.current + 1;
    nextStartBatchIdRef.current = batchId;
    activeStartBatchesRef.current.add(batchId);
    targets.forEach((target) => startingStreamIpsRef.current.add(target.ip));
    setBusy(true);
    setMessage(`正在接入 ${targets.length} 路实时采集…`);
    void (async () => {
      let cursor = 0;
      let started = 0;
      const errors: string[] = [];
      const worker = async () => {
        while (lifecycleIsActive()) {
          const index = cursor;
          cursor += 1;
          const target = targets[index];
          if (!target) return;
          const controller = new AbortController();
          let timedOut = false;
          const request: PendingStreamControlRequest = {
            controller,
            timeout: window.setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, STREAM_CONTROL_TIMEOUT_MS),
          };
          startRequestsRef.current.set(target.ip, request);
          try {
            const result = await startCaptureStream(
              { ip: target.ip, dataMode: 3, fpsLimit: 2 },
              controller.signal,
            );
            if (result.code !== 0) throw new Error(result.error || result.message || `code ${result.code}`);
            if (!lifecycleIsActive()) {
              stopStreamBestEffort(target.ip);
              return;
            }
            ownedStreamIpsRef.current.add(target.ip);
            streamStartedAtRef.current.set(target.ip, Date.now());
            streamStartFailureCountRef.current.delete(target.ip);
            started += 1;
          } catch (error) {
            if (!lifecycleIsActive() && isAbortError(error)) return;
            streamStartFailureCountRef.current.set(
              target.ip,
              (streamStartFailureCountRef.current.get(target.ip) ?? 0) + 1,
            );
            const detail = timedOut
              ? '启动请求超时'
              : error instanceof Error ? error.message : '启动失败';
            errors.push(`${cameraLabel(target, cameras.indexOf(target))}: ${detail}`);
          } finally {
            window.clearTimeout(request.timeout);
            if (startRequestsRef.current.get(target.ip) === request) {
              startRequestsRef.current.delete(target.ip);
            }
            startingStreamIpsRef.current.delete(target.ip);
          }
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(2, targets.length) }, () => worker()));
        if (!lifecycleIsActive()) return;
        setRenderedFrames(0);
        setRenderedAt(null);
        if (errors.length > 0) {
          setMessage(`${started}/${targets.length} 路已启动；${errors.join('；')}`);
          const highestFailureCount = Math.max(
            1,
            ...targets.map((target) => streamStartFailureCountRef.current.get(target.ip) ?? 0),
          );
          scheduleReconnect(Math.min(30_000, 2_000 * (2 ** Math.min(4, highestFailureCount - 1))));
        } else {
          setMessage(`已启动 ${started} 路实时预览，等待首帧`);
          // Re-render once after provider warm-up; the lifecycle watchdog then
          // keeps its separate ten-second first-frame deadline.
          scheduleReconnect(4_000);
        }
      } finally {
        targets.forEach((target) => startingStreamIpsRef.current.delete(target.ip));
        activeStartBatchesRef.current.delete(batchId);
        if (mountedRef.current && activeStartBatchesRef.current.size === 0) setBusy(false);
        if (mountedRef.current && liveStreamDesiredRef.current && !lifecycleIsActive()) {
          scheduleReconnect(250);
        }
      }
    })();
    return undefined;
  // The topology key is the stable, per-camera dependency for stream lifecycle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitorMode, playing, reconnectToken, streamTopologyKey]);

  useEffect(() => {
    if (monitorMode !== 'live' || !playing) return undefined;
    // The provider publishes at most two previews per second. Polling faster
    // only creates duplicate six-camera proxy requests and delays history/API
    // responses while adding no visible frames.
    const timer = window.setInterval(() => setRefreshToken((value) => value + 1), 500);
    return () => window.clearInterval(timer);
  }, [monitorMode, playing]);

  const selectCamera = (ip: string) => {
    pausedByUserRef.current = false;
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
      const targetIps = focusedIp ? [selected.ip] : connected.map((status) => status.ip);
      const result = await stopStreams(targetIps);
      pausedByUserRef.current = true;
      setPlaying(false);
      setMessage(result.errors.length > 0
        ? `已暂停 ${result.stopped}/${result.requested} 路；${result.errors.join('；')}`
        : focusedIp ? `${cameraLabel(selected, selectedIndex)} 实时播放已暂停` : '六相机实时播放已暂停');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '停止实时播放失败');
    } finally {
      setBusy(false);
    }
  };

  const play = () => {
    pausedByUserRef.current = false;
    setPlaying(true);
    setMessage('正在接入实时采集…');
  };

  const imageUrl = selected && playing && canRequestStreamFrame(selected)
    ? captureStreamImageUrl(selected.ip, kind, refreshToken)
    : '';

  const handleImageLoad = (ip: string) => {
    lastStreamFrameAtRef.current.set(ip, Date.now());
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
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const targetIps = connected.map((status) => status.ip);
      void stopStreams(targetIps).catch(() => undefined);
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
          <span
            className={qualityAlarms.length > 0 || qualitySuspects.length > 0 ? 'warning' : ''}
            title={qualityAlarms.map((status, index) => `${cameraLabel(status, index)}：${(status.imageQuality?.reasons ?? []).map(imageQualityReasonLabel).join('、')}`).join('；') || '实时图像质量正常'}
          >
            <AlertTriangle size={14} />图像质量 <b>{qualityAlarms.length > 0 ? `${qualityAlarms.length} 路报警` : qualitySuspects.length > 0 ? `${qualitySuspects.length} 路观察` : '正常'}</b>
          </span>
          <span className={synchronizationDegraded ? 'warning' : ''} title={synchronization
            ? [
                synchronization.lastRound?.missingCameras?.length
                  ? `最近轮次缺少：${synchronization.lastRound.missingCameras.join('、')}`
                  : '最近轮次相机齐全',
                `窗口完整 ${synchronization.completeRounds}/${synchronization.windowRounds}`,
                `传输序号间隙 ${recentTransportGaps}`,
              ].join('；')
            : '等待同步采集统计'}>
            <Radio size={14} />{synchronizationDegraded ? '同步降级' : '同步'} <b>{synchronization
              ? `${synchronization.connectedCameras}/${synchronization.expectedCameras} · 偏差 ${synchronization.frameCountSkew}${recentTransportGaps > 0 ? ` · 丢帧 ${recentTransportGaps}` : ''}`
              : '等待'}</b>
          </span>
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
            {selected?.imageQuality?.alarmActive ? (
              <div className="live-monitor-quality-alert" role="alert">
                <AlertTriangle size={16} />
                <strong>{cameraQualityLabel(selected)}</strong>
                <span>{(selected.imageQuality.reasons ?? []).map(imageQualityReasonLabel).join('；')}</span>
                {selected.imageQuality.automaticReconnect?.pending ? <em>正在自动重连</em> : null}
              </div>
            ) : null}
            {imageUrl ? (
              <StableStreamImage
                key={`${selected!.ip}:${kind}`}
                src={imageUrl}
                alt={`${cameraLabel(selected!, selectedIndex)} 实时${kind === 'intensity' ? '灰度' : '深度'}图`}
                title="双击返回六相机网格"
                waitingLabel={`${cameraLabel(selected!, selectedIndex)} 等待首帧`}
                onDoubleClick={returnToGrid}
                onFrame={() => handleImageLoad(selected!.ip)}
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
                    <b className={status.imageQuality?.alarmActive ? 'warning' : status.connected ? 'online' : ''}>{cameraQualityLabel(status)}</b>
                    <small>{formatFps(status.continuousFps)} FPS · {status.continuousFrameCount ?? 0} 帧</small>
                  </span>
                </button>
              );
            })}
          </div>
          {cameras.length === 0 ? (
            <div className="live-monitor-camera-list-empty">
              {error ? <AlertTriangle size={24} /> : <RefreshCw size={24} className="spin" />}
              <span>{error ? '采集服务离线' : '正在读取相机拓扑…'}</span>
              {error ? <small title={error}>{error}</small> : null}
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
                const gridImageUrl = status.connected && playing && canRequestStreamFrame(status)
                  ? captureStreamImageUrl(
                    status.ip,
                    'intensity-grid',
                    gridStreamRevision(refreshToken, index, cameras.length),
                  )
                  : '';
                return (
                  <section
                    key={status.ip}
                    className={`live-monitor-grid-card ${status.connected ? 'online' : 'offline'} ${status.imageQuality?.alarmActive ? 'quality-alarm' : status.imageQuality?.status === 'suspect' ? 'quality-suspect' : ''}`}
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
                      <span className={status.imageQuality?.alarmActive ? 'warning' : status.connected ? 'online' : ''}><i />{cameraQualityLabel(status)}</span>
                    </header>
                    <div className="live-monitor-grid-viewport">
                      {gridImageUrl ? (
                        <StableStreamImage
                          src={gridImageUrl}
                          alt={`${label} 实时灰度图`}
                          waitingLabel={`${label} 等待首帧`}
                          onFrame={() => handleImageLoad(status.ip)}
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
                      <span>同步偏差 {status.continuousFrameDelta ?? 0}</span>
                    </footer>
                  </section>
                );
              })}
              {cameras.length === 0 ? (
                <div className="live-monitor-camera-list-empty" role={error ? 'alert' : 'status'}>
                  {error ? <AlertTriangle size={24} /> : <RefreshCw size={24} className="spin" />}
                  <span>{error ? '采集服务离线，实时画面已清除' : '正在读取相机拓扑…'}</span>
                  {error ? <small title={error}>{error}</small> : null}
                </div>
              ) : null}
            </div>
          </article>
        )}
      </section>}
    </main>
  );
}
