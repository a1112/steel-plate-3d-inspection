import defectInclusionImage from '../assets/mock-defects/defect-inclusion.png';
import defectPitImage from '../assets/mock-defects/defect-pit.png';
import defectScratchImage from '../assets/mock-defects/defect-scratch.png';

export type ThemeMode = 'dark' | 'light' | 'graphite';
export type ThemeStyle = 'default' | 'soft' | 'tech' | 'industrial' | 'modern';
export type Severity = 'severe' | 'review' | 'minor';
export type Surface = 'top' | 'bottom';

export interface SteelPlate {
  plateNo: string;
  widthMm: number;
  lengthMm: number;
  thicknessMm: number;
  steelGrade: string;
  detectedAt: string;
}

export interface DefectType {
  id: string;
  label: string;
  color: string;
  shape: 'circle' | 'square' | 'diamond' | 'rect' | 'star';
}

export interface DefectItem {
  id: string;
  plateNo: string;
  inspectionId?: string;
  typeId: string;
  typeLabel: string;
  surface: Surface;
  severity: Severity;
  distanceHeadMm: number;
  operatorSideMm: number;
  driveSideMm: number;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  xRatio: number;
  yOffsetMm: number;
  previewX: number;
  previewY: number;
  previewImageUrl: string;
  cameraId?: string;
  cameraIndex?: number;
  circumferenceRatio?: number;
  confidence?: number;
  detectionConfidence?: number;
  classificationConfidence?: number | null;
  classificationState?: 'candidate-only' | 'classified' | string;
  classificationVersion?: string;
  candidatePolarity?: 'depression' | 'protrusion' | string;
  synthetic?: boolean;
  artifacts?: DefectArtifacts;
}

export interface DefectArtifacts {
  schema: 'steel.surface.defect.artifacts.v1' | string;
  cameraId: string;
  frameId: string;
  sequenceNo: number;
  roi: { x: number; y: number; width: number; height: number };
  sourceFrame?: {
    intensity?: string;
    intensitySha256?: string;
    depth?: string;
    depthSha256?: string;
  };
  roiImage?: string;
  depthRoiImage?: string;
  localPointCloud?: string;
  lengthProfile?: string;
  widthProfile?: string;
}

export interface CaptureImageItem {
  id: string;
  cameraId: string;
  cameraIp: string;
  dataName: 'depth' | 'intensity' | 'metadata' | string;
  sequenceNo: number;
  fileType: string;
  path: string;
  metadataPath?: string;
  url: string;
  metadataUrl?: string;
  createdAt: string;
}

export interface InspectionRecord {
  id: string;
  time: string;
  plateNo: string;
  status: 'detecting' | 'completed';
  defectCount: number;
}

export interface DevicePort {
  index: number;
  ok: boolean;
}

export interface DeviceStatus {
  receiverPorts: DevicePort[];
  cameraPorts: DevicePort[];
  encoder: 'sync' | 'offline';
  plc: 'normal' | 'error';
  l2: 'normal' | 'error';
  alarmCount: number;
}

export interface InspectionSummary {
  total: number;
  bySeverity: Record<Severity, number>;
  bySurface: Record<Surface, number>;
}

export interface ChartPoint {
  x: number;
  z: number;
}

export interface InspectionSnapshot {
  currentPlate: SteelPlate;
  defectTypes: DefectType[];
  defects: DefectItem[];
  records: InspectionRecord[];
  status: DeviceStatus;
  summary: InspectionSummary;
  heightProfile: ChartPoint[];
  inspections: PlateInspection[];
  captureImages?: CaptureImageItem[];
  source?: string;
}

export interface PlateInspection {
  plate: SteelPlate;
  defects: DefectItem[];
  heightProfile: ChartPoint[];
  captureImages?: CaptureImageItem[];
  inspectionId?: string;
  summaryPath?: string;
  captureSummaryPath?: string;
  source?: string;
}

export const severityLabels: Record<Severity, string> = {
  severe: '严重',
  review: '待复核',
  minor: '轻微',
};

export const surfaceLabels: Record<Surface, string> = {
  top: '1-3号相机',
  bottom: '4-6号相机',
};

const defectTypes: DefectType[] = [
  { id: 'pit', label: '凹坑', color: '#2f6bff', shape: 'circle' },
  { id: 'roll', label: '辊印', color: '#ff7f1f', shape: 'square' },
  { id: 'scratch', label: '划伤', color: '#24a647', shape: 'rect' },
  { id: 'foreign', label: '异物压入', color: '#f0141e', shape: 'diamond' },
  { id: 'burnt', label: '烂钢', color: '#8b5cf6', shape: 'square' },
  { id: 'edge', label: '边裂', color: '#f6b800', shape: 'diamond' },
  { id: 'longitudinal', label: '纵裂', color: '#17bce1', shape: 'rect' },
  { id: 'bubble', label: '气泡', color: '#ec4899', shape: 'circle' },
  { id: 'inclusion', label: '夹杂', color: '#a63a1f', shape: 'circle' },
  { id: 'review', label: '待复核', color: '#737373', shape: 'star' },
];

const defectPreviewImages: Record<string, string> = {
  pit: defectPitImage,
  bubble: defectPitImage,
  scratch: defectScratchImage,
  longitudinal: defectScratchImage,
  edge: defectScratchImage,
  foreign: defectInclusionImage,
  inclusion: defectInclusionImage,
  roll: defectInclusionImage,
  burnt: defectInclusionImage,
  review: defectPitImage,
};

export function getDefectPreviewImage(typeId: string) {
  return defectPreviewImages[typeId] ?? defectPitImage;
}

function withPreviewImage<T extends Omit<DefectItem, 'previewImageUrl'>>(defect: T): DefectItem {
  return {
    ...defect,
    previewImageUrl: getDefectPreviewImage(defect.typeId),
  };
}

const defects: DefectItem[] = ([
  {
    id: 'D-001',
    plateNo: '202606131900',
    typeId: 'pit',
    typeLabel: '凹坑',
    surface: 'top',
    severity: 'severe',
    distanceHeadMm: 8342,
    operatorSideMm: 1260,
    driveSideMm: 2240,
    widthMm: 0.42,
    heightMm: 0.36,
    depthMm: -0.12,
    xRatio: 0.18,
    yOffsetMm: 0.92,
    previewX: 54,
    previewY: 48,
  },
  {
    id: 'D-002',
    plateNo: '202606131900',
    typeId: 'scratch',
    typeLabel: '划伤',
    surface: 'bottom',
    severity: 'minor',
    distanceHeadMm: 5260,
    operatorSideMm: 580,
    driveSideMm: 2920,
    widthMm: 0.64,
    heightMm: 0.18,
    depthMm: -0.05,
    xRatio: 0.12,
    yOffsetMm: 0.52,
    previewX: 38,
    previewY: 40,
  },
  {
    id: 'D-003',
    plateNo: '202606131900',
    typeId: 'roll',
    typeLabel: '辊印',
    surface: 'top',
    severity: 'review',
    distanceHeadMm: 4100,
    operatorSideMm: 2050,
    driveSideMm: 1450,
    widthMm: 0.28,
    heightMm: 0.28,
    depthMm: -0.08,
    xRatio: 0.42,
    yOffsetMm: -0.4,
    previewX: 50,
    previewY: 54,
  },
  {
    id: 'D-004',
    plateNo: '202606131900',
    typeId: 'foreign',
    typeLabel: '异物压入',
    surface: 'bottom',
    severity: 'severe',
    distanceHeadMm: 3880,
    operatorSideMm: 960,
    driveSideMm: 2540,
    widthMm: 0.48,
    heightMm: 0.42,
    depthMm: -0.14,
    xRatio: 0.04,
    yOffsetMm: 0.82,
    previewX: 43,
    previewY: 48,
  },
  {
    id: 'D-005',
    plateNo: '202606131900',
    typeId: 'pit',
    typeLabel: '凹坑',
    surface: 'top',
    severity: 'severe',
    distanceHeadMm: 3200,
    operatorSideMm: 1780,
    driveSideMm: 1720,
    widthMm: 0.38,
    heightMm: 0.31,
    depthMm: -0.1,
    xRatio: 0.61,
    yOffsetMm: 0.84,
    previewX: 56,
    previewY: 45,
  },
  {
    id: 'D-006',
    plateNo: '202606131900',
    typeId: 'scratch',
    typeLabel: '划伤',
    surface: 'top',
    severity: 'minor',
    distanceHeadMm: 2910,
    operatorSideMm: 1560,
    driveSideMm: 1940,
    widthMm: 0.71,
    heightMm: 0.16,
    depthMm: -0.04,
    xRatio: 0.62,
    yOffsetMm: -0.48,
    previewX: 48,
    previewY: 53,
  },
  {
    id: 'D-007',
    plateNo: '202606131900',
    typeId: 'roll',
    typeLabel: '辊印',
    surface: 'bottom',
    severity: 'review',
    distanceHeadMm: 2600,
    operatorSideMm: 1440,
    driveSideMm: 2060,
    widthMm: 0.36,
    heightMm: 0.33,
    depthMm: -0.07,
    xRatio: 0.24,
    yOffsetMm: -0.52,
    previewX: 46,
    previewY: 57,
  },
  {
    id: 'D-008',
    plateNo: '202606131900',
    typeId: 'pit',
    typeLabel: '凹坑',
    surface: 'bottom',
    severity: 'minor',
    distanceHeadMm: 1980,
    operatorSideMm: 1840,
    driveSideMm: 1660,
    widthMm: 0.4,
    heightMm: 0.33,
    depthMm: -0.09,
    xRatio: 0.72,
    yOffsetMm: -0.45,
    previewX: 59,
    previewY: 50,
  },
  {
    id: 'D-009',
    plateNo: '202606131900',
    typeId: 'bubble',
    typeLabel: '气泡',
    surface: 'bottom',
    severity: 'minor',
    distanceHeadMm: 1460,
    operatorSideMm: 1740,
    driveSideMm: 1760,
    widthMm: 0.26,
    heightMm: 0.24,
    depthMm: -0.03,
    xRatio: 0.71,
    yOffsetMm: 0.52,
    previewX: 52,
    previewY: 49,
  },
  {
    id: 'D-010',
    plateNo: '202606131900',
    typeId: 'foreign',
    typeLabel: '异物压入',
    surface: 'top',
    severity: 'severe',
    distanceHeadMm: 920,
    operatorSideMm: 2680,
    driveSideMm: 820,
    widthMm: 0.5,
    heightMm: 0.42,
    depthMm: -0.16,
    xRatio: 0.78,
    yOffsetMm: 0.9,
    previewX: 61,
    previewY: 45,
  },
  {
    id: 'D-011',
    plateNo: '202606131900',
    typeId: 'burnt',
    typeLabel: '烂钢',
    surface: 'bottom',
    severity: 'review',
    distanceHeadMm: 640,
    operatorSideMm: 2240,
    driveSideMm: 1260,
    widthMm: 0.34,
    heightMm: 0.34,
    depthMm: -0.08,
    xRatio: 0.82,
    yOffsetMm: -0.52,
    previewX: 63,
    previewY: 55,
  },
  {
    id: 'D-012',
    plateNo: '202606131900',
    typeId: 'edge',
    typeLabel: '边裂',
    surface: 'bottom',
    severity: 'minor',
    distanceHeadMm: 540,
    operatorSideMm: 2480,
    driveSideMm: 1020,
    widthMm: 0.55,
    heightMm: 0.26,
    depthMm: -0.05,
    xRatio: 0.84,
    yOffsetMm: -0.95,
    previewX: 65,
    previewY: 58,
  },
] satisfies Array<Omit<DefectItem, 'previewImageUrl'>>).map(withPreviewImage);

const records: InspectionRecord[] = [
  { id: 'R-001', time: '19:00', plateNo: '202606131900', status: 'detecting', defectCount: 12 },
  { id: 'R-002', time: '18:42', plateNo: '202606131858', status: 'completed', defectCount: 8 },
  { id: 'R-003', time: '18:20', plateNo: '202606131820', status: 'completed', defectCount: 0 },
  { id: 'R-004', time: '17:55', plateNo: '202606131755', status: 'completed', defectCount: 24 },
  { id: 'R-005', time: '17:30', plateNo: '202606131730', status: 'completed', defectCount: 5 },
  { id: 'R-006', time: '17:05', plateNo: '202606131705', status: 'completed', defectCount: 16 },
  { id: 'R-007', time: '16:40', plateNo: '202606131640', status: 'completed', defectCount: 2 },
  { id: 'R-008', time: '16:15', plateNo: '202606131615', status: 'completed', defectCount: 7 },
  { id: 'R-009', time: '15:50', plateNo: '202606131550', status: 'completed', defectCount: 10 },
  { id: 'R-010', time: '15:25', plateNo: '202606131525', status: 'completed', defectCount: 3 },
];

const heightProfile: ChartPoint[] = Array.from({ length: 81 }, (_, index) => {
  const dip = Math.exp(-Math.pow(index - 36, 2) / 12) * -0.18;
  const ripple = Math.sin(index / 5) * 0.015;
  return { x: index, z: Number((dip + ripple).toFixed(3)) };
});

function createHistoricalHeightProfile(depthMm: number, center = 36): ChartPoint[] {
  return Array.from({ length: 81 }, (_, index) => {
    const dip = Math.exp(-Math.pow(index - center, 2) / 16) * depthMm;
    const ripple = Math.sin(index / 6) * 0.012;
    return { x: index, z: Number((dip + ripple).toFixed(3)) };
  });
}

const plateOverrides: Record<string, Partial<SteelPlate>> = {
  '202606131900': {
    widthMm: 3500,
    lengthMm: 12000,
    thicknessMm: 12,
    steelGrade: 'Q355B',
  },
  '202606131858': {
    widthMm: 3600,
    lengthMm: 11800,
    thicknessMm: 14,
    steelGrade: 'Q355B',
  },
  '202606131820': {
    widthMm: 3200,
    lengthMm: 10000,
    thicknessMm: 10,
    steelGrade: 'Q235B',
  },
  '202606131755': {
    widthMm: 3800,
    lengthMm: 12500,
    thicknessMm: 16,
    steelGrade: 'Q420B',
  },
};

const historicalSeverityPlans: Record<string, Severity[]> = {
  '202606131858': ['severe', 'review', 'minor', 'review', 'severe', 'minor', 'review', 'minor'],
  '202606131755': [
    'severe',
    'review',
    'minor',
    'minor',
    'severe',
    'review',
    'minor',
    'severe',
    'review',
    'minor',
    'minor',
    'review',
    'severe',
    'minor',
    'review',
    'minor',
    'severe',
    'review',
    'minor',
    'minor',
    'review',
    'severe',
    'minor',
    'minor',
  ],
};

function createPlateFromRecord(record: InspectionRecord, index: number): SteelPlate {
  const override = plateOverrides[record.plateNo] ?? {};
  return {
    plateNo: record.plateNo,
    widthMm: override.widthMm ?? 3300 + (index % 4) * 120,
    lengthMm: override.lengthMm ?? 10800 + (index % 5) * 350,
    thicknessMm: override.thicknessMm ?? 10 + (index % 4) * 2,
    steelGrade: override.steelGrade ?? (index % 3 === 0 ? 'Q355B' : 'Q235B'),
    detectedAt: `2026-06-13 ${record.time}`,
  };
}

function createSeverityPlan(record: InspectionRecord): Severity[] {
  const explicit = historicalSeverityPlans[record.plateNo];
  if (explicit) {
    return explicit;
  }
  const cycle: Severity[] = ['minor', 'review', 'minor', 'severe', 'review'];
  return Array.from({ length: record.defectCount }, (_, index) => cycle[index % cycle.length]);
}

function createHistoricalDefects(record: InspectionRecord, plate: SteelPlate, recordIndex: number): DefectItem[] {
  if (record.plateNo === '202606131900') {
    return defects;
  }
  const severityPlan = createSeverityPlan(record);
  return severityPlan.map((severity, index) => {
    const type = defectTypes[(recordIndex + index) % (defectTypes.length - 1)];
    const distanceHeadMm = Math.round(((index + 1) * plate.lengthMm) / (severityPlan.length + 1));
    const sidePosition = Math.round(((index * 431 + recordIndex * 277) % plate.widthMm) + 1);
    const operatorSideMm = Math.min(sidePosition, plate.widthMm - 80);
    const driveSideMm = Math.max(80, plate.widthMm - operatorSideMm);
    const depthBySeverity: Record<Severity, number> = {
      severe: -0.13 - (index % 3) * 0.015,
      review: -0.08 - (index % 2) * 0.01,
      minor: -0.035 - (index % 3) * 0.008,
    };
    const widthMm = Number((0.24 + (index % 5) * 0.09).toFixed(2));
    const heightMm = Number((0.16 + (index % 4) * 0.07).toFixed(2));
    return withPreviewImage({
      id: `D-${recordIndex + 1}${String(index + 1).padStart(2, '0')}`,
      plateNo: record.plateNo,
      typeId: type.id,
      typeLabel: type.label,
      surface: index % 2 === 0 ? 'top' : 'bottom',
      severity,
      distanceHeadMm,
      operatorSideMm,
      driveSideMm,
      widthMm,
      heightMm,
      depthMm: Number(depthBySeverity[severity].toFixed(2)),
      xRatio: Number((distanceHeadMm / plate.lengthMm).toFixed(4)),
      yOffsetMm: Number((((operatorSideMm / plate.widthMm) - 0.5) * 2).toFixed(2)),
      previewX: 34 + ((index * 7 + recordIndex * 5) % 32),
      previewY: 38 + ((index * 5 + recordIndex * 3) % 22),
    });
  });
}

function createPlateInspections(): PlateInspection[] {
  return records.map((record, index) => {
    const plate = createPlateFromRecord(record, index);
    const inspectionDefects = createHistoricalDefects(record, plate, index);
    return {
      plate,
      defects: inspectionDefects,
      heightProfile:
        record.plateNo === '202606131900'
          ? heightProfile
          : createHistoricalHeightProfile(inspectionDefects[0]?.depthMm ?? -0.02, 28 + ((index * 7) % 22)),
      source: 'demo',
    };
  });
}

export function summarizeDefects(items: DefectItem[]): InspectionSummary {
  return items.reduce<InspectionSummary>(
    (summary, defect) => {
      summary.total += 1;
      summary.bySeverity[defect.severity] += 1;
      summary.bySurface[defect.surface] += 1;
      return summary;
    },
    {
      total: 0,
      bySeverity: { severe: 0, review: 0, minor: 0 },
      bySurface: { top: 0, bottom: 0 },
    },
  );
}

export function getMockInspectionSnapshot(): InspectionSnapshot {
  const inspections = createPlateInspections();
  const currentInspection = inspections[0];
  return {
    currentPlate: currentInspection.plate,
    defectTypes,
    defects: currentInspection.defects,
    records,
    status: {
      receiverPorts: Array.from({ length: 8 }, (_, index) => ({ index: index + 1, ok: index !== 2 })),
      cameraPorts: Array.from({ length: 8 }, (_, index) => ({ index: index + 1, ok: index !== 2 })),
      encoder: 'sync',
      plc: 'normal',
      l2: 'normal',
      alarmCount: 1,
    },
    summary: summarizeDefects(currentInspection.defects),
    heightProfile: currentInspection.heightProfile,
    inspections,
    source: 'demo',
  };
}

export function getPlateInspectionSnapshot(snapshot: InspectionSnapshot, recordSelector: string): InspectionSnapshot {
  const inspection = getInspectionByRecordSelector(snapshot, recordSelector);
  if (!inspection) {
    return snapshot;
  }
  return {
    ...snapshot,
    currentPlate: inspection.plate,
    defects: inspection.defects,
    summary: summarizeDefects(inspection.defects),
    heightProfile: inspection.heightProfile,
    captureImages: inspection.captureImages,
  };
}

export function getInspectionByRecordSelector(snapshot: InspectionSnapshot, recordSelector: string) {
  const directInspection = snapshot.inspections.find((item) => item.inspectionId === recordSelector)
    ?? snapshot.inspections.find((item) => item.plate.plateNo === recordSelector);
  if (directInspection) {
    return directInspection;
  }

  const record = snapshot.records.find((item) => item.id === recordSelector);
  if (!record) {
    return undefined;
  }
  return snapshot.inspections.find((item) => item.inspectionId === record.id)
    ?? snapshot.inspections.find((item) => item.plate.plateNo === record.plateNo);
}

export function getAllDefects(snapshot: InspectionSnapshot): DefectItem[] {
  return snapshot.inspections.flatMap((inspection) => inspection.defects);
}
