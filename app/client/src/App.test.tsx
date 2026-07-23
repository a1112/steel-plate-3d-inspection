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
  it('renders ready BKV data inside the shared dashboard without online hardware polling', async () => {
    window.history.replaceState(null, '', '/?app=terminal');
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/api/bkv/status')) {
        return new Response(JSON.stringify({
          provider: 'bkv', ready: true, mode: 'offline-replay-no-camera-hardware', cameraMode: 'offline-file',
          cameraCount: 6, physicalCamerasOnline: 0, batchId: 'legacy-1893700-1893710', materialCount: 11,
          nextIndex: 0, nextLegacySeqNo: 1893700, completed: false,
        }), { status: 200 });
      }
      if (url.includes('/api/bkv/materials')) {
        return new Response(JSON.stringify({
          provider: 'bkv',
          materials: [{
            legacySeqNo: 1893700,
            legacyCheckRecordSeqNo: 661700,
            steelId: '253B09401250925A12004328',
            steelType: '37Mn/2',
            lengthMm: 12096,
            outerDiameterLegacyValue: 233.664,
            wallThicknessMm: null,
            inspectionTime: '2025-09-26 03:36:17',
            defects: [{
              legacyDefectId: 706831,
              cameraId: 1,
              classNo: 1,
              className: '轧折',
              grade: 2,
              confidence: 0.51,
              imageRect2d: { left: 20, top: 40, right: 60, bottom: 100 },
              steelRect2d: { left: 20, top: 40, right: 60, bottom: 100 },
            }],
            cameras: [],
            artifacts: {
              unwrapped: { path: 'preview/unwrapped.png', size: 1, sha256: 'a'.repeat(64) },
              cylinder: { path: 'preview/cylinder.json', size: 1, sha256: 'b'.repeat(64) },
              summary: { path: 'preview/summary.json', size: 1, sha256: 'c'.repeat(64) },
            },
          }],
        }), { status: 200 });
      }
      if (url.includes('/api/inspection-world/meta')) {
        return new Response(JSON.stringify({
          schema: 'steel.inspection-world.meta.v1',
          provider: 'bkv',
          recordId: '1893700',
          sourceFrameCount: 6,
          world: {
            width: 600,
            height: 1024,
            tileSize: 512,
            maxLevel: 10,
            cameras: Array.from({ length: 6 }, (_, index) => ({
              cameraId: index + 1,
              frameWidth: 100,
              frameHeight: 1024,
              frameNumbers: [0],
              orientation: { rotation: 0, flipX: false, flipY: false, frameOrder: 'ascending' },
              width: 100,
              height: 1024,
              offsetX: index * 100,
            })),
          },
        }), { status: 200 });
      }
      if (url.includes('/api/inspection-world/defects')) {
        return new Response(JSON.stringify({
          schema: 'steel.inspection-world.defects.v1',
          provider: 'bkv',
          recordId: '1893700',
          defects: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify(getMockInspectionSnapshot()), { status: 200 });
    }));

    render(<App />);
    expect(await screen.findByText('钢管3D表面检测系统')).toBeInTheDocument();
    expect(screen.getByText('BKV 模式')).toBeInTheDocument();
    expect(screen.getByText('离线数据')).toBeInTheDocument();
    expect(screen.getByText('6/6')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '检测记录' })).toBeInTheDocument();
    expect(screen.getAllByText('253B09401250925A12004328').length).toBeGreaterThan(0);
    expect(screen.getByText('BKV 离线数据')).toBeInTheDocument();
    expect(screen.getAllByText('轧折').length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'BKV 离线回放' })).not.toBeInTheDocument();
    expect(screen.queryByText('相机状态')).not.toBeInTheDocument();
    expect(requestedUrls.some((url) => url.includes('/api/inspection/snapshot'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/api/capture/health'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/api/trigger/status'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/api/inspection-world/meta') && url.includes('1893700'))).toBe(true);

    const moreButton = screen.getByRole('button', { name: '更多功能' });
    fireEvent.click(moreButton);
    const replayItem = screen.getByRole('menuitem', { name: '离线回放' });
    expect(replayItem).toBeEnabled();
    expect(replayItem).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('钢管3D表面检测系统')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: '在线检测' }));
    expect(new URLSearchParams(window.location.search).get('view')).toBe('online');
    expect(await screen.findByText('模式不匹配')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '更多功能' }));
    expect(screen.getByRole('menuitem', { name: '在线检测' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('menuitem', { name: '离线回放' })).toBeEnabled();
    fireEvent.click(screen.getByRole('menuitem', { name: '离线回放' }));

    expect(await screen.findByText('BKV 模式')).toBeInTheDocument();
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

  it('collapses the lower analysis area from the window controls without a footer duplicate', async () => {
    const { container } = render(<App />);

    const collapse = await screen.findByRole('button', { name: '收起缺陷分析区' });
    expect(collapse).toBe(container.querySelector('.window-controls .window-analysis-collapse'));
    expect(screen.getAllByRole('button', { name: '收起缺陷分析区' })).toHaveLength(1);
    expect(container.querySelector('.app-footer-collapse')).not.toBeInTheDocument();

    fireEvent.click(collapse);
    expect(container.querySelector('.center-column')).toHaveClass('analysis-collapsed');
    const expand = screen.getByRole('button', { name: '展开缺陷分析区' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(expand);
    expect(container.querySelector('.center-column')).not.toHaveClass('analysis-collapsed');
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
