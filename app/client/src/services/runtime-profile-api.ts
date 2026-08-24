import {
  createAdminHeaders,
  getInspectionServiceOrigin,
  readAdminErrorMessage,
} from './inspection-api';

export type RuntimeCapabilities = {
  directCamera: boolean;
  captureManagement: boolean;
  reconstruction: boolean;
  offlineReplay: boolean;
};

export type RuntimeCamera = {
  id: string;
  displayOrder: number;
  sourceCameraId: number;
  role: string;
  sourceDirectory?: string;
};

export type RuntimeStorage = {
  sourceRoot: string;
  convertedRoot: string;
  catalogPath: string;
  converterOrigin: string;
};

export type RuntimeProfileDocument = {
  schema: 'steel.runtime-profile.v1' | string;
  id: string;
  displayName: string;
  provider: string;
  dataSource: string;
  cameraConnection: string;
  cameraCount: number;
  captureProfile?: string;
  cameras: RuntimeCamera[];
  storage: RuntimeStorage;
  capabilities: RuntimeCapabilities;
};

export type PublicRuntimeProfile = {
  schema: 'steel.runtime-profile.public.v1' | string;
  siteDisplayName?: string;
  profileId: string;
  displayName: string;
  provider: string;
  dataSource: string;
  cameraConnection: string;
  cameraCount: number;
  cameras: RuntimeCamera[];
  configHash: string;
  capabilities: RuntimeCapabilities;
};

export type AdminRuntimeProfileState = {
  schema: 'steel.runtime-profile.admin.v1' | string;
  activeProfile: PublicRuntimeProfile;
  savedProfile: RuntimeProfileDocument;
  activeConfigHash: string;
  savedConfigHash: string;
  restartRequired: boolean;
};

export type RuntimeProfileValidationResult = {
  valid: boolean;
  profileId: string;
  activeConfigHash: string;
  savedConfigHash: string;
  restartRequired: boolean;
};

export type RuntimeProfileSaveResult = {
  saved: boolean;
  profileId: string;
  activeConfigHash: string;
  savedConfigHash: string;
  restartRequired: boolean;
};

export type BkvImportJob = {
  id: string;
  status: string;
  totalRecords?: number;
  convertedRecords?: number;
  skippedRecords?: number;
  quarantinedRecords?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  failureDetails?: unknown[];
};

export type BkvImportStatus = {
  schema: string;
  ready: boolean;
  profileId?: string;
  cameraCount?: number;
  latestJob?: BkvImportJob | null;
};

export type BkvImportActionResult = {
  job_id: string;
  status: string;
  converted_records?: number;
  skipped_records?: number;
  quarantined_records?: number;
};

async function requestAdminJson<T>(
  path: string,
  fallback: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${getInspectionServiceOrigin()}${path}`, {
    ...init,
    headers: createAdminHeaders({
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, fallback));
  }
  return response.json() as Promise<T>;
}

export async function fetchRuntimeProfile(signal?: AbortSignal): Promise<PublicRuntimeProfile> {
  const response = await fetch(`${getInspectionServiceOrigin()}/api/runtime-profile`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`运行配置读取失败：${response.status}`);
  }
  return response.json() as Promise<PublicRuntimeProfile>;
}

export function fetchAdminRuntimeProfile(signal?: AbortSignal) {
  return requestAdminJson<AdminRuntimeProfileState>(
    '/api/admin/runtime-profile',
    '运行配置读取失败',
    { signal },
  );
}

export function validateAdminRuntimeProfile(profile: RuntimeProfileDocument) {
  return requestAdminJson<RuntimeProfileValidationResult>(
    '/api/admin/runtime-profile/validate',
    '运行配置校验失败',
    { method: 'POST', body: JSON.stringify({ profile }) },
  );
}

export function saveAdminRuntimeProfile(profile: RuntimeProfileDocument) {
  return requestAdminJson<RuntimeProfileSaveResult>(
    '/api/admin/runtime-profile',
    '运行配置保存失败',
    { method: 'POST', body: JSON.stringify({ profile }) },
  );
}

export function fetchAdminBkvImportJobs(signal?: AbortSignal) {
  return requestAdminJson<BkvImportStatus>(
    '/api/admin/bkv-import/jobs',
    '转换任务读取失败',
    { signal },
  );
}

export function startAdminBkvImportJob() {
  return requestAdminJson<BkvImportActionResult>(
    '/api/admin/bkv-import/jobs',
    '转换任务启动失败',
    { method: 'POST' },
  );
}

export function retryAdminBkvImportJob(jobId: string) {
  return requestAdminJson<BkvImportActionResult>(
    '/api/admin/bkv-import/jobs/retry',
    '转换任务重试失败',
    { method: 'POST', body: JSON.stringify({ jobId }) },
  );
}
