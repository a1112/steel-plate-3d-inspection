import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundMonitorApp, backgroundTaskProgressPercent } from './BackgroundMonitorApp';

const monitorApi = vi.hoisted(() => {
  const baseSnapshot = {
    schema: 'steel.tauri-background-monitor.v1',
    state: 'busy',
    origin: 'http://127.0.0.1:4873',
    serviceAvailable: true,
    serviceReady: true,
    workerRunning: true,
    queueDepth: 2,
    activeTasks: 1,
    failedTasks: 1,
    blockedTasks: 1,
    activeTaskId: 'TASK-ACTIVE',
    detail: '正在执行 1 项任务，队列等待 2 项',
    updatedAtUnixMs: 1_800_000_000_000,
    services: [
      {
        id: 'inspection',
        name: '检测服务',
        role: 'api',
        kind: 'inspection',
        origin: 'http://127.0.0.1:4873',
        port: 4873,
        healthPath: '/api/health/live',
        ok: true,
        required: true,
        status: 'running',
        responseStatus: 200,
        latencyMs: 2,
        uptimeMs: 1000,
        reason: null,
        lifecycle: { source: 'service', phase: 'ready', desiredRunning: true, pid: 1234 },
        operations: [
          { id: 'refresh-status', label: '刷新状态', effect: 'query', scope: 'service', enabled: true },
          { id: 'copy-origin', label: '复制地址', effect: 'local', scope: 'service', enabled: true },
          { id: 'view-logs', label: '查看日志', effect: 'local', scope: 'service', enabled: true },
        ],
        control: { mode: 'observe', owner: 'service' },
      },
      {
        id: 'capture',
        name: '采集服务',
        role: 'camera-capture-provider',
        kind: 'capture',
        origin: 'http://127.0.0.1:4317',
        port: 4317,
        healthPath: '/health',
        ok: false,
        required: true,
        status: 'stopped',
        responseStatus: 0,
        latencyMs: 0,
        reason: 'capture_process_not_running',
        lifecycle: { source: 'capture-supervisor', phase: 'stopped', desiredRunning: true },
        operations: [
          { id: 'refresh-status', label: '刷新状态', effect: 'query', scope: 'service', enabled: true },
          { id: 'copy-origin', label: '复制地址', effect: 'local', scope: 'service', enabled: true },
          { id: 'view-logs', label: '查看日志', effect: 'local', scope: 'service', enabled: true },
        ],
        control: { mode: 'observe', owner: 'capture-supervisor' },
      },
    ],
    logs: [
      {
        name: 'inspection-service.out',
        serviceId: 'inspection',
        serviceName: '检测服务',
        bytes: 2048,
        modifiedAt: '1800000002000',
        tail: 'service started\nworker heartbeat ok',
        truncated: false,
      },
      {
        name: 'capture-child.log',
        serviceId: 'capture',
        serviceName: '采集服务',
        bytes: 512,
        modifiedAt: '1800000003000',
        tail: 'capture process stopped',
        truncated: false,
      },
    ],
    runtime: {
      stateRoot: 'C:/runtime/state',
      logRoot: 'C:/runtime/logs',
      taskWorker: { status: 'running', running: true, heartbeatAgeMs: 80 },
      supervisor: { status: 'running', reason: '' },
    },
    registry: {
      schema: 'steel.service-registry.v1',
      version: 1,
      path: 'C:/runtime/config/service-registry.json',
      services: [],
    },
    monitorProtocol: {
      schema: 'steel.runtime-monitor-capabilities.v1',
      version: 1,
      selectionKey: 'serviceId',
      logScopes: ['service', 'all'],
      operationEffects: ['query', 'local', 'mutation'],
      mutationPolicy: 'capability-only',
      readAccess: 'loopback-or-private-network',
    },
    serviceCount: 2,
    healthyServiceCount: 1,
    tasks: [
      {
        taskId: 'TASK-ACTIVE',
        kind: 'capture-once',
        materialId: 'PIPE-001',
        status: 'running',
        phase: 'capture',
        progress: 0.5,
        updatedAt: '1800000000000',
        error: '',
      },
      {
        taskId: 'TASK-FAILED',
        kind: 'algorithm-run',
        materialId: 'PIPE-002',
        status: 'failed',
        phase: 'algorithm',
        progress: 1,
        updatedAt: '1800000001000',
        error: '算法进程退出码 1',
      },
      {
        taskId: 'TASK-BLOCKED',
        kind: 'steel-out',
        materialId: 'PIPE-003',
        status: 'blocked',
        phase: '等待依赖',
        progress: 0,
        updatedAt: '1800000002000',
        error: '',
      },
    ],
  };
  const refreshedSnapshot = {
    ...baseSnapshot,
    state: 'healthy',
    queueDepth: 0,
    activeTasks: 0,
    failedTasks: 0,
    blockedTasks: 0,
    activeTaskId: null,
    detail: '后台服务与生产任务队列运行正常',
    tasks: [],
  };
  let eventHandler: ((snapshot: typeof baseSnapshot) => void) | undefined;
  const unlisten = vi.fn();
  return {
    baseSnapshot,
    refreshedSnapshot,
    hasNative: vi.fn(() => true),
    configure: vi.fn().mockResolvedValue(baseSnapshot),
    read: vi.fn().mockResolvedValue(baseSnapshot),
    refresh: vi.fn().mockResolvedValue(refreshedSnapshot),
    listen: vi.fn(async (handler: (snapshot: typeof baseSnapshot) => void) => {
      eventHandler = handler;
      return unlisten;
    }),
    emit(snapshot: typeof baseSnapshot) {
      eventHandler?.(snapshot);
    },
    unlisten,
  };
});

const windowApi = vi.hoisted(() => ({
  isAvailable: true,
  hide: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  isFullscreen: vi.fn().mockResolvedValue(false),
  minimize: vi.fn().mockResolvedValue(undefined),
  setTitle: vi.fn().mockResolvedValue(undefined),
  setFullscreen: vi.fn().mockResolvedValue(undefined),
  startDragging: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  onResized: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock('../lib/background-monitor', () => ({
  configureBackgroundMonitor: monitorApi.configure,
  hasNativeBackgroundMonitor: monitorApi.hasNative,
  listenBackgroundMonitor: monitorApi.listen,
  readBackgroundMonitor: monitorApi.read,
  refreshBackgroundMonitor: monitorApi.refresh,
}));

vi.mock('../lib/tauri-window', () => ({
  getTauriWindowApi: () => windowApi,
}));

describe('BackgroundMonitorApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    monitorApi.configure.mockResolvedValue(monitorApi.baseSnapshot);
    monitorApi.read.mockResolvedValue(monitorApi.baseSnapshot);
    monitorApi.refresh.mockResolvedValue(monitorApi.refreshedSnapshot);
  });

  afterEach(() => {
    cleanup();
  });

  it('renders concise title stats, selectable services, details and scoped logs', async () => {
    render(<BackgroundMonitorApp origin="http://127.0.0.1:4873" />);

    expect(await screen.findByText('后台任务监控')).toBeInTheDocument();
    await waitFor(() => expect(monitorApi.read).toHaveBeenCalled());
    expect(monitorApi.configure).not.toHaveBeenCalled();

    expect(screen.getByText(/^服务/, { selector: '.background-monitor-title-stat' })).toHaveTextContent('1/2');
    expect(screen.getByText(/^关注/, { selector: '.background-monitor-title-stat' })).toHaveTextContent('2');
    expect(screen.getByTestId('background-monitor-service-inspection')).toHaveTextContent('检测服务');
    expect(screen.getByTestId('background-monitor-service-capture')).toHaveTextContent('采集服务');
    expect(screen.getByTestId('background-monitor-service-detail')).toHaveTextContent('inspection');
    expect(screen.getByTestId('background-monitor-runtime')).toHaveTextContent('只读观察');
    expect(screen.getByTestId('background-monitor-logs')).toHaveTextContent('worker heartbeat ok');
    expect(screen.queryByText('capture process stopped')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('background-monitor-service-capture'));
    expect(screen.getByTestId('background-monitor-service-detail')).toHaveTextContent('capture');
    expect(screen.getByTestId('background-monitor-service-detail')).toHaveTextContent('capture_process_not_running');
    expect(screen.getByTestId('background-monitor-logs')).toHaveTextContent('capture process stopped');

    fireEvent.click(screen.getByRole('button', { name: '全部日志' }));
    expect(screen.getByTestId('background-monitor-logs')).toHaveTextContent('worker heartbeat ok');
    expect(screen.getByTestId('background-monitor-logs')).toHaveTextContent('capture process stopped');
    expect(screen.queryByText('当前活动任务')).not.toBeInTheDocument();
    expect(screen.queryByText('任务列表')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('后台监控摘要')).not.toBeInTheDocument();
  });

  it('refreshes from the native monitor, reacts to events, and hides to tray', async () => {
    const { unmount } = render(<BackgroundMonitorApp origin="http://127.0.0.1:4873" />);
    await waitFor(() => expect(monitorApi.listen).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '刷新后台任务监控' }));
    await waitFor(() => expect(monitorApi.refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/^关注/, { selector: '.background-monitor-title-stat' })).toHaveTextContent('0'));

    await act(async () => {
      monitorApi.emit(monitorApi.baseSnapshot);
    });
    await waitFor(() => expect(screen.getByText(/^关注/, { selector: '.background-monitor-title-stat' })).toHaveTextContent('2'));

    fireEvent.click(screen.getByRole('button', { name: '隐藏到托盘' }));
    expect(windowApi.hide).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/独立服务器进程 · 能力协议 1 · 只读监控/)).toBeInTheDocument();

    unmount();
    expect(monitorApi.unlisten).toHaveBeenCalledTimes(1);
  });

  it('normalizes fractional and percentage progress values for the worker payload', () => {
    expect(backgroundTaskProgressPercent(0.5)).toBe(50);
    expect(backgroundTaskProgressPercent(75)).toBe(75);
    expect(backgroundTaskProgressPercent(-1)).toBe(0);
    expect(backgroundTaskProgressPercent(120)).toBe(100);
  });
});
