import { Camera, ChevronLeft, ChevronRight, HardDrive, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type WheelEvent } from 'react';
import {
  captureHistoryImageUrl,
  readCaptureHistory,
  type CaptureCameraStatus,
  type CaptureHistoryResult,
} from '../lib/capture-api';

interface CapturePlaybackProps {
  statuses: CaptureCameraStatus[];
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

export function CapturePlayback({ statuses }: CapturePlaybackProps) {
  const cameras = useMemo(
    () => statuses.filter((status) => status.enabled !== false),
    [statuses],
  );
  const [history, setHistory] = useState<CaptureHistoryResult | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await readCaptureHistory(300);
      setHistory(result);
      setFrameIndex(Math.max(0, result.frames.length - 1));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '历史采集读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const frames = history?.frames ?? [];
  const frame = frames[frameIndex] ?? null;
  const move = (delta: number) => {
    setFrameIndex((current) => Math.max(0, Math.min(frames.length - 1, current + delta)));
  };
  const handleWheel = (event: WheelEvent<HTMLElement>) => {
    if (frames.length < 2 || event.deltaY === 0) return;
    event.preventDefault();
    move(event.deltaY > 0 ? -1 : 1);
  };

  return (
    <section className="capture-playback" aria-label="历史采集回放" onWheel={handleWheel}>
      <header className="capture-playback-header">
        <div>
          <strong>{frame?.materialId ?? '历史采集'}</strong>
          <span>{frame ? `${timeLabel(frame.capturedAt)} · 第 ${frame.sequence} 帧` : '暂无可回放帧'}</span>
        </div>
        <div>
          <span>{frames.length}/{history?.total ?? 0} 帧</span>
          <button type="button" onClick={() => void load()} disabled={loading} aria-label="刷新历史采集">
            <RefreshCw size={14} className={loading ? 'spin' : ''} />刷新
          </button>
        </div>
      </header>

      {frame ? (
        <div className="capture-playback-grid" aria-label="历史六相机画面">
          {cameras.map((camera, index) => {
            const saved = frame.cameras.find((item) => (
              item.cameraId === camera.configId
              || item.cameraId === camera.name
              || item.ip === camera.ip
              || item.cameraIndex === camera.deviceId
            ));
            const label = cameraLabel(camera, index);
            return (
              <article key={camera.ip} className="capture-playback-card">
                <header><b>{label}</b><span>{camera.ip}</span></header>
                <div>
                  {saved ? (
                    <img
                      src={captureHistoryImageUrl(saved.artifactRef, 800)}
                      alt={`${label} 历史灰度图`}
                      width={saved.width}
                      height={saved.height}
                    />
                  ) : (
                    <span className="capture-playback-missing"><Camera size={25} />该帧无图像</span>
                  )}
                </div>
                <footer>
                  <span>{saved ? `${saved.width}×${saved.height}` : '--'}</span>
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

      <footer className="capture-playback-timeline">
        <button type="button" onClick={() => move(-1)} disabled={frameIndex <= 0} aria-label="上一历史帧"><ChevronLeft size={16} /></button>
        <input
          type="range"
          min={0}
          max={Math.max(0, frames.length - 1)}
          value={frameIndex}
          disabled={frames.length < 2}
          aria-label="历史采集时间轴"
          onChange={(event) => setFrameIndex(Number(event.target.value))}
        />
        <button type="button" onClick={() => move(1)} disabled={frameIndex >= frames.length - 1} aria-label="下一历史帧"><ChevronRight size={16} /></button>
        <span>{frames.length ? `${frameIndex + 1} / ${frames.length}` : '0 / 0'}</span>
      </footer>
    </section>
  );
}
