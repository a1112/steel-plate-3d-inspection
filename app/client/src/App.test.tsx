import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App, { formatStorageBytes, formatStorageWarning } from './App';
import { getMockInspectionSnapshot } from './data/inspection';

const bkvRuntimeProfile = {
  schema: 'steel.runtime-profile.public.v1',
  siteDisplayName: '北满特钢小棒检测系统',
  profileId: 'bkv-6',
  displayName: 'BKV 六相机离线转换',
  provider: 'bkv',
  dataSource: 'converted-local',
  cameraConnection: 'none',
  cameraCount: 6,
  cameras: Array.from({ length: 6 }, (_, index) => ({
    id: `C${index + 1}`,
    displayOrder: index + 1,
    sourceCameraId: index + 1,
    role: `legacy-${index + 1}`,
  })),
  configHash: 'bkv-active',
  capabilities: {
    directCamera: false,
    captureManagement: false,
    reconstruction: false,
    offlineReplay: true,
  },
};

const directRuntimeProfile = {
  ...bkvRuntimeProfile,
  profileId: 'direct-8',
  displayName: '八相机在线直连',
  provider: 'direct',
  dataSource: 'online',
  cameraConnection: 'headless-cpp',
  cameraCount: 8,
  cameras: Array.from({ length: 8 }, (_, index) => ({
    id: `C${index + 1}`,
    displayOrder: index + 1,
    sourceCameraId: index + 1,
    role: `camera-${index + 1}`,
  })),
  configHash: 'direct-active',
  capabilities: {
    directCamera: true,
    captureManagement: true,
    reconstruction: true,
    offlineReplay: false,
  },
};

const bkvOnlineRuntimeProfile = {
  ...bkvRuntimeProfile,
  profileId: 'bkv-online-6',
  displayName: 'BKV 在线转换',
  dataSource: 'bkv-online-mysql',
  capabilities: {
    directCamera: false,
    captureManagement: false,
    reconstruction: false,
    offlineReplay: false,
  },
};

const bkvRecordsPayload = {
  schema: 'steel.inspection-world.records.v1',
  provider: 'bkv',
  ready: true,
  cameraCount: 6,
  batchId: 'legacy-1893700-1893710',
  records: [{
    recordId: '1893700',
    legacySeqNo: 1893700,
    steelId: '253B09401250925A12004328',
    steelType: '37Mn/2',
    lengthMm: 12096,
    outerDiameterMm: 233.664,
    wallThicknessMm: null,
    inspectionTime: '2025-09-26 03:36:17',
    defectCount: 1,
    cameraCount: 6,
    sourceHash: 'record-hash-1893700',
  }, {
    recordId: '1893701',
    legacySeqNo: 1893701,
    steelId: '253B09401250925A12004329',
    steelType: '37Mn/2',
    lengthMm: 12096,
    outerDiameterMm: 232.939,
    wallThicknessMm: null,
    inspectionTime: '2025-09-26 03:40:36',
    defectCount: 0,
    cameraCount: 6,
    sourceHash: 'record-hash-1893701',
  }],
};

function getDefectTableRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.defect-table tbody tr')).map((row) => row.textContent?.trim() ?? '');
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{
        target,
        contentRect: target.getBoundingClientRect(),
        borderBoxSize: [],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
      }], this);
    }
    unobserve() {}
    disconnect() {}
  });
});

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

describe('App disconnected startup', () => {
  it('enters the dashboard and offers IP configuration in an error dialog', async () => {
    window.history.replaceState(null, '', '/?app=terminal');
    window.localStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    render(<App />);

    const dialog = await screen.findByRole('alertdialog', { name: '未连接到检测服务' });
    expect(screen.queryByRole('heading', { name: '运行配置不可用' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '记录' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '直接进入' }));
    expect(screen.queryByRole('alertdialog', { name: '未连接到检测服务' })).not.toBeInTheDocument();
  });
});

describe('App background monitor route', () => {
  it('renders the dedicated task monitor and its read-only service endpoints', async () => {
    window.history.replaceState(null, '', '/?app=monitor');
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/api/runtime-profile')) {
        return new Response(JSON.stringify(directRuntimeProfile), { status: 200 });
      }
      if (url.includes('/api/health/details')) {
        return new Response(JSON.stringify({
          ok: true,
          status: 'ready',
          service: 'steel-inspection-service',
          uptimeMs: 1000,
          checks: { taskWorker: { ok: true, status: 'idle', running: true } },
        }), { status: 200 });
      }
      if (url.includes('/api/production/status')) {
        return new Response(JSON.stringify({
          code: 0,
          tasks: { queueDepth: 0, capacity: 128, worker: { running: true } },
        }), { status: 200 });
      }
      if (url.includes('/api/production/tasks')) {
        return new Response(JSON.stringify({
          code: 0,
          total: 0,
          limit: 16,
          offset: 0,
          tasks: [],
          taskWorker: { running: true, capacity: 128 },
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }));

    render(<App />);

    expect(await screen.findByTestId('background-monitor-app')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '后台任务监控' })).toBeInTheDocument();
    await waitFor(() => {
      expect(requestedUrls.some((url) => url.includes('/api/health/details'))).toBe(true);
      expect(requestedUrls.some((url) => url.includes('/api/production/tasks'))).toBe(true);
    });
    expect(requestedUrls.some((url) => url.includes('/api/runtime-profile'))).toBe(false);
    expect(screen.queryByRole('alertdialog', { name: '未连接到检测服务' })).not.toBeInTheDocument();
  });
});

describe('App BKV provider selection', () => {
  it('uses the unified standard record catalog in BKV online mode', async () => {
    window.history.replaceState(null, '', '/?app=terminal&view=online');
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/api/runtime-profile')) {
        return new Response(JSON.stringify(bkvOnlineRuntimeProfile), { status: 200 });
      }
      if (url.includes('/api/inspection-world/records')) {
        return new Response(JSON.stringify(bkvRecordsPayload), { status: 200 });
      }
      if (url.includes('/api/inspection-world/meta')) {
        return new Response(JSON.stringify({
          schema: 'steel.inspection-world.meta.v1',
          provider: 'bkv',
          recordId: '1893700',
          sourceFrameCount: 6,
          sourceRevision: 'revision-1893700',
          cache: { state: 'on-demand', tileSize: 512, maxLevel: 3 },
          world: { width: 600, height: 1024, tileSize: 512, maxLevel: 3, cameras: [] },
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
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    render(<App />);

    expect((await screen.findAllByText('253B09401250925A12004328')).length).toBeGreaterThan(0);
    expect(await screen.findByTestId('inspection-world-viewport')).toHaveAttribute('data-record-id', '1893700');
    expect(requestedUrls.some((url) => url.includes('/api/inspection-world/records'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('/api/inspection/snapshot'))).toBe(false);
  });

  it('renders ready BKV data inside the shared dashboard without online hardware polling', async () => {
    window.history.replaceState(null, '', '/?app=terminal');
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/api/runtime-profile')) {
        return new Response(JSON.stringify(bkvRuntimeProfile), { status: 200 });
      }
      if (url.includes('/api/inspection-world/records')) {
        return new Response(JSON.stringify(bkvRecordsPayload), { status: 200 });
      }
      if (url.includes('/api/inspection-world/meta')) {
        const recordId = new URL(url).searchParams.get('recordId') ?? '1893700';
        return new Response(JSON.stringify({
          schema: 'steel.inspection-world.meta.v1',
          provider: 'bkv',
          recordId,
          sourceFrameCount: 6,
          sourceRevision: `revision-${recordId}`,
          cache: { state: 'on-demand', tileSize: 512, maxLevel: 3 },
          world: {
            width: 600,
            height: 1024,
            tileSize: 512,
            maxLevel: 3,
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
        const recordId = new URL(url).searchParams.get('recordId') ?? '1893700';
        return new Response(JSON.stringify({
          schema: 'steel.inspection-world.defects.v1',
          provider: 'bkv',
          recordId,
          defects: recordId === '1893700' ? [{
            id: 706831,
            className: '轧折',
            cameraId: 1,
            imageIndex: 0,
            locatable: true,
            worldRect: { x: 20, y: 40, width: 40, height: 60 },
          }] : [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify(getMockInspectionSnapshot()), { status: 200 });
    }));

    const { container } = render(<App />);
    expect((await screen.findAllByText('北满特钢小棒检测系统')).length).toBeGreaterThan(0);
    expect(screen.getByText('BKV 模式')).toBeInTheDocument();
    expect(screen.getByText('离线数据')).toBeInTheDocument();
    expect(screen.getByText('6/6')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '记录' })).toBeInTheDocument();
    expect(screen.getAllByText('253B09401250925A12004328').length).toBeGreaterThan(0);
    expect(screen.getByText('来源：BKV 标准离线仓库')).toBeInTheDocument();
    expect(screen.getByText(/转换后标准数据/)).toBeInTheDocument();
    expect(screen.getByText('硬件控制已禁用')).toBeInTheDocument();
    expect((await screen.findAllByText('轧折')).length).toBeGreaterThan(0);
    expect(screen.getByText('BKV 离线记录')).toBeInTheDocument();
    expect(screen.queryByText('实时跟随最新检测')).not.toBeInTheDocument();
    expect(screen.queryByText(/每 8 秒刷新/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'BKV 离线回放' })).not.toBeInTheDocument();
    expect(screen.queryByText('相机状态')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '采集管理' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3D 重建' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '主检测视图' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '折叠右侧栏' }));
    expect(screen.queryByRole('heading', { name: '缺陷图像' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开右侧栏' }));
    expect(screen.getByRole('heading', { name: '缺陷图像' })).toBeInTheDocument();
    expect(requestedUrls.some((url) => url.includes('/api/inspection/snapshot'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/api/inspection-world/records'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('/api/bkv/status'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/api/bkv/materials'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/api/capture/health'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/api/trigger/status'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('converter'))).toBe(false);
    expect(await screen.findByTestId('inspection-world-viewport')).toHaveAttribute('data-record-id', '1893700');
    await waitFor(() => {
      expect(requestedUrls.some((url) => url.includes('/api/inspection-world/meta') && url.includes('1893700'))).toBe(true);
      expect(requestedUrls.some((url) => url.includes('/api/inspection-world/defects') && url.includes('1893700'))).toBe(true);
    });
    const canvas = await screen.findByTestId('inspection-world-canvas');
    await waitFor(() => expect(canvas).toHaveAttribute('data-locatable-defects', '1'));
    expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(1000 / 600, 6);

    fireEvent.click(screen.getByTitle('列表'));
    const selectedDefectRow = container.querySelector('.defect-table tbody tr');
    expect(selectedDefectRow).not.toBeNull();
    fireEvent.click(selectedDefectRow!);
    await waitFor(() => expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(4, 6));

    fireEvent.wheel(canvas, { deltaY: 200, ctrlKey: true, clientX: 500, clientY: 300 });
    expect(Number(canvas.getAttribute('data-view-scale'))).toBeLessThan(4);
    fireEvent.click(selectedDefectRow!);
    await waitFor(() => expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(4, 6));

    fireEvent.click(screen.getByText('253B09401250925A12004329'));
    expect(await screen.findByLabelText('1893701 检测图像滚动视图')).toHaveAttribute('data-record-id', '1893701');
    expect(requestedUrls.some((url) => url.includes('/api/inspection-world/surface'))).toBe(false);

    const moreButton = screen.getByRole('button', { name: '更多功能' });
    fireEvent.click(moreButton);
    const replayItem = screen.getByRole('menuitem', { name: '离线回放' });
    expect(replayItem).toBeEnabled();
    expect(replayItem).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByText('北满特钢小棒检测系统').length).toBeGreaterThan(0);

    expect(screen.queryByRole('menuitem', { name: '在线检测' })).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('view')).not.toBe('online');
  });

  it('forces a refreshed D3IMG surface fetch when switching from 2D to 3D', async () => {
    window.history.replaceState(null, '', '/?app=terminal');
    const requestedUrls: string[] = [];
    const surfaceMesh = {
      schema: 'steel.bkv-depth-surface.v1',
      coordinateUnit: 'legacy-unknown',
      cameraCount: 6,
      frameStems: [],
      rows: 2,
      colsPerCamera: 1,
      positions: [0, 0, 1, 0, 1, 0, 8, 0, 1, 8, 1, 0],
      uvs: [],
      colors: [],
      indices: [0, 1, 2, 1, 2, 3],
    };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/api/runtime-profile')) {
        return new Response(JSON.stringify(bkvRuntimeProfile), { status: 200 });
      }
      if (url.includes('/api/inspection-world/records')) {
        return new Response(JSON.stringify(bkvRecordsPayload), { status: 200 });
      }
      if (url.includes('/api/inspection-world/meta')) {
        return new Response(JSON.stringify({
          schema: 'steel.inspection-world.meta.v1',
          provider: 'bkv',
          recordId: '1893700',
          sourceFrameCount: 6,
          sourceRevision: 'revision-1893700',
          cache: { state: 'on-demand', tileSize: 512, maxLevel: 3 },
          world: { width: 600, height: 1024, tileSize: 512, maxLevel: 3, cameras: [] },
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
      if (url.includes('/api/inspection-world/surface')) {
        return new Response(JSON.stringify(surfaceMesh), { status: 200 });
      }
      return new Response(JSON.stringify(getMockInspectionSnapshot()), { status: 200 });
    }));

    render(<App />);
    await screen.findByTestId('inspection-world-viewport');

    // 2D 模式下不应请求三维表面
    const surfaceCallsAfter2d = requestedUrls.filter((url) => url.includes('/api/inspection-world/surface'));
    expect(surfaceCallsAfter2d).toHaveLength(0);

    // 切换到 3D 模式，应触发带刷新的表面加载
    const viewToggle = screen.getByRole('group', { name: '显示视图切换' });
    fireEvent.click(within(viewToggle).getByRole('button', { name: '3D' }));

    await waitFor(() => {
      const surfaceCalls = requestedUrls.filter((url) => url.includes('/api/inspection-world/surface'));
      expect(surfaceCalls.length).toBeGreaterThan(0);
    });
  });

  it('keeps the unified BKV shell when explicitly selected BKV data is unavailable', async () => {
    window.history.replaceState(null, '', '/?app=terminal&view=bkv');
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/api/runtime-profile')) {
        return new Response(JSON.stringify(bkvRuntimeProfile), { status: 200 });
      }
      if (url.includes('/api/inspection-world/records')) {
        return new Response(JSON.stringify({ message: 'standard store unavailable' }), { status: 503 });
      }
      return new Response(JSON.stringify(getMockInspectionSnapshot()), { status: 200 });
    }));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'BKV 数据读取失败' })).toBeInTheDocument();
    expect(screen.getAllByText('北满特钢小棒检测系统').length).toBeGreaterThan(0);
    expect(screen.getByText('BKV 模式')).toBeInTheDocument();
    expect(screen.queryByText('相机状态')).not.toBeInTheDocument();
    expect(screen.queryByText(/服务异常/)).not.toBeInTheDocument();
    expect(requestedUrls.some((url) => url.includes('/api/inspection/snapshot'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/api/bkv/materials'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '更多功能' }));
    expect(screen.getByRole('menuitem', { name: '离线回放' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows a mode-local failure when the standard BKV record store cannot be read', async () => {
    window.history.replaceState(null, '', '/?app=terminal&view=bkv');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/runtime-profile')) {
        return new Response(JSON.stringify(bkvRuntimeProfile), { status: 200 });
      }
      if (url.includes('/api/inspection-world/records')) {
        return new Response(JSON.stringify({ message: 'converted catalog locked' }), { status: 503 });
      }
      return new Response(null, { status: 503 });
    }));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'BKV 数据读取失败' })).toBeInTheDocument();
    expect(screen.getByText(/converted catalog locked/)).toBeInTheDocument();
    expect(screen.getByText('BKV 模式')).toBeInTheDocument();
    expect(screen.getByText('BKV 数据异常')).toBeInTheDocument();
    expect(screen.queryByText(/服务异常/)).not.toBeInTheDocument();
  });

  it('keeps BKV store health ready when only the selected record world is missing', async () => {
    window.history.replaceState(null, '', '/?app=terminal&view=bkv');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/runtime-profile')) {
        return new Response(JSON.stringify(bkvRuntimeProfile), { status: 200 });
      }
      if (url.includes('/api/inspection-world/records')) {
        return new Response(JSON.stringify(bkvRecordsPayload), { status: 200 });
      }
      if (url.includes('/api/inspection-world/meta')) {
        return new Response(JSON.stringify({ message: 'record world not found' }), { status: 404 });
      }
      if (url.includes('/api/inspection-world/defects')) {
        const recordId = new URL(url).searchParams.get('recordId') ?? '1893700';
        return new Response(JSON.stringify({
          schema: 'steel.inspection-world.defects.v1',
          provider: 'bkv',
          recordId,
          defects: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify(getMockInspectionSnapshot()), { status: 200 });
    }));

    render(<App />);

    expect(await screen.findByText('数据就绪')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('当前记录图像读取失败');
    expect(screen.getByRole('alert')).toHaveTextContent('record world not found');
    expect(screen.queryByText('BKV 数据异常')).not.toBeInTheDocument();
    expect(screen.queryByText(/服务异常/)).not.toBeInTheDocument();
  });
});

describe('App online severity filters', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/?app=terminal');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/runtime-profile')) {
          return {
            ok: true,
            json: async () => directRuntimeProfile,
          };
        }
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

  it('exposes one top-level online monitor and switches its complete result/camera modes', async () => {
    const { container } = render(<App />);

    expect(await screen.findByRole('button', { name: '在线监测' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '在线监测' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '实时监控' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: '在线监测模式' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '实时/回放' })).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelectorAll('.online-workspace')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '实时/回放' }));
    expect(await screen.findByRole('heading', { name: '相机监控' })).toBeInTheDocument();
    expect(container.querySelectorAll('.online-workspace')).toHaveLength(0);
    expect(screen.getByRole('tab', { name: '实时' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '回放' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '返回检测' }));
    expect(container.querySelectorAll('.online-workspace')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: '相机监控' })).not.toBeInTheDocument();
  });

  it('shows the complete scrollable defect list and toggles statistics severities', async () => {
    const { container } = render(<App />);

    const severeCard = await screen.findByRole('button', { name: '严重等级过滤，当前4项' });
    const reviewCard = screen.getByRole('button', { name: '待复核等级过滤，当前3项' });
    const minorCard = screen.getByRole('button', { name: '轻微等级过滤，当前5项' });
    expect(severeCard).toHaveAttribute('aria-pressed', 'true');
    expect(reviewCard).toHaveAttribute('aria-pressed', 'true');
    expect(minorCard).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTitle('列表'));
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

describe('App runtime capability routing', () => {
  it('redirects the capture deep link to the terminal when BKV disables capture management', async () => {
    window.history.replaceState(null, '', '/?app=capture');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/runtime-profile')) {
        return new Response(JSON.stringify(bkvRuntimeProfile), { status: 200 });
      }
      if (url.includes('/api/inspection-world/records')) {
        return new Response(JSON.stringify({
          ...bkvRecordsPayload,
          ready: false,
          batchId: '无离线批次',
          records: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify(getMockInspectionSnapshot()), { status: 200 });
    }));

    render(<App />);

    expect(await screen.findByText('当前运行模式不支持采集管理，已返回检测终端')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('app')).toBe('terminal');
    expect(screen.queryByRole('heading', { name: '采集管理' })).not.toBeInTheDocument();
  });

  it('keeps the read-only NPZ reconstruction deep link available in BKV mode', async () => {
    window.history.replaceState(null, '', '/?app=bar-surface');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/runtime-profile')) {
        return new Response(JSON.stringify(bkvRuntimeProfile), { status: 200 });
      }
      if (url.includes('/api/inspection-world/records')) {
        return new Response(JSON.stringify({
          ...bkvRecordsPayload,
          ready: false,
          batchId: '无离线批次',
          records: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify(getMockInspectionSnapshot()), { status: 200 });
    }));

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'NPZ 3D 重建工作台' })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('app')).toBe('bar-surface');
  });

  it('normalizes an online deep link back to the configured BKV terminal', async () => {
    window.history.replaceState(null, '', '/?app=terminal&view=online');
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/api/runtime-profile')) {
        return new Response(JSON.stringify(bkvRuntimeProfile), { status: 200 });
      }
      if (url.includes('/api/inspection-world/records')) {
        return new Response(JSON.stringify({
          ...bkvRecordsPayload,
          ready: false,
          batchId: '无离线批次',
          records: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify(getMockInspectionSnapshot()), { status: 200 });
    }));

    render(<App />);

    expect(await screen.findByText('BKV 模式')).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('view')).toBe('bkv');
    expect(requestedUrls.some((url) => url.includes('/api/inspection/snapshot'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/api/bkv/status'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/api/bkv/status'))).toBe(false);
  });

  it('keeps direct-only deep links available for an eight-camera direct profile', async () => {
    window.history.replaceState(null, '', '/?app=capture');
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/api/runtime-profile')) {
        return new Response(JSON.stringify(directRuntimeProfile), { status: 200 });
      }
      return new Response(JSON.stringify(getMockInspectionSnapshot()), { status: 200 });
    }));

    render(<App />);

    expect((await screen.findAllByText('采集管理')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/当前运行模式不支持/)).not.toBeInTheDocument();
    expect(requestedUrls.some((url) => url.includes('/api/bkv/status'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/api/bkv/materials'))).toBe(false);
    expect(requestedUrls.some((url) => url.includes('/api/inspection-world/records'))).toBe(false);
  });
});
