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
  imageCache?: {
    entries: number;
    bytes: number;
    hits: number;
    misses: number;
    evictions: number;
    maxEntries: number;
    maxBytes: number;
  };
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
  lastErrorDetail?: string | null;
  processingLogPath?: string | null;
  processingLog?: Array<{
    schema?: string;
    operation?: string;
    recordId?: string;
    revision?: string;
    elapsedMs?: number;
    completedAtMs?: number;
    phases?: Record<string, number>;
    outputPath?: string | null;
    [key: string]: unknown;
  }>;
  dailyHistory?: Array<{
    date: string;
    recordCount: number;
    successCount: number;
    abnormalCount: number;
    timedCount: number;
    elapsedMs: number;
    averageElapsedMs?: number | null;
    latestRecordId?: string;
    latestCompletedAtMs?: number;
  }>;
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

export function bkvOnlineCroppedImageUrl(
  sourceUrl: string | undefined,
  roi?: { x: number; y: number; width: number; height: number } | null,
) {
  if (!sourceUrl || !sourceUrl.includes('/api/bkv-online/image')) return '';
  const url = new URL(sourceUrl, getInspectionServiceOrigin());
  if (roi && roi.width > 0 && roi.height > 0) {
    url.searchParams.set('cropX', String(Math.max(0, Math.round(roi.x))));
    url.searchParams.set('cropY', String(Math.max(0, Math.round(roi.y))));
    url.searchParams.set('cropWidth', String(Math.max(1, Math.round(roi.width))));
    url.searchParams.set('cropHeight', String(Math.max(1, Math.round(roi.height))));
  }
  return url.toString();
}
