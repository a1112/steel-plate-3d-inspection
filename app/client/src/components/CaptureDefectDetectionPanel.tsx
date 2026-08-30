import { RefreshCw, ScanSearch, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CaptureApiError,
  captureArtifactImageUrl,
  readCaptureDefects,
  rebuildCaptureDefects,
  type CaptureFlowDefectDetection,
} from '../lib/capture-api';
import { RequestedSizeImage } from './RequestedSizeImage';

interface CaptureDefectDetectionPanelProps {
  materialId: string;
}

function pendingDetectionLabel(result: Awaited<ReturnType<typeof readCaptureDefects>>) {
  if (result.historyBackfill?.state === 'paused') {
    return result.historyBackfill.pauseReason === 'steel-present'
      ? '来钢采集优先，历史重检已暂停'
      : '等待采集写盘队列排空，历史重检已暂停';
  }
  const labels: Record<string, string> = {
    'waiting-for-flow-close': '等待当前流水采集结束',
    building: '正在生成缺陷检测结果',
    queued: '已加入缺陷处理队列',
    processing: '正在生成缺陷检测结果',
    'paused-for-capture': '采集优先，历史重检已暂停',
  };
  return labels[result.state || ''] || result.state || '等待缺陷任务';
}

export function CaptureDefectDetectionPanel({ materialId }: CaptureDefectDetectionPanelProps) {
  const [detection, setDetection] = useState<CaptureFlowDefectDetection | null>(null);
  const [loading, setLoading] = useState(false);
  const [rebuildPending, setRebuildPending] = useState(false);
  const [pendingState, setPendingState] = useState('');
  const [error, setError] = useState('');
  const loadRevisionRef = useRef(0);

  const load = useCallback(async (showLoading = false, signal?: AbortSignal) => {
    if (!materialId) return;
    const revision = ++loadRevisionRef.current;
    if (showLoading) setLoading(true);
    try {
      const result = await readCaptureDefects(materialId, signal);
      if (signal?.aborted || revision !== loadRevisionRef.current) return;
      if (result.detection) {
        setDetection(result.detection);
        setRebuildPending(false);
        setPendingState('');
        setError('');
      } else {
        setPendingState(pendingDetectionLabel(result));
        if (result.state === 'failed' || result.state === 'disabled') setRebuildPending(false);
      }
    } catch (loadError) {
      if (signal?.aborted || revision !== loadRevisionRef.current) return;
      if (loadError instanceof CaptureApiError && loadError.status === 404) {
        setPendingState('尚未生成缺陷检出结果；已提交的任务会自动刷新');
        setError('');
      } else {
        setPendingState('');
        setRebuildPending(false);
        setError(loadError instanceof Error ? loadError.message : '检出结果读取失败');
      }
    } finally {
      if (!signal?.aborted && revision === loadRevisionRef.current && showLoading) {
        setLoading(false);
      }
    }
  }, [materialId]);

  useEffect(() => {
    const controller = new AbortController();
    setDetection(null);
    setRebuildPending(false);
    setPendingState('');
    setError('');
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

  const rebuild = async () => {
    setLoading(true);
    setError('');
    try {
      await rebuildCaptureDefects(materialId);
      setRebuildPending(true);
      setPendingState('缺陷检出任务已提交，正在等待算法结果…');
      setLoading(false);
    } catch (rebuildError) {
      setError(rebuildError instanceof Error ? rebuildError.message : '重新检出失败');
      setLoading(false);
    }
  };

  const count = detection?.statistics?.defectCount ?? detection?.defects.length ?? 0;
  const filteredCount = (detection?.statistics?.pseudoDefectFilteredCount ?? 0)
    + (detection?.statistics?.boundaryArtifactFilteredCount ?? 0);
  const elapsedSeconds = (detection?.statistics?.elapsedMs ?? 0) / 1000;
  const throughput = detection?.statistics?.throughputFramesPerSecond;
  const computeThroughput = detection?.statistics?.computeThroughputFramesPerSecond;
  const captureWaitSeconds = (detection?.statistics?.timingsMs?.captureWaitMs ?? 0) / 1000;
  return (
    <section className="capture-defect-panel" aria-label="表面缺陷检出">
      <header>
        <div>
          <ScanSearch size={17} />
          <div><strong>缺陷检出</strong><span>{materialId}</span></div>
        </div>
        <button type="button" onClick={() => void rebuild()} disabled={loading || rebuildPending}>
          <RefreshCw size={14} className={loading || rebuildPending ? 'spin' : ''} />{rebuildPending ? '检出中' : '重新检出'}
        </button>
      </header>
      {detection ? (
        <div className="capture-defect-content">
          <aside>
            <span className={`defect-state defect-state-${detection.state}`}>
              {detection.state === 'complete' ? '检出完成' : detection.state === 'degraded' ? '降级检出' : detection.state}
            </span>
            <strong><ShieldAlert size={16} />{count} 个候选</strong>
            <small>
              {detection.quality.gpuAcceleration ? 'CUDA GPU' : 'CPU 限流'} · {' '}
              {detection.quality.fineGrainedClassification ? '二级识别临时模型' : '二分类临时模型'}
            </small>
            <small>
              已过滤 {filteredCount} 个边界/伪缺陷 · 结果仍需复核
            </small>
            {typeof throughput === 'number' ? (
              <small>
                计算 {typeof computeThroughput === 'number' ? computeThroughput.toFixed(2) : throughput.toFixed(2)} 帧/秒
                {' · '}总计 {elapsedSeconds.toFixed(1)} 秒{' · '}
                {detection.statistics?.processedFrames ?? 0} 帧
              </small>
            ) : null}
            {captureWaitSeconds > 0 ? (
              <small>采集优先等待 {captureWaitSeconds.toFixed(1)} 秒 · 墙钟吞吐 {throughput?.toFixed(2)} 帧/秒</small>
            ) : null}
          </aside>
          <div className="capture-defect-list">
            {detection.defects.length ? detection.defects.slice(0, 12).map((defect) => (
              <div key={defect.id}>
                {defect.reviewImage ? (
                  <RequestedSizeImage
                    src={captureArtifactImageUrl(defect.reviewImage, 192)}
                    alt={`${defect.cameraId} 第 ${defect.storageIndex} 帧 ${defect.className} 缺陷小图`}
                    width={defect.reviewImageWidth || 64}
                    height={defect.reviewImageHeight || 64}
                    requestWidth={defect.reviewImageWidth || 64}
                    requestHeight={defect.reviewImageHeight || 64}
                    loading="lazy"
                    decoding="async"
                  />
                ) : null}
                <b>{defect.cameraId} · 第 {defect.storageIndex} 帧 · {defect.className}</b>
                <span>
                  检出 {(defect.confidence * 100).toFixed(1)}%
                  {typeof defect.recognitionConfidence === 'number'
                    ? ` · 识别 ${(defect.recognitionConfidence * 100).toFixed(1)}%`
                    : ''}
                  {' · '}{defect.modalities.join('+').toUpperCase()}
                </span>
              </div>
            )) : <span className="capture-defect-none">当前抽检范围未发现缺陷候选</span>}
          </div>
        </div>
      ) : (
        <div className="capture-defect-empty">
          {loading ? <RefreshCw size={22} className="spin" /> : <ScanSearch size={22} />}
          <span>{loading ? '正在读取检出结果…' : pendingState || error || '尚未生成检出结果'}</span>
        </div>
      )}
    </section>
  );
}
