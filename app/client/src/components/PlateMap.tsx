import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Check, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type WheelEvent } from 'react';
import { DoubleSide, type Mesh, type PerspectiveCamera } from 'three';
import heightMapBottomImage from '../assets/plate-surfaces/height-map-bottom.png';
import heightMapTopImage from '../assets/plate-surfaces/height-map-top.png';
import type { CaptureImageItem, DefectItem, DefectType } from '../data/inspection';
import { severityLabels, surfaceLabels } from '../data/inspection';
import { createSequentialCameraLanes, type CameraDisplayLane } from '../lib/camera-display';
import { captureArtifactImageUrl, type CaptureFlowSurface, type CaptureSurfaceCameraTiles } from '../lib/capture-api';
import { barSurfaceFileUrl, type BarSurfaceCamera, type BarSurfaceMesh } from '../services/bar-surface-api';
import {
  fetchCaptureStitchHistory,
  type CaptureStitchFrame,
  type CaptureStitchResult,
} from '../services/capture-roi-api';
import {
  fetchInspectionWorldDefects,
  fetchInspectionWorldMeta,
  fetchInspectionWorldTile,
  InspectionWorldHttpError,
  type InspectionWorldDefect,
  type InspectionWorldMeta,
} from '../services/inspection-world-api';
import { clampPreviewPositionM, DEFAULT_PLATE_LENGTH_M, type SurfaceDisplayMode } from '../state/inspection-ui';
import { Panel } from './Panel';
import { ProductionArtifactView, type ArtifactOrientation } from './ProductionArtifactView';
import { BkvSectionView } from './BkvReconstructionApp';
import { CaptureSectionView } from './CaptureSectionView';
import { InspectionWorldCanvas, type InspectionWorldTileLoading } from './InspectionWorldCanvas';

interface PlateMapProps {
  defectTypes: DefectType[];
  defects: DefectItem[];
  defectTypeCounts: Record<string, number>;
  hiddenTypeIds: Set<string>;
  selectedDefectId: string | null;
  worldFocusRequest?: {
    defectId: string | null;
    revision: number;
  };
  surfaceMode: SurfaceDisplayMode;
  previewPositionM: number;
  plateLengthM?: number;
  nominalDiameterMm?: number;
  artifactMode?: 'production' | 'demo';
  inspectionId?: string;
  requireInspectionWorld?: boolean;
  captureMaterialId?: string;
  captureRoiFallbackMaterialIds?: readonly string[];
  refreshCaptureRoi?: boolean;
  captureImages?: CaptureImageItem[];
  cameraLanes?: CameraDisplayLane[];
  surfaceMesh?: BarSurfaceMesh | null;
  surfaceCameraTiles?: CaptureSurfaceCameraTiles | null;
  surfaceHeadAlignment?: CaptureFlowSurface['headAlignment'] | null;
  surfaceCameras?: BarSurfaceCamera[];
  artifactStatus?: string;
  viewMode?: PlateMapViewMode;
  integratedToolbar?: boolean;
  toolbarExtra?: ReactNode;
  onToggleType: (typeId: string) => void;
  onSurfaceModeChange: (surfaceMode: SurfaceDisplayMode) => void;
  onPreviewPositionChange: (positionM: number) => void;
  onSelectDefect: (defectId: string) => void;
  onViewModeChange?: (viewMode: PlateMapViewMode) => void;
  onVisibleRangeChange?: (range: [number, number] | null) => void;
}

const surfaceModeOptions: { id: SurfaceDisplayMode; label: string }[] = [
  { id: 'top', label: '1-3号' },
  { id: 'bottom', label: '4-6号' },
  { id: 'all', label: '全部' },
];

export type PlateMapViewMode = '2d' | '3d' | 'section';
type Plate3DDisplayMode = 'surface' | 'points' | 'texture' | 'jet';
type Plate2DDisplayMode = 'gray' | 'jet';
type UnfoldOrientation = 'horizontal' | 'vertical';
type DisplayWorld = {
  recordId: string;
  meta: InspectionWorldMeta;
  defects: InspectionWorldDefect[];
};

type CaptureStitchState = {
  materialId: string;
  status: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  result: CaptureStitchResult | null;
};

function useCaptureStitchHistory(
  materialId: string | undefined,
  cameraIds: readonly string[],
  enabled: boolean,
  keepRefreshing: boolean,
) {
  const cameraKey = cameraIds.join(',');
  const [state, setState] = useState<CaptureStitchState>({
    materialId: '',
    status: 'idle',
    result: null,
  });
  useEffect(() => {
    const normalizedMaterialId = materialId?.trim() || '';
    if (!enabled || !normalizedMaterialId) {
      setState({ materialId: normalizedMaterialId, status: 'idle', result: null });
      return undefined;
    }
    const expectedCameraIds = cameraKey.split(',').filter(Boolean);
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    setState({ materialId: normalizedMaterialId, status: 'loading', result: null });

    const schedule = (delayMs: number) => {
      if (!cancelled) timer = window.setTimeout(() => void refresh(), delayMs);
    };
    const refresh = async () => {
      try {
        const result = await fetchCaptureStitchHistory(normalizedMaterialId, expectedCameraIds);
        if (cancelled) return;
        failures = 0;
        setState({
          materialId: normalizedMaterialId,
          status: result.frames.length > 0 ? 'ready' : 'missing',
          result: result.frames.length > 0 ? result : null,
        });
        if (keepRefreshing) schedule(8_000);
      } catch {
        if (cancelled) return;
        failures += 1;
        setState({ materialId: normalizedMaterialId, status: 'error', result: null });
        schedule(Math.min(30_000, 4_000 * (2 ** Math.min(3, failures - 1))));
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [cameraKey, enabled, keepRefreshing, materialId]);
  return state;
}

export function cameraBandRotationRadians(orientation: UnfoldOrientation) {
  // Line-scan frames store the camera cross-section on X and acquisition
  // progress (steel length) on Y. Vertical unfolding therefore uses the
  // frame as-is; horizontal unfolding rotates counter-clockwise so source Y
  // still runs from the steel-in side to the steel-out side.
  return orientation === 'horizontal' ? -Math.PI / 2 : 0;
}

export function cameraBandCropPadding(sampleSpan: number) {
  // Automatic black-border detection is deliberately conservative. Keep a
  // visible guard around the detected steel so dark physical edge pixels are
  // not mistaken for the black sensor background after down-sampling.
  return Math.max(6, Math.round(Math.max(0, sampleSpan) * 0.06));
}

export interface CameraBandCropWindow {
  left: number;
  right: number;
}

export function mergeCameraBandCropWindow(
  current: CameraBandCropWindow | undefined,
  candidate: CameraBandCropWindow,
) {
  const left = Math.max(0, Math.min(1, candidate.left));
  const right = Math.max(0, Math.min(1, candidate.right));
  if (!Number.isFinite(left) || !Number.isFinite(right) || right - left < 0.04) return current;
  if (!current) return { left, right };
  const merged = {
    left: Math.min(current.left, left),
    right: Math.max(current.right, right),
  };
  return merged.left === current.left && merged.right === current.right ? current : merged;
}

function captureStitchCameraHasContent(camera: CaptureStitchFrame['cameras'][number]) {
  if (camera.sourceBytes === undefined) return true;
  if (!Number.isFinite(camera.sourceBytes) || camera.sourceBytes <= 0) return false;
  const roiPixels = camera.validRoi
    ? (camera.validRoi[2] - camera.validRoi[0]) * (camera.validRoi[3] - camera.validRoi[1])
    : camera.sourceWidth * camera.sourceHeight;
  // Empty line-scan PNGs from the current cameras are typically about 24 KB.
  // Combine an absolute floor with a resolution-aware density check so a
  // partial physical edge is retained without landing on a sensor-black run.
  return camera.sourceBytes >= Math.max(48 * 1024, roiPixels * 0.02);
}

export function captureStitchInitialFrameIndex(
  frames: readonly CaptureStitchFrame[],
  expectedCameraCount: number,
) {
  if (frames.length === 0) return 0;
  const expected = Math.max(1, Math.trunc(expectedCameraCount));
  let bestIndex = 0;
  let bestContentCount = -1;
  let bestCameraCount = -1;
  let bestBytes = -1;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const contentCount = frame.cameras.filter(captureStitchCameraHasContent).length;
    const sourceBytes = frame.cameras.reduce((total, camera) => total + (camera.sourceBytes ?? 0), 0);
    if (contentCount >= expected) return index;
    if (
      contentCount > bestContentCount
      || (contentCount === bestContentCount && frame.cameras.length > bestCameraCount)
      || (contentCount === bestContentCount && frame.cameras.length === bestCameraCount && sourceBytes > bestBytes)
    ) {
      bestIndex = index;
      bestContentCount = contentCount;
      bestCameraCount = frame.cameras.length;
      bestBytes = sourceBytes;
    }
  }
  return bestIndex;
}

const viewModeOptions: { id: PlateMapViewMode; label: string }[] = [
  { id: '2d', label: '2D' },
  { id: '3d', label: '3D' },
  { id: 'section', label: '切面' },
];

const PLATE_3D_LENGTH = 10;
const PLATE_3D_WIDTH = 2.8;
const PLATE_3D_REFERENCE_GRID = 12;
const MAX_PLATE_3D_YAW = 0.5;
const MIN_PLATE_3D_ZOOM = 0.72;
const MAX_PLATE_3D_ZOOM = 2.2;
const PLATE_3D_ZOOM_STEP = 0.12;
const DEFAULT_CAMERA_LANES = createSequentialCameraLanes(8);

function loadTextureImage(url: string, signal: AbortSignal) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const abort = () => {
      image.src = '';
      reject(new DOMException('Texture loading aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    image.onload = () => {
      signal.removeEventListener('abort', abort);
      resolve(image);
    };
    image.onerror = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('检测图像瓦片解码失败'));
    };
    image.src = url;
  });
}

function useInspectionWorldTexture(
  recordId: string | undefined,
  meta: InspectionWorldMeta | undefined,
  enabled: boolean,
  zoom: number,
) {
  const [textureUrl, setTextureUrl] = useState('');
  const [textureStatus, setTextureStatus] = useState('');
  const textureRecordRef = useRef('');
  const textureObjectUrlRef = useRef('');
  const detailBoost = Math.min(3, Math.max(0, Math.floor(Math.log2(Math.max(1, zoom)))));

  useEffect(() => () => {
    if (textureObjectUrlRef.current) {
      URL.revokeObjectURL(textureObjectUrlRef.current);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !recordId || !meta) return;
    const controller = new AbortController();
    if (textureRecordRef.current !== recordId) {
      textureRecordRef.current = recordId;
      if (textureObjectUrlRef.current) {
        URL.revokeObjectURL(textureObjectUrlRef.current);
        textureObjectUrlRef.current = '';
      }
      setTextureUrl('');
    }
    setTextureStatus('正在生成 2D 检测图像贴图…');
    const generate = async () => {
      const resolutionMultiplier = 2 ** detailBoost;
      const maximumTextureDimension = 8192;
      const maximumTexturePixels = 24 * 1024 * 1024;
      const scale = Math.min(
        1,
        2048 * resolutionMultiplier / Math.max(1, meta.world.height),
        1024 * resolutionMultiplier / Math.max(1, meta.world.width),
        maximumTextureDimension / Math.max(1, meta.world.height),
        maximumTextureDimension / Math.max(1, meta.world.width),
        Math.sqrt(maximumTexturePixels / Math.max(1, meta.world.width * meta.world.height)),
      );
      const level = Math.min(
        meta.world.maxLevel,
        Math.max(0, Math.floor(Math.log2(1 / Math.max(scale, 1e-6)))),
      );
      const span = meta.world.tileSize * 2 ** level;
      const worldCanvas = document.createElement('canvas');
      worldCanvas.width = Math.max(1, Math.round(meta.world.width * scale));
      worldCanvas.height = Math.max(1, Math.round(meta.world.height * scale));
      const context = worldCanvas.getContext('2d');
      if (!context) throw new Error('浏览器不支持贴图合成');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.fillStyle = '#07111c';
      context.fillRect(0, 0, worldCanvas.width, worldCanvas.height);

      const requests = meta.world.cameras.flatMap((camera) => (
        Array.from({ length: Math.ceil(camera.height / span) }, (_, y) => (
          Array.from({ length: Math.ceil(camera.width / span) }, (_, x) => ({
            camera,
            x,
            y,
          }))
        )).flat()
      ));
      for (let index = 0; index < requests.length; index += 8) {
        const batch = requests.slice(index, index + 8);
        await Promise.all(batch.map(async ({ camera, x, y }) => {
          const tile = await fetchInspectionWorldTile(
            recordId,
            {
              cameraId: camera.cameraId,
              level,
              x,
              y,
              revision: meta.sourceRevision,
              format: 'jpeg',
            },
            controller.signal,
          );
          try {
            const image = await loadTextureImage(tile.url, controller.signal);
            const sourceWidth = Math.min(span, camera.width - x * span);
            const sourceHeight = Math.min(span, camera.height - y * span);
            context.drawImage(
              image,
              (camera.offsetX + x * span) * scale,
              y * span * scale,
              sourceWidth * scale,
              sourceHeight * scale,
            );
          } finally {
            tile.revoke();
          }
        }));
        setTextureStatus(`正在生成 2D 检测图像贴图… ${Math.min(index + 8, requests.length)}/${requests.length}`);
      }

      const textureCanvas = document.createElement('canvas');
      textureCanvas.width = worldCanvas.height;
      textureCanvas.height = worldCanvas.width;
      const textureContext = textureCanvas.getContext('2d');
      if (!textureContext) throw new Error('浏览器不支持贴图旋转');
      textureContext.imageSmoothingEnabled = true;
      textureContext.imageSmoothingQuality = 'high';
      textureContext.translate(textureCanvas.width, 0);
      textureContext.rotate(Math.PI / 2);
      textureContext.drawImage(worldCanvas, 0, 0);
      if (controller.signal.aborted) return;
      const blob = await new Promise<Blob | null>((resolve) => {
        textureCanvas.toBlob(resolve, 'image/jpeg', 0.96);
      });
      if (!blob) throw new Error('2D 检测图像贴图编码失败');
      if (controller.signal.aborted) return;
      const nextTextureUrl = URL.createObjectURL(blob);
      const previousTextureUrl = textureObjectUrlRef.current;
      textureObjectUrlRef.current = nextTextureUrl;
      setTextureUrl(nextTextureUrl);
      if (previousTextureUrl) {
        URL.revokeObjectURL(previousTextureUrl);
      }
      setTextureStatus(`2D 检测图像贴图 · LOD ${level} · ${textureCanvas.width}×${textureCanvas.height}`);
    };
    void generate().catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setTextureStatus(error instanceof Error ? error.message : '2D 检测图像贴图生成失败');
      }
    });
    return () => controller.abort();
  }, [detailBoost, enabled, meta, recordId]);

  return { textureUrl, textureStatus };
}

function clampPercent(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, value));
}

function closestObservedSectionRow(mesh: BarSurfaceMesh, requestedRow: number) {
  const rowCount = Math.max(1, mesh.rows);
  const columns = Math.max(1, mesh.colsPerCamera * mesh.cameraCount);
  const target = Math.max(0, Math.min(rowCount - 1, Math.round(requestedRow)));
  if (!mesh.validMask || mesh.validMask.length < rowCount * columns) return target;
  const observedCount = (row: number) => {
    let observed = 0;
    const start = row * columns;
    for (let column = 0; column < columns; column += 1) {
      if (Number(mesh.validMask?.[start + column]) !== 0) observed += 1;
    }
    return observed;
  };
  for (const minimumObserved of [Math.max(3, Math.floor(columns / 2)), 3]) {
    for (let offset = 0; offset < rowCount; offset += 1) {
      const after = target + offset;
      if (after < rowCount && observedCount(after) >= minimumObserved) return after;
      const before = target - offset;
      if (before >= 0 && before !== after && observedCount(before) >= minimumObserved) return before;
    }
  }
  return target;
}

function getDefectLengthPercent(defect: DefectItem, plateLengthM: number) {
  const lengthMm = plateLengthM > 0 ? plateLengthM * 1000 : DEFAULT_PLATE_LENGTH_M * 1000;
  const ratio = lengthMm > 0 ? defect.distanceHeadMm / lengthMm : defect.xRatio;
  return clampPercent((Number.isFinite(ratio) ? ratio : defect.xRatio) * 100);
}

function getDefectCircumferenceRatio(defect: DefectItem) {
  if (typeof defect.circumferenceRatio === 'number' && Number.isFinite(defect.circumferenceRatio)) {
    return Math.max(0, Math.min(0.999, defect.circumferenceRatio));
  }
  const span = defect.operatorSideMm + defect.driveSideMm;
  if (Number.isFinite(span) && span > 0) {
    return Math.max(0, Math.min(0.999, defect.operatorSideMm / span));
  }
  return Math.max(0, Math.min(0.999, (defect.yOffsetMm + 1.5) / 3));
}

function getDefectCameraIndex(defect: DefectItem, cameraCount = DEFAULT_CAMERA_LANES.length) {
  const explicitCamera = defect as DefectItem & { camera?: number; cameraName?: string };
  const explicitIndex = explicitCamera.cameraIndex ?? explicitCamera.camera;
  if (typeof explicitIndex === 'number' && Number.isFinite(explicitIndex) && explicitIndex >= 1 && explicitIndex <= cameraCount) {
    return Math.round(explicitIndex) - 1;
  }
  const parsed = String(explicitCamera.cameraId ?? explicitCamera.cameraName ?? '').match(/(?:camera|cam|相机)\s*(\d+)/i);
  if (parsed) {
    return Math.max(0, Math.min(cameraCount - 1, Number(parsed[1]) - 1));
  }
  return Math.min(cameraCount - 1, Math.floor(getDefectCircumferenceRatio(defect) * cameraCount));
}

function getDefectCameraLabel(defect: DefectItem, cameraLanes = DEFAULT_CAMERA_LANES) {
  return cameraLanes[getDefectCameraIndex(defect, cameraLanes.length)]?.cameraId ?? cameraLanes[0]?.cameraId ?? 'camera1';
}

function getDefectUnfoldedTopPercent(defect: DefectItem, cameraCount = DEFAULT_CAMERA_LANES.length) {
  const cameraIndex = getDefectCameraIndex(defect, cameraCount);
  const localRatio = getDefectCircumferenceRatio(defect) * cameraCount - cameraIndex;
  const safeLocalRatio = Math.max(0.14, Math.min(0.86, Number.isFinite(localRatio) ? localRatio : 0.5));
  return ((cameraIndex + safeLocalRatio) / cameraCount) * 100;
}

function yOffsetToPercentValue(offset: number) {
  return Math.max(10, Math.min(90, 50 - (offset / 1.5) * 37));
}

function yOffsetToPercent(offset: number) {
  return `${yOffsetToPercentValue(offset)}%`;
}

function getDefectSizeText(defect: Pick<DefectItem, 'widthMm' | 'heightMm' | 'depthMm'>) {
  return `${defect.widthMm.toFixed(2)} x ${defect.heightMm.toFixed(2)} x ${Math.abs(defect.depthMm).toFixed(2)}mm`;
}

function DefectMarker({
  defect,
  type,
  selected,
  onSelect,
  onHoverChange,
}: {
  defect: DefectItem;
  type: DefectType;
  selected: boolean;
  onSelect: () => void;
  onHoverChange: (defectId: string | null) => void;
}) {
  return (
    <button
      type="button"
      className={`defect-marker ${type.shape} ${selected ? 'selected' : ''}`}
      aria-label={`${defect.typeLabel}，${getDefectCameraLabel(defect)}，距头${defect.distanceHeadMm}mm`}
      style={{
        left: `${defect.xRatio * 100}%`,
        top: yOffsetToPercent(defect.yOffsetMm),
        backgroundColor: type.color,
      }}
      title={`${defect.typeLabel} ${getDefectCameraLabel(defect)} ${defect.distanceHeadMm}mm`}
      onClick={onSelect}
      onMouseEnter={() => onHoverChange(defect.id)}
      onMouseLeave={() => onHoverChange(null)}
      onFocus={() => onHoverChange(defect.id)}
      onBlur={() => onHoverChange(null)}
    />
  );
}

function DefectHoverCard({
  defect,
  type,
  xPercent,
  yPercent,
}: {
  defect: DefectItem;
  type: DefectType;
  xPercent?: number;
  yPercent?: number;
}) {
  const actualXPercent = xPercent ?? defect.xRatio * 100;
  const actualYPercent = yPercent ?? yOffsetToPercentValue(defect.yOffsetMm);
  const xPercentValue = clampPercent(actualXPercent, 0, 100);
  const yPercentValue = clampPercent(actualYPercent, 0, 100);
  const edgeClass = `${xPercentValue > 76 ? 'near-right' : xPercentValue < 24 ? 'near-left' : ''} ${yPercentValue < 44 ? 'near-top' : ''}`;

  return (
    <div
      className={`defect-hover-card ${edgeClass}`}
      role="tooltip"
      style={
        {
          left: `${xPercentValue}%`,
          top: `${yPercentValue}%`,
          '--defect-color': type.color,
        } as CSSProperties
      }
    >
      <div className="defect-hover-title">
        <i />
        <strong>{defect.typeLabel}</strong>
        {defect.synthetic ? <em className="synthetic-defect-badge">模拟</em> : null}
        <span>{defect.id}</span>
      </div>
      {defect.previewImageUrl ? (
        <div className="defect-hover-preview">
          <img src={defect.previewImageUrl} alt={`${defect.typeLabel}缺陷小图`} />
        </div>
      ) : null}
      <dl>
        <div>
          <dt>相机</dt>
          <dd>{getDefectCameraLabel(defect)}</dd>
        </div>
        <div>
          <dt>等级</dt>
          <dd className={defect.severity}>{severityLabels[defect.severity]}</dd>
        </div>
        <div>
          <dt>距头</dt>
          <dd>{defect.distanceHeadMm}mm</dd>
        </div>
        <div>
          <dt>深度</dt>
          <dd>{defect.depthMm.toFixed(2)}mm</dd>
        </div>
        <div>
          <dt>操作侧</dt>
          <dd>{defect.operatorSideMm}mm</dd>
        </div>
        <div>
          <dt>传动侧</dt>
          <dd>{defect.driveSideMm}mm</dd>
        </div>
        <div className="wide">
          <dt>尺寸</dt>
          <dd>{getDefectSizeText(defect)}</dd>
        </div>
      </dl>
    </div>
  );
}

function CameraBandImage({
  src,
  label,
  orientation,
  contentLabel = '实际裁剪图',
  cropBlackBorders = false,
  stableCropWindow,
  autoCropCameraId,
  onAutoCropDetected,
  loadDelayMs = 0,
}: {
  src: string;
  label: string;
  orientation: UnfoldOrientation;
  contentLabel?: string;
  cropBlackBorders?: boolean;
  stableCropWindow?: CameraBandCropWindow;
  autoCropCameraId?: string;
  onAutoCropDetected?: (cameraId: string, crop: CameraBandCropWindow) => void;
  loadDelayMs?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropWindowRef = useRef(stableCropWindow);
  const redrawRef = useRef<(() => void) | null>(null);

  cropWindowRef.current = stableCropWindow;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !src) {
      return;
    }
    canvas.dataset.renderState = 'loading';
    let disposed = false;
    let loadTimer: number | null = null;
    const image = new Image();
    const draw = () => {
      if (disposed || !image.complete || image.naturalWidth <= 0) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      // A processed JET panorama can span hundreds of history slots. Cap the
      // backing bitmap while retaining its CSS extent so WebView canvas limits
      // cannot blank an otherwise valid long strip.
      const rasterScale = Math.max(0.1, Math.min(dpr, 4096 / rect.width, 4096 / rect.height));
      canvas.width = Math.max(1, Math.round(rect.width * rasterScale));
      canvas.height = Math.max(1, Math.round(rect.height * rasterScale));
      const context = canvas.getContext('2d');
      if (!context) {
        return;
      }
      context.setTransform(rasterScale, 0, 0, rasterScale, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      context.globalAlpha = 1;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      let sourceX = 0;
      const sourceY = 0;
      let sourceWidth = image.naturalWidth;
      const sourceHeight = image.naturalHeight;
      if (cropBlackBorders) {
        try {
          const sample = document.createElement('canvas');
          sample.width = Math.min(256, image.naturalWidth);
          sample.height = Math.min(128, image.naturalHeight);
          const sampleContext = sample.getContext('2d', { willReadFrequently: true });
          if (sampleContext) {
            sampleContext.drawImage(image, 0, 0, sample.width, sample.height);
            const pixels = sampleContext.getImageData(0, 0, sample.width, sample.height).data;
            const brightRowsByColumn = new Uint16Array(sample.width);
            for (let y = 0; y < sample.height; y += 1) {
              for (let x = 0; x < sample.width; x += 1) {
                const offset = (y * sample.width + x) * 4;
                const luminance = Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
                if (luminance > 8) brightRowsByColumn[x] += 1;
              }
            }
            const minimumBrightRows = Math.max(2, Math.round(sample.height * 0.04));
            let minX = sample.width;
            let maxX = -1;
            brightRowsByColumn.forEach((brightRows, x) => {
              if (brightRows < minimumBrightRows) return;
              minX = Math.min(minX, x);
              maxX = Math.max(maxX, x);
            });
            if (maxX >= minX && maxX - minX + 1 >= sample.width * 0.04) {
              const paddingX = cameraBandCropPadding(maxX - minX + 1);
              minX = Math.max(0, minX - paddingX);
              maxX = Math.min(sample.width - 1, maxX + paddingX);
              if (autoCropCameraId) {
                onAutoCropDetected?.(autoCropCameraId, {
                  left: minX / sample.width,
                  right: (maxX + 1) / sample.width,
                });
              }
            }
          }
        } catch {
          // Cross-origin images can disallow pixel reads. The full production
          // frame remains usable in that case instead of hiding the lane.
        }
      }
      const cropWindow = cropBlackBorders ? cropWindowRef.current : undefined;
      if (cropWindow && cropWindow.right - cropWindow.left >= 0.04) {
        // Source Y is the acquisition/progress axis and must remain untouched.
        // Sharing one source-X window across a camera lane prevents the
        // rotated frames from acquiring independent vertical offsets.
        sourceX = cropWindow.left * image.naturalWidth;
        sourceWidth = (cropWindow.right - cropWindow.left) * image.naturalWidth;
        canvas.dataset.cropLeft = cropWindow.left.toFixed(6);
        canvas.dataset.cropRight = cropWindow.right.toFixed(6);
      } else {
        delete canvas.dataset.cropLeft;
        delete canvas.dataset.cropRight;
      }
      const rotation = cameraBandRotationRadians(orientation);
      if (rotation !== 0) {
        context.translate(0, rect.height);
        context.rotate(rotation);
        context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, rect.height, rect.width);
      } else {
        context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, rect.width, rect.height);
      }
      canvas.dataset.renderState = 'ready';
    };
    redrawRef.current = draw;
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.fetchPriority = loadDelayMs > 0 ? 'low' : 'high';
    image.onload = draw;
    image.onerror = () => {
      if (!disposed) canvas.dataset.renderState = 'error';
    };
    if (loadDelayMs > 0) {
      loadTimer = window.setTimeout(() => {
        loadTimer = null;
        if (!disposed) image.src = src;
      }, loadDelayMs);
    } else {
      image.src = src;
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
    observer?.observe(canvas);
    return () => {
      disposed = true;
      if (loadTimer !== null) window.clearTimeout(loadTimer);
      observer?.disconnect();
      redrawRef.current = null;
      image.onload = null;
      image.onerror = null;
      if (typeof image.removeAttribute === 'function') image.removeAttribute('src');
    };
  }, [autoCropCameraId, cropBlackBorders, loadDelayMs, onAutoCropDetected, orientation, src]);

  useEffect(() => {
    redrawRef.current?.();
  }, [stableCropWindow?.left, stableCropWindow?.right]);

  return <canvas
    ref={canvasRef}
    className="bar-camera-band-image"
    aria-label={`${label} ${contentLabel}`}
    data-edge-policy={cropBlackBorders ? 'stable-source-crop' : 'source-roi'}
    data-load-priority={loadDelayMs > 0 ? 'deferred' : 'high'}
  />;
}

function captureImageCameraName(image: CaptureImageItem) {
  for (const value of [image.cameraId, image.cameraIp, image.path]) {
    const identity = value.match(/(?:^|[\\/])(?:camera|camimagesource|c)[-_ ]?(\d+)(?:[\\/]|$)/i)
      ?? value.match(/^(?:camera|camimagesource|c)[-_ ]?(\d+)$/i);
    if (identity) return `camera${Number(identity[1])}`;
  }
  const legacyIpMatch = image.cameraIp.match(/\.10(\d)\./);
  return legacyIpMatch ? `camera${Number(legacyIpMatch[1])}` : '';
}

function cameraIdentityNumber(value: string) {
  const match = value.match(/(?:camera|camimagesource|cam|c|相机)[-_ ]?(\d+)/i);
  return match ? Number(match[1]) : null;
}

type CaptureHeadAlignment = NonNullable<CaptureFlowSurface['headAlignment']>;
type CaptureHeadAlignmentCamera = NonNullable<CaptureHeadAlignment['cameras']>[string];

function headAlignmentCamera(
  alignment: CaptureFlowSurface['headAlignment'] | null | undefined,
  cameraId: string,
): CaptureHeadAlignmentCamera | undefined {
  const target = cameraIdentityNumber(cameraId);
  if (target === null) return undefined;
  return Object.entries(alignment?.cameras ?? {}).find(
    ([candidate]) => cameraIdentityNumber(candidate) === target,
  )?.[1];
}

function signedFrameOffset(value: number) {
  if (Math.abs(value) < 0.0005) return '参考头';
  return `头偏移 ${value > 0 ? '+' : ''}${value.toFixed(2)} 帧`;
}

function BarUnfoldedMap({
  defects,
  defectTypes,
  selectedDefectId,
  hoveredDefectId,
  previewPositionM,
  plateLengthM,
  onPreviewPositionChange,
  onSelectDefect,
  onHoverDefect,
  onDefectNavigationKeyDown,
  onDefectNavigationWheel,
  orientation,
  surfaceCameras,
  captureImages,
  captureFrames = [],
  stitchKey = '',
  cameraLanes,
  imageMode = 'gray',
  cameraTiles,
  headAlignment,
  cropBlackBorders = false,
}: {
  defects: DefectItem[];
  defectTypes: DefectType[];
  selectedDefectId: string | null;
  hoveredDefectId: string | null;
  previewPositionM: number;
  plateLengthM: number;
  onPreviewPositionChange: (positionM: number) => void;
  onSelectDefect: (defectId: string) => void;
  onHoverDefect: (defectId: string | null) => void;
  onDefectNavigationKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onDefectNavigationWheel: (event: WheelEvent<HTMLDivElement>) => void;
  orientation: UnfoldOrientation;
  surfaceCameras: BarSurfaceCamera[];
  captureImages: CaptureImageItem[];
  captureFrames?: CaptureStitchFrame[];
  stitchKey?: string;
  cameraLanes: CameraDisplayLane[];
  imageMode?: Plate2DDisplayMode;
  cameraTiles?: CaptureSurfaceCameraTiles | null;
  headAlignment?: CaptureFlowSurface['headAlignment'] | null;
  cropBlackBorders?: boolean;
}) {
  const FRAME_SPAN_PX = 176;
  const FRAME_OVERSCAN = 3;
  const [expandedCamera, setExpandedCamera] = useState<string | null>(null);
  const [autoCropWindows, setAutoCropWindows] = useState<Record<string, CameraBandCropWindow>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollProgressRef = useRef(0);
  const atTailRef = useRef(false);
  const previousLayoutRef = useRef({
    orientation,
    stitchKey,
    frameCount: captureFrames.length,
    alignmentKey: '',
  });
  const [scrollWindow, setScrollWindow] = useState({ offset: 0, extent: 1, total: 1 });
  const previewPercent = (clampPreviewPositionM(previewPositionM, plateLengthM) / plateLengthM) * 100;
  const hoveredDefect = defects.find((defect) => defect.id === hoveredDefectId) ?? null;
  const hoveredType = hoveredDefect ? defectTypes.find((type) => type.id === hoveredDefect.typeId) : null;
  const hoveredXPercent = hoveredDefect ? getDefectLengthPercent(hoveredDefect, plateLengthM) : 0;
  const hoveredYPercent = hoveredDefect ? getDefectUnfoldedTopPercent(hoveredDefect, cameraLanes.length) : 0;
  const captureImageByCamera = useMemo(() => {
    const images = new Map<string, CaptureImageItem>();
    captureImages
      .filter((image) => image.dataName.toLowerCase() === 'intensity')
      .forEach((image) => {
        const cameraName = captureImageCameraName(image);
        if (!cameraName) return;
        const current = images.get(cameraName);
        if (!current || image.sequenceNo > current.sequenceNo) images.set(cameraName, image);
      });
    return images;
  }, [captureImages]);
  const stitchEnabled = captureFrames.length > 0;
  const displayHeadAlignmentApplied = Boolean(
    imageMode === 'gray'
    && stitchEnabled
    && headAlignment?.displayAligned
    && cameraLanes.every((lane) => {
      const padding = headAlignmentCamera(
        headAlignment,
        lane.cameraId,
      )?.displayPaddingFrames;
      return typeof padding === 'number' && Number.isFinite(padding);
    }),
  );
  const maximumHeadPaddingFrames = displayHeadAlignmentApplied
    ? Math.max(
      0,
      ...cameraLanes.map((lane) => Number(
        headAlignmentCamera(headAlignment, lane.cameraId)?.displayPaddingFrames ?? 0,
      )),
    )
    : 0;
  const alignmentKey = displayHeadAlignmentApplied
    ? `${headAlignment?.alignedTimelinePositionFrames ?? ''}:${maximumHeadPaddingFrames}`
    : '';
  const longitudinalExtent = Math.max(
    FRAME_SPAN_PX,
    (captureFrames.length + maximumHeadPaddingFrames) * FRAME_SPAN_PX,
  );
  const firstVisibleFrame = stitchEnabled
    ? Math.max(
      0,
      Math.floor(scrollWindow.offset / FRAME_SPAN_PX - maximumHeadPaddingFrames)
      - FRAME_OVERSCAN,
    )
    : 0;
  const lastVisibleFrame = stitchEnabled
    ? Math.min(
      captureFrames.length,
      Math.ceil((scrollWindow.offset + scrollWindow.extent) / FRAME_SPAN_PX) + FRAME_OVERSCAN,
    )
    : 0;
  const visibleCaptureFrames = stitchEnabled
    ? captureFrames.slice(firstVisibleFrame, lastVisibleFrame)
    : [];
  const detectedContentAnchorFrame = captureStitchInitialFrameIndex(
    captureFrames,
    cameraLanes.length,
  );
  const alignedTimelinePosition = Number(headAlignment?.alignedTimelinePositionFrames);
  const firstCaptureSequence = Number(captureFrames[0]?.sequence);
  const contentAnchorFrame = displayHeadAlignmentApplied
    && Number.isFinite(alignedTimelinePosition)
    && Number.isFinite(firstCaptureSequence)
    ? Math.max(0, alignedTimelinePosition - firstCaptureSequence)
    : detectedContentAnchorFrame;
  const priorityFrameIndex = stitchEnabled
    ? Math.max(
      firstVisibleFrame,
      Math.min(
        Math.max(firstVisibleFrame, lastVisibleFrame - 1),
        Math.floor((scrollWindow.offset + scrollWindow.extent / 2) / FRAME_SPAN_PX),
      ),
    )
    : 0;
  const scrollSpaceStyle: CSSProperties = stitchEnabled
    ? orientation === 'horizontal'
      ? { width: `max(100%, ${longitudinalExtent}px)`, height: '100%' }
      : { width: '100%', height: `max(100%, ${longitudinalExtent}px)` }
    : { width: '100%', height: '100%' };

  const reportAutoCrop = useCallback((cameraId: string, crop: CameraBandCropWindow) => {
    setAutoCropWindows((current) => {
      const merged = mergeCameraBandCropWindow(current[cameraId], crop);
      if (!merged || merged === current[cameraId]) return current;
      return { ...current, [cameraId]: merged };
    });
  }, []);

  useEffect(() => {
    setAutoCropWindows({});
  }, [stitchKey]);

  const readScrollPosition = () => {
    const host = scrollRef.current;
    if (!host) return;
    const offset = orientation === 'horizontal' ? host.scrollLeft : host.scrollTop;
    const extent = orientation === 'horizontal' ? host.clientWidth : host.clientHeight;
    const scrollExtent = orientation === 'horizontal' ? host.scrollWidth : host.scrollHeight;
    const maximum = Math.max(0, scrollExtent - extent);
    scrollProgressRef.current = maximum > 0 ? offset / maximum : 0;
    atTailRef.current = maximum <= 0 || maximum - offset <= Math.max(24, extent * 0.08);
    const nextExtent = Math.max(1, extent);
    const total = Math.max(nextExtent, scrollExtent, longitudinalExtent);
    setScrollWindow((current) => current.offset === offset && current.extent === nextExtent && current.total === total
      ? current
      : { offset, extent: nextExtent, total });
  };

  const scrollToProgress = (progress: number) => {
    const host = scrollRef.current;
    if (!host) return;
    const extent = orientation === 'horizontal' ? host.clientWidth : host.clientHeight;
    const scrollExtent = orientation === 'horizontal' ? host.scrollWidth : host.scrollHeight;
    const maximum = Math.max(0, Math.max(scrollExtent, longitudinalExtent) - extent);
    const target = clampUnit(progress) * maximum;
    if (orientation === 'horizontal') {
      host.scrollLeft = target;
    } else {
      host.scrollTop = target;
    }
    readScrollPosition();
  };

  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return undefined;
    const update = () => readScrollPosition();
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(host);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  // The scroll reader intentionally follows the active orientation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orientation, stitchEnabled]);

  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const previous = previousLayoutRef.current;
    const recordChanged = previous.stitchKey !== stitchKey;
    const orientationChanged = previous.orientation !== orientation;
    const alignmentChanged = previous.alignmentKey !== alignmentKey;
    const recordContentBecameReady = previous.frameCount === 0 && captureFrames.length > 0;
    const appendedAtTail = !recordChanged
      && previous.frameCount > 0
      && captureFrames.length > previous.frameCount
      && atTailRef.current;
    const retainedProgress = recordChanged || alignmentChanged ? 0 : scrollProgressRef.current;
    previousLayoutRef.current = {
      orientation,
      stitchKey,
      frameCount: captureFrames.length,
      alignmentKey,
    };
    const frame = window.requestAnimationFrame(() => {
      const extent = orientation === 'horizontal' ? host.clientWidth : host.clientHeight;
      const scrollExtent = orientation === 'horizontal' ? host.scrollWidth : host.scrollHeight;
      const maximum = Math.max(0, scrollExtent - extent);
      const target = appendedAtTail
        ? maximum
        : recordChanged || recordContentBecameReady || alignmentChanged
          ? Math.min(maximum, contentAnchorFrame * FRAME_SPAN_PX)
          : maximum * retainedProgress;
      if (orientation === 'horizontal') {
        host.scrollTop = 0;
        host.scrollLeft = target;
      } else {
        host.scrollLeft = 0;
        host.scrollTop = target;
      }
      if (orientationChanged || recordChanged || recordContentBecameReady || alignmentChanged || appendedAtTail) readScrollPosition();
    });
    return () => window.cancelAnimationFrame(frame);
  // readScrollPosition is deliberately kept local so it always uses the
  // orientation committed by this render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alignmentKey, captureFrames.length, contentAnchorFrame, orientation, stitchKey]);

  const handleMapWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!stitchEnabled) {
      onDefectNavigationWheel(event);
      return;
    }
    if (orientation !== 'horizontal' || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const host = scrollRef.current;
    if (!host) return;
    event.preventDefault();
    host.scrollLeft += event.deltaY;
    readScrollPosition();
  };

  return (
    <div className={`bar-unfolded-map orientation-${orientation} ${expandedCamera ? 'camera-expanded' : ''}`} data-testid="bar-unfolded-map" data-orientation={orientation} data-expanded-camera={expandedCamera || undefined} style={{ '--camera-count': cameraLanes.length } as CSSProperties}>
      <div
        ref={scrollRef}
        className={`bar-unfolded-canvas ${stitchEnabled ? 'has-stitch' : ''}`}
        role="region"
        tabIndex={0}
        aria-label={`${cameraLanes.length} 相机圆周展开缺陷图`}
        data-testid="capture-stitch-viewport"
        data-scroll-axis={stitchEnabled ? orientation === 'horizontal' ? 'x' : 'y' : 'none'}
        data-frame-count={captureFrames.length}
        data-content-anchor-frame={contentAnchorFrame}
        data-head-aligned={headAlignment?.displayAligned ? 'true' : 'false'}
        data-head-display-padding-applied={displayHeadAlignmentApplied ? 'true' : 'false'}
        data-head-spread-frames={headAlignment?.timelineSpreadFrames ?? undefined}
        data-visible-frame-start={firstVisibleFrame}
        data-visible-frame-end={lastVisibleFrame}
        style={{ '--preview-position': `${previewPercent}%` } as CSSProperties}
        onKeyDown={onDefectNavigationKeyDown}
        onScroll={readScrollPosition}
        onWheel={handleMapWheel}
      >
        <div className="bar-unfolded-scroll-space" style={scrollSpaceStyle}>
        <div className="bar-camera-bands">
          {cameraLanes.map((lane) => {
            const camera = surfaceCameras.find((item) => item.name.toLowerCase() === lane.cameraId);
            const preview = camera?.relative.intensityPreview || camera?.latest.intensityPreview || '';
            const captureImage = captureImageByCamera.get(lane.cameraId);
            const laneNumber = cameraIdentityNumber(lane.cameraId) ?? cameraIdentityNumber(lane.shortLabel);
            const jetTile = cameraTiles?.cameras.find((tile) => cameraIdentityNumber(tile.cameraId) === laneNumber);
            const jetImagePath = jetTile?.state === 'ready' ? jetTile.jet?.imagePath?.trim() : '';
            const source = imageMode === 'jet'
              ? jetImagePath ? captureArtifactImageUrl(jetImagePath, 2048) : ''
              : stitchEnabled ? '' : preview ? barSurfaceFileUrl(preview) : captureImage?.url || '';
            const expanded = expandedCamera === lane.cameraId;
            const stableCropWindow = autoCropWindows[lane.cameraId];
            const cameraHead = headAlignmentCamera(headAlignment, lane.cameraId);
            const headOffsetFrames = Number(cameraHead?.offsetFramesFromReference);
            const displayPaddingFrames = displayHeadAlignmentApplied
              ? Math.max(0, Number(cameraHead?.displayPaddingFrames ?? 0))
              : 0;
            const alignmentLabel = cameraHead?.displayAligned
              && Number.isFinite(headOffsetFrames)
              ? `${signedFrameOffset(headOffsetFrames)} · 已对齐`
              : '';
            return <div
              key={lane.cameraId}
              className={`bar-camera-band ${source ? 'has-production-image' : ''} ${expanded ? 'is-expanded' : ''} ${expandedCamera && !expanded ? 'is-collapsed' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`${lane.cameraId} 采集图像${expanded ? '，已展开，双击恢复' : '，双击展开'}`}
              title={`${expanded ? `双击恢复 ${cameraLanes.length} 相机展开图` : `双击展开 ${lane.cameraId}；悬停查看采集轮廓`}${alignmentLabel ? `；${alignmentLabel}` : ''}`}
              data-head-offset-frames={Number.isFinite(headOffsetFrames) ? headOffsetFrames.toFixed(6) : undefined}
              data-head-display-padding-frames={cameraHead?.displayAligned ? Number(cameraHead.displayPaddingFrames ?? 0).toFixed(6) : undefined}
              data-head-aligned={cameraHead?.displayAligned ? 'true' : 'false'}
              onDoubleClick={() => setExpandedCamera((current) => current === lane.cameraId ? null : lane.cameraId)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setExpandedCamera((current) => current === lane.cameraId ? null : lane.cameraId);
                }
              }}
            >
              {source ? <CameraBandImage
                src={source}
                label={lane.cameraId}
                orientation={orientation}
                contentLabel={imageMode === 'jet' ? '处理后 JET 图' : '实际裁剪图'}
                cropBlackBorders={imageMode === 'gray' && cropBlackBorders}
              /> : null}
              {imageMode === 'gray' && stitchEnabled ? (
                <div className="bar-camera-band-strip" aria-label={`${lane.shortLabel} 裁剪拼接帧`}>
                  {visibleCaptureFrames.map((frame, visibleIndex) => {
                    const frameIndex = firstVisibleFrame + visibleIndex;
                    const cameraFrame = frame.cameras.find((item) => (
                      cameraIdentityNumber(item.cameraId) === laneNumber
                    ));
                    return <div
                      key={`${frame.frameId}:${lane.cameraId}`}
                      className={`bar-camera-frame ${cameraFrame ? 'has-production-image' : 'is-missing'}`}
                      data-frame-sequence={frame.sequence}
                      data-camera-id={lane.shortLabel}
                      style={orientation === 'horizontal'
                        ? { left: (frameIndex + displayPaddingFrames) * FRAME_SPAN_PX, width: FRAME_SPAN_PX }
                        : { top: (frameIndex + displayPaddingFrames) * FRAME_SPAN_PX, height: FRAME_SPAN_PX }}
                    >
                      {cameraFrame ? <CameraBandImage
                        src={cameraFrame.url}
                        label={`${lane.shortLabel} 第 ${frame.sequence} 轮`}
                        orientation={orientation}
                        contentLabel={cameraFrame.cropMode === 'algorithm-roi' ? '算法 ROI 裁剪图' : '自动裁黑边图'}
                        cropBlackBorders={cameraFrame.cropMode === 'auto-black-border'}
                        stableCropWindow={cameraFrame.cropMode === 'auto-black-border' ? stableCropWindow : undefined}
                        autoCropCameraId={cameraFrame.cropMode === 'auto-black-border' ? lane.cameraId : undefined}
                        onAutoCropDetected={reportAutoCrop}
                        loadDelayMs={frameIndex === priorityFrameIndex ? 0 : 250}
                      /> : <small>缺帧</small>}
                    </div>;
                  })}
                </div>
              ) : null}
              <span>{lane.shortLabel}{alignmentLabel ? ` · ${alignmentLabel}` : ''}</span>
            </div>;
          })}
        </div>
        <span className="bar-unfolded-note bar-unfolded-note-start">进钢</span>
        <span className="bar-unfolded-note bar-unfolded-note-end">出钢</span>
        <div className="bar-unfolded-centerline" aria-hidden="true" />
        <div
          className={`strip-preview-cursor bar-unfolded-preview-cursor ${previewPercent > 82 ? 'near-end' : ''}`}
          data-testid="preview-cursor-unfolded"
          aria-hidden="true"
          style={orientation === 'horizontal' ? { left: `${previewPercent}%` } : { top: `${previewPercent}%` }}
        >
          <span>{clampPreviewPositionM(previewPositionM, plateLengthM).toFixed(2)}m</span>
        </div>
        {defects.map((defect) => {
          const type = defectTypes.find((item) => item.id === defect.typeId);
          if (!type) return null;
          return (
            <button
              key={defect.id}
              type="button"
              className={`defect-marker ${type.shape} ${defect.id === selectedDefectId ? 'selected' : ''}`}
              aria-label={`${defect.typeLabel}，${getDefectCameraLabel(defect, cameraLanes)}，距头${defect.distanceHeadMm}mm`}
              style={{
                left: `${orientation === 'horizontal' ? getDefectLengthPercent(defect, plateLengthM) : getDefectUnfoldedTopPercent(defect, cameraLanes.length)}%`,
                top: `${orientation === 'horizontal' ? getDefectUnfoldedTopPercent(defect, cameraLanes.length) : getDefectLengthPercent(defect, plateLengthM)}%`,
                backgroundColor: type.color,
              }}
              title={`${defect.typeLabel} ${getDefectCameraLabel(defect, cameraLanes)} ${defect.distanceHeadMm}mm`}
              onClick={() => onSelectDefect(defect.id)}
              onMouseEnter={() => onHoverDefect(defect.id)}
              onMouseLeave={() => onHoverDefect(null)}
              onFocus={() => onHoverDefect(defect.id)}
              onBlur={() => onHoverDefect(null)}
            />
          );
        })}
        {hoveredDefect && hoveredType ? (
          <DefectHoverCard
            defect={hoveredDefect}
            type={hoveredType}
            xPercent={orientation === 'horizontal' ? hoveredXPercent : hoveredYPercent}
            yPercent={orientation === 'horizontal' ? hoveredYPercent : hoveredXPercent}
          />
        ) : null}
        </div>
      </div>
      <LengthRuler
        previewPositionM={previewPositionM}
        plateLengthM={plateLengthM}
        onPreviewPositionChange={onPreviewPositionChange}
        orientation={orientation}
        scrollMetrics={stitchEnabled ? scrollWindow : undefined}
        onScrollProgressChange={scrollToProgress}
      />
    </div>
  );
}

function LengthRuler({
  previewPositionM,
  plateLengthM,
  onPreviewPositionChange,
  orientation,
  scrollMetrics,
  onScrollProgressChange,
}: {
  previewPositionM: number;
  plateLengthM: number;
  onPreviewPositionChange: (positionM: number) => void;
  orientation: UnfoldOrientation;
  scrollMetrics?: { offset: number; extent: number; total: number };
  onScrollProgressChange?: (progress: number) => void;
}) {
  const activePointerId = useRef<number | null>(null);
  const mouseDragging = useRef(false);
  const scrollDrag = useRef<{ pointerId: number; grabOffsetRatio: number } | null>(null);
  const safePlateLengthM = plateLengthM > 0 ? plateLengthM : DEFAULT_PLATE_LENGTH_M;
  const safePositionM = clampPreviewPositionM(previewPositionM, safePlateLengthM);
  const previewPercent = (safePositionM / safePlateLengthM) * 100;
  const visibleFraction = scrollMetrics
    ? clampUnit(scrollMetrics.extent / Math.max(scrollMetrics.total, 1))
    : 1;
  const maximumScrollOffset = scrollMetrics
    ? Math.max(0, scrollMetrics.total - scrollMetrics.extent)
    : 0;
  const scrollProgress = maximumScrollOffset > 0 && scrollMetrics
    ? clampUnit(scrollMetrics.offset / maximumScrollOffset)
    : 0;
  const scrollStartRatio = scrollProgress * (1 - visibleFraction);
  const scrollEnabled = Boolean(scrollMetrics && maximumScrollOffset > 1 && onScrollProgressChange);

  const updateFromPointer = (clientX: number, clientY: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const extent = orientation === 'horizontal' ? rect.width : rect.height;
    if (extent <= 0) {
      return;
    }
    const ratio = orientation === 'horizontal' ? (clientX - rect.left) / rect.width : (clientY - rect.top) / rect.height;
    const nextPositionM = clampPreviewPositionM(Number((ratio * safePlateLengthM).toFixed(2)), safePlateLengthM);
    onPreviewPositionChange(nextPositionM);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    activePointerId.current = event.pointerId;
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    updateFromPointer(event.clientX, event.clientY, event.currentTarget);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointerId.current !== event.pointerId) {
      return;
    }
    updateFromPointer(event.clientX, event.clientY, event.currentTarget);
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
    updateFromPointer(event.clientX, event.clientY, event.currentTarget);
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!mouseDragging.current || activePointerId.current !== null) {
      return;
    }
    updateFromPointer(event.clientX, event.clientY, event.currentTarget);
  };

  const stopMouseDragging = () => {
    mouseDragging.current = false;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 1 : 0.1;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      onPreviewPositionChange(clampPreviewPositionM(Number((safePositionM - step).toFixed(2)), safePlateLengthM));
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
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

  const updateScrollFromPointer = (clientX: number, clientY: number, element: HTMLElement) => {
    if (!scrollEnabled || !onScrollProgressChange || !scrollDrag.current) return;
    const rect = element.getBoundingClientRect();
    const extent = orientation === 'horizontal' ? rect.width : rect.height;
    if (extent <= 0) return;
    const pointerRatio = clampUnit(
      orientation === 'horizontal'
        ? (clientX - rect.left) / rect.width
        : (clientY - rect.top) / rect.height,
    );
    const availableTrack = Math.max(0.0001, 1 - visibleFraction);
    const nextStartRatio = Math.max(
      0,
      Math.min(availableTrack, pointerRatio - scrollDrag.current.grabOffsetRatio),
    );
    onScrollProgressChange(nextStartRatio / availableTrack);
  };

  const handleScrollPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!scrollEnabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerRatio = clampUnit(
      orientation === 'horizontal'
        ? (event.clientX - rect.left) / Math.max(1, rect.width)
        : (event.clientY - rect.top) / Math.max(1, rect.height),
    );
    const thumb = (event.target as HTMLElement).closest('.ruler-scrollbar-thumb');
    scrollDrag.current = {
      pointerId: event.pointerId,
      grabOffsetRatio: thumb
        ? Math.max(0, Math.min(visibleFraction, pointerRatio - scrollStartRatio))
        : visibleFraction / 2,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateScrollFromPointer(event.clientX, event.clientY, event.currentTarget);
  };

  const handleScrollPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (scrollDrag.current?.pointerId !== event.pointerId) return;
    updateScrollFromPointer(event.clientX, event.clientY, event.currentTarget);
  };

  const stopScrollDragging = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (scrollDrag.current?.pointerId !== event.pointerId) return;
    scrollDrag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleScrollKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (!scrollEnabled || !onScrollProgressChange) return;
    const step = event.shiftKey ? 0.2 : 0.05;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      onScrollProgressChange(clampUnit(scrollProgress - step));
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      onScrollProgressChange(clampUnit(scrollProgress + step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onScrollProgressChange(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      onScrollProgressChange(1);
    }
  };

  return (
    <div
      className={`length-ruler orientation-${orientation}`}
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
          style={orientation === 'horizontal'
            ? (meter === 12 ? { right: 0 } : { left: `${(meter / 12) * 100}%` })
            : (meter === 12 ? { bottom: 0 } : { top: `${(meter / 12) * 100}%` })}
        >
          {meter}m
        </span>
      ))}
      <div
        className={`ruler-preview-position ${previewPercent > 82 ? 'near-end' : ''}`}
        style={orientation === 'horizontal' ? { left: `${previewPercent}%` } : { top: `${previewPercent}%` }}
      >
        <span className="ruler-preview-label">{safePositionM.toFixed(2)}m</span>
      </div>
      {scrollMetrics ? (
        <div
          className={`ruler-scrollbar ${scrollEnabled ? '' : 'is-disabled'}`.trim()}
          role="scrollbar"
          tabIndex={scrollEnabled ? 0 : -1}
          aria-label="展开图滚动位置"
          aria-orientation={orientation}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(scrollProgress * 100)}
          aria-valuetext={scrollEnabled ? `已滚动 ${Math.round(scrollProgress * 100)}%` : '已显示全部图像'}
          aria-disabled={!scrollEnabled}
          onPointerDown={handleScrollPointerDown}
          onPointerMove={handleScrollPointerMove}
          onPointerUp={stopScrollDragging}
          onPointerCancel={stopScrollDragging}
          onKeyDown={handleScrollKeyDown}
        >
          <i className="ruler-scrollbar-track" />
          <b
            className="ruler-scrollbar-thumb"
            style={orientation === 'horizontal'
              ? { left: `${scrollStartRatio * 100}%`, width: `${visibleFraction * 100}%` }
              : { top: `${scrollStartRatio * 100}%`, height: `${visibleFraction * 100}%` }}
          />
        </div>
      ) : null}
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
    <div className="surface-mode-switch" role="group" aria-label="相机区显示切换">
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
  onViewModeChange,
}: {
  viewMode: PlateMapViewMode;
  onViewModeChange: (viewMode: PlateMapViewMode) => void;
}) {
  return (
    <div className="plate-map-actions">
      <ViewModeSwitch value={viewMode} onChange={onViewModeChange} />
    </div>
  );
}

function PlateDisplaySubModes({
  viewMode,
  threeMode,
  twoDMode,
  artifactOrientation,
  onThreeModeChange,
  onTwoDModeChange,
  onArtifactOrientationChange,
}: {
  viewMode: PlateMapViewMode;
  threeMode: Plate3DDisplayMode;
  twoDMode: Plate2DDisplayMode;
  artifactOrientation: ArtifactOrientation;
  onThreeModeChange: (mode: Plate3DDisplayMode) => void;
  onTwoDModeChange: (mode: Plate2DDisplayMode) => void;
  onArtifactOrientationChange: (orientation: ArtifactOrientation) => void;
}) {
  if (viewMode === '3d') {
    const options: Array<{ id: Plate3DDisplayMode; label: string }> = [
      { id: 'surface', label: '表面' },
      { id: 'points', label: '点云' },
      { id: 'texture', label: '贴图' },
      { id: 'jet', label: 'Jet' },
    ];
    return (
      <>
        <div className="plate-display-submodes" role="group" aria-label="3D 显示子模式">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={threeMode === option.id ? `active ${option.id}` : option.id}
              aria-pressed={threeMode === option.id}
              onClick={() => onThreeModeChange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="artifact-orientation-switch" role="group" aria-label="3D 管轴方向">
          <button
            type="button"
            className={artifactOrientation === 'horizontal' ? 'active' : ''}
            aria-pressed={artifactOrientation === 'horizontal'}
            onClick={() => onArtifactOrientationChange('horizontal')}
          >
            横向
          </button>
          <button
            type="button"
            className={artifactOrientation === 'vertical' ? 'active' : ''}
            aria-pressed={artifactOrientation === 'vertical'}
            onClick={() => onArtifactOrientationChange('vertical')}
          >
            纵向
          </button>
        </div>
      </>
    );
  }
  if (viewMode === '2d') {
    return (
      <div className="plate-display-submodes" role="group" aria-label="2D 显示子模式">
        <button type="button" className={twoDMode === 'gray' ? 'active' : ''} aria-pressed={twoDMode === 'gray'} onClick={() => onTwoDModeChange('gray')}>灰度平铺</button>
        <button type="button" className={twoDMode === 'jet' ? 'active jet' : 'jet'} aria-pressed={twoDMode === 'jet'} onClick={() => onTwoDModeChange('jet')}>Jet 平铺</button>
      </div>
    );
  }
  return null;
}

export function PlateMapToolbar({
  defectTypes,
  defectTypeCounts,
  hiddenTypeIds,
  viewMode,
  showViewSwitch = true,
  onToggleType,
  onViewModeChange,
}: {
  defectTypes: DefectType[];
  defectTypeCounts: Record<string, number>;
  hiddenTypeIds: Set<string>;
  viewMode: PlateMapViewMode;
  showViewSwitch?: boolean;
  onToggleType: (typeId: string) => void;
  onViewModeChange: (viewMode: PlateMapViewMode) => void;
}) {
  return (
    <div className="plate-map-toolbar" aria-label="棒材圆周展开缺陷图工具栏">
      <strong className="plate-map-toolbar-title">棒材圆周展开缺陷图</strong>
      <div className="defect-legend plate-map-toolbar-legend">
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
      {showViewSwitch ? <PlateMapActions viewMode={viewMode} onViewModeChange={onViewModeChange} /> : null}
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

function PointCloudHeatDefect({
  defect,
  type,
  selected,
}: {
  defect: DefectItem;
  type: DefectType | undefined;
  selected: boolean;
}) {
  const xPercent = Math.max(2, Math.min(98, defect.xRatio * 100));
  const yPercent = yOffsetToPercentValue(defect.yOffsetMm);
  const hot = Math.abs(defect.depthMm) >= 0.1 || defect.severity === 'severe';

  return (
    <>
      <span
        className={`point-cloud-heat-blob ${hot ? 'hot' : 'cool'}`}
        style={
          {
            left: `${xPercent}%`,
            top: `${yPercent}%`,
            '--defect-color': type?.color ?? '#ff3f47',
          } as CSSProperties
        }
      />
      <button
        type="button"
        className={`point-cloud-defect-label ${selected ? 'selected' : ''}`}
        style={
          {
            left: `${Math.min(88, xPercent + 1.5)}%`,
            top: `${Math.max(8, yPercent - 16)}%`,
            '--defect-color': type?.color ?? '#ff3f47',
          } as CSSProperties
        }
        aria-label={`${defect.typeLabel}点云标注，${surfaceLabels[defect.surface]}，距头${defect.distanceHeadMm}mm`}
        title={`${defect.typeLabel} ${surfaceLabels[defect.surface]} ${defect.distanceHeadMm}mm`}
      >
        <span>{defect.id.replace(/^D-/, '').slice(0, 5)}</span>
        <b />
      </button>
    </>
  );
}

function PointCloudSurfaceStrip({
  surface,
  defects,
  defectTypes,
  selectedDefectId,
  previewPositionM,
  plateLengthM,
}: {
  surface: 'top' | 'bottom';
  defects: DefectItem[];
  defectTypes: DefectType[];
  selectedDefectId: string | null;
  previewPositionM: number;
  plateLengthM: number;
}) {
  const surfaceDefects = defects.filter((defect) => defect.surface === surface);
  const previewPercent = (clampPreviewPositionM(previewPositionM, plateLengthM) / plateLengthM) * 100;
  const title = surface === 'top' ? '1-3号相机 3D 高度展开图' : '4-6号相机 3D 高度展开图';
  const heightMapImage = surface === 'top' ? heightMapTopImage : heightMapBottomImage;

  return (
    <div className="point-cloud-unfold-row">
      <div className="point-cloud-unfold-title">
        <strong>{title}</strong>
        <span>单位：mm</span>
      </div>
      <div className="point-cloud-unfold-axis" aria-hidden="true">
        {[1125, 750, 375, 0].map((tick) => (
          <span key={tick}>{tick}</span>
        ))}
      </div>
      <div
        className="point-cloud-unfold-map"
        role="img"
        aria-label={`${surfaceLabels[surface]}点云高度展开图`}
        style={{ '--point-cloud-surface-image': `url(${heightMapImage})` } as CSSProperties}
      >
        <div className="point-cloud-texture" />
        <span className="point-cloud-preview-line" style={{ left: `${previewPercent}%` }} />
        {surfaceDefects.map((defect) => (
          <PointCloudHeatDefect
            key={defect.id}
            defect={defect}
            type={defectTypes.find((item) => item.id === defect.typeId)}
            selected={defect.id === selectedDefectId}
          />
        ))}
        <div className="point-cloud-x-axis" aria-hidden="true">
          {[0, 2000, 4000, 6000, 8000, 10000, Math.round(plateLengthM * 1000)].map((tick) => (
            <span key={tick}>{tick}</span>
          ))}
        </div>
        <span className="point-cloud-axis-caption">钢管长度方向(mm)</span>
      </div>
      <div className="point-cloud-height-scale" aria-label={`${surfaceLabels[surface]}高度色标`}>
        <span>高度(mm)</span>
        <i />
        <b>2.00</b>
        <b>1.00</b>
        <b>0.00</b>
        <b>-1.00</b>
        <b>-2.00</b>
      </div>
    </div>
  );
}

function PlatePointCloudView({
  defects,
  defectTypes,
  selectedDefectId,
  previewPositionM,
  plateLengthM,
  surfaceMode,
  artifactMode,
  surfaceMesh,
  artifactStatus,
}: {
  defects: DefectItem[];
  defectTypes: DefectType[];
  selectedDefectId: string | null;
  previewPositionM: number;
  plateLengthM: number;
  surfaceMode: SurfaceDisplayMode;
  artifactMode: 'production' | 'demo';
  surfaceMesh?: BarSurfaceMesh | null;
  artifactStatus?: string;
}) {
  if (artifactMode === 'production') {
    return surfaceMesh && surfaceMesh.positions.length >= 3 ? (
      <ProductionArtifactView
        mesh={surfaceMesh}
        mode="points"
        testId="plate-production-point-cloud"
        ariaLabel="当前检测记录真实点云"
        className="plate-production-artifact"
      />
    ) : (
      <div className="production-artifact-empty" role="status" data-testid="plate-production-point-cloud-empty">
        <strong>暂无生产点云产物</strong>
        <span>{artifactStatus || '当前检测记录尚未绑定算法点云，请等待算法任务完成。'}</span>
      </div>
    );
  }
  const surfaces: Array<'top' | 'bottom'> = surfaceMode === 'all' ? ['top', 'bottom'] : [surfaceMode];

  return (
    <div
      className={`plate-point-cloud-view rows-${surfaces.length}`}
      data-testid="plate-point-cloud-view"
      data-point-cloud-points={surfaces.length * 124 * 46}
      data-point-cloud-z-range="-2.00,2.00"
      data-artifact-source="demo"
      aria-label="钢管点云高度展开图"
    >
      <span className="demo-artifact-badge">演示点云 · 非生产产物</span>
      <div className="point-cloud-unfold-stack">
        {surfaces.map((surface) => (
          <PointCloudSurfaceStrip
            key={surface}
            surface={surface}
            defects={defects}
            defectTypes={defectTypes}
            selectedDefectId={selectedDefectId}
            previewPositionM={previewPositionM}
            plateLengthM={plateLengthM}
          />
        ))}
      </div>
    </div>
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
      aria-label="3D钢管视图，左右拖拽调整视角，滚轮放大缩小"
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
          <strong>{surfaceMode === 'all' ? '全部相机区' : surfaceLabels[surfaceMode]}</strong>
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
  worldFocusRequest,
  surfaceMode,
  previewPositionM,
  plateLengthM = DEFAULT_PLATE_LENGTH_M,
  nominalDiameterMm = 0,
  artifactMode = 'production',
  inspectionId,
  requireInspectionWorld = false,
  captureMaterialId,
  captureRoiFallbackMaterialIds: _captureRoiFallbackMaterialIds = [],
  refreshCaptureRoi = false,
  captureImages = [],
  cameraLanes = DEFAULT_CAMERA_LANES,
  surfaceMesh,
  surfaceCameraTiles,
  surfaceHeadAlignment,
  surfaceCameras = [],
  artifactStatus,
  viewMode: controlledViewMode,
  integratedToolbar = false,
  toolbarExtra,
  onToggleType,
  onSurfaceModeChange,
  onPreviewPositionChange,
  onSelectDefect,
  onViewModeChange,
  onVisibleRangeChange,
}: PlateMapProps) {
  const [localViewMode, setLocalViewMode] = useState<PlateMapViewMode>('2d');
  const viewMode = controlledViewMode ?? localViewMode;
  const setViewMode = onViewModeChange ?? setLocalViewMode;
  const artifactLoading = Boolean(
    artifactStatus && (artifactStatus.startsWith('正在') || artifactStatus.includes('加载')),
  );
  const [threeDisplayMode, setThreeDisplayMode] = useState<Plate3DDisplayMode>('surface');
  const [twoDDisplayMode, setTwoDDisplayMode] = useState<Plate2DDisplayMode>('gray');
  const [artifactOrientation, setArtifactOrientation] = useState<ArtifactOrientation>('horizontal');
  const [productionZoom, setProductionZoom] = useState(1);
  const [hoveredDefectId, setHoveredDefectId] = useState<string | null>(null);
  const [unfoldOrientation, setUnfoldOrientation] = useState<UnfoldOrientation>('horizontal');
  const [displayedWorld, setDisplayedWorld] = useState<DisplayWorld | null>(null);
  const displayedWorldRef = useRef<DisplayWorld | null>(null);
  const [pendingWorld, setPendingWorld] = useState<DisplayWorld | null>(null);
  const [worldTileProgress, setWorldTileProgress] = useState<InspectionWorldTileLoading | null>(null);
  const [worldLoading, setWorldLoading] = useState(false);
  const [worldUnavailable, setWorldUnavailable] = useState(false);
  const [worldError, setWorldError] = useState('');
  const captureStitchEligible = artifactMode === 'production'
    && viewMode === '2d'
    && !requireInspectionWorld
    && Boolean(captureMaterialId?.trim());
  const captureStitchState = useCaptureStitchHistory(
    captureMaterialId,
    cameraLanes.map((lane) => lane.shortLabel),
    captureStitchEligible,
    refreshCaptureRoi,
  );
  const captureStitchResult = captureStitchState.materialId === captureMaterialId?.trim()
    ? captureStitchState.result
    : null;
  const captureStitchPending = captureStitchEligible && (
    captureStitchState.materialId !== captureMaterialId?.trim()
    || captureStitchState.status === 'idle'
    || captureStitchState.status === 'loading'
  );
  // History is strictly bound to the selected material. A record-bound raw
  // snapshot remains the one-frame fallback when the history index is absent.
  const recordBoundRawImages = artifactMode === 'production' ? captureImages : [];
  const displayedCaptureImages = recordBoundRawImages;
  const productionCameraImageCount = surfaceCameras.filter((camera) => Boolean(camera.relative.intensityPreview || camera.latest.intensityPreview)).length;
  const capturedCameraImageCount = new Set(
    captureStitchResult?.frames.flatMap((frame) => frame.cameras.map((camera) => camera.cameraId))
      ?? displayedCaptureImages.filter((image) => image.dataName.toLowerCase() === 'intensity').map((image) => image.cameraId),
  ).size;
  const rawCameraImageCount = new Set(recordBoundRawImages.filter((image) => image.dataName.toLowerCase() === 'intensity').map((image) => image.cameraId)).size;
  const displayedCameraImageCount = Math.min(cameraLanes.length, Math.max(productionCameraImageCount, capturedCameraImageCount));
  const safePlateLengthM = plateLengthM > 0 ? plateLengthM : DEFAULT_PLATE_LENGTH_M;
  const selectedDefect = defects.find((defect) => defect.id === selectedDefectId) ?? null;
  const selectedDefectPositionRatio = useMemo(() => {
    if (!selectedDefect) return null;
    const lengthMm = safePlateLengthM * 1000;
    if (selectedDefect.distanceHeadMm > 0 && lengthMm > 0) {
      return Math.max(0, Math.min(1, selectedDefect.distanceHeadMm / lengthMm));
    }
    const sequenceNo = selectedDefect.artifacts?.sequenceNo;
    const camera = displayedWorld?.meta.world.cameras.find(
      (item) => item.cameraId === selectedDefect.cameraIndex,
    );
    if (sequenceNo != null && camera?.frameNumbers.length) {
      const index = camera.frameNumbers.indexOf(sequenceNo);
      if (index >= 0) return index / Math.max(1, camera.frameNumbers.length - 1);
    }
    if (sequenceNo != null && surfaceMesh && surfaceMesh.rows > 1) {
      return Math.max(0, Math.min(1, sequenceNo / (surfaceMesh.rows - 1)));
    }
    return null;
  }, [displayedWorld?.meta.world.cameras, safePlateLengthM, selectedDefect, surfaceMesh]);
  const { textureUrl, textureStatus } = useInspectionWorldTexture(
    inspectionId,
    displayedWorld?.meta,
    artifactMode === 'production' && viewMode === '3d' && threeDisplayMode === 'texture',
    productionZoom,
  );
  useEffect(() => {
    displayedWorldRef.current = displayedWorld;
  }, [displayedWorld]);
  useEffect(() => {
    setWorldUnavailable(false);
    setWorldError('');
    setPendingWorld(null);
    setWorldTileProgress(null);
    if (artifactMode !== 'production' || viewMode !== '2d') return;
    if (captureStitchEligible) {
      // Direct SICK records are keyed by their numeric flow/material ID in
      // derived/playback/index.json. Prefer that stable-ROI index and avoid a
      // known-missing inspection-world lookup keyed by the database ID.
      displayedWorldRef.current = null;
      setDisplayedWorld(null);
      setWorldUnavailable(true);
      setWorldLoading(captureStitchState.status === 'idle' || captureStitchState.status === 'loading');
      return;
    }
    if (!inspectionId) {
      setWorldLoading(false);
      setWorldUnavailable(true);
      return;
    }
    setWorldLoading(true);
    const controller = new AbortController();
    let worldMissing = false;
    const refresh = async () => {
      if (worldMissing || controller.signal.aborted) return;
      try {
        const meta = await fetchInspectionWorldMeta(inspectionId, controller.signal);
        if (controller.signal.aborted) return;
        setWorldUnavailable(false);
        setWorldError('');
        const current = displayedWorldRef.current;
        const sameDisplayedWorld = current?.recordId === inspectionId
          && current.meta.sourceFrameCount === meta.sourceFrameCount
          && current.meta.world.width === meta.world.width
          && current.meta.world.height === meta.world.height;
        if (sameDisplayedWorld) {
          const next = { ...current, meta };
          displayedWorldRef.current = next;
          setDisplayedWorld(next);
          setWorldLoading(false);
        } else {
          setPendingWorld({
            recordId: inspectionId,
            meta,
            defects: [],
          });
          setWorldTileProgress(null);
        }
        try {
          const defectPayload = await fetchInspectionWorldDefects(inspectionId, controller.signal);
          if (!controller.signal.aborted) {
            if (sameDisplayedWorld) {
              setDisplayedWorld((displayed) => {
                if (displayed?.recordId !== inspectionId) return displayed;
                const next = { ...displayed, defects: defectPayload.defects };
                displayedWorldRef.current = next;
                return next;
              });
            } else {
              setPendingWorld((pending) => pending?.recordId === inspectionId
                ? { ...pending, defects: defectPayload.defects }
                : pending);
              setDisplayedWorld((displayed) => {
                if (displayed?.recordId !== inspectionId) return displayed;
                const next = { ...displayed, defects: defectPayload.defects };
                displayedWorldRef.current = next;
                return next;
              });
            }
          }
        } catch {
          // Image-world availability is independent from optional defect overlays.
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setWorldUnavailable(true);
          setWorldLoading(false);
          setWorldTileProgress(null);
          // A direct-camera record can legitimately have cropped frame
          // artifacts before a tile world is generated. Fall back to those
          // frames and do not hammer the missing meta endpoint every 5 s.
          if (!requireInspectionWorld
            && error instanceof InspectionWorldHttpError
            && error.status === 404) {
            worldMissing = true;
            setWorldError('');
          } else {
            setWorldError(error instanceof Error ? error.message : '检测图像世界读取失败');
          }
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [artifactMode, captureStitchEligible, captureStitchState.status, inspectionId, requireInspectionWorld, viewMode]);
  const activePendingWorld = pendingWorld?.recordId === inspectionId ? pendingWorld : null;
  const shouldRenderWorldStack = viewMode === '2d' && (
    displayedWorld !== null
    || activePendingWorld !== null
    || requireInspectionWorld
  );
  const switchingWorld = Boolean(
    displayedWorld
    && inspectionId
    && displayedWorld.recordId !== inspectionId,
  );
  const selectRelativeDefect = (step: number) => {
    if (defects.length === 0) {
      return;
    }
    const selectedIndex = defects.findIndex((defect) => defect.id === selectedDefectId);
    const currentIndex = selectedIndex >= 0 ? selectedIndex : step > 0 ? -1 : 0;
    const nextIndex = (currentIndex + step + defects.length) % defects.length;
    onSelectDefect(defects[nextIndex].id);
  };

  const handleDefectNavigationKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      selectRelativeDefect(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      selectRelativeDefect(-1);
    } else if (event.key === 'Home' && defects[0]) {
      event.preventDefault();
      onSelectDefect(defects[0].id);
    } else if (event.key === 'End' && defects[defects.length - 1]) {
      event.preventDefault();
      onSelectDefect(defects[defects.length - 1].id);
    }
  };

  const handleDefectNavigationWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (defects.length < 2 || Math.abs(event.deltaY) < 1) {
      return;
    }
    event.preventDefault();
    selectRelativeDefect(event.deltaY > 0 ? 1 : -1);
  };

  return (
    <Panel
      title="棒材圆周展开缺陷图"
      className={`plate-map-panel surface-mode-${surfaceMode} view-mode-${viewMode} ${integratedToolbar ? 'integrated-toolbar' : ''}`}
      headerless={integratedToolbar}
      action={
        <PlateMapActions
          viewMode={viewMode}
          onViewModeChange={setViewMode}
        />
      }
    >
      {integratedToolbar ? null : <div className="defect-legend">
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
      </div>}

      <div className={`record-artifact-row ${integratedToolbar ? 'integrated-map-tools' : ''}`}>
      {integratedToolbar ? null : <div className={`record-artifact-provenance ${artifactMode}`} role="note">
        {artifactMode === 'demo'
          ? '演示/测试数据：允许使用内置表面与模拟点云，不代表当前生产结果。'
          : `生产记录 ${inspectionId || '未绑定'}：数据库采集产物 ${captureImages.length} 件；算法 ROI 图像 ${displayedCameraImageCount}/${cameraLanes.length} 路。`}
      </div>}
      {viewMode === '2d' && (!shouldRenderWorldStack || twoDDisplayMode === 'jet') ? (
        <div className="unfold-orientation-switch" role="group" aria-label="二维展开方向">
          <button type="button" className={unfoldOrientation === 'horizontal' ? 'active' : ''} aria-pressed={unfoldOrientation === 'horizontal'} onClick={() => setUnfoldOrientation('horizontal')}>横向</button>
          <button type="button" className={unfoldOrientation === 'vertical' ? 'active' : ''} aria-pressed={unfoldOrientation === 'vertical'} onClick={() => setUnfoldOrientation('vertical')}>纵向</button>
        </div>
      ) : null}
      {surfaceHeadAlignment ? (
        <div
          className={`head-alignment-summary ${surfaceHeadAlignment.displayAligned ? 'is-aligned' : 'is-unavailable'}`}
          role="status"
          data-testid="head-alignment-summary"
          data-head-aligned={surfaceHeadAlignment.displayAligned ? 'true' : 'false'}
        >
          <strong>{surfaceHeadAlignment.displayAligned ? '头部已对齐' : '头部未对齐'}</strong>
          <span>
            参考 {surfaceHeadAlignment.referenceCameraId || '--'}
            {typeof surfaceHeadAlignment.maximumDisplayPaddingFrames === 'number'
              ? ` · 最大补偿 ${surfaceHeadAlignment.maximumDisplayPaddingFrames.toFixed(2)} 帧`
              : ''}
          </span>
        </div>
      ) : null}
      {integratedToolbar ? <PlateMapActions viewMode={viewMode} onViewModeChange={setViewMode} /> : null}
      <PlateDisplaySubModes
        viewMode={viewMode}
        threeMode={threeDisplayMode}
        twoDMode={twoDDisplayMode}
        artifactOrientation={artifactOrientation}
        onThreeModeChange={setThreeDisplayMode}
        onTwoDModeChange={setTwoDDisplayMode}
        onArtifactOrientationChange={setArtifactOrientation}
      />
      {toolbarExtra}
      </div>

      {viewMode === '3d' ? (
        artifactMode === 'production' ? (
          surfaceMesh
          && surfaceMesh.positions.length >= 3
          && (threeDisplayMode === 'points' || surfaceMesh.indices.length >= 3) ? (
            <ProductionArtifactView
              mesh={surfaceMesh}
              mode={threeDisplayMode === 'points' ? 'points' : 'surface'}
              testId={threeDisplayMode === 'points'
                ? 'plate-production-point-cloud'
                : 'plate-production-surface'}
              ariaLabel={threeDisplayMode === 'points'
                ? '当前检测记录真实点云'
                : threeDisplayMode === 'texture'
                  ? '当前检测记录二维贴图三维表面'
                  : threeDisplayMode === 'jet'
                    ? '当前检测记录 Jet 径向偏差三维表面'
                    : '当前检测记录真实三维表面'}
              className="plate-production-artifact"
              colorMode={threeDisplayMode === 'jet'
                ? 'radial-jet'
                : threeDisplayMode === 'texture'
                  ? 'texture'
                  : threeDisplayMode === 'surface'
                    ? 'neutral'
                    : 'source'}
              textureUrl={textureUrl}
              radialUnitScale={surfaceMesh.coordinateUnit === 'mm'
                ? 1
                : nominalDiameterMm > 0 ? nominalDiameterMm / 2 : 1}
              radialUnit={surfaceMesh.coordinateUnit === 'mm'
                ? 'mm'
                : nominalDiameterMm > 0 ? 'mm' : '显示坐标'}
              orientation={artifactOrientation}
              onZoomChange={setProductionZoom}
              lengthMm={surfaceMesh.materialId
                ? surfaceMesh.longitudinalAxis?.absoluteScaleVerified === true
                  ? safePlateLengthM * 1000
                  : 0
                : safePlateLengthM * 1000}
              onVisibleRangeChange={onVisibleRangeChange}
              focusPositionRatio={selectedDefectPositionRatio}
              focusRevision={worldFocusRequest?.revision}
            />
          ) : (
            <div
              className={`production-artifact-empty${artifactLoading ? ' is-loading' : ''}`}
              role="status"
              data-testid={threeDisplayMode === 'points'
                ? 'plate-production-point-cloud-empty'
                : 'plate-production-surface-empty'}
            >
              <strong>{artifactLoading
                ? (threeDisplayMode === 'points' ? '正在准备生产点云' : '正在准备生产三维表面')
                : (threeDisplayMode === 'points' ? '暂无生产点云产物' : '暂无生产三维表面产物')}</strong>
              <span>{artifactStatus || '当前检测记录尚未绑定三维重建结果，请等待算法任务完成。'}</span>
            </div>
          )
        ) : threeDisplayMode === 'points' ? (
          <PlatePointCloudView
            defects={defects}
            defectTypes={defectTypes}
            selectedDefectId={selectedDefectId}
            previewPositionM={previewPositionM}
            plateLengthM={safePlateLengthM}
            surfaceMode={surfaceMode}
            artifactMode={artifactMode}
            surfaceMesh={surfaceMesh}
            artifactStatus={artifactStatus}
          />
        ) : (
          <PlateMap3DView
            defects={defects}
            defectTypes={defectTypes}
            selectedDefectId={selectedDefectId}
            previewPositionM={previewPositionM}
            plateLengthM={safePlateLengthM}
            surfaceMode={surfaceMode}
            onSelectDefect={onSelectDefect}
          />
        )
      ) : viewMode === 'section' ? (
        surfaceMesh && surfaceMesh.positions.length >= 3 ? (
          surfaceMesh.materialId ? (
            <CaptureSectionView
              mesh={surfaceMesh}
              row={closestObservedSectionRow(
                surfaceMesh,
                previewPositionM / Math.max(safePlateLengthM, 0.001) * (surfaceMesh.rows - 1),
              )}
              onRowChange={(row) => onPreviewPositionChange(
                row / Math.max(1, surfaceMesh.rows - 1) * safePlateLengthM,
              )}
              recordId={inspectionId || surfaceMesh.materialId || '当前记录'}
            />
          ) : (
            <BkvSectionView
              mesh={surfaceMesh}
              row={closestObservedSectionRow(
                surfaceMesh,
                previewPositionM / Math.max(safePlateLengthM, 0.001) * (surfaceMesh.rows - 1),
              )}
              onRowChange={(row) => onPreviewPositionChange(
                row / Math.max(1, surfaceMesh.rows - 1) * safePlateLengthM,
              )}
              recordId={inspectionId || '当前记录'}
              nominalDiameterMm={nominalDiameterMm}
              lengthMm={safePlateLengthM * 1000}
            />
          )
        ) : (
          <div className={`production-artifact-empty${artifactLoading ? ' is-loading' : ''}`} role="status">
            <strong>{artifactLoading ? '正在准备切面数据' : '暂无可提取切面的三维表面'}</strong>
            <span>{artifactStatus || '当前记录尚未生成 NPZ 三维表面。'}</span>
          </div>
        )
      ) : twoDDisplayMode === 'jet' ? (
        surfaceCameraTiles?.cameras.some((tile) => tile.state === 'ready' && Boolean(tile.jet?.imagePath?.trim())) ? (
          <div
            className={`bar-unfolded-layout orientation-${unfoldOrientation}`}
            data-testid="surface-jet-unfolded"
            data-image-source="processed-jet-camera-images"
          >
            <BarUnfoldedMap
              defects={defects}
              defectTypes={defectTypes}
              selectedDefectId={selectedDefectId}
              hoveredDefectId={hoveredDefectId}
              previewPositionM={previewPositionM}
              plateLengthM={safePlateLengthM}
              onPreviewPositionChange={onPreviewPositionChange}
              onSelectDefect={onSelectDefect}
              onHoverDefect={setHoveredDefectId}
              onDefectNavigationKeyDown={handleDefectNavigationKeyDown}
              onDefectNavigationWheel={handleDefectNavigationWheel}
              orientation={unfoldOrientation}
              surfaceCameras={surfaceCameras}
              captureImages={[]}
              captureFrames={captureStitchResult?.frames ?? []}
              stitchKey={captureMaterialId?.trim() || inspectionId || ''}
              cameraLanes={cameraLanes}
              imageMode="jet"
              cameraTiles={surfaceCameraTiles}
              headAlignment={surfaceHeadAlignment}
            />
          </div>
        ) : (
          <div className={`production-artifact-empty${artifactLoading ? ' is-loading' : ''}`} role="status" data-testid="surface-jet-unfolded-empty">
            <strong>{artifactLoading ? '正在准备处理后 JET 图像' : '暂无可用的处理后 JET 图像'}</strong>
            <span>{artifactStatus || 'JET 平铺仅替换为算法处理后的逐相机 JET 图像，平铺布局与灰度图保持一致。'}</span>
          </div>
        )
      ) : shouldRenderWorldStack ? (
        <div className="inspection-world-stack" data-testid="inspection-world-stack">
          {displayedWorld ? <InspectionWorldCanvas
            key={`world:${displayedWorld.recordId}:${displayedWorld.meta.sourceFrameCount}:${displayedWorld.meta.world.width}:${displayedWorld.meta.world.height}`}
            className="online-inspection-world inspection-world-displayed"
            recordId={displayedWorld.recordId}
            meta={displayedWorld.meta}
            defects={displayedWorld.defects}
            selectedDefectId={selectedDefectId}
            focusDefectId={displayedWorld.recordId === inspectionId
              ? worldFocusRequest?.defectId ?? null
              : null}
            focusDefectRevision={worldFocusRequest?.revision}
            focusCameraId={selectedDefect?.cameraIndex}
            focusPositionRatio={selectedDefectPositionRatio}
            colorMode={twoDDisplayMode}
            suspendLoading={switchingWorld}
            onVisibleRangeChange={onVisibleRangeChange}
            onDefectClick={(defectId) => onSelectDefect(String(defectId))}
          /> : null}
          {activePendingWorld ? <InspectionWorldCanvas
            key={`world:${activePendingWorld.recordId}:${activePendingWorld.meta.sourceFrameCount}:${activePendingWorld.meta.world.width}:${activePendingWorld.meta.world.height}`}
            className="online-inspection-world inspection-world-preparing"
            recordId={activePendingWorld.recordId}
            meta={activePendingWorld.meta}
            defects={activePendingWorld.defects}
            selectedDefectId={selectedDefectId}
            focusDefectId={worldFocusRequest?.defectId ?? null}
            focusDefectRevision={worldFocusRequest?.revision}
            focusCameraId={selectedDefect?.cameraIndex}
            focusPositionRatio={selectedDefectPositionRatio}
            colorMode={twoDDisplayMode}
            onDefectClick={(defectId) => onSelectDefect(String(defectId))}
            onFirstPaint={() => {
              displayedWorldRef.current = activePendingWorld;
              setDisplayedWorld(activePendingWorld);
              setPendingWorld((current) => current === activePendingWorld ? null : current);
              setWorldLoading(false);
              setWorldError('');
            }}
            onFirstScreenReady={() => setWorldTileProgress(null)}
            onTileLoadingChange={setWorldTileProgress}
          /> : null}
          {!displayedWorld ? <div
            className="inspection-world-loading-skeleton"
            role="status"
            aria-label={inspectionId ? '正在加载 BKV 检测图像世界' : '暂无 BKV 检测记录'}
          >
            <strong>{inspectionId ? '正在加载检测图像…' : '暂无 BKV 检测记录'}</strong>
            <span>{inspectionId ? '正在准备相机瓦片，首个画面完成后自动显示。' : '标准离线仓库当前没有可显示的检测记录。'}</span>
          </div> : null}
          {displayedWorld && (worldLoading || (switchingWorld && !worldError)) ? <div
            className="inspection-world-switch-overlay"
            role="status"
            aria-label="正在切换 BKV 检测记录"
          >
            正在准备记录 {inspectionId}…
          </div> : null}
          {displayedWorld && switchingWorld && worldTileProgress ? <div
            className="inspection-world-switch-progress"
            role="status"
            aria-label="首屏瓦片加载进度"
          >
            首屏瓦片 {worldTileProgress.loadedFirstScreenTiles}/{worldTileProgress.firstScreenTiles}
            <span>
              候选 {worldTileProgress.loadCandidates} · 并发 {worldTileProgress.activeRequests}/8 · 待完成 {worldTileProgress.pendingTiles}
              {worldTileProgress.failedTiles ? ` · 失败 ${worldTileProgress.failedTiles}` : ''}
            </span>
          </div> : null}
          {worldError ? <div className="inspection-world-record-error" role="alert">
            <strong>当前记录图像读取失败</strong>
            <span>{worldError}</span>
          </div> : null}
        </div>
      ) : cameraLanes.length === 0 ? (
        <div className="production-artifact-empty" role="status">
          <strong>未配置 2D 相机</strong>
          <span>请先提供有序相机参数，再显示采集图像。</span>
        </div>
      ) : (
        <div className={`bar-unfolded-layout orientation-${unfoldOrientation}`}>
          {artifactMode === 'production' && worldUnavailable ? <span className="live-preview-badge" data-testid="capture-roi-status">
            {captureStitchResult
              ? `${captureStitchResult.hasMore ? '最近 ' : ''}${captureStitchResult.frames.length}/${captureStitchResult.totalFrames} 轮裁剪拼接 · 算法 ROI ${captureStitchResult.algorithmRoiImageCount} · 自动裁黑边 ${captureStitchResult.autoCropImageCount}`
              : captureStitchPending
                ? `原始灰度 ${rawCameraImageCount}/${cameraLanes.length} · 正在读取裁剪拼接`
                : rawCameraImageCount > 0
                  ? `原始灰度 ${rawCameraImageCount}/${cameraLanes.length} · 拼接历史尚未就绪`
                  : '当前卷暂无可拼接灰度图'}
          </span> : null}
          <BarUnfoldedMap
            defects={defects}
            defectTypes={defectTypes}
            selectedDefectId={selectedDefectId}
            hoveredDefectId={hoveredDefectId}
            previewPositionM={previewPositionM}
            plateLengthM={safePlateLengthM}
            onPreviewPositionChange={onPreviewPositionChange}
            onSelectDefect={onSelectDefect}
            onHoverDefect={setHoveredDefectId}
            onDefectNavigationKeyDown={handleDefectNavigationKeyDown}
            onDefectNavigationWheel={handleDefectNavigationWheel}
            orientation={unfoldOrientation}
            surfaceCameras={surfaceCameras}
            captureImages={displayedCaptureImages}
            captureFrames={captureStitchResult?.frames ?? []}
            stitchKey={captureMaterialId?.trim() || inspectionId || ''}
            cameraLanes={cameraLanes}
            headAlignment={surfaceHeadAlignment}
            cropBlackBorders
          />
        </div>
      )}
      {viewMode === '3d' && threeDisplayMode === 'texture' && textureStatus ? (
        <div className="plate-texture-status" role="status">{textureStatus}</div>
      ) : null}
    </Panel>
  );
}
