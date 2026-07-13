import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceStatus } from '../data/inspection';
import { createEmptyCaptureSnapshot, type CaptureSnapshot } from '../lib/capture-api';
import { createInitialOperationState, type OperationState } from '../state/operations';
import {
  CaptureManagementApp,
  mergeCaptureLogEvents,
  prependBoundedCaptureLog,
} from './SystemStatusPage';

const deviceStatus: DeviceStatus = {
  receiverPorts: Array.from({ length: 8 }, (_, index) => ({ index: index + 1, ok: true })),
  cameraPorts: Array.from({ length: 8 }, (_, index) => ({ index: index + 1, ok: index < 6 })),
  encoder: 'sync',
  plc: 'normal',
  l2: 'normal',
  alarmCount: 0,
};

const productionStatus = {
  code: 0,
  activeSession: {
    id: 'COIL-TEST-001-session',
    materialId: 'COIL-TEST-001',
    status: 'info-ready',
    triggerMode: 'manual',
    controlMode: 'manual',
    updatedAt: '1783489000000',
  },
  latestSession: null,
  latestInspection: null,
  tasks: {
    queueDepth: 1,
    capacity: 128,
    worker: { running: true, activeTaskId: 'TASK-ACTIVE' },
  },
  capture: {
    code: 0,
    phase: 'idle',
    captureSaveState: 'discard',
    saveEnabled: false,
    connectedCameras: 6,
  },
};

const triggerStatus = {
  code: 0,
  service: 'steel-trigger-gateway',
  mode: 'manual',
  modeLabel: '手动',
  manualAllowed: true,
  allowedModes: ['api', 'gray', 'secondary', 'manual'],
  inspectionServiceOrigin: 'http://127.0.0.1:4873',
  production: productionStatus,
};

function jsonResponse(payload: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function renderCaptureManagement(
  fetchMock: ReturnType<typeof vi.fn>,
  capture: CaptureSnapshot = createEmptyCaptureSnapshot(null),
  operation: OperationState = createInitialOperationState(),
) {
  vi.stubGlobal('fetch', fetchMock);
  return render(
    <CaptureManagementApp
      status={deviceStatus}
      operation={operation}
      capture={capture}
      onAction={vi.fn()}
    />,
  );
}

describe('CaptureManagementApp production trigger flow', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:4873/api/production/status') {
        return jsonResponse(productionStatus);
      }
      if (url === 'http://127.0.0.1:4873/api/trigger/status') {
        return jsonResponse(triggerStatus);
      }
      if (url.startsWith('http://127.0.0.1:4873/api/capture/latest?')) {
        const requestUrl = new URL(url);
        const kind = requestUrl.searchParams.get('kind') || 'depth';
        return jsonResponse({
          code: 0,
          ip: requestUrl.searchParams.get('ip'),
          kind,
          path: `H:/camera1/BAR-TEST/${kind}/000001.png`,
          url: `/api/capture/file?path=H%3A%2Fcamera1%2FBAR-TEST%2F${kind}%2F000001.png`,
        });
      }
      if (url.startsWith('http://127.0.0.1:4873/api/trigger/manual/')) {
        const target = url.endsWith('/steel-info')
          ? '/api/production/tasks/steel-info'
          : url.endsWith('/steel-in')
            ? '/api/production/tasks/steel-in'
            : '/api/production/tasks/steel-out';
        return jsonResponse({
          code: 0,
          gateway: 'steel-trigger-gateway',
          mode: 'manual',
          target,
          service: {
            code: 0,
            task: {
              taskId: 'TASK-QUEUED',
              kind: url.endsWith('/steel-in') ? 'steel-in' : 'steel-event',
              materialId: 'COIL-TEST-001',
              sessionId: 'COIL-TEST-001-session',
              status: 'queued',
            },
          },
        });
      }
      return jsonResponse({ code: 0 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes manual steel info, steel-in and steel-out commands through the Rust proxy', async () => {
    renderCaptureManagement(fetchMock);

    await waitFor(() => expect(screen.getByRole('button', { name: '写检测记录' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: '写检测记录' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => String(url) === 'http://127.0.0.1:4873/api/trigger/manual/steel-info' && init?.method === 'POST')).toBe(true);
    });

    await waitFor(() => expect(screen.getByRole('button', { name: '进钢开始保存' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '进钢开始保存' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => String(url) === 'http://127.0.0.1:4873/api/trigger/manual/steel-in' && init?.method === 'POST')).toBe(true);
    });

    await waitFor(() => expect(screen.getByRole('button', { name: '出钢结束' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '出钢结束' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => String(url) === 'http://127.0.0.1:4873/api/trigger/manual/steel-out' && init?.method === 'POST')).toBe(true);
    });

    const productionDirectCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes('/api/production/steel-') && init?.method === 'POST',
    );
    expect(productionDirectCalls).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('127.0.0.1:4881'))).toBe(false);
    expect(screen.getByText('由 Tauri 经 Rust /api/trigger/* 受控代理')).toBeInTheDocument();

    const steelInCall = fetchMock.mock.calls.find(([url]) => String(url) === 'http://127.0.0.1:4873/api/trigger/manual/steel-in');
    expect(steelInCall).toBeTruthy();
    expect(JSON.parse(String(steelInCall?.[1]?.body))).toMatchObject({
      materialId: 'COIL-TEST-001',
      steelId: 'COIL-TEST-001',
      steelNo: 'COIL-TEST-001',
      mode: 'manual',
      triggerMode: 'manual',
      present: true,
      value: 1,
      autoCapture: true,
      discardBlackFrames: true,
      requestId: expect.any(String),
    });
    expect(screen.getByText(/TASK-QUEUED/)).toBeInTheDocument();
    expect(screen.getByText(/1\/128 · TASK-ACTIVE/)).toBeInTheDocument();
  });

  it('loads depth, intensity, metadata and SDK-derived latest artifacts through Rust', async () => {
    renderCaptureManagement(fetchMock);

    fireEvent.click(screen.getByRole('button', { name: /1 号采集相机/ }));

    expect(await screen.findByRole('img', { name: '1 号采集相机 depth map' })).toHaveAttribute(
      'src',
      expect.stringContaining('http://127.0.0.1:4873/api/capture/file?path='),
    );
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/capture/latest?ip=192.168.105.13&kind=depth&meta=1'),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '亮度图' }));

    expect(await screen.findByRole('img', { name: '1 号采集相机 intensity map' })).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/capture/latest?ip=192.168.105.13&kind=intensity&meta=1'),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '元数据' }));
    expect(await screen.findByLabelText('最新采集元数据')).toHaveTextContent('code');
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/api/capture/latest?ip=192.168.105.13&kind=metadata&meta=1')),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'SDK 派生图' }));
    expect(await screen.findByRole('img', { name: '1 号采集相机 SDK 派生图' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/api/capture/latest?ip=192.168.105.13&kind=sdk-derived&meta=1')),
    ).toBe(true);
  });

  it('starts a connected camera realtime preview through Rust and reads frames from the Rust origin', async () => {
    const capture = createEmptyCaptureSnapshot(null);
    capture.statuses[0] = {
      ...capture.statuses[0],
      connected: true,
      acquisitionState: 'connected',
      sdkStatus: 'ready',
      error: null,
    };
    renderCaptureManagement(fetchMock, capture);

    fireEvent.click(screen.getByRole('button', { name: /1 号采集相机/ }));
    fireEvent.change(screen.getByLabelText('实时预览宽度'), { target: { value: '4096' } });
    fireEvent.change(screen.getByLabelText('实时预览数据模式'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('实时预览 FPS 限制'), { target: { value: '12' } });
    fireEvent.click(screen.getByLabelText('实时预览高速模式'));
    fireEvent.click(screen.getByRole('button', { name: '启动实时预览' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url) === 'http://127.0.0.1:4873/api/stream/start' && init?.method === 'POST',
        ),
      ).toBe(true);
    });
    const startCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === 'http://127.0.0.1:4873/api/stream/start' && init?.method === 'POST',
    );
    expect(JSON.parse(String(startCall?.[1]?.body))).toMatchObject({
      ip: '192.168.105.13',
      width: 4096,
      dataMode: 1,
      fpsLimit: 12,
      hs: true,
    });
    await waitFor(() => {
      expect(screen.getByRole('img', { name: '1 号采集相机 depth map' })).toHaveAttribute(
        'src',
        expect.stringContaining('http://127.0.0.1:4873/api/stream/latest?'),
      );
    });
  });

  it('blocks realtime preview when an operator parameter is out of range', async () => {
    const capture = createEmptyCaptureSnapshot(null);
    capture.statuses[0] = {
      ...capture.statuses[0],
      connected: true,
      acquisitionState: 'connected',
      sdkStatus: 'ready',
      error: null,
    };
    renderCaptureManagement(fetchMock, capture);

    await waitFor(() => expect(screen.getByRole('button', { name: '写检测记录' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /1 号采集相机/ }));
    await screen.findByRole('img', { name: '1 号采集相机 depth map' });
    fireEvent.change(screen.getByLabelText('实时预览宽度'), { target: { value: '32769' } });

    expect(screen.getByRole('alert')).toHaveTextContent('实时预览宽度必须是 0 到 32768 的整数');
    expect(screen.getByRole('button', { name: '启动实时预览' })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/stream/start'))).toBe(false);
  });

  it('keeps provider snapshots visible while accumulating bounded frontend and system operation logs', async () => {
    const capture = createEmptyCaptureSnapshot(null);
    capture.logs = [{
      id: 'PROVIDER-1',
      time: '2026-07-12T02:00:00Z',
      level: 'info',
      source: 'provider-snapshot',
      message: 'Provider snapshot ready',
    }];
    const operation = createInitialOperationState();
    operation.events = [{
      id: 'SYSTEM-1',
      time: '2026-07-12T02:00:01Z',
      level: 'warning',
      message: '系统自检待复核',
    }];
    renderCaptureManagement(fetchMock, capture, operation);

    fireEvent.click(screen.getByRole('button', { name: /1 号采集相机/ }));
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    await waitFor(() => expect(screen.getAllByText('相机已连接')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: '日志记录' }));

    expect(screen.getByText('Provider snapshot ready')).toBeInTheDocument();
    expect(screen.getByText('系统自检待复核')).toBeInTheDocument();
    expect(screen.getByText('相机已连接')).toBeInTheDocument();
    expect(screen.getByText('Provider 快照')).toBeInTheDocument();
    expect(screen.getByText('系统操作')).toBeInTheDocument();
    expect(screen.getByText('前端操作')).toBeInTheDocument();

    const bounded = prependBoundedCaptureLog(
      [{ id: 'old-1', time: '', level: 'info', message: 'old 1' }, { id: 'old-2', time: '', level: 'info', message: 'old 2' }],
      { id: 'new', time: '', level: 'info', message: 'new' },
      2,
    );
    expect(bounded.map((event) => event.id)).toEqual(['new', 'old-1']);
    expect(mergeCaptureLogEvents(capture.logs, operation.events, bounded).map((event) => event.message))
      .toEqual(expect.arrayContaining(['new', '系统自检待复核', 'Provider snapshot ready']));
  });

  it('reports every camera result when disconnect-all is only partially successful', async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:4873/api/production/status') {
        return jsonResponse(productionStatus);
      }
      if (url === 'http://127.0.0.1:4873/api/trigger/status') {
        return jsonResponse(triggerStatus);
      }
      if (url === 'http://127.0.0.1:4873/api/camera/disconnect') {
        return jsonResponse({
          code: 49003,
          requested: 2,
          disconnected: 1,
          failed: 1,
          results: [
            { code: 0, ip: '192.168.101.100', disconnected: true },
            {
              code: 49003,
              ip: '192.168.102.100',
              disconnected: false,
              errorName: 'DEV_DISCONNECT_ERROR',
              operatorHint: '检查相机链路',
            },
          ],
        });
      }
      return jsonResponse({ code: 0 });
    });
    renderCaptureManagement(fetchMock);

    fireEvent.click(screen.getByRole('button', { name: '全部断开' }));

    expect((await screen.findAllByText(/相机批量断开完成：1\/2，失败 1/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/192\.168\.102\.100: DEV_DISCONNECT_ERROR（检查相机链路）/).length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === 'http://127.0.0.1:4873/api/camera/disconnect')).toBe(true);
  });

  it('shows the complete SDK capture parameter readback in camera details', async () => {
    const capture = createEmptyCaptureSnapshot(null);
    capture.statuses[0] = {
      ...capture.statuses[0],
      connected: true,
      captureConfig: {
        available: true,
        controlMode: 0,
        ctrlType: 2,
        controlLabel: 'continuous',
        triggerInputType: 4,
        triggerSourceLabel: 'time',
        captureDataType: 3,
        triggerLines: 1000,
        divRatio: 4,
        timeTriggerFreq: 300,
        maxFrameRate: 523.75,
        exposureTime: 850,
        gainK: 1.25,
        laserEnable: 1,
        laserPower: 80,
        laserLineSelect: 2,
        arrayEnable: 1,
      },
    };
    renderCaptureManagement(fetchMock, capture);

    fireEvent.click(screen.getByRole('button', { name: /1 号采集相机/ }));

    const readback = await screen.findByRole('region', { name: 'SDK 参数读回' });
    expect(within(readback).getByText('continuous (0)')).toBeInTheDocument();
    expect(within(readback).getByText('time (4)')).toBeInTheDocument();
    expect(within(readback).getByText('1000 line')).toBeInTheDocument();
    expect(within(readback).getByText('300 Hz')).toBeInTheDocument();
    expect(within(readback).getByText('523.75 fps')).toBeInTheDocument();
    expect(within(readback).getByText('850 us')).toBeInTheDocument();
    expect(within(readback).getByText('1.25')).toBeInTheDocument();
    expect(within(readback).getAllByText('开启 (1)')).toHaveLength(2);
    expect(within(readback).getByText(/arrayEnable 是运行开关/)).toBeInTheDocument();
  });
});
