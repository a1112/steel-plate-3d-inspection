import { invoke, isTauri } from '@tauri-apps/api/core';
import { getInspectionServiceOrigin } from '../services/inspection-api';

export type AppResourceUsageSource = 'tauri' | 'service';
export type AppResourceUsagePrecision = 'full' | 'degraded';

export interface AppResourceUsage {
  cpuUsage: number;
  memoryUsed: number;
  memoryTotal: number;
  memoryPercent: number;
  processCount: number;
  pythonMemoryUsed: number;
  rustMemoryUsed: number;
  webviewMemoryUsed: number;
  nodeMemoryUsed: number;
  tauriMemoryUsed: number;
  otherMemoryUsed: number;
  largestProcessName: string;
  largestProcessMemoryUsed: number;
  sampledAtMs: number;
  source: AppResourceUsageSource;
  precision: AppResourceUsagePrecision;
}

export interface ResourceUsageTransport {
  isTauri: () => boolean;
  invoke: <T>(command: string) => Promise<T>;
  fetchJson: <T>(path: string, signal?: AbortSignal) => Promise<T>;
}

type RawResourceUsage = Partial<AppResourceUsage> & {
  code?: number;
  error?: string;
};

function finiteNonNegative(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, value));
}

export function normalizeAppResourceUsage(
  raw: RawResourceUsage,
  fallbackSource: AppResourceUsageSource,
  fallbackPrecision: AppResourceUsagePrecision,
): AppResourceUsage {
  const source = raw.source === 'tauri' || raw.source === 'service' ? raw.source : fallbackSource;
  const precision = raw.precision === 'full' || raw.precision === 'degraded'
    ? raw.precision
    : fallbackPrecision;

  return {
    cpuUsage: finiteNonNegative(raw.cpuUsage, 100),
    memoryUsed: finiteNonNegative(raw.memoryUsed),
    memoryTotal: finiteNonNegative(raw.memoryTotal),
    memoryPercent: finiteNonNegative(raw.memoryPercent, 100),
    processCount: Math.floor(finiteNonNegative(raw.processCount)),
    pythonMemoryUsed: finiteNonNegative(raw.pythonMemoryUsed),
    rustMemoryUsed: finiteNonNegative(raw.rustMemoryUsed),
    webviewMemoryUsed: finiteNonNegative(raw.webviewMemoryUsed),
    nodeMemoryUsed: finiteNonNegative(raw.nodeMemoryUsed),
    tauriMemoryUsed: finiteNonNegative(raw.tauriMemoryUsed),
    otherMemoryUsed: finiteNonNegative(raw.otherMemoryUsed),
    largestProcessName: typeof raw.largestProcessName === 'string' ? raw.largestProcessName : '',
    largestProcessMemoryUsed: finiteNonNegative(raw.largestProcessMemoryUsed),
    sampledAtMs: finiteNonNegative(raw.sampledAtMs) || Date.now(),
    source,
    precision,
  };
}

export function formatResourceBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '--';
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatResourcePercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--';
  return `${Math.min(100, Math.max(0, value)).toFixed(1)}%`;
}

export function formatResourceBreakdown(usage: AppResourceUsage | null | undefined): string {
  if (!usage) return '--';
  const parts = [
    ['Python', usage.pythonMemoryUsed],
    ['Rust', usage.rustMemoryUsed],
    ['WebView', usage.webviewMemoryUsed],
    ['Node', usage.nodeMemoryUsed],
    ['Tauri', usage.tauriMemoryUsed],
    ['其他', usage.otherMemoryUsed],
  ]
    .filter(([, bytes]) => Number(bytes) > 0)
    .map(([label, bytes]) => `${label}: ${formatResourceBytes(Number(bytes))}`);
  if (usage.largestProcessName) {
    parts.push(
      `最大进程: ${usage.largestProcessName} ${formatResourceBytes(usage.largestProcessMemoryUsed)}`,
    );
  }
  return parts.join(' / ') || '--';
}

export function formatResourceMemorySummary(usage: AppResourceUsage | null | undefined): string {
  return usage ? formatResourceBytes(usage.memoryUsed) : '--';
}

async function fetchServiceJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${getInspectionServiceOrigin()}${path}`, { signal });
  if (!response.ok) {
    throw new Error(`resource monitor api ${response.status}`);
  }
  return response.json() as Promise<T>;
}

const productionTransport: ResourceUsageTransport = {
  isTauri,
  invoke: <T>(command: string) => invoke<T>(command),
  fetchJson: fetchServiceJson,
};

export async function fetchAppResourceUsageWithTransport(
  transport: ResourceUsageTransport,
  signal?: AbortSignal,
): Promise<AppResourceUsage> {
  if (transport.isTauri()) {
    const raw = await transport.invoke<RawResourceUsage>('app_resource_usage');
    return normalizeAppResourceUsage(raw, 'tauri', 'full');
  }

  const raw = await transport.fetchJson<RawResourceUsage>('/api/system/resources', signal);
  if (raw.code != null && raw.code !== 0) {
    throw new Error(raw.error || 'resource monitor unavailable');
  }
  return normalizeAppResourceUsage(raw, 'service', 'degraded');
}

export function fetchAppResourceUsage(signal?: AbortSignal): Promise<AppResourceUsage> {
  return fetchAppResourceUsageWithTransport(productionTransport, signal);
}
