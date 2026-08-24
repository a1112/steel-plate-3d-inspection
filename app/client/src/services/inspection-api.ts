import defectInclusionImage from '../assets/mock-defects/defect-inclusion.png';
import defectPitImage from '../assets/mock-defects/defect-pit.png';
import defectScratchImage from '../assets/mock-defects/defect-scratch.png';
import { getMockInspectionSnapshot } from '../data/inspection';
import type {
  CaptureImageItem,
  DefectItem,
  DefectReviewStatus,
  InspectionSnapshot,
  PlateInspection,
} from '../data/inspection';

const DEFAULT_SERVICE_ORIGIN = 'http://127.0.0.1:4873';
const CONNECTION_CONFIG_KEY = 'steel-inspection-connection-config';
const ADMIN_SESSION_KEY = 'steel-inspection-admin-session';
const ADMIN_ERROR_MESSAGES: Record<string, string> = {
  report_archive_integrity_failed: '检测报告归档完整性校验失败，请停止打印并联系运维恢复归档',
  report_archive_invalid: '检测报告归档格式损坏，请联系运维恢复归档',
  report_archive_not_found: '指定的检测报告归档不存在或已丢失',
  invalid_report_identity: '检测报告归档编号无效',
  auth_required: '请先登录后台管理',
  permission_denied: '当前账号没有该操作权限',
  password_change_required: '首次登录必须先修改初始密码',
  origin_not_allowed: '请求来源不受信任，请从本机客户端操作',
  trigger_gateway_unavailable: '触发网关不可达',
  trigger_gateway_timeout: '触发网关响应超时',
  invalid_credentials: '账号或密码错误',
  password_configured: '后台已设置密码，请输入密码登录',
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
  runtime?: ConnectionRuntimeInfo;
};

export type ConnectionRuntimeInfo = {
  service: string;
  bindHost: string;
  advertisedHost: string;
  port: number;
  origin: string;
  lanAccess: boolean;
  databaseEngine: string;
  databaseStatus: string;
  databaseFallbackActive: boolean;
  schemaVersion: number;
};

export type DiscoveredInspectionService = {
  host: string;
  port: number;
  origin: string;
  scope: 'lan' | 'loopback' | string;
  preferred: boolean;
};

export type ConnectionDiscoveryResult = {
  schema: 'steel.inspection-service-discovery.v1';
  code: number;
  runtime: ConnectionRuntimeInfo;
  preferred: DiscoveredInspectionService;
  addresses: DiscoveredInspectionService[];
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
  mustChangePassword?: boolean;
  lastLoginAt: string;
};

export type AdminAuthenticatedUser = {
  id: string;
  displayName: string;
  role: string;
  permissions: string[];
  mustChangePassword?: boolean;
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
      requestedEngine?: string;
      supportedEngines?: string[];
      fallbackEnabled?: boolean;
      fallbackActive?: boolean;
      fallbackReason?: string | null;
      path: string;
      bytes?: number;
      configDir?: string;
    };
  };
  capture: {
    name?: string;
    provider?: 'headless-cpp' | 'external-api' | 'simulated' | string;
    managed?: boolean;
    running?: boolean;
    port?: number;
    origin?: string;
    processAvailable?: boolean;
    executable?: string;
    fallback?: string;
    lifecycle?: {
      phase?: 'starting' | 'ready' | 'collecting' | 'degraded' | 'stopping' | 'stopped' | string;
      desiredRunning?: boolean;
      autostart?: boolean;
      pid?: number | null;
      startedAt?: string | null;
      readyAt?: string | null;
      lastExitAt?: string | null;
      lastExitCode?: number | null;
      lastError?: string;
      restartCount?: number;
      consecutiveFailures?: number;
      unhealthyConfirmations?: number;
      restartBudget?: number;
      restartBudgetExhausted?: boolean;
      nextRestartAt?: string | null;
    };
  };
  diagnostics?: Array<{
    id: string;
    label: string;
    status: 'normal' | 'warning' | 'error' | string;
    detail: string;
  }>;
};

export type AdminRuntimeLogFile = {
  name: string;
  bytes: number;
  modifiedAt?: string;
  tail: string;
  truncated?: boolean;
};

export type AdminRuntimeService = {
  id: string;
  name: string;
  origin: string;
  port: string | number;
  ok: boolean;
  required: boolean;
  status: string;
  reason?: string | null;
};

export type AdminRuntimeLogStatus = {
  schema: 'steel.runtime-log-status.v1' | string;
  updatedAt: string;
  status: 'running' | 'degraded' | string;
  runtime: {
    stateRoot?: string | null;
    logRoot: string;
    supervisor?: {
      status?: string;
      reason?: string;
      updatedAt?: string;
      restartBudgetExhausted?: boolean;
      restartCountWindow?: number;
      restartBudgetMaximum?: number;
      [key: string]: unknown;
    } | null;
  };
  resultStore: {
    root?: string | null;
    catalogPath?: string | null;
    ready: boolean;
    bytes: number;
  };
  services: AdminRuntimeService[];
  logs: AdminRuntimeLogFile[];
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
  siteConfiguration?: {
    active: {
      id: string;
      displayName: string;
      mode: 'bkv' | 'direct-camera' | string;
      provider: string;
      dataSource: string;
      cameraCount: number;
      capabilities: {
        directCamera: boolean;
        captureManagement: boolean;
        reconstruction: boolean;
        offlineReplay: boolean;
      };
      configHash: string;
      compatibility: boolean;
    };
    pending?: {
      id: string;
      displayName: string;
      mode: 'bkv' | 'direct-camera' | string;
      cameraCount: number;
    } | null;
    restartRequired: boolean;
    checkSummary: {
      normal: number;
      warning: number;
      error: number;
      blocking: number;
      checkedAt?: number | null;
    };
  };
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
    requestedEngine?: string;
    supportedEngines?: string[];
    fallbackEnabled?: boolean;
    fallbackActive?: boolean;
    fallbackReason?: string | null;
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
  source?: 'production' | 'unified-result' | string;
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
  artifacts?: import('../data/inspection').DefectArtifacts;
};

export type AdminInspectionRecordDetail = AdminInspectionRecord & {
  defects: AdminDefectDetail[];
  algorithmTrace?: {
    schema: string;
    algorithmName?: string;
    algorithmVersion?: string;
    configRevision?: string;
    configSha256?: string;
    scriptSha256?: string;
    coreSha256?: string;
    releaseCommit?: string;
    acceptanceReportSha256?: string;
    datasetRevision?: string;
    datasetSha256?: string;
    evaluatorRevision?: string;
    evaluatorSha256?: string;
    calibrationRevision?: string;
    calibrationSha256?: string;
    inputSummarySha256?: string;
    inputArtifactCount?: number;
    qualityGate?: { passed?: boolean; reasons?: string[] };
    realDefectCount?: number;
    syntheticDefectCount?: number;
  } | null;
};

export type InspectionReportArchive = {
  schema: 'steel.inspection.report-archive.v1' | string;
  reportId: string;
  inspectionId: string;
  materialId: string;
  issuedAt: string;
  issuedBy: string;
  documentSha256: string;
  document: Record<string, unknown>;
};

export type IssuedInspectionReport = {
  code: number;
  created: boolean;
  reportId: string;
  archivePath: string;
  archive: InspectionReportArchive;
};

export type InspectionReportArchiveSummary = {
  reportId: string;
  inspectionId: string;
  materialId: string;
  issuedAt: string;
  issuedBy: string;
  documentSha256: string;
};

export type InspectionReportArchivePage = {
  code: number;
  inspectionId: string;
  reports: InspectionReportArchiveSummary[];
};

export type InspectionReportArchiveDetail = {
  code: number;
  archive: InspectionReportArchive;
};

export type AdminInspectionRecordPage = {
  source?: 'production' | 'unified-result' | string;
  synchronizedAt?: string;
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
  deletedCaptureFiles: number;
  deletedPlates: number;
  filesPlanned: number;
  filesDeleted: number;
  filesMissing: number;
  bytesPlanned: number;
  bytesDeleted: number;
  cleanupIds: string[];
  failures: Array<{ recordId: string; cleanupId?: string; error: string }>;
  dryRun: boolean;
};

export type AdminRecordCleanupResult = {
  code: number;
  deleted: boolean;
  cleanupId: string;
  recordId: string;
  materialId: string;
  filesPlanned: number;
  filesDeleted: number;
  filesMissing: number;
  bytesPlanned: number;
  bytesDeleted: number;
  defectsDeleted: number;
  captureFilesDeleted: number;
  plateDeleted: false;
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
  captureSummaryPath?: string;
  captureCount: number;
  defectCount: number;
  startedAt: string;
  finishedAt: string;
};

export type ProductionStatus = {
  code: number;
  database?: {
    engine: string;
    requestedEngine?: string;
    fallbackActive?: boolean;
    fallbackReason?: string | null;
    path: string;
  };
  latestSession?: ProductionMaterialSession | null;
  activeSession?: ProductionMaterialSession | null;
  latestInspection?: ProductionInspection | null;
  tasks?: {
    queueDepth: number;
    capacity: number;
    worker?: {
      running: boolean;
      activeTaskId?: string | null;
      heartbeatAgeMs?: number;
      recoveredTasks?: number;
    };
  };
  capture?: BkvCaptureStatus | Record<string, unknown>;
};

export type CaptureProvider = 'headless-cpp' | 'external-api' | 'simulated' | 'bkv';

export type BkvSourceBadge = 'BKV 离线回放';

export type BkvDepthDecode = {
  status: 'decoded' | 'unsupported' | 'invalid';
  reason: string;
  probeSchema: 'steel.bkv-d3img-probe.v1';
  parserVersion: string;
  originalSha256: string;
  decoderAvailable: boolean;
  previewArtifactRef?: string;
  depthArtifactRef?: string;
  metadataArtifactRef?: string;
};

export type BkvArtifact = {
  artifactRef: `bkv://${string}`;
  relativePath: string;
  url: string;
  authenticated: true;
  source: 'bkv';
  sourceBadge: BkvSourceBadge;
  offline: true;
  sha256: string;
  size: number;
  cameraNumber: number;
  legacySeqNo: number;
  kind: string;
  verified?: boolean;
  depthDecode: BkvDepthDecode | null;
};

export type BkvReplayState = {
  previousIndex?: number;
  index: number;
  total: number;
  status: 'ready' | 'replaying' | 'completed';
  version: number;
  legacySeqNo?: number;
};

export type BkvCaptureStatus = {
  provider: 'bkv';
  status: 'bkv-offline';
  sdkRequired: false;
  sdkReady: null;
  cameraCount: 6;
  channels: Array<{
    index: number;
    status: 'offline';
    source: 'bkv';
  }>;
  batchId?: string;
  contentId?: string;
  replay?: BkvReplayState;
};

export type BkvStatus = {
  code: number;
  active: boolean;
  provider: 'bkv';
  source: 'bkv';
  sourceBadge: BkvSourceBadge;
  offline: true;
  activeBatch?: { batchId: string; contentId: string };
  batch?: {
    batchId: string;
    contentId: string;
    status: 'ready' | 'partial';
    operatorReviewedPartial?: true;
    counts?: Record<string, number>;
  };
  replay?: BkvReplayState;
};

export type BkvPlateInspection = Omit<PlateInspection, 'captureImages' | 'source'> & {
  captureImages: [];
  bkvArtifacts: BkvArtifact[];
  source: 'bkv';
};

export type BkvInspectionSnapshot = Omit<
  InspectionSnapshot,
  'source' | 'captureImages' | 'inspections'
> & {
  provider: 'bkv';
  source: 'bkv' | 'bkv-offline';
  sourceBadge: BkvSourceBadge;
  offline: true;
  captureImages: [];
  inspections: BkvPlateInspection[];
  legacySeqNo?: number;
  batchId?: string;
  contentId?: string;
  replay?: BkvReplayState;
  bkvArtifacts: BkvArtifact[];
};

export type PhysicalInspectionSnapshot = InspectionSnapshot & {
  provider?: Exclude<CaptureProvider, 'bkv'>;
  bkvArtifacts?: never;
  offline?: false;
};

export type InspectionSnapshotResponse = PhysicalInspectionSnapshot | BkvInspectionSnapshot;

export type ProductionEventInput = {
  materialId: string;
  sessionId?: string;
  requestId?: string;
  source?: string;
  mode?: string;
  triggerMode?: string;
  storageRoot?: string;
  steelType?: string;
  width?: number;
  length?: number;
  thick?: number;
  captureMode?: string;
  autoCapture?: boolean;
  discardBlackFrames?: boolean;
};

export type ProductionTaskSummary = {
  id?: string;
  taskId: string;
  kind: string;
  materialId: string;
  sessionId: string;
  chainId?: string;
  dependsOnTaskId?: string | null;
  dependencyPolicy?: 'require-success' | 'always-run' | string;
  blockedReason?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'blocked' | string;
  phase?: string;
  progress?: number;
  cancelRequested?: boolean;
  error?: string;
};

export type ProductionTaskDetail = ProductionTaskSummary & {
  result?: ProductionCommandResult | null;
};

export type ProductionCommandResult = {
  code: number;
  duplicate?: boolean;
  task?: ProductionTaskSummary;
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
  provider?: CaptureProvider | Record<string, unknown>;
  source?: string;
  sourceBadge?: string;
  offline?: boolean;
  cameraCount?: number;
  batchId?: string;
  contentId?: string;
  legacySeqNo?: number;
  replay?: BkvReplayState;
  artifacts?: BkvArtifact[];
  record?: unknown;
  error?: string;
  message?: string;
};

export type BkvProductionCommandResult = ProductionCommandResult & {
  provider: 'bkv';
  source: 'bkv';
  sourceBadge: BkvSourceBadge;
  offline: true;
  cameraCount: 6;
  batchId: string;
  contentId: string;
  legacySeqNo: number;
  replay: BkvReplayState & { previousIndex: number };
  artifacts: BkvArtifact[];
};

export type TriggerGatewayMode = 'api' | 'tcp' | 'udp' | 'gray' | 'secondary' | 'manual';

export type TriggerGatewayStatus = {
  code: number;
  service?: string;
  mode: TriggerGatewayMode | string;
  modeLabel?: string;
  manualAllowed: boolean;
  allowedModes?: TriggerGatewayMode[];
  listeners?: Partial<Record<'http' | 'tcp' | 'udp', { enabled: boolean }>>;
  security?: {
    profile?: 'development' | 'production' | string;
    authenticationRequired?: boolean;
    operatorAuthenticationRequired?: boolean;
    sourceAllowlistConfigured?: boolean;
    authWindowSeconds?: number;
    modeMutationAllowed?: boolean;
  };
  inspectionServiceHealthy?: boolean;
  error?: string;
  message?: string;
};

export type ServiceHealthCheck = {
  ok: boolean;
  status: string;
  level?: 'ok' | 'warning' | 'critical' | 'simulated' | string;
  reason?: string | null;
  warningReason?: string | null;
  required?: boolean;
  readyContribution?: boolean;
  apiReachable?: boolean;
  engine?: string;
  requestedEngine?: string;
  fallbackActive?: boolean;
  schemaVersion?: number;
  sdkReady?: boolean | null;
  writable?: boolean;
  accepting?: boolean;
  capacityAvailable?: boolean | null;
  capacityBytes?: number | null;
  freeBytes?: number | null;
  freePercent?: number | null;
  minimumFreeBytes?: number | null;
  minimumFreePercent?: number | null;
  warningFreeBytes?: number | null;
  warningFreePercent?: number | null;
  recentWriteBytesPerSecond?: number | null;
  estimatedRemainingSeconds?: number | null;
  unresolvedCount?: number | null;
  unresolvedOperations?: Array<{
    operationId: string;
    kind?: string;
    status?: string;
    error?: string | null;
    updatedAt?: string;
  }>;
};

export type ServiceHealthDetails = {
  ok: boolean;
  status: string;
  service: string;
  uptimeMs: number;
  endpoint?: string;
  checks: {
    database?: ServiceHealthCheck;
    taskWorker?: ServiceHealthCheck;
    capture?: ServiceHealthCheck;
    calibrationReconciliation?: ServiceHealthCheck;
    storage?: ServiceHealthCheck;
    trigger?: ServiceHealthCheck;
    algorithm?: ServiceHealthCheck;
    productionPolicy?: ServiceHealthCheck;
  };
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
  const pageHost = typeof window !== 'undefined' ? window.location?.hostname?.trim() : '';
  const host = pageHost && !matchesLoopbackHost(pageHost) ? pageHost : '127.0.0.1';
  return {
    mode: 'online',
    host,
    port: 4873,
  };
}

function matchesLoopbackHost(host: string) {
  const normalized = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized.endsWith('.localhost');
}

function formatServiceOrigin(host: string, port: number) {
  const normalized = host.trim().replace(/^\[|\]$/g, '');
  const authority = normalized.includes(':') ? `[${normalized}]` : normalized;
  return `http://${authority}:${port}`;
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
    storage.setItem(CONNECTION_CONFIG_KEY, JSON.stringify({
      mode: config.mode,
      host: config.host,
      port: config.port,
    }));
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
  return config.host && config.port ? formatServiceOrigin(config.host, config.port) : DEFAULT_SERVICE_ORIGIN;
}

export function getTriggerGatewayOrigin() {
  return getInspectionServiceOrigin();
}

export async function readAdminErrorMessage(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { detail?: string; error?: string; message?: string };
    if (payload.detail) {
      return `${fallback}：${payload.detail}`;
    }
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

export async function loginAdminWithDefaultAccess(): Promise<AdminAuthSession> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'admin', defaultAccess: true }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '后台默认访问失败'));
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

function normalizeServiceUrl(value: string | undefined, origin: string) {
  if (!value) {
    return '';
  }
  if (/^https?:\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:')) {
    return value;
  }
  return value.startsWith('/') ? `${origin}${value}` : value;
}

function normalizeCaptureImage(image: CaptureImageItem, origin: string): CaptureImageItem {
  let imageUrl = normalizeServiceUrl(image.url, origin);
  const normalizedPath = image.path.replaceAll('\\', '/');
  const isSickIntensityFrame = image.dataName.toLowerCase() === 'intensity'
    && /(?:^|\/)\d+\/capture\/C\d+\/2d\/[^/]+\.png$/i.test(normalizedPath);
  if (isSickIntensityFrame) {
    const params = new URLSearchParams({
      path: image.path,
      maxWidth: '2048',
      region: 'valid',
    });
    imageUrl = `${origin}/api/capture/file?${params.toString()}`;
  }
  return {
    ...image,
    url: imageUrl,
    metadataUrl: normalizeServiceUrl(image.metadataUrl, origin),
  };
}

function withPreviewImage(defect: DefectItem, allowMockFallback: boolean, origin: string): DefectItem {
  const previewImageUrl = normalizeServiceUrl(defect.previewImageUrl, origin);
  return {
    ...defect,
    previewImageUrl: previewImageUrl || (allowMockFallback ? defectPreviewImages[defect.typeId] ?? defectPitImage : ''),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BKV_TOTAL = 11;
const BKV_FIRST_SEQ_NO = 1_893_700;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BKV_BATCH_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,117}$/;

function isSafeIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function parseBkvReplayState(value: unknown): BkvReplayState {
  if (!isRecord(value)
    || !isSafeIntegerIn(value.index, 0, BKV_TOTAL)
    || value.total !== BKV_TOTAL
    || !isSafeIntegerIn(value.version, value.index, Number.MAX_SAFE_INTEGER)) {
    throw new Error('BKV replay state is invalid');
  }
  const expectedStatus = value.index === 0
    ? 'ready'
    : value.index === BKV_TOTAL ? 'completed' : 'replaying';
  const expectedSeqNo = value.index === 0 ? undefined : BKV_FIRST_SEQ_NO + value.index - 1;
  if (value.status !== expectedStatus
    || (expectedSeqNo === undefined
      ? value.legacySeqNo !== undefined && value.legacySeqNo !== null
      : value.legacySeqNo !== expectedSeqNo)
    || (value.previousIndex !== undefined
      && !isSafeIntegerIn(value.previousIndex, 0, value.index))) {
    throw new Error('BKV replay state contradicts its index');
  }
  return {
    ...(typeof value.previousIndex === 'number' ? { previousIndex: value.previousIndex } : {}),
    index: value.index,
    total: BKV_TOTAL,
    status: expectedStatus,
    version: value.version,
    ...(expectedSeqNo === undefined ? {} : { legacySeqNo: expectedSeqNo }),
  };
}

function parseBkvIdentity(value: unknown, label: string): { batchId: string; contentId: string } {
  if (!isRecord(value)
    || typeof value.batchId !== 'string'
    || !BKV_BATCH_ID_PATTERN.test(value.batchId)
    || typeof value.contentId !== 'string'
    || !SHA256_PATTERN.test(value.contentId)) {
    throw new Error(`BKV ${label} identity is invalid`);
  }
  return { batchId: value.batchId, contentId: value.contentId };
}

export function parseBkvStatus(value: unknown): BkvStatus {
  if (!isRecord(value) || value.code !== 0 || typeof value.active !== 'boolean'
    || value.provider !== 'bkv' || value.source !== 'bkv'
    || value.sourceBadge !== 'BKV 离线回放' || value.offline !== true) {
    throw new Error('BKV status response is invalid');
  }
  if (!value.active) {
    if (value.activeBatch !== undefined || value.batch !== undefined || value.replay !== undefined) {
      throw new Error('BKV inactive status contains active state');
    }
    return {
      code: 0, active: false, provider: 'bkv', source: 'bkv',
      sourceBadge: 'BKV 离线回放', offline: true,
    };
  }
  const activeBatch = parseBkvIdentity(value.activeBatch, 'active batch');
  const batchValue = value.batch;
  const batchIdentity = parseBkvIdentity(batchValue, 'batch');
  if (!isRecord(batchValue)) {
    throw new Error('BKV status batch binding is invalid');
  }
  const batchStatus = batchValue.status;
  const reviewedPartial = batchValue.operatorReviewedPartial;
  if (activeBatch.batchId !== batchIdentity.batchId
    || activeBatch.contentId !== batchIdentity.contentId
    || (batchStatus !== 'ready' && batchStatus !== 'partial')
    || (batchStatus === 'partial' && reviewedPartial !== true)
    || (batchStatus === 'ready' && reviewedPartial !== undefined)) {
    throw new Error('BKV status batch binding is invalid');
  }
  let counts: Record<string, number> | undefined;
  if (batchValue.counts !== undefined && batchValue.counts !== null) {
    if (!isRecord(batchValue.counts)) {
      throw new Error('BKV status counts are invalid');
    }
    counts = {};
    for (const [key, count] of Object.entries(batchValue.counts)) {
      if (!isSafeIntegerIn(count, 0, Number.MAX_SAFE_INTEGER)) {
        throw new Error('BKV status counts are invalid');
      }
      counts[key] = count;
    }
  }
  const replay = parseBkvReplayState(value.replay);
  return {
    code: 0, active: true, provider: 'bkv', source: 'bkv',
    sourceBadge: 'BKV 离线回放', offline: true,
    activeBatch,
    batch: {
      ...batchIdentity,
      status: batchStatus,
      ...(batchStatus === 'partial' ? { operatorReviewedPartial: true as const } : {}),
      ...(counts ? { counts } : {}),
    },
    replay,
  };
}

export function parseBkvCaptureStatus(value: unknown): BkvCaptureStatus {
  if (!isRecord(value) || value.provider !== 'bkv' || value.status !== 'bkv-offline'
    || value.sdkRequired !== false || value.sdkReady !== null || value.cameraCount !== 6
    || !Array.isArray(value.channels) || value.channels.length !== 6) {
    throw new Error('BKV capture status is invalid');
  }
  const channels = value.channels.map((channel, offset) => {
    if (!isRecord(channel) || channel.index !== offset + 1
      || channel.status !== 'offline' || channel.source !== 'bkv') {
      throw new Error('BKV capture channels are invalid');
    }
    return { index: offset + 1, status: 'offline' as const, source: 'bkv' as const };
  });
  const hasIdentity = value.batchId !== undefined || value.contentId !== undefined;
  const identity = hasIdentity
    ? parseBkvIdentity({ batchId: value.batchId, contentId: value.contentId }, 'capture')
    : undefined;
  const replay = value.replay === undefined ? undefined : parseBkvReplayState(value.replay);
  return {
    provider: 'bkv', status: 'bkv-offline', sdkRequired: false, sdkReady: null,
    cameraCount: 6, channels,
    ...(identity ?? {}), ...(replay ? { replay } : {}),
  };
}

function isInspectionSnapshotShape(value: unknown): value is InspectionSnapshot & Record<string, unknown> {
  return isRecord(value)
    && isRecord(value.currentPlate)
    && Array.isArray(value.defectTypes)
    && Array.isArray(value.defects)
    && value.defects.every(isRecord)
    && Array.isArray(value.records)
    && isRecord(value.status)
    && isRecord(value.summary)
    && Array.isArray(value.heightProfile)
    && Array.isArray(value.inspections)
    && value.inspections.every((inspection) => (
      isRecord(inspection)
      && isRecord(inspection.plate)
      && Array.isArray(inspection.defects)
      && Array.isArray(inspection.heightProfile)
    ));
}

function parseBkvDepthDecode(value: unknown, artifactSha256: string): BkvDepthDecode {
  if (!isRecord(value)
    || value.probeSchema !== 'steel.bkv-d3img-probe.v1'
    || value.parserVersion !== 'bkv-d3img-probe/1'
    || value.originalSha256 !== artifactSha256
    || typeof value.decoderAvailable !== 'boolean'
    || (value.status !== 'decoded' && value.status !== 'unsupported' && value.status !== 'invalid')
    || typeof value.reason !== 'string' || value.reason.trim().length === 0
    || ((value.status === 'unsupported' || value.status === 'invalid')
      && value.decoderAvailable !== false)
    || (value.status === 'decoded' && value.decoderAvailable !== true)) {
    throw new Error('BKV d3img decode evidence is invalid');
  }
  return {
    status: value.status, reason: value.reason,
    probeSchema: 'steel.bkv-d3img-probe.v1', parserVersion: 'bkv-d3img-probe/1',
    originalSha256: artifactSha256, decoderAvailable: value.decoderAvailable,
    ...(typeof value.previewArtifactRef === 'string' ? { previewArtifactRef: value.previewArtifactRef } : {}),
    ...(typeof value.depthArtifactRef === 'string' ? { depthArtifactRef: value.depthArtifactRef } : {}),
    ...(typeof value.metadataArtifactRef === 'string' ? { metadataArtifactRef: value.metadataArtifactRef } : {}),
  };
}

export function parseBkvArtifact(value: unknown): BkvArtifact {
  if (!isRecord(value)) throw new Error('BKV artifact is invalid');
  const relativePath = typeof value.relativePath === 'string' ? value.relativePath : '';
  const artifactRef = typeof value.artifactRef === 'string' ? value.artifactRef : '';
  const refMatch = /^bkv:\/\/([^/]+)\/(artifacts\/.+)$/.exec(artifactRef);
  const artifactUrl = typeof value.url === 'string' ? value.url : '';
  let artifactUrlValid = false;
  if (artifactUrl) {
    try {
      const parsedUrl = new URL(artifactUrl, 'http://bkv.invalid');
      artifactUrlValid = parsedUrl.pathname === '/api/production/file'
        && parsedUrl.searchParams.get('path') === value.artifactRef;
    } catch {
      artifactUrlValid = false;
    }
  }
  if (!refMatch || !BKV_BATCH_ID_PATTERN.test(refMatch[1]) || refMatch[2] !== relativePath
    || relativePath.includes('..') || relativePath.includes('\\')
    || !artifactUrlValid
    || value.authenticated !== true || value.source !== 'bkv'
    || value.sourceBadge !== 'BKV 离线回放' || value.offline !== true
    || typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)
    || !isSafeIntegerIn(value.size, 0, Number.MAX_SAFE_INTEGER)
    || !isSafeIntegerIn(value.cameraNumber, 1, 6)
    || !isSafeIntegerIn(value.legacySeqNo, BKV_FIRST_SEQ_NO, BKV_FIRST_SEQ_NO + BKV_TOTAL - 1)
    || typeof value.kind !== 'string' || value.kind.trim().length === 0) {
    throw new Error('BKV artifact is invalid');
  }
  const isDepth = relativePath.toLowerCase().endsWith('.d3img');
  const depthDecode = isDepth
    ? parseBkvDepthDecode(value.depthDecode, value.sha256)
    : value.depthDecode === null ? null : (() => { throw new Error('BKV artifact decode evidence is unexpected'); })();
  return {
    artifactRef: artifactRef as `bkv://${string}`, relativePath,
    url: artifactUrl, authenticated: true, source: 'bkv', sourceBadge: 'BKV 离线回放', offline: true,
    sha256: value.sha256, size: value.size, cameraNumber: value.cameraNumber,
    legacySeqNo: value.legacySeqNo, kind: value.kind,
    ...(value.verified === true ? { verified: true } : {}), depthDecode,
  };
}

function isBkvPlateInspection(
  value: PlateInspection,
): value is PlateInspection & { bkvArtifacts: BkvArtifact[] } {
  return isRecord(value)
    && Array.isArray(value.bkvArtifacts)
    && value.bkvArtifacts.every((artifact) => { try { parseBkvArtifact(artifact); return true; } catch { return false; } });
}

function epochMillis(value: unknown): number | null {
  const text = typeof value === 'number' ? String(Math.trunc(value)) : String(value ?? '').trim();
  if (!/^\d{10,16}$/.test(text)) return null;
  let numeric = Number(text);
  if (!Number.isFinite(numeric)) return null;
  if (text.length <= 10) numeric *= 1_000;
  if (text.length > 13) numeric /= 10 ** (text.length - 13);
  const date = new Date(numeric);
  const year = date.getFullYear();
  return Number.isNaN(date.getTime()) || year < 2000 || year > 2200 ? null : numeric;
}

export function formatProductionDateTime(value: unknown): string {
  const millis = epochMillis(value);
  if (millis === null) return String(value ?? '');
  return new Date(millis).toLocaleString('zh-CN', { hour12: false });
}

export function formatProductionRecordTime(value: unknown, detectedAt?: unknown): string {
  const text = String(value ?? '').trim();
  const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (timeMatch
    && Number(timeMatch[1]) <= 23
    && Number(timeMatch[2]) <= 59
    && (timeMatch[3] === undefined || Number(timeMatch[3]) <= 59)) {
    return text;
  }
  const millis = epochMillis(value) ?? epochMillis(detectedAt);
  return millis === null
    ? '--:--'
    : new Date(millis).toLocaleTimeString('zh-CN', { hour12: false });
}

function normalizeSnapshotTimes<T extends InspectionSnapshot>(snapshot: T): T {
  const detectedAtByRecord = new Map<string, unknown>();
  const detectedAtByMaterial = new Map<string, unknown>();
  const inspections = snapshot.inspections.map((inspection) => {
    const detectedAt = inspection.plate.detectedAt;
    if (inspection.inspectionId) detectedAtByRecord.set(inspection.inspectionId, detectedAt);
    detectedAtByMaterial.set(inspection.plate.plateNo, detectedAt);
    return {
      ...inspection,
      plate: {
        ...inspection.plate,
        detectedAt: formatProductionDateTime(detectedAt),
      },
    };
  });
  return {
    ...snapshot,
    currentPlate: {
      ...snapshot.currentPlate,
      detectedAt: formatProductionDateTime(snapshot.currentPlate.detectedAt),
    },
    records: snapshot.records.map((record) => ({
      ...record,
      time: formatProductionRecordTime(
        record.time,
        detectedAtByRecord.get(record.id) ?? detectedAtByMaterial.get(record.plateNo),
      ),
    })),
    inspections,
  } as T;
}

function normalizeInspectionSnapshot(snapshot: unknown, origin: string): InspectionSnapshotResponse {
  if (!isInspectionSnapshotShape(snapshot)) {
    throw new Error('inspection snapshot shape is invalid');
  }
  if (snapshot.provider === 'bkv') {
    const bkvInspections = snapshot.inspections;
    const selected = snapshot.source === 'bkv';
    if ((snapshot.source !== 'bkv' && snapshot.source !== 'bkv-offline')
      || snapshot.offline !== true
      || snapshot.sourceBadge !== 'BKV 离线回放'
      || !Array.isArray(snapshot.bkvArtifacts)
      || !snapshot.bkvArtifacts.every((artifact) => { try { parseBkvArtifact(artifact); return true; } catch { return false; } })
      || !bkvInspections.every(isBkvPlateInspection)
      || (selected && (bkvInspections.length !== 1 || snapshot.records.length !== 1))
      || (!selected && (bkvInspections.length !== 0 || snapshot.bkvArtifacts.length !== 0))) {
      throw new Error('BKV inspection snapshot shape is invalid');
    }
    let identity: { batchId: string; contentId: string } | undefined;
    let legacySeqNo: number | undefined;
    let replay: BkvReplayState | undefined;
    if (selected) {
      identity = parseBkvIdentity(
        { batchId: snapshot.batchId, contentId: snapshot.contentId },
        'snapshot',
      );
      if (!isSafeIntegerIn(snapshot.legacySeqNo, BKV_FIRST_SEQ_NO, BKV_FIRST_SEQ_NO + BKV_TOTAL - 1)
        || snapshot.currentPlate.plateNo !== bkvInspections[0].plate.plateNo) {
        throw new Error('BKV snapshot selection binding is invalid');
      }
      legacySeqNo = snapshot.legacySeqNo;
      const prefix = `bkv://${identity.batchId}/`;
      if (![...snapshot.bkvArtifacts, ...bkvInspections[0].bkvArtifacts]
        .every((artifact) => artifact.artifactRef.startsWith(prefix))) {
        throw new Error('BKV snapshot artifact binding is invalid');
      }
      if (snapshot.replay !== undefined) {
        replay = parseBkvReplayState(snapshot.replay);
        if (replay.legacySeqNo !== legacySeqNo) {
          throw new Error('BKV snapshot replay selection is invalid');
        }
      }
    } else if (snapshot.batchId !== undefined || snapshot.contentId !== undefined
      || snapshot.legacySeqNo !== undefined || snapshot.replay !== undefined) {
      throw new Error('BKV offline snapshot contains a selection');
    }
    return normalizeSnapshotTimes({
      ...snapshot,
      provider: 'bkv',
      source: snapshot.source,
      sourceBadge: 'BKV 离线回放',
      offline: true,
      ...(identity ?? {}),
      ...(legacySeqNo === undefined ? {} : { legacySeqNo }),
      ...(replay ? { replay } : {}),
      defects: snapshot.defects.map((defect) => withPreviewImage(defect, false, origin)),
      captureImages: [],
      inspections: bkvInspections.map((inspection) => ({
        ...inspection,
        defects: inspection.defects.map((defect) => withPreviewImage(defect, false, origin)),
        captureImages: [],
        bkvArtifacts: inspection.bkvArtifacts.map((raw) => {
          const artifact = parseBkvArtifact(raw);
          return { ...artifact, url: normalizeServiceUrl(artifact.url, origin) };
        }),
        source: 'bkv',
      })),
      bkvArtifacts: snapshot.bkvArtifacts.map((raw) => {
        const artifact = parseBkvArtifact(raw);
        return { ...artifact, url: normalizeServiceUrl(artifact.url, origin) };
      }),
    });
  }
  // Static fixtures are allowed only for an explicitly identified demo/test
  // snapshot. Unknown and database-backed sources must fail closed so the
  // online page never presents bundled mock images as production evidence.
  const allowMockFallback = snapshot.source === 'demo' || snapshot.source === 'test';
  const inspections = snapshot.inspections.map((inspection) => ({
    ...inspection,
    defects: inspection.defects.map((defect) => withPreviewImage(defect, allowMockFallback, origin)),
    captureImages: inspection.captureImages?.map((image) => normalizeCaptureImage(image, origin)),
  }));
  const normalized = normalizeSnapshotTimes({
    ...snapshot,
    defects: snapshot.defects.map((defect) => withPreviewImage(defect, allowMockFallback, origin)),
    captureImages: snapshot.captureImages?.map((image) => normalizeCaptureImage(image, origin)),
    inspections,
  });
  return normalized;
}

export async function fetchInspectionSnapshot(
  signal?: AbortSignal,
): Promise<InspectionSnapshotResponse> {
  const config = getStoredConnectionConfig();
  if (config.mode === 'demo') {
    return getMockInspectionSnapshot();
  }

  const origin = getInspectionServiceOrigin(config);
  const response = await fetch(`${origin}/api/inspection/snapshot`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '后台数据接口异常'));
  }
  return normalizeInspectionSnapshot(await response.json(), origin);
}

export type DefectReviewInput = {
  defectId: string;
  status: DefectReviewStatus;
  note?: string;
  defectType?: string;
  severity?: 'severe' | 'review' | 'minor';
};

export type ProductionDefectHistory = {
  total: number;
  defects: DefectItem[];
};

export async function fetchProductionDefectHistory(
  limit = 5_000,
  signal?: AbortSignal,
): Promise<ProductionDefectHistory> {
  const config = getStoredConnectionConfig();
  if (config.mode === 'demo') {
    return { total: 0, defects: [] };
  }
  const origin = getInspectionServiceOrigin(config);
  // `limit` is a UI memory/latency budget, not a database page size. The old
  // loop kept paging until `total` and could pull an unbounded defect table on
  // every 15-second report refresh.
  const requestedLimit = Math.max(1, Math.min(10_000, Math.round(limit)));
  const query = new URLSearchParams({ limit: String(requestedLimit) });
  const response = await fetch(`${origin}/api/defects/history?${query.toString()}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '历史缺陷读取失败'));
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload)
    || payload.schema !== 'steel.production-defect-history.v1'
    || !Array.isArray(payload.defects)
    || !payload.defects.every(isRecord)
    || typeof payload.total !== 'number') {
    throw new Error('历史缺陷数据格式无效');
  }
  const page = payload.defects as unknown as DefectItem[];
  return {
    total: Math.max(0, Math.trunc(payload.total)),
    defects: [...new Map(page
      .slice(0, requestedLimit)
      .map((defect) => withPreviewImage(defect, false, origin))
      .map((defect) => [defect.id, defect])).values()],
  };
}

export async function reviewProductionDefect(input: DefectReviewInput): Promise<void> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/defects/review`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '缺陷复核写入失败'));
  }
}

export async function fetchBkvStatus(signal?: AbortSignal): Promise<BkvStatus> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/bkv/status`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, 'BKV 离线回放状态接口异常'));
  }
  return parseBkvStatus(await response.json());
}

export async function fetchBkvArtifact(
  artifact: BkvArtifact,
  signal?: AbortSignal,
): Promise<Blob> {
  artifact = parseBkvArtifact(artifact);
  const origin = getInspectionServiceOrigin(getStoredConnectionConfig());
  const query = new URLSearchParams({ path: artifact.artifactRef });
  const response = await fetch(`${origin}/api/production/file?${query.toString()}`, {
    headers: createAdminHeaders({ Accept: 'application/octet-stream' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, 'BKV 离线数据文件读取失败'));
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  const extension = artifact.relativePath.split('.').pop()?.toLowerCase() ?? '';
  const imageExpected = ['jpg', 'jpeg', 'png', 'bmp', 'webp'].includes(extension);
  if (contentType === 'text/html' || contentType.startsWith('text/')
    || (imageExpected && !contentType.startsWith('image/'))
    || (extension === 'd3img' && contentType !== 'application/octet-stream')) {
    throw new Error('BKV artifact content type mismatch');
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) !== artifact.size) {
    throw new Error('BKV artifact size mismatch');
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== artifact.size) throw new Error('BKV artifact size mismatch');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  const expected = artifact.sha256;
  let mismatch = expected.length ^ 64;
  for (let index = 0; index < digest.length; index += 1) {
    const actualPair = digest[index].toString(16).padStart(2, '0');
    mismatch |= actualPair.charCodeAt(0) ^ expected.charCodeAt(index * 2);
    mismatch |= actualPair.charCodeAt(1) ^ expected.charCodeAt(index * 2 + 1);
  }
  if (mismatch !== 0) throw new Error('BKV artifact hash mismatch');
  return new Blob([buffer], { type: contentType || 'application/octet-stream' });
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

export async function fetchServiceHealthDetails(signal?: AbortSignal): Promise<ServiceHealthDetails> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/health/details`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (response.status !== 503 && !response.ok) {
    throw new Error(await readAdminErrorMessage(response, '服务健康检查异常'));
  }
  return response.json() as Promise<ServiceHealthDetails>;
}

async function postProductionCommand(path: string, body: Record<string, unknown>): Promise<ProductionCommandResult> {
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

function productionRequestId(kind: string, input: ProductionEventInput & Record<string, unknown>) {
  const provided = typeof input.requestId === 'string' ? input.requestId.trim() : '';
  if (provided) {
    return provided;
  }
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${kind}-${input.materialId || 'unknown'}-${random}`;
}

export async function writeProductionSteelInfo(input: ProductionEventInput): Promise<ProductionCommandResult> {
  return postProductionCommand('/api/production/tasks/steel-info', {
    ...input,
    requestId: productionRequestId('steel-info', input),
  });
}

export async function startProductionSteelIn(input: ProductionEventInput): Promise<ProductionCommandResult> {
  return postProductionCommand('/api/production/tasks/steel-in', {
    ...input,
    requestId: productionRequestId('steel-in', input),
    autoCapture: input.autoCapture ?? true,
    discardBlackFrames: input.discardBlackFrames ?? true,
  });
}

export async function stopProductionSteelOut(input: ProductionEventInput): Promise<ProductionCommandResult> {
  return postProductionCommand('/api/production/tasks/steel-out', {
    ...input,
    requestId: productionRequestId('steel-out', input),
  });
}

export function hasStoredAdminSession() {
  return getStoredAdminSession() !== null;
}

export async function writeProductionSecondaryData(
  input: ProductionEventInput & Record<string, unknown>,
): Promise<ProductionCommandResult> {
  return postProductionCommand('/api/production/secondary-data', {
    ...input,
    requestId: productionRequestId('secondary-data', input),
    payloadType: input.payloadType ?? 'trigger-secondary-data',
  });
}

export async function captureProductionOnce(input: ProductionEventInput & Record<string, unknown>): Promise<ProductionCommandResult> {
  const requestId = productionRequestId('capture-once', input);
  return postProductionCommand('/api/production/tasks', {
    kind: 'capture-once',
    idempotencyKey: requestId,
    maxAttempts: 1,
    payload: {
      ...input,
      requestId,
      autoCapture: input.autoCapture ?? false,
      discardBlackFrames: input.discardBlackFrames ?? true,
    },
  });
}

export async function waitForProductionCommandTask(
  command: ProductionCommandResult,
  onTaskStatus?: (task: ProductionTaskDetail) => void,
): Promise<ProductionCommandResult> {
  if (!command.task?.taskId) {
    return command;
  }

  const config = getStoredConnectionConfig();
  const origin = getInspectionServiceOrigin(config);
  const terminalStates = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'blocked']);
  let task: ProductionTaskDetail = command.task;
  const deadline = Date.now() + 60 * 60 * 1000;
  onTaskStatus?.(task);

  while (!terminalStates.has(task.status)) {
    if (Date.now() >= deadline) {
      throw new Error(`生产任务 ${task.taskId} 在一小时内未完成`);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    const response = await fetch(
      `${origin}/api/production/tasks/detail?id=${encodeURIComponent(task.taskId)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!response.ok) {
      throw new Error(await readAdminErrorMessage(response, '生产任务状态读取失败'));
    }
    const envelope = (await response.json()) as { code: number; task: ProductionTaskDetail };
    task = envelope.task;
    onTaskStatus?.(task);
  }

  if (task.status !== 'succeeded') {
    throw new Error(task.error || `生产任务 ${task.taskId} 结束状态为 ${task.status}`);
  }

  return {
    ...command,
    ...(task.result ?? {}),
    code: task.result?.code ?? command.code ?? 0,
    materialId: task.result?.materialId ?? task.materialId ?? command.materialId,
    sessionId: task.result?.sessionId ?? task.sessionId ?? command.sessionId,
    task,
  };
}

export async function fetchTriggerGatewayStatus(signal?: AbortSignal): Promise<TriggerGatewayStatus> {
  const response = await fetch(`${getInspectionServiceOrigin()}/api/trigger/status`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '触发网关状态接口异常'));
  }
  return response.json() as Promise<TriggerGatewayStatus>;
}

export async function setTriggerGatewayMode(mode: TriggerGatewayMode): Promise<TriggerGatewayStatus> {
  const response = await fetch(`${getInspectionServiceOrigin()}/api/trigger/mode`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '触发网关模式切换失败'));
  }
  return response.json() as Promise<TriggerGatewayStatus>;
}

function mergeTriggerGatewayResult(payload: TriggerGatewayCommandResult): ProductionCommandResult {
  const service = payload.service;
  const task = service?.task;
  return {
    ...(service ?? {}),
    code: payload.code ?? service?.code ?? 503,
    materialId: service?.materialId ?? task?.materialId,
    sessionId: service?.sessionId ?? task?.sessionId,
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
  const response = await fetch(`${getInspectionServiceOrigin()}${path}`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '触发网关手动指令失败'));
  }
  const payload = (await response.json()) as TriggerGatewayCommandResult;
  return mergeTriggerGatewayResult(payload);
}

export async function triggerGatewayManualSteelInfo(input: ProductionEventInput & Record<string, unknown>): Promise<ProductionCommandResult> {
  return postTriggerGatewayManualCommand('/api/trigger/manual/steel-info', {
    ...input,
    requestId: productionRequestId('steel-info', input),
  });
}

export async function triggerGatewayManualSteelIn(input: ProductionEventInput & Record<string, unknown>): Promise<ProductionCommandResult> {
  return postTriggerGatewayManualCommand('/api/trigger/manual/steel-in', {
    ...input,
    requestId: productionRequestId('steel-in', input),
    present: true,
    value: 1,
    autoCapture: input.autoCapture ?? true,
    discardBlackFrames: input.discardBlackFrames ?? true,
  });
}

export async function triggerGatewayManualSteelOut(input: ProductionEventInput & Record<string, unknown>): Promise<ProductionCommandResult> {
  return postTriggerGatewayManualCommand('/api/trigger/manual/steel-out', {
    ...input,
    requestId: productionRequestId('steel-out', input),
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
    if (matchesLoopbackHost(remoteConfig.host) && !matchesLoopbackHost(localConfig.host)) {
      // A shared server-side connection record may still contain 127.0.0.1.
      // Keep the LAN hostname that successfully reached this service so a
      // remote browser does not redirect its next request to its own machine.
      remoteConfig.host = localConfig.host;
    }
    saveLocalConnectionConfig(remoteConfig);
    return remoteConfig;
  } catch {
    return localConfig;
  }
}

function connectionDiscoveryOrigins(config: ConnectionConfig) {
  const origins = new Set<string>();
  const configuredOrigin = import.meta.env.VITE_INSPECTION_SERVICE_ORIGIN?.trim();
  if (configuredOrigin) {
    origins.add(configuredOrigin.replace(/\/$/, ''));
  }
  if (config.host && config.port) {
    origins.add(formatServiceOrigin(config.host, config.port));
  }
  if (typeof window !== 'undefined') {
    const pageHost = window.location?.hostname?.trim();
    if (pageHost) {
      origins.add(formatServiceOrigin(pageHost, config.port || 4873));
    }
  }
  origins.add(formatServiceOrigin('127.0.0.1', config.port || 4873));
  return [...origins];
}

async function probeConnectionDiscovery(origin: string, signal?: AbortSignal): Promise<ConnectionDiscoveryResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(`${origin}/api/config/discovery`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`服务发现响应 ${response.status}`);
    }
    const payload = (await response.json()) as ConnectionDiscoveryResult;
    if (payload.schema !== 'steel.inspection-service-discovery.v1' || !Array.isArray(payload.addresses)) {
      throw new Error('服务发现响应格式不正确');
    }
    return payload;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function discoverInspectionServices(
  config = getStoredConnectionConfig(),
  signal?: AbortSignal,
): Promise<ConnectionDiscoveryResult> {
  const attempts = await Promise.allSettled(
    connectionDiscoveryOrigins(config).map((origin) => probeConnectionDiscovery(origin, signal)),
  );
  const successful = attempts
    .filter((attempt): attempt is PromiseFulfilledResult<ConnectionDiscoveryResult> => attempt.status === 'fulfilled')
    .map((attempt) => attempt.value);
  if (successful.length === 0) {
    throw new Error('未发现局域网检测服务，请确认服务已启动且防火墙允许当前端口');
  }
  const primary = successful.find((result) => result.preferred?.scope === 'lan') ?? successful[0];
  const addresses = new Map<string, DiscoveredInspectionService>();
  for (const result of successful) {
    for (const address of result.addresses) {
      addresses.set(address.origin, address);
    }
  }
  return {
    ...primary,
    addresses: [...addresses.values()].sort((left, right) => Number(right.preferred) - Number(left.preferred)),
  };
}

export async function saveConnectionConfig(config: ConnectionConfig): Promise<void> {
  if (config.mode === 'demo') {
    saveLocalConnectionConfig(config);
    return;
  }
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/config/connection`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ mode: config.mode, host: config.host, port: config.port }),
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

export type DatabaseInfo = {
  engine: string;
  requestedEngine: string;
  supportedEngines: string[];
  fallbackEnabled: boolean;
  fallbackActive: boolean;
  fallbackReason?: string | null;
  orm: string;
  path: string;
  configDir: string;
};

export async function fetchDatabaseInfo(signal?: AbortSignal): Promise<DatabaseInfo> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/database`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '数据库信息接口异常'));
  }
  return response.json() as Promise<DatabaseInfo>;
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

export async function fetchAdminRuntimeLogStatus(signal?: AbortSignal): Promise<AdminRuntimeLogStatus> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/runtime/logs`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '运行日志接口异常'));
  }
  return response.json() as Promise<AdminRuntimeLogStatus>;
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
    cache: 'no-store',
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

export async function deleteAdminRecord(id: string): Promise<AdminRecordCleanupResult> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams({ id });
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/records?${params.toString()}`, {
    method: 'DELETE',
    headers: createAdminHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '检测记录删除失败'));
  }
  return response.json() as Promise<AdminRecordCleanupResult>;
}

export async function issueInspectionReportArchive(inspectionId: string): Promise<IssuedInspectionReport> {
  const config = getStoredConnectionConfig();
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/records/reports`, {
    method: 'POST',
    headers: createAdminHeaders({ Accept: 'application/json', 'Content-Type': 'application/json' }),
    body: JSON.stringify({ inspectionId }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '检测报告签发失败'));
  }
  return response.json() as Promise<IssuedInspectionReport>;
}

export async function fetchInspectionReportArchives(inspectionId: string): Promise<InspectionReportArchivePage> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams({ inspectionId });
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/records/reports?${params.toString()}`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '检测报告归档查询失败'));
  }
  return response.json() as Promise<InspectionReportArchivePage>;
}

export async function fetchInspectionReportArchive(
  inspectionId: string,
  reportId: string,
): Promise<InspectionReportArchiveDetail> {
  const config = getStoredConnectionConfig();
  const params = new URLSearchParams({ inspectionId, reportId });
  const response = await fetch(`${getInspectionServiceOrigin(config)}/api/admin/records/reports/detail?${params.toString()}`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '检测报告归档正文读取失败'));
  }
  return response.json() as Promise<InspectionReportArchiveDetail>;
}
