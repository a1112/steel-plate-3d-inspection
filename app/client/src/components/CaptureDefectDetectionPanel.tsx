import { RefreshCw, ScanSearch, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  readCaptureDefects,
  rebuildCaptureDefects,
  type CaptureFlowDefectDetection,
} from '../lib/capture-api';

interface CaptureDefectDetectionPanelProps {
  materialId: string;
}

export function CaptureDefectDetectionPanel({ materialId }: CaptureDefectDetectionPanelProps) {
  const [detection, setDetection] = useState<CaptureFlowDefectDetection | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingState, setPendingState] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (showLoading = false) => {
    if (!materialId) return;
    if (showLoading) setLoading(true);
    try {
      const result = await readCaptureDefects(materialId);
      if (result.detection) {
        setDetection(result.detection);
        setPendingState('');
        setError('');
      } else {
        setPendingState(result.state || '等待缺陷任务');
      }
    } catch (loadError) {
      setPendingState('');
      setError(loadError instanceof Error ? loadError.message : '检出结果读取失败');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [materialId]);

  useEffect(() => {
    setDetection(null);
    setPendingState('');
    setError('');
    void load(true);
    const timer = window.setInterval(() => void load(false), 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  const rebuild = async () => {
    setLoading(true);
    setError('');
    try {
      await rebuildCaptureDefects(materialId);
      window.setTimeout(() => {
        void load(false).finally(() => setLoading(false));
      }, 1500);
    } catch (rebuildError) {
      setError(rebuildError instanceof Error ? rebuildError.message : '重新检出失败');
      setLoading(false);
    }
  };

  const count = detection?.statistics?.defectCount ?? detection?.defects.length ?? 0;
  const filteredCount = (detection?.statistics?.pseudoDefectFilteredCount ?? 0)
    + (detection?.statistics?.boundaryArtifactFilteredCount ?? 0);
  return (
    <section className="capture-defect-panel" aria-label="表面缺陷检出">
      <header>
        <div>
          <ScanSearch size={17} />
          <div><strong>缺陷检出</strong><span>{materialId}</span></div>
        </div>
        <button type="button" onClick={() => void rebuild()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} />重新检出
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
          </aside>
          <div className="capture-defect-list">
            {detection.defects.length ? detection.defects.slice(0, 12).map((defect) => (
              <div key={defect.id}>
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
