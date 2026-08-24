export const DEFAULT_SYSTEM_NAME = '北满特钢小棒检测系统';

export function resolveSystemName(configuredName?: string | null): string {
  return configuredName?.trim() || DEFAULT_SYSTEM_NAME;
}
