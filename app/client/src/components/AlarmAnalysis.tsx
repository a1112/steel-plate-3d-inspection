import { Canvas } from '@react-three/fiber';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Maximize2, X } from 'lucide-react';
import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CaptureImageItem, ChartPoint, DefectItem } from '../data/inspection';
import { severityLabels, surfaceLabels } from '../data/inspection';
import { createPointCloudGeometryArrays } from '../lib/point-cloud-simulator';
import { createSectionProfiles } from '../lib/section-profiles';
import { barSurfaceFileUrl, type BarSurfaceMesh } from '../services/bar-surface-api';
import { Panel } from './Panel';
import { ProductionArtifactView } from './ProductionArtifactView';

const POINT_CLOUD_INITIAL_YAW = -0.32;
const POINT_CLOUD_PITCH = 0.24;
const POINT_CLOUD_MAX_YAW_OFFSET = 0.68;
const POINT_CLOUD_MIN_ZOOM = 0.72;
const POINT_CLOUD_MAX_ZOOM = 2.2;
const POINT_CLOUD_ZOOM_STEP = 0.12;
const CHART_AXIS_MIN_ZOOM = 1;
const CHART_AXIS_MAX_ZOOM = 3;
const CHART_AXIS_ZOOM_STEP = 0.2;

function clampPointCloudYaw(yaw: number) {
  return Math.max(POINT_CLOUD_INITIAL_YAW - POINT_CLOUD_MAX_YAW_OFFSET, Math.min(POINT_CLOUD_INITIAL_YAW + POINT_CLOUD_MAX_YAW_OFFSET, yaw));
}

function clampPointCloudZoom(zoom: number) {
  return Math.max(POINT_CLOUD_MIN_ZOOM, Math.min(POINT_CLOUD_MAX_ZOOM, zoom));
}

function clampChartAxisZoom(zoom: number) {
  return Math.max(CHART_AXIS_MIN_ZOOM, Math.min(CHART_AXIS_MAX_ZOOM, zoom));
}

function DefectPreview({
  defect,
  captureImages,
  artifactMode,
}: {
  defect: DefectItem;
  captureImages: CaptureImageItem[];
  artifactMode: 'production' | 'demo';
}) {
  const artifactPreviewUrl = defect.artifacts?.roiImage ? barSurfaceFileUrl(defect.artifacts.roiImage) : '';
  const previewImageUrl = defect.previewImageUrl || artifactPreviewUrl;
  const recordImage = captureImages.find((image) => image.dataName === 'intensity' && image.url)
    ?? captureImages.find((image) => image.dataName === 'depth' && image.url);
  if (artifactMode === 'production' && !previewImageUrl) {
    if (!recordImage) {
      return (
        <div className="production-artifact-empty compact" role="status">
          <strong>暂无生产缺陷图像产物</strong>
          <span>当前缺陷没有绑定 ROI/灰度裁剪图，检测记录也没有可显示的采集原图。</span>
        </div>
      );
    }
    return (
      <figure className="record-bound-defect-image" data-artifact-source="production-record">
        <img src={recordImage.url} alt={`检测记录采集原图 ${recordImage.cameraId || recordImage.cameraIp}`} loading="lazy" />
        <figcaption>
          <strong>检测记录采集原图</strong>
          <span>{recordImage.cameraId || recordImage.cameraIp} · {recordImage.dataName} #{recordImage.sequenceNo}；非缺陷 ROI 裁剪</span>
        </figcaption>
      </figure>
    );
  }
  const previewStyle = {
    '--defect-preview-image': `url(${previewImageUrl})`,
  } as CSSProperties;

  return (
    <div className="defect-preview" style={previewStyle} data-artifact-source={artifactMode === 'demo' ? 'demo' : 'production-record'}>
      <div className="defect-bbox" style={{ left: `${defect.previewX}%`, top: `${defect.previewY}%` }}>
        <span>{`${defect.typeLabel} ${defect.widthMm.toFixed(2)}x${defect.heightMm.toFixed(2)}x${Math.abs(defect.depthMm).toFixed(2)}mm`}</span>
      </div>
      <span className="scale-mark">2 mm</span>
      {artifactMode === 'demo'
        ? <span className="demo-artifact-badge">演示缺陷图</span>
        : <span className="production-artifact-tag">生产记录缺陷图</span>}
    </div>
  );
}

function CaptureImagePreview({ captureImages }: { captureImages: CaptureImageItem[] }) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const visibleImages = captureImages
    .filter((image) => image.url && (image.dataName === 'depth' || image.dataName === 'intensity'))
    .slice(0, 12);
  const selectedImage = selectedIndex === null ? null : visibleImages[selectedIndex] ?? null;
  const activeSelectedIndex = selectedIndex ?? 0;

  useEffect(() => {
    if (!selectedImage) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedIndex(null);
      if (event.key === 'ArrowLeft') setSelectedIndex((current) => current === null ? null : (current - 1 + visibleImages.length) % visibleImages.length);
      if (event.key === 'ArrowRight') setSelectedIndex((current) => current === null ? null : (current + 1) % visibleImages.length);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedImage, visibleImages.length]);

  if (visibleImages.length === 0) {
    return (
      <div className="analysis-empty">
        <h3>当前钢管暂无缺陷</h3>
        <p>真实检测记录已加载，当前流水还没有可显示的缺陷图像或采集图像。</p>
      </div>
    );
  }

  return (
    <div className="capture-image-preview-grid" data-artifact-source="production-record">
      {visibleImages.map((image, index) => (
        <figure key={`${image.id}-${image.dataName}`} className="capture-image-preview-card">
          <button type="button" className="capture-image-preview-open" onClick={() => setSelectedIndex(index)} aria-label={`打开 ${image.cameraId || image.cameraIp} ${image.dataName} #${image.sequenceNo}`}>
            <img src={image.url} alt={`${image.cameraId} ${image.dataName}`} loading="lazy" />
            <figcaption>
              <strong>{image.cameraId || image.cameraIp}</strong>
              <span>{image.dataName === 'depth' ? '深度' : '亮度'} #{image.sequenceNo}</span>
              <Maximize2 size={13} aria-hidden="true" />
            </figcaption>
          </button>
        </figure>
      ))}
      {selectedImage && typeof document !== 'undefined' ? createPortal(
        <div className="capture-image-viewer-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelectedIndex(null);
        }}>
          <section className="capture-image-viewer" role="dialog" aria-modal="true" aria-label="单相机采集图像查看">
            <header>
              <div>
                <span>单相机采集图像</span>
                <strong>{selectedImage.cameraId || selectedImage.cameraIp}</strong>
              </div>
              <button type="button" onClick={() => setSelectedIndex(null)} aria-label="关闭图像弹窗"><X size={18} /></button>
            </header>
            <div className="capture-image-viewer-stage">
              <img src={selectedImage.url} alt={`${selectedImage.cameraId} ${selectedImage.dataName} #${selectedImage.sequenceNo}`} />
              {visibleImages.length > 1 ? (
                <>
                  <button type="button" className="previous" onClick={() => setSelectedIndex((activeSelectedIndex - 1 + visibleImages.length) % visibleImages.length)} aria-label="上一张"><ChevronLeft size={24} /></button>
                  <button type="button" className="next" onClick={() => setSelectedIndex((activeSelectedIndex + 1) % visibleImages.length)} aria-label="下一张"><ChevronRight size={24} /></button>
                </>
              ) : null}
            </div>
            <footer>
              <span>{selectedImage.dataName === 'depth' ? '深度图' : '亮度图'}</span>
              <span>序号 #{selectedImage.sequenceNo}</span>
              <span>{activeSelectedIndex + 1} / {visibleImages.length}</span>
              <code title={selectedImage.path}>{selectedImage.path}</code>
            </footer>
          </section>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function getDefectSizeLabel(defect: DefectItem) {
  return `${defect.widthMm.toFixed(2)} × ${defect.heightMm.toFixed(2)} × ${Math.abs(defect.depthMm).toFixed(2)}mm`;
}

function DemoSurfacePointCloud() {
  const [yaw, setYaw] = useState(POINT_CLOUD_INITIAL_YAW);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ pointerId: number; startX: number; startYaw: number } | null>(null);
  const pointCloud = useMemo(() => createPointCloudGeometryArrays(), []);
  const geometry = useMemo(() => {
    const mesh = new BufferGeometry();
    mesh.setAttribute('position', new Float32BufferAttribute(pointCloud.positions, 3));
    mesh.setAttribute('color', new Float32BufferAttribute(pointCloud.colors, 3));
    return mesh;
  }, [pointCloud]);

  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) {
      return;
    }
    dragState.current = null;
    setDragging(false);
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleWheelZoom = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    setZoom((current) => clampPointCloudZoom(Number((current + direction * POINT_CLOUD_ZOOM_STEP).toFixed(2))));
  };

  return (
    <div
      className={`point-cloud-viewer ${dragging ? 'is-dragging' : ''}`}
      data-testid="point-cloud-viewer"
      data-point-cloud-yaw={yaw.toFixed(3)}
      data-point-cloud-zoom={zoom.toFixed(2)}
      data-point-cloud-points={pointCloud.pointCount}
      data-point-cloud-memory-bytes={pointCloud.memoryBytes}
      data-artifact-source="demo"
      aria-label="点云图，左右拖拽调整视角，滚轮放大缩小"
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }
        dragState.current = { pointerId: event.pointerId, startX: event.clientX, startYaw: yaw };
        setDragging(true);
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }}
      onPointerMove={(event) => {
        const currentDrag = dragState.current;
        if (!currentDrag || currentDrag.pointerId !== event.pointerId) {
          return;
        }
        const horizontalDelta = event.clientX - currentDrag.startX;
        setYaw(clampPointCloudYaw(currentDrag.startYaw + horizontalDelta * 0.006));
      }}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onWheel={handleWheelZoom}
    >
      <Canvas camera={{ position: [2.4, 2.2, 3.3], fov: 46 }}>
        <ambientLight intensity={0.8} />
        <group rotation={[POINT_CLOUD_PITCH, yaw, 0]} scale={zoom}>
          <points geometry={geometry}>
            <pointsMaterial vertexColors size={0.044} />
          </points>
          <mesh position={[0.25, -0.72, 0]}>
            <boxGeometry args={[3.8, 0.025, 2.5]} />
            <meshBasicMaterial color="#6b7280" transparent opacity={0.22} />
          </mesh>
        </group>
      </Canvas>
      <span className="point-cloud-zoom-tag">缩放 {zoom.toFixed(2)}x</span>
      <span className="demo-artifact-badge">演示点云 · 非生产产物</span>
    </div>
  );
}

function HeightProfile({ points, widthPoints, defect }: { points: ChartPoint[]; widthPoints?: ChartPoint[]; defect: DefectItem }) {
  const [axisZoom, setAxisZoom] = useState(1);
  const sectionPoints = useMemo(() => {
    if (!widthPoints?.length) {
      return createSectionProfiles(points, defect);
    }
    return [
      ...points.map((point) => ({ x: point.x, lengthSection: point.z, widthSection: undefined })),
      ...widthPoints.map((point) => ({ x: point.x, lengthSection: undefined, widthSection: point.z })),
    ].sort((left, right) => left.x - right.x);
  }, [points, widthPoints, defect]);
  const depthLabel = `${defect.depthMm.toFixed(2)}mm`;
  const axisRange = useMemo(() => {
    const xValues = sectionPoints.map((point) => point.x);
    const fullXMin = xValues.length > 0 ? Math.min(...xValues) : 0;
    const fullXMax = xValues.length > 0 ? Math.max(...xValues) : 80;
    const fullXSpan = Math.max(1, fullXMax - fullXMin);
    const xCenter = (fullXMin + fullXMax) / 2;
    const xHalfRange = fullXSpan / axisZoom / 2;
    const yHalfRange = Math.max(1 / axisZoom, Math.abs(defect.depthMm) + 0.1);

    return {
      xDomain: [Number((xCenter - xHalfRange).toFixed(2)), Number((xCenter + xHalfRange).toFixed(2))] as [number, number],
      yDomain: [Number((-yHalfRange).toFixed(2)), Number(yHalfRange.toFixed(2))] as [number, number],
    };
  }, [axisZoom, defect.depthMm, sectionPoints]);

  const handleAxisWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    setAxisZoom((current) => clampChartAxisZoom(Number((current + direction * CHART_AXIS_ZOOM_STEP).toFixed(2))));
  };

  return (
    <div
      className="height-chart"
      data-testid="height-profile-chart"
      data-axis-zoom={axisZoom.toFixed(2)}
      data-x-domain={`${axisRange.xDomain[0].toFixed(2)},${axisRange.xDomain[1].toFixed(2)}`}
      data-y-domain={`${axisRange.yDomain[0].toFixed(2)},${axisRange.yDomain[1].toFixed(2)}`}
      aria-label="缺陷高度剖面图，滚轮调整坐标范围"
      onWheel={handleAxisWheel}
    >
      <div className="section-chart-legend" aria-label="切面曲线图例">
        <span>
          <i className="length-section" />
          长度切面
        </span>
        <span>
          <i className="width-section" />
          宽度切面
        </span>
      </div>
      <div className="chart-axis-range-tag" aria-label="当前坐标范围">
        <span>坐标 {axisZoom.toFixed(2)}x</span>
        <b>
          X {axisRange.xDomain[0].toFixed(0)}-{axisRange.xDomain[1].toFixed(0)}mm / Y {axisRange.yDomain[0].toFixed(2)}-{axisRange.yDomain[1].toFixed(2)}mm
        </b>
      </div>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={sectionPoints} margin={{ left: -26, right: 12, top: 14, bottom: 2 }}>
          <XAxis dataKey="x" type="number" domain={axisRange.xDomain} allowDataOverflow tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis domain={axisRange.yDomain} allowDataOverflow tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <Tooltip
            formatter={(value, name) => [
              `${Number(value).toFixed(2)}mm`,
              name === 'lengthSection' || name === '长度切面' ? '长度切面' : '宽度切面',
            ]}
            labelFormatter={(value) => `距离 ${value}mm`}
          />
          <ReferenceLine y={0} stroke="var(--chart-grid-strong)" />
          <ReferenceLine y={defect.depthMm} stroke="#ef2029" label={{ value: depthLabel, fill: '#ef2029', fontSize: 11 }} />
          <Line type="monotone" dataKey="lengthSection" name="长度切面" stroke="#2f6bff" dot={false} strokeWidth={2} isAnimationActive={false} connectNulls />
          <Line type="monotone" dataKey="widthSection" name="宽度切面" stroke="#ffb21c" dot={false} strokeWidth={2} isAnimationActive={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AlarmAnalysis({
  selectedDefect,
  heightProfile,
  captureImages = [],
  artifactMode = 'production',
  surfaceMesh,
  artifactStatus,
  inspectionId,
  headerless = false,
  collapsed,
  onCollapsedChange,
}: {
  selectedDefect: DefectItem | null;
  heightProfile: ChartPoint[];
  captureImages?: CaptureImageItem[];
  artifactMode?: 'production' | 'demo';
  surfaceMesh?: BarSurfaceMesh | null;
  artifactStatus?: string;
  inspectionId?: string;
  headerless?: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [localArtifacts, setLocalArtifacts] = useState<{
    pointCloud: BarSurfaceMesh | null;
    lengthProfile: ChartPoint[];
    widthProfile: ChartPoint[];
    status: string;
  }>({ pointCloud: null, lengthProfile: [], widthProfile: [], status: '' });
  const isCollapsed = selectedDefect ? (collapsed ?? internalCollapsed) : false;
  const setCollapsed = onCollapsedChange ?? setInternalCollapsed;
  const panelClassName = `alarm-analysis-panel ${isCollapsed ? 'is-collapsed' : ''}`;

  useEffect(() => {
    const controller = new AbortController();
    const artifacts = selectedDefect?.artifacts;
    if (artifactMode !== 'production' || !selectedDefect || !artifacts) {
      setLocalArtifacts({ pointCloud: null, lengthProfile: [], widthProfile: [], status: '' });
      return () => controller.abort();
    }
    const readJson = async <T,>(path: string | undefined): Promise<T | null> => {
      if (!path) return null;
      const response = await fetch(barSurfaceFileUrl(path), { signal: controller.signal });
      if (!response.ok) throw new Error(`缺陷产物读取失败 HTTP ${response.status}`);
      return response.json() as Promise<T>;
    };
    setLocalArtifacts({ pointCloud: null, lengthProfile: [], widthProfile: [], status: '正在加载缺陷局部产物' });
    Promise.all([
      readJson<{ schema: string; positions: number[]; colors?: number[] }>(artifacts.localPointCloud),
      readJson<{ points?: ChartPoint[] }>(artifacts.lengthProfile),
      readJson<{ points?: ChartPoint[] }>(artifacts.widthProfile),
    ]).then(([pointCloud, length, width]) => {
      if (controller.signal.aborted) return;
      setLocalArtifacts({
        pointCloud: pointCloud?.positions?.length ? {
          schema: pointCloud.schema,
          coordinateUnit: 'mm', cameraCount: 1, frameStems: [artifacts.frameId], rows: 1,
          colsPerCamera: Math.floor(pointCloud.positions.length / 3), positions: pointCloud.positions,
          colors: pointCloud.colors ?? [], uvs: [], indices: [], source: 'json',
        } : null,
        lengthProfile: length?.points ?? [],
        widthProfile: width?.points ?? [],
        status: '',
      });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setLocalArtifacts({ pointCloud: null, lengthProfile: [], widthProfile: [], status: error instanceof Error ? error.message : '缺陷局部产物读取失败' });
      }
    });
    return () => controller.abort();
  }, [artifactMode, selectedDefect?.id, selectedDefect?.artifacts]);

  if (!selectedDefect && captureImages.length > 0) {
    return (
      <Panel title="缺陷检测报警图" className={panelClassName} headerless={headerless}>
        <CaptureImagePreview captureImages={captureImages} />
      </Panel>
    );
  }

  if (!selectedDefect) {
    return (
      <Panel title="缺陷检测报警图" className={panelClassName} headerless={headerless}>
        <div className="analysis-empty">
          <h3>当前钢管暂无缺陷</h3>
          <p>切换检测记录或调整筛选条件后，将显示选中缺陷的灰度图、点云图和高度剖面。</p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="缺陷检测报警图" className={panelClassName} headerless={headerless}>
      {isCollapsed ? null : (
        <div className="analysis-grid">
          <div className="analysis-cell">
            <h3>灰度图</h3>
            <DefectPreview defect={selectedDefect} captureImages={captureImages} artifactMode={artifactMode} />
          </div>
          <div className="analysis-cell point-cloud">
            <h3>点云图</h3>
            {artifactMode === 'demo' ? (
              <>
                <span className="base-plane">基准面 0mm</span>
                <DemoSurfacePointCloud />
                <span className="depth-tag">凹坑深度 {selectedDefect.depthMm.toFixed(2)}mm</span>
              </>
            ) : localArtifacts.pointCloud && localArtifacts.pointCloud.positions.length >= 3 ? (
              <ProductionArtifactView
                mesh={localArtifacts.pointCloud}
                mode="points"
                testId="analysis-production-point-cloud"
                ariaLabel="当前缺陷真实局部点云"
                className="analysis-production-point-cloud"
              />
            ) : surfaceMesh && surfaceMesh.positions.length >= 3 ? (
              <>
                <ProductionArtifactView
                  mesh={surfaceMesh}
                  mode="points"
                  testId="analysis-production-point-cloud"
                  ariaLabel="当前检测记录整管参考点云"
                  className="analysis-production-point-cloud"
                />
                <span className="production-artifact-tag">整管参考 · 非缺陷局部点云</span>
              </>
            ) : (
              <div className="production-artifact-empty compact" role="status">
                <strong>暂无生产点云产物</strong>
                <span>{localArtifacts.status || artifactStatus || '当前缺陷尚未绑定算法局部点云。'}</span>
              </div>
            )}
          </div>
          <div className="analysis-cell">
            <h3>缺陷高度剖面图</h3>
            {artifactMode === 'demo' || localArtifacts.lengthProfile.length >= 2 || heightProfile.length >= 2 ? (
              <HeightProfile
                points={artifactMode === 'production' && localArtifacts.lengthProfile.length ? localArtifacts.lengthProfile : heightProfile}
                widthPoints={artifactMode === 'production' ? localArtifacts.widthProfile : undefined}
                defect={selectedDefect}
              />
            ) : (
              <div className="production-artifact-empty compact" role="status">
                <strong>暂无生产高度剖面产物</strong>
                <span>检测记录 {inspectionId || '未绑定'} 未提供缺陷局部剖面点。</span>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="analysis-detail-bar">
        {isCollapsed ? (
          <div className="detail-summary-line" data-testid="analysis-collapsed-summary">
            <span>{surfaceLabels[selectedDefect.surface]}</span>
            <strong>{selectedDefect.typeLabel}</strong>
            <b>{getDefectSizeLabel(selectedDefect)}</b>
            <span>距头 {selectedDefect.distanceHeadMm}mm</span>
            <span>操作 {selectedDefect.operatorSideMm}mm</span>
            <span>传动 {selectedDefect.driveSideMm}mm</span>
            <em className={selectedDefect.severity}>{severityLabels[selectedDefect.severity]}</em>
          </div>
        ) : (
          <table className="detail-table">
            <tbody>
              <tr>
                <th>缺陷类别名</th>
                <th>缺陷尺寸</th>
                <th>距头距离</th>
                <th>距操作侧</th>
                <th>距传动侧</th>
                <th>缺陷等级</th>
                <th>周期缺陷</th>
                <th>周期值</th>
              </tr>
              <tr>
                <td>{selectedDefect.typeLabel}</td>
                <td>{getDefectSizeLabel(selectedDefect)}</td>
                <td>{selectedDefect.distanceHeadMm}mm</td>
                <td>{selectedDefect.operatorSideMm}mm</td>
                <td>{selectedDefect.driveSideMm}mm</td>
                <td className={selectedDefect.severity}>{severityLabels[selectedDefect.severity]}</td>
                <td>{selectedDefect.typeId === 'roll' ? '是' : '否'}</td>
                <td>--</td>
              </tr>
            </tbody>
          </table>
        )}
        <button
          type="button"
          className="analysis-collapse-button"
          aria-label={isCollapsed ? '展开缺陷分析区' : '收起缺陷分析区'}
          aria-expanded={!isCollapsed}
          title={isCollapsed ? '展开缺陷分析区' : '收起缺陷分析区'}
          data-no-drag
          onClick={() => setCollapsed(!isCollapsed)}
        >
          {isCollapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>
      <div className="surface-caption">{surfaceLabels[selectedDefect.surface]}</div>
    </Panel>
  );
}
