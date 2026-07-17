import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelBarSurfaceProductionTask,
  captureBarSurfaceProductionOnce,
  fitBarSurfaceCalibration,
  runBarSurfaceProductionAlgorithm,
  type BarSurfaceProductionTask,
} from './bar-surface-api';

const SERVICE_ORIGIN = 'http://127.0.0.1:4873';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function productionTask<T>(
  status: BarSurfaceProductionTask<T>['status'],
  overrides: Partial<BarSurfaceProductionTask<T>> = {},
): BarSurfaceProductionTask<T> {
  return {
    id: 'TASK-001',
    taskId: 'TASK-001',
    kind: 'capture-once',
    materialId: 'MAT-001',
    sessionId: 'SESSION-001',
    status,
    phase: status,
    progress: status === 'succeeded' ? 100 : 0,
    attempts: status === 'queued' ? 0 : 1,
    maxAttempts: 1,
    cancelRequested: false,
    result: null,
    error: '',
    createdAt: '1783771200000',
    startedAt: '',
    finishedAt: '',
    updatedAt: '1783771200000',
    ...overrides,
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bar-surface persistent production tasks', () => {
  it('enqueues capture-once, polls with fake timers, and resolves the succeeded result', async () => {
    const captureResult = {
      code: 0,
      materialId: 'MAT-001',
      sessionId: 'SESSION-001',
      provider: { successes: 6, failures: 0 },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ code: 0, duplicate: false, task: productionTask('queued') }, 202),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          task: productionTask('running', {
            phase: 'executing',
            progress: 5,
            startedAt: '1783771200100',
          }),
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          task: productionTask('succeeded', {
            progress: 100,
            result: captureResult,
            startedAt: '1783771200100',
            finishedAt: '1783771200800',
          }),
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const statuses: string[] = [];

    const resultPromise = captureBarSurfaceProductionOnce({
      materialId: 'MAT-001',
      sessionId: 'SESSION-001',
      rounds: 1,
      onTaskStatus: (task) => statuses.push(task.status),
    });

    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(400);
    await expect(resultPromise).resolves.toEqual(captureResult);
    expect(statuses).toEqual(['queued', 'running', 'succeeded']);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${SERVICE_ORIGIN}/api/production/tasks/detail?id=TASK-001`,
      { headers: { Accept: 'application/json' } },
    );

    const enqueueBody = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(enqueueBody).toMatchObject({
      kind: 'capture-once',
      maxAttempts: 1,
      payload: {
        materialId: 'MAT-001',
        sessionId: 'SESSION-001',
        rounds: 1,
        productionLayout: true,
        requireSteelPresent: true,
      },
    });
    expect(enqueueBody.idempotencyKey).toEqual(expect.any(String));
  });

  it('rejects with the persisted terminal task error after polling a failed algorithm task', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          duplicate: false,
          task: productionTask('queued', {
            kind: 'algorithm-run',
          }),
        }, 202),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          task: productionTask('failed', {
            kind: 'algorithm-run',
            progress: 100,
            error: 'bar-surface core unavailable',
            finishedAt: '1783771200400',
          }),
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = runBarSurfaceProductionAlgorithm({ materialId: 'MAT-001' });
    const rejection = expect(resultPromise).rejects.toThrow('bar-surface core unavailable');

    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const enqueueBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body));
    expect(enqueueBody.payload).toMatchObject({ materialId: 'MAT-001', runCore: true });
    expect(enqueueBody.payload).not.toHaveProperty('meshRows');
    expect(enqueueBody.payload).not.toHaveProperty('maxFrames');
    expect(enqueueBody.payload).not.toHaveProperty('contourCrop');
    await vi.advanceTimersByTimeAsync(400);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a dependency-blocked task as terminal and reports the persisted reason', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          duplicate: false,
          task: productionTask('queued'),
        }, 202),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          task: productionTask('blocked', {
            chainId: 'SESSION-001',
            dependsOnTaskId: 'TASK-PARENT',
            dependencyPolicy: 'require-success',
            blockedReason: 'dependency_failed:TASK-PARENT',
            error: 'dependency_failed:TASK-PARENT',
            finishedAt: '1783771200400',
          }),
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = captureBarSurfaceProductionOnce({ materialId: 'MAT-001' });
    const rejection = expect(resultPromise).rejects.toThrow('dependency_failed:TASK-PARENT');

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(400);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('posts an explicit cancellation request and returns the updated task', async () => {
    const cancelledTask = productionTask('running', {
      cancelRequested: true,
      phase: 'executing',
      progress: 5,
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ code: 0, task: cancelledTask }, 202),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(cancelBarSurfaceProductionTask('TASK-001')).resolves.toEqual(cancelledTask);
    expect(fetchMock).toHaveBeenCalledWith(
      `${SERVICE_ORIGIN}/api/production/tasks/cancel`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: 'TASK-001' }),
      },
    );
  });

  it('runs automatic calibration capture and fit through one durable algorithm task', async () => {
    const fitResult = {
      code: 0,
      capture: {
        code: 0,
        successes: 8,
        failures: 0,
        completeFrames: 8,
        metadataFrames: 8,
        summaryOutput: 'H:\\calibration\\summary.json',
      },
      result: {
        cameraCount: 8,
        correctedXml: 'H:\\calibration\\ArrayCalibration.corrected.xml',
      },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        duplicate: false,
        task: productionTask('succeeded', {
          kind: 'algorithm-run',
          progress: 100,
          result: fitResult,
        }),
      }, 202),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fitBarSurfaceCalibration({ expectedCameras: 8 })).resolves.toEqual(fitResult);
    const enqueueBody = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(enqueueBody).toMatchObject({
      kind: 'algorithm-run',
      maxAttempts: 1,
      payload: {
        operation: 'calibration-capture-fit',
        expectedCameras: 8,
        autoActivate: true,
        profile: 'current-8-time-trigger',
        lines: 1000,
        width: 0,
        timeoutMs: 8000,
        dataMode: 3,
      },
    });
  });
});
