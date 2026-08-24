import type { CaptureImageItem } from '../data/inspection';
import {
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

function validRoi(value: number[] | undefined): [number, number, number, number] | null {
  if (!value || value.length !== 4 || !value.every(Number.isFinite)) return null;
  const [left, top, right, bottom] = value.map((item) => Math.round(item));
  return right > left && bottom > top ? [left, top, right, bottom] : null;
}

function eligibleCamera(
  frame: CaptureHistoryFrame,
  camera: CaptureHistoryCameraFrame,
): EligibleCamera | null {
  const roi = validRoi(camera.validRoi);
  if (!roi || camera.regionState !== 'ready' || !camera.artifactRef.trim()) return null;
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
      url: captureHistoryImageUrl(camera.artifactRef, 2048),
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
