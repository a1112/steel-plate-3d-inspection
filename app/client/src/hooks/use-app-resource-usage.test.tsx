import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppResourceUsage } from '../lib/app-resource-usage';
import { useAppResourceUsage } from './use-app-resource-usage';

const usage: AppResourceUsage = {
  cpuUsage: 12.4,
  memoryUsed: 1024,
  memoryTotal: 8192,
  memoryPercent: 12.5,
  processCount: 2,
  pythonMemoryUsed: 0,
  rustMemoryUsed: 1024,
  webviewMemoryUsed: 0,
  nodeMemoryUsed: 0,
  tauriMemoryUsed: 0,
  otherMemoryUsed: 0,
  largestProcessName: 'steel-inspection-service.exe',
  largestProcessMemoryUsed: 1024,
  sampledAtMs: 123,
  source: 'service',
  precision: 'degraded',
};

function Harness({ loader }: { loader: (signal?: AbortSignal) => Promise<AppResourceUsage> }) {
  const state = useAppResourceUsage(loader);
  return (
    <output>
      {state.usage?.cpuUsage ?? 'none'}|{state.loading ? 'loading' : 'idle'}|{state.stale ? 'stale' : 'fresh'}
    </output>
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

describe('useAppResourceUsage', () => {
  it('loads immediately, polls every five seconds, and prevents overlap', async () => {
    vi.useFakeTimers();
    let resolveFirst: ((value: AppResourceUsage) => void) | undefined;
    const loader = vi.fn()
      .mockImplementationOnce(() => new Promise<AppResourceUsage>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValue(usage);

    render(<Harness loader={loader} />);
    expect(loader).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(loader).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst?.(usage);
      await Promise.resolve();
    });
    expect(screen.getByText('12.4|idle|fresh')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('pauses while hidden and refreshes as soon as the page becomes visible', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    const loader = vi.fn().mockResolvedValue(usage);

    render(<Harness loader={loader} />);
    expect(loader).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(loader).not.toHaveBeenCalled();

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('keeps the last successful snapshot when a later sample fails', async () => {
    vi.useFakeTimers();
    const loader = vi.fn()
      .mockResolvedValueOnce(usage)
      .mockRejectedValueOnce(new Error('offline'));

    render(<Harness loader={loader} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('12.4|idle|fresh')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText('12.4|idle|stale')).toBeInTheDocument();
  });
});
