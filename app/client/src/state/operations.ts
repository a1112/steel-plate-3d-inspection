import type { DefectItem, DeviceStatus, PlateInspection, Severity, Surface } from '../data/inspection';
import { severityLabels, surfaceLabels } from '../data/inspection';

export type ReportSeverityFilter = Severity | 'all';
export type ReportSurfaceFilter = Surface | 'all';
export type SystemAction = 'self-check' | 'clear-alarm' | 'sync-time' | 'export-log';
export type ServiceHealth = 'normal' | 'warning' | 'error';

export interface ReportFilters {
  severity: ReportSeverityFilter;
  surface: ReportSurfaceFilter;
  typeId: string | 'all';
  keyword: string;
}

export interface ReportMetrics {
  total: number;
  severe: number;
  review: number;
  minor: number;
  top: number;
  bottom: number;
  maxDepthMm: number;
}

export interface ReportMetadata {
  reportId: string;
  dataSource: string;
  dataThrough: string;
  inspectionIds: string[];
  materialIds: string[];
  recordCount: number;
}

function stableReportSuffix(values: string[]) {
  let hash = 2166136261;
  for (const character of values.join('|')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export function createReportMetadata(inspections: PlateInspection[], defects: DefectItem[]): ReportMetadata {
  const relevantMaterials = new Set(defects.map((defect) => defect.plateNo));
  const relevant = inspections.filter((inspection) => relevantMaterials.size === 0 || relevantMaterials.has(inspection.plate.plateNo));
  const inspectionIds = [...new Set(relevant.map((inspection) => inspection.inspectionId).filter((value): value is string => Boolean(value)))].sort();
  const materialIds = [...new Set((defects.length ? defects.map((defect) => defect.plateNo) : relevant.map((inspection) => inspection.plate.plateNo)).filter(Boolean))].sort();
  const identity = inspectionIds.length ? inspectionIds : materialIds.length ? materialIds : ['EMPTY'];
  const reportId = inspectionIds.length === 1
    ? `RPT-${inspectionIds[0]}`
    : `RPT-${inspectionIds.length > 1 ? 'MULTI' : 'DATA'}-${stableReportSuffix(identity)}`;
  const sources = new Set(relevant.map((inspection) => inspection.source || 'unknown'));
  const dataSource = sources.size === 1 && sources.has('production')
    ? '生产检测数据库'
    : sources.size === 1 && (sources.has('demo') || sources.has('test'))
      ? '演示数据'
      : sources.has('production')
        ? '生产与兼容记录'
        : '检测记录快照';
  const dataThrough = relevant
    .map((inspection) => inspection.plate.detectedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? '';
  return { reportId, dataSource, dataThrough, inspectionIds, materialIds, recordCount: defects.length };
}

export interface InspectionSettings {
  severeDepthMm: number;
  reviewDepthMm: number;
  minDefectWidthMm: number;
  cameraExposureUs: number;
  encoderPulsePerMeter: number;
  autoReview: boolean;
  alarmVolume: number;
  saveRawImages: boolean;
}

export type SettingsErrors = Partial<Record<keyof InspectionSettings, string>>;

export interface SystemEvent {
  id: string;
  time: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface OperationState {
  alarmCount: number;
  serviceHealth: {
    inspectionEngine: ServiceHealth;
    cameraAcquisition: ServiceHealth;
    plcBridge: ServiceHealth;
    l2Uploader: ServiceHealth;
  };
  events: SystemEvent[];
  lastSyncTime: string;
}

function operationTimestamp() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}
const defaultInspectionSettings: InspectionSettings = {
  severeDepthMm: 0.12,
  reviewDepthMm: 0.08,
  minDefectWidthMm: 0.2,
  cameraExposureUs: 850,
  encoderPulsePerMeter: 2048,
  autoReview: true,
  alarmVolume: 86,
  saveRawImages: true,
};

export function createDefaultReportFilters(): ReportFilters {
  return {
    severity: 'all',
    surface: 'all',
    typeId: 'all',
    keyword: '',
  };
}

export function filterDefectsForReport(defects: DefectItem[], filters: ReportFilters): DefectItem[] {
  const keyword = filters.keyword.trim().toLowerCase();
  return defects.filter((defect) => {
    const matchesSeverity = filters.severity === 'all' || defect.severity === filters.severity;
    const matchesSurface = filters.surface === 'all' || defect.surface === filters.surface;
    const matchesType = filters.typeId === 'all' || defect.typeId === filters.typeId;
    const searchable = [
      defect.id,
      defect.plateNo,
      defect.typeLabel,
      surfaceLabels[defect.surface],
      severityLabels[defect.severity],
      String(defect.distanceHeadMm),
    ]
      .join(' ')
      .toLowerCase();
    return matchesSeverity && matchesSurface && matchesType && (!keyword || searchable.includes(keyword));
  });
}

export function getReportMetrics(defects: DefectItem[]): ReportMetrics {
  return defects.reduce<ReportMetrics>(
    (metrics, defect) => {
      metrics.total += 1;
      metrics[defect.severity] += 1;
      metrics[defect.surface] += 1;
      metrics.maxDepthMm = Math.max(metrics.maxDepthMm, Number(Math.abs(defect.depthMm).toFixed(2)));
      return metrics;
    },
    {
      total: 0,
      severe: 0,
      review: 0,
      minor: 0,
      top: 0,
      bottom: 0,
      maxDepthMm: 0,
    },
  );
}

export function applyInspectionSettingsToDefects(
  defects: DefectItem[],
  settings: Pick<InspectionSettings, 'severeDepthMm' | 'reviewDepthMm' | 'minDefectWidthMm'>,
): DefectItem[] {
  const usesDefaultGradeSettings =
    settings.severeDepthMm === defaultInspectionSettings.severeDepthMm &&
    settings.reviewDepthMm === defaultInspectionSettings.reviewDepthMm &&
    settings.minDefectWidthMm === defaultInspectionSettings.minDefectWidthMm;
  if (usesDefaultGradeSettings) {
    return defects.map((defect) => ({ ...defect }));
  }
  return defects.map((defect) => {
    const depthMm = Math.abs(defect.depthMm);
    const effectiveWidthMm = Math.max(defect.widthMm, defect.heightMm);
    let severity: Severity = 'minor';
    if (effectiveWidthMm >= settings.minDefectWidthMm && depthMm >= settings.severeDepthMm) {
      severity = 'severe';
    } else if (effectiveWidthMm >= settings.minDefectWidthMm && depthMm >= settings.reviewDepthMm) {
      severity = 'review';
    }
    return defect.severity === severity ? defect : { ...defect, severity };
  });
}

export function createDefaultSettings(): InspectionSettings {
  return { ...defaultInspectionSettings };
}

export function validateSettings(settings: InspectionSettings): SettingsErrors {
  const errors: SettingsErrors = {};
  if (settings.severeDepthMm <= settings.reviewDepthMm) {
    errors.severeDepthMm = '严重阈值必须大于待复核阈值';
  }
  if (settings.reviewDepthMm <= 0) {
    errors.reviewDepthMm = '待复核阈值必须大于 0';
  }
  if (settings.minDefectWidthMm <= 0) {
    errors.minDefectWidthMm = '最小缺陷宽度必须大于 0';
  }
  if (settings.cameraExposureUs < 100 || settings.cameraExposureUs > 5000) {
    errors.cameraExposureUs = '曝光时间范围为 100-5000us';
  }
  if (settings.encoderPulsePerMeter < 500 || settings.encoderPulsePerMeter > 10000) {
    errors.encoderPulsePerMeter = '编码器脉冲范围为 500-10000';
  }
  if (settings.alarmVolume < 0 || settings.alarmVolume > 100) {
    errors.alarmVolume = '报警音量范围为 0-100';
  }
  return errors;
}

export function saveSettingsDraft(current: InspectionSettings, draft: InspectionSettings): InspectionSettings {
  const errors = validateSettings(draft);
  if (Object.keys(errors).length > 0) {
    return { ...current };
  }
  return { ...draft };
}

export function createInitialOperationState(): OperationState {
  return {
    alarmCount: 0,
    serviceHealth: {
      inspectionEngine: 'warning',
      cameraAcquisition: 'warning',
      plcBridge: 'normal',
      l2Uploader: 'normal',
    },
    events: [],
    lastSyncTime: '',
  };
}

function prependEvent(state: OperationState, message: string, level: SystemEvent['level'] = 'info'): OperationState {
  const nextIndex = state.events.length + 1;
  return {
    ...state,
    events: [
      {
        id: `EVT-${String(nextIndex).padStart(3, '0')}`,
        time: operationTimestamp(),
        level,
        message,
      },
      ...state.events,
    ],
  };
}

export function runSystemAction(state: OperationState, action: SystemAction): OperationState {
  if (action === 'self-check') {
    return prependEvent(
      {
        ...state,
        serviceHealth: {
          inspectionEngine: 'normal',
          cameraAcquisition: 'normal',
          plcBridge: 'normal',
          l2Uploader: 'normal',
        },
      },
      '系统自检完成，核心服务正常',
    );
  }
  if (action === 'clear-alarm') {
    return prependEvent({ ...state, alarmCount: 0 }, '已清除当前报警计数');
  }
  if (action === 'sync-time') {
    return prependEvent({ ...state, lastSyncTime: operationTimestamp() }, '系统时间已同步到工控主站');
  }
  return prependEvent(state, '已生成运行日志导出文件');
}

export function getDeviceStatusWithOperation(status: DeviceStatus, operation: Pick<OperationState, 'alarmCount'>): DeviceStatus {
  return {
    ...status,
    alarmCount: status.alarmCount + operation.alarmCount,
  };
}

export function exportRowsAsCsv(defects: DefectItem[]): string {
  const header = '序号,钢管号,缺陷类别,相机区,等级,距头距离(mm),尺寸(mm),深度(mm)';
  const rows = defects.map((defect) =>
    [
      defect.id,
      defect.plateNo,
      defect.typeLabel,
      surfaceLabels[defect.surface],
      severityLabels[defect.severity],
      defect.distanceHeadMm,
      `${defect.widthMm.toFixed(2)} x ${defect.heightMm.toFixed(2)}`,
      defect.depthMm.toFixed(2),
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

export function exportReportAsJson(metadata: ReportMetadata, defects: DefectItem[]): string {
  return JSON.stringify({ schema: 'steel.inspection.report.v1', metadata, defects }, null, 2);
}
