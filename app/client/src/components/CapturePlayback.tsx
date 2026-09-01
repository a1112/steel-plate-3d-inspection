import { Camera, ChevronLeft, ChevronRight, HardDrive, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import {
  captureRenderImageUrl,
  readCaptureHistory,
  type CaptureCameraStatus,
  type CaptureHistoryCameraFrame,
  type CaptureHistoryResult,
} from '../lib/capture-api';
import { prefetchCaptureImageUrls } from '../lib/capture-image-prefetch';
import { CaptureMeasurementPanel } from './CaptureMeasurementPanel';
import { CaptureDefectDetectionPanel } from './CaptureDefectDetectionPanel';
import { CaptureSurfacePanel } from './CaptureSurfacePanel';

interface CapturePlaybackProps {
  statuses: CaptureCameraStatus[];
  simulation?: boolean;
}

function cameraLabel(status: CaptureCameraStatus, index: number) {
  return status.name?.trim() || status.configId?.trim() || `C${status.deviceId || index + 1}`;
}

function timeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false });
}

function readyPlaybackRoi(
  saved: CaptureHistoryCameraFrame,
): [number, number, number, number] | null {
  const roi = saved.validRoi;
  if (saved.regionState !== 'ready' || !roi || roi.length !== 4 || !roi.every(Number.isFinite)) {
    return null;
  }
  const [left, top, right, bottom] = roi.map(Math.round);
  return left >= 0
    && top >= 0
    && right > left
    && bottom > top
    && right <= saved.width
    && bottom <= saved.height
    ? [left, top, right, bottom]
    : null;
}

function playbackImageSize(saved: CaptureHistoryCameraFrame, roi: [number, number, number, number]) {
  const roiWidth = roi[2] - roi[0];
  const roiHeight = roi[3] - roi[1];
  const indexedWidth = Number(saved.playbackWidth || 0);
  const indexedHeight = Number(saved.playbackHeight || 0);
  const hasIndexedSize = indexedWidth > 0 && indexedHeight > 0;
  return {
    width: hasIndexedSize ? indexedWidth : roiWidth,
    height: hasIndexedSize ? indexedHeight : roiHeight,
  };
}

export function CapturePlayback({ statuses, simulation = false }: CapturePlaybackProps) {
  const cameras = useMemo(
    () => statuses.filter((status) => status.enabled !== false),
    [statuses],
  );
  const [history, setHistory] = useState<CaptureHistoryResult | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [requestedFrameIndex, setRequestedFrameIndex] = useState(0);
  const [switching, setSwitching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const switchRevision = useRef(0);
  const frameIndexRef = useRef(0);
  const requestedFrameIndexRef = useRef(0);
  const loadRevisionRef = useRef(0);

  useEffect(() => {
    frameIndexRef.current = frameIndex;
    requestedFrameIndexRef.current = requestedFrameIndex;
  }, [frameIndex, requestedFrameIndex]);

  const load = useCallback(async (showLoading = true, signal?: AbortSignal) => {
    const revision = ++loadRevisionRef.current;
    if (showLoading) setLoading(true);
    try {
      const result = await readCaptureHistory(300, undefined, signal);
      if (signal?.aborted || revision !== loadRevisionRef.current) return;
      setHistory((current) => {
        const latest = Math.max(0, result.frames.length - 1);
        if (!current?.frames.length) {
          setFrameIndex(latest);
          setRequestedFrameIndex(latest);
          return result;
        }
        const requested = Math.max(
          0,
          Math.min(current.frames.length - 1, requestedFrameIndexRef.current),
        );
        const selected = current.frames[requested]
          ?? current.frames[frameIndexRef.current];
        const followingLatest = requested >= current.frames.length - 1;
        const preserved = followingLatest
          ? latest
          : result.frames.findIndex((candidate) => candidate.frameId === selected?.frameId);
        const nextIndex = preserved >= 0 ? preserved : latest;
        setFrameIndex(nextIndex);
        setRequestedFrameIndex(nextIndex);
        return result;
      });
      setError('');
    } catch (loadError) {
      if (signal?.aborted || revision !== loadRevisionRef.current) return;
      setError(loadError instanceof Error ? loadError.message : '历史采集读取失败');
    } finally {
      if (!signal?.aborted && revision === loadRevisionRef.current && showLoading) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(true, controller.signal);
    const timer = window.setInterval(
      () => void load(false, controller.signal),
      1_500,
    );
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);

  const frames = history?.frames ?? [];
  const frame = frames[frameIndex] ?? null;
  const move = (delta: number) => {
    setRequestedFrameIndex((current) => (
      Math.max(0, Math.min(frames.length - 1, current + delta))
    ));
  };
  const handleWheel = (event: WheelEvent<HTMLElement>) => {
    if (frames.length < 2 || event.deltaY === 0) return;
    event.preventDefault();
    move(event.deltaY > 0 ? -1 : 1);
  };

  useEffect(() => {
    if (requestedFrameIndex === frameIndex || !frames[requestedFrameIndex]) {
      setSwitching(false);
      return undefined;
    }
    const revision = ++switchRevision.current;
    setSwitching(true);
    const timer = window.setTimeout(() => {
      const target = frames[requestedFrameIndex];
      const urls = target.cameras.flatMap((camera) => {
        const roi = readyPlaybackRoi(camera);
        return roi
          ? [captureRenderImageUrl(camera.artifactRef, 'gray', 'thumbnail')]
          : [];
      });
      const preload = urls.map((url) => new Promise<void>((resolve) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () => resolve();
        image.src = url;
      }));
      const timeout = new Promise<void>((resolve) => {
        window.setTimeout(resolve, 1200);
      });
      void Promise.race([Promise.all(preload).then(() => undefined), timeout]).then(() => {
        if (switchRevision.current !== revision) return;
        setFrameIndex(requestedFrameIndex);
        setSwitching(false);
      });
    }, 70);
    return () => window.clearTimeout(timer);
  }, [frameIndex, frames, requestedFrameIndex]);

  useEffect(() => {
    if (!frames.length) return undefined;
    const urls = [-2, -1, 1, 2].flatMap((offset) => {
      const neighbor = frames[frameIndex + offset];
      if (!neighbor) return [];
      return neighbor.cameras.flatMap((camera) => {
        if (!readyPlaybackRoi(camera)) return [];
        return [captureRenderImageUrl(camera.artifactRef, 'gray', 'thumbnail')];
      });
    });
    return prefetchCaptureImageUrls(urls, {
      maxUrls: 24,
      delayMs: 180,
    });
  }, [frameIndex, frames]);

  return (
    <section className="capture-playback" aria-label="历史采集回放" onWheel={handleWheel}>
      <header className="capture-playback-header">
        <div>
          <strong>{frame?.materialId ?? '历史采集'}</strong>
          <span>{frame ? `${timeLabel(frame.capturedAt)} · 第 ${frame.sequence} 帧` : '暂无可回放帧'}</span>
        </div>
        <div>
          <span>{switching ? '加载中' : `${frames.length}/${history?.total ?? 0} 帧`}</span>
          <button type="button" onClick={() => void load()} disabled={loading} aria-label="刷新历史采集">
            <RefreshCw size={14} className={loading ? 'spin' : ''} />刷新
          </button>
        </div>
      </header>

      {frame ? (
        <div className="capture-playback-grid" aria-label={simulation ? '历史模拟通道画面' : '历史六相机画面'}>
          {cameras.map((camera, index) => {
            const saved = frame.cameras.find((item) => (
              readyPlaybackRoi(item) !== null
              && (item.cameraId === camera.configId
                || item.cameraId === camera.name
                || item.ip === camera.ip
                || item.cameraIndex === camera.deviceId)
            ));
            const label = cameraLabel(camera, index);
            const roi = saved ? readyPlaybackRoi(saved) : null;
            const size = saved && roi ? playbackImageSize(saved, roi) : null;
            return (
              <article key={camera.ip} className="capture-playback-card">
                <header><b>{label}</b><span>{simulation ? '模拟数据回放' : camera.ip}</span></header>
                <div>
                  {saved && roi && size ? (
                    <img
                      src={captureRenderImageUrl(saved.artifactRef, 'gray', 'thumbnail')}
                      alt={`${label} 历史灰度图`}
                      width={size.width}
                      height={size.height}
                      decoding="async"
                      loading="eager"
                    />
                  ) : (
                    <span className="capture-playback-missing"><Camera size={25} />该帧无算法裁剪图</span>
                  )}
                </div>
                <footer>
                  <span>{size ? `${size.width}×${size.height}` : '--'}</span>
                  <span>{saved ? `${Math.max(1, Math.round(saved.bytes / 1024))} KB` : '--'}</span>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="capture-playback-empty">
          {loading ? <RefreshCw size={34} className="spin" /> : <HardDrive size={38} />}
          <strong>{loading ? '正在读取历史采集…' : error || '暂无已保存图像'}</strong>
          <span>{history?.storageRoot || 'D:\\steel-sick-data'}</span>
        </div>
      )}

      {frame?.materialId ? <CaptureMeasurementPanel materialId={frame.materialId} /> : null}
      {frame?.materialId ? <CaptureSurfacePanel materialId={frame.materialId} /> : null}
      {frame?.materialId ? <CaptureDefectDetectionPanel materialId={frame.materialId} /> : null}

      <footer className="capture-playback-timeline">
        <button type="button" onClick={() => move(-1)} disabled={requestedFrameIndex <= 0} aria-label="上一历史帧"><ChevronLeft size={16} /></button>
        <input
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          value={requestedFrameIndex}
          disabled={frames.length < 2}
          aria-label="历史采集时间轴"
          onChange={(event) => setRequestedFrameIndex(Number(event.target.value))}
        />
        <button type="button" onClick={() => move(1)} disabled={requestedFrameIndex >= frames.length - 1} aria-label="下一历史帧"><ChevronRight size={16} /></button>
        <span>{frames.length ? `${requestedFrameIndex + 1} / ${frames.length}` : '0 / 0'}</span>
      </footer>
    </section>
  );
}
