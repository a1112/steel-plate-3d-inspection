import { getInspectionServiceOrigin } from './inspection-api';

export type BkvOnlineStatus = {
  enabled: boolean;
  running: boolean;
  source: 'bkv-online-mysql';
  databaseConnected: boolean;
  hasSnapshot: boolean;
  recordLimit: number;
  recordCount: number;
  previewImageCount: number;
  latestRecord?: {
    id?: string;
    plateNo?: string;
    time?: string;
    defectCount?: number;
  } | null;
  refreshIntervalMs: number;
  refreshAttempts: number;
  refreshSuccesses: number;
  lastSuccessAtMs: number;
  lastError: string | null;
};

export async function fetchBkvOnlineStatus(signal?: AbortSignal): Promise<BkvOnlineStatus> {
  const response = await fetch(`${getInspectionServiceOrigin()}/api/bkv-online/status`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(`在线转换状态读取失败（HTTP ${response.status}）`);
  }
  return response.json() as Promise<BkvOnlineStatus>;
}
