import type {
  DefectItem,
  DefectType,
  InspectionSnapshot,
  InspectionSummary,
  PlateInspection,
  SteelPlate,
} from '../data/inspection';
import type { BkvDefect, BkvMaterial } from '../services/bkv-api';

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
