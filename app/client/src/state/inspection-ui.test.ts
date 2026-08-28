import { describe, expect, it } from 'vitest';
import { getMockInspectionSnapshot } from '../data/inspection';
import {
  clampPreviewPositionM,
  createInitialUiState,
  filterDefectsBySurfaceMode,
  followLatestRecord,
  getVisibleDefects,
  paginateItems,
  persistTheme,
  persistThemeStyle,
  readStoredTheme,
  readStoredThemeStyle,
  selectRecord,
  selectDefect,
  toggleDefectType,
} from './inspection-ui';

describe('inspection UI state helpers', () => {
  it('filters defects by category without mutating the current state', () => {
    const snapshot = getMockInspectionSnapshot();
    const state = createInitialUiState(snapshot);
    const withoutPits = toggleDefectType(state, 'pit');

    expect(getVisibleDefects(snapshot.defects, state)).toHaveLength(12);
    expect(getVisibleDefects(snapshot.defects, withoutPits)).toHaveLength(9);
    expect(withoutPits.hiddenDefectTypeIds.has('pit')).toBe(true);

    const restored = toggleDefectType(withoutPits, 'pit');
    expect(getVisibleDefects(snapshot.defects, restored)).toHaveLength(12);
    expect(state.hiddenDefectTypeIds.has('pit')).toBe(false);
  });

  it('clamps preview positions to the active plate length', () => {
    expect(clampPreviewPositionM(-1, 12)).toBe(0);
    expect(clampPreviewPositionM(5.25, 12)).toBe(5.25);
    expect(clampPreviewPositionM(20, 12)).toBe(12);
    expect(clampPreviewPositionM(Number.NaN, 12)).toBe(0);
  });

  it('filters visible defects by surface display mode', () => {
    const snapshot = getMockInspectionSnapshot();

    expect(filterDefectsBySurfaceMode(snapshot.defects, 'all')).toHaveLength(12);
    expect(filterDefectsBySurfaceMode(snapshot.defects, 'top')).toHaveLength(5);
    expect(filterDefectsBySurfaceMode(snapshot.defects, 'bottom')).toHaveLength(7);
  });

  it('selects defects and synchronizes the corresponding record and detail id', () => {
    const snapshot = getMockInspectionSnapshot();
    const state = createInitialUiState(snapshot);
    const selected = selectDefect(state, snapshot.defects, 'D-008');

    expect(selected.selectedDefectId).toBe('D-008');
    expect(selected.selectedRecordId).toBe('202606131900');
    expect(selected.previewPositionM).toBe(1.98);
  });

  it('selects records and resets the active defect to that plate context', () => {
    const snapshot = getMockInspectionSnapshot();
    const state = { ...createInitialUiState(snapshot), defectPage: 2 };
    const selected = selectRecord(state, snapshot, '202606131858');

    expect(selected.selectedRecordId).toBe('202606131858');
    expect(selected.selectedDefectId).toBe('D-201');
    expect(selected.previewPositionM).toBe(1.311);
    expect(selected.defectPage).toBe(1);

    const cleanPlate = selectRecord(selected, snapshot, '202606131820');
    expect(cleanPlate.selectedRecordId).toBe('202606131820');
    expect(cleanPlate.selectedDefectId).toBeNull();
    expect(cleanPlate.previewPositionM).toBe(0);
  });

  it('follows live updates without resetting a retained defect or viewport', () => {
    const snapshot = getMockInspectionSnapshot();
    const initial = {
      ...createInitialUiState(snapshot),
      selectedRecordId: snapshot.records[0].id,
      selectedDefectId: snapshot.defects[1].id,
      previewPositionM: 4.75,
      defectPage: 3,
    };
    const refreshed = {
      ...snapshot,
      defects: [
        { ...snapshot.defects[0], id: 'D-LIVE-NEW' },
        ...snapshot.defects,
      ],
      inspections: snapshot.inspections.map((inspection, index) => index === 0
        ? {
            ...inspection,
            defects: [
              { ...inspection.defects[0], id: 'D-LIVE-NEW' },
              ...inspection.defects,
            ],
          }
        : inspection),
    };

    const followed = followLatestRecord(initial, refreshed);

    expect(followed.selectedRecordId).toBe(initial.selectedRecordId);
    expect(followed.selectedDefectId).toBe(initial.selectedDefectId);
    expect(followed.previewPositionM).toBe(4.75);
    expect(followed.defectPage).toBe(3);
  });

  it('switches live following to a genuinely newer record', () => {
    const snapshot = getMockInspectionSnapshot();
    const previous = selectRecord(createInitialUiState(snapshot), snapshot, snapshot.records[1].id);

    const followed = followLatestRecord(previous, snapshot);

    expect(followed.selectedRecordId).toBe(snapshot.records[0].id);
    expect(followed.selectedDefectId).toBe(snapshot.inspections[0].defects[0]?.id ?? null);
    expect(followed.defectPage).toBe(1);
  });

  it('uses the inspection id to distinguish repeated inspections of the same plate', () => {
    const snapshot = getMockInspectionSnapshot();
    const newer = {
      ...snapshot.inspections[0],
      inspectionId: 'R-newer',
      plate: { ...snapshot.inspections[0].plate, plateNo: 'DUPLICATE-PLATE' },
    };
    const older = {
      ...snapshot.inspections[1],
      inspectionId: 'R-older',
      plate: { ...snapshot.inspections[1].plate, plateNo: 'DUPLICATE-PLATE' },
    };
    const duplicateSnapshot = {
      ...snapshot,
      inspections: [newer, older],
      records: [
        { ...snapshot.records[0], id: 'R-newer', plateNo: 'DUPLICATE-PLATE' },
        { ...snapshot.records[1], id: 'R-older', plateNo: 'DUPLICATE-PLATE' },
      ],
    };

    const selected = selectRecord(createInitialUiState(duplicateSnapshot), duplicateSnapshot, 'R-older');

    expect(selected.selectedRecordId).toBe('R-older');
    expect(selected.selectedDefectId).toBe(older.defects[0]?.id ?? null);
  });

  it('resolves opaque record ids through the record plate number when inspection ids are absent', () => {
    const snapshot = getMockInspectionSnapshot();
    const serviceSnapshot = {
      ...snapshot,
      records: snapshot.records.map((record, index) => ({ ...record, id: `R-${index + 1}` })),
      inspections: snapshot.inspections.map((inspection) => ({ ...inspection, inspectionId: '' })),
    };

    const selected = selectRecord(createInitialUiState(serviceSnapshot), serviceSnapshot, 'R-2');

    expect(selected.selectedRecordId).toBe('R-2');
    expect(selected.selectedDefectId).toBe(serviceSnapshot.inspections[1].defects[0]?.id ?? null);
    expect(selected.previewPositionM).toBe(1.311);
  });

  it('paginates stable table rows with a 1-based page number', () => {
    const rows = Array.from({ length: 10 }, (_, index) => index + 1);

    expect(paginateItems(rows, 1, 4)).toEqual([1, 2, 3, 4]);
    expect(paginateItems(rows, 2, 4)).toEqual([5, 6, 7, 8]);
    expect(paginateItems(rows, 3, 4)).toEqual([9, 10]);
    expect(paginateItems(rows, 10, 4)).toEqual([9, 10]);
  });

  it('uses the light inspection palette by default', () => {
    const snapshot = getMockInspectionSnapshot();
    expect(createInitialUiState(snapshot).theme).toBe('light');
  });

  it('persists valid theme choices and rejects unknown stored values', () => {
    let stored: string | null = null;
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value; },
    };

    persistTheme('graphite', storage);
    expect(readStoredTheme(storage)).toBe('graphite');

    stored = 'emerald';
    expect(readStoredTheme(storage)).toBe('light');
  });

  it('persists the independent style dimension and rejects unknown styles', () => {
    let stored: string | null = null;
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => { stored = value; },
    };

    persistThemeStyle('tech', storage);
    expect(readStoredThemeStyle(storage)).toBe('tech');

    stored = 'neon';
    expect(readStoredThemeStyle(storage)).toBe('default');
  });
});
