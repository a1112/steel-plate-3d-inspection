import { describe, expect, it } from 'vitest';
import type { CaptureRegionMap, CaptureSurfaceCameraTiles } from './capture-api';
import type { CaptureStitchFrame } from '../services/capture-roi-api';
import {
  buildCaptureCylinderTexturePlan,
  normalizeOwnedColumnIntervals,
} from './capture-cylinder-texture';

function regionMap(materialId: string): CaptureRegionMap {
  return {
    schema: 'steel.capture-region-map.v1',
    materialId,
    state: 'ready',
    backgroundReady: true,
    defectDetectionAllowed: true,
    qualityGate: { passed: true, reasons: [] },
    calibration: { revision: 'cal-1', approved: true, sha256: 'a'.repeat(64) },
    ownership: { ready: true, reasons: [], overlapPairCount: 6, pairs: [] },
    cameras: Object.fromEntries(Array.from({ length: 6 }, (_, index) => {
      const cameraId = `C${index + 1}`;
      return [cameraId, {
        cameraId,
        state: 'ready',
        sourceSize: [2560, 1024],
        stableCrop: [100, 0, 700, 1024],
        sourceOffset: { x: 100, y: 0 },
        displaySize: [600, 1024],
        ownedColumnIntervals: [[100, 550]],
        overlapColumnIntervals: [[500, 700]],
      }];
    })),
  };
}

const CALIBRATED_COLUMNS_PER_CAMERA = 600;
const OWNED_COLUMNS_PER_CAMERA = 450;

function surfaceCameraTiles(): CaptureSurfaceCameraTiles {
  return {
    schema: 'steel.ranger3-camera-jet-tiles.v1',
    coordinateSpace: 'camera-crop-columns',
    angleConvention: 'clockwise-degrees-0-360',
    rowOrder: 'head-to-tail',
    cameras: Array.from({ length: 6 }, (_, index) => {
      const cameraId = `C${index + 1}`;
      const lowerAngle = index * 60;
      const upperAngle = (index + 1) * 60;
      const reverseColumns = index % 2 === 1;
      return {
        cameraId,
        state: 'ready',
        fixedAngleDeg: lowerAngle + 30,
        sourceShape: [1024, 2560],
        cropBox: [100, 0, 700, 1024],
        sourceOffset: { x: 100, y: 0 },
        rows: 30,
        columns: CALIBRATED_COLUMNS_PER_CAMERA,
        coordinateLayout: 'row-major-camera-crop',
        angleDegByColumn: Array.from(
          { length: CALIBRATED_COLUMNS_PER_CAMERA },
          (_unused, column) => {
            const angleOffset = (column + 0.5) * 60 / OWNED_COLUMNS_PER_CAMERA;
            return reverseColumns
              ? upperAngle - angleOffset
              : lowerAngle + angleOffset;
          },
        ),
        coverage: {
          ownedAngleIntervalsDeg: [[lowerAngle, upperAngle]],
          ownedColumnIntervals: [[100, 550]],
          overlapColumnIntervals: [[500, 700]],
        },
      };
    }),
  };
}

function frames(materialId: string, frameCount: number): CaptureStitchFrame[] {
  return Array.from({ length: frameCount }, (_, frameIndex) => {
    const sequence = frameIndex + 1;
    return {
      frameId: `${materialId}:${sequence}`,
      sequence,
      capturedAt: '2026-08-28T10:00:00Z',
      cameras: Array.from({ length: 6 }, (_unused, cameraIndex) => {
        const cameraId = `C${cameraIndex + 1}`;
        const base = `http://127.0.0.1:4873/api/capture/render?path=${cameraId}-${sequence}`;
        return {
          cameraId,
          cameraIp: `192.168.10${cameraIndex + 1}.100`,
          artifactRef: `${materialId}/capture/${cameraId}/2d/${sequence}.png`,
          frameSequence: sequence,
          storageIndex: sequence,
          sourceWidth: 2560,
          sourceHeight: 1024,
          validRoi: [100, 0, 700, 1024] as [number, number, number, number],
          url: `${base}&modality=gray&level=thumbnail`,
          grayThumbnailUrl: `${base}&modality=gray&level=thumbnail`,
          grayOriginalUrl: `${base}&modality=gray&level=original`,
          jetThumbnailUrl: `${base}&modality=jet&level=thumbnail`,
          jetOriginalUrl: `${base}&modality=jet&level=original`,
        };
      }),
    };
  });
}

describe('deduplicated capture cylinder texture', () => {
  it('builds a square-pixel long-strip plan from owned camera columns only', () => {
    const plan = buildCaptureCylinderTexturePlan({
      materialId: '4033',
      frames: frames('4033', 134),
      cameraIds: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
      regionMap: regionMap('4033'),
      surfaceCameraTiles: surfaceCameraTiles(),
      modality: 'gray',
    });

    expect(plan).not.toBeNull();
    expect(plan?.overlapPolicy).toBe('owned-columns-concatenated');
    expect(plan?.projectionPolicy).toBe('calibrated-angle-columns');
    expect(plan?.longitudinalPixels).toBe(134 * 1024);
    expect(plan?.circumferencePixels).toBe(6 * 450);
    expect(plan?.lengthDiameterRatio).toBeCloseTo(Math.PI * 134 * 1024 / (6 * 450), 6);
    expect(plan?.canvasWidth).toBe(8192);
    expect(plan?.canvasHeight).toBe(161);
    expect(plan?.tiles).toHaveLength(134 * 6);
    expect(plan?.tiles[0].segments).toEqual([
      expect.objectContaining({
        sourceInterval: [0, 0.75],
        reverseSourceColumns: false,
      }),
    ]);
    expect(plan?.tiles[0].url).toContain('modality=gray');
  });

  it('uses calibrated column angles to reverse cameras whose source order runs backwards', () => {
    const plan = buildCaptureCylinderTexturePlan({
      materialId: '4033',
      frames: frames('4033', 1),
      cameraIds: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
      regionMap: regionMap('4033'),
      surfaceCameraTiles: surfaceCameraTiles(),
      modality: 'gray',
    });

    expect(plan?.projectionPolicy).toBe('calibrated-angle-columns');
    const forward = plan?.tiles.find((tile) => tile.cameraId === 'C1');
    const reverse = plan?.tiles.find((tile) => tile.cameraId === 'C2');
    expect(forward?.segments).toEqual([
      expect.objectContaining({ reverseSourceColumns: false }),
    ]);
    expect(reverse?.segments).toEqual([
      expect.objectContaining({ reverseSourceColumns: true }),
    ]);
    expect(reverse?.segments[0].circumferencePixels).toBeGreaterThan(0);
    expect(reverse?.segments[0].circumferenceOffsetPixels).toBeGreaterThanOrEqual(0);
  });

  it('keeps every owned source column when calibrated angles contain gaps and duplicates', () => {
    const imperfectCalibration = surfaceCameraTiles();
    const c1Angles = imperfectCalibration.cameras[0].angleDegByColumn;
    const c2Angles = imperfectCalibration.cameras[1].angleDegByColumn;
    const c3Angles = imperfectCalibration.cameras[2].angleDegByColumn;
    if (!c1Angles || !c2Angles || !c3Angles) throw new Error('fixture calibration missing');
    c1Angles[0] = null;
    c1Angles[225] = null;
    c1Angles[449] = null;
    c2Angles[137] = null;
    c2Angles[449] = c1Angles[448];
    c3Angles[101] = c3Angles[100];

    const plan = buildCaptureCylinderTexturePlan({
      materialId: '4033',
      frames: frames('4033', 1),
      cameraIds: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
      regionMap: regionMap('4033'),
      surfaceCameraTiles: imperfectCalibration,
      modality: 'gray',
    });

    expect(plan).not.toBeNull();
    expect(plan?.circumferencePixels).toBe(6 * OWNED_COLUMNS_PER_CAMERA);
    const circumferencePixelsFromSegments = plan?.tiles.reduce(
      (total, tile) => total + tile.segments.reduce(
        (tileTotal, segment) => tileTotal + segment.circumferencePixels,
        0,
      ),
      0,
    );
    expect(circumferencePixelsFromSegments).toBe(6 * OWNED_COLUMNS_PER_CAMERA);

    const mappedSourceColumns: string[] = [];
    plan?.tiles.forEach((tile) => {
      tile.segments.forEach((segment) => {
        const left = Math.round(segment.sourceInterval[0] * CALIBRATED_COLUMNS_PER_CAMERA);
        const right = Math.round(segment.sourceInterval[1] * CALIBRATED_COLUMNS_PER_CAMERA);
        for (let column = left; column < right; column += 1) {
          mappedSourceColumns.push(`${tile.cameraId}:${column}`);
        }
      });
    });
    expect(mappedSourceColumns).toHaveLength(6 * OWNED_COLUMNS_PER_CAMERA);
    expect(new Set(mappedSourceColumns)).toHaveProperty(
      'size',
      6 * OWNED_COLUMNS_PER_CAMERA,
    );
  });

  it('uses an identical deduplicated layout for gray and JET renditions', () => {
    const inputFrames = frames('4034', 3);
    const inputRegionMap = regionMap('4034');
    const common = {
      materialId: '4034',
      frames: inputFrames,
      cameraIds: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
      regionMap: inputRegionMap,
      surfaceCameraTiles: surfaceCameraTiles(),
    };
    const gray = buildCaptureCylinderTexturePlan({ ...common, modality: 'gray' });
    const jet = buildCaptureCylinderTexturePlan({ ...common, modality: 'jet' });

    expect(gray).not.toBeNull();
    expect(jet).not.toBeNull();
    expect(jet?.longitudinalPixels).toBe(gray?.longitudinalPixels);
    expect(jet?.circumferencePixels).toBe(gray?.circumferencePixels);
    expect(jet?.canvasWidth).toBe(gray?.canvasWidth);
    expect(jet?.canvasHeight).toBe(gray?.canvasHeight);
    expect(jet?.projectionPolicy).toBe('calibrated-angle-columns');
    expect(jet?.tiles.map(({ url: _url, ...tile }) => tile)).toEqual(
      gray?.tiles.map(({ url: _url, ...tile }) => tile),
    );
    expect(jet?.tiles.every((tile) => tile.url.includes('modality=jet'))).toBe(true);
  });

  it('fails closed when calibrated ownership is incomplete', () => {
    const incomplete = regionMap('4035');
    incomplete.ownership.ready = false;
    expect(buildCaptureCylinderTexturePlan({
      materialId: '4035',
      frames: frames('4035', 1),
      cameraIds: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
      regionMap: incomplete,
      surfaceCameraTiles: surfaceCameraTiles(),
      modality: 'gray',
    })).toBeNull();
  });

  it('fails closed when any owned camera lacks calibrated per-column angles', () => {
    const incompleteCalibration = surfaceCameraTiles();
    incompleteCalibration.cameras[3] = {
      ...incompleteCalibration.cameras[3],
      angleDegByColumn: undefined,
    };

    expect(buildCaptureCylinderTexturePlan({
      materialId: '4036',
      frames: frames('4036', 1),
      cameraIds: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
      regionMap: regionMap('4036'),
      surfaceCameraTiles: incompleteCalibration,
      modality: 'gray',
    })).toBeNull();
  });

  it('merges owned intervals while excluding calibrated overlap columns', () => {
    expect(normalizeOwnedColumnIntervals(
      [[90, 180], [170, 240], [300, 360], [500, 510]],
      [100, 0, 400, 1024],
    )).toEqual([
      [0, 140 / 300],
      [200 / 300, 260 / 300],
    ]);
  });
});
