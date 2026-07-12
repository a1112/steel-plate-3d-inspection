import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeAlarm, fetchAlarmPage, resolveAlarm, type PersistentAlarm } from './alarm-api';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const activeAlarm: PersistentAlarm = {
  id: 'ALARM-001',
  source: 'camera',
  type: 'camera-offline',
  severity: 'critical',
  materialId: 'MAT-001',
  sessionId: 'SESSION-001',
  inspectionId: 'INSPECTION-001',
  cameraId: 'CAM-01',
  message: '1 号相机离线',
  details: { ip: '192.168.10.11' },
  status: 'active',
  createdAt: '1783792800000',
  acknowledgedAt: '',
  resolvedAt: '',
  acknowledgedBy: '',
  acknowledgeNote: '',
  resolvedBy: '',
  resolveNote: '',
};

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    'steel-inspection-admin-session',
    JSON.stringify({
      authenticated: true,
      token: 'alarm-admin-token',
      expiresAt: '2099-01-01T00:00:00Z',
      user: { id: 'alarm-admin', displayName: '值班管理员', role: 'administrator', permissions: ['admin.records'] },
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('persistent alarm API client', () => {
  it('loads the open alarm page with server-side filters and the admin session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 0,
        total: 1,
        limit: 20,
        offset: 0,
        alarms: [activeAlarm],
        counts: { active: 1, acknowledged: 2, resolved: 9 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchAlarmPage({
      status: 'open',
      severity: ' critical ',
      source: ' camera ',
      keyword: ' CAM-01 ',
      limit: 20,
      offset: 0,
    });

    expect(page.alarms).toEqual([activeAlarm]);
    expect(page.counts).toEqual({ active: 1, acknowledged: 2, resolved: 9 });
    const [url, init] = fetchMock.mock.calls[0];
    const requestUrl = new URL(String(url));
    expect(requestUrl.pathname).toBe('/api/alarms');
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
      status: 'open',
      severity: 'critical',
      source: 'camera',
      keyword: 'CAM-01',
      limit: '20',
      offset: '0',
    });
    expect(init?.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer alarm-admin-token' });
  });

  it('acknowledges an alarm without trusting or sending a client actor', async () => {
    const acknowledged = {
      ...activeAlarm,
      status: 'acknowledged',
      acknowledgedAt: '1783792860000',
      acknowledgedBy: '值班管理员',
      acknowledgeNote: '已通知维护人员检查网线',
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 0, alarm: acknowledged }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(acknowledgeAlarm(activeAlarm.id, acknowledged.acknowledgeNote)).resolves.toEqual(acknowledged);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4873/api/alarms/acknowledge');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer alarm-admin-token',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      alarmId: 'ALARM-001',
      note: '已通知维护人员检查网线',
    });
    expect(String(init?.body)).not.toContain('actor');
  });

  it('resolves an acknowledged alarm with the durable audit note', async () => {
    const resolved = {
      ...activeAlarm,
      status: 'resolved',
      acknowledgedBy: '值班管理员',
      acknowledgeNote: '已确认',
      resolvedAt: '1783792920000',
      resolvedBy: '维护工程师',
      resolveNote: '更换网线并恢复采集',
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 0, alarm: resolved }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveAlarm(activeAlarm.id, resolved.resolveNote)).resolves.toEqual(resolved);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4873/api/alarms/resolve');
    expect(JSON.parse(String(init?.body))).toEqual({ alarmId: 'ALARM-001', note: '更换网线并恢复采集' });
  });
});
