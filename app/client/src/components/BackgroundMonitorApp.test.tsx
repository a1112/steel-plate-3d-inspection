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

  it('renders health, worker, queue, attention and filters the read-only task table', async () => {
    render(<BackgroundMonitorApp origin="http://127.0.0.1:4873" />);

    expect(await screen.findByText('后台任务监控')).toBeInTheDocument();
    await waitFor(() => expect(monitorApi.read).toHaveBeenCalled());
    expect(monitorApi.configure).not.toHaveBeenCalled();

    expect(screen.getByLabelText('运行健康')).toHaveTextContent('任务运行中');
    expect(screen.getByLabelText('Worker')).toHaveTextContent('在线');
    expect(screen.getByLabelText('队列')).toHaveTextContent('2');
    expect(screen.getByLabelText('关注计数')).toHaveTextContent('2');
    expect(screen.getByTestId('background-monitor-active-task')).toHaveTextContent('TASK-ACTIVE');
    expect(screen.getByTestId('background-monitor-task-TASK-ACTIVE')).toBeInTheDocument();
    expect(screen.getByTestId('background-monitor-task-TASK-FAILED')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('任务状态过滤'), { target: { value: 'failed' } });
    expect(screen.queryByTestId('background-monitor-task-TASK-ACTIVE')).not.toBeInTheDocument();
    expect(screen.getByTestId('background-monitor-task-TASK-FAILED')).toBeInTheDocument();
    expect(screen.getByText('算法进程退出码 1')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('任务状态过滤'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('搜索后台任务'), { target: { value: 'PIPE-003' } });
    expect(screen.queryByTestId('background-monitor-task-TASK-FAILED')).not.toBeInTheDocument();
    expect(screen.getByTestId('background-monitor-task-TASK-BLOCKED')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /取消|重试/ })).not.toBeInTheDocument();
  });

  it('refreshes from the native monitor, reacts to events, and hides to tray', async () => {
    const { unmount } = render(<BackgroundMonitorApp origin="http://127.0.0.1:4873" />);
    await waitFor(() => expect(monitorApi.listen).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '刷新后台任务监控' }));
    await waitFor(() => expect(monitorApi.refresh).toHaveBeenCalled());
    expect(await screen.findByText('后台服务与生产任务队列运行正常')).toBeInTheDocument();
    expect(screen.getByLabelText('关注计数')).toHaveTextContent('0');

    await act(async () => {
      monitorApi.emit(monitorApi.baseSnapshot);
    });
    await waitFor(() => expect(screen.getByLabelText('关注计数')).toHaveTextContent('2'));

    fireEvent.click(screen.getByRole('button', { name: '隐藏到托盘' }));
    expect(windowApi.hide).toHaveBeenCalledTimes(1);
    expect(screen.getByText('独立服务器进程 · 只读监控')).toBeInTheDocument();

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
