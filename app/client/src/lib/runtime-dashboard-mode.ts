import type { PublicRuntimeProfile } from '../services/runtime-profile-api';
import { isAcquisitionMode, type AcquisitionMode } from './acquisition-mode';

export type RuntimeDashboardMode = {
  kind: 'bkv' | 'bkv-online' | 'direct';
  acquisitionMode: AcquisitionMode;
  cameraCount: number;
  requestsOnlineServices: boolean;
  requestsStandardRecords: boolean;
  showsHardwareStatus: boolean;
  showsCaptureManagement: boolean;
  showsReconstruction: boolean;
  supportsOfflineReplay: boolean;
  acquisitionDisabled: boolean;
  allowsAcquisitionWrites: boolean;
  readOnly: boolean;
  usesPhysicalHardware: boolean;
  usesSimulationSource: boolean;
  allowsProductionWrites: boolean;
};

export function resolveProfileAcquisitionMode(profile: PublicRuntimeProfile): AcquisitionMode {
  if (isAcquisitionMode(profile.acquisitionMode)) return profile.acquisitionMode;
  if (profile.dataSource === 'converted-local') return 'offline';
  if (profile.provider === 'simulated' || profile.cameraConnection === 'simulated') return 'simulation';
  return 'online';
}

export function createRuntimeDashboardMode(
  profile: PublicRuntimeProfile,
): RuntimeDashboardMode {
  const usesConvertedStore = profile.dataSource === 'converted-local';
  const acquisitionMode = resolveProfileAcquisitionMode(profile);
  if (usesConvertedStore && profile.capabilities.directCamera) {
    throw new Error('运行配置的 BKV 数据源与直连相机能力冲突');
  }
  if (usesConvertedStore) {
    const formalOfflineMode = profile.acquisitionMode === 'offline';
    return Object.freeze({
      kind: 'bkv',
      acquisitionMode: 'offline',
      cameraCount: profile.cameraCount,
      requestsOnlineServices: formalOfflineMode,
      requestsStandardRecords: true,
      showsHardwareStatus: false,
      showsCaptureManagement: false,
      showsReconstruction: !formalOfflineMode,
      supportsOfflineReplay: true,
      acquisitionDisabled: true,
      allowsAcquisitionWrites: false,
      readOnly: !formalOfflineMode,
      usesPhysicalHardware: false,
      usesSimulationSource: false,
      allowsProductionWrites: formalOfflineMode,
    });
  }
  if (profile.dataSource === 'bkv-online-mysql') {
    return Object.freeze({
      kind: 'bkv-online',
      acquisitionMode,
      cameraCount: profile.cameraCount,
      requestsOnlineServices: false,
      requestsStandardRecords: true,
      showsHardwareStatus: false,
      showsCaptureManagement: false,
      showsReconstruction: false,
      supportsOfflineReplay: false,
      acquisitionDisabled: true,
      allowsAcquisitionWrites: false,
      readOnly: false,
      usesPhysicalHardware: false,
      usesSimulationSource: acquisitionMode === 'simulation',
      allowsProductionWrites: false,
    });
  }
  return Object.freeze({
    kind: 'direct',
    acquisitionMode,
    cameraCount: profile.cameraCount,
    // Direct offline mode still uses the inspection service for history,
    // review, reports and configuration. Capture polling is gated separately.
    requestsOnlineServices: true,
    requestsStandardRecords: false,
    showsHardwareStatus: acquisitionMode === 'online',
    showsCaptureManagement: acquisitionMode !== 'offline' && profile.capabilities.captureManagement,
    showsReconstruction: acquisitionMode !== 'offline' && profile.capabilities.reconstruction,
    supportsOfflineReplay: acquisitionMode === 'offline',
    acquisitionDisabled: acquisitionMode === 'offline',
    allowsAcquisitionWrites: acquisitionMode !== 'offline',
    readOnly: false,
    usesPhysicalHardware: acquisitionMode === 'online',
    usesSimulationSource: acquisitionMode === 'simulation',
    allowsProductionWrites: true,
  });
}
