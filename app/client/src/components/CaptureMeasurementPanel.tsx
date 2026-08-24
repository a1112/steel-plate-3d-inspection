import { CircleDot, RefreshCw, Ruler } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CaptureApiError,
  readCaptureMeasurement,
  rebuildCaptureMeasurement,
  type CaptureFlowMeasurement,
} from '../lib/capture-api';

interface CaptureMeasurementPanelProps {
  materialId: string;
}

const COLORS = ['#19c3a3', '#4f8cff', '#f6a53a', '#ee5d78', '#a879ff', '#50bfe6'];

function CrossSection({ measurement }: { measurement: CaptureFlowMeasurement }) {
  const curves = useMemo(() => Object.entries(measurement.cameras)
    .map(([cameraId, camera]) => ({
      cameraId,
      points: (measurement.metricValid ? camera.arrayProfile : camera.localProfile) ?? [],
    }))
    .filter((item) => item.points.length > 1), [measurement]);
  const bounds = useMemo(() => {
    const points = curves.flatMap((curve) => curve.points);
    if (!points.length) return null;
    const xs = points.map((point) => point[0]).filter(Number.isFinite);
    const zs = points.map((point) => point[1]).filter(Number.isFinite);
    if (!xs.length || !zs.length) return null;
    return {
      minX: Math.min(...xs), maxX: Math.max(...xs),
      minZ: Math.min(...zs), maxZ: Math.max(...zs),
    };
  }, [curves]);
  if (!bounds) return <div className="capture-measurement-empty">暂无有效截面点</div>;
  const width = Math.max(1e-6, bounds.maxX - bounds.minX);
  const height = Math.max(1e-6, bounds.maxZ - bounds.minZ);
  const pointText = (point: number[]) => {
    const x = 18 + ((point[0] - bounds.minX) / width) * 564;
    const y = 182 - ((point[1] - bounds.minZ) / height) * 164;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  };
  return (
    <svg className="capture-measurement-section" viewBox="0 0 600 200" role="img" aria-label="棒材截面曲线">
      <rect x="1" y="1" width="598" height="198" rx="8" />
      {curves.map((curve, index) => (
        <polyline
          key={curve.cameraId}
          points={curve.points.map(pointText).join(' ')}
          stroke={COLORS[index % COLORS.length]}
        />
      ))}
    </svg>
  );
}

export function CaptureMeasurementPanel({ materialId }: CaptureMeasurementPanelProps) {
  const [measurement, setMeasurement] = useState<CaptureFlowMeasurement | null>(null);
  const [loading, setLoading] = useState(false);
  const [rebuildPending, setRebuildPending] = useState(false);
  const [error, setError] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (showLoading = true) => {
    if (!materialId) return;
    if (showLoading) setLoading(true);
    try {
      const result = await readCaptureMeasurement(materialId);
      if (mountedRef.current) {
        setMeasurement(result.measurement);
        setRebuildPending(false);
        setError('');
      }
    } catch (loadError) {
      if (mountedRef.current) {
        setMeasurement(null);
        if (loadError instanceof CaptureApiError && loadError.status === 404) {
          setError('尚未生成截面分析；已提交的任务会自动刷新');
        } else {
          setRebuildPending(false);
          setError(loadError instanceof Error ? loadError.message : '截面分析读取失败');
        }
      }
    } finally {
      if (mountedRef.current && showLoading) setLoading(false);
    }
  }, [materialId]);

  useEffect(() => {
    setMeasurement(null);
    setRebuildPending(false);
    setError('');
    void load();
  }, [load]);

  useEffect(() => {
    if (!rebuildPending) return undefined;
    const timer = window.setInterval(() => void load(false), 2_000);
    return () => window.clearInterval(timer);
  }, [load, rebuildPending]);

  const rebuild = async () => {
    setLoading(true);
    setError('');
    try {
      await rebuildCaptureMeasurement(materialId);
      if (mountedRef.current) {
        setRebuildPending(true);
        setError('截面分析任务已提交，正在等待算法结果…');
        setLoading(false);
      }
    } catch (rebuildError) {
      if (mountedRef.current) {
        setError(rebuildError instanceof Error ? rebuildError.message : '重新分析失败');
        setLoading(false);
      }
    }
  };

  const circle = measurement?.selectedSection.circleFit;
  return (
    <section className="capture-measurement-panel" aria-label="2D裁剪与截面测量">
      <header>
        <div>
          <CircleDot size={17} />
          <div><strong>截面与外径</strong><span>{materialId}</span></div>
        </div>
        <button type="button" onClick={() => void rebuild()} disabled={loading || rebuildPending}>
          <RefreshCw size={14} className={loading || rebuildPending ? 'spin' : ''} />{rebuildPending ? '分析中' : '重新分析'}
        </button>
      </header>
      {measurement ? (
        <div className="capture-measurement-content">
          <CrossSection measurement={measurement} />
          <aside>
            <span className={measurement.metricValid ? 'metric-valid' : 'preview-only'}>
              {measurement.metricValid ? '计量有效' : '仅预览'}
            </span>
            <strong><Ruler size={16} />{measurement.metricValid && circle?.diameterMm
              ? `${circle.diameterMm.toFixed(3)} mm`
              : '外径待标定'}</strong>
            <small>截面：{Object.values(measurement.cameras).filter((camera) => camera.available).length} / {Object.keys(measurement.cameras).length} 路</small>
            <small>圆拟合：{circle?.available ? `P95 ${circle.p95AbsResidualMm?.toFixed(3) ?? '-'} mm` : '未通过'}</small>
            {!measurement.metricValid ? (
              <ul>{measurement.qualityGate.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            ) : null}
          </aside>
        </div>
      ) : (
        <div className="capture-measurement-empty">
          {loading ? <RefreshCw size={22} className="spin" /> : <CircleDot size={22} />}
          <span>{loading ? '正在读取分析结果…' : error || '尚未生成截面分析'}</span>
        </div>
      )}
    </section>
  );
}
