import { Canvas } from '@react-three/fiber';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from 'react';
import type { ChartPoint, DefectItem } from '../data/inspection';
import { severityLabels, surfaceLabels } from '../data/inspection';
import { createSectionProfiles } from '../lib/section-profiles';
import { Panel } from './Panel';

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

function DefectPreview({ defect }: { defect: DefectItem }) {
  const previewStyle = {
    '--defect-preview-image': `url(${defect.previewImageUrl})`,
  } as CSSProperties;

  return (
    <div className="defect-preview" style={previewStyle}>
      <div className="defect-bbox" style={{ left: `${defect.previewX}%`, top: `${defect.previewY}%` }}>
        <span>{`${defect.typeLabel} ${defect.widthMm.toFixed(2)}x${defect.heightMm.toFixed(2)}x${Math.abs(defect.depthMm).toFixed(2)}mm`}</span>
      </div>
      <span className="scale-mark">2 mm</span>
    </div>
  );
}

function getDefectSizeLabel(defect: DefectItem) {
  return `${defect.widthMm.toFixed(2)} × ${defect.heightMm.toFixed(2)} × ${Math.abs(defect.depthMm).toFixed(2)}mm`;
}

function SurfacePointCloud() {
  const [yaw, setYaw] = useState(POINT_CLOUD_INITIAL_YAW);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ pointerId: number; startX: number; startYaw: number } | null>(null);
  const geometry = useMemo(() => {
    const positions: number[] = [];
    const colors: number[] = [];
    for (let x = -52; x <= 52; x += 2) {
      for (let y = -30; y <= 30; y += 2) {
        const dip = Math.exp(-((x - 16) ** 2 + (y + 5) ** 2) / 90) * -0.65;
        const wave = Math.sin(x * 0.18) * 0.08 + Math.cos(y * 0.22) * 0.06;
        const z = dip + wave;
        positions.push(x / 30, z, y / 25);
        const t = Math.max(0, Math.min(1, (z + 0.7) / 0.95));
        if (t < 0.5) {
          colors.push(0.04, 0.28 + t * 1.25, 0.96 - t * 1.1);
        } else {
          colors.push((t - 0.5) * 1.8, 0.92 - (t - 0.5) * 0.32, 0.12);
        }
      }
    }
    const mesh = new BufferGeometry();
    mesh.setAttribute('position', new Float32BufferAttribute(positions, 3));
    mesh.setAttribute('color', new Float32BufferAttribute(colors, 3));
    return mesh;
  }, []);

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
    </div>
  );
}

function HeightProfile({ points, defect }: { points: ChartPoint[]; defect: DefectItem }) {
  const [axisZoom, setAxisZoom] = useState(1);
  const sectionPoints = useMemo(() => createSectionProfiles(points, defect), [points, defect]);
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
          <Line type="monotone" dataKey="lengthSection" name="长度切面" stroke="#2f6bff" dot={false} strokeWidth={2} isAnimationActive={false} />
          <Line type="monotone" dataKey="widthSection" name="宽度切面" stroke="#ffb21c" dot={false} strokeWidth={2} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AlarmAnalysis({
  selectedDefect,
  heightProfile,
  headerless = false,
  collapsed,
  onCollapsedChange,
}: {
  selectedDefect: DefectItem | null;
  heightProfile: ChartPoint[];
  headerless?: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const isCollapsed = selectedDefect ? (collapsed ?? internalCollapsed) : false;
  const setCollapsed = onCollapsedChange ?? setInternalCollapsed;
  const panelClassName = `alarm-analysis-panel ${isCollapsed ? 'is-collapsed' : ''}`;

  if (!selectedDefect) {
    return (
      <Panel title="缺陷检测报警图" className={panelClassName} headerless={headerless}>
        <div className="analysis-empty">
          <h3>当前钢板暂无缺陷</h3>
          <p>切换检测记录或调整筛选条件后，将显示选中缺陷的灰度图、点云图和高度剖面。</p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="缺陷检测报警图" className={panelClassName} headerless={headerless}>
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
      {isCollapsed ? null : (
        <div className="analysis-grid">
          <div className="analysis-cell">
            <h3>灰度图</h3>
            <DefectPreview defect={selectedDefect} />
          </div>
          <div className="analysis-cell point-cloud">
            <h3>点云图</h3>
            <span className="base-plane">基准面 0mm</span>
            <SurfacePointCloud />
            <span className="depth-tag">凹坑深度 {selectedDefect.depthMm.toFixed(2)}mm</span>
          </div>
          <div className="analysis-cell">
            <h3>缺陷高度剖面图</h3>
            <HeightProfile points={heightProfile} defect={selectedDefect} />
          </div>
        </div>
      )}
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
      <div className="surface-caption">{surfaceLabels[selectedDefect.surface]}</div>
    </Panel>
  );
}
