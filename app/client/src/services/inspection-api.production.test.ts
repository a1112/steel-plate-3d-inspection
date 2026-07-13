import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockInspectionSnapshot } from '../data/inspection';
import {
  captureProductionOnce,
  fetchInspectionSnapshot,
  fetchServiceHealthDetails,
  startProductionSteelIn,
  stopProductionSteelOut,
  triggerGatewayManualSteelIn,
  writeProductionSteelInfo,
} from './inspection-api';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('persistent production command client', () => {
  it('does not inject bundled defect images into an online database snapshot', async () => {
    const fixture = getMockInspectionSnapshot();
    const productionSnapshot = {
      ...fixture,
      source: 'sqlite-seaorm',
      defects: fixture.defects.map((defect) => ({ ...defect, previewImageUrl: '' })),
      inspections: fixture.inspections.map((inspection) => ({
        ...inspection,
        source: 'production',
        defects: inspection.defects.map((defect) => ({ ...defect, previewImageUrl: '' })),
      })),
      captureImages: [{
        id: 'CAPTURE-1',
        cameraId: 'camera1',
        cameraIp: '192.168.1.11',
        dataName: 'intensity',
        sequenceNo: 1,
        fileType: 'png',
        path: 'records/INS-1/intensity.png',
        url: '/api/production/file?path=records%2FINS-1%2Fintensity.png',
        createdAt: '2026-07-12 10:00:00',
      }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(productionSnapshot)));

    const snapshot = await fetchInspectionSnapshot();

    expect(snapshot.source).toBe('sqlite-seaorm');
    expect(snapshot.defects.every((defect) => defect.previewImageUrl === '')).toBe(true);
    expect(snapshot.inspections.flatMap((inspection) => inspection.defects).every((defect) => defect.previewImageUrl === '')).toBe(true);
    expect(snapshot.captureImages?.[0].url).toBe(
      'http://127.0.0.1:4873/api/production/file?path=records%2FINS-1%2Fintensity.png',
    );
  });

  it('allows bundled defect fallbacks only for an explicitly marked demo response', async () => {
    const fixture = getMockInspectionSnapshot();
    const demoSnapshot = {
      ...fixture,
      source: 'demo',
      defects: fixture.defects.map((defect) => ({ ...defect, previewImageUrl: '' })),
      inspections: fixture.inspections.map((inspection) => ({
        ...inspection,
        source: 'demo',
        defects: inspection.defects.map((defect) => ({ ...defect, previewImageUrl: '' })),
      })),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(demoSnapshot)));

    const snapshot = await fetchInspectionSnapshot();

    expect(snapshot.source).toBe('demo');
    expect(snapshot.defects.every((defect) => defect.previewImageUrl.includes('/src/assets/mock-defects/'))).toBe(true);
  });

  it('keeps structured readiness details when the service reports HTTP 503', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: false,
        status: 'not-ready',
        service: 'steel-inspection-service',
        uptimeMs: 1200,
        checks: {
          database: { ok: true, status: 'up' },
          capture: { ok: false, status: 'unavailable', reason: 'capture_provider_unreachable' },
          calibrationReconciliation: {
            ok: false,
            status: 'reconciliation-required',
            unresolvedCount: 1,
            unresolvedOperations: [{
              operationId: 'apply-pending-42',
              kind: 'apply',
              status: 'needs-reconciliation',
            }],
            reason: 'calibration_reconciliation_required',
          },
          storage: { ok: false, status: 'unavailable', reason: 'storage_provider_unreachable' },
          trigger: { ok: true, status: 'up', required: true },
        },
      }, 503),
    );
    vi.stubGlobal('fetch', fetchMock);

    const health = await fetchServiceHealthDetails();

    expect(health.ok).toBe(false);
    expect(health.checks.capture?.reason).toBe('capture_provider_unreachable');
    expect(health.checks.calibrationReconciliation).toMatchObject({
      ok: false,
      unresolvedCount: 1,
      unresolvedOperations: [{ operationId: 'apply-pending-42' }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/health/details',
      { headers: { Accept: 'application/json' }, signal: undefined },
    );
  });

  it('routes steel events to explicit durable task endpoints with caller idempotency', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(jsonResponse({ code: 0, task: { taskId: 'TASK-1', status: 'queued' } }, 202)),
    );
    vi.stubGlobal('fetch', fetchMock);

    await writeProductionSteelInfo({ materialId: 'MAT-1', requestId: 'INFO-1' });
    await startProductionSteelIn({ materialId: 'MAT-1', requestId: 'IN-1' });
    await stopProductionSteelOut({ materialId: 'MAT-1', requestId: 'OUT-1' });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'http://127.0.0.1:4873/api/production/tasks/steel-info',
      'http://127.0.0.1:4873/api/production/tasks/steel-in',
      'http://127.0.0.1:4873/api/production/tasks/steel-out',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      materialId: 'MAT-1',
      requestId: 'INFO-1',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({
      requestId: 'IN-1',
      autoCapture: true,
      discardBlackFrames: true,
    });
  });

  it('enqueues capture-once through the generic task API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ code: 0, task: { taskId: 'TASK-CAPTURE', status: 'queued' } }, 202),
    );
    vi.stubGlobal('fetch', fetchMock);

    await captureProductionOnce({
      materialId: 'MAT-1',
      sessionId: 'SESSION-1',
      requestId: 'CAPTURE-1',
      rounds: 1,
    });

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:4873/api/production/tasks');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      kind: 'capture-once',
      idempotencyKey: 'CAPTURE-1',
      maxAttempts: 1,
      payload: {
        materialId: 'MAT-1',
        sessionId: 'SESSION-1',
        requestId: 'CAPTURE-1',
        rounds: 1,
        autoCapture: false,
        discardBlackFrames: true,
      },
    });
  });

  it('preserves queued task identity returned through the trigger gateway', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 0,
        gateway: 'steel-trigger-gateway',
        mode: 'manual',
        target: '/api/production/tasks/steel-in',
        service: {
          code: 0,
          task: {
            taskId: 'TASK-IN',
            kind: 'steel-in',
            materialId: 'MAT-1',
            sessionId: 'SESSION-1',
            status: 'queued',
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await triggerGatewayManualSteelIn({
      materialId: 'MAT-1',
      requestId: 'IN-1',
    });

    expect(result.task?.taskId).toBe('TASK-IN');
    expect(result.materialId).toBe('MAT-1');
    expect(result.sessionId).toBe('SESSION-1');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://127.0.0.1:4873/api/trigger/manual/steel-in',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      requestId: 'IN-1',
      present: true,
      value: 1,
    });
  });
});
