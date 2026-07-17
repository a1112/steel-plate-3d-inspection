import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmPage, PersistentAlarm } from '../services/alarm-api';
import { AlarmCenter } from './AlarmCenter';

const alarmApiMocks = vi.hoisted(() => ({
  fetchAlarmPage: vi.fn(),
  acknowledgeAlarm: vi.fn(),
  resolveAlarm: vi.fn(),
}));

vi.mock('../services/alarm-api', () => alarmApiMocks);

function makeAlarm(status: 'active' | 'acknowledged' | 'resolved', patch: Partial<PersistentAlarm> = {}): PersistentAlarm {
  return {
    id: `ALARM-${status.toUpperCase()}`,
    source: 'camera',
    type: 'camera-offline',
    severity: 'critical',
    materialId: 'MAT-001',
    sessionId: 'SESSION-001',
    inspectionId: 'INSPECTION-001',
    cameraId: 'CAM-01',
    message: status === 'active' ? '1 号相机离线' : status === 'acknowledged' ? '2 号相机温度过高' : '存储空间报警已解除',
    details: { ip: '192.168.10.11' },
    status,
    createdAt: '1783792800000',
    acknowledgedAt: status === 'active' ? '' : '1783792860000',
    resolvedAt: status === 'resolved' ? '1783792920000' : '',
    acknowledgedBy: status === 'active' ? '' : '值班管理员',
    acknowledgeNote: status === 'active' ? '' : '已确认现场状态',
    resolvedBy: status === 'resolved' ? '维护工程师' : '',
    resolveNote: status === 'resolved' ? '设备恢复并复测通过' : '',
    ...patch,
  };
}

function makePage(alarms: PersistentAlarm[]): AlarmPage {
  return {
    code: 0,
    total: alarms.length,
    limit: 20,
    offset: 0,
    alarms,
    counts: {
      active: alarms.filter((alarm) => alarm.status === 'active').length,
      acknowledged: alarms.filter((alarm) => alarm.status === 'acknowledged').length,
      resolved: alarms.filter((alarm) => alarm.status === 'resolved').length,
    },
  };
}

beforeEach(() => {
  alarmApiMocks.fetchAlarmPage.mockReset();
  alarmApiMocks.acknowledgeAlarm.mockReset();
  alarmApiMocks.resolveAlarm.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('AlarmCenter', () => {
  it('loads durable open alarms and applies server-side filters without mock fallback rows', async () => {
    const active = makeAlarm('active');
    const acknowledged = makeAlarm('acknowledged');
    alarmApiMocks.fetchAlarmPage.mockResolvedValue(makePage([active, acknowledged]));

    render(<AlarmCenter pollIntervalMs={0} />);

    expect(await screen.findByText('1 号相机离线')).toBeInTheDocument();
    expect(screen.getByText('2 号相机温度过高')).toBeInTheDocument();
    expect(alarmApiMocks.fetchAlarmPage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'open', limit: 20, offset: 0 }),
      expect.any(AbortSignal),
    );

    fireEvent.change(screen.getByLabelText('报警级别'), { target: { value: 'critical' } });
    fireEvent.change(screen.getByLabelText('报警来源'), { target: { value: 'camera' } });
    fireEvent.change(screen.getByLabelText('报警关键词'), { target: { value: 'CAM-01' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => {
      expect(alarmApiMocks.fetchAlarmPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'open', severity: 'critical', source: 'camera', keyword: 'CAM-01' }),
        expect.any(AbortSignal),
      );
    });

    fireEvent.click(screen.getByRole('tab', { name: '历史报警' }));
    await waitFor(() => {
      expect(alarmApiMocks.fetchAlarmPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'history' }),
        expect.any(AbortSignal),
      );
    });
  });

  it('requires an audit note, shows pending state, and renders server-owned confirmation and resolution identities', async () => {
    const active = makeAlarm('active');
    let durableAlarm = active;
    alarmApiMocks.fetchAlarmPage.mockImplementation(async (filter: { status?: string }) => {
      if (filter.status === 'history') {
        return makePage(durableAlarm.status === 'resolved' ? [durableAlarm] : []);
      }
      return makePage(durableAlarm.status === 'resolved' ? [] : [durableAlarm]);
    });

    let completeAcknowledge!: (alarm: PersistentAlarm) => void;
    alarmApiMocks.acknowledgeAlarm.mockReturnValue(
      new Promise<PersistentAlarm>((resolve) => {
        completeAcknowledge = resolve;
      }),
    );

    render(<AlarmCenter pollIntervalMs={0} />);
    await screen.findByText('1 号相机离线');

    fireEvent.click(screen.getByRole('button', { name: '确认报警 ALARM-ACTIVE' }));
    fireEvent.click(screen.getByRole('button', { name: '提交确认' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请填写处置说明');

    fireEvent.change(screen.getByLabelText('确认说明 ALARM-ACTIVE'), { target: { value: '现场已确认，通知维护人员' } });
    fireEvent.click(screen.getByRole('button', { name: '提交确认' }));
    expect(screen.getByRole('button', { name: '正在确认…' })).toBeDisabled();
    expect(alarmApiMocks.acknowledgeAlarm).toHaveBeenCalledWith('ALARM-ACTIVE', '现场已确认，通知维护人员');

    durableAlarm = makeAlarm('acknowledged', {
      id: active.id,
      message: active.message,
      acknowledgedBy: '服务端值班员',
      acknowledgeNote: '现场已确认，通知维护人员',
    });
    completeAcknowledge(durableAlarm);

    expect(await screen.findByText('服务端值班员')).toBeInTheDocument();
    expect(screen.getByText('现场已确认，通知维护人员')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '解除报警 ALARM-ACTIVE' })).toBeInTheDocument();

    alarmApiMocks.resolveAlarm.mockImplementation(async (_alarmId: string, note: string) => {
      durableAlarm = makeAlarm('resolved', {
        id: active.id,
        message: active.message,
        acknowledgedBy: '服务端值班员',
        acknowledgeNote: '现场已确认，通知维护人员',
        resolvedBy: '服务端维护员',
        resolveNote: note,
      });
      return durableAlarm;
    });
    fireEvent.click(screen.getByRole('button', { name: '解除报警 ALARM-ACTIVE' }));
    fireEvent.change(screen.getByLabelText('解除说明 ALARM-ACTIVE'), { target: { value: '更换网线并复测通过' } });
    fireEvent.click(screen.getByRole('button', { name: '提交解除' }));

    expect(await screen.findByText(/已由 服务端维护员 解除/)).toBeInTheDocument();
    expect(screen.queryByText('1 号相机离线')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '历史报警' }));
    expect(await screen.findByText('1 号相机离线')).toBeInTheDocument();
    expect(screen.getByText('服务端维护员')).toBeInTheDocument();
    expect(screen.getByText('更换网线并复测通过')).toBeInTheDocument();
  });

  it('keeps the action form open and displays an authorization error from the service', async () => {
    const active = makeAlarm('active');
    alarmApiMocks.fetchAlarmPage.mockResolvedValue(makePage([active]));
    alarmApiMocks.acknowledgeAlarm.mockRejectedValue(new Error('报警确认失败：401 auth_required'));

    render(<AlarmCenter pollIntervalMs={0} />);
    await screen.findByText(active.message);
    fireEvent.click(screen.getByRole('button', { name: '确认报警 ALARM-ACTIVE' }));
    fireEvent.change(screen.getByLabelText('确认说明 ALARM-ACTIVE'), { target: { value: '准备确认' } });
    fireEvent.click(screen.getByRole('button', { name: '提交确认' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('401 auth_required');
    expect(screen.getByLabelText('确认说明 ALARM-ACTIVE')).toHaveValue('准备确认');
    expect(screen.getByRole('button', { name: '提交确认' })).toBeEnabled();
  });

  it('renders an automatically recovered system-health episode as immutable history', async () => {
    const recovered = makeAlarm('resolved', {
      id: 'ALARM-HEALTH-001',
      source: 'system-health',
      type: 'storage-capacity-warning',
      severity: 'warning',
      materialId: '',
      sessionId: '',
      inspectionId: '',
      cameraId: '',
      message: '存储容量接近生产水位，请安排归档或清理。',
      details: {
        schema: 'steel.system-health.alarm.v1',
        check: 'storage',
        freePercent: 12,
      },
      acknowledgedBy: 'system-health-monitor',
      acknowledgeNote: '系统检测到运行条件已恢复，自动确认并关闭告警。',
      resolvedBy: 'system-health-monitor',
      resolveNote: '系统健康监视器确认运行条件已恢复。',
    });
    alarmApiMocks.fetchAlarmPage.mockImplementation(async (filter: { status?: string }) => (
      makePage(filter.status === 'history' ? [recovered] : [])
    ));

    render(<AlarmCenter pollIntervalMs={0} />);
    expect(await screen.findByText('当前没有符合条件的活动报警')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '历史报警' }));

    expect(await screen.findByText(recovered.message)).toBeInTheDocument();
    expect(screen.getByText('system-health')).toBeInTheDocument();
    expect(screen.getAllByText('system-health-monitor')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /报警 ALARM-HEALTH-001/ })).not.toBeInTheDocument();
  });
});
