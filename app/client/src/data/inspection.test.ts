import { describe, expect, it } from 'vitest';
import { getAllDefects, getMockInspectionSnapshot, getPlateInspectionSnapshot } from './inspection';

describe('getMockInspectionSnapshot', () => {
  it('returns the accepted design plate, defects, status groups, and summaries', () => {
    const snapshot = getMockInspectionSnapshot();

    expect(snapshot.source).toBe('demo');
    expect(snapshot.inspections.every((inspection) => inspection.source === 'demo')).toBe(true);
    expect(snapshot.currentPlate.plateNo).toBe('202606131900');
    expect(snapshot.currentPlate.widthMm).toBe(3500);
    expect(snapshot.currentPlate.lengthMm).toBe(12000);
    expect(snapshot.currentPlate.thicknessMm).toBe(12);
    expect(snapshot.currentPlate.steelGrade).toBe('Q355B');

    expect(snapshot.defects).toHaveLength(12);
    expect(snapshot.summary.total).toBe(12);
    expect(snapshot.summary.bySeverity).toEqual({
      severe: 4,
      review: 3,
      minor: 5,
    });
    expect(snapshot.summary.bySurface).toEqual({
      top: 5,
      bottom: 7,
    });

    expect(snapshot.defectTypes.map((type) => type.label)).toEqual([
      '凹坑',
      '辊印',
      '划伤',
      '异物压入',
      '烂钢',
      '边裂',
      '纵裂',
      '气泡',
      '夹杂',
      '待复核',
    ]);
    expect(snapshot.status.receiverPorts.map((port) => port.ok)).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(snapshot.status.cameraPorts.map((port) => port.ok)).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('derives the active plate snapshot from a selected inspection record', () => {
    const snapshot = getMockInspectionSnapshot();
    const selected = getPlateInspectionSnapshot(snapshot, '202606131858');

    expect(selected.currentPlate.plateNo).toBe('202606131858');
    expect(selected.currentPlate.detectedAt).toBe('2026-06-13 18:42');
    expect(selected.defects).toHaveLength(8);
    expect(selected.summary.total).toBe(8);
    expect(selected.summary.bySeverity).toEqual({
      severe: 2,
      review: 3,
      minor: 3,
    });
    expect(selected.records).toHaveLength(snapshot.records.length);
    expect(selected.defects.every((defect) => defect.plateNo === '202606131858')).toBe(true);
  });

  it('attaches generated mock defect images only to the explicit demo fixture', () => {
    const snapshot = getMockInspectionSnapshot();
    const historical = getPlateInspectionSnapshot(snapshot, '202606131858');

    expect(snapshot.source).toBe('demo');
    expect(historical.source).toBe('demo');
    expect(snapshot.defects.every((defect) => defect.previewImageUrl)).toBe(true);
    expect(snapshot.defects.find((defect) => defect.typeId === 'pit')?.previewImageUrl).toContain('defect-pit');
    expect(snapshot.defects.find((defect) => defect.typeId === 'scratch')?.previewImageUrl).toContain('defect-scratch');
    expect(snapshot.defects.find((defect) => defect.typeId === 'foreign')?.previewImageUrl).toContain('defect-inclusion');
    expect(historical.defects.every((defect) => defect.previewImageUrl)).toBe(true);
  });

  it('keeps all historical defects queryable across record snapshots', () => {
    const snapshot = getMockInspectionSnapshot();
    const allDefects = getAllDefects(snapshot);

    expect(allDefects).toHaveLength(87);
    expect(allDefects.filter((defect) => defect.plateNo === '202606131755')).toHaveLength(24);
    expect(allDefects.some((defect) => defect.plateNo === '202606131820')).toBe(false);
  });
});
