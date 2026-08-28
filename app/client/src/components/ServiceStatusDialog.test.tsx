import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ServiceStatusDialog } from './ServiceStatusDialog';

const supervisorApi = vi.hoisted(() => {
  const snapshot = {
    schema: 'steel.tauri-background-monitor.v1',
    state: 'healthy',
    origin: 'http://127.0.0.1:4873',
    serviceAvailable: true,
    serviceReady: true,
    workerRunning: true,
    queueDepth: 0,
    activeTasks: 0,
    failedTasks: 0,
    blockedTasks: 0,
    activeTaskId: null,
    detail: '正常',
    updatedAtUnixMs: 1_800_000_000_000,
    tasks: [],
    serviceCount: 1,
    healthyServiceCount: 1,
    services: [{
      id: 'capture',
      name: '采集服务',
      role: 'camera-capture-provider',
      kind: 'capture',
      origin: 'http://127.0.0.1:4317',
      port: 4317,
      healthPath: '/health',
      ok: true,
      required: true,
      status: 'running',
      responseStatus: 200,
      latencyMs: 2,
      lifecycle: { pid: 4321, source: 'tauri-service-supervisor', phase: 'running' },
      operations: [
        { id: 'start', enabled: false },
        { id: 'stop', enabled: true },
        { id: 'restart', enabled: true },
      ],
      control: { mode: 'control', owner: 'tauri-service-supervisor' },
      startupMode: 'normal',
      autoRestart: true,
      managed: true,
    }],
    lifecycleLogs: [{
      id: 1,
      timestamp: '1800000000000',
      serviceId: 'capture',
      serviceName: '采集服务',
      action: 'start',
      outcome: 'success',
      source: 'startup',
      message: '采集服务启动命令已执行',
      pid: 4321,
    }],
  };
  return {
    snapshot,
    read: vi.fn().mockResolvedValue(snapshot),
    control: vi.fn().mockResolvedValue({ success: true, serviceId: 'capture', action: 'restart', message: '采集服务已重启' }),
    setMode: vi.fn().mockResolvedValue({ success: true, serviceId: 'capture', action: 'startup-mode', message: '启动模式已设置为 manual' }),
  };
});

vi.mock('../lib/background-monitor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/background-monitor')>();
  return {
    ...actual,
    readServiceSupervisorSnapshot: supervisorApi.read,
    controlServiceSupervisor: supervisorApi.control,
    setServiceSupervisorStartupMode: supervisorApi.setMode,
  };
});

describe('ServiceStatusDialog', () => {
  it('reads real supervisor state and exposes restart and startup mode controls', async () => {
    const onClose = vi.fn();
    render(<ServiceStatusDialog onClose={onClose} />);

    expect(await screen.findByRole('dialog', { name: '服务状态与生命周期' })).toBeInTheDocument();
    expect(screen.getByText('真实健康探针 1/1 · 每秒刷新')).toBeInTheDocument();
    expect(screen.getByText('采集服务启动命令已执行')).toBeInTheDocument();
    expect(screen.getByText('PID 4321')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重启' }));
    await waitFor(() => expect(supervisorApi.control).toHaveBeenCalledWith('capture', 'restart'));
    fireEvent.change(screen.getByRole('combobox', { name: '主界面启动模式' }), { target: { value: 'manual' } });
    await waitFor(() => expect(supervisorApi.setMode).toHaveBeenCalledWith('capture', 'manual'));

    fireEvent.click(screen.getByRole('button', { name: '关闭服务状态' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
