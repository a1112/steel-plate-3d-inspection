import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ParameterManagementApp } from './ParameterManagementApp';

const adminSession = {
  authenticated: true,
  token: 'test-admin-token',
  createdAt: '1782879112730',
  expiresAt: '1782907912730',
  user: {
    id: 'admin',
    displayName: '系统管理员',
    role: 'administrator',
    permissions: ['admin.overview', 'admin.services', 'admin.users', 'admin.roles', 'admin.config', 'admin.cameras', 'admin.records', 'admin.audit'],
  },
};

const adminOverview = {
  updatedAt: '1782879112730',
  siteConfiguration: {
    active: {
      id: 'bkv-default',
      displayName: 'BKV 六相机现场',
      mode: 'bkv',
      provider: 'bkv',
      dataSource: 'legacy-bkv',
      cameraCount: 6,
      capabilities: {
        directCamera: false,
        captureManagement: false,
        reconstruction: false,
        offlineReplay: true,
      },
      configHash: 'bkv-config-hash',
      compatibility: true,
    },
    pending: null,
    restartRequired: false,
    checkSummary: {
      normal: 5,
      warning: 1,
      error: 0,
      blocking: 0,
      checkedAt: 1782879112730,
    },
  },
  service: {
    name: 'steel-inspection-service',
    role: 'api-config-capture-orchestrator',
    language: 'rust',
    running: true,
    port: 4873,
    capture: {
      name: 'capture-service',
      managed: true,
      running: false,
      port: 4317,
      fallback: 'simulated-eight-camera',
    },
  },
  database: {
    engine: 'sqlite',
    orm: 'sea-orm',
    path: '/tmp/steel-inspection.sqlite',
    configDir: '/tmp/config',
    tables: [
      { name: 'steel_plate', label: '钢管档案', rows: 10 },
      { name: 'defect', label: '缺陷明细', rows: 12 },
      { name: 'defect_type', label: '缺陷类型', rows: 10 },
      { name: 'audit_log', label: '审计日志', rows: 2 },
      { name: 'admin_role', label: '角色权限', rows: 2 },
    ],
  },
  configs: [
    { key: 'capture', updatedAt: '1782879112730', bytes: 474 },
    { key: 'connection', updatedAt: '1782879112730', bytes: 48 },
    { key: 'inspection_settings', updatedAt: '1782879112730', bytes: 160 },
    { key: 'alarm_rules', updatedAt: '1782879112730', bytes: 196 },
  ],
  users: [
    { id: 'admin', displayName: '系统管理员', role: 'administrator', status: 'active', lastLoginAt: '2026-06-13 19:00' },
    { id: 'engineer', displayName: '工艺工程师', role: 'engineer', status: 'active', lastLoginAt: '2026-06-13 18:42' },
  ],
  roles: [
    {
      id: 'administrator',
      label: '管理员',
      description: '拥有后台管理全部权限',
      permissions: ['admin.overview', 'admin.services', 'admin.users', 'admin.roles', 'admin.config', 'admin.cameras', 'admin.records', 'admin.audit'],
      status: 'active',
      updatedAt: '1782879112730',
    },
    {
      id: 'engineer',
      label: '工程师',
      description: '维护工艺、相机和检测记录',
      permissions: ['admin.overview', 'admin.services', 'admin.config', 'admin.cameras', 'admin.records'],
      status: 'active',
      updatedAt: '1782879112730',
    },
  ],
  auditLogs: [
    {
      id: 'AUD-1',
      actor: 'system',
      action: 'service.bootstrap',
      target: 'steel-inspection-service',
      detail: '服务启动并完成 SQLite/SeaORM 初始化',
      level: 'info',
      createdAt: '1782879112730',
    },
  ],
  apiRoutes: [
    { method: 'GET', path: '/api/admin/overview', scope: 'admin' },
    { method: 'POST', path: '/api/config/capture', scope: 'config' },
  ],
};

function setAdminOverviewSiteMode(mode: 'bkv' | 'direct-camera') {
  const direct = mode === 'direct-camera';
  Object.assign(adminOverview.siteConfiguration.active, {
    id: direct ? 'direct-default' : 'bkv-default',
    displayName: direct ? '八相机直连现场' : 'BKV 六相机现场',
    mode,
    provider: direct ? 'headless-cpp' : 'bkv',
    dataSource: direct ? 'line-scan-camera' : 'legacy-bkv',
    cameraCount: direct ? 8 : 6,
    capabilities: {
      directCamera: direct,
      captureManagement: direct,
      reconstruction: direct,
      offlineReplay: !direct,
    },
    configHash: direct ? 'direct-config-hash' : 'bkv-config-hash',
    compatibility: !direct,
  });
  adminOverview.siteConfiguration.pending = null;
  adminOverview.siteConfiguration.restartRequired = false;
}

const adminRecordPage = {
  total: 10,
  limit: 8,
  offset: 0,
  records: [
    {
      id: 'R-001',
      time: '19:00',
      plateNo: '202606131900',
      status: 'detecting',
      defectCount: 12,
      plate: {
        plateNo: '202606131900',
        widthMm: 3500,
        lengthMm: 12000,
        thicknessMm: 12,
        steelGrade: 'Q355B',
        detectedAt: '2026-06-13 19:00',
      },
      severity: { severe: 4, review: 3, minor: 5 },
    },
  ],
};

const adminRecordDetail = {
  ...adminRecordPage.records[0],
  defects: [
    {
      id: 'D-001',
      plateNo: '202606131900',
      typeId: 'pit',
      typeLabel: '凹坑',
      surface: '1-3号相机',
      severity: 'severe',
      distanceHeadMm: 8342,
      operatorSideMm: 1260,
      driveSideMm: 2240,
      widthMm: 0.42,
      heightMm: 0.36,
      depthMm: 0.12,
      xRatio: 0.69517,
      yOffsetMm: -0.12,
      previewX: 536,
      previewY: 887,
      previewImageUrl: '',
    },
  ],
};

const adminRecordRetentionPreview = {
  code: 0,
  retentionDays: 365,
  cutoffAt: '2025-07-02 18:20:00',
  matched: 4,
  deletedRecords: 0,
  deletedDefects: 0,
  deletedCaptureFiles: 0,
  deletedPlates: 0,
  filesPlanned: 8,
  filesDeleted: 0,
  filesMissing: 0,
  bytesPlanned: 4096,
  bytesDeleted: 0,
  cleanupIds: [],
  failures: [],
  dryRun: true,
};

const adminRecordRetentionPurge = {
  code: 0,
  retentionDays: 365,
  cutoffAt: '2025-07-02 18:20:00',
  matched: 4,
  deletedRecords: 4,
  deletedDefects: 12,
  deletedCaptureFiles: 8,
  deletedPlates: 0,
  filesPlanned: 8,
  filesDeleted: 8,
  filesMissing: 0,
  bytesPlanned: 4096,
  bytesDeleted: 4096,
  cleanupIds: ['CLEAN-1', 'CLEAN-2', 'CLEAN-3', 'CLEAN-4'],
  failures: [],
  dryRun: false,
};

const adminConfigRevisions = [
  {
    id: 'CFG-1',
    key: 'capture',
    actor: 'admin',
    action: 'save',
    bytes: 96,
    createdAt: '1782879112730',
  },
  {
    id: 'CFG-2',
    key: 'connection',
    actor: 'admin',
    action: 'restore',
    bytes: 48,
    createdAt: '1782879012730',
  },
  {
    id: 'CFG-3',
    key: 'inspection_settings',
    actor: 'admin',
    action: 'save',
    bytes: 160,
    createdAt: '1782879010000',
  },
  {
    id: 'CFG-4',
    key: 'alarm_rules',
    actor: 'admin',
    action: 'save',
    bytes: 196,
    createdAt: '1782879000000',
  },
  {
    id: 'CFG-5',
    key: 'security_policy',
    actor: 'admin',
    action: 'save',
    bytes: 146,
    createdAt: '1782878990000',
  },
];

const securityPolicyRevisionValue = {
  auditRetentionDays: 120,
  login: {
    maxFailures: 4,
    failureWindowMinutes: 15,
    lockoutMinutes: 6,
  },
  session: {
    ttlHours: 10,
  },
};

const adminCameras = [
  {
    id: 'CAM-01',
    name: '1 号采集相机',
    ip: '192.168.101.100',
    driverId: 'lvm-nvt',
    modelHint: 'LVM3450CA',
    role: '主采集相机',
    enabled: true,
    triggerMode: '软件触发',
    exposureUs: 850,
    gain: 1,
    depthLines: 1280,
    outputPath: 'captures/CAM-01',
  },
];

const adminDefectTypes = [
  { id: 'pit', label: '凹坑', color: '#2f6bff', shape: 'circle' },
  { id: 'scratch', label: '划伤', color: '#24a647', shape: 'rect' },
];

const adminInspectionSettings = {
  severeDepthMm: 0.12,
  reviewDepthMm: 0.08,
  minDefectWidthMm: 0.2,
  cameraExposureUs: 850,
  encoderPulsePerMeter: 2048,
  autoReview: true,
  alarmVolume: 86,
  saveRawImages: true,
  source: 'database',
};

const adminAlarmRules = {
  enabled: true,
  severeDefectThreshold: 1,
  reviewDefectThreshold: 3,
  cameraOffline: true,
  receiverPortFailure: true,
  plcOffline: true,
  l2Offline: true,
  notifySound: true,
  notifyBanner: true,
  retainMinutes: 60,
  source: 'database',
};

const adminExternalIntegrations = {
  plc: {
    enabled: true,
    protocol: 'modbus-tcp',
    host: '127.0.0.1',
    port: 1502,
    path: '/plc/status',
    timeoutMs: 1000,
    retryIntervalMs: 3000,
  },
  l2: {
    enabled: true,
    protocol: 'http-json',
    host: '127.0.0.1',
    port: 8082,
    path: '/api/l2/status',
    timeoutMs: 1500,
    retryIntervalMs: 5000,
  },
  mes: {
    enabled: false,
    protocol: 'http-json',
    host: '127.0.0.1',
    port: 8088,
    path: '/api/mes/report',
    timeoutMs: 2000,
    retryIntervalMs: 10000,
  },
  source: 'database',
};

const adminServices = {
  updatedAt: '1782879112730',
  api: {
    name: 'steel-inspection-service',
    role: 'api-config-capture-orchestrator',
    language: 'rust',
    running: true,
    port: 4873,
    uptimeMs: 125000,
    activeSessions: 1,
    database: {
      engine: 'sqlite',
      path: '/tmp/steel-inspection.sqlite',
      bytes: 94208,
      configDir: '/tmp',
    },
  },
  capture: {
    name: 'capture-service',
    managed: true,
    running: false,
    port: 4317,
    origin: 'http://127.0.0.1:4317',
    processAvailable: true,
    executable: '/tmp/steel_capture_service.exe',
    fallback: 'simulated-eight-camera',
    lifecycle: {
      phase: 'starting',
      desiredRunning: true,
      autostart: true,
      pid: 43210,
      restartCount: 2,
      consecutiveFailures: 1,
      restartBudget: 5,
      restartBudgetExhausted: false,
    },
  },
  diagnostics: [
    { id: 'api', label: 'API 服务', status: 'normal', detail: '运行 125000ms，在线会话 1 个' },
    { id: 'database', label: 'SQLite 数据库', status: 'normal', detail: '94208 bytes / /tmp/steel-inspection.sqlite' },
    { id: 'config', label: '配置目录', status: 'normal', detail: '/tmp' },
    { id: 'capture', label: '采集服务连通性', status: 'warning', detail: 'http://127.0.0.1:4317' },
  ],
};

const adminRuntimeLogStatus = {
  schema: 'steel.runtime-log-status.v1',
  updatedAt: '1782879116000',
  status: 'running',
  runtime: {
    stateRoot: 'target/run/tauri-dev',
    logRoot: 'target/run/tauri-dev/logs',
    supervisor: { status: 'running', updatedAt: '1782879115000', restartBudgetExhausted: false },
  },
  resultStore: {
    root: 'target/run/tauri-dev/processing/result-data',
    catalogPath: 'target/run/tauri-dev/processing/result-data/catalog.db',
    ready: true,
    bytes: 4096,
  },
  services: [
    { id: 'inspection', name: '业务服务', origin: 'http://127.0.0.1:4873', port: 4873, ok: true, required: true, status: 'running' },
    { id: 'image', name: 'Rust 图像服务', origin: 'http://127.0.0.1:4874', port: 4874, ok: true, required: true, status: 'running' },
    { id: 'image-worker', name: '图像 Worker', origin: 'http://127.0.0.1:4875', port: 4875, ok: true, required: true, status: 'running' },
    { id: 'defect-worker', name: '缺陷 Worker', origin: 'http://127.0.0.1:4876', port: 4876, ok: true, required: true, status: 'running' },
    { id: 'capture', name: '采集服务', origin: 'http://127.0.0.1:4317', port: 4317, ok: false, required: false, status: 'unavailable', reason: 'unreachable' },
  ],
  logs: [
    { name: 'image-worker.out.log', bytes: 128, modifiedAt: '1782879115000', tail: 'image results completed: 3 records' },
    { name: 'supervisor.log', bytes: 256, modifiedAt: '1782879115000', tail: 'runtime supervisor running' },
  ],
};

const adminDiagnostics = {
  code: 0,
  checkedAt: '1782879115000',
  status: 'warning',
  summary: {
    normal: 7,
    warning: 2,
    error: 0,
  },
  checks: [
    {
      id: 'api',
      group: 'service',
      label: 'API 服务',
      status: 'normal',
      detail: '端口 4873，运行 2m 5s，在线会话 1 个',
      recommendation: '保持本机服务常驻运行',
    },
    {
      id: 'database-integrity',
      group: 'database',
      label: '数据库完整性',
      status: 'normal',
      detail: 'ok',
      recommendation: '完整性检查通过',
    },
    {
      id: 'capture-service',
      group: 'capture',
      label: '采集服务',
      status: 'warning',
      detail: '未找到采集服务可执行文件，当前使用模拟回退：http://127.0.0.1:4317',
      recommendation: '构建 C++ 采集服务或配置 STEEL_CAPTURE_SERVICE_EXE',
    },
  ],
};

const adminDatabaseIntegrity = {
  code: 0,
  status: 'ok',
  messages: ['ok'],
  stats: {
    pageCount: 24,
    pageSize: 4096,
    freelistCount: 2,
    bytes: 94208,
  },
  checkedAt: '1782879113000',
};

const adminDatabaseMaintenance = {
  code: 0,
  action: 'vacuum-analyze',
  integrity: {
    status: 'ok',
    messages: ['ok'],
  },
  before: {
    pageCount: 24,
    pageSize: 4096,
    freelistCount: 2,
    bytes: 94208,
  },
  after: {
    pageCount: 23,
    pageSize: 4096,
    freelistCount: 0,
    bytes: 92160,
  },
  reclaimedBytes: 2048,
  checkedAt: '1782879114000',
};

const adminSecurityPolicy = {
  auditRetentionDays: 180,
  limits: {
    minAuditRetentionDays: 1,
    maxAuditRetentionDays: 3650,
    minLoginMaxFailures: 1,
    maxLoginMaxFailures: 20,
    minLoginWindowMinutes: 1,
    maxLoginWindowMinutes: 1440,
    minLoginLockoutMinutes: 1,
    maxLoginLockoutMinutes: 1440,
    minSessionTtlHours: 1,
    maxSessionTtlHours: 168,
  },
  login: {
    maxFailures: 5,
    failureWindowMinutes: 10,
    lockoutMinutes: 5,
  },
  session: {
    ttlHours: 8,
  },
  source: 'database',
};

const adminPermissions = [
  { id: 'admin.overview', label: '总览', group: '基础', description: '查看后台总览、数据库概览和接口清单' },
  { id: 'admin.services', label: '服务管理', group: '运维', description: '查看服务状态、运行诊断并重启采集服务' },
  { id: 'admin.users', label: '账号管理', group: '安全', description: '创建、编辑和删除后台账号' },
  { id: 'admin.roles', label: '角色权限', group: '安全', description: '维护角色和权限授权目录' },
  { id: 'admin.config', label: '系统配置', group: '配置', description: '保存连接、采集配置并恢复配置版本' },
  { id: 'admin.cameras', label: '相机配置', group: '配置', description: '维护采集相机、驱动和触发参数' },
  { id: 'admin.records', label: '检测记录', group: '数据', description: '查询和导出检测记录' },
  { id: 'admin.audit', label: '审计日志', group: '审计', description: '查询和导出后台审计日志' },
];

const adminLoginSessions = [
  {
    id: 'ses-current',
    userId: 'admin',
    displayName: '系统管理员',
    role: 'administrator',
    current: true,
    userAgent: 'Codex Browser',
    createdAt: '1782879112730',
    expiresAt: '1782907912730',
  },
  {
    id: 'ses-other',
    userId: 'admin',
    displayName: '系统管理员',
    role: 'administrator',
    current: false,
    userAgent: 'Chrome Remote',
    createdAt: '1782875512730',
    expiresAt: '1782904312730',
  },
];

const adminRuntimeProfile = {
  schema: 'steel.runtime-profile.admin.v1',
  activeProfile: {
    schema: 'steel.runtime-profile.public.v1',
    profileId: 'bkv-6',
    displayName: 'BKV 六相机离线转换',
    provider: 'bkv',
    dataSource: 'converted-local',
    cameraConnection: 'none',
    cameraCount: 6,
    cameras: Array.from({ length: 6 }, (_, index) => ({
      id: `C${index + 1}`,
      displayOrder: index + 1,
      sourceCameraId: index + 1,
      role: `legacy-${index + 1}`,
    })),
    configHash: 'active-hash',
    capabilities: {
      directCamera: false,
      captureManagement: false,
      reconstruction: false,
      offlineReplay: true,
    },
  },
  savedProfile: {
    schema: 'steel.runtime-profile.v1',
    id: 'bkv-6',
    displayName: 'BKV 六相机离线转换',
    provider: 'bkv',
    dataSource: 'converted-local',
    cameraConnection: 'none',
    cameraCount: 6,
    cameras: Array.from({ length: 6 }, (_, index) => ({
      id: `C${index + 1}`,
      displayOrder: index + 1,
      sourceCameraId: index + 1,
      role: `legacy-${index + 1}`,
      sourceDirectory: `camera-${index + 1}`,
    })),
    storage: {
      sourceRoot: 'tmp/legacy-bkv',
      convertedRoot: 'target/data/bkv-converted',
      catalogPath: 'target/data/bkv-converted/catalog.db',
      converterOrigin: 'http://127.0.0.1:4893',
    },
    capabilities: {
      directCamera: false,
      captureManagement: false,
      reconstruction: false,
      offlineReplay: true,
    },
  },
  activeConfigHash: 'active-hash',
  savedConfigHash: 'active-hash',
  restartRequired: false,
};

const adminBkvImportStatus = {
  schema: 'steel.bkv-import-service.v1',
  ready: true,
  profileId: 'bkv-6',
  cameraCount: 6,
  latestJob: {
    id: 'job-1',
    status: 'completed_with_errors',
    totalRecords: 11,
    convertedRecords: 10,
    skippedRecords: 0,
    quarantinedRecords: 1,
    startedAt: '2026-07-23T10:00:00Z',
    completedAt: '2026-07-23T10:01:00Z',
    failureDetails: [{ error: 'fixture failure' }],
  },
};

describe('ParameterManagementApp', () => {
  const fetchMock = vi.fn();
  const storage = new Map<string, string>();
  let failLoginSessions = false;
  let failDiagnostics = false;
  let forcePasswordChangeLogin = false;
  let defaultAccessRequiresPassword = false;
  let loginFailureResponse: { status: number; payload: Record<string, unknown> } | null = null;
  let saveUserFailureResponse: { status: number; payload: Record<string, unknown> } | null = null;
  let deleteUserFailureResponse: { status: number; payload: Record<string, unknown> } | null = null;
  let deleteRoleFailureResponse: { status: number; payload: Record<string, unknown> } | null = null;
  let connectionConfigFailureResponse: { status: number; payload: Record<string, unknown> } | null = null;
  let captureConfigFailureResponse: { status: number; payload: Record<string, unknown> } | null = null;
  let saveCameraFailureResponse: { status: number; payload: Record<string, unknown> } | null = null;
  let saveRoleFailureResponse: { status: number; payload: Record<string, unknown> } | null = null;
  let sessionPermissionsOverride: string[] | null = null;
  let runtimeProfileValidationFailure = false;
  let failBkvImportStatus = false;
  let managementOnly = false;

  beforeEach(() => {
    vi.restoreAllMocks();
    failLoginSessions = false;
    failDiagnostics = false;
    forcePasswordChangeLogin = false;
    defaultAccessRequiresPassword = false;
    loginFailureResponse = null;
    saveUserFailureResponse = null;
    deleteUserFailureResponse = null;
    deleteRoleFailureResponse = null;
    connectionConfigFailureResponse = null;
    captureConfigFailureResponse = null;
    saveCameraFailureResponse = null;
    saveRoleFailureResponse = null;
    sessionPermissionsOverride = null;
    runtimeProfileValidationFailure = false;
    failBkvImportStatus = false;
    managementOnly = false;
    setAdminOverviewSiteMode('bkv');
    storage.clear();
    storage.set('steel-inspection-admin-session', JSON.stringify(adminSession));
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
        clear: () => storage.clear(),
      },
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:audit-csv'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/admin/auth/me')) {
        const session = sessionPermissionsOverride
          ? { ...adminSession, user: { ...adminSession.user, permissions: sessionPermissionsOverride } }
          : adminSession;
        return {
          ok: true,
          json: async () => forcePasswordChangeLogin
            ? { ...session, user: { ...session.user, mustChangePassword: true } }
            : session,
        };
      }
      if (url.includes('/api/admin/auth/login')) {
        const loginBody = JSON.parse(String(init?.body ?? '{}')) as { defaultAccess?: boolean };
        if (loginBody.defaultAccess && defaultAccessRequiresPassword) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ code: 401, error: 'password_configured' }),
          };
        }
        if (loginFailureResponse) {
          return {
            ok: false,
            status: loginFailureResponse.status,
            json: async () => loginFailureResponse?.payload ?? {},
          };
        }
        return {
          ok: true,
          json: async () => forcePasswordChangeLogin
            ? { ...adminSession, user: { ...adminSession.user, mustChangePassword: true } }
            : adminSession,
        };
      }
      if (url.includes('/api/admin/auth/logout')) {
        return { ok: true, json: async () => ({ code: 0 }) };
      }
      if (url.includes('/api/admin/auth/sessions') && init?.method === 'DELETE') {
        return { ok: true, json: async () => ({ code: 0, revoked: true }) };
      }
      if (url.includes('/api/admin/auth/sessions')) {
        if (failLoginSessions) {
          return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
        }
        return { ok: true, json: async () => ({ sessions: adminLoginSessions }) };
      }
      if (url.includes('/api/admin/auth/password')) {
        return { ok: true, json: async () => ({ code: 0, message: 'password changed' }) };
      }
      if (url.includes('/api/admin/users') && init?.method === 'DELETE') {
        if (deleteUserFailureResponse) {
          return {
            ok: false,
            status: deleteUserFailureResponse.status,
            json: async () => deleteUserFailureResponse?.payload ?? {},
          };
        }
        return { ok: true, json: async () => ({ code: 0, deleted: true }) };
      }
      if (url.includes('/api/admin/roles') && init?.method === 'DELETE') {
        if (deleteRoleFailureResponse) {
          return {
            ok: false,
            status: deleteRoleFailureResponse.status,
            json: async () => deleteRoleFailureResponse?.payload ?? {},
          };
        }
        return { ok: true, json: async () => ({ code: 0, deleted: true }) };
      }
      if (url.includes('/api/admin/cameras') && init?.method === 'DELETE') {
        return { ok: true, json: async () => ({ code: 0, deleted: true }) };
      }
      if (url.includes('/api/admin/database/integrity')) {
        return { ok: true, json: async () => adminDatabaseIntegrity };
      }
      if (url.includes('/api/admin/database/maintenance')) {
        return { ok: true, json: async () => adminDatabaseMaintenance };
      }
      if (url.includes('/api/admin/database/backup')) {
        return {
          ok: true,
          blob: async () => new Blob(['SQLite format 3 backup'], { type: 'application/x-sqlite3' }),
        };
      }
      if (url.includes('/api/config/connection') && init?.method === 'POST' && connectionConfigFailureResponse) {
        return {
          ok: false,
          status: connectionConfigFailureResponse.status,
          json: async () => connectionConfigFailureResponse?.payload ?? {},
        };
      }
      if (url.includes('/api/config/capture') && init?.method === 'POST' && captureConfigFailureResponse) {
        return {
          ok: false,
          status: captureConfigFailureResponse.status,
          json: async () => captureConfigFailureResponse?.payload ?? {},
        };
      }
      if (url.includes('/api/config/connection')) {
        return { ok: true, json: async () => ({ mode: 'online', host: '127.0.0.1', port: 4873 }) };
      }
      if (url.includes('/api/database')) {
        return {
          ok: true,
          json: async () => ({
            engine: 'sqlite',
            requestedEngine: 'sqlite',
            supportedEngines: ['sqlite', 'mysql', 'postgres'],
            fallbackEnabled: false,
            fallbackActive: false,
            fallbackReason: null,
            orm: 'sea-orm',
            path: '/tmp/steel-inspection.sqlite',
            configDir: '/tmp/config',
          }),
        };
      }
      if (url.includes('/api/admin/overview')) {
        return { ok: true, json: async () => adminOverview };
      }
      if (url.includes('/api/admin/diagnostics')) {
        if (failDiagnostics) {
          return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
        }
        return { ok: true, json: async () => adminDiagnostics };
      }
      if (url.includes('/api/admin/runtime/logs')) {
        return { ok: true, json: async () => adminRuntimeLogStatus };
      }
      if (url.includes('/api/admin/services/capture/start')) {
        return { ok: true, json: async () => ({ code: 0, action: 'start', success: true, running: true, started: true, services: { ...adminServices, capture: { ...adminServices.capture, running: true } } }) };
      }
      if (url.includes('/api/admin/services/capture/stop')) {
        return { ok: true, json: async () => ({ code: 0, action: 'stop', success: true, running: false, stopped: true, services: { ...adminServices, capture: { ...adminServices.capture, running: false } } }) };
      }
      if (url.includes('/api/admin/services/capture/restart')) {
        return { ok: true, json: async () => ({ code: 0, action: 'restart', success: true, running: true, restarted: true, services: { ...adminServices, capture: { ...adminServices.capture, running: true } } }) };
      }
      if (url.includes('/api/admin/services')) {
        return {
          ok: true,
          json: async () => managementOnly
            ? {
                ...adminServices,
                capture: {
                  ...adminServices.capture,
                  running: false,
                  controlAllowed: false,
                  managementOnly: true,
                  lifecycle: {
                    ...adminServices.capture.lifecycle,
                    phase: 'stopped',
                    desiredRunning: false,
                    autostart: false,
                    pid: null,
                  },
                },
              }
            : adminServices,
        };
      }
      if (url.includes('/api/admin/site-configs/detail')) {
        return {
          ok: true,
          json: async () => ({
            schema: 'steel.site-config-detail.v1',
            site: {
              id: 'bkv-default',
              displayName: 'BKV 六相机现场',
              mode: 'bkv',
              cameraCount: 6,
              active: true,
              pending: false,
              restartRequired: false,
              availability: {
                normal: 4,
                warning: 0,
                error: 0,
                blocking: 0,
                checkedAt: 1,
              },
            },
            document: {
              schema: 'steel.site-config.v1',
              id: 'bkv-default',
              displayName: 'BKV 六相机现场',
              mode: 'bkv',
              runtimeProfile: 'runtime.json',
              connectionConfig: 'connection.json',
              captureConfig: 'capture.json',
            },
            report: {
              siteId: 'bkv-default',
              depth: 'default',
              checkedAt: 1,
              checks: [{
                id: 'site.schema',
                label: '现场配置结构',
                status: 'normal',
                message: '结构正常',
                blocking: false,
              }],
            },
          }),
        };
      }
      if (url.includes('/api/admin/site-configs')) {
        return {
          ok: true,
          json: async () => ({
            schema: 'steel.site-config-list.v1',
            activeSiteId: 'bkv-default',
            pendingSiteId: null,
            restartRequired: false,
            sites: [{
              id: 'bkv-default',
              displayName: 'BKV 六相机现场',
              mode: 'bkv',
              cameraCount: 6,
              active: true,
              pending: false,
              restartRequired: false,
              availability: {
                normal: 4,
                warning: 0,
                error: 0,
                blocking: 0,
                checkedAt: 1,
              },
            }],
          }),
        };
      }
      if (url.includes('/api/admin/runtime-profile/validate')) {
        if (runtimeProfileValidationFailure) {
          return {
            ok: false,
            status: 400,
            json: async () => ({
              code: 400,
              error: 'runtime_profile_invalid',
              detail: 'cameraCount 必须与 cameras 一致',
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            valid: true,
            profileId: 'bkv-6',
            activeConfigHash: 'active-hash',
            savedConfigHash: 'saved-hash',
            restartRequired: true,
          }),
        };
      }
      if (url.includes('/api/admin/runtime-profile') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            saved: true,
            profileId: 'bkv-6',
            activeConfigHash: 'active-hash',
            savedConfigHash: 'saved-hash',
            restartRequired: true,
          }),
        };
      }
      if (url.includes('/api/admin/runtime-profile')) {
        return { ok: true, json: async () => adminRuntimeProfile };
      }
      if (url.includes('/api/admin/bkv-import/jobs/retry')) {
        return {
          ok: true,
          json: async () => ({ job_id: 'job-1', status: 'completed', converted_records: 1 }),
        };
      }
      if (url.includes('/api/admin/bkv-import/jobs') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({ job_id: 'job-2', status: 'completed', converted_records: 11 }),
        };
      }
      if (url.includes('/api/admin/bkv-import/jobs')) {
        if (failBkvImportStatus) {
          return {
            ok: false,
            status: 503,
            json: async () => ({ error: 'bkv_converter_unavailable' }),
          };
        }
        return { ok: true, json: async () => adminBkvImportStatus };
      }
      if (url.includes('/api/admin/security/policy') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return {
          ok: true,
          json: async () => ({
            code: 0,
            policy: { ...adminSecurityPolicy, ...body },
            source: 'database',
            revisionId: 'CFG-SECURITY',
          }),
        };
      }
      if (url.includes('/api/admin/security/policy')) {
        return { ok: true, json: async () => ({ code: 0, policy: adminSecurityPolicy, source: 'database' }) };
      }
      if (url.includes('/api/admin/permissions')) {
        return { ok: true, json: async () => ({ permissions: adminPermissions }) };
      }
      if (url.includes('/api/admin/users') && init?.method === 'POST') {
        if (saveUserFailureResponse) {
          return {
            ok: false,
            status: saveUserFailureResponse.status,
            json: async () => saveUserFailureResponse?.payload ?? {},
          };
        }
        const body = JSON.parse(String(init.body));
        if (body.id === 'admin' && body.role !== 'administrator') {
          return { ok: false, status: 400, json: async () => ({ code: 400, error: 'cannot change current user role' }) };
        }
        return { ok: true, json: async () => ({ user: { ...body, createdAt: '1782879112730' } }) };
      }
      if (url.includes('/api/admin/users')) {
        return { ok: true, json: async () => ({ users: adminOverview.users }) };
      }
      if (url.includes('/api/admin/roles') && init?.method === 'POST') {
        if (saveRoleFailureResponse) {
          return {
            ok: false,
            status: saveRoleFailureResponse.status,
            json: async () => saveRoleFailureResponse?.payload ?? {},
          };
        }
        const body = JSON.parse(String(init.body));
        if (body.id === 'administrator' && !body.permissions.includes('admin.roles')) {
          return { ok: false, status: 400, json: async () => ({ code: 400, error: 'cannot remove current role management permission' }) };
        }
        return { ok: true, json: async () => ({ role: { ...body, updatedAt: '1782879112730' } }) };
      }
      if (url.includes('/api/admin/roles')) {
        return { ok: true, json: async () => ({ roles: adminOverview.roles }) };
      }
      if (url.includes('/api/admin/cameras') && init?.method === 'POST') {
        if (saveCameraFailureResponse) {
          return {
            ok: false,
            status: saveCameraFailureResponse.status,
            json: async () => saveCameraFailureResponse?.payload ?? {},
          };
        }
        const body = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({ camera: body }) };
      }
      if (url.includes('/api/admin/cameras')) {
        return { ok: true, json: async () => ({ cameras: adminCameras }) };
      }
      if (url.includes('/api/admin/defect-types') && init?.method === 'DELETE') {
        return { ok: true, json: async () => ({ code: 0, deleted: true }) };
      }
      if (url.includes('/api/admin/defect-types') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({ code: 0, defectType: body }) };
      }
      if (url.includes('/api/admin/defect-types')) {
        return { ok: true, json: async () => ({ defectTypes: adminDefectTypes }) };
      }
      if (url.includes('/api/admin/inspection-settings') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({ code: 0, settings: { ...body, source: 'database' } }) };
      }
      if (url.includes('/api/admin/inspection-settings')) {
        return { ok: true, json: async () => adminInspectionSettings };
      }
      if (url.includes('/api/admin/alarm-rules') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({ code: 0, rules: { ...body, source: 'database' } }) };
      }
      if (url.includes('/api/admin/alarm-rules')) {
        return { ok: true, json: async () => adminAlarmRules };
      }
      if (url.includes('/api/admin/external-integrations') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return { ok: true, json: async () => ({ code: 0, integrations: { ...body, source: 'database' } }) };
      }
      if (url.includes('/api/admin/external-integrations')) {
        return { ok: true, json: async () => adminExternalIntegrations };
      }
      if (url.includes('/api/admin/config/revisions/detail')) {
        const id = new URL(url).searchParams.get('id');
        const revision = adminConfigRevisions.find((item) => item.id === id) ?? adminConfigRevisions[0];
        return {
          ok: true,
          json: async () => ({
            revision: {
              ...revision,
              value: revision.key === 'security_policy'
                ? securityPolicyRevisionValue
                : {
                    service: { name: 'steel-inspection-service' },
                    capture: { mode: 'batch-camera', driver: 'lvm-nvt' },
                  },
            },
          }),
        };
      }
      if (url.includes('/api/admin/config/revisions/restore')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { id?: string };
        const revision = adminConfigRevisions.find((item) => item.id === body.id) ?? adminConfigRevisions[0];
        const value = revision.key === 'security_policy'
          ? securityPolicyRevisionValue
          : {
              service: { name: 'steel-inspection-service' },
              capture: { mode: 'single-camera' },
            };
        return {
          ok: true,
          json: async () => ({
            code: 0,
            message: 'config revision restored',
            sourceRevision: revision,
            revision: { ...revision, id: 'CFG-RESTORE', action: 'restore' },
            config: {
              key: revision.key,
              value,
            },
          }),
        };
      }
      if (url.includes('/api/admin/config/revisions')) {
        return { ok: true, json: async () => ({ revisions: adminConfigRevisions }) };
      }
      if (url.includes('/api/admin/audit/export')) {
        return {
          ok: true,
          text: async () => '时间,级别,账号,动作,对象,内容\n1782879112730,info,admin,audit.export,audit_log,导出审计日志 2 条\n',
        };
      }
      if (url.includes('/api/admin/audit/retention')) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            retentionDays: 90,
            cutoffAt: '1775103112730',
            matched: 5,
            deleted: 0,
            dryRun: true,
          }),
        };
      }
      if (url.includes('/api/admin/audit')) {
        const parsed = new URL(url);
        const limit = Number(parsed.searchParams.get('limit') ?? 8);
        const offset = Number(parsed.searchParams.get('offset') ?? 0);
        return {
          ok: true,
          json: async () => ({
            auditLogs: adminOverview.auditLogs,
            total: 18,
            limit,
            offset,
          }),
        };
      }
      if (url.includes('/api/admin/records/export')) {
        return {
          ok: true,
          text: async () => '记录号,检测时间,管号,钢种,规格,状态,缺陷总数,严重,待复核,轻微\nR-001,19:00,202606131900,Q355B,3500 x 12000 x 12mm,检测中,12,4,3,5\n',
        };
      }
      if (url.includes('/api/admin/records/retention')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { dryRun?: boolean };
        return {
          ok: true,
          json: async () => (body.dryRun === false ? adminRecordRetentionPurge : adminRecordRetentionPreview),
        };
      }
      if (url.includes('/api/admin/records/detail')) {
        return { ok: true, json: async () => ({ record: adminRecordDetail }) };
      }
      if (url.includes('/api/admin/records') && init?.method === 'DELETE') {
        return { ok: true, json: async () => ({
          code: 0,
          deleted: true,
          cleanupId: 'CLEAN-1',
          recordId: 'R-001',
          materialId: '202606131900',
          filesPlanned: 4,
          filesDeleted: 4,
          filesMissing: 0,
          bytesPlanned: 4096,
          bytesDeleted: 4096,
          defectsDeleted: 12,
          captureFilesDeleted: 2,
          plateDeleted: false,
        }) };
      }
      if (url.includes('/api/admin/records')) {
        return { ok: true, json: async () => adminRecordPage };
      }
      if (url.includes('/api/config')) {
        return {
          ok: true,
          json: async () => ({
            service: { name: 'steel-inspection-service' },
            capture: { mode: 'single-camera' },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  it('renders backend overview and switches to config and audit management sections', async () => {
    setAdminOverviewSiteMode('direct-camera');
    const { container } = render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    expect(screen.getByText('工艺工程师')).toBeInTheDocument();
    expect(screen.getByText('钢管档案')).toBeInTheDocument();
    expect(screen.getByText('缺陷明细')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '系统自检' })).toBeInTheDocument();
    expect(screen.getByText('总体状态')).toBeInTheDocument();
    expect(screen.getByText('已完成 3 项后台自检')).toBeInTheDocument();
    expect(screen.getByText('数据库完整性')).toBeInTheDocument();
    expect(screen.getByText('sqlite / mysql / postgres')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/admin/diagnostics',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    const requestedPaths = fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(requestedPaths).toContain('/api/config/capture');
    expect(requestedPaths).not.toContain('/api/config');

    fireEvent.click(screen.getByRole('button', { name: /重新自检/ }));
    await waitFor(() => {
      expect(screen.getByText('系统自检完成：关注')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /备份数据库/ }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/database/backup',
        expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/x-sqlite3' }) }),
      );
    });
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    expect(await screen.findByText('数据库备份已下载')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /完整性检查/ }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/database/integrity',
        expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
      );
    });
    expect(await screen.findByText('数据库完整性正常')).toBeInTheDocument();
    expect(screen.getByText('空闲页')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /压缩整理/ }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/database/maintenance',
        expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Accept: 'application/json' }) }),
      );
    });
    expect(await screen.findByText('数据库维护完成，释放 2.0 KB')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    expect(screen.getByText('1 号采集相机')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '采集管理' }));
    expect(screen.getByText('采集配置 JSON')).toBeInTheDocument();
    expect(container.querySelectorAll('.json-code-editor')).toHaveLength(1);
    expect(container.querySelectorAll('.json-code-gutter')).toHaveLength(1);
    expect(container.querySelectorAll('.json-token-key').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.json-token-string').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.json-token-punctuation').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.json-token-punctuation').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'PLC 通讯' }));
    expect(screen.getByText('连接配置 JSON')).toBeInTheDocument();
    expect(container.querySelectorAll('.json-code-editor')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '检测算法' }));
    expect(screen.getByRole('heading', { name: '检测规则' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('后台严重深度阈值'), { target: { value: '0.16' } });
    fireEvent.click(screen.getByRole('button', { name: /保存规则/ }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/inspection-settings',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"severeDepthMm":0.16'),
        }),
      );
    });
    expect(await screen.findByText('检测规则已保存')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '配置版本' }));
    expect(screen.getByRole('heading', { name: '配置版本' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '审计' }));
    expect(screen.getByText('服务启动并完成 SQLite/SeaORM 初始化')).toBeInTheDocument();
    expect(screen.getByText('共 18 条 / 第 1 页')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/audit?limit=8&offset=8',
        expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
      );
    });
    expect(screen.getByText('2', { selector: '.admin-api-summary strong' })).toBeInTheDocument();
    expect(screen.getByText('个后台接口已纳入管理概览')).toBeInTheDocument();
  });

  it('loads split runtime status and bounded service logs in the runtime log tab', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '运行日志' }));

    expect(await screen.findByText('运行正常')).toBeInTheDocument();
    expect(screen.getByText('统一结果库')).toBeInTheDocument();
    expect(screen.getByText('已就绪')).toBeInTheDocument();
    expect(screen.getByText('Rust 图像服务')).toBeInTheDocument();
    expect(screen.getByText('image results completed: 3 records')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/admin/runtime/logs',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
  });

  it('saves alarm rules through the backend rule management tab', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '规则' }));
    expect(screen.getByRole('heading', { name: '告警规则' })).toBeInTheDocument();
    expect(screen.getByText('规则摘要')).toBeInTheDocument();
    expect(screen.getByText('1 个触发')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('后台严重缺陷告警数'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('后台待复核缺陷告警数'), { target: { value: '4' } });
    fireEvent.click(screen.getByLabelText('后台PLC异常告警'));
    fireEvent.click(screen.getByRole('button', { name: /保存告警/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/alarm-rules',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"severeDefectThreshold":2'),
        }),
      );
    });
    const alarmSaveCall = fetchMock.mock.calls.find(([url, init]) => String(url).includes('/api/admin/alarm-rules') && init?.method === 'POST');
    expect(String(alarmSaveCall?.[1]?.body)).toContain('"reviewDefectThreshold":4');
    expect(String(alarmSaveCall?.[1]?.body)).toContain('"plcOffline":false');
    expect(await screen.findByText('告警规则已保存')).toBeInTheDocument();
  });

  it('saves external integration endpoints through the backend rule management tab', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '规则' }));
    expect(screen.getByRole('heading', { name: '外部系统接口' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('后台PLC接口主机'), { target: { value: '192.168.20.10' } });
    fireEvent.change(screen.getByLabelText('后台PLC接口端口'), { target: { value: '502' } });
    fireEvent.change(screen.getByLabelText('后台PLC接口路径'), { target: { value: '/plc/line-1/status' } });
    fireEvent.change(screen.getByLabelText('后台PLC接口超时'), { target: { value: '1800' } });
    fireEvent.click(screen.getByRole('button', { name: /保存接口/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/external-integrations',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"host":"192.168.20.10"'),
        }),
      );
    });
    const integrationSaveCall = fetchMock.mock.calls.find(([url, init]) => String(url).includes('/api/admin/external-integrations') && init?.method === 'POST');
    expect(String(integrationSaveCall?.[1]?.body)).toContain('"port":502');
    expect(String(integrationSaveCall?.[1]?.body)).toContain('"path":"/plc/line-1/status"');
    expect(String(integrationSaveCall?.[1]?.body)).toContain('"timeoutMs":1800');
    expect(await screen.findByText('外部系统接口已保存')).toBeInTheDocument();
  });

  it('exports filtered audit logs as CSV from the audit tab', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '审计' }));
    fireEvent.change(screen.getByPlaceholderText('账号、动作、目标或内容'), { target: { value: 'config' } });
    fireEvent.change(screen.getByLabelText('等级'), { target: { value: 'warning' } });
    fireEvent.click(screen.getByRole('button', { name: /导出 CSV/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/audit/export?keyword=config&level=warning',
        expect.objectContaining({ headers: expect.objectContaining({ Accept: 'text/csv' }) }),
      );
    });
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audit-csv');
    expect(await screen.findByText('审计日志 CSV 已导出')).toBeInTheDocument();
  });

  it('previews audit log retention cleanup from the audit tab', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '审计' }));
    fireEvent.change(screen.getByLabelText('保留天数'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: /预览清理/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/audit/retention',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ retentionDays: 90, dryRun: true }),
          headers: expect.objectContaining({ Accept: 'application/json' }),
        }),
      );
    });
    expect(await screen.findByText('审计日志清理预览：5 条将被清理')).toBeInTheDocument();
    expect(screen.getByText('条旧审计日志可清理')).toBeInTheDocument();
  });

  it('keeps JSON config syntax highlighting when optional login sessions are unavailable', async () => {
    failLoginSessions = true;
    setAdminOverviewSiteMode('direct-camera');
    const { container } = render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    fireEvent.click(screen.getByRole('button', { name: '采集管理' }));

    await waitFor(() => {
      expect((screen.getByLabelText('采集配置 JSON') as HTMLTextAreaElement).value).toContain('"service"');
    });
    expect(screen.queryByText('登录会话接口异常：404')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.json-code-editor')).toHaveLength(1);
    expect(container.querySelectorAll('.json-code-input')).toHaveLength(1);
    expect(container.querySelectorAll('.json-token-key').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.json-token-string').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.json-token-punctuation').length).toBeGreaterThan(0);
  });

  it('keeps JSON config syntax highlighting when diagnostics are unavailable', async () => {
    failDiagnostics = true;
    setAdminOverviewSiteMode('direct-camera');
    const { container } = render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    fireEvent.click(screen.getByRole('button', { name: '采集管理' }));

    await waitFor(() => {
      expect((screen.getByLabelText('采集配置 JSON') as HTMLTextAreaElement).value).toContain('"service"');
    });
    expect(screen.getByText('参数已同步')).toBeInTheDocument();
    expect(container.querySelectorAll('.json-code-editor')).toHaveLength(1);
    expect(container.querySelectorAll('.json-token-key').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.json-token-string').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.json-token-punctuation').length).toBeGreaterThan(0);
  });

  it('shows backend schema validation details when capture JSON save is rejected', async () => {
    setAdminOverviewSiteMode('direct-camera');
    captureConfigFailureResponse = {
      status: 400,
      payload: {
        code: 400,
        error: 'invalid capture config',
        message: 'capture.cameras 至少需要 1 个相机',
      },
    };
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    fireEvent.click(screen.getByRole('button', { name: '采集管理' }));
    fireEvent.change(screen.getByLabelText('采集配置 JSON'), {
      target: {
        value: JSON.stringify({
          capture: {
            mode: 'single-camera',
            driver: 'lvm-nvt',
            fallback: 'simulated',
            cameras: [],
          },
        }, null, 2),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存采集/ }));

    expect(await screen.findByText('采集参数保存失败：capture.cameras 至少需要 1 个相机')).toBeInTheDocument();
  });

  it('keeps the last valid local connection config when backend rejects an online save', async () => {
    connectionConfigFailureResponse = {
      status: 400,
      payload: {
        code: 400,
        error: 'invalid connection config',
        message: 'connection.port 必须在 1..65535 范围内',
      },
    };
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    fireEvent.click(screen.getByRole('button', { name: '数据源' }));
    const connectionEditor = screen.getByLabelText('连接配置 JSON') as HTMLTextAreaElement;
    await waitFor(() => {
      expect(connectionEditor.value).toContain('"port": 4873');
    });
    fireEvent.change(connectionEditor, {
      target: {
        value: JSON.stringify({ mode: 'online', host: '127.0.0.1', port: 4874 }, null, 2),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存连接/ }));

    expect(await screen.findByText('连接设置保存失败：connection.port 必须在 1..65535 范围内')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4874/api/config/connection',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(storage.get('steel-inspection-connection-config') ?? '{}')).toMatchObject({
      mode: 'online',
      host: '127.0.0.1',
      port: 4873,
    });
  });

  it('saves admin user edits through the backend management API', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    fireEvent.change(screen.getByLabelText('账号 ID'), { target: { value: 'supervisor' } });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '检测主管' } });
    fireEvent.change(screen.getByLabelText('角色'), { target: { value: 'engineer' } });
    fireEvent.change(screen.getByLabelText('重置密码'), { target: { value: 'supervisor123' } });
    fireEvent.click(screen.getByRole('button', { name: /保存账号/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/users',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            id: 'supervisor',
            displayName: '检测主管',
            role: 'engineer',
            status: 'active',
            lastLoginAt: '未登录',
            password: 'supervisor123',
          }),
        }),
      );
    });
  });

  it('requires a compliant initial password when creating a backend user', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    fireEvent.change(screen.getByLabelText('账号 ID'), { target: { value: 'weak-user' } });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '弱密码账号' } });
    fireEvent.click(screen.getByRole('button', { name: /保存账号/ }));

    expect(await screen.findByText('新建账号需要设置初始密码')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/admin/users',
      expect.objectContaining({ method: 'POST' }),
    );

    fireEvent.change(screen.getByLabelText('重置密码'), { target: { value: '12345678' } });
    fireEvent.click(screen.getByRole('button', { name: /保存账号/ }));

    expect(await screen.findByText('密码至少 8 位且需同时包含字母和数字')).toBeInTheDocument();
  });

  it('shows backend protection when saving would change the current administrator role', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    fireEvent.click(screen.getByText('系统管理员'));
    fireEvent.change(screen.getByLabelText('角色'), { target: { value: 'engineer' } });
    fireEvent.click(screen.getByRole('button', { name: /保存账号/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/users',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(await screen.findByText('后台账号保存失败：不能修改当前登录账号的角色')).toBeInTheDocument();
  });

  it('shows backend admin user identity validation details', async () => {
    saveUserFailureResponse = {
      status: 400,
      payload: {
        code: 400,
        error: 'invalid admin user id',
        message: 'adminUser.id 只能包含字母、数字、下划线、中划线或点',
      },
    };
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    fireEvent.change(screen.getByLabelText('账号 ID'), { target: { value: 'bad user' } });
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '异常账号' } });
    fireEvent.change(screen.getByLabelText('重置密码'), { target: { value: 'user1234' } });
    fireEvent.click(screen.getByRole('button', { name: /保存账号/ }));

    expect(await screen.findByText('后台账号保存失败：adminUser.id 只能包含字母、数字、下划线、中划线或点')).toBeInTheDocument();
  });

  it('deletes managed users, roles, and cameras through protected backend APIs', async () => {
    setAdminOverviewSiteMode('direct-camera');
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    fireEvent.click(screen.getByText('工艺工程师'));
    fireEvent.click(screen.getByRole('button', { name: /删除账号/ }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/users?id=engineer',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(await screen.findByText('后台账号已删除')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    fireEvent.click(screen.getByText('1 号采集相机'));
    fireEvent.click(screen.getByRole('button', { name: /删除相机/ }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/cameras?id=CAM-01',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(await screen.findByText('相机配置已删除')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    fireEvent.click(screen.getByText('工程师'));
    fireEvent.click(screen.getByRole('button', { name: /删除角色/ }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/roles?id=engineer',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(await screen.findByText('角色权限已删除')).toBeInTheDocument();
  });

  it('shows backend protection details when deleting the current admin user', async () => {
    deleteUserFailureResponse = {
      status: 400,
      payload: { code: 400, error: 'cannot delete current user' },
    };
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    fireEvent.click(screen.getByText('系统管理员'));
    fireEvent.click(screen.getByRole('button', { name: /删除账号/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/users?id=admin',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(await screen.findByText('后台账号删除失败：不能删除当前登录账号')).toBeInTheDocument();
  });

  it('shows backend protection details when deleting a role that is still assigned', async () => {
    deleteRoleFailureResponse = {
      status: 409,
      payload: { code: 409, error: 'role is still assigned to users' },
    };
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    fireEvent.click(screen.getByText('工程师'));
    fireEvent.click(screen.getByRole('button', { name: /删除角色/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/roles?id=engineer',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(await screen.findByText('角色权限删除失败：该角色仍分配给账号')).toBeInTheDocument();
  });

  it('saves role permissions through the backend management API', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    expect(screen.getByText('角色列表')).toBeInTheDocument();
    expect(screen.getByText('安全 / 维护角色和权限授权目录')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/admin/permissions',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
    );
    fireEvent.change(screen.getByLabelText('角色 ID'), { target: { value: 'reviewer' } });
    fireEvent.change(screen.getByLabelText('角色名称'), { target: { value: '复核员' } });
    fireEvent.change(screen.getByLabelText('说明'), { target: { value: '负责缺陷复核' } });
    fireEvent.click(screen.getByLabelText('审计日志'));
    fireEvent.click(screen.getByRole('button', { name: /保存角色/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/roles',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            id: 'reviewer',
            label: '复核员',
            description: '负责缺陷复核',
            permissions: ['admin.overview', 'admin.audit'],
            status: 'active',
          }),
        }),
      );
    });
  });

  it('shows backend protection when saving the current role would remove role management permission', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    fireEvent.click(screen.getByText('administrator / 启用'));
    fireEvent.click(screen.getByLabelText('角色权限'));
    fireEvent.click(screen.getByRole('button', { name: /保存角色/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/roles',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(await screen.findByText('角色权限保存失败：不能移除当前角色的角色权限管理权限')).toBeInTheDocument();
  });

  it('shows backend role permission schema validation details', async () => {
    saveRoleFailureResponse = {
      status: 400,
      payload: {
        code: 400,
        error: 'invalid role permission',
        message: 'role.permissions 必须是数组',
      },
    };
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    fireEvent.change(screen.getByLabelText('角色 ID'), { target: { value: 'reviewer' } });
    fireEvent.change(screen.getByLabelText('角色名称'), { target: { value: '复核员' } });
    fireEvent.click(screen.getByRole('button', { name: /保存角色/ }));

    expect(await screen.findByText('角色权限保存失败：role.permissions 必须是数组')).toBeInTheDocument();
  });

  it('shows backend role identity validation details', async () => {
    saveRoleFailureResponse = {
      status: 400,
      payload: {
        code: 400,
        error: 'invalid role id',
        message: 'role.id 必须以字母或数字开头',
      },
    };
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '权限' }));
    fireEvent.change(screen.getByLabelText('角色 ID'), { target: { value: '-reviewer' } });
    fireEvent.change(screen.getByLabelText('角色名称'), { target: { value: '复核员' } });
    fireEvent.click(screen.getByRole('button', { name: /保存角色/ }));

    expect(await screen.findByText('角色权限保存失败：role.id 必须以字母或数字开头')).toBeInTheDocument();
  });

  it('queries inspection records from the backend data management tab', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '数据' }));
    expect(screen.getByText('202606131900')).toBeInTheDocument();
    expect(screen.getByText('Q355B')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('管号 / 记录号'), { target: { value: '202606131900' } });
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'detecting' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/records?keyword=202606131900&status=detecting&limit=8',
        expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: /导出 CSV/ }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/records/export?keyword=202606131900&status=detecting',
        expect.objectContaining({ headers: expect.objectContaining({ Accept: 'text/csv' }) }),
      );
    });
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:audit-csv');
    expect(await screen.findByText('检测记录 CSV 已导出')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('检测记录保留天数'), { target: { value: '365' } });
    fireEvent.click(screen.getByRole('button', { name: /预览清理/ }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/records/retention',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ retentionDays: 365, dryRun: true }),
        }),
      );
    });
    expect(await screen.findByText('检测记录清理预览：4 条，计划清理 8 个文件')).toBeInTheDocument();
    expect(screen.getByText('条旧检测记录可清理，计划物理文件 8 个')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /执行清理/ }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/records/retention',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ retentionDays: 365, dryRun: false }),
        }),
      );
    });
    expect(await screen.findByText('检测记录清理完成：4/4 条记录，物理文件 8 个，失败 0 条')).toBeInTheDocument();
    expect(screen.getByText('条检测记录已清理，物理文件 8/8 个，缺失 0 个，失败 0 条；生产会话保留')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '查看' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/records/detail?id=R-001',
        expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
      );
    });
    expect(await screen.findByText('检测记录详情已加载：R-001')).toBeInTheDocument();
    expect(screen.getByText('D-001')).toBeInTheDocument();
    expect(screen.getAllByText('凹坑').length).toBeGreaterThan(0);
    expect(screen.getByText('0.42 x 0.36')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/records?id=R-001',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(await screen.findByText('检测记录已删除：物理文件 4/4 个，缺失 0 个')).toBeInTheDocument();
  });

  it('manages defect type catalog from the backend data tab', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '数据' }));
    expect(screen.getByText('缺陷类型维护')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /凹坑/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /划伤/ }));
    expect(screen.getByLabelText('缺陷类型 ID')).toHaveValue('scratch');
    fireEvent.change(screen.getByLabelText('缺陷类型 ID'), { target: { value: 'dent' } });
    fireEvent.change(screen.getByLabelText('缺陷类型名称'), { target: { value: '压痕' } });
    fireEvent.change(screen.getByLabelText('缺陷类型颜色'), { target: { value: '#ff3355' } });
    fireEvent.change(screen.getByLabelText('缺陷类型形状'), { target: { value: 'diamond' } });
    fireEvent.click(screen.getByRole('button', { name: /保存类型/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/defect-types',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ id: 'dent', label: '压痕', color: '#ff3355', shape: 'diamond' }),
        }),
      );
    });
    expect(await screen.findByText('缺陷类型已保存')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /删除类型/ }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/defect-types?id=dent',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(await screen.findByText('缺陷类型已删除')).toBeInTheDocument();
  });

  it('shows service operations and controls the capture service', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '服务' }));
    expect(screen.getByRole('heading', { name: 'API 服务' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '采集服务' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '运行诊断' })).toBeInTheDocument();
    expect(screen.getByText('2分 5秒')).toBeInTheDocument();
    expect(screen.getByText('92.0 KB')).toBeInTheDocument();
    expect(screen.getAllByText('API 服务')).toHaveLength(2);
    expect(screen.getByText('SQLite 数据库')).toBeInTheDocument();
    expect(screen.getByText('采集服务连通性')).toBeInTheDocument();
    expect(screen.getByText('/tmp/steel_capture_service.exe')).toBeInTheDocument();
    expect(screen.getByText('启动中')).toBeInTheDocument();
    expect(screen.getByText('PID 43210')).toBeInTheDocument();
    expect(screen.getByText('Rust 服务子进程')).toBeInTheDocument();
    expect(screen.getByText('2 次 · 剩余 4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /启动采集服务/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/services/capture/start',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(await screen.findByText('采集服务已启动')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /停止采集服务/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/services/capture/stop',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(await screen.findByText('采集服务已停止')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /重启采集服务/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/services/capture/restart',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(await screen.findByText('采集服务已重启')).toBeInTheDocument();
  });

  it('keeps capture controls locked in standalone background-management mode', async () => {
    managementOnly = true;
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '服务' }));

    expect(screen.getByText('独立后台管理（采集锁定）')).toBeInTheDocument();
    expect(screen.getByText('当前入口只运行后台管理与业务 API，不会启动采集；采集服务控制已锁定。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /启动采集服务/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /停止采集服务/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /重启采集服务/ })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/services/capture/'),
      expect.anything(),
    );
  });

  it('opens the backend directly with default access when no password was configured', async () => {
    storage.clear();
    render(<ParameterManagementApp />);

    expect(await screen.findByText('钢管档案')).toBeInTheDocument();
    expect(screen.queryByText('后台登录')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/admin/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ userId: 'admin', defaultAccess: true }),
      }),
    );
  });

  it('shows login form and authenticates when an admin password is configured', async () => {
    storage.clear();
    defaultAccessRequiresPassword = true;
    render(<ParameterManagementApp />);

    expect(await screen.findByText('后台登录')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('登录账号'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'admin123' } });
    fireEvent.click(screen.getByRole('button', { name: /登录/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/auth/login',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ userId: 'admin', password: 'admin123' }),
        }),
      );
    });
    expect(await screen.findByText('钢管档案')).toBeInTheDocument();
  });

  it('shows backend lockout message when login attempts are temporarily blocked', async () => {
    storage.clear();
    loginFailureResponse = {
      status: 423,
      payload: {
        code: 423,
        error: 'login_locked',
        message: '登录失败次数过多，请稍后再试',
      },
    };
    render(<ParameterManagementApp />);

    expect(await screen.findByText('后台登录')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('登录账号'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: /登录/ }));

    expect(await screen.findByText('后台登录失败：登录失败次数过多，请稍后再试')).toBeInTheDocument();
  });

  it('forces a bootstrap admin to change the initial password before loading management data', async () => {
    storage.clear();
    forcePasswordChangeLogin = true;
    defaultAccessRequiresPassword = true;
    render(<ParameterManagementApp />);

    expect(await screen.findByText('后台登录')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('登录账号'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'Bootstrap1!' } });
    fireEvent.click(screen.getByRole('button', { name: /登录/ }));

    expect(await screen.findByText('首次登录必须修改密码')).toBeInTheDocument();
    expect(screen.queryByText('钢管档案')).not.toBeInTheDocument();
    expect(screen.getByLabelText('当前初始密码')).toHaveValue('Bootstrap1!');
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'secure456' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'secure456' } });
    fireEvent.click(screen.getByRole('button', { name: /完成安全初始化/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/auth/password',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            currentPassword: 'Bootstrap1!',
            newPassword: 'secure456',
            confirmPassword: 'secure456',
          }),
        }),
      );
    });
    expect(await screen.findByText('当前账号密码已修改')).toBeInTheDocument();
    expect(await screen.findByText('钢管档案')).toBeInTheDocument();
  });

  it('changes the current admin password through the authenticated API', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '安全' }));
    expect(screen.getByText('登录会话')).toBeInTheDocument();
    expect(screen.getByText('Codex Browser')).toBeInTheDocument();
    expect(screen.getByText('Chrome Remote')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'admin123' } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'secure456' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'secure456' } });
    fireEvent.click(screen.getByRole('button', { name: /修改密码/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/auth/password',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            currentPassword: 'admin123',
            newPassword: 'secure456',
            confirmPassword: 'secure456',
          }),
        }),
      );
    });
    expect(await screen.findByText('当前账号密码已修改')).toBeInTheDocument();
    expect(screen.getByLabelText('新密码')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/auth/sessions?id=ses-other',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(await screen.findByText('登录会话已撤销')).toBeInTheDocument();
  });

  it('loads and saves persisted security policy defaults', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '安全' }));
    expect(screen.getByText('安全策略')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('审计保留默认天数'), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('登录失败阈值'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('失败统计窗口分钟'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('登录锁定时长分钟'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('会话有效期小时'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /保存策略/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/security/policy',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            auditRetentionDays: 120,
            login: {
              maxFailures: 4,
              failureWindowMinutes: 20,
              lockoutMinutes: 15,
            },
            session: {
              ttlHours: 10,
            },
          }),
          headers: expect.objectContaining({ Accept: 'application/json' }),
        }),
      );
    });
    expect(await screen.findByText('安全策略已保存')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '审计' }));
    expect(screen.getByLabelText('保留天数')).toHaveValue(120);
  });

  it('blocks weak current-account passwords before calling the backend', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '安全' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'admin123' } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: '12345678' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: '12345678' } });
    fireEvent.click(screen.getByRole('button', { name: /修改密码/ }));

    expect(await screen.findByText('密码至少 8 位且需同时包含字母和数字')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/admin/auth/password',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('restores a saved config revision through the backend API', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    fireEvent.click(screen.getByRole('button', { name: '配置版本' }));
    const restoreButtons = await screen.findAllByRole('button', { name: '恢复' });
    fireEvent.click(restoreButtons[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/config/revisions/restore',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ id: 'CFG-1' }),
        }),
      );
    });
    expect(await screen.findByText('已恢复 capture 配置版本')).toBeInTheDocument();
  });

  it('restores security policy config revisions into the security form', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    fireEvent.click(screen.getByRole('button', { name: '配置版本' }));
    const restoreButtons = await screen.findAllByRole('button', { name: '恢复' });
    fireEvent.click(restoreButtons[4]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/config/revisions/restore',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ id: 'CFG-5' }),
        }),
      );
    });
    expect(await screen.findByText('已恢复 security_policy 配置版本')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '安全' }));
    expect(screen.getByLabelText('审计保留默认天数')).toHaveValue(120);
    expect(screen.getByLabelText('登录失败阈值')).toHaveValue(4);
    expect(screen.getByLabelText('失败统计窗口分钟')).toHaveValue(15);
    expect(screen.getByLabelText('登录锁定时长分钟')).toHaveValue(6);
    expect(screen.getByLabelText('会话有效期小时')).toHaveValue(10);
  });

  it('previews a config revision before restore and shows a diff summary', async () => {
    const { container } = render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    fireEvent.click(screen.getByRole('button', { name: '配置版本' }));
    const previewButtons = await screen.findAllByRole('button', { name: '预览' });
    fireEvent.click(previewButtons[0]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/config/revisions/detail?id=CFG-1',
        expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) }),
      );
    });
    expect(await screen.findByText('已加载 capture 配置版本预览')).toBeInTheDocument();
    expect(screen.getByText('新增 1 / 删除 0 / 变更 1')).toBeInTheDocument();
    expect(screen.getByLabelText('配置版本预览 JSON')).toHaveAttribute('readonly');
    expect(container.querySelectorAll('.json-code-editor')).toHaveLength(1);
  });

  it('saves camera configuration through the backend management API', async () => {
    setAdminOverviewSiteMode('direct-camera');
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    fireEvent.change(screen.getByLabelText('相机 ID'), { target: { value: 'CAM-02' } });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '2 号采集相机' } });
    fireEvent.change(screen.getByLabelText('IP 地址'), { target: { value: '192.168.102.100' } });
    fireEvent.change(screen.getByLabelText('采集行数'), { target: { value: '1600' } });
    fireEvent.click(screen.getByRole('button', { name: /保存相机/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4873/api/admin/cameras',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            id: 'CAM-02',
            name: '2 号采集相机',
            ip: '192.168.102.100',
            driverId: 'lvm-nvt',
            modelHint: 'LVM3450CA',
            role: '采集相机',
            enabled: true,
            triggerMode: '软件触发',
            exposureUs: 850,
            gain: 1,
            depthLines: 1600,
            outputPath: 'captures/CAM-01',
          }),
        }),
      );
    });
  });

  it('shows backend camera validation details when camera save is rejected', async () => {
    setAdminOverviewSiteMode('direct-camera');
    saveCameraFailureResponse = {
      status: 400,
      payload: {
        code: 400,
        error: 'invalid camera config',
        message: 'camera.exposureUs 必须在 1..1000000 范围内',
      },
    };
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    fireEvent.change(screen.getByLabelText('相机 ID'), { target: { value: 'CAM-02' } });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '2 号采集相机' } });
    fireEvent.change(screen.getByLabelText('IP 地址'), { target: { value: '192.168.102.100' } });
    fireEvent.change(screen.getByLabelText('曝光 us'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /保存相机/ }));

    expect(await screen.findByText('相机配置保存失败：camera.exposureUs 必须在 1..1000000 范围内')).toBeInTheDocument();
  });

  it('shows active site availability on overview and runs only the default check', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    const sitePanel = screen.getByTestId('site-configuration-overview');
    expect(within(sitePanel).getByText('BKV 六相机现场')).toBeInTheDocument();
    expect(within(sitePanel).getByText('BKV 模式')).toBeInTheDocument();
    expect(within(sitePanel).getByText('legacy-bkv')).toBeInTheDocument();
    expect(within(sitePanel).getByText('6 个相机')).toBeInTheDocument();
    expect(within(sitePanel).getByText('正常 5')).toBeInTheDocument();
    expect(within(sitePanel).getByText('关注 1')).toBeInTheDocument();
    expect(within(sitePanel).getByText('阻断 0')).toBeInTheDocument();
    expect(within(sitePanel).getByText('当前配置已生效')).toBeInTheDocument();

    fireEvent.click(within(sitePanel).getByRole('button', { name: '检查配置' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/site-configs/check'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ id: 'bkv-default', depth: 'default' }),
        }),
      );
    });
    const checkCalls = fetchMock.mock.calls.filter(
      ([url]) => String(url).includes('/api/admin/site-configs/check'),
    );
    expect(checkCalls).toHaveLength(1);
    expect(String(checkCalls[0][1]?.body)).not.toContain('"deep"');

    fireEvent.click(within(sitePanel).getByRole('button', { name: '进入全局配置' }));
    expect(await screen.findByTestId('global-configuration-panel')).toBeInTheDocument();
  });

  it('shows only BKV configuration modules advertised by the active site', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));

    const navigation = screen.getByTestId('configuration-module-navigation');
    for (const label of ['数据转换', '数据源', '存储配置', '相机映射', '检测算法', '配置版本']) {
      expect(within(navigation).getByRole('button', { name: label })).toBeInTheDocument();
    }
    for (const label of ['相机直连', '采集管理', '3D 重建']) {
      expect(within(navigation).queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
    expect(screen.queryByText('相机配置')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('采集配置 JSON')).not.toBeInTheDocument();

    fireEvent.click(within(navigation).getByRole('button', { name: '数据源' }));
    expect(screen.getByLabelText('连接配置 JSON')).toBeInTheDocument();
    expect(screen.queryByLabelText('采集配置 JSON')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.json-code-editor')).toHaveLength(1);

    fireEvent.click(within(navigation).getByRole('button', { name: '检测算法' }));
    expect(screen.getByLabelText('后台严重深度阈值')).toBeInTheDocument();
    expect(screen.queryByLabelText('连接配置 JSON')).not.toBeInTheDocument();
  });

  it('shows direct-camera modules and mounts only the selected editor', async () => {
    setAdminOverviewSiteMode('direct-camera');
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));

    const navigation = screen.getByTestId('configuration-module-navigation');
    for (const label of ['相机直连', '采集管理', '触发配置', 'PLC 通讯', '存储配置', '检测算法', '3D 重建', '配置版本']) {
      expect(within(navigation).getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText('相机配置')).toBeInTheDocument();
    expect(screen.queryByLabelText('采集配置 JSON')).not.toBeInTheDocument();

    fireEvent.click(within(navigation).getByRole('button', { name: '采集管理' }));
    expect(screen.getByLabelText('采集配置 JSON')).toBeInTheDocument();
    expect(screen.queryByLabelText('连接配置 JSON')).not.toBeInTheDocument();
    expect(screen.queryByText('相机配置')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.json-code-editor')).toHaveLength(1);

    fireEvent.click(within(navigation).getByRole('button', { name: 'PLC 通讯' }));
    expect(screen.getByLabelText('连接配置 JSON')).toBeInTheDocument();
    expect(screen.queryByLabelText('采集配置 JSON')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.json-code-editor')).toHaveLength(1);
  });

  it('renders the six-camera BKV runtime mode and converter progress in system config', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    expect(screen.queryByTestId('runtime-profile-management')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全局配置' }));
    const panel = await screen.findByTestId('runtime-profile-management');
    expect(within(panel).getByText('运行模式与数据转换')).toBeInTheDocument();
    expect(within(panel).getByText('BKV 六相机离线转换')).toBeInTheDocument();
    expect(within(panel).getByText('6 个相机')).toBeInTheDocument();
    for (const camera of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']) {
      expect(within(panel).getByText(camera)).toBeInTheDocument();
    }
    expect(within(panel).queryByText('C7')).not.toBeInTheDocument();
    expect(within(panel).queryByText('C8')).not.toBeInTheDocument();
    expect(within(panel).getByText('10 / 11 已转换')).toBeInTheDocument();
    expect(within(panel).getByText('隔离 1')).toBeInTheDocument();
  });

  it('keeps runtime configuration editable when the optional converter status is unavailable', async () => {
    failBkvImportStatus = true;
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全局配置' }));
    const panel = await screen.findByTestId('runtime-profile-management');
    expect(await within(panel).findByText('BKV 六相机离线转换')).toBeInTheDocument();
    expect(within(panel).getByLabelText('BKV 源目录')).toBeEnabled();
    expect(within(panel).getByText('转换服务状态暂不可用')).toBeInTheDocument();
  });

  it('validates and saves runtime configuration with a persistent restart message', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全局配置' }));
    const sourceInput = await screen.findByLabelText('BKV 源目录');
    fireEvent.change(sourceInput, { target: { value: 'tmp/legacy-bkv-new' } });
    fireEvent.click(screen.getByRole('button', { name: '校验运行配置' }));
    expect(await screen.findByText('配置校验通过')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存运行配置' }));
    expect(await screen.findByText('配置已保存，重启后生效')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4873/api/admin/runtime-profile',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows validation details and does not save an invalid runtime profile', async () => {
    runtimeProfileValidationFailure = true;
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全局配置' }));
    fireEvent.click(await screen.findByRole('button', { name: '校验运行配置' }));
    expect(await screen.findByText('运行配置校验失败：cameraCount 必须与 cameras 一致')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url).endsWith('/api/admin/runtime-profile') && init?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('starts and retries BKV converter jobs while hiding config from unauthorized users', async () => {
    const { unmount } = render(<ParameterManagementApp />);
    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全局配置' }));
    fireEvent.click(await screen.findByRole('button', { name: '启动转换' }));
    expect(await screen.findByText('转换任务已启动')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试任务' }));
    expect(await screen.findByText('转换任务已重试')).toBeInTheDocument();
    unmount();

    sessionPermissionsOverride = ['admin.overview'];
    render(<ParameterManagementApp />);
    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '配置' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '全局配置' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('runtime-profile-management')).not.toBeInTheDocument();
  });

  it('opens global site configuration from the management navigation', async () => {
    render(<ParameterManagementApp />);

    expect(await screen.findByText('系统管理员')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全局配置' }));

    expect(await screen.findByTestId('global-configuration-panel')).toBeInTheDocument();
  });
});
