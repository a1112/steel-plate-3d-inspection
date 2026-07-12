import { getPlateInspectionSnapshot } from '../data/inspection';
import type { DefectItem, InspectionSnapshot, Surface, ThemeMode } from '../data/inspection';

export type SurfaceDisplayMode = Surface | 'all';
export const DEFAULT_PLATE_LENGTH_M = 12;

export interface InspectionUiState {
  theme: ThemeMode;
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
    theme: 'dark',
    activeNav: 'online',
    selectedRecordId: snapshot.records[0]?.plateNo ?? snapshot.currentPlate.plateNo,
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
    selectedRecordId: defect.plateNo,
    previewPositionM: getDefectPreviewPositionM(defect),
  };
}

export function selectRecord(
  state: InspectionUiState,
  snapshot: InspectionSnapshot,
  plateNo: string,
): InspectionUiState {
  const inspection = getPlateInspectionSnapshot(snapshot, plateNo);
  if (inspection.currentPlate.plateNo !== plateNo) {
    return state;
  }
  return {
    ...state,
    selectedRecordId: plateNo,
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
