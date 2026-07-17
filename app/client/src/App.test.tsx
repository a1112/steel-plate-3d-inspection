import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App, { formatStorageBytes, formatStorageWarning } from './App';
import { getMockInspectionSnapshot } from './data/inspection';

function getDefectTableRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.defect-table tbody tr')).map((row) => row.textContent?.trim() ?? '');
}

describe('storage capacity warning presentation', () => {
  it('shows remaining capacity, percentage, and estimated production time', () => {
    expect(formatStorageBytes(30 * 1024 ** 3)).toBe('30.0 GiB');
    expect(formatStorageWarning({
      freeBytes: 30 * 1024 ** 3,
      freePercent: 12,
      estimatedRemainingSeconds: 5.5 * 3600,
    })).toBe('存储容量预警：剩余 30.0 GiB / 12.0%，预计 5.5 小时');
  });

  it('keeps the warning useful when recent write throughput is unavailable', () => {
    expect(formatStorageWarning({
      freeBytes: 8 * 1024 ** 3,
      freePercent: 7.25,
      estimatedRemainingSeconds: null,
    })).toBe('存储容量预警：剩余 8.0 GiB / 7.3%，预计 按当前吞吐暂无法估算');
  });
});

describe('App online severity filters', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/inspection/settings')) {
          return {
            ok: true,
            json: async () => ({
              severeDepthMm: 0.12,
              reviewDepthMm: 0.08,
              minDefectWidthMm: 0.2,
              cameraExposureUs: 850,
              encoderPulsePerMeter: 2048,
              autoReview: true,
              alarmVolume: 86,
              saveRawImages: true,
            }),
          };
        }
        return {
          ok: true,
          json: async () => getMockInspectionSnapshot(),
        };
      }),
    );
  });

  it('defaults all statistics severities selected and toggles them from the online defect list', async () => {
    const { container } = render(<App />);

    const severeCard = await screen.findByRole('button', { name: '严重等级过滤，当前4项' });
    const reviewCard = screen.getByRole('button', { name: '待复核等级过滤，当前3项' });
    const minorCard = screen.getByRole('button', { name: '轻微等级过滤，当前5项' });
    expect(severeCard).toHaveAttribute('aria-pressed', 'true');
    expect(reviewCard).toHaveAttribute('aria-pressed', 'true');
    expect(minorCard).toHaveAttribute('aria-pressed', 'true');
    expect(getDefectTableRows(container)).toHaveLength(10);

    fireEvent.click(severeCard);

    expect(severeCard).toHaveAttribute('aria-pressed', 'false');
    const rowsWithoutSevere = getDefectTableRows(container);
    expect(rowsWithoutSevere).toHaveLength(8);
    expect(rowsWithoutSevere.every((row) => !row.endsWith('严重'))).toBe(true);

    fireEvent.click(severeCard);

    expect(severeCard).toHaveAttribute('aria-pressed', 'true');
    const restoredRows = getDefectTableRows(container);
    expect(restoredRows).toHaveLength(10);
    expect(restoredRows.some((row) => row.endsWith('严重'))).toBe(true);
    expect(restoredRows.some((row) => row.endsWith('轻微'))).toBe(true);
    expect(restoredRows.some((row) => row.endsWith('待复核'))).toBe(true);

    const followLatest = screen.getByRole('button', { name: '跟随最新' });
    const holdHistory = screen.getByRole('button', { name: '固定当前' });
    expect(followLatest).toHaveClass('active');
    fireEvent.click(holdHistory);
    expect(holdHistory).toHaveClass('active');
  });
});
