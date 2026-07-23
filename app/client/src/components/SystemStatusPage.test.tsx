import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceStatus } from '../data/inspection';
import { createEmptyCaptureSnapshot, type CaptureSnapshot } from '../lib/capture-api';
import { createInitialOperationState, type OperationState } from '../state/operations';
import {
  CaptureManagementApp,
  SystemStatusPage,
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
    connectedCameras: 8,
    captureSuccessCount: 0,
    productionCaptureRunning: true,
  },
};

const triggerStatus = {
  code: 0,
  service: 'steel-trigger-gateway',
  mode: 'manual',
  modeLabel: '手动',
  manualAllowed: true,
  allowedModes: ['api', 'tcp', 'udp', 'gray', 'secondary', 'manual'],
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

it('does not expose capture management or reconstruction in a non-direct runtime', () => {
  render(
    <SystemStatusPage
      status={deviceStatus}
      operation={createInitialOperationState()}
      capture={createEmptyCaptureSnapshot(null)}
      capabilities={{
        directCamera: false,
        captureManagement: false,
        reconstruction: false,
        offlineReplay: true,
      }}
      cameraCount={6}
      onAction={vi.fn()}
    />,
  );

  expect(screen.getByRole('heading', { name: '离线运行状态' })).toBeInTheDocument();
  expect(screen.getByText('6 路配置相机')).toBeInTheDocument();
  expect(screen.queryByText('采集管理')).not.toBeInTheDocument();
  expect(screen.queryByText('3D 重建')).not.toBeInTheDocument();
});

describe('CaptureManagementApp production trigger flow', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let siteCaptureCount: number;

  beforeEach(() => {
    window.localStorage.clear();
    siteCaptureCount = 0;
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:4873/api/production/status') {
        return jsonResponse({
          ...productionStatus,
          capture: {
            ...productionStatus.capture,
            captureSuccessCount: siteCaptureCount,
          },
        });
      }
      if (url === 'http://127.0.0.1:4873/api/trigger/status') {
        return jsonResponse(triggerStatus);
      }
      if (url === 'http://127.0.0.1:4873/api/trigger/mode' && init?.method === 'POST') {
        const mode = JSON.parse(String(init.body)).mode;
        return jsonResponse({
          ...triggerStatus,
          mode,
          manualAllowed: mode === 'manual',
        });
      }
      if (url === 'http://127.0.0.1:4873/api/steel/capture-mode' && init?.method === 'POST') {
        const captureMode = JSON.parse(String(init.body)).captureMode;
        return jsonResponse({
          code: 0,
          captureMode,
          automaticCaptureEnabled: captureMode === 'continuous',
          productionCaptureRunning: captureMode === 'continuous',
        });
      }
      if (url === 'http://127.0.0.1:4873/api/capture/continuous-settings' && init?.method === 'POST') {
        const input = JSON.parse(String(init.body));
        return jsonResponse({
          code: 0,
          applyToDevice: input.applyToDevice,
          dryRun: !input.applyToDevice,
          restartContinuous: input.restartContinuous,
          timeTriggerFreq: input.timeTriggerFreq,
          lineTriggerFrequency: input.timeTriggerFreq,
          applied: input.ips?.length ?? 0,
          failed: 0,
          results: (input.ips ?? []).map((ip: string) => ({ code: 0, ip, applied: input.applyToDevice })),
        });
      }
      if (url === 'http://127.0.0.1:4873/api/capture/continuous-settings') {
        return jsonResponse({
          code: 0,
          settings: {
            supported: true,
            connectedCameras: 8,
            configuredCameras: 8,
            timeTriggerFreq: 300,
            lineTriggerFrequency: 300,
            requiresApplyToDevice: true,
          },
        });
      }
      if (url.startsWith('http://127.0.0.1:4873/api/production/tasks/detail?id=')) {
        return jsonResponse({
          code: 0,
          task: {
            taskId: new URL(url).searchParams.get('id'),
            kind: 'site-simulation-step',
            materialId: 'COIL-TEST-001',
            sessionId: 'COIL-TEST-001-session',
            status: 'succeeded',
            phase: 'complete',
            progress: 100,
            result: {
              code: 0,
              materialId: 'COIL-TEST-001',
              sessionId: 'COIL-TEST-001-session',
            },
          },
        });
      }
      if (url === 'http://127.0.0.1:4873/api/production/tasks' && init?.method === 'POST') {
        return jsonResponse({
          code: 0,
          task: {
            taskId: 'TASK-CAPTURE',
            kind: 'capture-once',
            materialId: 'COIL-TEST-001',
            sessionId: 'COIL-TEST-001-session',
            status: 'queued',
            phase: 'queued',
            progress: 0,
          },
        });
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
        if (url.endsWith('/steel-in')) {
          siteCaptureCount = 16;
        }
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

  it('provides global trigger settings and gates manual steel controls by mode', async () => {
    renderCaptureManagement(fetchMock);

    fireEvent.click(screen.getAllByRole('button').find((button) => button.textContent?.includes('触发设置'))!);
    expect(await screen.findByTestId('trigger-settings')).toBeInTheDocument();
    expect(screen.getByTestId('capture-output-mode')).toBeInTheDocument();
    expect(screen.getByTestId('steel-flow-mode')).toBeInTheDocument();
    expect(screen.getByLabelText('模拟进出钢秒数')).toHaveValue(30);
    expect(screen.getByLabelText('进钢二级数据')).toHaveValue('{\n  "heatNo": "",\n  "grade": "Q355B"\n}');
    expect(screen.getByLabelText('进钢写入二级数据')).toBeChecked();
    expect(screen.getByLabelText('标记为测试生成')).not.toBeChecked();

    fireEvent.change(screen.getByTestId('steel-flow-mode'), { target: { value: 'manual' } });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) =>
        String(url) === 'http://127.0.0.1:4873/api/trigger/mode'
        && init?.method === 'POST'
        && JSON.parse(String(init.body)).mode === 'manual',
      )).toBe(true);
    });

    fireEvent.change(screen.getByTestId('capture-output-mode'), { target: { value: 'on-demand' } });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) =>
        String(url) === 'http://127.0.0.1:4873/api/steel/capture-mode'
        && init?.method === 'POST'
        && JSON.parse(String(init.body)).captureMode === 'on-demand',
      )).toBe(true);
    });

    const steelIn = screen.getByTestId('manual-steel-in');
    expect(steelIn).toBeEnabled();
    fireEvent.click(steelIn!);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url) === 'http://127.0.0.1:4873/api/trigger/manual/steel-in' && init?.method === 'POST',
    )).toBe(true));
    const steelInRequest = fetchMock.mock.calls.find(([url]) =>
      String(url) === 'http://127.0.0.1:4873/api/trigger/manual/steel-in',
    );
    expect(JSON.parse(String(steelInRequest?.[1]?.body))).toMatchObject({
      captureMode: 'on-demand',
      autoCapture: false,
    });
  });

  it('shows completed depth-map FPS and applies a runtime-only continuous line trigger rate from capture control', async () => {
    const capture = createEmptyCaptureSnapshot(null);
    capture.statuses = capture.statuses.map((camera, index) => ({
      ...camera,
      connected: true,
      acquisitionState: 'connected',
      sdkStatus: 'ready',
      error: null,
      continuousAcquiring: true,
      continuousFps: 4.5 + index / 10,
      continuousFrameCount: 32 + index,
      lastContinuousFrameAt: '1783489000000',
      captureConfig: {
        available: true,
        controlMode: 0,
        controlLabel: 'continuous',
        timeTriggerFreq: 300,
      },
    }));
    renderCaptureManagement(fetchMock, capture);

    const settings = await screen.findByTestId('continuous-capture-settings');
    expect(screen.getAllByText('连续 FPS')).toHaveLength(8);
    expect(screen.getByText('4.5')).toBeInTheDocument();
    const frequency = within(settings).getByLabelText('连续采集线触发频率');
    await waitFor(() => expect(frequency).toHaveValue(300));

    fireEvent.change(frequency, { target: { value: '360.5' } });
    fireEvent.click(within(settings).getByTestId('apply-continuous-settings'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) =>
        String(url) === 'http://127.0.0.1:4873/api/capture/continuous-settings'
        && init?.method === 'POST',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        timeTriggerFreq: 360.5,
        ips: capture.statuses.map((camera) => camera.ip),
        applyToDevice: true,
        restartContinuous: true,
      });
    });
    expect(await within(settings).findByText(/已运行时下发：线触发 360.5 Hz，8\/8 台相机/)).toBeInTheDocument();
  });

  it('shows preview FPS and preview frame count while a camera realtime stream owns acquisition telemetry', () => {
    const capture = createEmptyCaptureSnapshot(null);
    capture.statuses[3] = {
      ...capture.statuses[3],
      connected: true,
      continuousFps: 0,
      continuousFrameCount: 12,
      streamRunning: true,
      streamFps: 4.8,
      streamFrames: 1826,
    };
    renderCaptureManagement(fetchMock, capture);

    const camera = screen.getByRole('button', { name: /4 号采集相机/ });
    expect(within(camera).getByText('预览 FPS')).toBeInTheDocument();
    expect(within(camera).getByText('4.8')).toBeInTheDocument();
    expect(within(camera).getByText('预览帧数')).toBeInTheDocument();
    expect(within(camera).getByText('1826')).toBeInTheDocument();
  });

  it('runs the complete simulated site flow with the current eight-camera source', async () => {
    const capture = createEmptyCaptureSnapshot(null);
    capture.statuses = capture.statuses.map((camera) => ({
      ...camera,
      connected: true,
      acquisitionState: 'connected',
      sdkStatus: 'ready',
      error: null,
    }));
    renderCaptureManagement(fetchMock, capture);

    const runButton = await screen.findByRole('button', { name: '一键模拟现场运行' });
    await waitFor(() => expect(runButton).toBeEnabled());
    fireEvent.change(screen.getByLabelText('模拟采集轮数'), { target: { value: '2' } });
    fireEvent.click(runButton);

    await waitFor(() => expect(screen.getByText(/现场模拟完成：COIL-TEST-001/)).toBeInTheDocument(), { timeout: 8_000 });

    const commandUrls = fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([url]) => String(url));
    expect(commandUrls).toEqual(expect.arrayContaining([
      'http://127.0.0.1:4873/api/trigger/manual/steel-info',
      'http://127.0.0.1:4873/api/trigger/manual/steel-in',
      'http://127.0.0.1:4873/api/trigger/manual/steel-out',
    ]));
    const steelInCall = fetchMock.mock.calls.find(([url]) => String(url) === 'http://127.0.0.1:4873/api/trigger/manual/steel-in');
    expect(JSON.parse(String(steelInCall?.[1]?.body))).toMatchObject({
      autoCapture: true,
    });
    expect(commandUrls).not.toContain('http://127.0.0.1:4873/api/production/tasks');
  }, 10_000);

  it('exposes a return link from capture management to the main interface', async () => {
    vi.stubGlobal('fetch', fetchMock);
    render(
      <CaptureManagementApp
        status={deviceStatus}
        operation={createInitialOperationState()}
        capture={createEmptyCaptureSnapshot(null)}
        onAction={vi.fn()}
        className="standalone-capture-manager"
      />,
    );
    expect(await screen.findByRole('link', { name: '返回主界面' })).toHaveAttribute('href', '/?app=terminal');
  });

  it('keeps the return link out of the embedded capture manager', async () => {
    renderCaptureManagement(fetchMock);
    expect(screen.queryByRole('link', { name: '返回主界面' })).not.toBeInTheDocument();
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
        String(url).includes('/api/capture/latest?ip=192.168.101.100&kind=depth&meta=1'),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '亮度图' }));

    expect(await screen.findByRole('img', { name: '1 号采集相机 intensity map' })).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/api/capture/latest?ip=192.168.101.100&kind=intensity&meta=1'),
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '元数据' }));
    expect(await screen.findByLabelText('最新采集元数据')).toHaveTextContent('code');
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/api/capture/latest?ip=192.168.101.100&kind=metadata&meta=1')),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'SDK 派生图' }));
    expect(await screen.findByRole('img', { name: '1 号采集相机 SDK 派生图' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/api/capture/latest?ip=192.168.101.100&kind=sdk-derived&meta=1')),
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
    const view = renderCaptureManagement(fetchMock, capture);

    fireEvent.click(screen.getByRole('button', { name: /1 号采集相机/ }));
    fireEvent.click(screen.getByRole('tab', { name: '采集控制' }));
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
      ip: '192.168.101.100',
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
    expect(view.container.querySelector('.capture-message')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '实时流' })).toHaveAttribute('aria-pressed', 'true');
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
    fireEvent.click(screen.getByRole('tab', { name: '采集控制' }));
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
    fireEvent.click(screen.getByRole('tab', { name: '采集控制' }));
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
    expect(screen.getByRole('tablist', { name: '单相机参数分类' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '实时状态' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('最新图像预览')).toBeInTheDocument();
    expect(screen.getByText('相机日志')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'SDK 参数' }));

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
