export type AcquisitionMode = 'online' | 'offline' | 'simulation';

export const acquisitionModeOptions: ReadonlyArray<{
  value: AcquisitionMode;
  label: string;
  detail: string;
}> = [
  { value: 'online', label: '在线（真实相机）', detail: '连接真实相机并运行生产采集' },
  { value: 'offline', label: '离线（历史模式）', detail: '不启动采集，继续浏览和处理历史数据' },
  { value: 'simulation', label: '模拟（数据回放）', detail: '使用已采集数据模拟生产采集流程' },
];

export function isAcquisitionMode(value: unknown): value is AcquisitionMode {
  return value === 'online' || value === 'offline' || value === 'simulation';
}

export function acquisitionModeLabel(mode: AcquisitionMode) {
  return acquisitionModeOptions.find((item) => item.value === mode)?.label ?? mode;
}

export function acquisitionModeDetail(mode: AcquisitionMode) {
  return acquisitionModeOptions.find((item) => item.value === mode)?.detail ?? '';
}
