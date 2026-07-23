import type { PublicRuntimeProfile } from '../services/runtime-profile-api';

export type RuntimeDashboardMode = {
  kind: 'bkv' | 'direct';
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
      showsReconstruction: false,
      supportsOfflineReplay: true,
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
