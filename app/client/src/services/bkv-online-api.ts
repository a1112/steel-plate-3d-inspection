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

type ImageRoi = { x: number; y: number; width: number; height: number };

function normalizedImageRoi(roi?: ImageRoi | null): ImageRoi | null {
  if (!roi
    || ![roi.x, roi.y, roi.width, roi.height].every(Number.isFinite)
    || roi.x < 0
    || roi.y < 0
    || roi.width <= 0
    || roi.height <= 0) {
    return null;
  }
  const normalized = {
    x: Math.round(roi.x),
    y: Math.round(roi.y),
    width: Math.round(roi.width),
    height: Math.round(roi.height),
  };
  return normalized.width >= 1 && normalized.height >= 1 ? normalized : null;
}

function parseBkvOnlineImageUrl(sourceUrl: string | undefined) {
  if (!sourceUrl?.trim()) return null;
  try {
    const url = new URL(sourceUrl, getInspectionServiceOrigin());
    return url.pathname === '/api/bkv-online/image' ? url : null;
  } catch {
    return null;
  }
}

export function isBkvOnlineImageUrl(sourceUrl: string | undefined) {
  return parseBkvOnlineImageUrl(sourceUrl) !== null;
}

export function bkvOnlineCroppedImageUrl(
  sourceUrl: string | undefined,
  roi?: ImageRoi | null,
) {
  const normalizedRoi = normalizedImageRoi(roi);
  const url = normalizedRoi ? parseBkvOnlineImageUrl(sourceUrl) : null;
  if (!url || !normalizedRoi) return '';
  url.searchParams.set('cropX', String(normalizedRoi.x));
  url.searchParams.set('cropY', String(normalizedRoi.y));
  url.searchParams.set('cropWidth', String(normalizedRoi.width));
  url.searchParams.set('cropHeight', String(normalizedRoi.height));
  return url.toString();
}
