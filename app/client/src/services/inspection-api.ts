import defectInclusionImage from '../assets/mock-defects/defect-inclusion.png';
import defectPitImage from '../assets/mock-defects/defect-pit.png';
import defectScratchImage from '../assets/mock-defects/defect-scratch.png';
import { getMockInspectionSnapshot } from '../data/inspection';
import type { DefectItem, InspectionSnapshot } from '../data/inspection';

const DEFAULT_SERVICE_ORIGIN = 'http://127.0.0.1:4873';
const DEFAULT_TRIGGER_GATEWAY_ORIGIN = 'http://127.0.0.1:4881';
const CONNECTION_CONFIG_KEY = 'steel-inspection-connection-config';
const ADMIN_SESSION_KEY = 'steel-inspection-admin-session';
const ADMIN_ERROR_MESSAGES: Record<string, string> = {
  auth_required: '请先登录后台管理',
  permission_denied: '当前账号没有该操作权限',
  origin_not_allowed: '请求来源不受信任，请从本机客户端操作',
  invalid_credentials: '账号或密码错误',
  login_locked: '登录失败次数过多，请稍后再试',
  role_disabled: '当前账号角色已停用',
  'cannot delete current user': '不能删除当前登录账号',
  'cannot delete last active administrator': '不能删除最后一个启用的管理员',
  'cannot change current user role': '不能修改当前登录账号的角色',
  'cannot disable current user': '不能停用当前登录账号',
  'cannot demote last active administrator': '不能降级或停用最后一个启用的管理员',
  'cannot remove current role management permission': '不能移除当前角色的角色权限管理权限',
  'role is assigned to active users': '该角色仍分配给启用账号',
  'role is still assigned to users': '该角色仍分配给账号',
  'invalid role permission': '角色包含无效权限',
  'invalid role id': '角色 ID 格式不符合要求',
  'invalid role label': '角色名称格式不符合要求',
  'invalid role description': '角色说明过长或格式不符合要求',
  'invalid admin user id': '账号 ID 格式不符合要求',
  'invalid admin user display name': '账号显示名称格式不符合要求',
  'session not found': '登录会话不存在或已失效',
  'cannot revoke current session': '不能撤销当前会话，请使用退出登录',
  'password required': '请设置密码',
  'invalid password length': '密码长度需为 8-128 位',
  'password complexity required': '密码需同时包含字母和数字',
  'password confirmation mismatch': '两次输入的新密码不一致',
  'new password must be different': '新密码不能与当前密码相同',
  'audit retention days required': '请填写审计日志保留天数',
  'invalid audit retention days': '审计日志保留天数需为 1-3650 天',
  'invalid security policy json': '安全策略不是合法 JSON',
  'invalid security policy': '安全策略不符合后台要求',
  'invalid config json': '配置不是合法 JSON',
  'invalid config schema': '配置结构不符合后台要求',
  'invalid capture config': '采集配置结构不符合后台要求',
  'invalid camera config': '相机配置结构不符合后台要求',
  'invalid defect type json': '缺陷类型不是合法 JSON',
  'invalid defect type': '缺陷类型结构不符合后台要求',
  'defect type is still assigned to defects': '该缺陷类型仍被缺陷记录引用',
  'record id required': '请先选择检测记录',
  'record not found': '检测记录不存在或已被删除',
  'record retention days required': '请填写检测记录保留天数',
  'invalid record retention days': '检测记录保留天数需为 1-3650 天',
  'invalid inspection settings json': '检测规则不是合法 JSON',
  'invalid inspection settings': '检测规则结构不符合后台要求',
  'invalid alarm rules json': '告警规则不是合法 JSON',
  'invalid alarm rules': '告警规则结构不符合后台要求',
  'invalid external integrations json': '外部系统接口配置不是合法 JSON',
  'invalid external integrations': '外部系统接口配置结构不符合后台要求',
  'invalid connection json': '连接配置不是合法 JSON',
  'invalid connection config': '连接配置结构不符合后台要求',
};

export type ConnectionMode = 'online' | 'demo';

export type ConnectionConfig = {
  mode: ConnectionMode;
  host: string;
  port: number;
};

export type AdminTableMetric = {
  name: string;
  label: string;
  rows: number;
};

export type AdminConfigSummary = {
  key: string;
  updatedAt: string;
  bytes: number;
};

export type AdminConfigRevision = {
  id: string;
  key: string;
  actor: string;
  action: string;
  bytes: number;
  createdAt: string;
};

export type AdminConfigRevisionFilter = {
  key?: string;
  limit?: number;
};

export type AdminConfigRevisionDetail = AdminConfigRevision & {
  value: unknown;
};

export type AdminUser = {
  id: string;
  displayName: string;
  role: string;
  status: string;
  lastLoginAt: string;
};

export type AdminAuthenticatedUser = {
  id: string;
  displayName: string;
  role: string;
  permissions: string[];
};

export type AdminAuthSession = {
  authenticated: boolean;
  token: string;
  createdAt?: string;
  expiresAt: string;
  user: AdminAuthenticatedUser;
};

export type AdminLoginSession = {
  id: string;
  userId: string;
  displayName: string;
  role: string;
  current: boolean;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
};

export type AdminRole = {
  id: string;
  label: string;
  description: string;
  permissions: string[];
  status: string;
  updatedAt: string;
};

export type AdminPermission = {
  id: string;
  label: string;
  group: string;
  description: string;
};

export type AdminServices = {
  updatedAt: string;
  api: {
    name: string;
    role: string;
    language: string;
    running: boolean;
    port: string | number;
    uptimeMs?: number;
    activeSessions: number;
    database: {
      engine: string;
      path: string;
      bytes?: number;
      configDir?: string;
    };
  };
  capture: {
    name?: string;
    managed?: boolean;
    running?: boolean;
    port?: number;
    origin?: string;
    processAvailable?: boolean;
    executable?: string;
    fallback?: string;
  };
  diagnostics?: Array<{
    id: string;
    label: string;
    status: 'normal' | 'warning' | 'error' | string;
    detail: string;
  }>;
};

export type AdminAuditLog = {
  id: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  level: string;
  createdAt: string;
};

export type AdminApiRoute = {
  method: string;
  path: string;
  scope: string;
};

export type AdminOverview = {
  updatedAt: string;
  service: {
    name: string;
    role: string;
    language: string;
    running: boolean;
    port: string | number;
    capture: {
      name?: string;
      managed?: boolean;
      running?: boolean;
      port?: number;
      origin?: string;
      processAvailable?: boolean;
      fallback?: string;
    };
  };
  database: {
    engine: string;
    orm: string;
    path: string;
    configDir: string;
    tables: AdminTableMetric[];
  };
  configs: AdminConfigSummary[];
  users: AdminUser[];
  roles?: AdminRole[];
  auditLogs: AdminAuditLog[];
  apiRoutes: AdminApiRoute[];
};

export type AdminUserInput = Pick<AdminUser, 'id' | 'displayName' | 'role' | 'status' | 'lastLoginAt'> & {
  password?: string;
};

export type AdminRoleInput = Pick<AdminRole, 'id' | 'label' | 'description' | 'permissions' | 'status'>;

export type AdminCameraConfig = {
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

export type AdminCameraConfigInput = AdminCameraConfig;

export type AdminDefectType = {
  id: string;
  label: string;
  color: string;
  shape: 'circle' | 'square' | 'rect' | 'diamond' | 'star' | string;
};

export type AdminDefectTypeInput = AdminDefectType;

export type AuditLogFilter = {
  keyword?: string;
  level?: string;
  limit?: number;
  offset?: number;
};

export type AdminAuditLogPage = {
  total: number;
  limit: number;
  offset: number;
  auditLogs: AdminAuditLog[];
};

export type AdminAuditRetentionResult = {
  code: number;
  retentionDays: number;
  cutoffAt: string;
  matched: number;
  deleted: number;
  dryRun: boolean;
};

export type AdminDatabaseStats = {
  pageCount: number;
  pageSize: number;
  freelistCount: number;
  bytes: number;
};

export type AdminDatabaseIntegrityResult = {
  code: number;
  status: 'ok' | 'warning' | string;
  messages: string[];
  stats: AdminDatabaseStats;
  checkedAt: string;
};

export type AdminDatabaseMaintenanceResult = {
  code: number;
  action: string;
  integrity: {
    status: 'ok' | 'warning' | string;
    messages: string[];
  };
  before: AdminDatabaseStats;
  after: AdminDatabaseStats;
  reclaimedBytes: number;
  checkedAt: string;
};

export type AdminDiagnosticStatus = 'normal' | 'warning' | 'error' | string;

export type AdminDiagnosticCheck = {
  id: string;
  group: string;
  label: string;
  status: AdminDiagnosticStatus;
  detail: string;
  recommendation: string;
};

export type AdminDiagnostics = {
  code: number;
  checkedAt: string;
  status: AdminDiagnosticStatus;
  summary: {
    normal: number;
    warning: number;
    error: number;
  };
  checks: AdminDiagnosticCheck[];
};

export type AdminInspectionSettings = {
  severeDepthMm: number;
  reviewDepthMm: number;
  minDefectWidthMm: number;
  cameraExposureUs: number;
  encoderPulsePerMeter: number;
  autoReview: boolean;
  alarmVolume: number;
  saveRawImages: boolean;
  source?: string;
};

export type AdminAlarmRules = {
  enabled: boolean;
  severeDefectThreshold: number;
  reviewDefectThreshold: number;
  cameraOffline: boolean;
  receiverPortFailure: boolean;
  plcOffline: boolean;
  l2Offline: boolean;
  notifySound: boolean;
  notifyBanner: boolean;
  retainMinutes: number;
  source?: string;
};

export type AdminExternalIntegrationEndpoint = {
  enabled: boolean;
  protocol: 'tcp' | 'modbus-tcp' | 'http' | 'http-json' | string;
  host: string;
  port: number;
  path: string;
  timeoutMs: number;
  retryIntervalMs: number;
};

export type AdminExternalIntegrations = {
  plc: AdminExternalIntegrationEndpoint;
  l2: AdminExternalIntegrationEndpoint;
  mes: AdminExternalIntegrationEndpoint;
  source?: string;
};

export type AdminSecurityPolicy = {
  auditRetentionDays: number;
  limits?: {
    minAuditRetentionDays: number;
    maxAuditRetentionDays: number;
    minLoginMaxFailures?: number;
    maxLoginMaxFailures?: number;
    minLoginWindowMinutes?: number;
    maxLoginWindowMinutes?: number;
    minLoginLockoutMinutes?: number;
    maxLoginLockoutMinutes?: number;
    minSessionTtlHours?: number;
    maxSessionTtlHours?: number;
  };
  login?: {
    maxFailures: number;
    failureWindowMinutes: number;
    lockoutMinutes: number;
  };
  session?: {
    ttlHours: number;
  };
  source?: string;
};

export type AdminSecurityPolicyInput = {
  auditRetentionDays: number;
  login: {
    maxFailures: number;
    failureWindowMinutes: number;
    lockoutMinutes: number;
  };
  session: {
    ttlHours: number;
  };
};

export type AdminInspectionRecord = {
  id: string;
  time: string;
  plateNo: string;
  status: string;
  defectCount: number;
  plate?: {
    plateNo: string;
    widthMm: number;
    lengthMm: number;
    thicknessMm: number;
    steelGrade: string;
    detectedAt: string;
  } | null;
  severity: {
    severe: number;
    review: number;
    minor: number;
  };
};

export type AdminDefectDetail = {
  id: string;
  plateNo: string;
  typeId: string;
  typeLabel: string;
  surface: string;
  severity: string;
  distanceHeadMm: number;
  operatorSideMm: number;
  driveSideMm: number;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  xRatio: number;
  yOffsetMm: number;
  previewX: number;
  previewY: number;
  previewImageUrl?: string;
};

export type AdminInspectionRecordDetail = AdminInspectionRecord & {
  defects: AdminDefectDetail[];
};

export type AdminInspectionRecordPage = {
  total: number;
  limit: number;
  offset: number;
  records: AdminInspectionRecord[];
};

export type AdminRecordRetentionResult = {
  code: number;
  retentionDays: number;
  cutoffAt: string;
  matched: number;
  deletedRecords: number;
  deletedDefects: number;
  deletedPlates: number;
  dryRun: boolean;
};

export type AdminRecordFilter = {
  keyword?: string;
  status?: string;
  limit?: number;
  offset?: number;
};

export type ProductionMaterialSession = {
  id: string;
  materialId: string;
  status: string;
  controlMode: string;
  triggerMode: string;
  updatedAt: string;
};

export type ProductionInspection = {
  id: string;
  materialId: string;
  sessionId: string;
  status: string;
  summaryPath: string;
  captureCount: number;
  defectCount: number;
  startedAt: string;
  finishedAt: string;
};

export type ProductionStatus = {
  code: number;
  database?: {
    engine: string;
    path: string;
  };
  latestSession?: ProductionMaterialSession | null;
  activeSession?: ProductionMaterialSession | null;
  latestInspection?: ProductionInspection | null;
  capture?: Record<string, unknown>;
};

export type ProductionEventInput = {
  materialId: string;
  sessionId?: string;
  source?: string;
  mode?: string;
  triggerMode?: string;
  storageRoot?: string;
  steelType?: string;
  width?: number;
  length?: number;
  thick?: number;
  autoCapture?: boolean;
  discardBlackFrames?: boolean;
};

export type ProductionCommandResult = {
  code: number;
  materialId?: string;
  sessionId?: string;
  inspectionId?: string;
  triggerEventId?: number;
  mode?: string;
  triggerMode?: string;
  flow?: {
    recordWrittenBeforeCapture?: boolean;
    captureSaveState?: string;
    saveEnabled?: boolean;
    discardBlackFrames?: boolean;
    algorithmPhase?: string;
  };
  provider?: unknown;
  record?: unknown;
  error?: string;
  message?: string;
};

export type TriggerGatewayMode = 'api' | 'gray' | 'secondary' | 'manual';

export type TriggerGatewayStatus = {
  code: number;
  service?: string;
  mode: TriggerGatewayMode | string;
  modeLabel?: string;
  manualAllowed: boolean;
  allowedModes?: TriggerGatewayMode[];
  inspectionServiceOrigin?: string;
  production?: ProductionStatus;
  error?: string;
  message?: string;
};

export type TriggerGatewayCommandResult = {
  code: number;
  gateway?: string;
  mode?: string;
  target?: string;
  service?: ProductionCommandResult;
  error?: string;
  message?: string;
};

const defectPreviewImages: Record<string, string> = {
  pit: defectPitImage,
  bubble: defectPitImage,
  scratch: defectScratchImage,
  longitudinal: defectScratchImage,
  edge: defectScratchImage,
  foreign: defectInclusionImage,
  inclusion: defectInclusionImage,
  roll: defectInclusionImage,
  burnt: defectInclusionImage,
  review: defectPitImage,
};

export function createDefaultConnectionConfig(): ConnectionConfig {
  return {
    mode: 'online',
    host: '127.0.0.1',
    port: 4873,
  };
}

function getSafeLocalStorage() {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function getStoredConnectionConfig(): ConnectionConfig {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return createDefaultConnectionConfig();
  }
  const raw = storage.getItem(CONNECTION_CONFIG_KEY);
  if (!raw) {
    return createDefaultConnectionConfig();
  }
  try {
    return { ...createDefaultConnectionConfig(), ...(JSON.parse(raw) as Partial<ConnectionConfig>) };
  } catch {
    return createDefaultConnectionConfig();
  }
}

export function saveLocalConnectionConfig(config: ConnectionConfig) {
  const storage = getSafeLocalStorage();
  if (storage) {
    storage.setItem(CONNECTION_CONFIG_KEY, JSON.stringify(config));
  }
}

function getStoredAdminSession(): AdminAuthSession | null {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return null;
  }
  const raw = storage.getItem(ADMIN_SESSION_KEY);
  if (!raw) {
    return null;
  }
  try {
    const session = JSON.parse(raw) as AdminAuthSession;
    return session?.token && session?.user ? session : null;
  } catch {
    storage.removeItem(ADMIN_SESSION_KEY);
    return null;
  }
}

function saveAdminSession(session: AdminAuthSession | null) {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  if (session) {
    storage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
  } else {
    storage.removeItem(ADMIN_SESSION_KEY);
  }
}

export function createAdminHeaders(headers: Record<string, string> = {}) {
  const session = getStoredAdminSession();
  return session?.token ? { ...headers, Authorization: `Bearer ${session.token}` } : headers;
}

export function getInspectionServiceOrigin(config = getStoredConnectionConfig()) {
  const configuredOrigin = import.meta.env.VITE_INSPECTION_SERVICE_ORIGIN;
  if (configuredOrigin && configuredOrigin.trim().length > 0) {
    return configuredOrigin;
  }
  return config.host && config.port ? `http://${config.host}:${config.port}` : DEFAULT_SERVICE_ORIGIN;
}

export function getTriggerGatewayOrigin() {
  const configuredOrigin = import.meta.env.VITE_TRIGGER_GATEWAY_ORIGIN;
  return configuredOrigin && configuredOrigin.trim().length > 0 ? configuredOrigin : DEFAULT_TRIGGER_GATEWAY_ORIGIN;
}

export async function readAdminErrorMessage(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: string; message?: string };
    if (payload.message) {
      return `${fallback}：${payload.message}`;
    }
    if (payload.error) {
      const mappedMessage = ADMIN_ERROR_MESSAGES[payload.error];
      if (mappedMessage) {
        return `${fallback}：${mappedMessage}`;
      }
      return `${fallback}：${response.status} ${payload.error}`;
    }
  } catch {
    // Fall through to the status-only message when a response has no JSON body.
  }
  return `${fallback}：${response.status}`;
}

export async function fetchAdminSession(signal?: AbortSignal): Promise<AdminAuthSession | null> {
  const storedSession = getStoredAdminSession();
  if (!storedSession?.token) {
    return null;
  }
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/auth/me`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    saveAdminSession(null);
    return null;
  }
  const payload = (await response.json()) as Partial<AdminAuthSession> & { authenticated?: boolean };
  if (!payload.authenticated || !payload.token || !payload.user || !payload.expiresAt) {
    saveAdminSession(null);
    return null;
  }
  const session = payload as AdminAuthSession;
  saveAdminSession(session);
  return session;
}

export async function loginAdmin(userId: string, password: string): Promise<AdminAuthSession> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, password }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '后台登录失败'));
  }
  const session = (await response.json()) as AdminAuthSession;
  saveAdminSession(session);
  return session;
}

export async function logoutAdmin(): Promise<void> {
  const config = getStoredConnectionConfig();
  try {
    await fetch(`${getInspectionServiceOrigin(config)}/api/admin/auth/logout`, {
      method: 'POST',
      headers: createAdminHeaders({ 'Content-Type': 'application/json' }),
      body: '{}',
    });
  } finally {
    saveAdminSession(null);
  }
}

export async function changeAdminPassword(currentPassword: string, newPassword: string, confirmPassword: string): Promise<void> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/auth/password`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '密码修改失败'));
  }
}

export async function fetchAdminLoginSessions(signal?: AbortSignal): Promise<AdminLoginSession[]> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/auth/sessions`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '登录会话接口异常'));
  }
  const payload = (await response.json()) as { sessions?: AdminLoginSession[] };
  return payload.sessions ?? [];
}

export async function revokeAdminLoginSession(id: string): Promise<void> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams({ id });
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/auth/sessions?${params.toString()}`, {
    method: 'DELETE',
    headers: createAdminHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '登录会话撤销失败'));
  }
}

function withPreviewImage(defect: DefectItem): DefectItem {
  return {
    ...defect,
    previewImageUrl: defectPreviewImages[defect.typeId] ?? defectPitImage,
  };
}

function normalizeInspectionSnapshot(snapshot: InspectionSnapshot): InspectionSnapshot {
  const inspections = snapshot.inspections.map((inspection) => ({
    ...inspection,
    defects: inspection.defects.map(withPreviewImage),
  }));
  return {
    ...snapshot,
    defects: snapshot.defects.map(withPreviewImage),
    inspections,
  };
}

export async function fetchInspectionSnapshot(signal?: AbortSignal): Promise<InspectionSnapshot> {
  const config = getStoredConnectionConfig();
  if (config.mode === 'demo') {
    return getMockInspectionSnapshot();
  }

  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/inspection/snapshot`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '后台数据接口异常'));
  }
  return normalizeInspectionSnapshot((await response.json()) as InspectionSnapshot);
}

export async function fetchProductionStatus(signal?: AbortSignal): Promise<ProductionStatus> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/production/status`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '生产采集状态接口异常'));
  }
  return response.json() as Promise<ProductionStatus>;
}

async function postProductionCommand(path: string, body: ProductionEventInput & Record<string, unknown>): Promise<ProductionCommandResult> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}${path}`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '生产采集指令失败'));
  }
  return response.json() as Promise<ProductionCommandResult>;
}

export async function writeProductionSteelInfo(input: ProductionEventInput): Promise<ProductionCommandResult> {
  return postProductionCommand('/api/production/steel-info', input);
}

export async function startProductionSteelIn(input: ProductionEventInput): Promise<ProductionCommandResult> {
  return postProductionCommand('/api/production/steel-in', {
    ...input,
    autoCapture: input.autoCapture ?? true,
    discardBlackFrames: input.discardBlackFrames ?? true,
  });
}

export async function stopProductionSteelOut(input: ProductionEventInput): Promise<ProductionCommandResult> {
  return postProductionCommand('/api/production/steel-out', input);
}

export async function captureProductionOnce(input: ProductionEventInput & Record<string, unknown>): Promise<ProductionCommandResult> {
  return postProductionCommand('/api/production/capture-once', {
    ...input,
    autoCapture: input.autoCapture ?? false,
    discardBlackFrames: input.discardBlackFrames ?? true,
  });
}

export async function fetchTriggerGatewayStatus(signal?: AbortSignal): Promise<TriggerGatewayStatus> {
  const response = await fetch(`${getTriggerGatewayOrigin()}/api/trigger/status`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '触发网关状态接口异常'));
  }
  return response.json() as Promise<TriggerGatewayStatus>;
}

export async function setTriggerGatewayMode(mode: TriggerGatewayMode): Promise<TriggerGatewayStatus> {
  const response = await fetch(`${getTriggerGatewayOrigin()}/api/trigger/mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '触发网关模式切换失败'));
  }
  return response.json() as Promise<TriggerGatewayStatus>;
}

function mergeTriggerGatewayResult(payload: TriggerGatewayCommandResult): ProductionCommandResult {
  const service = payload.service;
  return {
    ...(service ?? {}),
    code: payload.code ?? service?.code ?? 503,
    provider: {
      gateway: payload.gateway ?? 'steel-trigger-gateway',
      mode: payload.mode,
      target: payload.target,
      service: service ?? null,
    },
    error: payload.error ?? service?.error,
    message: payload.message ?? service?.message,
  };
}

async function postTriggerGatewayManualCommand(path: string, body: ProductionEventInput & Record<string, unknown>): Promise<ProductionCommandResult> {
  const response = await fetch(`${getTriggerGatewayOrigin()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '触发网关手动指令失败'));
  }
  const payload = (await response.json()) as TriggerGatewayCommandResult;
  return mergeTriggerGatewayResult(payload);
}

export async function triggerGatewayManualSteelInfo(input: ProductionEventInput & Record<string, unknown>): Promise<ProductionCommandResult> {
  return postTriggerGatewayManualCommand('/api/trigger/manual/steel-info', input);
}

export async function triggerGatewayManualSteelIn(input: ProductionEventInput & Record<string, unknown>): Promise<ProductionCommandResult> {
  return postTriggerGatewayManualCommand('/api/trigger/manual/steel-in', {
    ...input,
    present: true,
    value: 1,
    autoCapture: input.autoCapture ?? true,
    discardBlackFrames: input.discardBlackFrames ?? true,
  });
}

export async function triggerGatewayManualSteelOut(input: ProductionEventInput & Record<string, unknown>): Promise<ProductionCommandResult> {
  return postTriggerGatewayManualCommand('/api/trigger/manual/steel-out', {
    ...input,
    present: false,
    value: 0,
  });
}

export async function fetchConnectionConfig(signal?: AbortSignal): Promise<ConnectionConfig> {
  const localConfig = getStoredConnectionConfig();
  try {
    const response = await fetch(`${getInspectionServiceOrigin(localConfig)}/api/config/connection`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!response.ok) {
      return localConfig;
    }
    const remoteConfig = { ...createDefaultConnectionConfig(), ...((await response.json()) as Partial<ConnectionConfig>) };
    saveLocalConnectionConfig(remoteConfig);
    return remoteConfig;
  } catch {
    return localConfig;
  }
}

export async function saveConnectionConfig(config: ConnectionConfig): Promise<void> {
  if (config.mode === 'demo') {
    saveLocalConnectionConfig(config);
    return;
  }
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/config/connection`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '连接设置保存失败'));
  }
  saveLocalConnectionConfig(config);
}

export async function fetchConfigRevisions(
  filter: AdminConfigRevisionFilter = {},
  signal?: AbortSignal,
): Promise<AdminConfigRevision[]> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams();
  if (filter.key && filter.key !== 'all') {
    params.set('key', filter.key);
  }
  if (filter.limit) {
    params.set('limit', String(filter.limit));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/config/revisions${suffix}`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '配置版本接口异常'));
  }
  const payload = (await response.json()) as { revisions?: AdminConfigRevision[] };
  return payload.revisions ?? [];
}

export async function fetchConfigRevisionDetail(id: string, signal?: AbortSignal): Promise<AdminConfigRevisionDetail> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams({ id });
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/config/revisions/detail?${params.toString()}`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '配置版本详情接口异常'));
  }
  const payload = (await response.json()) as { revision?: AdminConfigRevisionDetail };
  if (!payload.revision) {
    throw new Error('配置版本详情响应异常');
  }
  return payload.revision;
}

export async function restoreConfigRevision(id: string): Promise<{
  code: number;
  message: string;
  sourceRevision: AdminConfigRevision;
  revision: AdminConfigRevision;
  config: { key: string; value: unknown };
}> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/config/revisions/restore`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '配置版本恢复失败'));
  }
  return response.json() as Promise<{
    code: number;
    message: string;
    sourceRevision: AdminConfigRevision;
    revision: AdminConfigRevision;
    config: { key: string; value: unknown };
  }>;
}

export async function fetchDatabaseInfo(signal?: AbortSignal): Promise<{ engine: string; orm: string; path: string; configDir: string }> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/database`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '数据库信息接口异常'));
  }
  return response.json() as Promise<{ engine: string; orm: string; path: string; configDir: string }>;
}

export async function downloadDatabaseBackup(signal?: AbortSignal): Promise<Blob> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/database/backup`, {
    headers: createAdminHeaders({ Accept: 'application/x-sqlite3' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '数据库备份下载失败'));
  }
  return response.blob();
}

export async function checkAdminDatabaseIntegrity(signal?: AbortSignal): Promise<AdminDatabaseIntegrityResult> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/database/integrity`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '数据库完整性检查失败'));
  }
  return response.json() as Promise<AdminDatabaseIntegrityResult>;
}

export async function runAdminDatabaseMaintenance(signal?: AbortSignal): Promise<AdminDatabaseMaintenanceResult> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/database/maintenance`, {
    method: 'POST',
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '数据库压缩整理失败'));
  }
  return response.json() as Promise<AdminDatabaseMaintenanceResult>;
}

export async function fetchInspectionSettings(signal?: AbortSignal): Promise<AdminInspectionSettings> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/inspection/settings`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '检测规则接口异常'));
  }
  return response.json() as Promise<AdminInspectionSettings>;
}

export async function fetchAdminInspectionSettings(signal?: AbortSignal): Promise<AdminInspectionSettings> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/inspection-settings`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '检测规则接口异常'));
  }
  return response.json() as Promise<AdminInspectionSettings>;
}

export async function saveAdminInspectionSettings(settings: AdminInspectionSettings): Promise<AdminInspectionSettings> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/inspection-settings`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify(settings),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '检测规则保存失败'));
  }
  const payload = (await response.json()) as { settings: AdminInspectionSettings };
  return payload.settings;
}

export async function fetchAdminAlarmRules(signal?: AbortSignal): Promise<AdminAlarmRules> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/alarm-rules`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '告警规则接口异常'));
  }
  return response.json() as Promise<AdminAlarmRules>;
}

export async function saveAdminAlarmRules(rules: AdminAlarmRules): Promise<AdminAlarmRules> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/alarm-rules`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify(rules),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '告警规则保存失败'));
  }
  const payload = (await response.json()) as { rules: AdminAlarmRules };
  return payload.rules;
}

export async function fetchAdminExternalIntegrations(signal?: AbortSignal): Promise<AdminExternalIntegrations> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/external-integrations`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '外部系统接口异常'));
  }
  return response.json() as Promise<AdminExternalIntegrations>;
}

export async function saveAdminExternalIntegrations(integrations: AdminExternalIntegrations): Promise<AdminExternalIntegrations> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/external-integrations`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify(integrations),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '外部系统接口保存失败'));
  }
  const payload = (await response.json()) as { integrations: AdminExternalIntegrations };
  return payload.integrations;
}

export async function fetchAdminOverview(signal?: AbortSignal): Promise<AdminOverview> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/overview`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '后台管理概览接口异常'));
  }
  return response.json() as Promise<AdminOverview>;
}

export async function fetchAdminUsers(signal?: AbortSignal): Promise<AdminUser[]> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/users`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '后台账号接口异常'));
  }
  const payload = (await response.json()) as { users?: AdminUser[] };
  return payload.users ?? [];
}

export async function saveAdminUser(user: AdminUserInput): Promise<AdminUser> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/users`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(user),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '后台账号保存失败'));
  }
  const payload = (await response.json()) as { user: AdminUser };
  return payload.user;
}

export async function deleteAdminUser(id: string): Promise<void> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams({ id });
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/users?${params.toString()}`, {
    method: 'DELETE',
    headers: createAdminHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '后台账号删除失败'));
  }
}

export async function fetchAdminRoles(signal?: AbortSignal): Promise<AdminRole[]> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/roles`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '角色权限接口异常'));
  }
  const payload = (await response.json()) as { roles?: AdminRole[] };
  return payload.roles ?? [];
}

export async function fetchAdminPermissions(signal?: AbortSignal): Promise<AdminPermission[]> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/permissions`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '权限目录接口异常'));
  }
  const payload = (await response.json()) as { permissions?: AdminPermission[] };
  return payload.permissions ?? [];
}

export async function saveAdminRole(role: AdminRoleInput): Promise<AdminRole> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/roles`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(role),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '角色权限保存失败'));
  }
  const payload = (await response.json()) as { role: AdminRole };
  return payload.role;
}

export async function deleteAdminRole(id: string): Promise<void> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams({ id });
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/roles?${params.toString()}`, {
    method: 'DELETE',
    headers: createAdminHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '角色权限删除失败'));
  }
}

export async function fetchAdminServices(signal?: AbortSignal): Promise<AdminServices> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/services`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '服务管理接口异常'));
  }
  return response.json() as Promise<AdminServices>;
}

export async function fetchAdminDiagnostics(signal?: AbortSignal): Promise<AdminDiagnostics> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/diagnostics`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '系统自检接口异常'));
  }
  return response.json() as Promise<AdminDiagnostics>;
}

type CaptureServiceAction = 'start' | 'stop' | 'restart';

type CaptureServiceActionResult = {
  code: number;
  action: CaptureServiceAction;
  success: boolean;
  running: boolean;
  services: AdminServices;
  started?: boolean;
  stopped?: boolean;
  restarted?: boolean;
};

const CAPTURE_SERVICE_ACTION_LABELS: Record<CaptureServiceAction, string> = {
  start: '启动',
  stop: '停止',
  restart: '重启',
};

async function controlCaptureService(action: CaptureServiceAction): Promise<CaptureServiceActionResult> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/services/capture/${action}`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json' }),
    body: '{}',
  });
  const payload = (await response.json().catch(() => null)) as {
    code?: number;
    action?: CaptureServiceAction;
    success?: boolean;
    running?: boolean;
    services?: AdminServices;
    started?: boolean;
    stopped?: boolean;
    restarted?: boolean;
    error?: string;
    message?: string;
  } | null;
  if (payload && typeof payload.success === 'boolean' && typeof payload.running === 'boolean' && payload.services) {
    return payload as CaptureServiceActionResult;
  }
  if (payload && action === 'restart' && typeof payload.restarted === 'boolean' && payload.services) {
    return {
      code: payload.code ?? (payload.restarted ? 0 : 503),
      action,
      success: payload.restarted,
      running: payload.restarted,
      restarted: payload.restarted,
      services: payload.services,
    };
  }
  if (!response.ok) {
    const actionLabel = CAPTURE_SERVICE_ACTION_LABELS[action];
    if (payload?.message) {
      throw new Error(`采集服务${actionLabel}失败：${payload.message}`);
    }
    if (payload?.error) {
      const mappedMessage = ADMIN_ERROR_MESSAGES[payload.error];
      throw new Error(`采集服务${actionLabel}失败：${mappedMessage ?? `${response.status} ${payload.error}`}`);
    }
    throw new Error(`采集服务${actionLabel}失败：${response.status}`);
  }
  throw new Error(`采集服务${CAPTURE_SERVICE_ACTION_LABELS[action]}响应异常`);
}

export async function startCaptureService(): Promise<CaptureServiceActionResult> {
  return controlCaptureService('start');
}

export async function stopCaptureService(): Promise<CaptureServiceActionResult> {
  return controlCaptureService('stop');
}

export async function restartCaptureService(): Promise<CaptureServiceActionResult> {
  return controlCaptureService('restart');
}

export async function fetchAdminCameras(signal?: AbortSignal): Promise<AdminCameraConfig[]> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/cameras`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '相机配置接口异常'));
  }
  const payload = (await response.json()) as { cameras?: AdminCameraConfig[] };
  return payload.cameras ?? [];
}

export async function saveAdminCamera(camera: AdminCameraConfigInput): Promise<AdminCameraConfig> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/cameras`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(camera),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '相机配置保存失败'));
  }
  const payload = (await response.json()) as { camera: AdminCameraConfig };
  return payload.camera;
}

export async function deleteAdminCamera(id: string): Promise<void> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams({ id });
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/cameras?${params.toString()}`, {
    method: 'DELETE',
    headers: createAdminHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '相机配置删除失败'));
  }
}

export async function fetchAdminDefectTypes(signal?: AbortSignal): Promise<AdminDefectType[]> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/defect-types`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '缺陷类型接口异常'));
  }
  const payload = (await response.json()) as { defectTypes?: AdminDefectType[] };
  return payload.defectTypes ?? [];
}

export async function saveAdminDefectType(defectType: AdminDefectTypeInput): Promise<AdminDefectType> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/defect-types`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify(defectType),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '缺陷类型保存失败'));
  }
  const payload = (await response.json()) as { defectType: AdminDefectType };
  return payload.defectType;
}

export async function deleteAdminDefectType(id: string): Promise<void> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams({ id });
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/defect-types?${params.toString()}`, {
    method: 'DELETE',
    headers: createAdminHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '缺陷类型删除失败'));
  }
}

export async function fetchAuditLogPage(filter: AuditLogFilter = {}, signal?: AbortSignal): Promise<AdminAuditLogPage> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams();
  if (filter.keyword) {
    params.set('keyword', filter.keyword);
  }
  if (filter.level && filter.level !== 'all') {
    params.set('level', filter.level);
  }
  if (filter.limit) {
    params.set('limit', String(filter.limit));
  }
  if (filter.offset) {
    params.set('offset', String(filter.offset));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/audit${suffix}`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '审计日志接口异常'));
  }
  const payload = (await response.json()) as Partial<AdminAuditLogPage> & { auditLogs?: AdminAuditLog[] };
  const auditLogs = payload.auditLogs ?? [];
  return {
    total: payload.total ?? auditLogs.length,
    limit: payload.limit ?? filter.limit ?? auditLogs.length,
    offset: payload.offset ?? filter.offset ?? 0,
    auditLogs,
  };
}

export async function exportAuditLogsCsv(filter: AuditLogFilter = {}, signal?: AbortSignal): Promise<string> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams();
  if (filter.keyword) {
    params.set('keyword', filter.keyword);
  }
  if (filter.level && filter.level !== 'all') {
    params.set('level', filter.level);
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/audit/export${suffix}`, {
    headers: createAdminHeaders({ Accept: 'text/csv' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '审计日志导出失败'));
  }
  return response.text();
}

export async function applyAuditRetentionPolicy(retentionDays: number, dryRun: boolean, signal?: AbortSignal): Promise<AdminAuditRetentionResult> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/audit/retention`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ retentionDays, dryRun }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '审计日志保留策略执行失败'));
  }
  return response.json() as Promise<AdminAuditRetentionResult>;
}

export async function fetchAdminSecurityPolicy(signal?: AbortSignal): Promise<AdminSecurityPolicy> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/security/policy`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '安全策略读取失败'));
  }
  const payload = (await response.json()) as Partial<AdminSecurityPolicy> & { policy?: AdminSecurityPolicy; source?: string };
  const policy = payload.policy ?? payload;
  return { ...policy, source: payload.source ?? policy.source } as AdminSecurityPolicy;
}

export async function saveAdminSecurityPolicy(policy: AdminSecurityPolicyInput, signal?: AbortSignal): Promise<AdminSecurityPolicy> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/security/policy`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify(policy),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '安全策略保存失败'));
  }
  const payload = (await response.json()) as { policy?: AdminSecurityPolicy; source?: string };
  const savedPolicy = payload.policy ?? (policy as AdminSecurityPolicy);
  return { ...savedPolicy, source: payload.source ?? savedPolicy.source };
}

export async function fetchAuditLogs(filter: AuditLogFilter = {}, signal?: AbortSignal): Promise<AdminAuditLog[]> {
  return (await fetchAuditLogPage(filter, signal)).auditLogs;
}

export async function fetchAdminRecords(filter: AdminRecordFilter = {}, signal?: AbortSignal): Promise<AdminInspectionRecordPage> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams();
  if (filter.keyword) {
    params.set('keyword', filter.keyword);
  }
  if (filter.status && filter.status !== 'all') {
    params.set('status', filter.status);
  }
  if (filter.limit) {
    params.set('limit', String(filter.limit));
  }
  if (filter.offset) {
    params.set('offset', String(filter.offset));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/records${suffix}`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '检测记录管理接口异常'));
  }
  return response.json() as Promise<AdminInspectionRecordPage>;
}

export async function fetchAdminRecordDetail(id: string, signal?: AbortSignal): Promise<AdminInspectionRecordDetail> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams({ id });
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/records/detail?${params.toString()}`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '检测记录详情接口异常'));
  }
  const payload = (await response.json()) as { record: AdminInspectionRecordDetail };
  return payload.record;
}

export async function exportAdminRecordsCsv(filter: AdminRecordFilter = {}, signal?: AbortSignal): Promise<string> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams();
  if (filter.keyword) {
    params.set('keyword', filter.keyword);
  }
  if (filter.status && filter.status !== 'all') {
    params.set('status', filter.status);
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/records/export${suffix}`, {
    headers: createAdminHeaders({ Accept: 'text/csv' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '检测记录导出失败'));
  }
  return response.text();
}

export async function applyRecordRetentionPolicy(
  retentionDays: number,
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<AdminRecordRetentionResult> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/records/retention`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ retentionDays, dryRun }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '检测记录保留策略执行失败'));
  }
  return response.json() as Promise<AdminRecordRetentionResult>;
}

export async function deleteAdminRecord(id: string): Promise<void> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams({ id });
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/records?${params.toString()}`, {
    method: 'DELETE',
    headers: createAdminHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '检测记录删除失败'));
  }
}
