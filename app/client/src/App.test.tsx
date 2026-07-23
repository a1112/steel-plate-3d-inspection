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

describe('App BKV provider selection', () => {
  it('switches only when the service explicitly reports a ready bkv provider', async () => {
    window.history.replaceState(null, '', '/?app=terminal');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/bkv/status')) {
        return new Response(JSON.stringify({
          provider: 'bkv', ready: true, mode: 'offline-replay-no-camera-hardware', cameraMode: 'offline-file',
          cameraCount: 6, physicalCamerasOnline: 0, batchId: 'legacy-1893700-1893710', materialCount: 11,
          nextIndex: 0, nextLegacySeqNo: 1893700, completed: false,
        }), { status: 200 });
      }
      if (url.includes('/api/bkv/materials')) {
        return new Response(JSON.stringify({ provider: 'bkv', materials: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(getMockInspectionSnapshot()), { status: 200 });
    }));

    render(<App />);
    expect(await screen.findByRole('heading', { name: 'BKV 离线回放' })).toBeInTheDocument();
    expect(screen.getByText('真实相机在线 0')).toBeInTheDocument();
    const moreButton = screen.getByRole('button', { name: '更多功能' });
    fireEvent.click(moreButton);
    const replayItem = screen.getByRole('menuitem', { name: '离线回放' });
    expect(replayItem).toBeEnabled();
    expect(replayItem).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('钢管3D表面检测系统')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: '在线检测' }));
    expect(await screen.findByText('钢管3D表面检测系统')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('view')).toBe('online');

    fireEvent.click(screen.getByRole('button', { name: '更多功能' }));
    expect(screen.getByRole('menuitem', { name: '在线检测' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('menuitem', { name: '离线回放' })).toBeEnabled();
    fireEvent.click(screen.getByRole('menuitem', { name: '离线回放' }));

    expect(await screen.findByRole('heading', { name: 'BKV 离线回放' })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('view')).toBe('bkv');
  });
});

describe('App online severity filters', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/?app=terminal');
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

  it('shows the complete scrollable defect list and toggles statistics severities', async () => {
    const { container } = render(<App />);

    const severeCard = await screen.findByRole('button', { name: '严重等级过滤，当前4项' });
    const reviewCard = screen.getByRole('button', { name: '待复核等级过滤，当前3项' });
    const minorCard = screen.getByRole('button', { name: '轻微等级过滤，当前5项' });
    expect(severeCard).toHaveAttribute('aria-pressed', 'true');
    expect(reviewCard).toHaveAttribute('aria-pressed', 'true');
    expect(minorCard).toHaveAttribute('aria-pressed', 'true');
    expect(getDefectTableRows(container)).toHaveLength(12);
    expect(container.querySelector('.defect-list-panel .pager')).not.toBeInTheDocument();

    fireEvent.click(severeCard);

    expect(severeCard).toHaveAttribute('aria-pressed', 'false');
    const rowsWithoutSevere = getDefectTableRows(container);
    expect(rowsWithoutSevere).toHaveLength(8);
    expect(rowsWithoutSevere.every((row) => !row.endsWith('严重'))).toBe(true);

    fireEvent.click(severeCard);

    expect(severeCard).toHaveAttribute('aria-pressed', 'true');
    const restoredRows = getDefectTableRows(container);
    expect(restoredRows).toHaveLength(12);
    expect(restoredRows.some((row) => row.endsWith('严重'))).toBe(true);
    expect(restoredRows.some((row) => row.endsWith('轻微'))).toBe(true);
    expect(restoredRows.some((row) => row.endsWith('待复核'))).toBe(true);

    const followLatest = screen.getByRole('button', { name: '跟随最新' });
    const holdHistory = screen.getByRole('button', { name: '固定当前' });
    expect(followLatest).toHaveClass('active');
    fireEvent.click(holdHistory);
    expect(holdHistory).toHaveClass('active');
  });

  it('keeps follow and view controls with the unfolded map instead of a separate status bar', async () => {
    render(<App />);

    await screen.findByRole('button', { name: '跟随最新' });

    expect(screen.queryByRole('status', { name: '检测数据实时跟随状态' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: '检测记录跟随模式' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '显示视图切换' })).toBeInTheDocument();
  });

  it('keeps offline replay visible but disabled outside BKV mode', async () => {
    render(<App />);

    const moreButton = await screen.findByRole('button', { name: '更多功能' });
    fireEvent.click(moreButton);

    expect(screen.getByRole('menuitem', { name: '离线回放' })).toBeDisabled();
    expect(screen.getByText('仅 BKV 模式可用')).toBeInTheDocument();
  });

  it('places defect filters before the list without a duplicate counts panel', async () => {
    render(<App />);

    const filterHeading = await screen.findByRole('heading', { name: '缺陷过滤' });
    const listHeading = screen.getByRole('heading', { name: '缺陷检测列表' });
    expect(filterHeading.compareDocumentPosition(listHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '缺陷数量' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '凹坑类别过滤，当前3项' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '严重等级过滤，当前4项' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '本钢管统计' })).not.toBeInTheDocument();
  });
});
