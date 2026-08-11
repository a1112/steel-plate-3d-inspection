import type { PublicRuntimeProfile } from '../services/runtime-profile-api';

export type RuntimeDashboardMode = {
  kind: 'bkv' | 'bkv-online' | 'direct';
  cameraCount: number;
  requestsOnlineServices: boolean;
  requestsStandardRecords: boolean;
  showsHardwareStatus: boolean;
  showsCaptureManagement: boolean;
  showsReconstruction: boolean;
  supportsOfflineReplay: boolean;
};

export function createRuntimeDashboardMode(
  profile: PublicRuntimeProfile,
): RuntimeDashboardMode {
  const usesConvertedStore = profile.dataSource === 'converted-local';
  if (usesConvertedStore && profile.capabilities.directCamera) {
    throw new Error('运行配置的 BKV 数据源与直连相机能力冲突');
  }
  if (usesConvertedStore) {
    return Object.freeze({
      kind: 'bkv',
      cameraCount: profile.cameraCount,
      requestsOnlineServices: false,
      requestsStandardRecords: true,
      showsHardwareStatus: false,
      showsCaptureManagement: false,
      showsReconstruction: true,
      supportsOfflineReplay: true,
    });
  }
  if (profile.dataSource === 'bkv-online-mysql') {
    return Object.freeze({
      kind: 'bkv-online',
      cameraCount: profile.cameraCount,
      requestsOnlineServices: false,
      requestsStandardRecords: true,
      showsHardwareStatus: false,
      showsCaptureManagement: false,
      showsReconstruction: false,
      supportsOfflineReplay: false,
    });
  }
  return Object.freeze({
    kind: 'direct',
    cameraCount: profile.cameraCount,
    requestsOnlineServices: true,
    requestsStandardRecords: false,
    showsHardwareStatus: true,
    showsCaptureManagement: profile.capabilities.captureManagement,
    showsReconstruction: profile.capabilities.reconstruction,
    supportsOfflineReplay: false,
  });
}
