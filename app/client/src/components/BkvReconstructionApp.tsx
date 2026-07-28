import { ArrowLeft, Box, Calculator, Database, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchInspectionWorldReconstructionParameters,
  fetchInspectionWorldRecords,
  fetchInspectionWorldSurface,
  type InspectionWorldReconstructionParameters,
  type InspectionWorldRecord,
} from '../services/inspection-world-api';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import {
  fitSurfaceCircle,
  ProductionArtifactView,
  type ArtifactColorMode,
} from './ProductionArtifactView';

const SECTION_CAMERA_COLORS = ['#30b8ff', '#32d3a7', '#ffd166', '#ff8a65', '#b58cff', '#ef6fa7'];

type BkvSectionPoint = {
  y: number;
  z: number;
  cameraIndex: number;
  valid: boolean;
};

export type BkvSection = {
  row: number;
  longitudinalPosition: number;
  points: BkvSectionPoint[];
  observedPointCount: number;
  centerY: number;
  centerZ: number;
  meanRadius: number;
  meanResidual: number;
  maximumResidual: number;
};

export function buildBkvSection(mesh: BarSurfaceMesh, requestedRow: number): BkvSection {
  const row = Math.max(0, Math.min(mesh.rows - 1, Math.round(requestedRow)));
  const columns = mesh.colsPerCamera * mesh.cameraCount;
  const points: BkvSectionPoint[] = [];
  let longitudinalPosition = 0;

  for (let column = 0; column < columns; column += 1) {
    const vertexIndex = row * columns + column;
    const positionIndex = vertexIndex * 3;
    if (column === 0) {
      longitudinalPosition = Number(mesh.positions[positionIndex]) || 0;
    }
    const valid = !mesh.validMask || Number(mesh.validMask[vertexIndex]) !== 0;
    const y = Number(mesh.positions[positionIndex + 1]);
    const z = Number(mesh.positions[positionIndex + 2]);
    if (!Number.isFinite(y) || !Number.isFinite(z)) continue;
    points.push({
      y,
      z,
      cameraIndex: Math.min(mesh.cameraCount - 1, Math.floor(column / mesh.colsPerCamera)),
      valid,
    });
  }

  const observedPoints = points.filter((point) => point.valid);
  const fitted = fitSurfaceCircle(observedPoints);
  const centerY = fitted?.centerY ?? 0;
  const centerZ = fitted?.centerZ ?? 0;
  const meanRadius = fitted?.radius ?? 0;
  const residuals = observedPoints.map((point) => Math.abs(
    Math.hypot(point.y - centerY, point.z - centerZ) - meanRadius,
  ));

  return {
    row,
    longitudinalPosition,
    points,
    observedPointCount: observedPoints.length,
    centerY,
    centerZ,
    meanRadius,
    meanResidual: residuals.length
      ? residuals.reduce((sum, residual) => sum + residual, 0) / residuals.length
      : 0,
    maximumResidual: residuals.length ? Math.max(...residuals) : 0,
  };
}

function formatMetric(value: number, digits = 6) {
  return Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
    : '--';
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return '--';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(2)} MB`;
}

export function BkvSectionView({
  mesh,
  row,
  onRowChange,
  recordId,
  nominalDiameterMm = 0,
  lengthMm = 0,
}: {
  mesh: BarSurfaceMesh;
  row: number;
  onRowChange: (row: number) => void;
  recordId: string;
  nominalDiameterMm?: number;
  lengthMm?: number;
}) {
  const section = useMemo(() => buildBkvSection(mesh, row), [mesh, row]);
  const radialScaleMm = nominalDiameterMm > 0 ? nominalDiameterMm / 2 : 1;
  const longitudinalMm = lengthMm > 0
    ? section.row / Math.max(1, mesh.rows - 1) * lengthMm
    : section.longitudinalPosition;
  const extent = Math.max(
    1,
    ...section.points.flatMap((point) => [
      Math.abs(point.y - section.centerY),
      Math.abs(point.z - section.centerZ),
    ]),
  ) * 1.18;
  const cameraPolylines = Array.from({ length: mesh.cameraCount }, (_, cameraIndex) => (
    section.points
      .filter((point) => point.cameraIndex === cameraIndex)
      .map((point) => `${point.y - section.centerY},${-(point.z - section.centerZ)}`)
      .join(' ')
  ));

  return (
    <div className="bkv-reconstruction-section" data-testid="bkv-reconstruction-section">
      <div className="bkv-reconstruction-section-chart">
        <svg
          viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`}
          role="img"
          aria-label={`${recordId} NPZ 横截面`}
          preserveAspectRatio="xMidYMid meet"
        >
          <line x1={-extent} y1={0} x2={extent} y2={0} className="section-axis" />
          <line x1={0} y1={-extent} x2={0} y2={extent} className="section-axis" />
          <circle r={section.meanRadius} className="section-fit-circle" />
          {cameraPolylines.map((polyline, cameraIndex) => (
            <polyline
              key={cameraIndex}
              points={polyline}
              fill="none"
              stroke={SECTION_CAMERA_COLORS[cameraIndex % SECTION_CAMERA_COLORS.length]}
              strokeWidth={extent * 0.012}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {section.points.map((point, index) => (
            <circle
              key={`${point.cameraIndex}-${index}`}
              cx={point.y - section.centerY}
              cy={-(point.z - section.centerZ)}
              r={extent * 0.012}
              fill={point.valid
                ? SECTION_CAMERA_COLORS[point.cameraIndex % SECTION_CAMERA_COLORS.length]
                : '#4d6875'}
              opacity={point.valid ? 1 : 0.62}
            />
          ))}
          <circle r={extent * 0.012} className="section-center-point" />
        </svg>
        <div className="bkv-reconstruction-section-stats">
          <span>切面 {section.row + 1}/{mesh.rows}</span>
          <span>有效点 {section.observedPointCount}/{mesh.colsPerCamera * mesh.cameraCount}</span>
          <span>长度位置 {formatMetric(longitudinalMm, 1)} mm</span>
          <span>拟合外径 {formatMetric(section.meanRadius * radialScaleMm * 2, 3)} mm</span>
          <span>平均残差 {formatMetric(section.meanResidual * radialScaleMm, 3)} mm</span>
          <span>最大残差 {formatMetric(section.maximumResidual * radialScaleMm, 3)} mm</span>
        </div>
        <div className="bkv-reconstruction-section-legend" aria-label="切面相机分区">
          {Array.from({ length: mesh.cameraCount }, (_, cameraIndex) => (
            <span key={cameraIndex}>
              <i style={{ backgroundColor: SECTION_CAMERA_COLORS[cameraIndex % SECTION_CAMERA_COLORS.length] }} />
              C{cameraIndex + 1}
            </span>
          ))}
          <span><i className="imputed" />灰色为名义补点</span>
        </div>
      </div>
      <label className="bkv-reconstruction-section-slider">
        <span>切面位置</span>
        <input
          type="range"
          min={0}
          max={Math.max(0, mesh.rows - 1)}
          step={1}
          value={section.row}
          onChange={(event) => onRowChange(Number(event.target.value))}
          aria-label="切面位置"
        />
        <strong>{section.row + 1} / {mesh.rows}</strong>
      </label>
    </div>
  );
}

export function BkvReconstructionApp({ expectedCameraCount = 6 }: { expectedCameraCount?: number }) {
  const [records, setRecords] = useState<InspectionWorldRecord[]>([]);
  const [recordId, setRecordId] = useState(
    () => new URLSearchParams(window.location.search).get('materialId') || '',
  );
  const [mesh, setMesh] = useState<BarSurfaceMesh | null>(null);
  const [parameters, setParameters] = useState<InspectionWorldReconstructionParameters | null>(null);
  const [loading, setLoading] = useState(true);
  const [calculating, setCalculating] = useState(false);
  const [error, setError] = useState('');
  const [viewMode, setViewMode] = useState<'3d' | 'points' | 'section'>('3d');
  const [colorMode, setColorMode] = useState<ArtifactColorMode>('radial-jet');
  const [sectionRow, setSectionRow] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchInspectionWorldRecords(controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setRecords(payload.records);
        setRecordId((current) => {
          const requested = payload.records.find(
            (record) => record.recordId === current || record.steelId === current,
          );
          return requested?.recordId || payload.records[0]?.recordId || '';
        });
        if (!payload.records.length) {
          setError('BKV 标准离线仓库暂无可重建记录');
          setLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'BKV 离线记录读取失败');
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, []);

  const calculate = useCallback(async (signal?: AbortSignal, forceRebuild = false) => {
    if (!recordId) return;
    setCalculating(true);
    setError('');
    setMesh(null);
    setParameters(null);
    try {
      // Parameters and mesh share the same verified NPZ conversion cache. Loading them in
      // sequence prevents two expensive cold conversions from racing each other.
      const nextParameters = await fetchInspectionWorldReconstructionParameters(
        recordId,
        signal,
        forceRebuild,
      );
      if (signal?.aborted) return;
      setParameters(nextParameters);
      const nextMesh = await fetchInspectionWorldSurface(recordId, signal, forceRebuild);
      if (signal?.aborted) return;
      setMesh(nextMesh);
      setSectionRow(Math.floor(nextMesh.rows / 2));
    } catch (reason) {
      if (!signal?.aborted) {
        setError(reason instanceof Error ? reason.message : 'NPZ 三维重建失败');
      }
    } finally {
      if (!signal?.aborted) {
        setCalculating(false);
        setLoading(false);
      }
    }
  }, [recordId]);

  useEffect(() => {
    if (!recordId) return;
    const controller = new AbortController();
    void calculate(controller.signal);
    return () => controller.abort();
  }, [calculate]);

  const selectedRecord = useMemo(
    () => records.find((record) => record.recordId === recordId) ?? null,
    [recordId, records],
  );

  return (
    <main className="bkv-reconstruction-shell" data-testid="bkv-reconstruction-app">
      <header className="bkv-reconstruction-header">
        <div className="bkv-reconstruction-title">
          <button type="button" onClick={() => window.location.assign('/?app=terminal&view=bkv')}>
            <ArrowLeft size={17} />
            返回检测
          </button>
          <div>
            <span>BKV 标准离线仓库 · 只读计算</span>
            <h1>NPZ 3D 重建工作台</h1>
          </div>
        </div>
        <div className="bkv-reconstruction-header-status">
          <span><Database size={14} />记录 <strong>{recordId || '--'}</strong></span>
          <span>相机 <strong>{parameters?.sampling.cameraCount ?? expectedCameraCount}/{expectedCameraCount}</strong></span>
          <span>顶点 <strong>{parameters?.output.vertexCount.toLocaleString('zh-CN') ?? '--'}</strong></span>
          <em>NPZ 深度单位 mm</em>
        </div>
        <div className="bkv-reconstruction-actions">
          <select
            aria-label="重建记录"
            value={recordId}
            disabled={calculating}
            onChange={(event) => setRecordId(event.target.value)}
          >
            {records.map((record) => (
              <option key={record.recordId} value={record.recordId}>
                {record.recordId} · {record.steelId || '未知钢管'}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary"
            disabled={!recordId || calculating}
            onClick={() => void calculate(undefined, true)}
          >
            {calculating ? <RefreshCw size={16} className="spin" /> : <Calculator size={16} />}
            {calculating ? '正在读取并重建…' : '重新读取 NPZ 并重建'}
          </button>
        </div>
      </header>

      {error ? <div className="bkv-reconstruction-error" role="alert">{error}</div> : null}

      <section className="bkv-reconstruction-workspace">
        <section className="bkv-reconstruction-model-panel">
          <header>
            <div>
              <Box size={18} />
              <strong>记录三维表面</strong>
              <span>{selectedRecord?.steelId || recordId}</span>
            </div>
            <div className="bkv-reconstruction-model-tools">
              <span>
                {parameters
                  ? `${parameters.output.validPointCount.toLocaleString('zh-CN')} 有效点 · ${parameters.output.triangleCount.toLocaleString('zh-CN')} 三角面`
                  : '等待计算'}
              </span>
              {viewMode !== 'section' ? (
                <div className="bkv-reconstruction-color-switch" role="group" aria-label="三维着色模式">
                  <button
                    type="button"
                    aria-pressed={colorMode === 'source'}
                    className={colorMode === 'source' ? 'active' : ''}
                    onClick={() => setColorMode('source')}
                  >
                    基础色
                  </button>
                  <button
                    type="button"
                    aria-pressed={colorMode === 'radial-jet'}
                    className={colorMode === 'radial-jet' ? 'active jet' : 'jet'}
                    onClick={() => setColorMode('radial-jet')}
                  >
                    Jet 偏差
                  </button>
                </div>
              ) : null}
              <div className="bkv-reconstruction-view-switch" role="tablist" aria-label="模型显示模式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === '3d'}
                  className={viewMode === '3d' ? 'active' : ''}
                  onClick={() => setViewMode('3d')}
                >
                  3D
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'points'}
                  className={viewMode === 'points' ? 'active' : ''}
                  onClick={() => setViewMode('points')}
                >
                  点云
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'section'}
                  className={viewMode === 'section' ? 'active' : ''}
                  onClick={() => setViewMode('section')}
                >
                  切面
                </button>
              </div>
            </div>
          </header>
          <div className="bkv-reconstruction-model">
            {mesh ? (
              viewMode === 'section' ? (
                <BkvSectionView
                  mesh={mesh}
                  row={sectionRow}
                  onRowChange={setSectionRow}
                  recordId={recordId}
                  nominalDiameterMm={parameters?.reconstruction.nominalDiameter}
                  lengthMm={parameters?.reconstruction.longitudinalExtent}
                />
              ) : (
                <ProductionArtifactView
                  mesh={mesh}
                  mode={viewMode === 'points' ? 'points' : 'surface'}
                  testId={viewMode === 'points'
                    ? 'bkv-reconstruction-point-cloud'
                    : 'bkv-reconstruction-surface'}
                  ariaLabel={viewMode === 'points'
                    ? `${recordId} NPZ 有效点云`
                    : `${recordId} NPZ 三维重建表面`}
                  colorMode={colorMode}
                  radialUnitScale={parameters?.reconstruction.nominalRadius ?? 1}
                  radialUnit="mm"
                />
              )
            ) : (
              <div className="bkv-reconstruction-loading" role="status">
                <RefreshCw size={28} className={calculating ? 'spin' : ''} />
                <strong>{calculating || loading ? '正在校验 NPZ 并计算三维网格' : '暂无三维网格'}</strong>
                <span>首次计算需读取并校验全部深度帧，后续直接使用记录缓存。</span>
              </div>
            )}
          </div>
          <footer>
            <ShieldCheck size={15} />
            <span>
              {viewMode === 'section'
                ? '切面按当前网格行拟合圆；长度、外径与径向残差均按 NPZ 毫米值显示。'
                : colorMode === 'radial-jet'
                  ? 'Jet 以每个纵向切面的拟合圆为零基准：蓝色为内凹、绿色接近圆面、红色为外凸；色标单位为毫米。'
                  : viewMode === 'points'
                  ? '点云仅显示 NPZ 实测有效点，已过滤名义补点；支持拖拽旋转与滚轮缩放。'
                    : '显示网格为 128 个纵向采样 × 32 列/相机；NPZ 深度按毫米解释，网格采样密度仍不等同于仪器精度。'}
            </span>
          </footer>
        </section>

        <aside className="bkv-reconstruction-parameters" aria-label="计算重建参数">
          <header>
            <Calculator size={17} />
            <div>
              <strong>计算重建参数</strong>
              <span>{parameters?.algorithmRevision || parameters?.schema || '等待计算'}</span>
            </div>
          </header>
          {parameters ? (
            <>
              <section>
                <h2>输入与采样</h2>
                <dl>
                  <div><dt>输入格式</dt><dd>{parameters.input.format} / float32</dd></div>
                  <div><dt>源深度帧</dt><dd>{parameters.input.sourceFrameCount}</dd></div>
                  <div><dt>采样网格</dt><dd>{parameters.sampling.rows} × {parameters.sampling.colsPerCamera}/相机</dd></div>
                  <div><dt>相机数量</dt><dd>{parameters.sampling.cameraCount}</dd></div>
                  <div><dt>无效值下限</dt><dd>{formatMetric(parameters.input.invalidDepthFloor, 0)}</dd></div>
                </dl>
              </section>
              <section>
                <h2>几何与显示</h2>
                <dl>
                  <div><dt>重建几何</dt><dd>闭合圆柱</dd></div>
                  <div><dt>相机归一化</dt><dd>逐列中位基线</dd></div>
                  <div><dt>钢管长度</dt><dd>{formatMetric(parameters.reconstruction.longitudinalExtent, 1)} mm</dd></div>
                  <div><dt>名义半径</dt><dd>{formatMetric(parameters.reconstruction.nominalRadius, 3)} mm</dd></div>
                  <div><dt>径向残差 P95</dt><dd>{formatMetric(parameters.display.robustResidualP95, 3)} mm</dd></div>
                  <div><dt>显示归一化</dt><dd>{formatMetric(parameters.display.radialScale, 8)} /mm</dd></div>
                </dl>
              </section>
              <section>
                <h2>输出拓扑</h2>
                <dl>
                  <div><dt>网格格式</dt><dd>{parameters.output.format}</dd></div>
                  <div><dt>顶点/有效点</dt><dd>{parameters.output.vertexCount.toLocaleString('zh-CN')} / {parameters.output.validPointCount.toLocaleString('zh-CN')}</dd></div>
                  <div><dt>名义补点</dt><dd>{parameters.output.imputedPointCount?.toLocaleString('zh-CN') ?? '--'}</dd></div>
                  <div><dt>三角面</dt><dd>{parameters.output.triangleCount.toLocaleString('zh-CN')}</dd></div>
                  <div><dt>二进制大小</dt><dd>{formatBytes(parameters.output.binaryBytes)}</dd></div>
                </dl>
              </section>
              <section className="bkv-reconstruction-camera-parameters">
                <h2>相机计算基线</h2>
                <div>
                  {parameters.cameras.map((camera) => (
                    <article key={camera.cameraId}>
                      <strong>C{camera.cameraId}</strong>
                      <span>{camera.frameCount} 帧 · {camera.sourceRows}×{camera.sourceColumns}</span>
                      <em>
                        {Number.isFinite(camera.columnBaselineMinimum)
                          && Number.isFinite(camera.columnBaselineMaximum)
                          ? `列基线 ${formatMetric(camera.columnBaselineMinimum!)} ~ ${formatMetric(camera.columnBaselineMaximum!)}`
                          : `中位值 ${formatMetric(camera.baseline)}`}
                      </em>
                    </article>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <div className="bkv-reconstruction-parameter-empty">
              参数将在 NPZ 校验与网格计算完成后显示。
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}
