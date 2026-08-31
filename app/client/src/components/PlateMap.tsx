import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Check, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type MutableRefObject, type PointerEvent, type ReactNode, type WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { DoubleSide, type Mesh, type PerspectiveCamera } from 'three';
import heightMapBottomImage from '../assets/plate-surfaces/height-map-bottom.png';
import heightMapTopImage from '../assets/plate-surfaces/height-map-top.png';
import type { CaptureImageItem, DefectItem, DefectType } from '../data/inspection';
import { severityLabels, surfaceLabels } from '../data/inspection';
import { createSequentialCameraLanes, type CameraDisplayLane } from '../lib/camera-display';
import {
  captureRenderImageUrl,
  readCaptureDefects,
  readCaptureRegions,
  type CaptureFlowMeasurement,
  type CaptureFlowSurface,
  type CaptureRegionCamera,
  type CaptureRegionMap,
  type CaptureSurfaceCameraTiles,
} from '../lib/capture-api';
import { barSurfaceFileUrl, type BarSurfaceCamera, type BarSurfaceMesh } from '../services/bar-surface-api';
import {
  fetchCaptureStitchHistory,
  type CaptureStitchCameraFrame,
  type CaptureStitchFrame,
  type CaptureStitchResult,
} from '../services/capture-roi-api';
import {
  mapFramePointerToCapturePixel,
  readCaptureRawDepthValue,
  sampleJetResidualMm,
} from '../services/capture-depth-probe';
import {
  getRememberedCaptureImage,
  hasRememberedCaptureImageUrl,
  prefetchCaptureImageUrls,
  rememberCaptureImage,
} from '../lib/capture-image-prefetch';
import {
  buildCaptureCylinderTexturePlan,
  composeCaptureCylinderTexture,
  normalizeOwnedColumnIntervals,
  type CaptureTextureModality,
  type NormalizedColumnInterval,
} from '../lib/capture-cylinder-texture';
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
import { RequestedSizeImage, requestedSizeImageUrl } from './RequestedSizeImage';
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
  surfaceMeasurement?: CaptureFlowMeasurement | null;
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
type OverlapDisplayMode = 'overlap' | 'deduplicated';
type UnfoldOrientation = 'horizontal' | 'vertical';
export { normalizeOwnedColumnIntervals } from '../lib/capture-cylinder-texture';
type DisplayWorld = {
  recordId: string;
  meta: InspectionWorldMeta;
  defects: InspectionWorldDefect[];
};

const MAP_DRAG_THRESHOLD_PX = 8;
const LIVE_ARTIFACT_REFRESH_MS = 2_000;

type CaptureStitchState = {
  materialId: string;
  status: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  result: CaptureStitchResult | null;
};

type CaptureOverlapState = {
  materialId: string;
  regionMap: CaptureRegionMap | null;
  duplicateFilteredCount: number | null;
  loading: boolean;
};

type TwoDViewportMemory = {
  stitchKey: string;
  orientation: UnfoldOrientation;
  scrollProgress: number;
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
    const controller = new AbortController();
    let cancelled = false;
    let timer: number | undefined;
    let failures = 0;
    setState({ materialId: normalizedMaterialId, status: 'loading', result: null });

    const schedule = (delayMs: number) => {
      if (!cancelled) timer = window.setTimeout(() => void refresh(), delayMs);
    };
    const refresh = async () => {
      try {
        const result = await fetchCaptureStitchHistory(
          normalizedMaterialId,
          expectedCameraIds,
          controller.signal,
        );
        if (cancelled) return;
        failures = 0;
        setState({
          materialId: normalizedMaterialId,
          status: result.frames.length > 0 ? 'ready' : 'missing',
          result: result.frames.length > 0 ? result : null,
        });
        if (keepRefreshing) schedule(LIVE_ARTIFACT_REFRESH_MS);
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        failures += 1;
        setState({ materialId: normalizedMaterialId, status: 'error', result: null });
        schedule(Math.min(30_000, 4_000 * (2 ** Math.min(3, failures - 1))));
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [cameraKey, enabled, keepRefreshing, materialId]);
  return state;
}

function useCaptureOverlapData(
  materialId: string | undefined,
  enabled: boolean,
  keepRefreshing: boolean,
) {
  const [state, setState] = useState<CaptureOverlapState>({
    materialId: '',
    regionMap: null,
    duplicateFilteredCount: null,
    loading: false,
  });
  useEffect(() => {
    const normalizedMaterialId = materialId?.trim() || '';
    if (!enabled || !normalizedMaterialId) {
      setState({
        materialId: normalizedMaterialId,
        regionMap: null,
        duplicateFilteredCount: null,
        loading: false,
      });
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;
    setState({
      materialId: normalizedMaterialId,
      regionMap: null,
      duplicateFilteredCount: null,
      loading: true,
    });

    const schedule = (delayMs: number) => {
      if (!cancelled) timer = window.setTimeout(() => void refresh(), delayMs);
    };
    const refresh = async () => {
      const [regionResult, defectResult] = await Promise.allSettled([
        readCaptureRegions(normalizedMaterialId),
        readCaptureDefects(normalizedMaterialId),
      ]);
      if (cancelled) return;
      const regionMap = regionResult.status === 'fulfilled' ? regionResult.value : null;
      const detection = defectResult.status === 'fulfilled' ? defectResult.value.detection : undefined;
      const duplicateFilteredCount = typeof detection?.statistics?.overlapDuplicateFilteredCount === 'number'
        ? detection.statistics.overlapDuplicateFilteredCount
        : null;
      setState((current) => ({
        materialId: normalizedMaterialId,
        regionMap: regionMap ?? (current.materialId === normalizedMaterialId ? current.regionMap : null),
        duplicateFilteredCount: duplicateFilteredCount
          ?? (current.materialId === normalizedMaterialId ? current.duplicateFilteredCount : null),
        loading: false,
      }));
      const defectSettled = defectResult.status === 'fulfilled' && Boolean(
        defectResult.value.detection
        || ['failed', 'disabled'].includes(defectResult.value.state || ''),
      );
      if (keepRefreshing || !regionMap || !defectSettled) {
        schedule(keepRefreshing ? LIVE_ARTIFACT_REFRESH_MS : 8_000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, keepRefreshing, materialId]);
  return state;
}

export function remapOwnedColumnRange(
  left: number,
  right: number,
  intervals: readonly NormalizedColumnInterval[],
): NormalizedColumnInterval | null {
  if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) return null;
  const center = (left + right) / 2;
  const totalWidth = intervals.reduce((total, interval) => total + interval[1] - interval[0], 0);
  if (totalWidth <= 0) return null;
  let offset = 0;
  for (const interval of intervals) {
    const width = interval[1] - interval[0];
    if (center >= interval[0] && center <= interval[1]) {
      const clippedLeft = Math.max(interval[0], left);
      const clippedRight = Math.min(interval[1], right);
      if (clippedRight <= clippedLeft) return null;
      return [
        (offset + clippedLeft - interval[0]) / totalWidth,
        (offset + clippedRight - interval[0]) / totalWidth,
      ];
    }
    offset += width;
  }
  return null;
}

export function restoreOwnedColumnRatio(
  displayedRatio: number,
  intervals: readonly NormalizedColumnInterval[],
) {
  if (!Number.isFinite(displayedRatio)) return null;
  const totalWidth = intervals.reduce((total, interval) => total + interval[1] - interval[0], 0);
  if (totalWidth <= 0) return null;
  const target = Math.max(0, Math.min(1, displayedRatio)) * totalWidth;
  let offset = 0;
  for (const [left, right] of intervals) {
    const width = right - left;
    if (target <= offset + width || right === intervals.at(-1)?.[1]) {
      return Math.max(left, Math.min(right, left + target - offset));
    }
    offset += width;
  }
  return null;
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

const CAPTURE_PREFETCH_SIDE_FRAMES = 4;
const CAPTURE_PREFETCH_MAX_IMAGES = 48;

/**
 * Returns only frames outside the rendered overscan window. Keeping the
 * overscan frames in the visible React tree and prefetching the next four
 * slots on each side gives scroll-ahead coverage without multiplying DOM
 * nodes for a long line-scan record.
 */
export function capturePrefetchFrameIndexes(
  frameCount: number,
  firstVisibleFrame: number,
  lastVisibleFrame: number,
  sideFrames = CAPTURE_PREFETCH_SIDE_FRAMES,
) {
  const count = Math.max(0, Math.floor(frameCount));
  const start = Math.max(0, Math.min(count, Math.floor(firstVisibleFrame)));
  const end = Math.max(start, Math.min(count, Math.ceil(lastVisibleFrame)));
  const radius = Math.max(0, Math.floor(sideFrames));
  const indexes: number[] = [];
  for (let index = Math.max(0, start - radius); index < start; index += 1) {
    indexes.push(index);
  }
  for (let index = end; index < Math.min(count, end + radius); index += 1) {
    indexes.push(index);
  }
  return indexes;
}

export function captureFrameDurationMs(
  frames: readonly CaptureStitchFrame[],
  headAlignment?: CaptureFlowSurface['headAlignment'] | null,
) {
  const candidates: number[] = [];
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1];
    const current = frames[index];
    const sequenceSpan = current.sequence - previous.sequence;
    const elapsedMs = Date.parse(current.capturedAt) - Date.parse(previous.capturedAt);
    if (sequenceSpan > 0 && elapsedMs > 0) candidates.push(elapsedMs / sequenceSpan);
  }
  Object.values(headAlignment?.cameras ?? {}).forEach((camera) => {
    const offsetFrames = Math.abs(Number(camera.offsetFramesFromReference));
    const offsetMs = Math.abs(Number(camera.offsetMsFromReference));
    if (offsetFrames > 0.01 && offsetMs > 0) candidates.push(offsetMs / offsetFrames);
  });
  const usable = candidates
    .filter((value) => Number.isFinite(value) && value >= 1 && value <= 60_000)
    .sort((left, right) => left - right);
  if (usable.length === 0) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 === 0
    ? (usable[middle - 1] + usable[middle]) / 2
    : usable[middle];
}

export function captureTailTimelineFrame(
  frames: readonly CaptureStitchFrame[],
  contentAnchorFrame: number,
  longitudinalAxis: BarSurfaceMesh['longitudinalAxis'] | null | undefined,
  headAlignment?: CaptureFlowSurface['headAlignment'] | null,
) {
  const endElapsedFromHeadMs = Number(longitudinalAxis?.endElapsedFromHeadMs);
  if (!Number.isFinite(endElapsedFromHeadMs) || endElapsedFromHeadMs <= 0) return null;
  const frameDurationMs = captureFrameDurationMs(frames, headAlignment);
  if (frameDurationMs === null) return null;
  return contentAnchorFrame + endElapsedFromHeadMs / frameDurationMs;
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

export function captureStitchTailFrameIndex(
  frames: readonly CaptureStitchFrame[],
  expectedCameraCount: number,
) {
  const hasDensityEvidence = frames.some((frame) => frame.cameras.some(
    (camera) => camera.sourceBytes !== undefined,
  ));
  if (!hasDensityEvidence) return null;
  const requiredContentCameras = Math.max(1, Math.ceil(Math.max(1, expectedCameraCount) / 2));
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const contentCount = frames[index].cameras.filter(captureStitchCameraHasContent).length;
    if (contentCount >= requiredContentCameras) return index;
  }
  return null;
}

export function captureFrameLongitudinalAspect(
  cameraFrame: CaptureStitchCameraFrame | null | undefined,
  sourceIntervals?: readonly NormalizedColumnInterval[],
) {
  if (!cameraFrame) return null;
  const [left, top, right, bottom] = cameraFrame.validRoi
    ?? [0, 0, cameraFrame.sourceWidth, cameraFrame.sourceHeight];
  const cropWidth = Math.abs(right - left);
  const cropHeight = Math.abs(bottom - top);
  if (!(cropWidth > 0) || !(cropHeight > 0)) return null;
  const ownedFraction = sourceIntervals?.reduce(
    (total, [start, end]) => total + Math.max(0, end - start),
    0,
  ) ?? 0;
  const visibleCrossAxisPixels = cropWidth * (ownedFraction > 0 ? ownedFraction : 1);
  if (!(visibleCrossAxisPixels > 0)) return null;
  return Math.max(0.25, Math.min(8, cropHeight / visibleCrossAxisPixels));
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

function useCaptureCylinderTexture(
  materialId: string | undefined,
  frames: readonly CaptureStitchFrame[],
  cameraIds: readonly string[],
  regionMap: CaptureRegionMap | null,
  surfaceCameraTiles: CaptureSurfaceCameraTiles | null | undefined,
  headAlignment: CaptureFlowSurface['headAlignment'] | null | undefined,
  modality: CaptureTextureModality,
  enabled: boolean,
) {
  const cameraKey = cameraIds.join(',');
  const plan = useMemo(() => enabled ? buildCaptureCylinderTexturePlan({
    materialId: materialId?.trim() || '',
    frames,
    cameraIds: cameraKey.split(',').filter(Boolean),
    regionMap,
    surfaceCameraTiles,
    headAlignment,
    modality,
  }) : null, [cameraKey, enabled, frames, headAlignment, materialId, modality, regionMap, surfaceCameraTiles]);
  const [textureUrl, setTextureUrl] = useState('');
  const [textureStatus, setTextureStatus] = useState('');
  const [textureRetryRevision, setTextureRetryRevision] = useState(0);
  const textureObjectUrlRef = useRef('');
  const planKey = plan?.cacheKey ?? '';
  const regionStateKey = regionMap
    ? `${regionMap.ownership.ready}:${regionMap.ownership.reasons.join(',')}`
    : '';

  useEffect(() => () => {
    if (textureObjectUrlRef.current) URL.revokeObjectURL(textureObjectUrlRef.current);
  }, []);

  useEffect(() => {
    if (!enabled) {
      if (textureObjectUrlRef.current) URL.revokeObjectURL(textureObjectUrlRef.current);
      textureObjectUrlRef.current = '';
      setTextureUrl('');
      setTextureStatus('');
      return undefined;
    }
    const label = modality === 'jet' ? 'JET' : '灰度';
    if (!plan) {
      if (textureObjectUrlRef.current) URL.revokeObjectURL(textureObjectUrlRef.current);
      textureObjectUrlRef.current = '';
      setTextureUrl('');
      setTextureStatus(frames.length === 0
        ? `正在读取${label}逐帧图像…`
        : !regionMap
          ? '正在读取六相机去重归属…'
          : !surfaceCameraTiles
            ? `当前三维结果缺少逐列角度标定，无法生成去重${label}贴图`
            : `六相机归属或逐列角度标定不完整，无法生成去重${label}贴图（${surfaceCameraTiles.cameras.length}/${cameraIds.length}）`);
      return undefined;
    }

    const controller = new AbortController();
    let retryTimer = 0;
    if (textureObjectUrlRef.current) URL.revokeObjectURL(textureObjectUrlRef.current);
    textureObjectUrlRef.current = '';
    setTextureUrl('');
    setTextureStatus(`正在生成去重${label}贴图… 0/${plan.tiles.length}`);
    void composeCaptureCylinderTexture(plan, controller.signal, (completed, total) => {
      if (!controller.signal.aborted) {
        setTextureStatus(`正在生成去重${label}贴图… ${completed}/${total}`);
      }
    }).then(({ blob }) => {
      if (controller.signal.aborted) return;
      const nextUrl = URL.createObjectURL(blob);
      textureObjectUrlRef.current = nextUrl;
      setTextureUrl(nextUrl);
      setTextureStatus(
        `去重${label}贴图 · ${plan.frameCount} 帧 · ${plan.canvasWidth}×${plan.canvasHeight} · 像素 1:1 · 长径比 ${plan.lengthDiameterRatio.toFixed(1)}:1`,
      );
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : `去重${label}贴图生成失败`;
        setTextureStatus(`${message}，稍后自动重试`);
        retryTimer = window.setTimeout(() => {
          setTextureRetryRevision((revision) => revision + 1);
        }, 8_000);
      }
    });
    return () => {
      controller.abort();
      window.clearTimeout(retryTimer);
    };
  // cacheKey deliberately shields an in-progress composition from periodic
  // API refreshes that return equivalent frame/region objects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, frames.length, modality, planKey, regionStateKey, textureRetryRevision]);

  return { textureUrl, textureStatus, texturePlan: plan };
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
  frameContext,
}: {
  defect: DefectItem;
  type: DefectType;
  xPercent?: number;
  yPercent?: number;
  frameContext?: {
    cameraId: string;
    frameSequence: number;
    storageIndex: number;
    imageUrl: string;
    roi: { x: number; y: number; width: number; height: number };
    clientX: number;
    clientY: number;
  };
}) {
  const actualXPercent = xPercent ?? defect.xRatio * 100;
  const actualYPercent = yPercent ?? yOffsetToPercentValue(defect.yOffsetMm);
  const xPercentValue = clampPercent(actualXPercent, 0, 100);
  const yPercentValue = clampPercent(actualYPercent, 0, 100);
  const edgeClass = `${xPercentValue > 76 ? 'near-right' : xPercentValue < 24 ? 'near-left' : ''} ${yPercentValue < 44 ? 'near-top' : ''}`;
  const previewImageUrl = defect.previewImageUrl?.trim() || frameContext?.imageUrl || '';
  const confidence = defect.classificationConfidence
    ?? defect.detectionConfidence
    ?? defect.confidence;
  const floatingStyle = frameContext ? {
    left: Math.max(8, Math.min(frameContext.clientX + 16, window.innerWidth - 378)),
    top: frameContext.clientY > window.innerHeight * 0.58
      ? Math.max(8, frameContext.clientY - 356)
      : Math.min(frameContext.clientY + 16, Math.max(8, window.innerHeight - 356)),
  } : null;

  return (
    <div
      className={`defect-hover-card ${frameContext ? 'frame-preview' : edgeClass}`}
      role="tooltip"
      data-testid={frameContext ? 'defect-frame-hover-card' : undefined}
      style={
        {
          left: floatingStyle?.left ?? `${xPercentValue}%`,
          top: floatingStyle?.top ?? `${yPercentValue}%`,
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
      {previewImageUrl ? (
        <div className={`defect-hover-preview ${frameContext ? 'large' : ''}`}>
          <RequestedSizeImage
            src={previewImageUrl}
            alt={`${defect.typeLabel}缺陷${frameContext ? '大图' : '小图'}`}
            requestWidth={frameContext ? 360 : 256}
            requestHeight={frameContext ? 240 : 160}
          />
        </div>
      ) : frameContext ? <div className="defect-hover-preview large empty">暂无缺陷图像</div> : null}
      <dl>
        {frameContext ? <>
          <div>
            <dt>相机</dt>
            <dd>{frameContext.cameraId}</dd>
          </div>
          <div>
            <dt>帧/文件</dt>
            <dd>{frameContext.frameSequence} / {frameContext.storageIndex}</dd>
          </div>
          <div className="wide">
            <dt>ROI</dt>
            <dd>{frameContext.roi.x}, {frameContext.roi.y} · {frameContext.roi.width}×{frameContext.roi.height}px</dd>
          </div>
        </> : null}
        {!frameContext ? <div>
          <dt>相机</dt>
          <dd>{getDefectCameraLabel(defect)}</dd>
        </div> : null}
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
        {typeof confidence === 'number' && Number.isFinite(confidence) ? (
          <div className="wide">
            <dt>置信度</dt>
            <dd>{Math.round(confidence * 100)}%</dd>
          </div>
        ) : null}
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
  sourceIntervals,
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
  sourceIntervals?: readonly NormalizedColumnInterval[];
  autoCropCameraId?: string;
  onAutoCropDetected?: (cameraId: string, crop: CameraBandCropWindow) => void;
  loadDelayMs?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropWindowRef = useRef(stableCropWindow);
  const sourceIntervalsRef = useRef(sourceIntervals);
  const redrawRef = useRef<(() => void) | null>(null);
  const sourceIntervalKey = sourceIntervals?.map((interval) => interval.join(':')).join(',') ?? '';

  cropWindowRef.current = stableCropWindow;
  sourceIntervalsRef.current = sourceIntervals;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const clear = () => {
      // Reassigning the bitmap dimensions clears pixels and resets transforms
      // without requiring a 2D context (also safe in WebView/jsdom startup).
      canvas.width = Math.max(1, canvas.width);
      canvas.height = Math.max(1, canvas.height);
    };
    if (!src) {
      clear();
      canvas.dataset.renderState = 'empty';
      delete canvas.dataset.imageCacheHit;
      delete canvas.dataset.hasPaintedFrame;
      delete canvas.dataset.pendingImageSource;
      return;
    }
    const initialRect = canvas.getBoundingClientRect();
    const requestedSource = requestedSizeImageUrl(
      src,
      initialRect.width > 0 ? initialRect.width : 256,
      initialRect.height > 0 ? initialRect.height : 128,
    );
    const rememberedImage = getRememberedCaptureImage(requestedSource);
    const previouslyLoaded = Boolean(rememberedImage) || hasRememberedCaptureImageUrl(requestedSource);
    const retainingPaintedFrame = canvas.dataset.hasPaintedFrame === 'true';
    if (!rememberedImage && !retainingPaintedFrame) clear();
    canvas.dataset.renderState = rememberedImage
      ? 'restoring-from-cache'
      : retainingPaintedFrame ? 'loading-retaining-frame' : 'loading';
    canvas.dataset.imageCacheHit = rememberedImage ? 'true' : 'false';
    canvas.dataset.imageCacheState = rememberedImage ? 'decoded' : previouslyLoaded ? 'http' : 'miss';
    canvas.dataset.pendingImageSource = requestedSource;
    let disposed = false;
    let loadTimer: number | null = null;
    let retryCount = 0;
    const image = rememberedImage ?? new Image();
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
      const visibleIntervals = sourceIntervalsRef.current?.filter(
        (interval) => interval[1] - interval[0] > 1e-6,
      ) ?? [];
      const visibleWidth = visibleIntervals.reduce(
        (total, interval) => total + interval[1] - interval[0],
        0,
      );
      if (visibleIntervals.length > 0 && visibleWidth > 0) {
        canvas.dataset.sourceIntervals = visibleIntervals
          .map((interval) => `${interval[0].toFixed(6)}:${interval[1].toFixed(6)}`)
          .join(',');
      } else {
        delete canvas.dataset.sourceIntervals;
      }
      const rotation = cameraBandRotationRadians(orientation);
      if (rotation !== 0) {
        context.translate(0, rect.height);
        context.rotate(rotation);
      }
      const destinationWidth = rotation !== 0 ? rect.height : rect.width;
      const destinationHeight = rotation !== 0 ? rect.width : rect.height;
      if (visibleIntervals.length > 0 && visibleWidth > 0) {
        let destinationX = 0;
        visibleIntervals.forEach(([left, right]) => {
          const intervalWidth = right - left;
          const renderedWidth = destinationWidth * intervalWidth / visibleWidth;
          context.drawImage(
            image,
            left * image.naturalWidth,
            sourceY,
            intervalWidth * image.naturalWidth,
            sourceHeight,
            destinationX,
            0,
            renderedWidth,
            destinationHeight,
          );
          destinationX += renderedWidth;
        });
      } else {
        context.drawImage(
          image,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          destinationWidth,
          destinationHeight,
        );
      }
      canvas.dataset.hasPaintedFrame = 'true';
      canvas.dataset.renderState = 'ready';
      delete canvas.dataset.pendingImageSource;
    };
    redrawRef.current = draw;
    if (!rememberedImage) {
      image.crossOrigin = 'anonymous';
      image.decoding = 'async';
      image.fetchPriority = loadDelayMs > 0 && !previouslyLoaded ? 'low' : 'high';
    }
    image.onload = () => {
      rememberCaptureImage(requestedSource, image);
      draw();
    };
    const requestImage = () => {
      if (!disposed) image.src = requestedSource;
    };
    image.onerror = () => {
      if (disposed) return;
      if (retryCount < 5) {
        const retryDelayMs = Math.min(8_000, 750 * (2 ** retryCount));
        retryCount += 1;
        canvas.dataset.renderState = retainingPaintedFrame
          ? 'waiting-for-rendition-retaining-frame'
          : 'waiting-for-rendition';
        loadTimer = window.setTimeout(() => {
          loadTimer = null;
          requestImage();
        }, retryDelayMs);
      } else {
        canvas.dataset.renderState = retainingPaintedFrame ? 'error-retaining-frame' : 'error';
      }
    };
    if (rememberedImage) {
      // Layout effects run before paint. Reusing the decoded Image object here
      // lets a virtualized frame return without exposing an empty canvas.
      draw();
    } else if (loadDelayMs > 0 && !previouslyLoaded) {
      loadTimer = window.setTimeout(() => {
        loadTimer = null;
        requestImage();
      }, loadDelayMs);
    } else {
      requestImage();
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
      if (!image.complete && typeof image.removeAttribute === 'function') image.removeAttribute('src');
    };
  }, [autoCropCameraId, cropBlackBorders, loadDelayMs, onAutoCropDetected, orientation, src]);

  useEffect(() => {
    redrawRef.current?.();
  }, [sourceIntervalKey, stableCropWindow?.left, stableCropWindow?.right]);

  return <canvas
    ref={canvasRef}
    className="bar-camera-band-image"
    aria-label={`${label} ${contentLabel}`}
    data-edge-policy={cropBlackBorders ? 'stable-source-crop' : 'source-roi'}
    data-overlap-policy={sourceIntervals?.length ? 'owned-columns-concatenated' : 'overlap-retained'}
    data-source-intervals={sourceIntervals?.length
      ? sourceIntervals.map(([start, end]) => `${start.toFixed(6)}:${end.toFixed(6)}`).join(',')
      : undefined}
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

function captureRegionCamera(
  regionMap: CaptureRegionMap | null | undefined,
  cameraId: string,
): CaptureRegionCamera | undefined {
  const target = cameraIdentityNumber(cameraId);
  if (target === null) return undefined;
  return Object.values(regionMap?.cameras ?? {}).find(
    (camera) => cameraIdentityNumber(camera.cameraId) === target,
  );
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

export function captureProbeDiameterMm(
  measurement: CaptureFlowMeasurement | null | undefined,
  frames: readonly CaptureStitchFrame[],
  frameSequence: number,
) {
  if (!measurement?.metricValid) return null;
  const surface = measurement.surfaceFit;
  const sections = (surface?.available !== false && surface?.metricValid !== false
    ? surface?.sections ?? []
    : [])
    .map((section, index) => {
      const diameterMm = Number(section.circleFit?.diameterMm);
      const accepted = section.metricValid ?? section.qualityGate?.passed ?? true;
      if (!accepted || section.circleFit?.available === false || !Number.isFinite(diameterMm)) return null;
      const positionRatio = Number(section.positionRatio);
      return {
        diameterMm,
        positionRatio: Number.isFinite(positionRatio)
          ? Math.max(0, Math.min(1, positionRatio))
          : index / Math.max(1, (surface?.sections?.length ?? 1) - 1),
      };
    })
    .filter((section): section is { diameterMm: number; positionRatio: number } => section !== null);
  if (sections.length > 0) {
    const frameIndex = frames.findIndex((frame) => frame.sequence === frameSequence);
    const frameRatio = frameIndex >= 0
      ? frameIndex / Math.max(1, frames.length - 1)
      : 0;
    return sections.reduce((nearest, section) => (
      Math.abs(section.positionRatio - frameRatio) < Math.abs(nearest.positionRatio - frameRatio)
        ? section
        : nearest
    )).diameterMm;
  }
  const selectedDiameterMm = Number(measurement.selectedSection.circleFit?.diameterMm);
  if (measurement.selectedSection.circleFit?.available !== false && Number.isFinite(selectedDiameterMm)) {
    return selectedDiameterMm;
  }
  const averageDiameterMm = Number(surface?.diameterMeanMm);
  return Number.isFinite(averageDiameterMm) ? averageDiameterMm : null;
}

function defectFrameRectStyle(
  defect: DefectItem,
  cameraFrame: CaptureStitchFrame['cameras'][number],
  orientation: UnfoldOrientation,
  sourceIntervals?: readonly NormalizedColumnInterval[],
): CSSProperties | null {
  const roi = defect.artifacts?.roi;
  if (!roi || ![roi.x, roi.y, roi.width, roi.height].every(Number.isFinite)
    || roi.width <= 0 || roi.height <= 0) return null;
  const sourceWidth = Math.max(1, cameraFrame.sourceWidth);
  const sourceHeight = Math.max(1, cameraFrame.sourceHeight);
  const crop = cameraFrame.validRoi ?? [0, 0, sourceWidth, sourceHeight];
  const [cropLeft, cropTop, cropRight, cropBottom] = crop;
  const cropWidth = Math.max(1, cropRight - cropLeft);
  const cropHeight = Math.max(1, cropBottom - cropTop);
  const left = Math.max(cropLeft, Math.min(cropRight, roi.x));
  const top = Math.max(cropTop, Math.min(cropBottom, roi.y));
  const right = Math.max(left, Math.min(cropRight, roi.x + roi.width));
  const bottom = Math.max(top, Math.min(cropBottom, roi.y + roi.height));
  if (right <= left || bottom <= top) return null;
  const sourceLeftRatio = (left - cropLeft) / cropWidth;
  const sourceRightRatio = (right - cropLeft) / cropWidth;
  const mappedColumns = sourceIntervals?.length
    ? remapOwnedColumnRange(sourceLeftRatio, sourceRightRatio, sourceIntervals)
    : [sourceLeftRatio, sourceRightRatio] as NormalizedColumnInterval;
  if (!mappedColumns) return null;
  if (orientation === 'horizontal') {
    return {
      left: `${(top - cropTop) / cropHeight * 100}%`,
      top: `${(1 - mappedColumns[1]) * 100}%`,
      width: `${Math.max(1.2, (bottom - top) / cropHeight * 100)}%`,
      height: `${Math.max(8, (mappedColumns[1] - mappedColumns[0]) * 100)}%`,
    };
  }
  return {
    left: `${mappedColumns[0] * 100}%`,
    top: `${(top - cropTop) / cropHeight * 100}%`,
    width: `${Math.max(8, (mappedColumns[1] - mappedColumns[0]) * 100)}%`,
    height: `${Math.max(1.2, (bottom - top) / cropHeight * 100)}%`,
  };
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
  headAlignment,
  regionMap,
  deduplicateOverlap = false,
  measurement,
  longitudinalAxis,
  cropBlackBorders = false,
  viewportMemory,
  onVisibleRangeChange,
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
  headAlignment?: CaptureFlowSurface['headAlignment'] | null;
  regionMap?: CaptureRegionMap | null;
  deduplicateOverlap?: boolean;
  measurement?: CaptureFlowMeasurement | null;
  longitudinalAxis?: BarSurfaceMesh['longitudinalAxis'] | null;
  cropBlackBorders?: boolean;
  viewportMemory?: MutableRefObject<TwoDViewportMemory>;
  onVisibleRangeChange?: (range: [number, number] | null) => void;
}) {
  const FRAME_SPAN_PX = 176;
  const FRAME_OVERSCAN = 3;
  const HEAD_CONTEXT_FRAMES = 0.35;
  const TAIL_CONTEXT_FRAMES = 0.35;
  const [expandedCamera, setExpandedCamera] = useState<string | null>(null);
  const [mapDragging, setMapDragging] = useState(false);
  const [frameDefectHover, setFrameDefectHover] = useState<{
    defectId: string;
    cameraId: string;
    frameSequence: number;
    storageIndex: number;
    imageUrl: string;
    roi: { x: number; y: number; width: number; height: number };
    clientX: number;
    clientY: number;
  } | null>(null);
  const [rawDepthHeld, setRawDepthHeld] = useState(false);
  const [depthProbe, setDepthProbe] = useState<{
    key: string;
    cameraId: string;
    sequence: number;
    storageIndex: number;
    artifactRef: string;
    jetUrl: string;
    clientX: number;
    clientY: number;
    localX: number;
    localY: number;
    sourceX: number;
    sourceY: number;
    cropXRatio: number;
    rowRatio: number;
    status: 'loading' | 'ready' | 'missing' | 'error';
    relativeMm: number | null;
    rawValue: number | null;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const mapDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
    cameraId: string | null;
  } | null>(null);
  const mapPointerRef = useRef<{
    cameraId: string;
    clientX: number;
    clientY: number;
  } | null>(null);
  const cameraClickRef = useRef<{
    cameraId: string;
    at: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const suppressNativeDoubleClickUntilRef = useRef(0);
  const pendingZoomAnchorRef = useRef<{
    timelineFrame: number;
    viewportOffsetPx: number;
  } | null>(null);
  const scrollProgressRef = useRef(0);
  const publishedVisibleRangeRef = useRef('');
  const initialScrollProgressRef = useRef(
    viewportMemory?.current.stitchKey === stitchKey
      && viewportMemory.current.orientation === orientation
      ? viewportMemory.current.scrollProgress
      : null,
  );
  const atTailRef = useRef(false);
  const previousLayoutRef = useRef({
    orientation,
    stitchKey,
    frameCount: captureFrames.length,
    alignmentKey: '',
    frameSpanPx: FRAME_SPAN_PX,
    expandedCamera: null as string | null,
  });
  const [scrollWindow, setScrollWindow] = useState({
    offset: 0,
    extent: 1,
    total: 1,
    crossExtent: 1,
  });

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.code === 'KeyT') setRawDepthHeld(true);
    };
    const handleKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.code === 'KeyT') setRawDepthHeld(false);
    };
    const handleBlur = () => setRawDepthHeld(false);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  useEffect(() => {
    if (!depthProbe) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setDepthProbe((current) => current?.key === depthProbe.key
        && current.sourceX === depthProbe.sourceX
        && current.sourceY === depthProbe.sourceY
        ? { ...current, status: 'loading' }
        : current);
      try {
        const value = rawDepthHeld
          ? await readCaptureRawDepthValue(depthProbe.artifactRef, depthProbe.sourceX, depthProbe.sourceY)
          : await sampleJetResidualMm(depthProbe.jetUrl, depthProbe.cropXRatio, depthProbe.rowRatio);
        if (cancelled) return;
        setDepthProbe((current) => current?.key === depthProbe.key
          && current.sourceX === depthProbe.sourceX
          && current.sourceY === depthProbe.sourceY
          ? {
              ...current,
              status: value === null ? 'missing' : 'ready',
              relativeMm: rawDepthHeld ? current.relativeMm : value,
              rawValue: rawDepthHeld ? value : current.rawValue,
            }
          : current);
      } catch {
        if (!cancelled) {
          setDepthProbe((current) => current?.key === depthProbe.key
            && current.sourceX === depthProbe.sourceX
            && current.sourceY === depthProbe.sourceY
            ? { ...current, status: 'error' }
            : current);
        }
      }
    }, 55);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    depthProbe?.artifactRef,
    depthProbe?.cropXRatio,
    depthProbe?.jetUrl,
    depthProbe?.key,
    depthProbe?.rowRatio,
    depthProbe?.sourceX,
    depthProbe?.sourceY,
    rawDepthHeld,
  ]);
  const previewPercent = (clampPreviewPositionM(previewPositionM, plateLengthM) / plateLengthM) * 100;
  const probeDiameterMm = depthProbe
    ? captureProbeDiameterMm(measurement, captureFrames, depthProbe.sequence)
    : null;
  const hoveredDefect = defects.find((defect) => defect.id === hoveredDefectId) ?? null;
  const hoveredType = hoveredDefect ? defectTypes.find((type) => type.id === hoveredDefect.typeId) : null;
  const frameHoveredDefect = frameDefectHover
    ? defects.find((defect) => defect.id === frameDefectHover.defectId) ?? null
    : null;
  const frameHoveredType = frameHoveredDefect
    ? defectTypes.find((type) => type.id === frameHoveredDefect.typeId) ?? null
    : null;
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
    stitchEnabled
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
  const detectedContentTailFrameIndex = captureStitchTailFrameIndex(
    captureFrames,
    cameraLanes.length,
  );
  const expandedCameraLaneNumber = expandedCamera
    ? cameraIdentityNumber(expandedCamera)
    : null;
  const expandedCameraFrame = expandedCameraLaneNumber === null
    ? null
    : captureFrames.flatMap((frame) => frame.cameras).find((camera) => (
      cameraIdentityNumber(camera.cameraId) === expandedCameraLaneNumber
    )) ?? null;
  const expandedRegionCamera = expandedCamera
    ? captureRegionCamera(regionMap, expandedCamera)
    : null;
  const expandedSourceIntervals = deduplicateOverlap && expandedCameraFrame && expandedRegionCamera
    ? normalizeOwnedColumnIntervals(
        expandedRegionCamera.ownedColumnIntervals,
        expandedCameraFrame.validRoi ?? expandedRegionCamera.stableCrop,
      )
    : undefined;
  const expandedFrameAspect = captureFrameLongitudinalAspect(
    expandedCameraFrame,
    expandedSourceIntervals,
  );
  const frameSpanPx = expandedCamera && expandedFrameAspect
    ? Math.max(FRAME_SPAN_PX, scrollWindow.crossExtent * expandedFrameAspect)
    : FRAME_SPAN_PX;
  const alignmentKey = `${displayHeadAlignmentApplied
    ? `${headAlignment?.alignedTimelinePositionFrames ?? ''}:${maximumHeadPaddingFrames}:${HEAD_CONTEXT_FRAMES}`
    : ''}:tail=${detectedContentTailFrameIndex ?? longitudinalAxis?.endElapsedFromHeadMs ?? ''}`;
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
  // Keep only a short pre-head context in the rendered timeline. Applying the
  // origin to frame positions (instead of relying on scrollLeft) makes gray
  // and JET use exactly the same stable aligned window after mode switches.
  const timelineOriginFrames = Math.max(0, contentAnchorFrame - HEAD_CONTEXT_FRAMES);
  const naturalTimelineEndFrames = captureFrames.length + maximumHeadPaddingFrames;
  const measuredTailTimelineFrame = captureTailTimelineFrame(
    captureFrames,
    contentAnchorFrame,
    longitudinalAxis,
    headAlignment,
  );
  const detectedTailTimelineFrame = detectedContentTailFrameIndex === null
    ? measuredTailTimelineFrame
    : detectedContentTailFrameIndex + 1 + maximumHeadPaddingFrames;
  const tailDetectionSource = detectedContentTailFrameIndex !== null
    ? 'frame-density'
    : measuredTailTimelineFrame !== null ? 'measurement-timeline' : 'unavailable';
  const timelineEndFrames = detectedTailTimelineFrame === null
    ? naturalTimelineEndFrames
    : Math.min(naturalTimelineEndFrames, detectedTailTimelineFrame + TAIL_CONTEXT_FRAMES);
  const tailTrimApplied = timelineEndFrames < naturalTimelineEndFrames - 0.01;
  const longitudinalExtent = Math.max(
    frameSpanPx,
    (timelineEndFrames - timelineOriginFrames) * frameSpanPx,
  );
  const firstVisibleFrame = stitchEnabled
    ? Math.max(
      0,
      Math.floor(timelineOriginFrames + scrollWindow.offset / frameSpanPx - maximumHeadPaddingFrames)
      - FRAME_OVERSCAN,
    )
    : 0;
  const lastVisibleFrame = stitchEnabled
    ? Math.min(
      captureFrames.length,
      Math.ceil(timelineOriginFrames + (scrollWindow.offset + scrollWindow.extent) / frameSpanPx) + FRAME_OVERSCAN,
    )
    : 0;
  const visibleCaptureFrames = stitchEnabled
    ? captureFrames.slice(firstVisibleFrame, lastVisibleFrame)
    : [];
  const priorityFrameIndex = stitchEnabled
    ? Math.max(
      firstVisibleFrame,
      Math.min(
        Math.max(firstVisibleFrame, lastVisibleFrame - 1),
        Math.floor(timelineOriginFrames + (scrollWindow.offset + scrollWindow.extent / 2) / frameSpanPx),
      ),
    )
    : 0;
  const prefetchFrameIndexes = useMemo(
    () => stitchEnabled
      ? capturePrefetchFrameIndexes(
        captureFrames.length,
        firstVisibleFrame,
        lastVisibleFrame,
      )
      : [],
    [captureFrames.length, firstVisibleFrame, lastVisibleFrame, stitchEnabled],
  );
  const prefetchImageUrls = useMemo(() => {
    if (!stitchEnabled || prefetchFrameIndexes.length === 0) return [];
    const expandedCameraNumber = expandedCamera ? cameraIdentityNumber(expandedCamera) : null;
    const urls: string[] = [];
    prefetchFrameIndexes.forEach((frameIndex) => {
      const frame = captureFrames[frameIndex];
      if (!frame) return;
      frame.cameras.forEach((cameraFrame) => {
        const cameraNumber = cameraIdentityNumber(cameraFrame.cameraId);
        const level = expandedCameraNumber !== null && cameraNumber === expandedCameraNumber
          ? 'original'
          : 'thumbnail';
        urls.push(captureRenderImageUrl(
          cameraFrame.artifactRef,
          imageMode,
          level,
        ));
      });
    });
    return [...new Set(urls)].slice(0, CAPTURE_PREFETCH_MAX_IMAGES);
  }, [captureFrames, expandedCamera, imageMode, prefetchFrameIndexes, stitchEnabled]);

  useEffect(() => {
    if (prefetchImageUrls.length === 0) return undefined;
    // The scheduler starts from an idle callback (or a short delayed timer)
    // and uses low fetch priority, so visible canvases always win the network
    // slot. Cleanup cancels requests made irrelevant by scroll/record changes.
    return prefetchCaptureImageUrls(prefetchImageUrls, {
      maxUrls: CAPTURE_PREFETCH_MAX_IMAGES,
      delayMs: 160,
    });
  }, [prefetchImageUrls]);
  const scrollSpaceStyle: CSSProperties = stitchEnabled
    ? orientation === 'horizontal'
      ? { width: `max(100%, ${longitudinalExtent}px)`, height: '100%' }
      : { width: '100%', height: `max(100%, ${longitudinalExtent}px)` }
    : { width: '100%', height: '100%' };

  const toggleCameraAtPoint = useCallback((cameraId: string, clientX: number, clientY: number) => {
    const host = scrollRef.current;
    if (host && stitchEnabled) {
      const rect = host.getBoundingClientRect();
      const viewportExtent = orientation === 'horizontal' ? host.clientWidth : host.clientHeight;
      const pointerOffset = clampUnit(
        (orientation === 'horizontal' ? clientX - rect.left : clientY - rect.top)
          / Math.max(1, viewportExtent),
      ) * Math.max(1, viewportExtent);
      const scrollOffset = orientation === 'horizontal' ? host.scrollLeft : host.scrollTop;
      pendingZoomAnchorRef.current = {
        timelineFrame: timelineOriginFrames + (scrollOffset + pointerOffset) / frameSpanPx,
        viewportOffsetPx: pointerOffset,
      };
    }
    setExpandedCamera((current) => current === cameraId ? null : cameraId);
  }, [frameSpanPx, orientation, stitchEnabled, timelineOriginFrames]);

  useEffect(() => {
    const handleSpaceZoom = (event: globalThis.KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || event.defaultPrevented) return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.matches('input, textarea, select, button') || active?.isContentEditable) return;
      const pointer = mapPointerRef.current;
      if (!pointer) return;
      event.preventDefault();
      toggleCameraAtPoint(pointer.cameraId, pointer.clientX, pointer.clientY);
    };
    window.addEventListener('keydown', handleSpaceZoom);
    return () => window.removeEventListener('keydown', handleSpaceZoom);
  }, [toggleCameraAtPoint]);

  const readScrollPosition = () => {
    const host = scrollRef.current;
    if (!host) return;
    const offset = orientation === 'horizontal' ? host.scrollLeft : host.scrollTop;
    const extent = orientation === 'horizontal' ? host.clientWidth : host.clientHeight;
    const crossExtent = orientation === 'horizontal' ? host.clientHeight : host.clientWidth;
    const scrollExtent = orientation === 'horizontal' ? host.scrollWidth : host.scrollHeight;
    const maximum = Math.max(0, scrollExtent - extent);
    scrollProgressRef.current = maximum > 0 ? offset / maximum : 0;
    if (viewportMemory) {
      viewportMemory.current = {
        stitchKey,
        orientation,
        scrollProgress: scrollProgressRef.current,
      };
    }
    atTailRef.current = maximum <= 0 || maximum - offset <= Math.max(24, extent * 0.08);
    const nextExtent = Math.max(1, extent);
    const total = Math.max(nextExtent, scrollExtent, longitudinalExtent);
    const nextCrossExtent = Math.max(1, crossExtent);
    const visibleFraction = Math.min(1, nextExtent / Math.max(total, 1));
    const visibleStart = maximum > 0
      ? (offset / maximum) * (1 - visibleFraction)
      : 0;
    const visibleEnd = Math.min(1, visibleStart + visibleFraction);
    const nextVisibleRange = stitchEnabled && visibleFraction < 0.995
      ? [visibleStart, visibleEnd] as [number, number]
      : null;
    const visibleRangeKey = nextVisibleRange
      ? `${nextVisibleRange[0].toFixed(6)}:${nextVisibleRange[1].toFixed(6)}`
      : 'all';
    if (publishedVisibleRangeRef.current !== visibleRangeKey) {
      publishedVisibleRangeRef.current = visibleRangeKey;
      onVisibleRangeChange?.(nextVisibleRange);
    }
    setScrollWindow((current) => current.offset === offset
      && current.extent === nextExtent
      && current.total === total
      && current.crossExtent === nextCrossExtent
      ? current
      : { offset, extent: nextExtent, total, crossExtent: nextCrossExtent });
  };

  useEffect(() => () => {
    publishedVisibleRangeRef.current = '';
    onVisibleRangeChange?.(null);
  }, [onVisibleRangeChange]);

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
    const displayScaleChanged = previous.frameSpanPx !== frameSpanPx
      || previous.expandedCamera !== expandedCamera;
    const recordContentBecameReady = previous.frameCount === 0 && captureFrames.length > 0;
    const appendedAtTail = !recordChanged
      && previous.frameCount > 0
      && captureFrames.length > previous.frameCount
      && atTailRef.current;
    const retainedProgress = recordChanged || alignmentChanged
      ? 0
      : initialScrollProgressRef.current ?? scrollProgressRef.current;
    initialScrollProgressRef.current = null;
    previousLayoutRef.current = {
      orientation,
      stitchKey,
      frameCount: captureFrames.length,
      alignmentKey,
      frameSpanPx,
      expandedCamera,
    };
    const frame = window.requestAnimationFrame(() => {
      const extent = orientation === 'horizontal' ? host.clientWidth : host.clientHeight;
      const scrollExtent = orientation === 'horizontal' ? host.scrollWidth : host.scrollHeight;
      const maximum = Math.max(0, scrollExtent - extent);
      const zoomAnchor = displayScaleChanged ? pendingZoomAnchorRef.current : null;
      pendingZoomAnchorRef.current = null;
      const anchoredTarget = zoomAnchor
        ? Math.max(
            0,
            Math.min(
              maximum,
              (zoomAnchor.timelineFrame - timelineOriginFrames) * frameSpanPx
                - zoomAnchor.viewportOffsetPx,
            ),
          )
        : null;
      const target = appendedAtTail
        ? maximum
        : recordChanged || recordContentBecameReady || alignmentChanged
          ? 0
          : anchoredTarget ?? maximum * retainedProgress;
      if (orientation === 'horizontal') {
        host.scrollTop = 0;
        host.scrollLeft = target;
      } else {
        host.scrollLeft = 0;
        host.scrollTop = target;
      }
      if (orientationChanged
        || recordChanged
        || recordContentBecameReady
        || alignmentChanged
        || displayScaleChanged
        || appendedAtTail) readScrollPosition();
    });
    return () => window.cancelAnimationFrame(frame);
  // readScrollPosition is deliberately kept local so it always uses the
  // orientation committed by this render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alignmentKey, captureFrames.length, expandedCamera, frameSpanPx, orientation, stitchKey, timelineOriginFrames]);

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

  const handleMapPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!stitchEnabled || event.button !== 0) return;
    const target = event.target as HTMLElement;
    const cameraBand = target.closest<HTMLElement>('.bar-camera-band');
    const cameraId = cameraBand?.dataset.cameraId ?? null;
    if (cameraId) {
      mapPointerRef.current = { cameraId, clientX: event.clientX, clientY: event.clientY };
    }
    if (target.closest('button, input, select, textarea, a')) return;
    mapDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
      moved: false,
      cameraId,
    };
    setFrameDefectHover(null);
    setDepthProbe(null);
    setMapDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleMapPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const cameraBand = (event.target as HTMLElement).closest<HTMLElement>('.bar-camera-band');
    const cameraId = cameraBand?.dataset.cameraId;
    if (cameraId) {
      mapPointerRef.current = { cameraId, clientX: event.clientX, clientY: event.clientY };
    }
    const drag = mapDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = orientation === 'horizontal'
      ? event.clientX - drag.startX
      : event.clientY - drag.startY;
    if (Math.abs(delta) < MAP_DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    setFrameDefectHover(null);
    setDepthProbe(null);
    event.preventDefault();
    if (orientation === 'horizontal') {
      event.currentTarget.scrollLeft = drag.scrollLeft - delta;
    } else {
      event.currentTarget.scrollTop = drag.scrollTop - delta;
    }
    readScrollPosition();
  };

  const stopMapDragging = (event: PointerEvent<HTMLDivElement>) => {
    const drag = mapDragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    if (drag.moved) {
      event.preventDefault();
    }
    mapDragRef.current = null;
    setMapDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved && drag.cameraId) {
      const now = Date.now();
      const previousClick = cameraClickRef.current;
      const isDoubleClick = previousClick?.cameraId === drag.cameraId
        && now - previousClick.at <= 450
        && Math.hypot(event.clientX - previousClick.clientX, event.clientY - previousClick.clientY) <= 10;
      if (isDoubleClick) {
        cameraClickRef.current = null;
        suppressNativeDoubleClickUntilRef.current = now + 500;
        toggleCameraAtPoint(drag.cameraId, event.clientX, event.clientY);
      } else {
        cameraClickRef.current = {
          cameraId: drag.cameraId,
          at: now,
          clientX: event.clientX,
          clientY: event.clientY,
        };
      }
    }
  };

  return (
    <div
      className={`bar-unfolded-map orientation-${orientation} ${expandedCamera ? 'camera-expanded' : ''}`}
      data-testid="bar-unfolded-map"
      data-orientation={orientation}
      data-overlap-display-mode={deduplicateOverlap ? 'deduplicated' : 'overlap'}
      data-expanded-camera={expandedCamera || undefined}
      style={{ '--camera-count': cameraLanes.length } as CSSProperties}
    >
      <div
        ref={scrollRef}
        className={`bar-unfolded-canvas ${stitchEnabled ? 'has-stitch' : ''} ${mapDragging ? 'is-dragging' : ''}`}
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
        data-head-retained-context-frames={displayHeadAlignmentApplied ? HEAD_CONTEXT_FRAMES : undefined}
        data-timeline-origin-frames={timelineOriginFrames.toFixed(6)}
        data-tail-trim-applied={tailTrimApplied ? 'true' : 'false'}
        data-tail-detection-source={tailDetectionSource}
        data-tail-content-frame-index={detectedContentTailFrameIndex ?? undefined}
        data-tail-timeline-frame={detectedTailTimelineFrame?.toFixed(6)}
        data-tail-retained-context-frames={tailTrimApplied ? TAIL_CONTEXT_FRAMES : undefined}
        data-timeline-end-frames={timelineEndFrames.toFixed(6)}
        data-longitudinal-extent-px={longitudinalExtent.toFixed(3)}
        data-frame-span-px={frameSpanPx.toFixed(3)}
        data-frame-pixel-aspect={expandedFrameAspect?.toFixed(6)}
        data-expanded-preserve-aspect={expandedCamera ? 'true' : undefined}
        data-visible-range-start={scrollWindow.total > 1
          ? ((scrollWindow.offset / Math.max(1, scrollWindow.total - scrollWindow.extent))
            * (1 - Math.min(1, scrollWindow.extent / scrollWindow.total))).toFixed(6)
          : '0.000000'}
        data-visible-range-end={scrollWindow.total > 1
          ? Math.min(
              1,
              (scrollWindow.offset / Math.max(1, scrollWindow.total - scrollWindow.extent))
                * (1 - Math.min(1, scrollWindow.extent / scrollWindow.total))
                + Math.min(1, scrollWindow.extent / scrollWindow.total),
            ).toFixed(6)
          : '1.000000'}
        data-image-mode={imageMode}
        data-visible-frame-start={firstVisibleFrame}
        data-visible-frame-end={lastVisibleFrame}
        data-prefetch-frame-count={prefetchFrameIndexes.length}
        data-prefetch-image-count={prefetchImageUrls.length}
        style={{ '--preview-position': `${previewPercent}%` } as CSSProperties}
        onKeyDown={onDefectNavigationKeyDown}
        onScroll={readScrollPosition}
        onWheel={handleMapWheel}
        onPointerDown={handleMapPointerDown}
        onPointerMove={handleMapPointerMove}
        onPointerUp={stopMapDragging}
        onPointerCancel={stopMapDragging}
        onPointerLeave={() => {
          if (!mapDragRef.current) mapPointerRef.current = null;
        }}
      >
        <div className="bar-unfolded-scroll-space" data-testid="capture-stitch-scroll-space" style={scrollSpaceStyle}>
        <div className="bar-camera-bands">
          {cameraLanes.map((lane) => {
            const camera = surfaceCameras.find((item) => item.name.toLowerCase() === lane.cameraId);
            const regionCamera = captureRegionCamera(regionMap, lane.cameraId);
            const preview = camera?.relative.intensityPreview || camera?.latest.intensityPreview || '';
            const captureImage = captureImageByCamera.get(lane.cameraId);
            const laneNumber = cameraIdentityNumber(lane.cameraId) ?? cameraIdentityNumber(lane.shortLabel);
            const source = imageMode === 'gray' && !stitchEnabled
              ? preview ? barSurfaceFileUrl(preview) : captureImage?.url || ''
              : '';
            const expanded = expandedCamera === lane.cameraId;
            const cameraHead = headAlignmentCamera(headAlignment, lane.cameraId);
            const headOffsetFrames = Number(cameraHead?.offsetFramesFromReference);
            const displayPaddingFrames = displayHeadAlignmentApplied
              ? Math.max(0, Number(cameraHead?.displayPaddingFrames ?? 0))
              : 0;
            return <div
              key={lane.cameraId}
              className={`bar-camera-band ${source ? 'has-production-image' : ''} ${expanded ? 'is-expanded' : ''} ${expandedCamera && !expanded ? 'is-collapsed' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`${lane.cameraId} 采集图像${expanded ? '，已展开，双击恢复' : '，双击展开'}`}
              data-head-offset-frames={Number.isFinite(headOffsetFrames) ? headOffsetFrames.toFixed(6) : undefined}
              data-head-display-padding-frames={cameraHead?.displayAligned ? Number(cameraHead.displayPaddingFrames ?? 0).toFixed(6) : undefined}
              data-head-aligned={cameraHead?.displayAligned ? 'true' : 'false'}
              data-camera-id={lane.cameraId}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (Date.now() < suppressNativeDoubleClickUntilRef.current) return;
                toggleCameraAtPoint(lane.cameraId, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  toggleCameraAtPoint(
                    lane.cameraId,
                    rect.left + rect.width / 2,
                    rect.top + rect.height / 2,
                  );
                }
              }}
            >
              {source ? <CameraBandImage
                key={`record-preview:${stitchKey}:${lane.cameraId}`}
                src={source}
                label={lane.cameraId}
                orientation={orientation}
                contentLabel={imageMode === 'jet' ? '处理后 JET 图' : '实际裁剪图'}
                cropBlackBorders={imageMode === 'gray' && cropBlackBorders}
              /> : null}
              {stitchEnabled ? (
                <div className="bar-camera-band-strip" aria-label={`${lane.shortLabel} 裁剪拼接帧`}>
                  {visibleCaptureFrames.map((frame, visibleIndex) => {
                    const frameIndex = firstVisibleFrame + visibleIndex;
                    const cameraFrame = frame.cameras.find((item) => (
                      cameraIdentityNumber(item.cameraId) === laneNumber
                    ));
                    const frameDefects = defects.filter((defect) => (
                      cameraIdentityNumber(defect.cameraId ?? `C${defect.cameraIndex ?? ''}`) === laneNumber
                      && (defect.artifacts?.sequenceNo === frame.sequence
                        || defect.artifacts?.sequenceNo === cameraFrame?.storageIndex)
                    ));
                    const probeKey = `${frame.frameId}:${lane.cameraId}`;
                    const ownedSourceIntervals = deduplicateOverlap && cameraFrame && regionCamera
                      ? normalizeOwnedColumnIntervals(
                          regionCamera.ownedColumnIntervals,
                          cameraFrame.validRoi ?? regionCamera.stableCrop,
                        )
                      : undefined;
                    return <div
                      key={`${frame.frameId}:${lane.cameraId}`}
                      className={`bar-camera-frame ${cameraFrame ? 'has-production-image' : 'is-missing'}`}
                      data-frame-sequence={frame.sequence}
                      data-frame-storage-index={cameraFrame?.storageIndex}
                      data-camera-id={lane.shortLabel}
                      style={orientation === 'horizontal'
                        ? { left: (frameIndex + displayPaddingFrames - timelineOriginFrames) * frameSpanPx, width: frameSpanPx }
                        : { top: (frameIndex + displayPaddingFrames - timelineOriginFrames) * frameSpanPx, height: frameSpanPx }}
                      onPointerMove={cameraFrame ? (event) => {
                        if (mapDragging) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        const localX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
                        const localY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
                        const displayedPixel = mapFramePointerToCapturePixel({
                          localX,
                          localY,
                          displayWidth: rect.width,
                          displayHeight: rect.height,
                          sourceWidth: cameraFrame.sourceWidth,
                          sourceHeight: cameraFrame.sourceHeight,
                          validRoi: cameraFrame.validRoi,
                          orientation,
                        });
                        const restoredColumnRatio = ownedSourceIntervals?.length
                          ? restoreOwnedColumnRatio(displayedPixel.cropXRatio, ownedSourceIntervals)
                          : null;
                        const [cropLeft, , cropRight] = cameraFrame.validRoi
                          ?? [0, 0, cameraFrame.sourceWidth, cameraFrame.sourceHeight];
                        const cropWidth = Math.max(1, cropRight - cropLeft);
                        const pixel = restoredColumnRatio === null
                          ? displayedPixel
                          : {
                              ...displayedPixel,
                              cropXRatio: restoredColumnRatio,
                              sourceX: Math.max(
                                cropLeft,
                                Math.min(
                                  cropRight - 1,
                                  Math.round(cropLeft + restoredColumnRatio * (cropWidth - 1)),
                                ),
                              ),
                            };
                        setDepthProbe((current) => ({
                          key: probeKey,
                          cameraId: lane.shortLabel,
                          sequence: frame.sequence,
                          storageIndex: cameraFrame.storageIndex,
                          artifactRef: cameraFrame.artifactRef,
                          jetUrl: cameraFrame.jetThumbnailUrl,
                          clientX: event.clientX,
                          clientY: event.clientY,
                          localX,
                          localY,
                          ...pixel,
                          status: current?.key === probeKey
                            && current.sourceX === pixel.sourceX
                            && current.sourceY === pixel.sourceY
                            ? current.status
                            : 'loading',
                          relativeMm: current?.key === probeKey ? current.relativeMm : null,
                          rawValue: current?.key === probeKey ? current.rawValue : null,
                        }));
                      } : undefined}
                      onPointerLeave={() => {
                        setDepthProbe((current) => current?.key === probeKey ? null : current);
                      }}
                    >
                      {cameraFrame ? <CameraBandImage
                        src={imageMode === 'jet'
                          ? expanded ? cameraFrame.jetOriginalUrl : cameraFrame.jetThumbnailUrl
                          : expanded ? cameraFrame.grayOriginalUrl : cameraFrame.grayThumbnailUrl}
                        label={`${lane.shortLabel} 第 ${frame.sequence} 轮`}
                        orientation={orientation}
                        contentLabel={imageMode === 'jet' ? '逐帧 JET 图' : '2D 去背景图'}
                        sourceIntervals={ownedSourceIntervals}
                        cropBlackBorders={false}
                        loadDelayMs={frameIndex === priorityFrameIndex ? 0 : 250}
                      /> : <small>缺帧</small>}
                      {cameraFrame ? frameDefects.map((defect) => {
                        const rectStyle = defectFrameRectStyle(
                          defect,
                          cameraFrame,
                          orientation,
                          ownedSourceIntervals,
                        );
                        const type = defectTypes.find((item) => item.id === defect.typeId);
                        if (!rectStyle) return null;
                        return <button
                          key={defect.id}
                          type="button"
                          className={`defect-image-rect ${defect.id === selectedDefectId ? 'selected' : ''}`}
                          style={{ ...rectStyle, '--defect-color': type?.color ?? '#ff3b30' } as CSSProperties}
                          aria-label={`${defect.typeLabel}矩形标记，${lane.shortLabel} 文件序号 ${cameraFrame.storageIndex}`}
                          title={`${defect.typeLabel} · ${lane.shortLabel} · 同步轮 ${frame.sequence} · 文件序号 ${cameraFrame.storageIndex} · ROI ${defect.artifacts?.roi.width}×${defect.artifacts?.roi.height}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onDoubleClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelectDefect(defect.id);
                          }}
                          onPointerMove={(event) => event.stopPropagation()}
                          onMouseEnter={(event) => {
                            setDepthProbe(null);
                            setFrameDefectHover({
                              defectId: defect.id,
                              cameraId: lane.shortLabel,
                              frameSequence: frame.sequence,
                              storageIndex: cameraFrame.storageIndex,
                              imageUrl: imageMode === 'jet'
                                ? cameraFrame.jetOriginalUrl
                                : cameraFrame.grayOriginalUrl,
                              roi: defect.artifacts?.roi ?? { x: 0, y: 0, width: 0, height: 0 },
                              clientX: event.clientX,
                              clientY: event.clientY,
                            });
                            onHoverDefect(defect.id);
                          }}
                          onMouseMove={(event) => {
                            setFrameDefectHover((current) => current?.defectId === defect.id
                              ? { ...current, clientX: event.clientX, clientY: event.clientY }
                              : current);
                          }}
                          onMouseLeave={() => {
                            setFrameDefectHover((current) => current?.defectId === defect.id ? null : current);
                            onHoverDefect(null);
                          }}
                          onFocus={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            setFrameDefectHover({
                              defectId: defect.id,
                              cameraId: lane.shortLabel,
                              frameSequence: frame.sequence,
                              storageIndex: cameraFrame.storageIndex,
                              imageUrl: imageMode === 'jet'
                                ? cameraFrame.jetOriginalUrl
                                : cameraFrame.grayOriginalUrl,
                              roi: defect.artifacts?.roi ?? { x: 0, y: 0, width: 0, height: 0 },
                              clientX: rect.left + rect.width / 2,
                              clientY: rect.top + rect.height / 2,
                            });
                            onHoverDefect(defect.id);
                          }}
                          onBlur={() => {
                            setFrameDefectHover((current) => current?.defectId === defect.id ? null : current);
                            onHoverDefect(null);
                          }}
                        />;
                      }) : null}
                      {depthProbe?.key === probeKey ? (
                        <i
                          className="capture-depth-probe-crosshair"
                          aria-hidden="true"
                          style={{ left: depthProbe.localX, top: depthProbe.localY }}
                        />
                      ) : null}
                    </div>;
                  })}
                </div>
              ) : null}
              <span>{lane.shortLabel}</span>
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
        {!frameDefectHover && hoveredDefect && hoveredType ? (
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
        defects={defects}
        selectedDefectId={selectedDefectId}
        previewPositionM={previewPositionM}
        plateLengthM={plateLengthM}
        onPreviewPositionChange={onPreviewPositionChange}
        orientation={orientation}
        scrollMetrics={stitchEnabled ? scrollWindow : undefined}
        onScrollProgressChange={scrollToProgress}
        onSelectDefect={onSelectDefect}
      />
      {frameDefectHover && frameHoveredDefect && frameHoveredType ? createPortal(
        <DefectHoverCard
          defect={frameHoveredDefect}
          type={frameHoveredType}
          frameContext={frameDefectHover}
        />,
        document.body,
      ) : null}
      {depthProbe ? createPortal(
        <div
          className={`capture-depth-probe-tooltip mode-${rawDepthHeld ? 'raw' : 'relative'}`}
          role="status"
          aria-label="3D 深度探针"
          data-probe-mode={rawDepthHeld ? 'raw' : 'relative'}
          style={{
            left: Math.min(depthProbe.clientX + 14, Math.max(8, window.innerWidth - 226)),
            top: Math.min(depthProbe.clientY + 14, Math.max(8, window.innerHeight - 124)),
          }}
        >
          <strong>{rawDepthHeld ? 'T · 相机原始深度' : '相对拟合圆柱'}</strong>
          <b>{depthProbe.status === 'loading'
            ? '读取中…'
            : depthProbe.status === 'error'
              ? '深度数据不可用'
              : depthProbe.status === 'missing'
                ? '该点无有效 3D 值'
                : rawDepthHeld
                  ? `${Number.isInteger(depthProbe.rawValue) ? depthProbe.rawValue : depthProbe.rawValue?.toFixed(3)}`
                  : `${depthProbe.relativeMm != null && depthProbe.relativeMm >= 0 ? '+' : ''}${depthProbe.relativeMm?.toFixed(3)} mm`}</b>
          <span>测径</span>
          <b className="capture-depth-probe-diameter">{probeDiameterMm === null ? '--' : `${probeDiameterMm.toFixed(3)} mm`}</b>
          <span>{depthProbe.cameraId} · 帧 {depthProbe.sequence} / 文件 {depthProbe.storageIndex}</span>
          <span>源像素 {depthProbe.sourceX}, {depthProbe.sourceY}</span>
          <small>{rawDepthHeld ? '松开 T 返回圆柱偏差' : '按住 T 查看相机原始值'}</small>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function LengthRuler({
  defects,
  selectedDefectId,
  previewPositionM,
  plateLengthM,
  onPreviewPositionChange,
  orientation,
  scrollMetrics,
  onScrollProgressChange,
  onSelectDefect,
}: {
  defects: DefectItem[];
  selectedDefectId: string | null;
  previewPositionM: number;
  plateLengthM: number;
  onPreviewPositionChange: (positionM: number) => void;
  orientation: UnfoldOrientation;
  scrollMetrics?: { offset: number; extent: number; total: number };
  onScrollProgressChange?: (progress: number) => void;
  onSelectDefect: (defectId: string) => void;
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

  const handleRulerClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    updateFromPointer(event.clientX, event.clientY, event.currentTarget);
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
      onClick={handleRulerClick}
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
      <div className="ruler-defect-markers" aria-label={`缺陷位置标注，共 ${defects.length} 个`}>
        {defects.map((defect) => {
          const percent = getDefectLengthPercent(defect, safePlateLengthM);
          return <button
            key={defect.id}
            type="button"
            className={defect.id === selectedDefectId ? 'selected' : ''}
            style={orientation === 'horizontal' ? { left: `${percent}%` } : { top: `${percent}%` }}
            aria-label={`${defect.typeLabel}位置，距头${defect.distanceHeadMm}毫米`}
            title={`${defect.typeLabel} · ${defect.distanceHeadMm}mm`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelectDefect(defect.id);
            }}
          />;
        })}
      </div>
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
  overlapMode,
  showOverlapMode,
  overlapAvailable,
  overlapPairCount,
  overlapDuplicateFilteredCount,
  artifactOrientation,
  onThreeModeChange,
  onTwoDModeChange,
  onOverlapModeChange,
  onArtifactOrientationChange,
}: {
  viewMode: PlateMapViewMode;
  threeMode: Plate3DDisplayMode;
  twoDMode: Plate2DDisplayMode;
  overlapMode: OverlapDisplayMode;
  showOverlapMode: boolean;
  overlapAvailable: boolean;
  overlapPairCount: number | null;
  overlapDuplicateFilteredCount: number | null;
  artifactOrientation: ArtifactOrientation;
  onThreeModeChange: (mode: Plate3DDisplayMode) => void;
  onTwoDModeChange: (mode: Plate2DDisplayMode) => void;
  onOverlapModeChange: (mode: OverlapDisplayMode) => void;
  onArtifactOrientationChange: (orientation: ArtifactOrientation) => void;
}) {
  if (viewMode === '3d') {
    const options: Array<{ id: Plate3DDisplayMode; label: string }> = [
      { id: 'surface', label: '表面' },
      { id: 'points', label: '点云' },
      { id: 'texture', label: '灰度贴图' },
      { id: 'jet', label: 'JET贴图' },
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
      <>
        <div className="plate-display-submodes" role="group" aria-label="2D 显示子模式">
          <button type="button" className={twoDMode === 'gray' ? 'active' : ''} aria-pressed={twoDMode === 'gray'} onClick={() => onTwoDModeChange('gray')}>灰度</button>
          <button type="button" className={twoDMode === 'jet' ? 'active jet' : 'jet'} aria-pressed={twoDMode === 'jet'} onClick={() => onTwoDModeChange('jet')}>Jet</button>
        </div>
        {showOverlapMode ? <>
          <div className="overlap-display-switch" role="group" aria-label="重叠区域显示模式">
            <button
              type="button"
              className={overlapMode === 'overlap' ? 'active' : ''}
              aria-pressed={overlapMode === 'overlap'}
              onClick={() => onOverlapModeChange('overlap')}
            >
              保留重叠
            </button>
            <button
              type="button"
              className={overlapMode === 'deduplicated' ? 'active' : ''}
              aria-pressed={overlapMode === 'deduplicated'}
              disabled={!overlapAvailable}
              title={overlapAvailable ? '仅显示每台相机负责的标定区域' : '当前记录缺少完整、有效的相机区域归属'}
              onClick={() => onOverlapModeChange('deduplicated')}
            >
              去除重叠
            </button>
          </div>
          <div
            className={`overlap-count-summary ${overlapAvailable ? 'is-ready' : 'is-unavailable'}`}
            role="status"
            aria-label={`重叠统计：重叠区 ${overlapPairCount ?? '不可用'}，去重候选 ${overlapDuplicateFilteredCount ?? '不可用'}`}
          >
            <span>重叠区 <strong>{overlapPairCount ?? '--'}</strong></span>
            <i aria-hidden="true" />
            <span>去重候选 <strong>{overlapDuplicateFilteredCount ?? '--'}</strong></span>
          </div>
        </> : null}
      </>
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
  surfaceMeasurement,
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
  const [overlapDisplayMode, setOverlapDisplayMode] = useState<OverlapDisplayMode>('overlap');
  const [artifactOrientation, setArtifactOrientation] = useState<ArtifactOrientation>('horizontal');
  const [productionZoom, setProductionZoom] = useState(1);
  const twoDViewportMemory = useRef<TwoDViewportMemory>({ stitchKey: '', orientation: 'horizontal', scrollProgress: 0 });
  const [hoveredDefectId, setHoveredDefectId] = useState<string | null>(null);
  const [unfoldOrientation, setUnfoldOrientation] = useState<UnfoldOrientation>('horizontal');
  const [displayedWorld, setDisplayedWorld] = useState<DisplayWorld | null>(null);
  const displayedWorldRef = useRef<DisplayWorld | null>(null);
  const [pendingWorld, setPendingWorld] = useState<DisplayWorld | null>(null);
  const [worldTileProgress, setWorldTileProgress] = useState<InspectionWorldTileLoading | null>(null);
  const [worldLoading, setWorldLoading] = useState(false);
  const [worldUnavailable, setWorldUnavailable] = useState(false);
  const [worldError, setWorldError] = useState('');
  const captureTextureRequested = viewMode === '3d'
    && (threeDisplayMode === 'texture' || threeDisplayMode === 'jet');
  const cameraLaneIds = useMemo(
    () => cameraLanes.map((lane) => lane.shortLabel),
    [cameraLanes],
  );
  const captureStitchEligible = artifactMode === 'production'
    && (viewMode === '2d' || captureTextureRequested)
    && !requireInspectionWorld
    && Boolean(captureMaterialId?.trim());
  const overlapFeatureVisible = artifactMode === 'production'
    && !requireInspectionWorld
    && Boolean(captureMaterialId?.trim());
  const captureStitchState = useCaptureStitchHistory(
    captureMaterialId,
    cameraLaneIds,
    captureStitchEligible,
    refreshCaptureRoi,
  );
  const captureOverlapState = useCaptureOverlapData(
    captureMaterialId,
    overlapFeatureVisible && (viewMode === '2d' || captureTextureRequested),
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
  const captureRegionMap = captureOverlapState.materialId === captureMaterialId?.trim()
    ? captureOverlapState.regionMap
    : null;
  const overlapPairCount = captureRegionMap?.ownership.ready
    ? captureRegionMap.ownership.overlapPairCount ?? captureRegionMap.ownership.pairs.length
    : null;
  const overlapDuplicateFilteredCount = captureOverlapState.materialId === captureMaterialId?.trim()
    ? captureOverlapState.duplicateFilteredCount
    : null;
  const overlapAvailable = Boolean(
    captureRegionMap?.ownership.ready
    && cameraLanes.length > 0
    && cameraLanes.every((lane) => {
      const camera = captureRegionCamera(captureRegionMap, lane.cameraId);
      return camera?.state === 'ready'
        && normalizeOwnedColumnIntervals(camera.ownedColumnIntervals, camera.stableCrop).length > 0;
    }),
  );
  const effectiveOverlapDisplayMode = overlapAvailable ? overlapDisplayMode : 'overlap';
  // Production 2D display is stitch-only. A per-camera raw PNG has no timeline
  // extent, so rendering it while the indexed stitch is loading creates a
  // convincing but non-scrollable first screen. Keep single-frame fallback
  // strictly outside production and wait for the record-bound stitch instead.
  const allowSingleFrameImageFallback = artifactMode !== 'production';
  const displayedCaptureImages: CaptureImageItem[] = [];
  const displayedSurfaceCameras = allowSingleFrameImageFallback ? surfaceCameras : [];
  const productionCameraImageCount = displayedSurfaceCameras.filter((camera) => Boolean(camera.relative.intensityPreview || camera.latest.intensityPreview)).length;
  const capturedCameraImageCount = new Set(
    captureStitchResult?.frames.flatMap((frame) => frame.cameras.map((camera) => camera.cameraId))
      ?? displayedCaptureImages.filter((image) => image.dataName.toLowerCase() === 'intensity').map((image) => image.cameraId),
  ).size;
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
  const captureTextureModality: CaptureTextureModality = threeDisplayMode === 'jet' ? 'jet' : 'gray';
  const captureTextureEnabled = artifactMode === 'production'
    && captureTextureRequested
    && !requireInspectionWorld
    && Boolean(captureMaterialId?.trim());
  const captureTexture = useCaptureCylinderTexture(
    captureMaterialId,
    captureStitchResult?.frames ?? [],
    cameraLaneIds,
    captureRegionMap,
    surfaceCameraTiles,
    surfaceHeadAlignment,
    captureTextureModality,
    captureTextureEnabled,
  );
  const worldTexture = useInspectionWorldTexture(
    inspectionId,
    displayedWorld?.meta,
    artifactMode === 'production'
      && viewMode === '3d'
      && threeDisplayMode === 'texture'
      && !captureTextureEnabled,
    productionZoom,
  );
  const textureUrl = captureTextureEnabled ? captureTexture.textureUrl : worldTexture.textureUrl;
  const textureStatus = captureTextureEnabled ? captureTexture.textureStatus : worldTexture.textureStatus;
  const captureTextureReady = captureTextureEnabled && Boolean(captureTexture.textureUrl);
  useEffect(() => {
    displayedWorldRef.current = displayedWorld;
  }, [displayedWorld]);
  useEffect(() => {
    setWorldUnavailable(false);
    setWorldError('');
    setPendingWorld(null);
    setWorldTileProgress(null);
    if (displayedWorldRef.current?.recordId !== inspectionId) {
      // Record identity is a strict rendering boundary. Never keep record A's
      // canvas mounted while the surrounding UI already refers to record B.
      displayedWorldRef.current = null;
      setDisplayedWorld(null);
    }
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
          : `生产记录 ${inspectionId || '未绑定'}：数据库采集产物 ${captureImages.length} 件；两级缓存图像 ${displayedCameraImageCount}/${cameraLanes.length} 路。`}
      </div>}
      {viewMode === '2d' && (!shouldRenderWorldStack || twoDDisplayMode === 'jet') ? (
        <div className="unfold-orientation-switch" role="group" aria-label="二维展开方向">
          <button type="button" className={unfoldOrientation === 'horizontal' ? 'active' : ''} aria-pressed={unfoldOrientation === 'horizontal'} onClick={() => setUnfoldOrientation('horizontal')}>横向</button>
          <button type="button" className={unfoldOrientation === 'vertical' ? 'active' : ''} aria-pressed={unfoldOrientation === 'vertical'} onClick={() => setUnfoldOrientation('vertical')}>纵向</button>
        </div>
      ) : null}
      {integratedToolbar ? <PlateMapActions viewMode={viewMode} onViewModeChange={setViewMode} /> : null}
      <PlateDisplaySubModes
        viewMode={viewMode}
        threeMode={threeDisplayMode}
        twoDMode={twoDDisplayMode}
        overlapMode={effectiveOverlapDisplayMode}
        showOverlapMode={overlapFeatureVisible}
        overlapAvailable={overlapAvailable}
        overlapPairCount={overlapPairCount}
        overlapDuplicateFilteredCount={overlapDuplicateFilteredCount}
        artifactOrientation={artifactOrientation}
        onThreeModeChange={setThreeDisplayMode}
        onTwoDModeChange={setTwoDDisplayMode}
        onOverlapModeChange={setOverlapDisplayMode}
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
                  ? '当前检测记录去重灰度贴图三维表面'
                  : threeDisplayMode === 'jet'
                    ? captureTextureEnabled
                      ? '当前检测记录去重 JET 贴图三维表面'
                      : '当前检测记录 Jet 径向偏差三维表面'
                    : '当前检测记录真实三维表面'}
              className="plate-production-artifact"
              colorMode={threeDisplayMode === 'jet'
                ? captureTextureReady ? 'texture' : 'radial-jet'
                : threeDisplayMode === 'texture'
                  ? 'texture'
                  : threeDisplayMode === 'surface'
                    ? 'neutral'
                    : 'source'}
              textureUrl={textureUrl}
              textureModality={captureTextureEnabled ? captureTextureModality : undefined}
              textureMetrics={captureTexture.texturePlan ? {
                longitudinalPixels: captureTexture.texturePlan.longitudinalPixels,
                circumferencePixels: captureTexture.texturePlan.circumferencePixels,
                pixelAspectRatio: captureTexture.texturePlan.pixelAspectRatio,
                overlapPolicy: captureTexture.texturePlan.overlapPolicy,
                projectionPolicy: captureTexture.texturePlan.projectionPolicy,
              } : undefined}
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
      ) : captureStitchResult?.frames.length && (twoDDisplayMode === 'jet' || !shouldRenderWorldStack) ? (
        <div
          className={`bar-unfolded-layout orientation-${unfoldOrientation}`}
          data-testid={twoDDisplayMode === 'jet' ? 'surface-jet-unfolded' : 'surface-gray-unfolded'}
          data-image-source={`per-frame-two-level-${twoDDisplayMode}`}
        >
          {twoDDisplayMode === 'gray' && artifactMode === 'production' && worldUnavailable ? <span className="live-preview-badge" data-testid="capture-roi-status">
            {`${captureStitchResult.hasMore ? '最近 ' : ''}${captureStitchResult.frames.length}/${captureStitchResult.totalFrames} 轮对齐拼接 · 两级可重建图像 ${captureStitchResult.renderableImageCount}`}
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
            surfaceCameras={displayedSurfaceCameras}
            captureImages={displayedCaptureImages}
            captureFrames={captureStitchResult.frames}
            stitchKey={captureMaterialId?.trim() || inspectionId || ''}
            cameraLanes={cameraLanes}
            imageMode={twoDDisplayMode}
            headAlignment={surfaceHeadAlignment}
            regionMap={captureRegionMap}
            deduplicateOverlap={effectiveOverlapDisplayMode === 'deduplicated'}
            measurement={surfaceMeasurement}
            longitudinalAxis={surfaceMesh?.longitudinalAxis}
            viewportMemory={twoDViewportMemory}
            onVisibleRangeChange={onVisibleRangeChange}
          />
        </div>
      ) : twoDDisplayMode === 'jet' ? (
        <div className={`production-artifact-empty${artifactLoading ? ' is-loading' : ''}`} role="status" data-testid="surface-jet-unfolded-empty">
          <strong>{artifactLoading ? '正在准备处理后 JET 图像' : '暂无可用的处理后 JET 图像'}</strong>
          <span>{artifactStatus || '逐帧 JET 使用与 2D 去背景完全一致的裁剪和六相机对齐；缓存缺失时从原始 3D 重建。'}</span>
        </div>
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
              ? `${captureStitchResult.hasMore ? '最近 ' : ''}${captureStitchResult.frames.length}/${captureStitchResult.totalFrames} 轮对齐拼接 · 两级可重建图像 ${captureStitchResult.renderableImageCount}`
              : captureStitchPending
                ? '拼接缓存准备中 · 正在校验索引并从原图按需重建'
                : '当前记录缺少可重建的拼接原图'}
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
            surfaceCameras={displayedSurfaceCameras}
            captureImages={displayedCaptureImages}
            captureFrames={captureStitchResult?.frames ?? []}
            stitchKey={captureMaterialId?.trim() || inspectionId || ''}
            cameraLanes={cameraLanes}
            headAlignment={surfaceHeadAlignment}
            regionMap={captureRegionMap}
            deduplicateOverlap={effectiveOverlapDisplayMode === 'deduplicated'}
            measurement={surfaceMeasurement}
            longitudinalAxis={surfaceMesh?.longitudinalAxis}
            cropBlackBorders
            viewportMemory={twoDViewportMemory}
            onVisibleRangeChange={onVisibleRangeChange}
          />
        </div>
      )}
      {viewMode === '3d'
        && (threeDisplayMode === 'texture' || (threeDisplayMode === 'jet' && captureTextureEnabled))
        && textureStatus ? (
        <div className="plate-texture-status" role="status">{textureStatus}</div>
      ) : null}
    </Panel>
  );
}
