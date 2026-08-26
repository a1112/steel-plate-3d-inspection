import { describe, expect, it } from 'vitest';
import { deriveBackgroundMonitorSnapshot } from './background-monitor';
import type {
  ProductionStatus,
  ProductionTaskPage,
  ServiceHealthDetails,
} from '../services/inspection-api';

const health = (ok = true, running = true): ServiceHealthDetails => ({
  ok,
  status: ok ? 'ready' : 'degraded',
  service: 'steel-inspection-service',
  uptimeMs: 10_000,
  checks: {
    taskWorker: { ok: running, status: running ? 'idle' : 'stopped', running },
  },
});

const production = (queueDepth = 0, activeTaskId: string | null = null): ProductionStatus => ({
  code: 0,
  tasks: {
    queueDepth,
    capacity: 128,
    worker: { running: true, activeTaskId },
  },
});

const taskPage = (tasks: ProductionTaskPage['tasks'] = []): ProductionTaskPage => ({
  code: 0,
  total: tasks.length,
  limit: 16,
  offset: 0,
  tasks,
  taskWorker: { running: true, capacity: 128 },
});

describe('background monitor snapshot derivation', () => {
  it('reports a ready and idle runtime as healthy', () => {
    const snapshot = deriveBackgroundMonitorSnapshot({
      origin: 'http://127.0.0.1:4873',
      health: health(),
      production: production(),
      taskPage: taskPage(),
      now: 2_000,
    });

    expect(snapshot.state).toBe('healthy');
    expect(snapshot.serviceReady).toBe(true);
    expect(snapshot.workerRunning).toBe(true);
    expect(snapshot.detail).toContain('运行正常');
  });

  it('reports queue and active task activity as busy', () => {
    const snapshot = deriveBackgroundMonitorSnapshot({
      origin: 'http://127.0.0.1:4873',
      health: health(),
      production: production(3, 'TASK-1'),
      taskPage: taskPage([
        {
          taskId: 'TASK-1',
          kind: 'capture-once',
          materialId: 'PLATE-8',
          sessionId: 'SESSION-1',
          status: 'running',
          phase: 'capture',
          progress: 0.45,
          updatedAt: '2000',
        },
      ]),
      now: 2_000,
    });

    expect(snapshot.state).toBe('busy');
    expect(snapshot.queueDepth).toBe(3);
    expect(snapshot.activeTasks).toBe(1);
    expect(snapshot.activeTaskId).toBe('TASK-1');
    expect(snapshot.tasks[0]).toMatchObject({ progress: 0.45, phase: 'capture' });
  });

  it('counts only recent failures and blocked tasks as attention items', () => {
    const now = 2_000_000_000;
    const snapshot = deriveBackgroundMonitorSnapshot({
      origin: 'http://127.0.0.1:4873',
      health: health(),
      production: production(),
      taskPage: taskPage([
        {
          taskId: 'RECENT',
          kind: 'algorithm-run',
          materialId: 'PLATE-1',
          sessionId: 'SESSION-1',
          status: 'failed',
          error: 'algorithm failed',
          updatedAt: String(now - 1_000),
        },
        {
          taskId: 'BLOCKED',
          kind: 'steel-out',
          materialId: 'PLATE-2',
          sessionId: 'SESSION-2',
          status: 'blocked',
          blockedReason: 'dependency failed',
          updatedAt: String(now - 2_000),
        },
        {
          taskId: 'OLD',
          kind: 'capture-once',
          materialId: 'PLATE-3',
          sessionId: 'SESSION-3',
          status: 'failed',
          updatedAt: String(now - 31 * 60 * 1_000),
        },
      ]),
      now,
    });

    expect(snapshot.state).toBe('degraded');
    expect(snapshot.failedTasks).toBe(1);
    expect(snapshot.blockedTasks).toBe(1);
    expect(snapshot.tasks[1].error).toBe('dependency failed');
  });

  it('marks missing task endpoints as degraded without hiding service availability', () => {
    const snapshot = deriveBackgroundMonitorSnapshot({
      origin: 'http://127.0.0.1:4873',
      health: health(),
      production: null,
      taskPage: null,
      now: 2_000,
    });

    expect(snapshot.state).toBe('degraded');
    expect(snapshot.serviceAvailable).toBe(true);
    expect(snapshot.detail).toBe('任务状态接口暂时不可用');
  });
});
