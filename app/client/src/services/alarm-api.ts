import { createAdminHeaders, getInspectionServiceOrigin, readAdminErrorMessage } from './inspection-api';

export type AlarmLifecycleStatus = 'active' | 'acknowledged' | 'resolved';
export type AlarmListStatus = 'open' | AlarmLifecycleStatus | 'history' | 'all';

export type PersistentAlarm = {
  id: string;
  source: string;
  type: string;
  severity: string;
  materialId: string;
  sessionId: string;
  inspectionId: string;
  cameraId: string;
  message: string;
  details: unknown;
  status: AlarmLifecycleStatus | string;
  createdAt: string;
  acknowledgedAt: string;
  resolvedAt: string;
  acknowledgedBy: string;
  acknowledgeNote: string;
  resolvedBy: string;
  resolveNote: string;
};

export type AlarmCounts = {
  active: number;
  acknowledged: number;
  resolved: number;
};

export type AlarmPage = {
  code: number;
  total: number;
  limit: number;
  offset: number;
  alarms: PersistentAlarm[];
  counts: AlarmCounts;
};

export type AlarmFilter = {
  status?: AlarmListStatus;
  severity?: string;
  source?: string;
  keyword?: string;
  limit?: number;
  offset?: number;
};

function alarmQuery(filter: AlarmFilter) {
  const params = new URLSearchParams();
  params.set('status', filter.status ?? 'open');
  if (filter.severity?.trim()) {
    params.set('severity', filter.severity.trim());
  }
  if (filter.source?.trim()) {
    params.set('source', filter.source.trim());
  }
  if (filter.keyword?.trim()) {
    params.set('keyword', filter.keyword.trim());
  }
  params.set('limit', String(filter.limit ?? 20));
  params.set('offset', String(filter.offset ?? 0));
  return params;
}

export async function fetchAlarmPage(filter: AlarmFilter = {}, signal?: AbortSignal): Promise<AlarmPage> {
  const response = await fetch(`${getInspectionServiceOrigin()}/api/alarms?${alarmQuery(filter).toString()}`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '报警列表加载失败'));
  }
  const payload = (await response.json()) as Partial<AlarmPage>;
  return {
    code: payload.code ?? 0,
    total: payload.total ?? 0,
    limit: payload.limit ?? filter.limit ?? 20,
    offset: payload.offset ?? filter.offset ?? 0,
    alarms: payload.alarms ?? [],
    counts: {
      active: payload.counts?.active ?? 0,
      acknowledged: payload.counts?.acknowledged ?? 0,
      resolved: payload.counts?.resolved ?? 0,
    },
  };
}

async function transitionAlarm(action: 'acknowledge' | 'resolve', alarmId: string, note: string): Promise<PersistentAlarm> {
  const response = await fetch(`${getInspectionServiceOrigin()}/api/alarms/${action}`, {
    method: 'POST',
    headers: createAdminHeaders({ Accept: 'application/json', 'Content-Type': 'application/json' }),
    body: JSON.stringify({ alarmId, note }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, action === 'acknowledge' ? '报警确认失败' : '报警解除失败'));
  }
  const payload = (await response.json()) as { alarm?: PersistentAlarm };
  if (!payload.alarm) {
    throw new Error(action === 'acknowledge' ? '报警确认失败：响应缺少报警记录' : '报警解除失败：响应缺少报警记录');
  }
  return payload.alarm;
}

export function acknowledgeAlarm(alarmId: string, note: string): Promise<PersistentAlarm> {
  return transitionAlarm('acknowledge', alarmId, note);
}

export function resolveAlarm(alarmId: string, note: string): Promise<PersistentAlarm> {
  return transitionAlarm('resolve', alarmId, note);
}
