import { describe, expect, it } from 'vitest';
import { getMockInspectionSnapshot } from '../data/inspection';
import {
  clampPreviewPositionM,
  createInitialUiState,
  filterDefectsBySurfaceMode,
  getVisibleDefects,
  paginateItems,
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

  it('paginates stable table rows with a 1-based page number', () => {
    const rows = Array.from({ length: 10 }, (_, index) => index + 1);

    expect(paginateItems(rows, 1, 4)).toEqual([1, 2, 3, 4]);
    expect(paginateItems(rows, 2, 4)).toEqual([5, 6, 7, 8]);
    expect(paginateItems(rows, 3, 4)).toEqual([9, 10]);
    expect(paginateItems(rows, 10, 4)).toEqual([9, 10]);
  });

  it('keeps the default inspection theme on the industrial dark palette', () => {
    const snapshot = getMockInspectionSnapshot();
    expect(createInitialUiState(snapshot).theme).toBe('dark');
  });
});
