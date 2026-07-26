import { describe, expect, it, vi } from 'vitest';
import {
  fetchAppResourceUsageWithTransport,
  formatResourceBreakdown,
  formatResourceBytes,
  formatResourcePercent,
  normalizeAppResourceUsage,
} from './app-resource-usage';

const rawUsage = {
  cpuUsage: 12.36,
  memoryUsed: 1_572_864,
  memoryTotal: 8_589_934_592,
  memoryPercent: 0.02,
  processCount: 3,
  pythonMemoryUsed: 1_048_576,
  rustMemoryUsed: 524_288,
  webviewMemoryUsed: 0,
  nodeMemoryUsed: 0,
  tauriMemoryUsed: 0,
  otherMemoryUsed: 0,
  largestProcessName: 'python.exe',
  largestProcessMemoryUsed: 1_048_576,
  sampledAtMs: 123,
};

describe('app resource usage', () => {
  it('formats resource values for the compact footer', () => {
    expect(formatResourceBytes(1_572_864)).toBe('1.5 MB');
    expect(formatResourceBytes(Number.NaN)).toBe('--');
    expect(formatResourceBytes(undefined)).toBe('--');
    expect(formatResourcePercent(12.36)).toBe('12.4%');
    expect(formatResourcePercent(153)).toBe('100.0%');
  });

  it('normalizes malformed metrics to finite non-negative values', () => {
    const usage = normalizeAppResourceUsage({
      ...rawUsage,
      cpuUsage: Number.POSITIVE_INFINITY,
      memoryUsed: -10,
      processCount: -2,
    }, 'service', 'degraded');

    expect(usage.cpuUsage).toBe(0);
    expect(usage.memoryUsed).toBe(0);
    expect(usage.processCount).toBe(0);
    expect(usage.source).toBe('service');
    expect(usage.precision).toBe('degraded');
  });

  it('omits empty runtime groups from the breakdown', () => {
    const usage = normalizeAppResourceUsage(rawUsage, 'tauri', 'full');

    expect(formatResourceBreakdown(usage)).toBe(
      'Python: 1.0 MB / Rust: 512.0 KB / 最大进程: python.exe 1.0 MB',
    );
  });

  it('prefers the Tauri command for a full desktop snapshot', async () => {
    const invoke = vi.fn().mockResolvedValue(rawUsage);
    const fetchJson = vi.fn();

    const usage = await fetchAppResourceUsageWithTransport({
      isTauri: () => true,
      invoke,
      fetchJson,
    });

    expect(invoke).toHaveBeenCalledWith('app_resource_usage');
    expect(fetchJson).not.toHaveBeenCalled();
    expect(usage.source).toBe('tauri');
    expect(usage.precision).toBe('full');
  });

  it('falls back to the Rust service in a browser', async () => {
    const invoke = vi.fn();
    const fetchJson = vi.fn().mockResolvedValue({
      code: 0,
      ...rawUsage,
      source: 'service',
      precision: 'degraded',
    });
    const signal = new AbortController().signal;

    const usage = await fetchAppResourceUsageWithTransport({
      isTauri: () => false,
      invoke,
      fetchJson,
    }, signal);

    expect(invoke).not.toHaveBeenCalled();
    expect(fetchJson).toHaveBeenCalledWith('/api/system/resources', signal);
    expect(usage.source).toBe('service');
    expect(usage.precision).toBe('degraded');
  });
});
