import { describe, expect, it } from 'vitest';
import { getMockInspectionSnapshot } from '../data/inspection';
import {
  applyInspectionSettingsToDefects,
  createDefaultSettings,
  createInitialOperationState,
  exportRowsAsCsv,
  filterDefectsForReport,
  getDeviceStatusWithOperation,
  getReportMetrics,
  runSystemAction,
  saveSettingsDraft,
  validateSettings,
} from './operations';

describe('operations state helpers', () => {
  it('filters report defects by severity, surface, category, and keyword', () => {
    const snapshot = getMockInspectionSnapshot();

    const severeTopPits = filterDefectsForReport(snapshot.defects, {
      severity: 'severe',
      surface: 'top',
      typeId: 'pit',
      keyword: '8342',
    });

    expect(severeTopPits.map((defect) => defect.id)).toEqual(['D-001']);
  });

  it('calculates report metrics from the filtered defect set', () => {
    const snapshot = getMockInspectionSnapshot();
    const severeDefects = filterDefectsForReport(snapshot.defects, {
      severity: 'severe',
      surface: 'all',
      typeId: 'all',
      keyword: '',
    });

    expect(getReportMetrics(severeDefects)).toEqual({
      total: 4,
      severe: 4,
      review: 0,
      minor: 0,
      top: 3,
      bottom: 1,
      maxDepthMm: 0.16,
    });
  });

  it('validates and saves settings drafts without mutating the previous settings', () => {
    const initial = createDefaultSettings();
    const invalid = {
      ...initial,
      severeDepthMm: 0.04,
      reviewDepthMm: 0.1,
      alarmVolume: 120,
    };

    expect(validateSettings(invalid)).toEqual({
      severeDepthMm: '严重阈值必须大于待复核阈值',
      alarmVolume: '报警音量范围为 0-100',
    });

    const saved = saveSettingsDraft(initial, { ...initial, severeDepthMm: 0.18, alarmVolume: 72 });
    expect(saved.severeDepthMm).toBe(0.18);
    expect(saved.alarmVolume).toBe(72);
    expect(initial.severeDepthMm).not.toBe(saved.severeDepthMm);
  });

  it('regrades visible defects from saved threshold settings', () => {
    const snapshot = getMockInspectionSnapshot();
    const settings = { ...createDefaultSettings(), severeDepthMm: 0.15, reviewDepthMm: 0.1 };
    const regraded = applyInspectionSettingsToDefects(snapshot.defects, settings);

    expect(regraded.find((defect) => defect.id === 'D-001')?.severity).toBe('review');
    expect(regraded.find((defect) => defect.id === 'D-010')?.severity).toBe('severe');
    expect(getReportMetrics(regraded).severe).toBe(1);
  });

  it('preserves the accepted current-plate severity split with default settings', () => {
    const snapshot = getMockInspectionSnapshot();
    const regraded = applyInspectionSettingsToDefects(snapshot.defects, createDefaultSettings());

    expect(getReportMetrics(regraded)).toMatchObject({
      severe: 4,
      review: 3,
      minor: 5,
    });
  });

  it('runs system actions as local state changes with an auditable event log', () => {
    const state = createInitialOperationState();
    const checked = runSystemAction(state, 'self-check');
    const cleared = runSystemAction(checked, 'clear-alarm');

    expect(checked.serviceHealth.inspectionEngine).toBe('normal');
    expect(cleared.alarmCount).toBe(0);
    expect(cleared.events[0].message).toBe('已清除当前报警计数');
    expect(cleared.events[1].message).toBe('系统自检完成，核心服务正常');
  });

  it('projects operation alarm state into the device status used by the header', () => {
    const snapshot = getMockInspectionSnapshot();
    const cleared = runSystemAction(createInitialOperationState(), 'clear-alarm');

    expect(snapshot.status.alarmCount).toBe(1);
    expect(getDeviceStatusWithOperation(snapshot.status, cleared).alarmCount).toBe(0);
  });

  it('exports visible report rows as csv text', () => {
    const snapshot = getMockInspectionSnapshot();
    const csv = exportRowsAsCsv(snapshot.defects.slice(0, 2));

    expect(csv.split('\n')[0]).toBe('序号,钢管号,缺陷类别,相机区,等级,距头距离(mm),尺寸(mm),深度(mm)');
    expect(csv).toContain('D-001,202606131900,凹坑,1-3号相机,严重,8342,0.42 x 0.36,-0.12');
  });
});
