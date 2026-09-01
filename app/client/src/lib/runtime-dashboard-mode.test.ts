import { describe, expect, it } from 'vitest';
import type { PublicRuntimeProfile } from '../services/runtime-profile-api';
import { createRuntimeDashboardMode } from './runtime-dashboard-mode';

const bkvProfile: PublicRuntimeProfile = {
  schema: 'steel.runtime-profile.public.v1',
  profileId: 'bkv-6',
  displayName: 'BKV 六相机标准离线仓库',
  provider: 'bkv',
  dataSource: 'converted-local',
  cameraConnection: 'none',
  cameraCount: 6,
  cameras: [],
  configHash: 'bkv-hash',
  capabilities: {
    directCamera: false,
    captureManagement: false,
    reconstruction: false,
    offlineReplay: true,
  },
};

const directProfile: PublicRuntimeProfile = {
  ...bkvProfile,
  profileId: 'direct-8',
  displayName: '八相机在线直连',
  provider: 'headless-cpp',
  dataSource: 'mysql',
  cameraConnection: 'headless-cpp',
  cameraCount: 8,
  configHash: 'direct-hash',
  capabilities: {
    directCamera: true,
    captureManagement: true,
    reconstruction: true,
    offlineReplay: false,
  },
};

const bkvOnlineProfile: PublicRuntimeProfile = {
  ...bkvProfile,
  profileId: 'bkv-online-6',
  displayName: 'BKV 六相机在线转换',
  dataSource: 'bkv-online-mysql',
};

describe('runtime dashboard mode', () => {
  it('makes converted-local BKV the exclusive standard-record dashboard mode', () => {
    expect(createRuntimeDashboardMode(bkvProfile)).toMatchObject({
      kind: 'bkv',
      cameraCount: 6,
      requestsOnlineServices: false,
      requestsStandardRecords: true,
      showsHardwareStatus: false,
      showsCaptureManagement: false,
      showsReconstruction: true,
    });
  });

  it('keeps direct-camera mode on online services and hardware tools', () => {
    expect(createRuntimeDashboardMode(directProfile)).toMatchObject({
      kind: 'direct',
      cameraCount: 8,
      requestsOnlineServices: true,
      requestsStandardRecords: false,
      showsHardwareStatus: true,
      showsCaptureManagement: true,
      showsReconstruction: true,
    });
  });

  it('disables acquisition and new reconstruction work in direct offline mode without making history business read-only', () => {
    expect(createRuntimeDashboardMode({
      ...directProfile,
      acquisitionMode: 'offline',
    })).toMatchObject({
      kind: 'direct',
      acquisitionMode: 'offline',
      requestsOnlineServices: true,
      showsHardwareStatus: false,
      showsCaptureManagement: false,
      showsReconstruction: false,
      acquisitionDisabled: true,
      allowsAcquisitionWrites: false,
      readOnly: false,
      allowsProductionWrites: true,
    });
  });

  it('keeps formal BKV offline history business writable while disabling acquisition and new reconstruction', () => {
    expect(createRuntimeDashboardMode({
      ...bkvProfile,
      acquisitionMode: 'offline',
    })).toMatchObject({
      kind: 'bkv',
      acquisitionMode: 'offline',
      requestsOnlineServices: true,
      requestsStandardRecords: true,
      showsCaptureManagement: false,
      showsReconstruction: false,
      acquisitionDisabled: true,
      allowsAcquisitionWrites: false,
      readOnly: false,
      allowsProductionWrites: true,
    });
  });

  it('keeps simulation acquisition controls separate from physical hardware status', () => {
    expect(createRuntimeDashboardMode({
      ...directProfile,
      acquisitionMode: 'simulation',
      simulation: { configured: true, speed: 1.5, loop: true, interSessionGapMs: 1500 },
    })).toMatchObject({
      kind: 'direct',
      acquisitionMode: 'simulation',
      requestsOnlineServices: true,
      showsHardwareStatus: false,
      showsCaptureManagement: true,
      usesPhysicalHardware: false,
      usesSimulationSource: true,
      allowsAcquisitionWrites: true,
    });
  });

  it('keeps BKV online conversion on the live dashboard without hardware controls', () => {
    expect(createRuntimeDashboardMode(bkvOnlineProfile)).toMatchObject({
      kind: 'bkv-online',
      cameraCount: 6,
      requestsOnlineServices: false,
      requestsStandardRecords: true,
      showsHardwareStatus: false,
      showsCaptureManagement: false,
      showsReconstruction: false,
    });
  });

  it('rejects a converted-local profile that enables direct-camera capabilities', () => {
    expect(() => createRuntimeDashboardMode({
      ...bkvProfile,
      capabilities: {
        ...bkvProfile.capabilities,
        directCamera: true,
      },
    })).toThrow('运行配置的 BKV 数据源与直连相机能力冲突');
  });
});
