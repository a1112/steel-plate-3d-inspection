import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Check, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type WheelEvent } from 'react';
import { DoubleSide, type Mesh, type PerspectiveCamera } from 'three';
import type { DefectItem, DefectType } from '../data/inspection';
import { surfaceLabels } from '../data/inspection';
import { clampPreviewPositionM, DEFAULT_PLATE_LENGTH_M, type SurfaceDisplayMode } from '../state/inspection-ui';
import { Panel } from './Panel';

interface PlateMapProps {
  defectTypes: DefectType[];
  defects: DefectItem[];
  defectTypeCounts: Record<string, number>;
  hiddenTypeIds: Set<string>;
  selectedDefectId: string | null;
  surfaceMode: SurfaceDisplayMode;
  previewPositionM: number;
  plateLengthM?: number;
  onToggleType: (typeId: string) => void;
  onSurfaceModeChange: (surfaceMode: SurfaceDisplayMode) => void;
  onPreviewPositionChange: (positionM: number) => void;
  onSelectDefect: (defectId: string) => void;
}

const surfaceModeOptions: { id: SurfaceDisplayMode; label: string }[] = [
  { id: 'top', label: '上表' },
  { id: 'bottom', label: '下表' },
  { id: 'all', label: '全部' },
];

type PlateMapViewMode = '2d' | '3d';

const viewModeOptions: { id: PlateMapViewMode; label: string }[] = [
  { id: '2d', label: '2D' },
  { id: '3d', label: '3D' },
];

const PLATE_3D_LENGTH = 10;
const PLATE_3D_WIDTH = 2.8;
const PLATE_3D_REFERENCE_GRID = 12;
const MAX_PLATE_3D_YAW = 0.5;
const MIN_PLATE_3D_ZOOM = 0.72;
const MAX_PLATE_3D_ZOOM = 2.2;
const PLATE_3D_ZOOM_STEP = 0.12;

function yOffsetToPercent(offset: number) {
  return `${Math.max(10, Math.min(90, 50 - (offset / 1.5) * 37))}%`;
}

function DefectMarker({
  defect,
  type,
  selected,
  onSelect,
}: {
  defect: DefectItem;
  type: DefectType;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`defect-marker ${type.shape} ${selected ? 'selected' : ''}`}
      style={{
        left: `${defect.xRatio * 100}%`,
        top: yOffsetToPercent(defect.yOffsetMm),
        backgroundColor: type.color,
      }}
      title={`${defect.typeLabel} ${surfaceLabels[defect.surface]} ${defect.distanceHeadMm}mm`}
      onClick={onSelect}
    />
  );
}

function AxisLabel({ label }: { label: string }) {
  return (
    <div className="axis-label">
      <span>{label}</span>
    </div>
  );
}

function SurfaceStrip({
  surface,
  defects,
  defectTypes,
  selectedDefectId,
  previewPositionM,
  plateLengthM,
  onSelectDefect,
}: {
  surface: 'top' | 'bottom';
  defects: DefectItem[];
  defectTypes: DefectType[];
  selectedDefectId: string | null;
  previewPositionM: number;
  plateLengthM: number;
  onSelectDefect: (defectId: string) => void;
}) {
  const previewPercent = (clampPreviewPositionM(previewPositionM, plateLengthM) / plateLengthM) * 100;

  return (
    <div className="surface-row">
      <AxisLabel label={surface === 'top' ? '上表面' : '下表面'} />
      <div className="y-axis">
        {['+1.5m', '+1.0m', '+0.5m', '0', '-0.5m', '-1.0m', '-1.5m'].map((tick) => (
          <span key={tick}>{tick}</span>
        ))}
      </div>
      <div className="plate-strip" style={{ '--preview-position': `${previewPercent}%` } as CSSProperties}>
        <span className="side-note operator">操作侧</span>
        <span className="side-note drive">传动侧</span>
        <div className="center-line" />
        <div
          className={`strip-preview-cursor ${previewPercent > 82 ? 'near-end' : ''}`}
          data-testid={`preview-cursor-${surface}`}
          aria-hidden="true"
          style={{ left: `${previewPercent}%` }}
        >
          <span>{clampPreviewPositionM(previewPositionM, plateLengthM).toFixed(2)}m</span>
        </div>
        {defects
          .filter((defect) => defect.surface === surface)
          .map((defect) => {
            const type = defectTypes.find((item) => item.id === defect.typeId);
            if (!type) return null;
            return (
              <DefectMarker
                key={defect.id}
                defect={defect}
                type={type}
                selected={defect.id === selectedDefectId}
                onSelect={() => onSelectDefect(defect.id)}
              />
            );
          })}
      </div>
    </div>
  );
}

function LengthRuler({
  previewPositionM,
  plateLengthM,
  onPreviewPositionChange,
}: {
  previewPositionM: number;
  plateLengthM: number;
  onPreviewPositionChange: (positionM: number) => void;
}) {
  const activePointerId = useRef<number | null>(null);
  const mouseDragging = useRef(false);
  const safePlateLengthM = plateLengthM > 0 ? plateLengthM : DEFAULT_PLATE_LENGTH_M;
  const safePositionM = clampPreviewPositionM(previewPositionM, safePlateLengthM);
  const previewPercent = (safePositionM / safePlateLengthM) * 100;

  const updateFromClientX = (clientX: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const ratio = (clientX - rect.left) / rect.width;
    const nextPositionM = clampPreviewPositionM(Number((ratio * safePlateLengthM).toFixed(2)), safePlateLengthM);
    onPreviewPositionChange(nextPositionM);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    activePointerId.current = event.pointerId;
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    updateFromClientX(event.clientX, event.currentTarget);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointerId.current !== event.pointerId) {
      return;
    }
    updateFromClientX(event.clientX, event.currentTarget);
  };

  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointerId.current !== event.pointerId) {
      return;
    }
    activePointerId.current = null;
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (activePointerId.current !== null) {
      return;
    }
    mouseDragging.current = true;
    updateFromClientX(event.clientX, event.currentTarget);
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!mouseDragging.current || activePointerId.current !== null) {
      return;
    }
    updateFromClientX(event.clientX, event.currentTarget);
  };

  const stopMouseDragging = () => {
    mouseDragging.current = false;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 1 : 0.1;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onPreviewPositionChange(clampPreviewPositionM(Number((safePositionM - step).toFixed(2)), safePlateLengthM));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onPreviewPositionChange(clampPreviewPositionM(Number((safePositionM + step).toFixed(2)), safePlateLengthM));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onPreviewPositionChange(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      onPreviewPositionChange(safePlateLengthM);
    }
  };

  return (
    <div
      className="length-ruler"
      role="slider"
      tabIndex={0}
      aria-label="预览位置"
      aria-valuemin={0}
      aria-valuemax={safePlateLengthM}
      aria-valuenow={Number(safePositionM.toFixed(2))}
      aria-valuetext={`${safePositionM.toFixed(2)}m`}
      data-preview-position-m={safePositionM.toFixed(2)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={stopMouseDragging}
      onMouseLeave={stopMouseDragging}
      onKeyDown={handleKeyDown}
    >
      {[0, 3, 6, 9, 12].map((meter) => (
        <span
          key={meter}
          className={`ruler-tick-label ${meter === 0 ? 'ruler-start-label' : meter === 12 ? 'ruler-end-label' : ''}`}
          style={meter === 12 ? { right: 0 } : { left: `${(meter / 12) * 100}%` }}
        >
          {meter}m
        </span>
      ))}
      <div className={`ruler-preview-position ${previewPercent > 82 ? 'near-end' : ''}`} style={{ left: `${previewPercent}%` }}>
        <span className="ruler-preview-label">{safePositionM.toFixed(2)}m</span>
      </div>
    </div>
  );
}

function SurfaceModeSwitch({
  value,
  onChange,
}: {
  value: SurfaceDisplayMode;
  onChange: (surfaceMode: SurfaceDisplayMode) => void;
}) {
  return (
    <div className="surface-mode-switch" role="group" aria-label="表面显示切换">
      {surfaceModeOptions.map((option) => {
        const active = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            className={active ? 'active' : ''}
            aria-pressed={active}
            aria-label={`显示${option.label}`}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function ViewModeSwitch({
  value,
  onChange,
}: {
  value: PlateMapViewMode;
  onChange: (viewMode: PlateMapViewMode) => void;
}) {
  return (
    <div className="plate-view-switch" role="group" aria-label="显示视图切换">
      {viewModeOptions.map((option) => {
        const active = value === option.id;
        return (
          <button key={option.id} type="button" className={active ? 'active' : ''} aria-pressed={active} onClick={() => onChange(option.id)}>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function PlateMapActions({
  viewMode,
  surfaceMode,
  onViewModeChange,
  onSurfaceModeChange,
}: {
  viewMode: PlateMapViewMode;
  surfaceMode: SurfaceDisplayMode;
  onViewModeChange: (viewMode: PlateMapViewMode) => void;
  onSurfaceModeChange: (surfaceMode: SurfaceDisplayMode) => void;
}) {
  return (
    <div className="plate-map-actions">
      <ViewModeSwitch value={viewMode} onChange={onViewModeChange} />
      <SurfaceModeSwitch value={surfaceMode} onChange={onSurfaceModeChange} />
    </div>
  );
}

function getDefect3DPosition(defect: DefectItem, plateLengthM: number): [number, number, number] {
  const lengthRatio = plateLengthM > 0 ? defect.distanceHeadMm / (plateLengthM * 1000) : defect.xRatio;
  const x = (Math.max(0, Math.min(1, lengthRatio)) - 0.5) * PLATE_3D_LENGTH;
  const y = defect.surface === 'top' ? 0.14 : -0.14;
  const z = Math.max(-1, Math.min(1, -defect.yOffsetMm / 1.5)) * (PLATE_3D_WIDTH / 2 - 0.16);
  return [x, y, z];
}

function Defect3DGeometry({ shape }: { shape: DefectType['shape'] }) {
  if (shape === 'diamond') {
    return <octahedronGeometry args={[0.11, 0]} />;
  }
  if (shape === 'rect') {
    return <boxGeometry args={[0.22, 0.055, 0.09]} />;
  }
  if (shape === 'square') {
    return <boxGeometry args={[0.13, 0.08, 0.13]} />;
  }
  if (shape === 'star') {
    return <coneGeometry args={[0.12, 0.18, 5]} />;
  }
  return <sphereGeometry args={[0.095, 18, 12]} />;
}

function PreviewScanPlane({ x }: { x: number }) {
  const scanRef = useRef<Mesh>(null);

  useFrame((state) => {
    if (!scanRef.current) {
      return;
    }
    const pulse = 1 + Math.sin(state.clock.elapsedTime * 3.1) * 0.12;
    scanRef.current.scale.set(1, pulse, 1);
  });

  return (
    <mesh ref={scanRef} position={[x, 0, 0]}>
      <boxGeometry args={[0.035, 0.62, PLATE_3D_WIDTH + 0.22]} />
      <meshBasicMaterial color="#2f7dff" transparent opacity={0.34} />
    </mesh>
  );
}

function clampPlate3DYaw(yaw: number) {
  return Math.max(-MAX_PLATE_3D_YAW, Math.min(MAX_PLATE_3D_YAW, yaw));
}

function clampPlate3DZoom(zoom: number) {
  return Math.max(MIN_PLATE_3D_ZOOM, Math.min(MAX_PLATE_3D_ZOOM, zoom));
}

function FixedTiltCamera({ zoom }: { zoom: number }) {
  const { camera, size } = useThree();

  useEffect(() => {
    const perspectiveCamera = camera as PerspectiveCamera;
    camera.position.set(0, 4.15, 7.2);
    camera.lookAt(0, 0, 0);
    perspectiveCamera.zoom = zoom;
    camera.updateProjectionMatrix();
  }, [camera, size.width, size.height, zoom]);

  return null;
}

function Plate3DGroup({
  defects,
  defectTypes,
  selectedDefectId,
  previewPositionM,
  plateLengthM,
  yawOffset,
  onSelectDefect,
}: {
  defects: DefectItem[];
  defectTypes: DefectType[];
  selectedDefectId: string | null;
  previewPositionM: number;
  plateLengthM: number;
  yawOffset: number;
  onSelectDefect: (defectId: string) => void;
}) {
  const safePreviewPositionM = clampPreviewPositionM(previewPositionM, plateLengthM);
  const previewX = (safePreviewPositionM / plateLengthM - 0.5) * PLATE_3D_LENGTH;

  return (
    <group rotation={[0, yawOffset, 0]}>
      <mesh receiveShadow>
        <boxGeometry args={[PLATE_3D_LENGTH, 0.18, PLATE_3D_WIDTH]} />
        <meshStandardMaterial color="#737d82" roughness={0.68} metalness={0.36} />
      </mesh>
      <mesh position={[0, 0.102, 0]}>
        <boxGeometry args={[PLATE_3D_LENGTH, 0.012, PLATE_3D_WIDTH]} />
        <meshStandardMaterial color="#a6afb4" roughness={0.62} metalness={0.22} transparent opacity={0.88} side={DoubleSide} />
      </mesh>
      <mesh position={[0, -0.102, 0]}>
        <boxGeometry args={[PLATE_3D_LENGTH, 0.012, PLATE_3D_WIDTH]} />
        <meshStandardMaterial color="#56636b" roughness={0.72} metalness={0.2} transparent opacity={0.5} side={DoubleSide} />
      </mesh>
      <gridHelper args={[PLATE_3D_REFERENCE_GRID, 24, '#4f6473', '#263743']} position={[0, -0.16, 0]} />
      <PreviewScanPlane x={previewX} />
      {defects.map((defect) => {
        const type = defectTypes.find((item) => item.id === defect.typeId);
        if (!type) {
          return null;
        }
        const selected = defect.id === selectedDefectId;
        const [x, y, z] = getDefect3DPosition(defect, plateLengthM);
        return (
          <mesh key={defect.id} position={[x, y, z]} scale={selected ? 1.42 : 1} onClick={() => onSelectDefect(defect.id)}>
            <Defect3DGeometry shape={type.shape} />
            <meshStandardMaterial color={type.color} emissive={type.color} emissiveIntensity={selected ? 0.38 : 0.16} roughness={0.38} />
          </mesh>
        );
      })}
    </group>
  );
}

function Plate3DScene(props: {
  defects: DefectItem[];
  defectTypes: DefectType[];
  selectedDefectId: string | null;
  previewPositionM: number;
  plateLengthM: number;
  zoom: number;
  yawOffset: number;
  onSelectDefect: (defectId: string) => void;
}) {
  return (
    <Canvas camera={{ fov: 34, near: 0.1, far: 100 }} dpr={[1, 1.5]} gl={{ antialias: true, preserveDrawingBuffer: true }}>
      <FixedTiltCamera zoom={props.zoom} />
      <color attach="background" args={['#101922']} />
      <ambientLight intensity={0.74} />
      <directionalLight position={[0, 6, 5]} intensity={1.25} />
      <directionalLight position={[-4, 3, -3]} intensity={0.45} />
      <Plate3DGroup {...props} />
    </Canvas>
  );
}

function PlateMap3DView({
  defects,
  defectTypes,
  selectedDefectId,
  previewPositionM,
  plateLengthM,
  surfaceMode,
  onSelectDefect,
}: {
  defects: DefectItem[];
  defectTypes: DefectType[];
  selectedDefectId: string | null;
  previewPositionM: number;
  plateLengthM: number;
  surfaceMode: SurfaceDisplayMode;
  onSelectDefect: (defectId: string) => void;
}) {
  const selectedDefect = defects.find((defect) => defect.id === selectedDefectId) ?? defects[0] ?? null;
  const topCount = useMemo(() => defects.filter((defect) => defect.surface === 'top').length, [defects]);
  const bottomCount = defects.length - topCount;
  const [viewYaw, setViewYaw] = useState(0);
  const [viewZoom, setViewZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ pointerId: number; startX: number; startYaw: number } | null>(null);

  const handleWheelZoom = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    setViewZoom((current) => clampPlate3DZoom(Number((current + direction * PLATE_3D_ZOOM_STEP).toFixed(2))));
  };

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

  return (
    <div
      className={`plate-map-3d-view ${dragging ? 'is-dragging' : ''}`}
      data-testid="plate-map-3d-view"
      data-view-yaw={viewYaw.toFixed(3)}
      data-view-zoom={viewZoom.toFixed(2)}
      aria-label="3D钢板视图，左右拖拽调整视角，滚轮放大缩小"
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }
        dragState.current = { pointerId: event.pointerId, startX: event.clientX, startYaw: viewYaw };
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
        setViewYaw(clampPlate3DYaw(currentDrag.startYaw + horizontalDelta * 0.004));
      }}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onWheel={handleWheelZoom}
    >
      <Plate3DScene
        defects={defects}
        defectTypes={defectTypes}
        selectedDefectId={selectedDefectId}
        previewPositionM={previewPositionM}
        plateLengthM={plateLengthM}
        zoom={viewZoom}
        yawOffset={viewYaw}
        onSelectDefect={onSelectDefect}
      />
      <div className="plate-3d-overlay">
        <div>
          <span>3D显示视图</span>
          <strong>{surfaceMode === 'all' ? '上下表面' : surfaceLabels[surfaceMode]}</strong>
        </div>
        <div>
          <span>上表 / 下表</span>
          <strong>
            {topCount} / {bottomCount}
          </strong>
        </div>
        <div>
          <span>预览位置</span>
          <strong>{clampPreviewPositionM(previewPositionM, plateLengthM).toFixed(2)}m</strong>
        </div>
        <div>
          <span>缩放倍率</span>
          <strong>{viewZoom.toFixed(2)}x</strong>
        </div>
      </div>
      <div className="plate-3d-axis-labels" aria-hidden="true">
        <span className="head">0m 头部</span>
        <span className="tail">{plateLengthM.toFixed(0)}m 尾部</span>
        <span className="operator">操作侧</span>
        <span className="drive">传动侧</span>
      </div>
      {selectedDefect ? (
        <div className="plate-3d-selected">
          <span>{surfaceLabels[selectedDefect.surface]}</span>
          <strong>{selectedDefect.typeLabel}</strong>
          <b>{`${(selectedDefect.distanceHeadMm / 1000).toFixed(2)}m / ${selectedDefect.depthMm.toFixed(2)}mm`}</b>
        </div>
      ) : null}
    </div>
  );
}

export function PlateMap({
  defectTypes,
  defects,
  defectTypeCounts,
  hiddenTypeIds,
  selectedDefectId,
  surfaceMode,
  previewPositionM,
  plateLengthM = DEFAULT_PLATE_LENGTH_M,
  onToggleType,
  onSurfaceModeChange,
  onPreviewPositionChange,
  onSelectDefect,
}: PlateMapProps) {
  const [viewMode, setViewMode] = useState<PlateMapViewMode>('2d');
  const showAllSurfaces = surfaceMode === 'all';
  const selectedSurface = surfaceMode === 'all' ? 'top' : surfaceMode;
  const safePlateLengthM = plateLengthM > 0 ? plateLengthM : DEFAULT_PLATE_LENGTH_M;

  return (
    <Panel
      title="钢板缺陷长宽映射图"
      className={`plate-map-panel surface-mode-${surfaceMode} view-mode-${viewMode}`}
      action={
        <PlateMapActions
          viewMode={viewMode}
          surfaceMode={surfaceMode}
          onViewModeChange={setViewMode}
          onSurfaceModeChange={onSurfaceModeChange}
        />
      }
    >
      <div className="defect-legend">
        {defectTypes.map((type) => {
          const active = !hiddenTypeIds.has(type.id);
          const count = defectTypeCounts[type.id] ?? 0;
          return (
            <button
              key={type.id}
              type="button"
              className={`legend-toggle ${active ? 'is-selected' : 'is-cancelled'}`}
              style={{ '--legend-color': type.color } as CSSProperties}
              aria-pressed={active}
              aria-label={`${type.label} ${count} 个${active ? '已选中，点击取消' : '已取消，点击选中'}`}
              title={`${type.label}：${count} 个${active ? '，点击取消显示' : '，点击选中显示'}`}
              onClick={() => onToggleType(type.id)}
            >
              <span className="legend-swatch" aria-hidden="true">
                {active ? <Check size={11} strokeWidth={3} /> : <X size={11} strokeWidth={3} />}
              </span>
              <span className="legend-label">{type.label}</span>
              <span className="legend-count">{count}</span>
            </button>
          );
        })}
      </div>

      {viewMode === '3d' ? (
        <PlateMap3DView
          defects={defects}
          defectTypes={defectTypes}
          selectedDefectId={selectedDefectId}
          previewPositionM={previewPositionM}
          plateLengthM={safePlateLengthM}
          surfaceMode={surfaceMode}
          onSelectDefect={onSelectDefect}
        />
      ) : showAllSurfaces ? (
        <>
          <SurfaceStrip
            surface="top"
            defects={defects}
            defectTypes={defectTypes}
            selectedDefectId={selectedDefectId}
            previewPositionM={previewPositionM}
            plateLengthM={safePlateLengthM}
            onSelectDefect={onSelectDefect}
          />
          <LengthRuler previewPositionM={previewPositionM} plateLengthM={safePlateLengthM} onPreviewPositionChange={onPreviewPositionChange} />
          <SurfaceStrip
            surface="bottom"
            defects={defects}
            defectTypes={defectTypes}
            selectedDefectId={selectedDefectId}
            previewPositionM={previewPositionM}
            plateLengthM={safePlateLengthM}
            onSelectDefect={onSelectDefect}
          />
        </>
      ) : (
        <>
          <SurfaceStrip
            surface={selectedSurface}
            defects={defects}
            defectTypes={defectTypes}
            selectedDefectId={selectedDefectId}
            previewPositionM={previewPositionM}
            plateLengthM={safePlateLengthM}
            onSelectDefect={onSelectDefect}
          />
          <LengthRuler previewPositionM={previewPositionM} plateLengthM={safePlateLengthM} onPreviewPositionChange={onPreviewPositionChange} />
        </>
      )}
    </Panel>
  );
}
