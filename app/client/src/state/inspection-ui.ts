import { getPlateInspectionSnapshot } from '../data/inspection';
import type { DefectItem, InspectionSnapshot, Surface, ThemeMode, ThemeStyle } from '../data/inspection';

export type SurfaceDisplayMode = Surface | 'all';
export const DEFAULT_PLATE_LENGTH_M = 12;
export const THEME_STORAGE_KEY = 'steel-inspection-theme';
export const THEME_STYLE_STORAGE_KEY = 'steel-inspection-theme-style';
const THEME_MODES: readonly ThemeMode[] = ['dark', 'light', 'graphite'];
const THEME_STYLES: readonly ThemeStyle[] = ['default', 'soft', 'tech', 'industrial', 'modern'];

export function readStoredTheme(storage?: Pick<Storage, 'getItem'> | null): ThemeMode {
  const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  try {
    const stored = target?.getItem(THEME_STORAGE_KEY);
    return THEME_MODES.includes(stored as ThemeMode) ? stored as ThemeMode : 'light';
  } catch {
    return 'light';
  }
}

export function persistTheme(theme: ThemeMode, storage?: Pick<Storage, 'setItem'> | null) {
  const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  try {
    target?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The selected theme still applies for the current session when storage is unavailable.
  }
}

export function readStoredThemeStyle(storage?: Pick<Storage, 'getItem'> | null): ThemeStyle {
  const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  try {
    const stored = target?.getItem(THEME_STYLE_STORAGE_KEY);
    return THEME_STYLES.includes(stored as ThemeStyle) ? stored as ThemeStyle : 'default';
  } catch {
    return 'default';
  }
}

export function persistThemeStyle(themeStyle: ThemeStyle, storage?: Pick<Storage, 'setItem'> | null) {
  const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
  try {
    target?.setItem(THEME_STYLE_STORAGE_KEY, themeStyle);
  } catch {
    // The selected style still applies for the current session when storage is unavailable.
  }
}

export interface InspectionUiState {
  theme: ThemeMode;
  themeStyle: ThemeStyle;
  activeNav: 'online' | 'report' | 'alarms' | 'settings' | 'status';
  selectedRecordId: string;
  selectedDefectId: string | null;
  hiddenDefectTypeIds: Set<string>;
  surfaceDisplayMode: SurfaceDisplayMode;
  previewPositionM: number;
  defectPage: number;
  recordPage: number;
}

export function clampPreviewPositionM(positionM: number, plateLengthM = DEFAULT_PLATE_LENGTH_M) {
  if (!Number.isFinite(positionM)) {
    return 0;
  }
  return Math.min(Math.max(positionM, 0), plateLengthM);
}

function getDefectPreviewPositionM(defect?: Pick<DefectItem, 'distanceHeadMm'>) {
  return clampPreviewPositionM((defect?.distanceHeadMm ?? 0) / 1000);
}

export function createInitialUiState(snapshot: InspectionSnapshot): InspectionUiState {
  return {
    theme: readStoredTheme(),
    themeStyle: readStoredThemeStyle(),
    activeNav: 'online',
    selectedRecordId: snapshot.records[0]?.id ?? snapshot.currentPlate.plateNo,
    selectedDefectId: snapshot.defects[0]?.id ?? null,
    hiddenDefectTypeIds: new Set<string>(),
    surfaceDisplayMode: 'all',
    previewPositionM: getDefectPreviewPositionM(snapshot.defects[0]),
    defectPage: 1,
    recordPage: 1,
  };
}

export function toggleDefectType(state: InspectionUiState, typeId: string): InspectionUiState {
  const hiddenDefectTypeIds = new Set(state.hiddenDefectTypeIds);
  if (hiddenDefectTypeIds.has(typeId)) {
    hiddenDefectTypeIds.delete(typeId);
  } else {
    hiddenDefectTypeIds.add(typeId);
  }
  return {
    ...state,
    hiddenDefectTypeIds,
  };
}

export function getVisibleDefects(defects: DefectItem[], state: Pick<InspectionUiState, 'hiddenDefectTypeIds'>) {
  return defects.filter((defect) => !state.hiddenDefectTypeIds.has(defect.typeId));
}

export function filterDefectsBySurfaceMode(defects: DefectItem[], surfaceDisplayMode: SurfaceDisplayMode) {
  if (surfaceDisplayMode === 'all') {
    return defects;
  }
  return defects.filter((defect) => defect.surface === surfaceDisplayMode);
}

export function selectDefect(
  state: InspectionUiState,
  defects: DefectItem[],
  defectId: string,
): InspectionUiState {
  const defect = defects.find((item) => item.id === defectId);
  if (!defect) {
    return state;
  }
  return {
    ...state,
    selectedDefectId: defect.id,
    selectedRecordId: defect.inspectionId ?? defect.plateNo,
    previewPositionM: getDefectPreviewPositionM(defect),
  };
}

export function selectRecord(
  state: InspectionUiState,
  snapshot: InspectionSnapshot,
  recordSelector: string,
): InspectionUiState {
  const selectedInspection = snapshot.inspections.find((item) => item.inspectionId === recordSelector)
    ?? snapshot.inspections.find((item) => item.plate.plateNo === recordSelector);
  if (!selectedInspection) {
    return state;
  }
  const inspection = getPlateInspectionSnapshot(snapshot, recordSelector);
  return {
    ...state,
    selectedRecordId: selectedInspection.inspectionId ?? selectedInspection.plate.plateNo,
    selectedDefectId: inspection.defects[0]?.id ?? null,
    previewPositionM: getDefectPreviewPositionM(inspection.defects[0]),
    defectPage: 1,
  };
}

export function paginateItems<T>(items: T[], page: number, pageSize: number): T[] {
  if (items.length === 0 || pageSize <= 0) {
    return [];
  }
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const normalizedPage = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages);
  const start = (normalizedPage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function getPageCount(totalItems: number, pageSize: number) {
  return Math.max(1, Math.ceil(totalItems / pageSize));
}
