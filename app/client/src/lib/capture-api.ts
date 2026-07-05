import { invoke } from '@tauri-apps/api/core';

export type CaptureDriverInfo = {
  id: string;
  name: string;
  vendor: string;
  transport: string;
  sdkVersion: string;
  supportedModels: string[];
  features: string[];
};

export type CaptureCamera = {
  ip: string;
  model: string;
  sn: string;
  driverId?: string;
  source?: string;
  configured?: boolean;
};

export type CaptureHealth = {
  service: string;
  time: string;
  sdkReady: boolean;
  sdkCode: number;
  sdkVersion?: string;
  connected: boolean;
  ip: string;
  driverId?: string;
  driverName?: string;
  cameraCount?: number;
};

export type CaptureCameraStatus = {
  connected: boolean;
  deviceId: number;
  ip: string;
  driverId?: string;
  model?: string;
  sn?: string;
  configId?: string | null;
  name?: string | null;
  role?: string | null;
  enabled?: boolean;
  acquisitionState?: 'connected' | 'discovered' | 'offline' | 'disabled' | string;
  sdkStatus?: string;
  fps?: number | null;
  bufferPercent?: number | null;
  lastFrameTime?: string | null;
  task?: number;
  status?: number;
  linkHealth?: number;
  temperatureJ28?: number;
  temperatureJ29?: number;
  temperatureJ30?: number;
  lostPulseCounter?: number;
  bufferOverflowCounter?: number;
  error?: string | null;
};

export type CaptureCameraConfig = {
  id: string;
  name: string;
  ip: string;
  driverId: string;
  modelHint: string;
  role: string;
  enabled: boolean;
  triggerMode: string;
  exposureUs: number;
  gain: number;
  depthLines: number;
  outputPath: string;
};

export type CaptureAppliedConfig = {
  id: string;
  name: string;
  applied: boolean;
  updatedAt: string;
  cameras: CaptureCameraConfig[];
};

export type CaptureControlCapability = {
  id: string;
  label: string;
  scope: string;
  requiresConnection: boolean;
};

export type CaptureParameterCapability = {
  key: string;
  label: string;
  valueType: 'int' | 'float' | string;
  unit: string;
  min?: number | null;
  max?: number | null;
  writable: boolean;
};

export type CaptureApiCapability = {
  method: string;
  path: string;
  label: string;
  scope: string;
};

export type CaptureCapabilitySet = {
  driver: CaptureDriverInfo;
  controls: CaptureControlCapability[];
  parameters: CaptureParameterCapability[];
  api: CaptureApiCapability[];
};

export type CaptureLogEvent = {
  id: string;
  time: string;
  level: 'info' | 'warning' | 'error' | string;
  cameraIp?: string | null;
  message: string;
};

export type CaptureSnapshot = {
  health: CaptureHealth | null;
  driver: CaptureDriverInfo;
  config: CaptureAppliedConfig;
  cameras: CaptureCamera[];
  status: CaptureCameraStatus | null;
  statuses: CaptureCameraStatus[];
  capabilities: CaptureCapabilitySet;
  logs: CaptureLogEvent[];
  error: string | null;
};

type ServiceConfigResponse = {
  service?: {
    name?: string;
    role?: string;
    capturePort?: number;
    captureOrigin?: string;
    updatedAt?: string;
  };
  capture?: {
    mode?: string;
    driver?: string;
    fallback?: string;
    cameras?: CaptureCameraConfig[];
  };
};

export type CaptureCommandResult = {
  code: number;
  connected?: boolean;
  ip?: string;
  key?: string;
  output?: string;
  imageUrl?: string;
  width?: number;
  lines?: number;
  error?: string;
  message?: string;
};

const DEFAULT_CAPTURE_SERVICE_ORIGIN = 'http://127.0.0.1:4873';

function getCaptureServiceOrigin() {
  const configuredOrigin = import.meta.env.VITE_CAPTURE_SERVICE_ORIGIN || import.meta.env.VITE_INSPECTION_SERVICE_ORIGIN;
  return configuredOrigin && configuredOrigin.trim().length > 0 ? configuredOrigin : DEFAULT_CAPTURE_SERVICE_ORIGIN;
}

function hasTauriRuntime() {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

async function invokeCapture<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!hasTauriRuntime()) {
    return null;
  }
  return invoke<T>(command, args);
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(`${getCaptureServiceOrigin()}${path}`);
  if (!response.ok) {
    throw new Error(`capture api ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function writeJson<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`${getCaptureServiceOrigin()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`capture api ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function timestamp() {
  return String(Date.now());
}

export function createDefaultCaptureCameras(): CaptureCameraConfig[] {
  const cameras = [
    { ip: '192.168.105.13', model: 'LVM3450CA', role: '\u4e0a\u8868\u9762\u5165\u53e3\u76f8\u673a' },
    { ip: '192.168.102.100', model: 'LVM3450CA', role: '\u4e0a\u8868\u9762\u4e2d\u90e8\u76f8\u673a' },
    { ip: '192.168.101.100', model: 'LVM3450BE', role: '\u4e0a\u8868\u9762\u51fa\u53e3\u76f8\u673a' },
    { ip: '192.168.103.100', model: 'LVM3450RE', role: '\u4e0b\u8868\u9762\u5165\u53e3\u76f8\u673a' },
    { ip: '192.168.104.100', model: 'LVM3450BE', role: '\u4e0b\u8868\u9762\u4e2d\u90e8\u76f8\u673a' },
    { ip: '192.168.106.100', model: 'LVM3450RE', role: '\u4e0b\u8868\u9762\u51fa\u53e3\u76f8\u673a' },
  ];
  return cameras.map((camera, index) => {
    const cameraNo = index + 1;
    const cameraId = `CAM-${String(cameraNo).padStart(2, '0')}`;
    return {
      id: cameraId,
      name: `${cameraNo} \u53f7\u91c7\u96c6\u76f8\u673a`,
      ip: camera.ip,
      role: camera.role,
      driverId: 'lvm-nvt',
      modelHint: camera.model,
      enabled: true,
      triggerMode: '\u8f6f\u4ef6\u89e6\u53d1',
      exposureUs: 850,
      gain: 1,
      depthLines: 1280,
      outputPath: `captures/${cameraId}`,
    };
  });
}

export function createDefaultCaptureDriver(): CaptureDriverInfo {
  return {
    id: 'lvm-nvt',
    name: 'LVM/NVT 3D Camera SDK',
    vendor: 'Capture 6.7 SDK',
    transport: 'GigE/Network',
    sdkVersion: '',
    supportedModels: ['LVM3450CA', 'LVM compatible 3D camera'],
    features: ['discover', 'multi-connect', 'parameters', 'depth-map', 'status-readback'],
  };
}

export function createDefaultCaptureConfig(): CaptureAppliedConfig {
  return {
    id: 'six-camera-capture',
    name: 'Six-Camera-Capture',
    applied: true,
    updatedAt: timestamp(),
    cameras: createDefaultCaptureCameras(),
  };
}

export function createDefaultCaptureCapabilities(driver = createDefaultCaptureDriver()): CaptureCapabilitySet {
  return {
    driver,
    controls: [
      { id: 'connect', label: '连接相机', scope: 'camera', requiresConnection: false },
      { id: 'disconnect', label: '断开相机', scope: 'camera', requiresConnection: true },
      { id: 'capture_depth_map', label: '采集深度图', scope: 'camera', requiresConnection: true },
      { id: 'apply_config', label: '应用配置', scope: 'system', requiresConnection: false },
    ],
    parameters: [
      { key: 'ExposureTime', label: '曝光', valueType: 'int', unit: 'us', min: 1, max: 20000, writable: true },
      { key: 'GainK', label: '增益', valueType: 'float', unit: 'x', min: 0, max: 16, writable: true },
      { key: 'DepthLines', label: '深度行数', valueType: 'int', unit: 'line', min: 64, max: 8192, writable: false },
    ],
    api: [
      { method: 'GET', path: '/api/config', label: '配置中心', scope: 'system' },
      { method: 'GET', path: '/api/camera/statuses', label: '相机状态', scope: 'camera' },
      { method: 'POST', path: '/api/camera/connect', label: '连接相机', scope: 'camera' },
      { method: 'POST', path: '/api/param', label: '下发参数', scope: 'camera' },
      { method: 'POST', path: '/api/capture/depth-map', label: '采集深度图', scope: 'camera' },
    ],
  };
}

function createStatusFromConfig(config: CaptureCameraConfig, discovered?: CaptureCamera): CaptureCameraStatus {
  return {
    connected: false,
    deviceId: -1,
    ip: config.ip,
    driverId: config.driverId,
    model: discovered?.model || config.modelHint,
    sn: discovered?.sn || '',
    configId: config.id,
    name: config.name,
    role: config.role,
    enabled: config.enabled,
    acquisitionState: config.enabled ? (discovered ? 'discovered' : 'offline') : 'disabled',
    sdkStatus: 'pending',
    fps: null,
    bufferPercent: 0,
    lastFrameTime: null,
    error: config.enabled ? 'not connected' : null,
  };
}

function hydrateSnapshot(partial: Partial<CaptureSnapshot> & { error?: string | null }): CaptureSnapshot {
  const driver = partial.driver ?? createDefaultCaptureDriver();
  const config = partial.config ?? createDefaultCaptureConfig();
  const capabilities = partial.capabilities ?? createDefaultCaptureCapabilities(driver);
  const cameras = partial.cameras ?? [];
  const discoveredByIp = new Map(cameras.map((camera) => [camera.ip, camera]));
  const statuses =
    partial.statuses && partial.statuses.length > 0
      ? partial.statuses
      : config.cameras.map((camera) => createStatusFromConfig(camera, discoveredByIp.get(camera.ip)));

  return {
    health: partial.health ?? null,
    driver,
    config,
    cameras,
    status: partial.status ?? statuses.find((status) => status.connected) ?? statuses[0] ?? null,
    statuses,
    capabilities,
    logs: partial.logs ?? [],
    error: partial.error ?? null,
  };
}

export async function readCaptureSnapshot(): Promise<CaptureSnapshot> {
  const [configResult, health, camerasResult, status, statusesResult] = await Promise.all([
    readJson<ServiceConfigResponse>('/api/config').catch((): ServiceConfigResponse => ({})),
    readJson<CaptureHealth>('/api/capture/health'),
    readJson<{ cameras: CaptureCamera[] }>('/api/cameras'),
    readJson<CaptureCameraStatus>('/api/camera/status'),
    readJson<{ statuses: CaptureCameraStatus[] }>('/api/camera/statuses').catch(() => ({ statuses: [] })),
  ]);

  const config = {
    ...createDefaultCaptureConfig(),
    cameras: configResult.capture?.cameras?.length ? configResult.capture.cameras : createDefaultCaptureConfig().cameras,
  };
  const cameras = camerasResult.cameras.map((camera) => ({
    ...camera,
    driverId: camera.driverId ?? 'lvm-nvt',
    source: camera.source ?? 'http-service',
  }));
  const discoveredByIp = new Map(cameras.map((camera) => [camera.ip, camera]));
  const statusByIp = new Map(statusesResult.statuses.map((cameraStatus) => [cameraStatus.ip, cameraStatus]));
  const statuses = config.cameras.map((camera) => {
    const backendStatus = statusByIp.get(camera.ip) ?? (status.connected && status.ip === camera.ip ? status : null);
    if (backendStatus) {
      return {
        ...createStatusFromConfig(camera, discoveredByIp.get(camera.ip)),
        ...backendStatus,
        driverId: backendStatus.driverId ?? 'lvm-nvt',
        name: camera.name,
        role: camera.role,
        configId: camera.id,
        acquisitionState: backendStatus.connected ? 'connected' : backendStatus.acquisitionState,
        sdkStatus: backendStatus.sdkStatus ?? (health.sdkReady ? 'ready' : 'error'),
      };
    }
    return createStatusFromConfig(camera, discoveredByIp.get(camera.ip));
  });

  return hydrateSnapshot({
    health,
    driver: { ...createDefaultCaptureDriver(), sdkVersion: health.sdkVersion ?? '' },
    config,
    cameras,
    status,
    statuses,
    logs: [
      {
        id: 'HTTP-001',
        time: timestamp(),
        level: health.sdkReady ? 'info' : 'warning',
        cameraIp: health.ip || null,
        message: health.sdkReady ? 'HTTP capture service ready' : 'HTTP capture service waiting for SDK',
      },
    ],
  });
}

export function createEmptyCaptureSnapshot(error: string | null = null): CaptureSnapshot {
  return hydrateSnapshot({ error });
}

export async function applyCaptureConfig(config: CaptureAppliedConfig) {
  return writeJson<CaptureCommandResult>('/api/config/capture', {
    service: {
      name: 'steel-inspection-service',
      role: 'api-config-capture-orchestrator',
      updatedAt: timestamp(),
    },
    capture: {
      mode: 'six-camera',
      driver: 'lvm-nvt',
      fallback: 'simulated',
      cameras: config.cameras,
    },
  });
}

export async function connectCaptureCamera(ip: string, devType = -1) {
  return writeJson<CaptureCommandResult>('/api/camera/connect', { ip, devType });
}

export async function disconnectCaptureCamera(ip?: string) {
  return writeJson<CaptureCommandResult>('/api/camera/disconnect', ip ? { ip } : {});
}

export async function setCaptureParam(key: string, type: 'int' | 'float', value: number, ip?: string) {
  return writeJson<CaptureCommandResult>('/api/param', { ip, key, type, value });
}

export async function setCaptureSoftwareTrigger(ip?: string) {
  return writeJson<CaptureCommandResult>('/api/param', { ip, key: 'TriggerMode', type: 'int', value: 0 });
}

export async function captureDepthMap(lines = 1280, output = 'capture-depth.png', ip?: string) {
  const result = await writeJson<CaptureCommandResult>('/api/capture/depth-map', { ip, lines, output });
  return {
    ...result,
    imageUrl: result.imageUrl?.startsWith('/') ? `${getCaptureServiceOrigin()}${result.imageUrl}` : result.imageUrl,
  };
}

export async function openCaptureManagementWindow() {
  const result = await invokeCapture<{ opened: boolean; label: string; error?: string | null }>('open_capture_management_window');
  if (result) {
    return result;
  }
  window.open('/?app=capture', '_blank', 'popup,width=1480,height=900');
  return {
    opened: true,
    label: 'browser-capture-management',
  };
}
