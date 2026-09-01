import { describe, expect, it } from 'vitest';
import { inspectionSourcePresentation } from './inspection-source';

describe('inspection source presentation', () => {
  it('permanently marks replayed simulation records as excluded from production acceptance', () => {
    expect(inspectionSourcePresentation({
      sourceMode: 'simulation',
      sourceDatasetId: 'usb-dataset-1',
      sourceRunId: 'run-1',
      replayed: true,
      productionEligible: false,
    })).toMatchObject({
      label: '模拟回放·不计入生产验收',
      tone: 'simulation',
    });
  });

  it('makes missing provenance explicit for legacy history', () => {
    expect(inspectionSourcePresentation({ sourceMode: 'unknown' })).toEqual({
      label: '历史来源未知',
      tone: 'history',
      title: '旧记录没有可验证的采集来源证据',
    });
    expect(inspectionSourcePresentation({ sourceMode: 'legacy_unknown' })).toEqual({
      label: '历史来源未知',
      tone: 'history',
      title: '旧记录没有可验证的采集来源证据',
    });
  });
});
