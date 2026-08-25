import type { CaptureImageItem } from '../data/inspection';
import {
  captureArtifactImageUrl,
  captureHistoryImageUrl,
  readCaptureHistory,
  type CaptureHistoryCameraFrame,
  type CaptureHistoryFrame,
  type CaptureHistoryResult,
} from '../lib/capture-api';

const NUMERIC_FLOW_ID = /^\d+$/;

export type CaptureRoiPreviewImage = CaptureImageItem & {
  validRoi: [number, number, number, number];
  sourceFrameId: string;
  sourceFrameSequence: number;
  sourceWidth: number;
  sourceHeight: number;
};

export type CaptureRoiPreviewResult = {
  materialId: string;
  indexed: true;
  totalFrames: number;
  representativeFrameId: string;
  expectedCameraCount: number;
  complete: boolean;
  images: CaptureRoiPreviewImage[];
};

export type CaptureStitchCameraFrame = {
  cameraId: string;
  cameraIp: string;
  artifactRef: string;
  frameSequence: number;
  storageIndex: number;
  sourceWidth: number;
  sourceHeight: number;
  validRoi: [number, number, number, number] | null;
  url: string;
  cropMode: 'algorithm-roi' | 'auto-black-border';
};

export type CaptureStitchFrame = {
  frameId: string;
  sequence: number;
  capturedAt: string;
  cameras: CaptureStitchCameraFrame[];
};

export type CaptureStitchResult = {
  materialId: string;
  indexed: boolean;
  totalFrames: number;
  hasMore: boolean;
  expectedCameraCount: number;
  algorithmRoiImageCount: number;
  autoCropImageCount: number;
  frames: CaptureStitchFrame[];
};

type EligibleCamera = {
  frame: CaptureHistoryFrame;
  camera: CaptureHistoryCameraFrame;
  canonicalId: string;
  roi: [number, number, number, number];
  density: number;
};

function canonicalCameraId(value: string) {
  const match = value.trim().match(/(?:camera|camimagesource|c)?[-_ ]?(\d+)$/i);
  return match ? `C${Number(match[1])}` : value.trim().toUpperCase();
}

function validRoi(
  value: number[] | undefined,
  sourceWidth: number,
  sourceHeight: number,
): [number, number, number, number] | null {
  if (!value || value.length !== 4 || !value.every(Number.isFinite)) return null;
  const [left, top, right, bottom] = value.map((item) => Math.round(item));
  return left >= 0
    && top >= 0
    && right > left
    && bottom > top
    && right <= sourceWidth
    && bottom <= sourceHeight
    ? [left, top, right, bottom]
    : null;
}

function eligibleCamera(
  frame: CaptureHistoryFrame,
  camera: CaptureHistoryCameraFrame,
): EligibleCamera | null {
  const artifactRef = camera.artifactRef.trim().replaceAll('\\', '/');
  const roi = validRoi(camera.validRoi, camera.width, camera.height);
  if (
    !roi
    || camera.regionState !== 'ready'
    || !/(?:^|\/)capture\/[^/]+\/2d\/[^/]+\.png$/i.test(artifactRef)
  ) return null;
  const pixels = Math.max(1, (roi[2] - roi[0]) * (roi[3] - roi[1]));
  return {
    frame,
    camera,
    canonicalId: canonicalCameraId(camera.cameraId),
    roi,
    density: Math.max(0, camera.bytes) / pixels,
  };
}

function compareCameraQuality(left: EligibleCamera, right: EligibleCamera) {
  return left.density - right.density
    || left.camera.bytes - right.camera.bytes
    || left.frame.sequence - right.frame.sequence;
}

function camerasForFrame(
  frame: CaptureHistoryFrame,
  expected: ReadonlySet<string>,
) {
  const unique = new Map<string, EligibleCamera>();
  frame.cameras.forEach((camera) => {
    const candidate = eligibleCamera(frame, camera);
    if (!candidate || (expected.size > 0 && !expected.has(candidate.canonicalId))) return;
    const current = unique.get(candidate.canonicalId);
    if (!current || compareCameraQuality(candidate, current) > 0) {
      unique.set(candidate.canonicalId, candidate);
    }
  });
  return [...unique.values()];
}

function compareFrameQuality(left: EligibleCamera[], right: EligibleCamera[]) {
  const leftMinimum = left.length ? Math.min(...left.map((item) => item.density)) : 0;
  const rightMinimum = right.length ? Math.min(...right.map((item) => item.density)) : 0;
  const leftTotal = left.reduce((total, item) => total + item.density, 0);
  const rightTotal = right.reduce((total, item) => total + item.density, 0);
  return left.length - right.length
    || leftMinimum - rightMinimum
    || leftTotal - rightTotal
    || (left[0]?.frame.sequence ?? 0) - (right[0]?.frame.sequence ?? 0);
}

function compareStitchCameraQuality(
  left: CaptureHistoryCameraFrame,
  right: CaptureHistoryCameraFrame,
) {
  const leftReady = left.regionState === 'ready'
    && validRoi(left.validRoi, left.width, left.height) !== null;
  const rightReady = right.regionState === 'ready'
    && validRoi(right.validRoi, right.width, right.height) !== null;
  return Number(leftReady) - Number(rightReady)
    || Number(left.bytes || 0) - Number(right.bytes || 0);
}

/**
 * Builds a strict, record-bound line-scan timeline. Every sequence remains a
 * synchronized slot across all configured cameras; a missing camera is left
 * missing instead of being borrowed from another sequence or material.
 */
export function selectCaptureStitchHistory(
  history: CaptureHistoryResult,
  materialId: string,
  expectedCameraIds: readonly string[],
): CaptureStitchResult {
  const normalizedMaterialId = materialId.trim();
  const expectedOrder = expectedCameraIds
    .map(canonicalCameraId)
    .filter((cameraId, index, values) => cameraId && values.indexOf(cameraId) === index);
  const expected = new Set(expectedOrder);
  const bySequence = new Map<number, CaptureStitchFrame>();

  history.frames
    .filter((frame) => frame.materialId.trim() === normalizedMaterialId)
    .sort((left, right) => left.sequence - right.sequence
      || left.capturedAt.localeCompare(right.capturedAt))
    .forEach((frame) => {
      const selected = new Map<string, CaptureHistoryCameraFrame>();
      frame.cameras.forEach((camera) => {
        const cameraId = canonicalCameraId(camera.cameraId);
        if (!cameraId || (expected.size > 0 && !expected.has(cameraId))) return;
        if (!/(?:^|\/)capture\/[^/]+\/2d\/[^/]+\.png$/i.test(camera.artifactRef.trim().replaceAll('\\', '/'))) return;
        const current = selected.get(cameraId);
        if (!current || compareStitchCameraQuality(camera, current) > 0) {
          selected.set(cameraId, camera);
        }
      });
      const order = expectedOrder.length > 0
        ? expectedOrder
        : [...selected.keys()].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
      const cameras = order.flatMap((cameraId) => {
        const camera = selected.get(cameraId);
        if (!camera) return [];
        const roi = camera.regionState === 'ready'
          ? validRoi(camera.validRoi, camera.width, camera.height)
          : null;
        return [{
          cameraId,
          cameraIp: camera.ip,
          artifactRef: camera.artifactRef,
          frameSequence: frame.sequence,
          storageIndex: camera.storageIndex ?? frame.sequence,
          sourceWidth: camera.width,
          sourceHeight: camera.height,
          validRoi: roi,
          url: roi
            ? captureHistoryImageUrl(camera.artifactRef, 2048, roi)
            : captureArtifactImageUrl(camera.artifactRef, 2048),
          cropMode: roi ? 'algorithm-roi' as const : 'auto-black-border' as const,
        }];
      });
      const candidate: CaptureStitchFrame = {
        frameId: frame.frameId,
        sequence: frame.sequence,
        capturedAt: frame.capturedAt,
        cameras,
      };
      const current = bySequence.get(frame.sequence);
      if (!current || candidate.cameras.length >= current.cameras.length) {
        bySequence.set(frame.sequence, candidate);
      }
    });

  const frames = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  const cameraFrames = frames.flatMap((frame) => frame.cameras);
  const algorithmRoiImageCount = cameraFrames.filter((camera) => camera.cropMode === 'algorithm-roi').length;
  const autoCropImageCount = cameraFrames.length - algorithmRoiImageCount;
  return {
    materialId: normalizedMaterialId,
    indexed: history.indexed === true,
    totalFrames: Math.max(frames.length, Number(history.total || 0)),
    hasMore: history.hasMore === true || Number(history.total || 0) > frames.length,
    expectedCameraCount: expectedOrder.length,
    algorithmRoiImageCount,
    autoCropImageCount,
    frames,
  };
}

export function isNumericCaptureFlowId(value: string | undefined): value is string {
  return Boolean(value?.trim() && NUMERIC_FLOW_ID.test(value.trim()));
}

/**
 * Selects a synchronized, information-rich frame from the algorithm-produced
 * playback index. If that frame has a transport gap, only the missing camera
 * slots are filled from their best indexed frame; raw history scans are never
 * accepted because they do not carry a stable ROI.
 */
export function selectCaptureRoiPreviews(
  history: CaptureHistoryResult,
  materialId: string,
  expectedCameraIds: readonly string[],
): CaptureRoiPreviewResult | null {
  const normalizedMaterialId = materialId.trim();
  if (!isNumericCaptureFlowId(normalizedMaterialId) || history.indexed !== true) return null;
  const expectedOrder = expectedCameraIds.map(canonicalCameraId);
  const expected = new Set(expectedOrder);
  const frames = history.frames.filter((frame) => frame.materialId === normalizedMaterialId);
  const frameCandidates = frames
    .map((frame) => camerasForFrame(frame, expected))
    .filter((items) => items.length > 0)
    .sort(compareFrameQuality);
  const representative = frameCandidates.at(-1);
  if (!representative) return null;

  const selected = new Map(representative.map((item) => [item.canonicalId, item]));
  const bestByCamera = new Map<string, EligibleCamera>();
  frames.forEach((frame) => {
    camerasForFrame(frame, expected).forEach((candidate) => {
      const current = bestByCamera.get(candidate.canonicalId);
      if (!current || compareCameraQuality(candidate, current) > 0) {
        bestByCamera.set(candidate.canonicalId, candidate);
      }
    });
  });
  bestByCamera.forEach((candidate, cameraId) => {
    if (!selected.has(cameraId)) selected.set(cameraId, candidate);
  });
  const order = expectedOrder.length > 0
    ? expectedOrder
    : [...selected.keys()].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const selectedImages = order
    .map((cameraId) => selected.get(cameraId))
    .filter((item): item is EligibleCamera => Boolean(item));
  if (selectedImages.length === 0) return null;

  const sourceFrame = representative[0].frame;
  return {
    materialId: normalizedMaterialId,
    indexed: true,
    totalFrames: history.total,
    representativeFrameId: sourceFrame.frameId,
    expectedCameraCount: expectedOrder.length,
    complete: expectedOrder.length > 0 && selectedImages.length === expectedOrder.length,
    images: selectedImages.map(({ frame, camera, canonicalId, roi }) => ({
      id: `capture-roi:${normalizedMaterialId}:${canonicalId}:${frame.sequence}`,
      cameraId: canonicalId,
      cameraIp: camera.ip,
      dataName: 'intensity',
      sequenceNo: camera.storageIndex ?? frame.sequence,
      fileType: 'png',
      path: camera.artifactRef,
      url: captureHistoryImageUrl(camera.artifactRef, 2048, roi),
      createdAt: camera.storedAt || frame.capturedAt,
      validRoi: roi,
      sourceFrameId: frame.frameId,
      sourceFrameSequence: frame.sequence,
      sourceWidth: camera.width,
      sourceHeight: camera.height,
    })),
  };
}

export async function fetchCaptureRoiPreviews(
  materialId: string,
  expectedCameraIds: readonly string[],
): Promise<CaptureRoiPreviewResult | null> {
  const normalizedMaterialId = materialId.trim();
  if (!isNumericCaptureFlowId(normalizedMaterialId)) return null;
  const history = await readCaptureHistory(500, normalizedMaterialId);
  return selectCaptureRoiPreviews(history, normalizedMaterialId, expectedCameraIds);
}

export async function fetchCaptureStitchHistory(
  materialId: string,
  expectedCameraIds: readonly string[],
): Promise<CaptureStitchResult> {
  const normalizedMaterialId = materialId.trim();
  const history = await readCaptureHistory(500, normalizedMaterialId);
  return selectCaptureStitchHistory(history, normalizedMaterialId, expectedCameraIds);
}
