import { describe, expect, it } from 'vitest';
import type { BkvMaterial } from '../services/bkv-api';
import { buildBkvInspectionSnapshot } from './bkv-inspection-adapter';

const artifact = {
  path: 'preview/example.json',
  size: 128,
  sha256: 'a'.repeat(64),
};

const materials: BkvMaterial[] = [
  {
    legacySeqNo: 1893700,
    legacyCheckRecordSeqNo: 661700,
    steelId: '253B09401250925A12004328',
    steelType: '37Mn/2',
    lengthMm: 12096,
    outerDiameterLegacyValue: 233.664,
    wallThicknessMm: null,
    inspectionTime: '2025-09-26 03:36:17',
    defects: [
      {
        legacyDefectId: 2019096,
        defectNo: 661789,
        cameraId: 1,
        classNo: 16,
        className: '轧折',
        grade: 16,
        confidence: 51,
        imageIndex: 12,
        imageRect2d: { left: 473, top: 857, right: 483, bottom: 867 },
        steelRect2d: { left: 1193, top: 12167, right: 1195, bottom: 12177 },
      },
    ],
    cameras: [],
    artifacts: { unwrapped: artifact, cylinder: artifact, summary: artifact },
  },
  {
    legacySeqNo: 1893701,
    legacyCheckRecordSeqNo: 661701,
    steelId: '253B09401250925A12004846',
    steelType: '37Mn/2',
    lengthMm: 12096,
    outerDiameterLegacyValue: 233.664,
    wallThicknessMm: null,
    inspectionTime: '2025-09-26 03:36:43',
    defects: [],
    cameras: [],
    artifacts: { unwrapped: artifact, cylinder: artifact, summary: artifact },
  },
];

describe('buildBkvInspectionSnapshot', () => {
  it('maps verified BKV materials into dashboard records and inspections', () => {
    const snapshot = buildBkvInspectionSnapshot(materials);

    expect(snapshot.source).toBe('bkv');
    expect(snapshot.currentPlate.plateNo).toBe('253B09401250925A12004328');
    expect(snapshot.records).toHaveLength(2);
    expect(snapshot.records[0]).toMatchObject({
      id: '1893700',
      plateNo: '253B09401250925A12004328',
      status: 'completed',
      defectCount: 1,
    });
    expect(snapshot.inspections).toHaveLength(2);
    expect(snapshot.inspections[0].inspectionId).toBe('1893700');
    expect(snapshot.inspections[0].source).toBe('bkv');
    expect(snapshot.inspections[0].defects[0]).toMatchObject({
      id: '2019096',
      plateNo: '253B09401250925A12004328',
      cameraId: 'camera1',
      cameraIndex: 1,
      typeLabel: '轧折',
      severity: 'review',
      confidence: 51,
    });
    expect(snapshot.defectTypes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'bkv-class-16', label: '轧折' }),
    ]));
    expect(snapshot.summary.total).toBe(1);
    expect(snapshot.summary.bySeverity.review).toBe(1);
    expect(snapshot.status.cameraPorts).toEqual([]);
  });

  it('returns a valid empty BKV snapshot when the manifest has no materials', () => {
    const snapshot = buildBkvInspectionSnapshot([]);

    expect(snapshot.source).toBe('bkv');
    expect(snapshot.records).toEqual([]);
    expect(snapshot.inspections).toEqual([]);
    expect(snapshot.currentPlate.plateNo).toBe('暂无 BKV 记录');
    expect(snapshot.status.cameraPorts).toEqual([]);
  });
});
