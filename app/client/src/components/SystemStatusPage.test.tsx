import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceStatus } from '../data/inspection';
import { createEmptyCaptureSnapshot } from '../lib/capture-api';
import { createInitialOperationState } from '../state/operations';
import { CaptureManagementApp } from './SystemStatusPage';

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

function renderCaptureManagement(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  return render(
    <CaptureManagementApp
      status={deviceStatus}
      operation={createInitialOperationState()}
      capture={createEmptyCaptureSnapshot(null)}
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
      if (url === 'http://127.0.0.1:4881/api/trigger/status') {
        return jsonResponse(triggerStatus);
      }
      if (url.startsWith('http://127.0.0.1:4881/api/trigger/manual/')) {
        const target = url.endsWith('/steel-info')
          ? '/api/production/steel-info'
          : url.endsWith('/steel-in')
            ? '/api/production/steel-in'
            : '/api/production/steel-out';
        return jsonResponse({
          code: 0,
          gateway: 'steel-trigger-gateway',
          mode: 'manual',
          target,
          service: {
            code: 0,
            materialId: 'COIL-TEST-001',
            sessionId: 'COIL-TEST-001-session',
          },
        });
      }
      return jsonResponse({ code: 0 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes manual steel info, steel-in and steel-out commands through the trigger gateway', async () => {
    renderCaptureManagement(fetchMock);

    await waitFor(() => expect(screen.getByRole('button', { name: '写检测记录' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: '写检测记录' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => String(url) === 'http://127.0.0.1:4881/api/trigger/manual/steel-info' && init?.method === 'POST')).toBe(true);
    });

    await waitFor(() => expect(screen.getByRole('button', { name: '进钢开始保存' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '进钢开始保存' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => String(url) === 'http://127.0.0.1:4881/api/trigger/manual/steel-in' && init?.method === 'POST')).toBe(true);
    });

    await waitFor(() => expect(screen.getByRole('button', { name: '出钢结束' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '出钢结束' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => String(url) === 'http://127.0.0.1:4881/api/trigger/manual/steel-out' && init?.method === 'POST')).toBe(true);
    });

    const productionDirectCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes('/api/production/steel-') && init?.method === 'POST',
    );
    expect(productionDirectCalls).toHaveLength(0);

    const steelInCall = fetchMock.mock.calls.find(([url]) => String(url) === 'http://127.0.0.1:4881/api/trigger/manual/steel-in');
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
    });
  });
});
