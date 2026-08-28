import type {
  CaptureFlowSurface,
  CaptureRegionCamera,
  CaptureRegionMap,
  CaptureSurfaceCameraTiles,
} from './capture-api';
import {
  getRememberedCaptureImage,
  rememberCaptureImage,
} from './capture-image-prefetch';
import type {
  CaptureStitchCameraFrame,
  CaptureStitchFrame,
} from '../services/capture-roi-api';

export type CaptureTextureModality = 'gray' | 'jet';
export type NormalizedColumnInterval = [number, number];

export type CaptureCylinderTextureBand = {
  cameraId: string;
  circumferenceOffsetPixels: number;
  circumferencePixels: number;
};

export type CaptureCylinderTextureTile = {
  cameraId: string;
  frameSequence: number;
  url: string;
  longitudinalOffsetPixels: number;
  longitudinalPixels: number;
  segments: Array<{
    sourceInterval: NormalizedColumnInterval;
    circumferenceOffsetPixels: number;
    circumferencePixels: number;
    reverseSourceColumns: boolean;
  }>;
};

export type CaptureCylinderTexturePlan = {
  modality: CaptureTextureModality;
  overlapPolicy: 'owned-columns-concatenated';
  projectionPolicy: 'calibrated-angle-columns';
  pixelAspectRatio: 1;
  frameCount: number;
  cameraCount: number;
  missingCameraFrameCount: number;
  longitudinalPixels: number;
  circumferencePixels: number;
  lengthDiameterRatio: number;
  canvasWidth: number;
  canvasHeight: number;
  rasterScale: number;
  timelineOriginFrames: number;
  bands: CaptureCylinderTextureBand[];
  tiles: CaptureCylinderTextureTile[];
  cacheKey: string;
};

export type CaptureCylinderTextureResult = {
  blob: Blob;
  plan: CaptureCylinderTexturePlan;
};

const MAXIMUM_TEXTURE_DIMENSION = 8192;
const MAXIMUM_TEXTURE_PIXELS = 24 * 1024 * 1024;
const TEXTURE_LOAD_CONCURRENCY = 8;
const HEAD_CONTEXT_FRAMES = 0.35;

type CalibratedColumn = {
  cameraId: string;
  absoluteSourceColumn: number;
  angleDeg: number;
};

type CalibratedProjectionSegment = {
  cameraId: string;
  absoluteSourceLeft: number;
  absoluteSourceRight: number;
  circumferenceOffsetPixels: number;
  circumferencePixels: number;
  reverseSourceColumns: boolean;
};

function cameraIdentityNumber(value: string | number | null | undefined) {
  const match = String(value ?? '').trim().match(/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function sameCamera(left: string | number | null | undefined, right: string | number | null | undefined) {
  const leftNumber = cameraIdentityNumber(left);
  const rightNumber = cameraIdentityNumber(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber === rightNumber;
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
}

function captureRegionCamera(regionMap: CaptureRegionMap, cameraId: string) {
  return Object.values(regionMap.cameras).find((camera) => (
    sameCamera(camera.cameraId, cameraId)
  )) ?? null;
}

function captureSurfaceCameraTile(
  surfaceCameraTiles: CaptureSurfaceCameraTiles,
  cameraId: string,
) {
  return surfaceCameraTiles.cameras.find((camera) => sameCamera(camera.cameraId, cameraId)) ?? null;
}

function captureFrameCamera(frame: CaptureStitchFrame, cameraId: string) {
  return frame.cameras.find((camera) => sameCamera(camera.cameraId, cameraId)) ?? null;
}

function headAlignmentCamera(
  headAlignment: CaptureFlowSurface['headAlignment'] | null | undefined,
  cameraId: string,
) {
  if (!headAlignment?.cameras) return null;
  return Object.entries(headAlignment.cameras).find(([key]) => sameCamera(key, cameraId))?.[1] ?? null;
}

function validCropBox(value: readonly number[] | null | undefined) {
  if (!value || value.length !== 4 || !value.every(Number.isFinite)) return null;
  const [left, top, right, bottom] = value.map(Number);
  return right > left && bottom > top ? [left, top, right, bottom] as const : null;
}

export function normalizeOwnedColumnIntervals(
  intervals: readonly number[][] | undefined,
  cropBox: readonly number[] | null | undefined,
): NormalizedColumnInterval[] {
  const crop = validCropBox(cropBox);
  if (!crop || !intervals) return [];
  const cropLeft = crop[0];
  const cropRight = crop[2];
  const cropWidth = cropRight - cropLeft;
  const normalized = intervals.flatMap((interval): NormalizedColumnInterval[] => {
    if (!Array.isArray(interval) || interval.length !== 2 || !interval.every(Number.isFinite)) return [];
    const left = Math.max(cropLeft, Math.min(cropRight, Number(interval[0])));
    const right = Math.max(cropLeft, Math.min(cropRight, Number(interval[1])));
    return right > left ? [[(left - cropLeft) / cropWidth, (right - cropLeft) / cropWidth]] : [];
  }).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: NormalizedColumnInterval[] = [];
  normalized.forEach(([left, right]) => {
    const previous = merged.at(-1);
    if (previous && left <= previous[1] + 1e-6) {
      previous[1] = Math.max(previous[1], right);
    } else {
      merged.push([left, right]);
    }
  });
  return merged;
}

function normalizeAngleDeg(value: number) {
  return ((value % 360) + 360) % 360;
}

function columnIsOwned(camera: CaptureRegionCamera, absoluteSourceColumn: number) {
  const center = absoluteSourceColumn + 0.5;
  return camera.ownedColumnIntervals.some((interval) => (
    Array.isArray(interval)
    && interval.length === 2
    && interval.every(Number.isFinite)
    && center >= Number(interval[0])
    && center < Number(interval[1])
  ));
}

function interpolateCircularColumnAngles(values: readonly (number | null)[]) {
  const finite = values.flatMap((rawAngle, index) => (
    typeof rawAngle === 'number' && Number.isFinite(rawAngle)
      ? [{ index, angleDeg: normalizeAngleDeg(rawAngle) }]
      : []
  ));
  if (finite.length < 2) return null;

  const unwrapped: Array<{ index: number; angleDeg: number; unwrappedAngleDeg: number }> = [];
  finite.forEach((entry, index) => {
    if (index === 0) {
      unwrapped.push({ ...entry, unwrappedAngleDeg: entry.angleDeg });
      return;
    }
    const previous = unwrapped[index - 1];
    const delta = ((entry.angleDeg - previous.angleDeg + 540) % 360) - 180;
    unwrapped.push({
      ...entry,
      unwrappedAngleDeg: previous.unwrappedAngleDeg + delta,
    });
  });
  const firstSlope = (
    unwrapped[1].unwrappedAngleDeg - unwrapped[0].unwrappedAngleDeg
  ) / Math.max(1, unwrapped[1].index - unwrapped[0].index);
  const last = unwrapped.length - 1;
  const lastSlope = (
    unwrapped[last].unwrappedAngleDeg - unwrapped[last - 1].unwrappedAngleDeg
  ) / Math.max(1, unwrapped[last].index - unwrapped[last - 1].index);
  const result = new Array<number>(values.length);
  let nextFinite = 0;
  for (let index = 0; index < values.length; index += 1) {
    while (nextFinite < unwrapped.length && unwrapped[nextFinite].index < index) nextFinite += 1;
    const after = unwrapped[nextFinite];
    const before = unwrapped[nextFinite - 1];
    let angleDeg: number;
    if (after?.index === index) {
      angleDeg = after.unwrappedAngleDeg;
    } else if (before && after) {
      const ratio = (index - before.index) / (after.index - before.index);
      angleDeg = before.unwrappedAngleDeg
        + (after.unwrappedAngleDeg - before.unwrappedAngleDeg) * ratio;
    } else if (after) {
      angleDeg = after.unwrappedAngleDeg - firstSlope * (after.index - index);
    } else {
      angleDeg = before.unwrappedAngleDeg + lastSlope * (index - before.index);
    }
    result[index] = normalizeAngleDeg(angleDeg);
  }
  return result;
}

function buildCalibratedProjection(
  cameraIds: readonly string[],
  regionMap: CaptureRegionMap,
  surfaceCameraTiles: CaptureSurfaceCameraTiles,
) {
  const columns: CalibratedColumn[] = [];
  for (const cameraId of cameraIds) {
    const region = captureRegionCamera(regionMap, cameraId);
    const surfaceTile = captureSurfaceCameraTile(surfaceCameraTiles, cameraId);
    const crop = validCropBox(surfaceTile?.cropBox);
    const angles = surfaceTile?.angleDegByColumn;
    const calibratedAngles = angles ? interpolateCircularColumnAngles(angles) : null;
    if (
      region?.state !== 'ready'
      || surfaceTile?.state !== 'ready'
      || !crop
      || !calibratedAngles?.length
      || Math.abs((crop[2] - crop[0]) - calibratedAngles.length) > 1
    ) return null;

    let cameraColumnCount = 0;
    calibratedAngles.forEach((angleDeg, localColumn) => {
      const absoluteSourceColumn = crop[0] + localColumn;
      if (!columnIsOwned(region, absoluteSourceColumn)) return;
      columns.push({
        cameraId,
        absoluteSourceColumn,
        angleDeg: normalizeAngleDeg(angleDeg),
      });
      cameraColumnCount += 1;
    });
    if (cameraColumnCount === 0) return null;
  }
  if (columns.length === 0) return null;

  // Preserve one square texture pixel per owned source column. Sorting all
  // columns by calibrated angle establishes camera order and source direction
  // without losing pixels to quantization collisions. Ownership filtering
  // happens first, so overlap cameras never contribute twice. Missing angles
  // are circularly interpolated above.
  columns.sort((left, right) => (
    left.angleDeg - right.angleDeg
    || left.cameraId.localeCompare(right.cameraId)
    || left.absoluteSourceColumn - right.absoluteSourceColumn
  ));
  const circumferencePixels = columns.length;
  const bins = columns;

  const segments: CalibratedProjectionSegment[] = [];
  let binIndex = 0;
  while (binIndex < bins.length) {
    const first = bins[binIndex];
    let sourceStep = 0;
    let endBin = binIndex + 1;
    while (endBin < bins.length) {
      const next = bins[endBin];
      if (!sameCamera(first.cameraId, next.cameraId)) break;
      const previous = bins[endBin - 1];
      const nextStep = next.absoluteSourceColumn - previous.absoluteSourceColumn;
      if (Math.abs(Math.abs(nextStep) - 1) > 1e-6) break;
      if (sourceStep === 0) sourceStep = nextStep;
      if (Math.abs(nextStep - sourceStep) > 1e-6) break;
      endBin += 1;
    }
    const last = bins[endBin - 1];
    segments.push({
      cameraId: first.cameraId,
      absoluteSourceLeft: Math.min(first.absoluteSourceColumn, last.absoluteSourceColumn),
      absoluteSourceRight: Math.max(first.absoluteSourceColumn, last.absoluteSourceColumn) + 1,
      circumferenceOffsetPixels: binIndex,
      circumferencePixels: endBin - binIndex,
      reverseSourceColumns: sourceStep < 0,
    });
    binIndex = endBin;
  }

  if (cameraIds.some((cameraId) => !segments.some((segment) => sameCamera(
    segment.cameraId,
    cameraId,
  )))) return null;
  return { circumferencePixels, segments };
}

function cameraImageUrl(camera: CaptureStitchCameraFrame, modality: CaptureTextureModality) {
  return modality === 'jet' ? camera.jetOriginalUrl : camera.grayOriginalUrl;
}

function planRasterSize(longitudinalPixels: number, circumferencePixels: number) {
  const rasterScale = Math.min(
    1,
    MAXIMUM_TEXTURE_DIMENSION / Math.max(1, longitudinalPixels),
    MAXIMUM_TEXTURE_DIMENSION / Math.max(1, circumferencePixels),
    Math.sqrt(MAXIMUM_TEXTURE_PIXELS / Math.max(1, longitudinalPixels * circumferencePixels)),
  );
  return {
    rasterScale,
    canvasWidth: Math.max(1, Math.round(longitudinalPixels * rasterScale)),
    canvasHeight: Math.max(1, Math.round(circumferencePixels * rasterScale)),
  };
}

function stableTexturePlanHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function displayPaddingPixels(
  headAlignment: CaptureFlowSurface['headAlignment'] | null | undefined,
  cameraId: string,
  frameLongitudinalPixels: number,
) {
  const camera = headAlignmentCamera(headAlignment, cameraId);
  const rows = Number(camera?.displayPaddingRows);
  if (Number.isFinite(rows)) return Math.max(0, rows);
  const frames = Number(camera?.displayPaddingFrames);
  return Number.isFinite(frames) ? Math.max(0, frames * frameLongitudinalPixels) : 0;
}

export function buildCaptureCylinderTexturePlan({
  materialId,
  frames,
  cameraIds,
  regionMap,
  surfaceCameraTiles,
  headAlignment,
  modality,
}: {
  materialId: string;
  frames: readonly CaptureStitchFrame[];
  cameraIds: readonly string[];
  regionMap: CaptureRegionMap | null | undefined;
  surfaceCameraTiles: CaptureSurfaceCameraTiles | null | undefined;
  headAlignment?: CaptureFlowSurface['headAlignment'] | null;
  modality: CaptureTextureModality;
}): CaptureCylinderTexturePlan | null {
  if (
    !materialId.trim()
    || frames.length === 0
    || cameraIds.length === 0
    || !regionMap?.ownership.ready
    || !surfaceCameraTiles
  ) {
    return null;
  }

  const cameraRegions = cameraIds.map((cameraId) => ({
    cameraId,
    region: captureRegionCamera(regionMap, cameraId),
  }));
  if (cameraRegions.some(({ region }) => region?.state !== 'ready')) return null;
  const projection = buildCalibratedProjection(cameraIds, regionMap, surfaceCameraTiles);
  if (!projection) return null;
  const { circumferencePixels } = projection;
  const bands: CaptureCylinderTextureBand[] = cameraIds.map((cameraId) => {
    const cameraSegments = projection.segments.filter((segment) => sameCamera(
      segment.cameraId,
      cameraId,
    ));
    return {
      cameraId,
      circumferenceOffsetPixels: Math.min(...cameraSegments.map(
        (segment) => segment.circumferenceOffsetPixels,
      )),
      circumferencePixels: cameraSegments.reduce(
        (total, segment) => total + segment.circumferencePixels,
        0,
      ),
    };
  });

  const frameLongitudinalPixels = Math.max(
    1,
    ...frames.flatMap((frame) => frame.cameras.map((camera) => {
      const crop = validCropBox(camera.validRoi);
      return crop ? crop[3] - crop[1] : Math.max(1, camera.sourceHeight);
    })),
  );
  const alignmentReady = Boolean(
    headAlignment?.displayAligned
    && cameraIds.every((cameraId) => {
      const camera = headAlignmentCamera(headAlignment, cameraId);
      return Number.isFinite(Number(camera?.displayPaddingRows))
        || Number.isFinite(Number(camera?.displayPaddingFrames));
    }),
  );
  const maximumHeadPaddingPixels = alignmentReady
    ? Math.max(0, ...cameraIds.map((cameraId) => displayPaddingPixels(
      headAlignment,
      cameraId,
      frameLongitudinalPixels,
    )))
    : 0;
  const alignedTimelinePosition = Number(headAlignment?.alignedTimelinePositionFrames);
  const firstCaptureSequence = Number(frames[0]?.sequence);
  const timelineOriginFrames = alignmentReady
    && Number.isFinite(alignedTimelinePosition)
    && Number.isFinite(firstCaptureSequence)
    ? Math.max(0, alignedTimelinePosition - firstCaptureSequence - HEAD_CONTEXT_FRAMES)
    : 0;
  const longitudinalPixels = Math.max(
    1,
    Math.ceil(
      frames.length * frameLongitudinalPixels
      + maximumHeadPaddingPixels
      - timelineOriginFrames * frameLongitudinalPixels,
    ),
  );
  const { rasterScale, canvasWidth, canvasHeight } = planRasterSize(
    longitudinalPixels,
    circumferencePixels,
  );

  let missingCameraFrameCount = 0;
  const tiles: CaptureCylinderTextureTile[] = [];
  frames.forEach((frame, frameIndex) => {
    cameraIds.forEach((cameraId) => {
      const camera = captureFrameCamera(frame, cameraId);
      const region = captureRegionCamera(regionMap, cameraId);
      if (!camera || !region) {
        missingCameraFrameCount += 1;
        return;
      }
      const frameCrop = validCropBox(camera.validRoi ?? region.stableCrop);
      const url = cameraImageUrl(camera, modality).trim();
      if (!frameCrop || !url) {
        missingCameraFrameCount += 1;
        return;
      }
      const segments = projection.segments.flatMap((segment) => {
        if (!sameCamera(segment.cameraId, cameraId)) return [];
        const clippedLeft = Math.max(frameCrop[0], segment.absoluteSourceLeft);
        const clippedRight = Math.min(frameCrop[2], segment.absoluteSourceRight);
        if (clippedRight <= clippedLeft) return [];
        const sourceWidth = frameCrop[2] - frameCrop[0];
        const clippedPixels = clippedRight - clippedLeft;
        const clippedLeadingPixels = segment.reverseSourceColumns
          ? segment.absoluteSourceRight - clippedRight
          : clippedLeft - segment.absoluteSourceLeft;
        return [{
          sourceInterval: [
            (clippedLeft - frameCrop[0]) / sourceWidth,
            (clippedRight - frameCrop[0]) / sourceWidth,
          ] as NormalizedColumnInterval,
          circumferenceOffsetPixels: segment.circumferenceOffsetPixels + clippedLeadingPixels,
          circumferencePixels: Math.min(segment.circumferencePixels, clippedPixels),
          reverseSourceColumns: segment.reverseSourceColumns,
        }];
      });
      if (segments.length === 0) {
        missingCameraFrameCount += 1;
        return;
      }
      const paddingPixels = alignmentReady
        ? displayPaddingPixels(headAlignment, cameraId, frameLongitudinalPixels)
        : 0;
      tiles.push({
        cameraId,
        frameSequence: frame.sequence,
        url,
        longitudinalOffsetPixels: (frameIndex - timelineOriginFrames) * frameLongitudinalPixels
          + paddingPixels,
        longitudinalPixels: frameLongitudinalPixels,
        segments,
      });
    });
  });
  if (tiles.length === 0) return null;

  const frameSignature = frames.map((frame) => [
    frame.sequence,
    ...cameraIds.map((cameraId) => {
      const camera = captureFrameCamera(frame, cameraId);
      return camera
        ? [
            cameraId,
            camera.storageIndex,
            camera.artifactRef,
            camera.sourceWidth,
            camera.sourceHeight,
            cameraImageUrl(camera, modality),
            camera.validRoi?.join(','),
          ].join(',')
        : `${cameraId},missing`;
    }),
  ].join('~')).join('|');
  const projectionSignature = projection.segments.map((segment) => [
    segment.cameraId,
    segment.absoluteSourceLeft,
    segment.absoluteSourceRight,
    segment.circumferenceOffsetPixels,
    segment.circumferencePixels,
    Number(segment.reverseSourceColumns),
  ].join(',')).join('|');
  const tileSignature = tiles.map((tile) => [
    tile.cameraId,
    tile.frameSequence,
    tile.longitudinalOffsetPixels.toFixed(4),
    tile.longitudinalPixels,
    ...tile.segments.map((segment) => [
      segment.sourceInterval.join(','),
      segment.circumferenceOffsetPixels,
      segment.circumferencePixels,
      Number(segment.reverseSourceColumns),
    ].join('/')),
  ].join('~')).join('|');
  const cacheKey = [
    materialId.trim(),
    modality,
    regionMap.calibration.sha256,
    stableTexturePlanHash(frameSignature),
    stableTexturePlanHash(projectionSignature),
    stableTexturePlanHash(tileSignature),
    timelineOriginFrames.toFixed(4),
    maximumHeadPaddingPixels.toFixed(4),
    canvasWidth,
    canvasHeight,
  ].join(':');

  return {
    modality,
    overlapPolicy: 'owned-columns-concatenated',
    projectionPolicy: 'calibrated-angle-columns',
    pixelAspectRatio: 1,
    frameCount: frames.length,
    cameraCount: bands.length,
    missingCameraFrameCount,
    longitudinalPixels,
    circumferencePixels,
    lengthDiameterRatio: Math.PI * longitudinalPixels / circumferencePixels,
    canvasWidth,
    canvasHeight,
    rasterScale,
    timelineOriginFrames,
    bands,
    tiles,
    cacheKey,
  };
}

function loadCaptureTextureImageOnce(url: string, signal: AbortSignal) {
  const remembered = getRememberedCaptureImage(url);
  if (remembered) return Promise.resolve(remembered);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const abort = () => {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute?.('src');
      reject(new DOMException('Texture loading aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.fetchPriority = 'low';
    image.onload = () => {
      signal.removeEventListener('abort', abort);
      rememberCaptureImage(url, image);
      resolve(image);
    };
    image.onerror = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('去重贴图图像解码失败'));
    };
    image.src = url;
  });
}

function abortableDelay(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Texture loading aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function loadCaptureTextureImage(url: string, signal: AbortSignal) {
  const retryDelays = [0, 180, 600, 1_400];
  let lastError: unknown = null;
  for (const retryDelay of retryDelays) {
    if (retryDelay > 0) await abortableDelay(retryDelay, signal);
    if (signal.aborted) throw new DOMException('Texture loading aborted', 'AbortError');
    try {
      return await loadCaptureTextureImageOnce(url, signal);
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('去重贴图图像解码失败');
}

function drawTextureTile(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  tile: CaptureCylinderTextureTile,
  scale: number,
) {
  const destinationX = tile.longitudinalOffsetPixels * scale;
  const destinationWidth = tile.longitudinalPixels * scale;
  tile.segments.forEach((segment) => {
    const [left, right] = segment.sourceInterval;
    const sourceX = left * image.naturalWidth;
    const sourceWidth = (right - left) * image.naturalWidth;
    const destinationY = segment.circumferenceOffsetPixels * scale;
    const destinationHeight = segment.circumferencePixels * scale;
    if (sourceWidth <= 0 || destinationHeight <= 0 || image.naturalHeight <= 0) return;
    context.save();
    context.setTransform(
      0,
      (segment.reverseSourceColumns ? -1 : 1) * destinationHeight / sourceWidth,
      destinationWidth / image.naturalHeight,
      0,
      destinationX,
      segment.reverseSourceColumns ? destinationY + destinationHeight : destinationY,
    );
    context.drawImage(
      image,
      sourceX,
      0,
      sourceWidth,
      image.naturalHeight,
      0,
      0,
      sourceWidth,
      image.naturalHeight,
    );
    context.restore();
  });
}

export async function composeCaptureCylinderTexture(
  plan: CaptureCylinderTexturePlan,
  signal: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
): Promise<CaptureCylinderTextureResult> {
  const canvas = document.createElement('canvas');
  canvas.width = plan.canvasWidth;
  canvas.height = plan.canvasHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持去重贴图合成');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#050a0e';
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < plan.tiles.length; index += TEXTURE_LOAD_CONCURRENCY) {
    if (signal.aborted) throw new DOMException('Texture loading aborted', 'AbortError');
    const batch = plan.tiles.slice(index, index + TEXTURE_LOAD_CONCURRENCY);
    await Promise.all(batch.map(async (tile) => {
      const image = await loadCaptureTextureImage(tile.url, signal);
      if (!signal.aborted) drawTextureTile(context, image, tile, plan.rasterScale);
    }));
    onProgress?.(Math.min(index + batch.length, plan.tiles.length), plan.tiles.length);
  }

  if (signal.aborted) throw new DOMException('Texture loading aborted', 'AbortError');
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('去重贴图编码失败');
  return { blob, plan };
}
