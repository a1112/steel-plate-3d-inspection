import { describe, expect, it } from 'vitest';
import type {
  InspectionWorldDefects,
  InspectionWorldRecords,
} from '../services/inspection-world-api';
import {
  buildStandardBkvInspectionSnapshot,
  mergeStandardBkvDefects,
} from './bkv-inspection-adapter';

const records: InspectionWorldRecords = {
  schema: 'steel.inspection-world.records.v1',
  provider: 'bkv',
  ready: true,
  cameraCount: 6,
  batchId: 'legacy-1893700-1893710',
  records: Array.from({ length: 11 }, (_, index) => ({
    recordId: String(1893700 + index),
    legacySeqNo: 1893700 + index,
    steelId: index === 0 ? '253B09401250925A12004328' : `STEEL-${index}`,
    steelType: '37Mn/2',
    lengthMm: 12096,
    outerDiameterMm: 233.664,
    wallThicknessMm: 12.5,
    inspectionTime: `2025-09-26 03:${String(36 + index).padStart(2, '0')}:17`,
    defectCount: index === 0 ? 1 : 0,
    cameraCount: 6,
    sourceHash: `record-hash-${index}`,
  })),
};

const defects: InspectionWorldDefects = {
  schema: 'steel.inspection-world.defects.v1',
  provider: 'bkv',
  recordId: '1893700',
  defects: [{
    id: '1893700-2019096',
    className: '轧折',
    grade: 16,
    confidence: 51,
    cameraId: 1,
    imageIndex: 12,
    locatable: true,
    worldRect: { x: 473, y: 857, width: 10, height: 10 },
    trace: {
      sequenceNo: 12,
      artifacts: {
        classNo: 16,
        imageRect2d: { left: 473, top: 857, right: 483, bottom: 867 },
        source: {
          distanceHeadMm: 11_420,
          operatorSideMm: 115,
          driveSideMm: 576,
          widthMm: 0.45,
          heightMm: 7.48,
          depthMm: -0.546,
          xRatio: 0.94,
          circumferenceRatio: 0.1665,
          previewImageUrl: '/api/bkv-online/image?camera=1&index=12&kind=2d',
          artifacts: {
            schema: 'steel.surface.defect.artifacts.v1',
            cameraId: 'camera1',
            frameId: 'frame-12',
            sequenceNo: 12,
            roi: { x: 1208, y: 848, width: 4, height: 11 },
            roiImage: '/api/bkv-online/image?camera=1&index=12&kind=2d',
          },
        },
      },
    },
  }],
};

describe('standard BKV inspection adapter', () => {
  it('builds dashboard records and plates from the standard record contract', () => {
    const snapshot = buildStandardBkvInspectionSnapshot(records);

    expect(snapshot.source).toBe('bkv');
    expect(snapshot.records).toHaveLength(11);
    expect(snapshot.currentPlate).toMatchObject({
      plateNo: '253B09401250925A12004328',
      widthMm: 233.664,
      lengthMm: 12096,
      thicknessMm: 12.5,
      steelGrade: '37Mn/2',
    });
    expect(snapshot.inspections).toHaveLength(11);
    expect(snapshot.inspections[0]).toMatchObject({
      inspectionId: '1893700',
      source: 'bkv',
      defects: [],
    });
    expect(snapshot.status.cameraPorts).toEqual([]);
  });

  it('retains catalog defect counts before detail defects are loaded', () => {
    const snapshot = buildStandardBkvInspectionSnapshot(records);

    expect(snapshot.records[0].defectCount).toBe(1);
    expect(snapshot.inspections[0].defects).toEqual([]);
    expect(snapshot.summary.total).toBe(0);
  });

  it('merges standard world defects into the matching inspection without mutating records', () => {
    const snapshot = buildStandardBkvInspectionSnapshot(records);
    const merged = mergeStandardBkvDefects(snapshot, '1893700', defects);

    expect(merged).not.toBe(snapshot);
    expect(merged.records[0].defectCount).toBe(1);
    expect(merged.inspections[0].defects[0]).toMatchObject({
      id: '1893700-2019096',
      plateNo: '253B09401250925A12004328',
      typeId: 'bkv-class-16',
      typeLabel: '轧折',
      cameraId: 'camera1',
      cameraIndex: 1,
      severity: 'severe',
      confidence: 51,
      synthetic: false,
      distanceHeadMm: 11_420,
      widthMm: 0.45,
      heightMm: 7.48,
      depthMm: -0.546,
      previewImageUrl: '/api/bkv-online/image?camera=1&index=12&kind=2d',
      artifacts: expect.objectContaining({
        sequenceNo: 12,
        roi: { x: 1208, y: 848, width: 4, height: 11 },
      }),
    });
    expect(merged.defectTypes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bkv-class-16', label: '轧折' }),
    ]));
    expect(merged.summary.total).toBe(1);
    expect(merged.summary.bySeverity.severe).toBe(1);
    expect(snapshot.inspections[0].defects).toEqual([]);
  });

  it('returns a valid empty snapshot when the standard store has no records', () => {
    const snapshot = buildStandardBkvInspectionSnapshot({
      ...records,
      ready: false,
      batchId: '无离线批次',
      records: [],
    });

    expect(snapshot.source).toBe('bkv');
    expect(snapshot.records).toEqual([]);
    expect(snapshot.inspections).toEqual([]);
    expect(snapshot.currentPlate.plateNo).toBe('暂无 BKV 记录');
  });
});
