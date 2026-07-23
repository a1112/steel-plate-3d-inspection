import type {
  DefectItem,
  DefectType,
  InspectionSnapshot,
  InspectionSummary,
  PlateInspection,
  SteelPlate,
} from '../data/inspection';
import type { BkvDefect, BkvMaterial } from '../services/bkv-api';
import type {
  InspectionWorldDefect,
  InspectionWorldDefects,
  InspectionWorldRecord,
  InspectionWorldRecords,
} from '../services/inspection-world-api';

const TYPE_COLORS = ['#2f6bff', '#ff7f1f', '#24a647', '#8b5cf6', '#17bce1', '#ec4899'];

function materialPlate(material: BkvMaterial): SteelPlate {
  return {
    plateNo: material.steelId,
    widthMm: material.outerDiameterLegacyValue ?? 0,
    lengthMm: material.lengthMm ?? 0,
    thicknessMm: material.wallThicknessMm ?? 0,
    steelGrade: material.steelType || '-',
    detectedAt: material.inspectionTime,
  };
}

function defectTypeId(defect: BkvDefect) {
  return `bkv-class-${defect.classNo}`;
}

function materialDefect(material: BkvMaterial, defect: BkvDefect): DefectItem {
  const imageWidth = Math.max(0, (defect.imageRect2d?.right ?? 0) - (defect.imageRect2d?.left ?? 0));
  const imageHeight = Math.max(0, (defect.imageRect2d?.bottom ?? 0) - (defect.imageRect2d?.top ?? 0));
  const surface = defect.cameraId <= 3 ? 'top' : 'bottom';
  return {
    id: String(defect.legacyDefectId),
    plateNo: material.steelId,
    typeId: defectTypeId(defect),
    typeLabel: defect.className || `旧缺陷 ${defect.classNo}`,
    surface,
    severity: 'review',
    distanceHeadMm: 0,
    operatorSideMm: 0,
    driveSideMm: 0,
    widthMm: 0,
    heightMm: 0,
    depthMm: 0,
    xRatio: 0,
    yOffsetMm: 0,
    previewX: defect.imageRect2d?.left ?? 0,
    previewY: defect.imageRect2d?.top ?? 0,
    previewImageUrl: '',
    cameraId: `camera${defect.cameraId}`,
    cameraIndex: defect.cameraId,
    circumferenceRatio: Math.max(0, Math.min(0.999, (defect.cameraId - 0.5) / 6)),
    confidence: defect.confidence,
    detectionConfidence: defect.confidence,
    classificationConfidence: defect.confidence,
    classificationState: 'classified',
    synthetic: false,
    artifacts: undefined,
    ...(imageWidth || imageHeight ? { previewX: defect.imageRect2d?.left ?? 0, previewY: defect.imageRect2d?.top ?? 0 } : {}),
  };
}

function emptySummary(): InspectionSummary {
  return {
    total: 0,
    bySeverity: { severe: 0, review: 0, minor: 0 },
    bySurface: { top: 0, bottom: 0 },
  };
}

function summarize(defects: DefectItem[]): InspectionSummary {
  return defects.reduce<InspectionSummary>((summary, defect) => {
    summary.total += 1;
    summary.bySeverity[defect.severity] += 1;
    summary.bySurface[defect.surface] += 1;
    return summary;
  }, emptySummary());
}

function buildDefectTypes(materials: BkvMaterial[]): DefectType[] {
  const seen = new Map<number, string>();
  materials.forEach((material) => material.defects.forEach((defect) => {
    if (!seen.has(defect.classNo)) seen.set(defect.classNo, defect.className || `旧缺陷 ${defect.classNo}`);
  }));
  return [...seen.entries()].map(([classNo, label], index) => ({
    id: `bkv-class-${classNo}`,
    label,
    color: TYPE_COLORS[index % TYPE_COLORS.length],
    shape: 'rect',
  }));
}

export function buildBkvInspectionSnapshot(materials: BkvMaterial[]): InspectionSnapshot {
  const inspections: PlateInspection[] = materials.map((material) => ({
    plate: materialPlate(material),
    defects: material.defects.map((defect) => materialDefect(material, defect)),
    heightProfile: [],
    captureImages: [],
    inspectionId: String(material.legacySeqNo),
    source: 'bkv',
  }));
  const defects = inspections.flatMap((inspection) => inspection.defects);
  const currentInspection = inspections[0];
  const currentPlate = currentInspection?.plate ?? {
    plateNo: '暂无 BKV 记录',
    widthMm: 0,
    lengthMm: 0,
    thicknessMm: 0,
    steelGrade: '-',
    detectedAt: '',
  };

  return {
    currentPlate,
    defectTypes: buildDefectTypes(materials),
    defects,
    records: materials.map((material) => ({
      id: String(material.legacySeqNo),
      time: material.inspectionTime,
      plateNo: material.steelId,
      status: 'completed',
      defectCount: material.defects.length,
    })),
    status: {
      receiverPorts: [],
      cameraPorts: [],
      encoder: 'offline',
      plc: 'error',
      l2: 'error',
      alarmCount: 0,
    },
    summary: summarize(currentInspection?.defects ?? []),
    heightProfile: [],
    inspections,
    captureImages: [],
    source: 'bkv',
  };
}

function standardRecordPlate(record: InspectionWorldRecord): SteelPlate {
  return {
    plateNo: record.steelId || record.recordId,
    widthMm: record.outerDiameterMm ?? 0,
    lengthMm: record.lengthMm ?? 0,
    thicknessMm: record.wallThicknessMm ?? 0,
    steelGrade: record.steelType || '-',
    detectedAt: record.inspectionTime || '',
  };
}

function standardDefectClassNo(defect: InspectionWorldDefect) {
  const classNo = defect.trace?.artifacts?.classNo;
  if (typeof classNo === 'number' && Number.isFinite(classNo)) return String(classNo);
  if (typeof classNo === 'string' && classNo.trim()) return classNo.trim();
  return null;
}

function standardDefectTypeId(defect: InspectionWorldDefect) {
  const classNo = standardDefectClassNo(defect);
  if (classNo) return `bkv-class-${classNo}`;
  const normalizedName = (defect.className || '未分类缺陷')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, '-');
  return `bkv-type-${normalizedName || 'unknown'}`;
}

function standardDefect(
  plate: SteelPlate,
  defect: InspectionWorldDefect,
  cameraCount: number,
): DefectItem {
  const cameraIndex = defect.cameraId ?? undefined;
  const imageRect = defect.trace?.artifacts?.imageRect2d;
  const previewX = imageRect?.left ?? defect.worldRect?.x ?? 0;
  const previewY = imageRect?.top ?? defect.worldRect?.y ?? 0;
  return {
    id: String(defect.id),
    plateNo: plate.plateNo,
    typeId: standardDefectTypeId(defect),
    typeLabel: defect.className || '未分类缺陷',
    surface: cameraIndex && cameraIndex <= Math.ceil(cameraCount / 2) ? 'top' : 'bottom',
    severity: 'review',
    distanceHeadMm: 0,
    operatorSideMm: 0,
    driveSideMm: 0,
    widthMm: 0,
    heightMm: 0,
    depthMm: 0,
    xRatio: 0,
    yOffsetMm: 0,
    previewX,
    previewY,
    previewImageUrl: '',
    cameraId: cameraIndex ? `camera${cameraIndex}` : undefined,
    cameraIndex,
    circumferenceRatio: cameraIndex
      ? Math.max(0, Math.min(0.999, (cameraIndex - 0.5) / Math.max(1, cameraCount)))
      : undefined,
    confidence: defect.confidence,
    detectionConfidence: defect.confidence,
    classificationConfidence: defect.confidence,
    classificationState: 'classified',
    synthetic: false,
    artifacts: undefined,
  };
}

function mappedDefectTypes(defects: DefectItem[]): DefectType[] {
  const labels = new Map<string, string>();
  defects.forEach((defect) => {
    if (!labels.has(defect.typeId)) labels.set(defect.typeId, defect.typeLabel);
  });
  return [...labels.entries()].map(([id, label], index) => ({
    id,
    label,
    color: TYPE_COLORS[index % TYPE_COLORS.length],
    shape: 'rect',
  }));
}

export function buildStandardBkvInspectionSnapshot(
  payload: InspectionWorldRecords,
): InspectionSnapshot {
  const inspections: PlateInspection[] = payload.records.map((record) => ({
    plate: standardRecordPlate(record),
    defects: [],
    heightProfile: [],
    captureImages: [],
    inspectionId: record.recordId,
    source: 'bkv',
  }));
  const currentPlate = inspections[0]?.plate ?? {
    plateNo: '暂无 BKV 记录',
    widthMm: 0,
    lengthMm: 0,
    thicknessMm: 0,
    steelGrade: '-',
    detectedAt: '',
  };

  return {
    currentPlate,
    defectTypes: [],
    defects: [],
    records: payload.records.map((record) => ({
      id: record.recordId,
      time: record.inspectionTime || '',
      plateNo: record.steelId || record.recordId,
      status: 'completed',
      defectCount: record.defectCount,
    })),
    status: {
      receiverPorts: [],
      cameraPorts: [],
      encoder: 'offline',
      plc: 'error',
      l2: 'error',
      alarmCount: 0,
    },
    summary: emptySummary(),
    heightProfile: [],
    inspections,
    captureImages: [],
    source: 'bkv',
  };
}

export function mergeStandardBkvDefects(
  snapshot: InspectionSnapshot,
  recordId: string,
  payload: InspectionWorldDefects,
): InspectionSnapshot {
  if (payload.recordId !== recordId) return snapshot;
  const cameraCount = Math.max(
    1,
    ...payload.defects
      .map((defect) => defect.cameraId ?? 0)
      .filter((cameraId) => cameraId > 0),
    6,
  );
  const inspections = snapshot.inspections.map((inspection) => (
    inspection.inspectionId === recordId
      ? {
        ...inspection,
        defects: payload.defects.map((defect) => standardDefect(
          inspection.plate,
          defect,
          cameraCount,
        )),
      }
      : inspection
  ));
  const defects = inspections.flatMap((inspection) => inspection.defects);
  const currentInspection = inspections[0];
  return {
    ...snapshot,
    inspections,
    defects,
    defectTypes: mappedDefectTypes(defects),
    summary: summarize(currentInspection?.defects ?? []),
  };
}
