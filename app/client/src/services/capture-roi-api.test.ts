import { describe, expect, it } from 'vitest';
import type {
  CaptureHistoryCameraFrame,
  CaptureHistoryFrame,
  CaptureHistoryResult,
} from '../lib/capture-api';
import { isNumericCaptureFlowId, selectCaptureRoiPreviews, selectCaptureStitchHistory } from './capture-roi-api';

function camera(
  cameraIndex: number,
  bytes: number,
  overrides: Partial<CaptureHistoryCameraFrame> = {},
): CaptureHistoryCameraFrame {
  return {
    cameraId: `C${cameraIndex}`,
    cameraIndex,
    ip: `192.168.10${cameraIndex}.100`,
    artifactRef: `2747/capture/C${cameraIndex}/2d/${cameraIndex}.png`,
    storageIndex: cameraIndex,
    captureRound: 100,
    width: 2560,
    height: 1024,
    playbackWidth: 600,
    playbackHeight: 1024,
    validRoi: [100, 0, 700, 1024],
    sourceSize: [2560, 1024],
    displaySize: [600, 1024],
    sourceOffset: { x: 100, y: 0 },
    regionState: 'ready',
    bytes,
    storedAt: '2026-08-24T02:00:00.000Z',
    ...overrides,
  };
}

function frame(sequence: number, cameras: CaptureHistoryCameraFrame[]): CaptureHistoryFrame {
  return {
    frameId: `2747:${String(sequence).padStart(12, '0')}`,
    materialId: '2747',
    sequence,
    capturedAt: '2026-08-24T02:00:00.000Z',
    cameras,
  };
}

function history(frames: CaptureHistoryFrame[], indexed = true): CaptureHistoryResult {
  return {
    code: 0,
    storageRoot: 'D:\\steel-sick-data',
    total: frames.length,
    count: frames.length,
    hasMore: false,
    indexed,
    frames,
  };
}

describe('capture ROI preview selection', () => {
  it('accepts only pure numeric flow identifiers', () => {
    expect(isNumericCaptureFlowId('2747')).toBe(true);
    expect(isNumericCaptureFlowId(' 2747 ')).toBe(true);
    expect(isNumericCaptureFlowId('FLOW-2747')).toBe(false);
    expect(isNumericCaptureFlowId('INSP-unknown-material-1')).toBe(false);
  });

  it('selects one synchronized information-rich six-camera indexed frame', () => {
    const quiet = frame(10, Array.from({ length: 6 }, (_, index) => camera(index + 1, 25_000)));
    const visible = frame(11, Array.from({ length: 6 }, (_, index) => camera(index + 1, 600_000, {
      artifactRef: `2747/capture/C${index + 1}/2d/80.png`,
      storageIndex: 80,
    })));
    const incomplete = frame(12, Array.from({ length: 5 }, (_, index) => camera(index + 1, 900_000)));

    const result = selectCaptureRoiPreviews(
      history([quiet, visible, incomplete]),
      '2747',
      ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
    );

    expect(result).toMatchObject({
      materialId: '2747',
      indexed: true,
      representativeFrameId: visible.frameId,
      expectedCameraCount: 6,
      complete: true,
    });
    expect(result?.images).toHaveLength(6);
    expect(new Set(result?.images.map((image) => image.sourceFrameId))).toEqual(new Set([visible.frameId]));
    expect(result?.images[0]).toMatchObject({
      cameraId: 'C1',
      sequenceNo: 80,
      validRoi: [100, 0, 700, 1024],
    });
    expect(result?.images[0].url).toContain(
      '/api/capture/render?path=2747%2Fcapture%2FC1%2F2d%2F80.png&modality=gray&level=original',
    );
    const previewUrl = new URL(result!.images[0].url);
    expect(Object.fromEntries(previewUrl.searchParams)).toMatchObject({
      modality: 'gray',
      level: 'original',
    });
  });

  it('fills only transport-gap camera slots from another indexed frame', () => {
    const primary = frame(20, [camera(1, 500_000), camera(2, 500_000)]);
    const gapFill = frame(19, [camera(3, 450_000)]);
    const result = selectCaptureRoiPreviews(history([gapFill, primary]), '2747', ['C1', 'C2', 'C3']);

    expect(result?.representativeFrameId).toBe(primary.frameId);
    expect(result?.complete).toBe(true);
    expect(result?.images.map((image) => image.sourceFrameId)).toEqual([
      primary.frameId,
      primary.frameId,
      gapFill.frameId,
    ]);
  });

  it('rejects raw scans and entries without a stable ready ROI', () => {
    const raw = history([frame(1, [camera(1, 1000)])], false);
    const missingRoi = history([frame(1, [camera(1, 1000, { validRoi: undefined })])]);
    const blocked = history([frame(1, [camera(1, 1000, { regionState: 'background-missing' })])]);

    expect(selectCaptureRoiPreviews(raw, '2747', ['C1'])).toBeNull();
    expect(selectCaptureRoiPreviews(missingRoi, '2747', ['C1'])).toBeNull();
    expect(selectCaptureRoiPreviews(blocked, '2747', ['C1'])).toBeNull();
  });

  it('rejects invalid bounds and artifacts that are not indexed 2D PNG frames', () => {
    const negative = history([frame(1, [camera(1, 1000, { validRoi: [-1, 0, 700, 1024] })])]);
    const outside = history([frame(1, [camera(1, 1000, { validRoi: [100, 0, 2561, 1024] })])]);
    const wrongArtifact = history([frame(1, [camera(1, 1000, {
      artifactRef: '2747/capture/C1/3d/1.npz',
    })])]);

    expect(selectCaptureRoiPreviews(negative, '2747', ['C1'])).toBeNull();
    expect(selectCaptureRoiPreviews(outside, '2747', ['C1'])).toBeNull();
    expect(selectCaptureRoiPreviews(wrongArtifact, '2747', ['C1'])).toBeNull();
  });
});

describe('capture crop-stitch history selection', () => {
  it('keeps every current-material sequence in order and leaves camera gaps unfilled', () => {
    const otherMaterial: CaptureHistoryFrame = {
      ...frame(2, [camera(1, 1000)]),
      frameId: 'other:000000000002',
      materialId: 'other',
    };
    const result = selectCaptureStitchHistory(
      history([
        frame(3, [camera(1, 1000), camera(3, 1000)]),
        otherMaterial,
        frame(1, [camera(1, 1000), camera(2, 1000), camera(3, 1000)]),
      ]),
      '2747',
      ['C1', 'C2', 'C3'],
    );

    expect(result.frames.map((item) => item.sequence)).toEqual([1, 3]);
    expect(result.frames[1].cameras.map((item) => item.cameraId)).toEqual(['C1', 'C3']);
    expect(result.frames.flatMap((item) => item.cameras)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ artifactRef: expect.stringContaining('other/') })]),
    );
  });

  it('keeps raw-rebuild sources renderable even when legacy ROI metadata is unavailable', () => {
    const result = selectCaptureStitchHistory(
      history([frame(7, [
        camera(1, 2000),
        camera(2, 1800, { validRoi: undefined, regionState: 'background-missing' }),
      ])]),
      '2747',
      ['C1', 'C2'],
    );

    expect(result).toMatchObject({
      materialId: '2747',
      expectedCameraCount: 2,
      renderableImageCount: 2,
    });
    expect(result.frames[0].cameras[0].sourceBytes).toBe(2000);
    expect(result.frames[0].cameras[0]).toMatchObject({
      displaySize: [600, 1024],
      sourceOffset: { x: 100, y: 0 },
    });
    expect(result.frames[0].cameras[0].url).toContain('modality=gray');
    expect(result.frames[0].cameras[0].url).toContain('level=thumbnail');
    expect(result.frames[0].cameras[1]).toMatchObject({ validRoi: null });
    expect(result.frames[0].cameras[1].url).toContain('level=thumbnail');
    expect(result.frames[0].cameras[1].url).not.toContain('/api/capture/file');
  });

  it('deduplicates repeated sequences before reporting image counts and exposes the 500-frame cap', () => {
    const duplicateSparse = frame(8, [camera(1, 1000)]);
    const duplicateComplete = {
      ...frame(8, [camera(1, 1000), camera(2, 1000, { validRoi: undefined })]),
      frameId: '2747:duplicate-complete',
    };
    const source = history([duplicateSparse, duplicateComplete]);
    source.total = 700;
    source.hasMore = true;

    const result = selectCaptureStitchHistory(source, '2747', ['C1', 'C2']);

    expect(result.frames).toHaveLength(1);
    expect(result.frames[0].frameId).toBe('2747:duplicate-complete');
    expect(result.renderableImageCount).toBe(2);
    expect(result).toMatchObject({ totalFrames: 700, hasMore: true });
  });
});
