import {
  createAdminHeaders,
  getInspectionServiceOrigin,
  readAdminErrorMessage,
} from './inspection-api';

export type SiteMode = 'bkv' | 'direct-camera';
export type SiteConfigCheckDepth = 'default' | 'deep';
export type SiteConfigCheckStatus = 'normal' | 'warning' | 'error';

export type SiteConfigAvailability = {
  normal: number;
  warning: number;
  error: number;
  blocking: number;
  checkedAt?: number | null;
};

export type SiteConfigSummary = {
  id: string;
  displayName: string;
  mode: SiteMode;
  cameraCount: number;
  active: boolean;
  pending: boolean;
  restartRequired: boolean;
  availability?: SiteConfigAvailability;
};

export type SiteConfigDocument = {
  schema: 'steel.site-config.v1' | string;
  id: string;
  displayName: string;
  mode: SiteMode;
  runtimeProfile: string;
  connectionConfig: string;
  captureConfig: string;
};

export type SiteConfigCheck = {
  id: string;
  label: string;
  status: SiteConfigCheckStatus;
  message: string;
  blocking: boolean;
};

export type SiteConfigCheckReport = {
  siteId: string;
  depth: SiteConfigCheckDepth;
  checkedAt: number;
  checks: SiteConfigCheck[];
};

export type SiteConfigListResponse = {
  schema: 'steel.site-config-list.v1' | string;
  activeSiteId: string;
  pendingSiteId?: string | null;
  restartRequired: boolean;
  sites: SiteConfigSummary[];
};

export type SiteConfigDetailResponse = {
  schema: 'steel.site-config-detail.v1' | string;
  site: SiteConfigSummary;
  document: SiteConfigDocument;
  report?: SiteConfigCheckReport | null;
};

export type CreateSiteConfigInput = {
  id: string;
  displayName: string;
  mode: SiteMode;
};

export type CloneSiteConfigInput = {
  id: string;
  displayName: string;
};

export type UpdateSiteConfigInput = {
  displayName: string;
};

export type SiteConfigMutationResponse = {
  created?: boolean;
  saved?: boolean;
  deleted?: boolean;
  site?: SiteConfigSummary;
};

export type SiteConfigActivationResponse = {
  activated: boolean;
  activeSiteId: string;
  pendingSiteId: string;
  restartRequired: boolean;
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

export function fetchSiteConfigs(signal?: AbortSignal) {
  return requestAdminJson<SiteConfigListResponse>(
    '/api/admin/site-configs',
    '现场配置列表读取失败',
    { signal },
  );
}

export function fetchSiteConfig(id: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ id });
  return requestAdminJson<SiteConfigDetailResponse>(
    `/api/admin/site-configs/detail?${query.toString()}`,
    '现场配置详情读取失败',
    { signal },
  );
}

export function createSiteConfig(input: CreateSiteConfigInput) {
  return requestAdminJson<SiteConfigMutationResponse>(
    '/api/admin/site-configs',
    '现场配置新建失败',
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function cloneSiteConfig(sourceId: string, input: CloneSiteConfigInput) {
  return requestAdminJson<SiteConfigMutationResponse>(
    '/api/admin/site-configs/clone',
    '现场配置复制失败',
    { method: 'POST', body: JSON.stringify({ sourceId, ...input }) },
  );
}

export function updateSiteConfig(id: string, input: UpdateSiteConfigInput) {
  return requestAdminJson<SiteConfigMutationResponse>(
    '/api/admin/site-configs',
    '现场配置保存失败',
    { method: 'PATCH', body: JSON.stringify({ id, ...input }) },
  );
}

export async function deleteSiteConfig(id: string) {
  const query = new URLSearchParams({ id });
  await requestAdminJson<SiteConfigMutationResponse>(
    `/api/admin/site-configs?${query.toString()}`,
    '现场配置删除失败',
    { method: 'DELETE' },
  );
}

export function checkSiteConfig(id: string, depth: SiteConfigCheckDepth) {
  return requestAdminJson<{ schema: string; report: SiteConfigCheckReport }>(
    '/api/admin/site-configs/check',
    '现场配置检查失败',
    { method: 'POST', body: JSON.stringify({ id, depth }) },
  );
}

export function activateSiteConfig(id: string) {
  return requestAdminJson<SiteConfigActivationResponse>(
    '/api/admin/site-configs/activate',
    '现场配置切换失败',
    { method: 'POST', body: JSON.stringify({ id }) },
  );
}
