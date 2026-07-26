import { useEffect, useRef, useState, type UIEvent } from 'react';
import { Activity, BellRing, Database, Download, FileClock, LogOut, Play, RefreshCw, Save, ServerCog, ShieldCheck, Square, Trash2, Users } from 'lucide-react';
import {
  applyAuditRetentionPolicy,
  applyRecordRetentionPolicy,
  changeAdminPassword,
  checkAdminDatabaseIntegrity,
  createAdminHeaders,
  createDefaultConnectionConfig,
  deleteAdminCamera,
  deleteAdminDefectType,
  deleteAdminRecord,
  deleteAdminRole,
  deleteAdminUser,
  downloadDatabaseBackup,
  exportAdminRecordsCsv,
  fetchAdminCameras,
  fetchAdminDefectTypes,
  fetchAdminDiagnostics,
  fetchAdminAlarmRules,
  fetchAdminExternalIntegrations,
  fetchAdminInspectionSettings,
  fetchAdminLoginSessions,
  fetchAdminOverview,
  fetchAdminPermissions,
  fetchAdminRecordDetail,
  fetchAdminRecords,
  fetchAdminRoles,
  fetchAdminSecurityPolicy,
  fetchAdminServices,
  fetchAdminSession,
  fetchAdminUsers,
  fetchAuditLogPage,
  fetchConfigRevisionDetail,
  fetchConfigRevisions,
  fetchConnectionConfig,
  fetchDatabaseInfo,
  exportAuditLogsCsv,
  getInspectionServiceOrigin,
  loginAdmin,
  loginAdminWithDefaultAccess,
  logoutAdmin,
  readAdminErrorMessage,
  restartCaptureService,
  restoreConfigRevision,
  revokeAdminLoginSession,
  runAdminDatabaseMaintenance,
  saveAdminAlarmRules,
  saveAdminCamera,
  saveAdminDefectType,
  saveAdminExternalIntegrations,
  saveAdminInspectionSettings,
  saveAdminRole,
  saveAdminSecurityPolicy,
  saveAdminUser,
  saveConnectionConfig,
  saveLocalConnectionConfig,
  startCaptureService,
  stopCaptureService,
  type AdminAlarmRules,
  type AdminAuthSession,
  type AdminAuditLog,
  type AdminAuditLogPage,
  type AdminAuditRetentionResult,
  type AdminCameraConfig,
  type AdminCameraConfigInput,
  type AdminConfigRevision,
  type AdminConfigRevisionDetail,
  type AdminDatabaseIntegrityResult,
  type AdminDatabaseMaintenanceResult,
  type AdminDefectType,
  type AdminDefectTypeInput,
  type AdminDiagnostics,
  type AdminExternalIntegrationEndpoint,
  type AdminExternalIntegrations,
  type AdminInspectionRecord,
  type AdminInspectionRecordDetail,
  type AdminInspectionSettings,
  type AdminInspectionRecordPage,
  type AdminLoginSession,
  type AdminOverview,
  type AdminPermission,
  type AdminRecordRetentionResult,
  type AdminRole,
  type AdminRoleInput,
  type AdminSecurityPolicy,
  type AdminSecurityPolicyInput,
  type AdminServices,
  type AdminUser,
  type AdminUserInput,
  type ConnectionConfig,
  type DatabaseInfo,
} from '../services/inspection-api';
import { Panel } from './Panel';
import { GlobalConfigurationPanel } from './GlobalConfigurationPanel';
import { checkSiteConfig } from '../services/site-config-api';

type JsonToken = {
  value: string;
  kind: 'plain' | 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punctuation';
};

function tokenizeJson(value: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const pattern = /("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\bnull\b|([{}\[\],:])/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ value: value.slice(cursor, index), kind: 'plain' });
    }
    const token = match[0];
    if (match[1]) {
      tokens.push({ value: token, kind: 'key' });
    } else if (match[2]) {
      tokens.push({ value: token, kind: 'string' });
    } else if (match[3]) {
      tokens.push({ value: token, kind: 'number' });
    } else if (match[4]) {
      tokens.push({ value: token, kind: 'boolean' });
    } else if (token === 'null') {
      tokens.push({ value: token, kind: 'null' });
    } else {
      tokens.push({ value: token, kind: 'punctuation' });
    }
    cursor = index + token.length;
  }
  if (cursor < value.length) {
    tokens.push({ value: value.slice(cursor), kind: 'plain' });
  }
  return tokens;
}

function JsonCodeEditor({
  label,
  value,
  onChange,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}) {
  const highlightRef = useRef<HTMLPreElement>(null);
  const lineNumberRef = useRef<HTMLDivElement>(null);
  const tokens = tokenizeJson(value);
  const lineCount = Math.max(1, value.split('\n').length);
  const handleScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const highlight = highlightRef.current;
    const lineNumbers = lineNumberRef.current;
    if (highlight) {
      highlight.scrollTop = event.currentTarget.scrollTop;
      highlight.scrollLeft = event.currentTarget.scrollLeft;
    }
    if (lineNumbers) {
      lineNumbers.scrollTop = event.currentTarget.scrollTop;
    }
  };

  return (
    <div className={`json-code-editor${readOnly ? ' readonly' : ''}`}>
      <div ref={lineNumberRef} className="json-code-gutter" aria-hidden="true">
        {Array.from({ length: lineCount }, (_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </div>
      <span className="json-code-language" aria-hidden="true">
        JSON
      </span>
      <div className="json-code-pane">
        <pre ref={highlightRef} className="json-code-highlight" aria-hidden="true">
          {tokens.map((token, index) => (
            <span key={`${index}-${token.kind}`} className={`json-token-${token.kind}`}>
              {token.value}
            </span>
          ))}
          {'\n'}
        </pre>
        <textarea
          className="json-code-input"
          aria-label={label}
          value={value}
          readOnly={readOnly}
          wrap="off"
          spellCheck={false}
          onScroll={handleScroll}
          onChange={(event) => onChange?.(event.target.value)}
        />
      </div>
    </div>
  );
}

function formatSteelPipeTableLabel(label: string) {
  return label.replaceAll('钢板', '钢管').replaceAll('板号', '管号');
}

function formatCameraZoneLabel(value: string) {
  if (value === '上表面') {
    return '1-3号相机';
  }
  if (value === '下表面') {
    return '4-6号相机';
  }
  return value.replaceAll('表面', '相机区');
}

async function readJsonText(path: string) {
  const response = await fetch(`${getInspectionServiceOrigin()}${path}`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, `${path} 读取失败`));
  }
  return JSON.stringify(await response.json(), null, 2);
}

async function writeJsonText(path: string, value: string) {
  JSON.parse(value);
  const response = await fetch(`${getInspectionServiceOrigin()}${path}`, {
    method: 'POST',
    headers: createAdminHeaders({ 'Content-Type': 'application/json' }),
    body: value,
  });
  if (!response.ok) {
    throw new Error(await readAdminErrorMessage(response, '采集参数保存失败'));
  }
}

function downloadBlobFile(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadTextFile(filename: string, content: string, mimeType = 'text/plain;charset=utf-8') {
  downloadBlobFile(filename, new Blob([content], { type: mimeType }));
}

function formatTimestamp(value?: string) {
  if (!value) {
    return '-';
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000_000) {
    return new Date(numeric).toLocaleString('zh-CN', { hour12: false });
  }
  return value;
}

function formatByteSize(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return '-';
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}

function formatDuration(value?: number) {
  if (!Number.isFinite(value) || !value || value < 0) {
    return '-';
  }
  const totalSeconds = Math.floor(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}时 ${minutes}分`;
  }
  if (minutes > 0) {
    return `${minutes}分 ${seconds}秒`;
  }
  return `${seconds}秒`;
}

function formatConfigKey(key: string) {
  const labels: Record<string, string> = {
    capture: '采集配置',
    connection: '连接配置',
    inspection_settings: '检测规则',
    alarm_rules: '告警规则',
    external_integrations: '外部接口',
  };
  return labels[key] ?? key;
}

function formatConfigAction(action: string) {
  const labels: Record<string, string> = {
    save: '保存',
    restore: '恢复',
  };
  return labels[action] ?? action;
}

function formatDiagnosticStatus(status?: string) {
  if (status === 'normal') {
    return '正常';
  }
  if (status === 'error') {
    return '异常';
  }
  return '关注';
}

function formatCaptureLifecycle(phase?: string) {
  const labels: Record<string, string> = {
    starting: '启动中',
    ready: '就绪',
    collecting: '采集中',
    degraded: '降级',
    stopping: '停止中',
    stopped: '已停止',
  };
  return labels[phase ?? ''] ?? '未知';
}

type ConfigDiffSummary = {
  added: number;
  removed: number;
  changed: number;
  parseError: boolean;
};

function flattenConfigValue(value: unknown, prefix = '$', output = new Map<string, string>()) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      output.set(prefix, '{}');
      return output;
    }
    entries
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([key, child]) => flattenConfigValue(child, `${prefix}.${key}`, output));
    return output;
  }
  output.set(prefix, JSON.stringify(value));
  return output;
}

function summarizeConfigDiff(currentText: string, revisionValue: unknown): ConfigDiffSummary {
  try {
    const currentValue = JSON.parse(currentText) as unknown;
    const currentMap = flattenConfigValue(currentValue);
    const revisionMap = flattenConfigValue(revisionValue);
    let added = 0;
    let removed = 0;
    let changed = 0;
    revisionMap.forEach((value, key) => {
      if (!currentMap.has(key)) {
        added += 1;
      } else if (currentMap.get(key) !== value) {
        changed += 1;
      }
    });
    currentMap.forEach((_, key) => {
      if (!revisionMap.has(key)) {
        removed += 1;
      }
    });
    return { added, removed, changed, parseError: false };
  } catch {
    return { added: 0, removed: 0, changed: 1, parseError: true };
  }
}

function formatConfigDiff(summary: ConfigDiffSummary) {
  if (summary.parseError) {
    return '当前配置无法解析，需先修正 JSON';
  }
  if (summary.added === 0 && summary.removed === 0 && summary.changed === 0) {
    return '与当前配置一致';
  }
  return `新增 ${summary.added} / 删除 ${summary.removed} / 变更 ${summary.changed}`;
}

function formatRole(role: string) {
  const labels: Record<string, string> = {
    administrator: '管理员',
    engineer: '工程师',
    operator: '操作员',
  };
  return labels[role] ?? role;
}

function createEmptyUserDraft(): AdminUserInput {
  return {
    id: '',
    displayName: '',
    role: 'operator',
    status: 'active',
    lastLoginAt: '未登录',
  };
}

function createEmptyRoleDraft(): AdminRoleInput {
  return {
    id: '',
    label: '',
    description: '',
    permissions: ['admin.overview'],
    status: 'active',
  };
}

function createEmptyCameraDraft(): AdminCameraConfigInput {
  return {
    id: '',
    name: '',
    ip: '192.168.101.100',
    driverId: 'lvm-nvt',
    modelHint: 'LVM3450CA',
    role: '采集相机',
    enabled: true,
    triggerMode: '软件触发',
    exposureUs: 850,
    gain: 1,
    depthLines: 1280,
    outputPath: 'captures/CAM-01',
  };
}

function createEmptyDefectTypeDraft(): AdminDefectTypeInput {
  return {
    id: '',
    label: '',
    color: '#ff2d3d',
    shape: 'circle',
  };
}

function createDefaultInspectionSettingsDraft(): AdminInspectionSettings {
  return {
    severeDepthMm: 0.12,
    reviewDepthMm: 0.08,
    minDefectWidthMm: 0.2,
    cameraExposureUs: 850,
    encoderPulsePerMeter: 2048,
    autoReview: true,
    alarmVolume: 86,
    saveRawImages: true,
  };
}

function createDefaultAlarmRulesDraft(): AdminAlarmRules {
  return {
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
  };
}

function createDefaultExternalIntegrationsDraft(): AdminExternalIntegrations {
  return {
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
  };
}

type ParameterSection = 'overview' | 'services' | 'data' | 'global-config' | 'config' | 'rules' | 'users' | 'permissions' | 'audit' | 'security';
type ConfigurationModuleId =
  | 'conversion'
  | 'data-source'
  | 'storage'
  | 'camera-map'
  | 'algorithm'
  | 'cameras'
  | 'capture'
  | 'trigger'
  | 'plc'
  | 'reconstruction'
  | 'versions';

type ConfigurationModule = {
  id: ConfigurationModuleId;
  label: string;
  description: string;
};

type ActiveSiteConfiguration = NonNullable<AdminOverview['siteConfiguration']>['active'];

const CONFIGURATION_MODULES: Record<ConfigurationModuleId, ConfigurationModule> = {
  conversion: { id: 'conversion', label: '数据转换', description: '旧 BKV 数据转换与兼容状态' },
  'data-source': { id: 'data-source', label: '数据源', description: '离线数据源与连接参数' },
  storage: { id: 'storage', label: '存储配置', description: '标准数据与目录数据库位置' },
  'camera-map': { id: 'camera-map', label: '相机映射', description: 'BKV 源相机到显示相机的映射' },
  algorithm: { id: 'algorithm', label: '检测算法', description: '检测阈值与数据保留策略' },
  cameras: { id: 'cameras', label: '相机直连', description: '相机驱动、网络与曝光参数' },
  capture: { id: 'capture', label: '采集管理', description: '直连相机采集服务参数' },
  trigger: { id: 'trigger', label: '触发配置', description: '编码器与线扫触发参数' },
  plc: { id: 'plc', label: 'PLC 通讯', description: '现场控制连接参数' },
  reconstruction: { id: 'reconstruction', label: '3D 重建', description: '点云与表面重建能力' },
  versions: { id: 'versions', label: '配置版本', description: '历史配置预览与恢复' },
};

function configurationModulesForSite(site?: ActiveSiteConfiguration) {
  if (site?.mode === 'direct-camera') {
    const moduleIds: ConfigurationModuleId[] = [];
    if (site.capabilities?.directCamera) moduleIds.push('cameras');
    if (site.capabilities?.captureManagement) {
      moduleIds.push('capture', 'trigger', 'plc');
    }
    moduleIds.push('storage', 'algorithm');
    if (site.capabilities?.reconstruction) moduleIds.push('reconstruction');
    moduleIds.push('versions');
    return moduleIds.map((id) => CONFIGURATION_MODULES[id]);
  }
  return [
    'conversion',
    'data-source',
    'storage',
    'camera-map',
    'algorithm',
    'versions',
  ].map((id) => CONFIGURATION_MODULES[id as ConfigurationModuleId]);
}

type ExternalIntegrationKey = 'plc' | 'l2' | 'mes';
const RECORD_PAGE_SIZE = 8;
const AUDIT_PAGE_SIZE = 8;
const FALLBACK_ADMIN_PERMISSIONS: AdminPermission[] = [
  { id: 'admin.overview', label: '总览', group: '基础', description: '查看后台总览、数据库概览和接口清单' },
  { id: 'admin.services', label: '服务管理', group: '运维', description: '查看服务状态、运行诊断并重启采集服务' },
  { id: 'admin.users', label: '账号管理', group: '安全', description: '创建、编辑和删除后台账号' },
  { id: 'admin.roles', label: '角色权限', group: '安全', description: '维护角色和权限授权目录' },
  { id: 'admin.config', label: '系统配置', group: '配置', description: '保存连接、采集配置并恢复配置版本' },
  { id: 'admin.cameras', label: '相机配置', group: '配置', description: '维护采集相机、驱动和触发参数' },
  { id: 'admin.records', label: '检测记录', group: '数据', description: '查询和导出检测记录' },
  { id: 'admin.audit', label: '审计日志', group: '审计', description: '查询和导出后台审计日志' },
];
const ADMIN_PASSWORD_POLICY_MESSAGE = '密码至少 8 位且需同时包含字母和数字';
const DEFAULT_SECURITY_POLICY_DRAFT: AdminSecurityPolicyInput = {
  auditRetentionDays: 180,
  login: {
    maxFailures: 5,
    failureWindowMinutes: 10,
    lockoutMinutes: 5,
  },
  session: {
    ttlHours: 8,
  },
};

function isValidAdminPassword(password: string) {
  return password.length >= 8
    && password.length <= 128
    && /[A-Za-z]/.test(password)
    && /\d/.test(password);
}

function createSecurityPolicyDraft(policy?: AdminSecurityPolicy | null): AdminSecurityPolicyInput {
  return {
    auditRetentionDays: policy?.auditRetentionDays ?? DEFAULT_SECURITY_POLICY_DRAFT.auditRetentionDays,
    login: {
      maxFailures: policy?.login?.maxFailures ?? DEFAULT_SECURITY_POLICY_DRAFT.login.maxFailures,
      failureWindowMinutes: policy?.login?.failureWindowMinutes ?? DEFAULT_SECURITY_POLICY_DRAFT.login.failureWindowMinutes,
      lockoutMinutes: policy?.login?.lockoutMinutes ?? DEFAULT_SECURITY_POLICY_DRAFT.login.lockoutMinutes,
    },
    session: {
      ttlHours: policy?.session?.ttlHours ?? DEFAULT_SECURITY_POLICY_DRAFT.session.ttlHours,
    },
  };
}

export function ParameterManagementApp() {
  const [authSession, setAuthSession] = useState<AdminAuthSession | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loginDraft, setLoginDraft] = useState({ userId: 'admin', password: '' });
  const [connection, setConnection] = useState<ConnectionConfig>(() => createDefaultConnectionConfig());
  const [database, setDatabase] = useState<DatabaseInfo | null>(null);
  const [databaseIntegrity, setDatabaseIntegrity] = useState<AdminDatabaseIntegrityResult | null>(null);
  const [databaseMaintenance, setDatabaseMaintenance] = useState<AdminDatabaseMaintenanceResult | null>(null);
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null);
  const [adminServices, setAdminServices] = useState<AdminServices | null>(null);
  const [adminDiagnostics, setAdminDiagnostics] = useState<AdminDiagnostics | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminRoles, setAdminRoles] = useState<AdminRole[]>([]);
  const [adminPermissions, setAdminPermissions] = useState<AdminPermission[]>(FALLBACK_ADMIN_PERMISSIONS);
  const [adminCameras, setAdminCameras] = useState<AdminCameraConfig[]>([]);
  const [adminDefectTypes, setAdminDefectTypes] = useState<AdminDefectType[]>([]);
  const [inspectionSettingsDraft, setInspectionSettingsDraft] = useState<AdminInspectionSettings>(() => createDefaultInspectionSettingsDraft());
  const [alarmRulesDraft, setAlarmRulesDraft] = useState<AdminAlarmRules>(() => createDefaultAlarmRulesDraft());
  const [externalIntegrationsDraft, setExternalIntegrationsDraft] = useState<AdminExternalIntegrations>(() => createDefaultExternalIntegrationsDraft());
  const [loginSessions, setLoginSessions] = useState<AdminLoginSession[]>([]);
  const [configRevisions, setConfigRevisions] = useState<AdminConfigRevision[]>([]);
  const [selectedRevisionDetail, setSelectedRevisionDetail] = useState<AdminConfigRevisionDetail | null>(null);
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([]);
  const [auditPage, setAuditPage] = useState<AdminAuditLogPage | null>(null);
  const [recordPage, setRecordPage] = useState<AdminInspectionRecordPage | null>(null);
  const [selectedRecordDetail, setSelectedRecordDetail] = useState<AdminInspectionRecordDetail | null>(null);
  const [activeSection, setActiveSection] = useState<ParameterSection>('overview');
  const [activeConfigurationModule, setActiveConfigurationModule] = useState<ConfigurationModuleId>('conversion');
  const [userDraft, setUserDraft] = useState<AdminUserInput>(() => createEmptyUserDraft());
  const [roleDraft, setRoleDraft] = useState<AdminRoleInput>(() => createEmptyRoleDraft());
  const [cameraDraft, setCameraDraft] = useState<AdminCameraConfigInput>(() => createEmptyCameraDraft());
  const [defectTypeDraft, setDefectTypeDraft] = useState<AdminDefectTypeInput>(() => createEmptyDefectTypeDraft());
  const [auditKeyword, setAuditKeyword] = useState('');
  const [auditLevel, setAuditLevel] = useState('all');
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditRetentionDays, setAuditRetentionDays] = useState(180);
  const [auditRetentionResult, setAuditRetentionResult] = useState<AdminAuditRetentionResult | null>(null);
  const [securityPolicy, setSecurityPolicy] = useState<AdminSecurityPolicy | null>(null);
  const [securityPolicyDraft, setSecurityPolicyDraft] = useState<AdminSecurityPolicyInput>(() => createSecurityPolicyDraft());
  const [recordKeyword, setRecordKeyword] = useState('');
  const [recordStatus, setRecordStatus] = useState('all');
  const [recordOffset, setRecordOffset] = useState(0);
  const [recordRetentionDays, setRecordRetentionDays] = useState(365);
  const [recordRetentionResult, setRecordRetentionResult] = useState<AdminRecordRetentionResult | null>(null);
  const [passwordDraft, setPasswordDraft] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [captureConfig, setCaptureConfig] = useState('');
  const [connectionConfigText, setConnectionConfigText] = useState('');
  const [message, setMessage] = useState('正在读取服务端参数');

  const refresh = async () => {
    const [nextConnection, nextDatabase, nextAdminOverview, nextAdminServices, nextAdminDiagnostics, nextAdminUsers, nextAdminRoles, nextAdminPermissions, nextAdminCameras, nextAdminDefectTypes, nextInspectionSettings, nextAlarmRules, nextExternalIntegrations, nextLoginSessions, nextConfigRevisions, nextAuditLogs, nextRecordPage, nextSecurityPolicy, nextCaptureText, nextConnectionText] = await Promise.all([
      fetchConnectionConfig().catch(() => createDefaultConnectionConfig()),
      fetchDatabaseInfo().catch((): DatabaseInfo | null => null),
      fetchAdminOverview().catch((): AdminOverview | null => null),
      fetchAdminServices().catch((): AdminServices | null => null),
      fetchAdminDiagnostics().catch((): AdminDiagnostics | null => null),
      fetchAdminUsers().catch((): AdminUser[] => []),
      fetchAdminRoles().catch((): AdminRole[] => []),
      fetchAdminPermissions().catch(() => FALLBACK_ADMIN_PERMISSIONS),
      fetchAdminCameras().catch((): AdminCameraConfig[] => []),
      fetchAdminDefectTypes().catch((): AdminDefectType[] => []),
      fetchAdminInspectionSettings().catch(() => createDefaultInspectionSettingsDraft()),
      fetchAdminAlarmRules().catch(() => createDefaultAlarmRulesDraft()),
      fetchAdminExternalIntegrations().catch(() => createDefaultExternalIntegrationsDraft()),
      fetchAdminLoginSessions().catch((): AdminLoginSession[] => []),
      fetchConfigRevisions({ limit: 30 }).catch((): AdminConfigRevision[] => []),
      fetchAuditLogPage({ limit: AUDIT_PAGE_SIZE, offset: auditOffset }).catch((): AdminAuditLogPage => ({
        total: 0,
        limit: AUDIT_PAGE_SIZE,
        offset: auditOffset,
        auditLogs: [],
      })),
      fetchAdminRecords({ limit: RECORD_PAGE_SIZE, offset: recordOffset }).catch((): AdminInspectionRecordPage => ({
        total: 0,
        limit: RECORD_PAGE_SIZE,
        offset: recordOffset,
        records: [],
      })),
      fetchAdminSecurityPolicy().catch((): AdminSecurityPolicy | null => null),
      readJsonText('/api/config'),
      readJsonText('/api/config/connection'),
    ]);
    setConnection(nextConnection);
    setDatabase(nextDatabase);
    setAdminOverview(nextAdminOverview);
    setAdminServices(nextAdminServices);
    setAdminDiagnostics(nextAdminDiagnostics);
    setAdminUsers(nextAdminUsers);
    setAdminRoles(nextAdminRoles);
    setAdminPermissions(nextAdminPermissions);
    setAdminCameras(nextAdminCameras);
    setAdminDefectTypes(nextAdminDefectTypes);
    setInspectionSettingsDraft(nextInspectionSettings);
    setAlarmRulesDraft(nextAlarmRules);
    setExternalIntegrationsDraft(nextExternalIntegrations);
    setLoginSessions(nextLoginSessions);
    setConfigRevisions(nextConfigRevisions);
    setAuditPage(nextAuditLogs);
    setAuditLogs(nextAuditLogs.auditLogs);
    setAuditOffset(nextAuditLogs.offset);
    setRecordPage(nextRecordPage);
    if (nextSecurityPolicy) {
      setSecurityPolicy(nextSecurityPolicy);
      setSecurityPolicyDraft(createSecurityPolicyDraft(nextSecurityPolicy));
      setAuditRetentionDays(nextSecurityPolicy.auditRetentionDays);
    }
    setCaptureConfig(nextCaptureText);
    setConnectionConfigText(nextConnectionText);
    setMessage('参数已同步');
  };

  useEffect(() => {
    let cancelled = false;
    fetchAdminSession()
      .then(async (session) => {
        if (session) {
          return session;
        }
        try {
          return await loginAdminWithDefaultAccess();
        } catch {
          return null;
        }
      })
      .then((session) => {
        if (cancelled) {
          return;
        }
        setAuthSession(session);
        setAuthChecked(true);
        if (session?.user.mustChangePassword) {
          setMessage('首次登录必须修改初始密码');
        } else if (session) {
          refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : '参数读取失败'));
        } else {
          setMessage('后台已设置密码，请登录');
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setAuthSession(null);
        setAuthChecked(true);
        setMessage(error instanceof Error ? error.message : '登录状态校验失败');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = async () => {
    try {
      const session = await loginAdmin(loginDraft.userId.trim(), loginDraft.password);
      setAuthSession(session);
      if (session.user.mustChangePassword) {
        setPasswordDraft((current) => ({ ...current, currentPassword: loginDraft.password }));
        setMessage('首次登录必须修改初始密码');
        return;
      }
      await refresh();
      setMessage('后台登录成功');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '后台登录失败');
    }
  };

  const logout = async () => {
    await logoutAdmin();
    setAuthSession(null);
    setAdminOverview(null);
    setAdminServices(null);
    setAdminDiagnostics(null);
    setAdminUsers([]);
    setAdminRoles([]);
    setAdminCameras([]);
    setLoginSessions([]);
    setConfigRevisions([]);
    setSelectedRevisionDetail(null);
    setAuditLogs([]);
    setAuditPage(null);
    setRecordPage(null);
    setSelectedRecordDetail(null);
    setRecordRetentionResult(null);
    setDatabaseIntegrity(null);
    setDatabaseMaintenance(null);
    setInspectionSettingsDraft(createDefaultInspectionSettingsDraft());
    setAlarmRulesDraft(createDefaultAlarmRulesDraft());
    setExternalIntegrationsDraft(createDefaultExternalIntegrationsDraft());
    setMessage('已退出后台管理');
  };

  const loadAuditLogs = async (offset = auditOffset) => {
    const nextPage = await fetchAuditLogPage({
      keyword: auditKeyword,
      level: auditLevel,
      limit: AUDIT_PAGE_SIZE,
      offset,
    });
    setAuditPage(nextPage);
    setAuditLogs(nextPage.auditLogs);
    setAuditOffset(nextPage.offset);
    return nextPage;
  };

  const saveConnection = async () => {
    try {
      const parsed = { ...createDefaultConnectionConfig(), ...(JSON.parse(connectionConfigText) as Partial<ConnectionConfig>) };
      await saveConnectionConfig(parsed);
      setConnection(parsed);
      const nextAdminOverview = await fetchAdminOverview();
      setAdminOverview(nextAdminOverview);
      setAdminDiagnostics(await fetchAdminDiagnostics());
      setConfigRevisions(await fetchConfigRevisions({ limit: 30 }));
      await loadAuditLogs(0);
      setMessage('连接参数已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '连接参数保存失败');
    }
  };

  const saveCapture = async () => {
    try {
      await writeJsonText('/api/config/capture', captureConfig);
      const nextAdminOverview = await fetchAdminOverview();
      setAdminOverview(nextAdminOverview);
      setAdminDiagnostics(await fetchAdminDiagnostics());
      setConfigRevisions(await fetchConfigRevisions({ limit: 30 }));
      await loadAuditLogs(0);
      setMessage('采集参数已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '采集参数保存失败');
    }
  };

  const controlCapture = async (action: 'start' | 'stop' | 'restart') => {
    const labels = {
      start: '启动',
      stop: '停止',
      restart: '重启',
    };
    try {
      const result = action === 'start'
        ? await startCaptureService()
        : action === 'stop'
          ? await stopCaptureService()
          : await restartCaptureService();
      setAdminServices(result.services);
      setAdminOverview(await fetchAdminOverview());
      setAdminDiagnostics(await fetchAdminDiagnostics());
      await loadAuditLogs(0);
      setMessage(result.success ? `采集服务已${labels[action]}` : `采集服务未能${labels[action]}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `采集服务${labels[action]}失败`);
    }
  };

  const previewRevision = async (revision: AdminConfigRevision) => {
    try {
      setSelectedRevisionDetail(await fetchConfigRevisionDetail(revision.id));
      setMessage(`已加载 ${revision.key} 配置版本预览`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '配置版本预览失败');
    }
  };

  const restoreRevision = async (revision: AdminConfigRevision) => {
    try {
      const result = await restoreConfigRevision(revision.id);
      const formattedConfig = JSON.stringify(result.config.value, null, 2);
      const nextAdminOverview = await fetchAdminOverview();
      const nextAdminDiagnostics = await fetchAdminDiagnostics();
      const nextConfigRevisions = await fetchConfigRevisions({ limit: 30 });
      setAdminOverview(nextAdminOverview);
      setAdminDiagnostics(nextAdminDiagnostics);
      setConfigRevisions(nextConfigRevisions);
      await loadAuditLogs(0);
      setSelectedRevisionDetail(null);
      if (result.config.key === 'capture') {
        setCaptureConfig(formattedConfig);
      }
      if (result.config.key === 'connection') {
        const restoredValue = result.config.value;
        if (!restoredValue || typeof restoredValue !== 'object' || Array.isArray(restoredValue)) {
          throw new Error('恢复的连接配置格式异常');
        }
        const parsed = { ...createDefaultConnectionConfig(), ...(restoredValue as Partial<ConnectionConfig>) };
        setConnection(parsed);
        saveLocalConnectionConfig(parsed);
        setConnectionConfigText(formattedConfig);
      }
      if (result.config.key === 'security_policy') {
        const restoredValue = result.config.value;
        if (!restoredValue || typeof restoredValue !== 'object' || Array.isArray(restoredValue)) {
          throw new Error('恢复的安全策略格式异常');
        }
        const restoredPolicy = restoredValue as AdminSecurityPolicy;
        setSecurityPolicy(restoredPolicy);
        setSecurityPolicyDraft(createSecurityPolicyDraft(restoredPolicy));
        setAuditRetentionDays(restoredPolicy.auditRetentionDays);
      }
      if (result.config.key === 'external_integrations') {
        const restoredValue = result.config.value;
        if (!restoredValue || typeof restoredValue !== 'object' || Array.isArray(restoredValue)) {
          throw new Error('恢复的外部接口配置格式异常');
        }
        setExternalIntegrationsDraft({
          ...createDefaultExternalIntegrationsDraft(),
          ...(restoredValue as Partial<AdminExternalIntegrations>),
        });
      }
      setMessage(`已恢复 ${revision.key} 配置版本`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '配置版本恢复失败');
    }
  };

  const selectUser = (user: AdminUser) => {
    setUserDraft({
      id: user.id,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      password: '',
      lastLoginAt: user.lastLoginAt,
    });
  };

  const saveUser = async () => {
    try {
      const password = userDraft.password?.trim();
      const isExistingUser = adminUsers.some((user) => user.id === userDraft.id.trim());
      if (!isExistingUser && !password) {
        setMessage('新建账号需要设置初始密码');
        return;
      }
      if (password && !isValidAdminPassword(password)) {
        setMessage(ADMIN_PASSWORD_POLICY_MESSAGE);
        return;
      }
      const savedUser = await saveAdminUser({
        ...userDraft,
        password: password ? password : undefined,
      });
      setAdminUsers((current) => {
        const existing = current.some((user) => user.id === savedUser.id);
        return existing ? current.map((user) => (user.id === savedUser.id ? savedUser : user)) : [...current, savedUser];
      });
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage('后台账号已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '后台账号保存失败');
    }
  };

  const deleteUser = async () => {
    const id = userDraft.id.trim();
    if (!id) {
      setMessage('请先选择要删除的后台账号');
      return;
    }
    if (!window.confirm(`确认删除后台账号 ${id}？`)) {
      return;
    }
    try {
      await deleteAdminUser(id);
      setAdminUsers((current) => current.filter((user) => user.id !== id));
      setUserDraft(createEmptyUserDraft());
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage('后台账号已删除');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '后台账号删除失败');
    }
  };

  const changePassword = async () => {
    try {
      if (!isValidAdminPassword(passwordDraft.newPassword)) {
        setMessage(ADMIN_PASSWORD_POLICY_MESSAGE);
        return;
      }
      if (passwordDraft.newPassword !== passwordDraft.confirmPassword) {
        setMessage('两次输入的新密码不一致');
        return;
      }
      await changeAdminPassword(
        passwordDraft.currentPassword,
        passwordDraft.newPassword,
        passwordDraft.confirmPassword,
      );
      setPasswordDraft({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setAuthSession((current) => current ? {
        ...current,
        user: { ...current.user, mustChangePassword: false },
      } : current);
      await refresh();
      await loadAuditLogs(0);
      setMessage('当前账号密码已修改');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '当前账号密码修改失败');
    }
  };

  const revokeLoginSession = async (session: AdminLoginSession) => {
    if (session.current) {
      setMessage('当前会话请使用退出登录');
      return;
    }
    if (!window.confirm(`确认撤销 ${formatTimestamp(session.createdAt)} 的登录会话？`)) {
      return;
    }
    try {
      await revokeAdminLoginSession(session.id);
      setLoginSessions((current) => current.filter((item) => item.id !== session.id));
      setAdminServices(await fetchAdminServices());
      await loadAuditLogs(0);
      setMessage('登录会话已撤销');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '登录会话撤销失败');
    }
  };

  const selectRole = (role: AdminRole) => {
    setRoleDraft({
      id: role.id,
      label: role.label,
      description: role.description,
      permissions: role.permissions,
      status: role.status,
    });
  };

  const toggleRolePermission = (permissionId: string) => {
    setRoleDraft((current) => {
      const permissions = new Set(current.permissions);
      if (permissions.has(permissionId)) {
        permissions.delete(permissionId);
      } else {
        permissions.add(permissionId);
      }
      return { ...current, permissions: Array.from(permissions) };
    });
  };

  const saveRole = async () => {
    try {
      const savedRole = await saveAdminRole(roleDraft);
      setAdminRoles((current) => {
        const existing = current.some((role) => role.id === savedRole.id);
        return existing ? current.map((role) => (role.id === savedRole.id ? savedRole : role)) : [...current, savedRole];
      });
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage('角色权限已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '角色权限保存失败');
    }
  };

  const deleteRole = async () => {
    const id = roleDraft.id.trim();
    if (!id) {
      setMessage('请先选择要删除的角色');
      return;
    }
    if (!window.confirm(`确认删除角色 ${id}？`)) {
      return;
    }
    try {
      await deleteAdminRole(id);
      setAdminRoles((current) => current.filter((role) => role.id !== id));
      setRoleDraft(createEmptyRoleDraft());
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage('角色权限已删除');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '角色权限删除失败');
    }
  };

  const selectCamera = (camera: AdminCameraConfig) => {
    setCameraDraft({ ...camera });
  };

  const saveCamera = async () => {
    try {
      const savedCamera = await saveAdminCamera(cameraDraft);
      setAdminCameras((current) => {
        const existing = current.some((camera) => camera.id === savedCamera.id);
        return existing ? current.map((camera) => (camera.id === savedCamera.id ? savedCamera : camera)) : [...current, savedCamera];
      });
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage('相机配置已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '相机配置保存失败');
    }
  };

  const deleteCamera = async () => {
    const id = cameraDraft.id.trim();
    if (!id) {
      setMessage('请先选择要删除的相机配置');
      return;
    }
    if (!window.confirm(`确认删除相机配置 ${id}？`)) {
      return;
    }
    try {
      await deleteAdminCamera(id);
      setAdminCameras((current) => current.filter((camera) => camera.id !== id));
      setCameraDraft(createEmptyCameraDraft());
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage('相机配置已删除');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '相机配置删除失败');
    }
  };

  const setInspectionNumber = (key: keyof Pick<AdminInspectionSettings, 'severeDepthMm' | 'reviewDepthMm' | 'minDefectWidthMm' | 'cameraExposureUs' | 'encoderPulsePerMeter' | 'alarmVolume'>, value: number) => {
    setInspectionSettingsDraft((current) => ({ ...current, [key]: value }));
  };

  const setInspectionBoolean = (key: keyof Pick<AdminInspectionSettings, 'autoReview' | 'saveRawImages'>, value: boolean) => {
    setInspectionSettingsDraft((current) => ({ ...current, [key]: value }));
  };

  const saveInspectionSettings = async () => {
    try {
      const savedSettings = await saveAdminInspectionSettings(inspectionSettingsDraft);
      setInspectionSettingsDraft(savedSettings);
      setConfigRevisions(await fetchConfigRevisions({ limit: 30 }));
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage('检测规则已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '检测规则保存失败');
    }
  };

  const setAlarmRuleNumber = (key: keyof Pick<AdminAlarmRules, 'severeDefectThreshold' | 'reviewDefectThreshold' | 'retainMinutes'>, value: number) => {
    setAlarmRulesDraft((current) => ({ ...current, [key]: value }));
  };

  const setAlarmRuleBoolean = (key: keyof Pick<AdminAlarmRules, 'enabled' | 'cameraOffline' | 'receiverPortFailure' | 'plcOffline' | 'l2Offline' | 'notifySound' | 'notifyBanner'>, value: boolean) => {
    setAlarmRulesDraft((current) => ({ ...current, [key]: value }));
  };

  const saveAlarmRules = async () => {
    try {
      const savedRules = await saveAdminAlarmRules(alarmRulesDraft);
      setAlarmRulesDraft(savedRules);
      setConfigRevisions(await fetchConfigRevisions({ limit: 30 }));
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage('告警规则已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '告警规则保存失败');
    }
  };

  const setExternalIntegrationField = <K extends keyof AdminExternalIntegrationEndpoint>(
    system: ExternalIntegrationKey,
    key: K,
    value: AdminExternalIntegrationEndpoint[K],
  ) => {
    setExternalIntegrationsDraft((current) => ({
      ...current,
      [system]: {
        ...current[system],
        [key]: value,
      },
    }));
  };

  const saveExternalIntegrations = async () => {
    try {
      const savedIntegrations = await saveAdminExternalIntegrations(externalIntegrationsDraft);
      setExternalIntegrationsDraft(savedIntegrations);
      setConfigRevisions(await fetchConfigRevisions({ limit: 30 }));
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage('外部系统接口已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '外部系统接口保存失败');
    }
  };

  const selectDefectType = (defectType: AdminDefectType) => {
    setDefectTypeDraft({ ...defectType });
  };

  const saveDefectType = async () => {
    try {
      const savedDefectType = await saveAdminDefectType(defectTypeDraft);
      setAdminDefectTypes((current) => {
        const existing = current.some((defectType) => defectType.id === savedDefectType.id);
        return existing
          ? current.map((defectType) => (defectType.id === savedDefectType.id ? savedDefectType : defectType))
          : [...current, savedDefectType];
      });
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage('缺陷类型已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '缺陷类型保存失败');
    }
  };

  const deleteDefectType = async () => {
    const id = defectTypeDraft.id.trim();
    if (!id) {
      setMessage('请先选择要删除的缺陷类型');
      return;
    }
    if (!window.confirm(`确认删除缺陷类型 ${id}？`)) {
      return;
    }
    try {
      await deleteAdminDefectType(id);
      setAdminDefectTypes((current) => current.filter((defectType) => defectType.id !== id));
      setDefectTypeDraft(createEmptyDefectTypeDraft());
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage('缺陷类型已删除');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '缺陷类型删除失败');
    }
  };

  const applyAuditFilter = async () => {
    try {
      const nextPage = await loadAuditLogs(0);
      setMessage(`审计日志已刷新：${nextPage.total} 条`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '审计日志查询失败');
    }
  };

  const exportAuditLogs = async () => {
    try {
      const csv = await exportAuditLogsCsv({
        keyword: auditKeyword,
        level: auditLevel,
      });
      downloadTextFile(`steel-inspection-audit-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage('审计日志 CSV 已导出');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '审计日志导出失败');
    }
  };

  const applyAuditRetention = async (dryRun: boolean) => {
    if (!Number.isFinite(auditRetentionDays) || auditRetentionDays < 1 || auditRetentionDays > 3650) {
      setMessage('审计日志保留天数需为 1-3650 天');
      return;
    }
    if (!dryRun && !window.confirm(`确认清理 ${auditRetentionDays} 天以前的审计日志？`)) {
      return;
    }
    try {
      const result = await applyAuditRetentionPolicy(auditRetentionDays, dryRun);
      setAuditRetentionResult(result);
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage(dryRun
        ? `审计日志清理预览：${result.matched} 条将被清理`
        : `审计日志已清理：${result.deleted} 条`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '审计日志保留策略执行失败');
    }
  };

  const saveSecurityPolicy = async () => {
    const validationRules: Array<[number, number, number, string]> = [
      [securityPolicyDraft.auditRetentionDays, 1, 3650, '审计日志保留天数需为 1-3650 天'],
      [securityPolicyDraft.login.maxFailures, 1, 20, '登录失败阈值需为 1-20 次'],
      [securityPolicyDraft.login.failureWindowMinutes, 1, 1440, '登录失败统计窗口需为 1-1440 分钟'],
      [securityPolicyDraft.login.lockoutMinutes, 1, 1440, '登录锁定时长需为 1-1440 分钟'],
      [securityPolicyDraft.session.ttlHours, 1, 168, '会话有效期需为 1-168 小时'],
    ];
    const invalidRule = validationRules.find(([value, min, max]) => !Number.isFinite(value) || value < min || value > max);
    if (invalidRule) {
      setMessage(invalidRule[3]);
      return;
    }
    const policyDraft: AdminSecurityPolicyInput = {
      auditRetentionDays: Math.trunc(securityPolicyDraft.auditRetentionDays),
      login: {
        maxFailures: Math.trunc(securityPolicyDraft.login.maxFailures),
        failureWindowMinutes: Math.trunc(securityPolicyDraft.login.failureWindowMinutes),
        lockoutMinutes: Math.trunc(securityPolicyDraft.login.lockoutMinutes),
      },
      session: {
        ttlHours: Math.trunc(securityPolicyDraft.session.ttlHours),
      },
    };
    try {
      const policy = await saveAdminSecurityPolicy(policyDraft);
      setSecurityPolicy(policy);
      setSecurityPolicyDraft(createSecurityPolicyDraft(policy));
      setAuditRetentionDays(policy.auditRetentionDays);
      setAdminOverview(await fetchAdminOverview());
      await loadAuditLogs(0);
      setMessage('安全策略已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '安全策略保存失败');
    }
  };

  const loadRecords = async (offset = recordOffset) => {
    try {
      const nextPage = await fetchAdminRecords({
        keyword: recordKeyword,
        status: recordStatus,
        limit: RECORD_PAGE_SIZE,
        offset,
      });
      setRecordPage(nextPage);
      setRecordOffset(nextPage.offset);
      setMessage(`检测记录已刷新：${nextPage.total} 条`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '检测记录查询失败');
    }
  };

  const applyRecordFilter = async () => {
    setRecordOffset(0);
    await loadRecords(0);
  };

  const exportRecords = async () => {
    try {
      const csv = await exportAdminRecordsCsv({
        keyword: recordKeyword,
        status: recordStatus,
      });
      downloadTextFile(`steel-inspection-records-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
      setAdminOverview(await fetchAdminOverview());
      setMessage('检测记录 CSV 已导出');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '检测记录导出失败');
    }
  };

  const applyRecordRetention = async (dryRun: boolean) => {
    if (!Number.isFinite(recordRetentionDays) || recordRetentionDays < 1 || recordRetentionDays > 3650) {
      setMessage('检测记录保留天数需为 1-3650 天');
      return;
    }
    const retentionDays = Math.trunc(recordRetentionDays);
    if (!dryRun && !window.confirm(`确认清理 ${retentionDays} 天以前的检测记录？受控目录内的采集与重建文件会先校验并删除，随后清理数据库索引；生产会话档案保留。`)) {
      return;
    }
    try {
      const result = await applyRecordRetentionPolicy(retentionDays, dryRun);
      setRecordRetentionResult(result);
      if (!dryRun) {
        setSelectedRecordDetail(null);
        await loadRecords(0);
        setAdminOverview(await fetchAdminOverview());
        setAdminDiagnostics(await fetchAdminDiagnostics());
      }
      if (authSession?.user.permissions.includes('admin.audit')) {
        await loadAuditLogs(0);
      }
      setMessage(dryRun
        ? `检测记录清理预览：${result.matched} 条，计划清理 ${result.filesPlanned} 个文件`
        : `检测记录清理完成：${result.deletedRecords}/${result.matched} 条记录，物理文件 ${result.filesDeleted} 个，失败 ${result.failures.length} 条`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '检测记录保留策略执行失败');
    }
  };

  const loadRecordDetail = async (record: AdminInspectionRecord) => {
    try {
      const detail = await fetchAdminRecordDetail(record.id);
      setSelectedRecordDetail(detail);
      setMessage(`检测记录详情已加载：${record.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '检测记录详情读取失败');
    }
  };

  const deleteRecord = async (record: AdminInspectionRecord) => {
    if (!window.confirm(`确认删除检测记录 ${record.id}？受控目录内的物理文件会先校验并删除，随后清理记录索引；生产会话档案保留。`)) {
      return;
    }
    try {
      const result = await deleteAdminRecord(record.id);
      const nextOffset = recordRows.length <= 1 ? Math.max(0, recordOffset - RECORD_PAGE_SIZE) : recordOffset;
      await loadRecords(nextOffset);
      if (selectedRecordDetail?.id === record.id) {
        setSelectedRecordDetail(null);
      }
      setAdminOverview(await fetchAdminOverview());
      if (authSession?.user.permissions.includes('admin.audit')) {
        await loadAuditLogs(0);
      }
      setMessage(`检测记录已删除：物理文件 ${result.filesDeleted}/${result.filesPlanned} 个，缺失 ${result.filesMissing} 个`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '检测记录删除失败');
    }
  };

  const backupDatabase = async () => {
    try {
      const backup = await downloadDatabaseBackup();
      downloadBlobFile(`steel-inspection-db-${new Date().toISOString().slice(0, 10)}.sqlite`, backup);
      setAdminOverview(await fetchAdminOverview());
      if (authSession?.user.permissions.includes('admin.audit')) {
        await loadAuditLogs(0);
      }
      setMessage('数据库备份已下载');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '数据库备份失败');
    }
  };

  const checkDatabaseIntegrity = async () => {
    try {
      const result = await checkAdminDatabaseIntegrity();
      setDatabaseIntegrity(result);
      setDatabaseMaintenance(null);
      setAdminOverview(await fetchAdminOverview());
      setAdminDiagnostics(await fetchAdminDiagnostics());
      if (authSession?.user.permissions.includes('admin.audit')) {
        await loadAuditLogs(0);
      }
      setMessage(result.status === 'ok' ? '数据库完整性正常' : '数据库完整性存在异常');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '数据库完整性检查失败');
    }
  };

  const maintainDatabase = async () => {
    if (!window.confirm('确认执行数据库压缩整理？执行前建议先备份数据库。')) {
      return;
    }
    try {
      const result = await runAdminDatabaseMaintenance();
      setDatabaseMaintenance(result);
      setDatabaseIntegrity({
        code: 0,
        status: result.integrity.status,
        messages: result.integrity.messages,
        stats: result.after,
        checkedAt: result.checkedAt,
      });
      setDatabase(await fetchDatabaseInfo());
      setAdminServices(await fetchAdminServices());
      setAdminOverview(await fetchAdminOverview());
      setAdminDiagnostics(await fetchAdminDiagnostics());
      if (authSession?.user.permissions.includes('admin.audit')) {
        await loadAuditLogs(0);
      }
      setMessage(`数据库维护完成，释放 ${formatByteSize(result.reclaimedBytes)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '数据库压缩整理失败');
    }
  };

  const refreshDiagnostics = async () => {
    try {
      const result = await fetchAdminDiagnostics();
      setAdminDiagnostics(result);
      setMessage(`系统自检完成：${formatDiagnosticStatus(result.status)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '系统自检失败');
    }
  };

  const checkActiveSiteConfiguration = async () => {
    const site = adminOverview?.siteConfiguration?.active;
    if (!site) return;
    setMessage('正在检查现场配置');
    try {
      await checkSiteConfig(site.id, 'default');
      setAdminOverview(await fetchAdminOverview());
      setMessage('现场配置检查完成');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '现场配置检查失败');
    }
  };

  const tableRows = adminOverview?.database.tables ?? [];
  const totalRows = tableRows.reduce((sum, table) => sum + table.rows, 0);
  const captureRunning = adminOverview?.service.capture.running ?? false;
  const overviewDiagnosticChecks = adminDiagnostics?.checks ?? [];
  const visibleDiagnosticChecks = overviewDiagnosticChecks.slice(0, 6);
  const diagnosticStatusClass = adminDiagnostics?.status === 'error'
    ? 'error'
    : adminDiagnostics?.status === 'normal'
      ? 'normal'
      : 'warning';
  const siteConfiguration = adminOverview?.siteConfiguration;
  const visibleConfigurationModules = configurationModulesForSite(siteConfiguration?.active);
  const selectedConfigurationModule = visibleConfigurationModules.some(
    (module) => module.id === activeConfigurationModule,
  )
    ? activeConfigurationModule
    : visibleConfigurationModules[0]?.id ?? 'algorithm';
  const allTabs: Array<{ id: ParameterSection; label: string }> = [
    { id: 'overview', label: '总览' },
    { id: 'services', label: '服务' },
    { id: 'data', label: '数据' },
    { id: 'global-config', label: '全局配置' },
    { id: 'config', label: '配置' },
    { id: 'rules', label: '规则' },
    { id: 'users', label: '账号' },
    { id: 'permissions', label: '权限' },
    { id: 'audit', label: '审计' },
    { id: 'security', label: '安全' },
  ];
  const tabPermissions: Partial<Record<ParameterSection, string>> = {
    overview: 'admin.overview',
    services: 'admin.services',
    data: 'admin.records',
    'global-config': 'admin.config',
    config: 'admin.config',
    rules: 'admin.config',
    users: 'admin.users',
    permissions: 'admin.roles',
    audit: 'admin.audit',
  };
  const tabs = allTabs.filter((tab) => {
    if (!authSession) {
      return false;
    }
    const permission = tabPermissions[tab.id];
    return !permission || authSession.user.permissions.includes(permission);
  });
  const canManageSecurityPolicy = authSession?.user.permissions.includes('admin.audit') ?? false;
  const canManageDefectTypes = authSession?.user.permissions.includes('admin.config') ?? false;
  const canMaintainDatabase = (authSession?.user.permissions.includes('admin.services') ?? false)
    && database?.engine === 'sqlite';
  const canDownloadDatabaseBackup = database?.engine === 'sqlite';
  const recordRows = recordPage?.records ?? [];
  const canPrevRecords = (recordPage?.offset ?? 0) > 0;
  const canNextRecords = recordPage ? recordPage.offset + recordPage.limit < recordPage.total : false;
  const auditTotal = auditPage?.total ?? auditLogs.length;
  const canPrevAudit = (auditPage?.offset ?? 0) > 0;
  const canNextAudit = auditPage ? auditPage.offset + auditPage.limit < auditPage.total : false;
  const selectedRevisionText = selectedRevisionDetail ? JSON.stringify(selectedRevisionDetail.value, null, 2) : '';
  const inspectionSettingsText = JSON.stringify(inspectionSettingsDraft, null, 2);
  const alarmRulesText = JSON.stringify(alarmRulesDraft, null, 2);
  const externalIntegrationsText = JSON.stringify(externalIntegrationsDraft, null, 2);
  const securityPolicyText = JSON.stringify(securityPolicyDraft, null, 2);
  const selectedRevisionCurrentText =
    selectedRevisionDetail?.key === 'connection'
      ? connectionConfigText
      : selectedRevisionDetail?.key === 'inspection_settings'
        ? inspectionSettingsText
        : selectedRevisionDetail?.key === 'alarm_rules'
          ? alarmRulesText
          : selectedRevisionDetail?.key === 'external_integrations'
            ? externalIntegrationsText
            : selectedRevisionDetail?.key === 'security_policy'
              ? securityPolicyText
              : captureConfig;
  const selectedRevisionDiff = selectedRevisionDetail
    ? summarizeConfigDiff(selectedRevisionCurrentText, selectedRevisionDetail.value)
    : null;

  useEffect(() => {
    if (tabs.length > 0 && !tabs.some((tab) => tab.id === activeSection)) {
      setActiveSection(tabs[0].id);
    }
  }, [activeSection, tabs]);

  if (!authChecked) {
    return (
      <main className="workspace-page parameter-page">
        <header className="parameter-header">
          <div>
            <span>服务端管理中心</span>
            <h1>后台管理</h1>
          </div>
          <div className="parameter-header-actions">
            <strong>{message}</strong>
          </div>
        </header>
      </main>
    );
  }

  if (!authSession) {
    return (
      <main className="workspace-page parameter-page">
        <header className="parameter-header">
          <div>
            <span>服务端管理中心</span>
            <h1>后台管理</h1>
          </div>
          <div className="parameter-header-actions">
            <strong>{message}</strong>
          </div>
        </header>
        <section className="parameter-login-wrap">
          <Panel title="后台登录" className="parameter-card parameter-login-card">
            <form
              className="admin-login-form"
              onSubmit={(event) => {
                event.preventDefault();
                void login();
              }}
            >
              <label>
                <span>账号</span>
                <input
                  aria-label="登录账号"
                  value={loginDraft.userId}
                  onChange={(event) => setLoginDraft((current) => ({ ...current, userId: event.target.value }))}
                />
              </label>
              <label>
                <span>密码</span>
                <input
                  aria-label="登录密码"
                  type="password"
                  placeholder="请输入账号密码"
                  value={loginDraft.password}
                  onChange={(event) => setLoginDraft((current) => ({ ...current, password: event.target.value }))}
                />
              </label>
              <button type="submit" className="primary">
                <ShieldCheck size={16} />
                登录
              </button>
            </form>
          </Panel>
        </section>
      </main>
    );
  }

  if (authSession.user.mustChangePassword) {
    return (
      <main className="workspace-page parameter-page">
        <header className="parameter-header">
          <div>
            <span>生产安全初始化</span>
            <h1>首次登录必须修改密码</h1>
          </div>
          <div className="parameter-header-actions">
            <strong>{message}</strong>
            <button type="button" onClick={() => void logout()}>
              <LogOut size={16} />
              退出
            </button>
          </div>
        </header>
        <section className="parameter-login-wrap">
          <Panel title="设置管理员新密码" className="parameter-card parameter-password-card">
            <div className="admin-password-form">
              <label>
                <span>当前初始密码</span>
                <input type="password" value={passwordDraft.currentPassword} onChange={(event) => setPasswordDraft((current) => ({ ...current, currentPassword: event.target.value }))} />
              </label>
              <label>
                <span>新密码</span>
                <input type="password" value={passwordDraft.newPassword} onChange={(event) => setPasswordDraft((current) => ({ ...current, newPassword: event.target.value }))} />
              </label>
              <label>
                <span>确认新密码</span>
                <input type="password" value={passwordDraft.confirmPassword} onChange={(event) => setPasswordDraft((current) => ({ ...current, confirmPassword: event.target.value }))} />
              </label>
              <button type="button" className="primary" onClick={() => void changePassword()}>
                <ShieldCheck size={16} />
                完成安全初始化
              </button>
            </div>
          </Panel>
        </section>
      </main>
    );
  }

  return (
    <main className="workspace-page parameter-page">
      <header className="parameter-header">
        <div>
          <span>服务端管理中心</span>
          <h1>后台管理</h1>
        </div>
        <div className="parameter-header-actions">
          <span className="admin-session-badge">
            <ShieldCheck size={15} />
            {authSession.user.displayName} / {formatRole(authSession.user.role)}
          </span>
          <strong>{message}</strong>
          <button type="button" onClick={() => refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : '刷新失败'))}>
            <RefreshCw size={16} />
            刷新
          </button>
          <button type="button" onClick={() => void logout()}>
            <LogOut size={16} />
            退出
          </button>
        </div>
      </header>

      <nav className="parameter-tabs" aria-label="后台管理分区">
        {tabs.map((tab) => (
          <button key={tab.id} type="button" className={activeSection === tab.id ? 'active' : ''} onClick={() => setActiveSection(tab.id)}>
            {tab.label}
          </button>
        ))}
      </nav>

      {activeSection === 'overview' ? (
      <section className="parameter-grid parameter-overview-grid">
        <div
          className="site-configuration-overview"
          data-testid="site-configuration-overview"
        >
          <Panel title="现场配置" className="parameter-card site-configuration-overview-card">
            <div className="site-configuration-overview-cards">
              <div>
                <span>当前现场</span>
                <strong>{siteConfiguration?.active.displayName ?? '尚未加载'}</strong>
                <div className="site-configuration-overview-meta">
                  <em>{siteConfiguration?.active.mode === 'direct-camera' ? '相机直连模式' : 'BKV 模式'}</em>
                  <em>{siteConfiguration?.active.dataSource ?? '-'}</em>
                  <em>{siteConfiguration?.active.cameraCount ?? 0} 个相机</em>
                </div>
                {siteConfiguration?.pending ? (
                  <b>待切换：{siteConfiguration.pending.displayName}</b>
                ) : null}
              </div>
              <div>
                <span>配置可用性</span>
                <div className="site-configuration-overview-meta">
                  <strong>正常 {siteConfiguration?.checkSummary.normal ?? 0}</strong>
                  <strong>关注 {siteConfiguration?.checkSummary.warning ?? 0}</strong>
                  <strong>错误 {siteConfiguration?.checkSummary.error ?? 0}</strong>
                  <strong>阻断 {siteConfiguration?.checkSummary.blocking ?? 0}</strong>
                </div>
                <em>
                  {siteConfiguration?.restartRequired
                    ? '配置已切换，等待服务重启'
                    : '当前配置已生效'}
                </em>
                <b>
                  最近检查：
                  {siteConfiguration?.checkSummary.checkedAt
                    ? formatTimestamp(String(siteConfiguration.checkSummary.checkedAt))
                    : '尚未检查'}
                </b>
              </div>
            </div>
            <div className="site-configuration-overview-actions">
              <button
                type="button"
                disabled={!siteConfiguration?.active}
                onClick={() => void checkActiveSiteConfiguration()}
              >
                检查配置
              </button>
              <button
                type="button"
                onClick={() => setActiveSection('global-config')}
              >
                进入全局配置
              </button>
            </div>
          </Panel>
        </div>

        <Panel title="服务概览" className="parameter-card parameter-service-card">
          <dl className="parameter-facts">
            <div>
              <dt>运行模式</dt>
              <dd>{connection.mode === 'online' ? '在线模式' : '演示模式'}</dd>
            </div>
            <div>
              <dt>API 服务</dt>
              <dd>
                <span className={adminOverview?.service.running ? 'status-dot online' : 'status-dot offline'} />
                {adminOverview?.service.name ?? 'steel-inspection-service'}
              </dd>
            </div>
            <div>
              <dt>采集服务</dt>
              <dd>
                <span className={captureRunning ? 'status-dot online' : 'status-dot warning'} />
                {captureRunning ? '已连接' : '模拟回退'}
              </dd>
            </div>
            <div>
              <dt>服务地址</dt>
              <dd>{connection.host}:{connection.port}</dd>
            </div>
          </dl>
        </Panel>

        <Panel title="系统自检" className="parameter-card parameter-diagnostics-card">
          <div className="admin-diagnostic-overview">
            <div className={diagnosticStatusClass}>
              <span>总体状态</span>
              <strong>{formatDiagnosticStatus(adminDiagnostics?.status)}</strong>
              <em>{formatTimestamp(adminDiagnostics?.checkedAt)}</em>
            </div>
            <div className="normal">
              <span>正常</span>
              <strong>{adminDiagnostics?.summary.normal ?? 0}</strong>
              <em>checks</em>
            </div>
            <div className="warning">
              <span>关注</span>
              <strong>{adminDiagnostics?.summary.warning ?? 0}</strong>
              <em>checks</em>
            </div>
            <div className="error">
              <span>异常</span>
              <strong>{adminDiagnostics?.summary.error ?? 0}</strong>
              <em>checks</em>
            </div>
          </div>
          <div className="admin-database-actions">
            <span>{overviewDiagnosticChecks.length > 0 ? `已完成 ${overviewDiagnosticChecks.length} 项后台自检` : '等待系统自检数据'}</span>
            <div className="admin-database-buttons">
              <button type="button" onClick={() => void refreshDiagnostics()}>
                <RefreshCw size={16} />
                重新自检
              </button>
            </div>
          </div>
          <div className="admin-diagnostic-list">
            {visibleDiagnosticChecks.length > 0 ? (
              visibleDiagnosticChecks.map((check) => (
                <div key={check.id} className={check.status === 'error' ? 'error' : check.status === 'normal' ? 'normal' : 'warning'}>
                  <Activity size={16} />
                  <strong>{check.label}</strong>
                  <span>{formatDiagnosticStatus(check.status)}</span>
                  <em>{check.detail}</em>
                </div>
              ))
            ) : (
              <div className="empty">
                <Activity size={16} />
                <strong>等待自检</strong>
                <span>关注</span>
                <em>服务端尚未返回系统自检结果</em>
              </div>
            )}
          </div>
        </Panel>

        <Panel title="数据库" className="parameter-card parameter-database-card">
          <dl className="parameter-facts">
            <div>
              <dt>引擎</dt>
              <dd>
                <span className={database?.fallbackActive ? 'status-dot warning' : 'status-dot online'} />
                {database?.engine ?? '-'}
                {database?.fallbackActive ? '（降级）' : ''}
              </dd>
            </div>
            <div>
              <dt>主数据库</dt>
              <dd>{database?.requestedEngine ?? '-'}</dd>
            </div>
            <div>
              <dt>可用适配器</dt>
              <dd>{database?.supportedEngines?.join(' / ') || '-'}</dd>
            </div>
            <div>
              <dt>数据行数</dt>
              <dd>{totalRows.toLocaleString('zh-CN')}</dd>
            </div>
          </dl>
          <div className="admin-database-actions">
            <span>{database?.path ?? '-'}</span>
            <div className="admin-database-buttons">
              <button
                type="button"
                onClick={() => void backupDatabase()}
                disabled={!canDownloadDatabaseBackup}
                title={canDownloadDatabaseBackup ? '下载 SQLite 在线快照' : '远程数据库请使用服务端备份工具'}
              >
                <Download size={16} />
                备份数据库
              </button>
              <button type="button" onClick={() => void checkDatabaseIntegrity()}>
                <ShieldCheck size={16} />
                完整性检查
              </button>
              <button type="button" onClick={() => void maintainDatabase()} disabled={!canMaintainDatabase}>
                <RefreshCw size={16} />
                压缩整理
              </button>
            </div>
          </div>
          {(databaseIntegrity || databaseMaintenance) && (
            <div className="admin-database-maintenance">
              <div>
                <span>完整性</span>
                <strong className={databaseIntegrity?.status === 'ok' ? 'ok' : 'warning'}>
                  {databaseIntegrity?.status === 'ok' ? '正常' : '需关注'}
                </strong>
              </div>
              <div>
                <span>空闲页</span>
                <strong>{databaseIntegrity?.stats.freelistCount ?? databaseMaintenance?.after.freelistCount ?? 0}</strong>
              </div>
              <div>
                <span>数据库大小</span>
                <strong>{formatByteSize(databaseIntegrity?.stats.bytes ?? databaseMaintenance?.after.bytes ?? 0)}</strong>
              </div>
              <div>
                <span>本次释放</span>
                <strong>{databaseMaintenance ? formatByteSize(databaseMaintenance.reclaimedBytes) : '-'}</strong>
              </div>
            </div>
          )}
          <div className="admin-table-metrics">
            {tableRows.map((table) => (
              <div key={table.name}>
                <span>{formatSteelPipeTableLabel(table.label)}</span>
                <strong>{table.rows}</strong>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="后台账号" className="parameter-card parameter-users-card">
          <div className="admin-user-list">
            {(adminOverview?.users ?? []).map((user) => (
              <div key={user.id}>
                <Users size={16} />
                <strong>{user.displayName}</strong>
                <span>{formatRole(user.role)}</span>
                <em>{formatTimestamp(user.lastLoginAt)}</em>
              </div>
            ))}
          </div>
        </Panel>
      </section>
      ) : null}

      {activeSection === 'services' ? (
      <section className="parameter-grid parameter-services-grid">
        <Panel title="API 服务" className="parameter-card parameter-api-service-card">
          <dl className="parameter-facts">
            <div>
              <dt>服务名</dt>
              <dd>
                <span className={adminServices?.api.running ? 'status-dot online' : 'status-dot offline'} />
                {adminServices?.api.name ?? 'steel-inspection-service'}
              </dd>
            </div>
            <div>
              <dt>语言</dt>
              <dd>{adminServices?.api.language ?? 'rust'}</dd>
            </div>
            <div>
              <dt>端口</dt>
              <dd>{adminServices?.api.port ?? '-'}</dd>
            </div>
            <div>
              <dt>在线会话</dt>
              <dd>{adminServices?.api.activeSessions ?? 0}</dd>
            </div>
            <div>
              <dt>运行时长</dt>
              <dd>{formatDuration(adminServices?.api.uptimeMs)}</dd>
            </div>
          </dl>
        </Panel>

        <Panel title="采集服务" className="parameter-card parameter-capture-service-card">
          <dl className="parameter-facts">
            <div>
              <dt>生命周期</dt>
              <dd>
                <span className={adminServices?.capture.running ? 'status-dot online' : 'status-dot warning'} />
                {formatCaptureLifecycle(adminServices?.capture.lifecycle?.phase)}
              </dd>
            </div>
            <div>
              <dt>进程</dt>
              <dd>{adminServices?.capture.lifecycle?.pid ? `PID ${adminServices.capture.lifecycle.pid}` : '无活动进程'}</dd>
            </div>
            <div>
              <dt>托管</dt>
              <dd>{adminServices?.capture.managed ? 'Rust 服务子进程' : '外部服务'}</dd>
            </div>
            <div>
              <dt>自动重启</dt>
              <dd>
                {adminServices?.capture.lifecycle?.restartBudgetExhausted
                  ? '预算已耗尽'
                  : `${adminServices?.capture.lifecycle?.restartCount ?? 0} 次 · 剩余 ${Math.max(
                    0,
                    (adminServices?.capture.lifecycle?.restartBudget ?? 0)
                      - (adminServices?.capture.lifecycle?.consecutiveFailures ?? 0),
                  )}`}
              </dd>
            </div>
          </dl>
          <div className="admin-service-actions">
            <button type="button" onClick={() => void controlCapture('start')}>
              <Play size={16} />
              启动采集服务
            </button>
            <button type="button" className="danger" onClick={() => void controlCapture('stop')}>
              <Square size={16} />
              停止采集服务
            </button>
            <button type="button" onClick={() => void controlCapture('restart')}>
              <RefreshCw size={16} />
              重启采集服务
            </button>
          </div>
        </Panel>

        <Panel title="运行路径" className="parameter-card parameter-service-path-card">
          <div className="admin-service-paths">
            <div>
              <span>数据库</span>
              <strong>{adminServices?.api.database.path ?? database?.path ?? '-'}</strong>
            </div>
            <div>
              <span>数据库大小</span>
              <strong>{formatByteSize(adminServices?.api.database.bytes ?? 0)}</strong>
            </div>
            <div>
              <span>配置目录</span>
              <strong>{adminServices?.api.database.configDir ?? database?.configDir ?? '-'}</strong>
            </div>
            <div>
              <span>采集服务地址</span>
              <strong>{adminServices?.capture.origin ?? '-'}</strong>
            </div>
            <div>
              <span>采集可执行文件</span>
              <strong>{adminServices?.capture.executable || '-'}</strong>
            </div>
          </div>
        </Panel>

        <Panel title="运行诊断" className="parameter-card parameter-diagnostics-card">
          <div className="admin-diagnostic-list">
            {(adminServices?.diagnostics ?? []).length > 0 ? (
              (adminServices?.diagnostics ?? []).map((check) => (
                <div key={check.id} className={check.status}>
                  <Activity size={16} />
                  <strong>{check.label}</strong>
                  <span>{formatDiagnosticStatus(check.status)}</span>
                  <em>{check.detail}</em>
                </div>
              ))
            ) : (
              <div className="empty">
                <Activity size={16} />
                <strong>等待诊断数据</strong>
                <span>关注</span>
                <em>服务端尚未返回运行诊断结果</em>
              </div>
            )}
          </div>
        </Panel>
      </section>
      ) : null}

      {activeSection === 'data' ? (
      <section className="parameter-grid parameter-records-grid">
        <Panel title="检测记录查询" className="parameter-card parameter-record-filter-card">
          <div className="admin-record-filter">
            <label>
              <span>管号 / 记录号</span>
              <input value={recordKeyword} placeholder="例如 202606131900" onChange={(event) => setRecordKeyword(event.target.value)} />
            </label>
            <label>
              <span>状态</span>
              <select value={recordStatus} onChange={(event) => setRecordStatus(event.target.value)}>
                <option value="all">全部</option>
                <option value="detecting">检测中</option>
                <option value="completed">已完成</option>
              </select>
            </label>
            <button type="button" onClick={() => void applyRecordFilter()}>
              <RefreshCw size={16} />
              查询
            </button>
            <button type="button" onClick={() => void exportRecords()}>
              <Download size={16} />
              导出 CSV
            </button>
            <div className="admin-record-retention">
              <label>
                <span>检测记录保留天数</span>
                <input
                  aria-label="检测记录保留天数"
                  type="number"
                  min={1}
                  max={3650}
                  value={recordRetentionDays}
                  onChange={(event) => setRecordRetentionDays(Number(event.target.value))}
                />
              </label>
              <div>
                <button type="button" onClick={() => void applyRecordRetention(true)}>
                  <FileClock size={16} />
                  预览清理
                </button>
                <button type="button" className="danger" onClick={() => void applyRecordRetention(false)}>
                  <Trash2 size={16} />
                  执行清理
                </button>
              </div>
              {recordRetentionResult ? (
                <p>
                  <strong>{recordRetentionResult.dryRun ? recordRetentionResult.matched : recordRetentionResult.deletedRecords}</strong>
                  <span>
                    {recordRetentionResult.dryRun
                      ? `条旧检测记录可清理，计划物理文件 ${recordRetentionResult.filesPlanned} 个`
                      : `条检测记录已清理，物理文件 ${recordRetentionResult.filesDeleted}/${recordRetentionResult.filesPlanned} 个，缺失 ${recordRetentionResult.filesMissing} 个，失败 ${recordRetentionResult.failures.length} 条；生产会话保留`}
                  </span>
                </p>
              ) : null}
            </div>
          </div>
        </Panel>

        <Panel title="检测记录" className="parameter-card parameter-record-table-card">
          <div className="admin-record-table-wrap">
            <table className="admin-record-table">
              <thead>
                <tr>
                  <th>记录号</th>
                  <th>管号</th>
                  <th>钢种</th>
                  <th>规格</th>
                  <th>状态</th>
                  <th>缺陷</th>
                  <th>严重 / 复核 / 轻微</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {recordRows.map((record) => (
                  <tr key={record.id}>
                    <td>{record.id}</td>
                    <td>{record.plateNo}</td>
                    <td>{record.plate?.steelGrade ?? '-'}</td>
                    <td>
                      {record.plate ? `${record.plate.widthMm} x ${record.plate.lengthMm} x ${record.plate.thicknessMm}mm` : '-'}
                    </td>
                    <td>{record.status === 'detecting' ? '检测中' : '已完成'}</td>
                    <td>{record.defectCount}</td>
                    <td>{record.severity.severe} / {record.severity.review} / {record.severity.minor}</td>
                    <td>
                      <div className="admin-record-actions">
                        <button type="button" onClick={() => void loadRecordDetail(record)}>
                          查看
                        </button>
                        <button type="button" className="danger" onClick={() => void deleteRecord(record)}>
                          <Trash2 size={15} />
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="admin-record-pager">
            <span>
              共 {recordPage?.total ?? 0} 条，当前 {recordRows.length} 条
            </span>
            <div>
              <button type="button" disabled={!canPrevRecords} onClick={() => void loadRecords(Math.max(0, recordOffset - RECORD_PAGE_SIZE))}>
                上一页
              </button>
              <button type="button" disabled={!canNextRecords} onClick={() => void loadRecords(recordOffset + RECORD_PAGE_SIZE)}>
                下一页
              </button>
            </div>
          </div>
          {selectedRecordDetail ? (
            <div className="admin-record-detail">
              <div className="admin-record-detail-head">
                <strong>{selectedRecordDetail.id} / {selectedRecordDetail.plateNo}</strong>
                <span>{selectedRecordDetail.plate?.steelGrade ?? '-'} / {selectedRecordDetail.plate ? `${selectedRecordDetail.plate.widthMm} x ${selectedRecordDetail.plate.lengthMm} x ${selectedRecordDetail.plate.thicknessMm}mm` : '-'}</span>
                <b>{selectedRecordDetail.defects.length} 条缺陷</b>
              </div>
              {selectedRecordDetail.algorithmTrace ? (
                <div className="admin-record-algorithm-trace">
                  <span>Algorithm {selectedRecordDetail.algorithmTrace.algorithmVersion ?? '-'}</span>
                  <span>Config {selectedRecordDetail.algorithmTrace.configRevision ?? '-'}</span>
                  <span>Release {selectedRecordDetail.algorithmTrace.releaseCommit?.slice(0, 12) ?? '-'}</span>
                  <span>Input {selectedRecordDetail.algorithmTrace.inputSummarySha256?.slice(0, 12) ?? '-'}</span>
                  <span>Qualification {selectedRecordDetail.algorithmTrace.acceptanceReportSha256?.slice(0, 12) ?? '-'}</span>
                  <span>Gate {selectedRecordDetail.algorithmTrace.qualityGate?.passed ? 'PASS' : 'FAIL'}</span>
                </div>
              ) : null}
              <div className="admin-record-detail-table-wrap">
                <table className="admin-record-detail-table">
                  <thead>
                    <tr>
                      <th>缺陷号</th>
                      <th>类别</th>
                      <th>相机区</th>
                      <th>等级</th>
                      <th>距头部</th>
                      <th>尺寸 mm</th>
                      <th>深度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRecordDetail.defects.length === 0 ? (
                      <tr>
                        <td colSpan={7}>暂无缺陷明细</td>
                      </tr>
                    ) : selectedRecordDetail.defects.map((defect) => (
                      <tr key={defect.id}>
                        <td>{defect.id}</td>
                        <td>{defect.typeLabel}</td>
                        <td>{formatCameraZoneLabel(defect.surface)}</td>
                        <td>{defect.severity}</td>
                        <td>{defect.distanceHeadMm}mm</td>
                        <td>{defect.widthMm.toFixed(2)} x {defect.heightMm.toFixed(2)}</td>
                        <td>{defect.depthMm.toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </Panel>

        <Panel title="缺陷类型维护" className="parameter-card parameter-defect-type-editor-card">
          <div className="admin-defect-type-form">
            <label>
              <span>类型 ID</span>
              <input
                aria-label="缺陷类型 ID"
                value={defectTypeDraft.id}
                placeholder="例如 pit_heavy"
                disabled={!canManageDefectTypes}
                onChange={(event) => setDefectTypeDraft((current) => ({ ...current, id: event.target.value.trim() }))}
              />
            </label>
            <label>
              <span>类型名称</span>
              <input
                aria-label="缺陷类型名称"
                value={defectTypeDraft.label}
                placeholder="例如 深凹坑"
                disabled={!canManageDefectTypes}
                onChange={(event) => setDefectTypeDraft((current) => ({ ...current, label: event.target.value }))}
              />
            </label>
            <label>
              <span>标记颜色</span>
              <input
                aria-label="缺陷类型颜色"
                type="color"
                value={defectTypeDraft.color}
                disabled={!canManageDefectTypes}
                onChange={(event) => setDefectTypeDraft((current) => ({ ...current, color: event.target.value }))}
              />
            </label>
            <label>
              <span>标记形状</span>
              <select
                aria-label="缺陷类型形状"
                value={defectTypeDraft.shape}
                disabled={!canManageDefectTypes}
                onChange={(event) => setDefectTypeDraft((current) => ({ ...current, shape: event.target.value }))}
              >
                <option value="circle">圆点</option>
                <option value="square">方块</option>
                <option value="rect">长条</option>
                <option value="diamond">菱形</option>
                <option value="star">星标</option>
              </select>
            </label>
            <div className="admin-defect-type-actions">
              <button type="button" disabled={!canManageDefectTypes} onClick={() => setDefectTypeDraft(createEmptyDefectTypeDraft())}>
                新建类型
              </button>
              <button type="button" className="danger" disabled={!canManageDefectTypes} onClick={() => void deleteDefectType()}>
                <Trash2 size={16} />
                删除类型
              </button>
              <button type="button" className="primary" disabled={!canManageDefectTypes} onClick={() => void saveDefectType()}>
                <Save size={16} />
                保存类型
              </button>
            </div>
          </div>
        </Panel>

        <Panel title="缺陷类型目录" className="parameter-card parameter-defect-type-list-card">
          <div className="admin-defect-type-list">
            {adminDefectTypes.map((defectType) => (
              <button key={defectType.id} type="button" onClick={() => selectDefectType(defectType)}>
                <i style={{ backgroundColor: defectType.color }} />
                <strong>{defectType.label}</strong>
                <span>{defectType.id}</span>
                <em>{defectType.shape}</em>
              </button>
            ))}
          </div>
        </Panel>
      </section>
      ) : null}

      {activeSection === 'config' ? (
      <section className="parameter-config-workspace">
        <aside
          className="parameter-config-module-nav"
          data-testid="configuration-module-navigation"
        >
          <div>
            <span>当前现场</span>
            <strong>{siteConfiguration?.active.displayName ?? '尚未加载'}</strong>
            <em>{siteConfiguration?.active.mode === 'direct-camera' ? '相机直连模式' : 'BKV 模式'}</em>
          </div>
          {visibleConfigurationModules.map((module) => (
            <button
              key={module.id}
              type="button"
              aria-label={module.label}
              className={selectedConfigurationModule === module.id ? 'active' : ''}
              onClick={() => setActiveConfigurationModule(module.id)}
            >
              <strong>{module.label}</strong>
              <span>{module.description}</span>
            </button>
          ))}
        </aside>
        <section className="parameter-config-module-detail">
        {selectedConfigurationModule === 'cameras' ? (
        <div className="parameter-config-camera-module">
        <Panel title="相机配置" className="parameter-card parameter-camera-editor-card">
          <div className="admin-camera-form">
            <label>
              <span>相机 ID</span>
              <input value={cameraDraft.id} placeholder="例如 CAM-02" onChange={(event) => setCameraDraft((current) => ({ ...current, id: event.target.value.trim() }))} />
            </label>
            <label>
              <span>名称</span>
              <input value={cameraDraft.name} placeholder="例如 2 号采集相机" onChange={(event) => setCameraDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label>
              <span>IP 地址</span>
              <input value={cameraDraft.ip} onChange={(event) => setCameraDraft((current) => ({ ...current, ip: event.target.value.trim() }))} />
            </label>
            <label>
              <span>驱动</span>
              <input value={cameraDraft.driverId} onChange={(event) => setCameraDraft((current) => ({ ...current, driverId: event.target.value.trim() }))} />
            </label>
            <label>
              <span>角色</span>
              <input value={cameraDraft.role} onChange={(event) => setCameraDraft((current) => ({ ...current, role: event.target.value }))} />
            </label>
            <label>
              <span>触发模式</span>
              <select value={cameraDraft.triggerMode} onChange={(event) => setCameraDraft((current) => ({ ...current, triggerMode: event.target.value }))}>
                <option value="软件触发">软件触发</option>
              </select>
            </label>
            <label>
              <span>曝光 us</span>
              <input type="number" value={cameraDraft.exposureUs} onChange={(event) => setCameraDraft((current) => ({ ...current, exposureUs: Number(event.target.value) }))} />
            </label>
            <label>
              <span>增益</span>
              <input type="number" step="0.1" value={cameraDraft.gain} onChange={(event) => setCameraDraft((current) => ({ ...current, gain: Number(event.target.value) }))} />
            </label>
            <label>
              <span>采集行数</span>
              <input type="number" value={cameraDraft.depthLines} onChange={(event) => setCameraDraft((current) => ({ ...current, depthLines: Number(event.target.value) }))} />
            </label>
            <label>
              <span>输出路径</span>
              <input value={cameraDraft.outputPath} onChange={(event) => setCameraDraft((current) => ({ ...current, outputPath: event.target.value }))} />
            </label>
            <label className="admin-toggle-field">
              <input type="checkbox" checked={cameraDraft.enabled} onChange={(event) => setCameraDraft((current) => ({ ...current, enabled: event.target.checked }))} />
              <span>启用相机</span>
            </label>
            <div className="admin-camera-actions">
              <button type="button" onClick={() => setCameraDraft(createEmptyCameraDraft())}>
                新建相机
              </button>
              <button type="button" className="danger" onClick={() => void deleteCamera()}>
                <Trash2 size={16} />
                删除相机
              </button>
              <button type="button" className="primary" onClick={saveCamera}>
                <Save size={16} />
                保存相机
              </button>
            </div>
          </div>
        </Panel>

        <Panel title="相机列表" className="parameter-card parameter-camera-list-card">
          <div className="admin-camera-list">
            {adminCameras.map((camera) => (
              <button key={camera.id} type="button" onClick={() => selectCamera(camera)}>
                <span className={camera.enabled ? 'status-dot online' : 'status-dot offline'} />
                <strong>{camera.name}</strong>
                <em>{camera.id} / {camera.ip}</em>
                <b>{camera.triggerMode}</b>
              </button>
            ))}
          </div>
        </Panel>
        </div>
        ) : null}

        {selectedConfigurationModule === 'algorithm' ? (
        <Panel title="检测规则" className="parameter-card parameter-inspection-settings-card">
          <div className="admin-inspection-settings-form">
            <label>
              <span>严重深度阈值 mm</span>
              <input
                aria-label="后台严重深度阈值"
                type="number"
                min={0.01}
                max={1}
                step={0.01}
                value={inspectionSettingsDraft.severeDepthMm}
                onChange={(event) => setInspectionNumber('severeDepthMm', Number(event.target.value))}
              />
            </label>
            <label>
              <span>待复核深度阈值 mm</span>
              <input
                aria-label="后台待复核深度阈值"
                type="number"
                min={0.01}
                max={1}
                step={0.01}
                value={inspectionSettingsDraft.reviewDepthMm}
                onChange={(event) => setInspectionNumber('reviewDepthMm', Number(event.target.value))}
              />
            </label>
            <label>
              <span>最小缺陷宽度 mm</span>
              <input
                aria-label="后台最小缺陷宽度"
                type="number"
                min={0.01}
                max={5}
                step={0.01}
                value={inspectionSettingsDraft.minDefectWidthMm}
                onChange={(event) => setInspectionNumber('minDefectWidthMm', Number(event.target.value))}
              />
            </label>
            <label>
              <span>相机曝光 us</span>
              <input
                aria-label="后台相机曝光时间"
                type="number"
                min={100}
                max={5000}
                step={10}
                value={inspectionSettingsDraft.cameraExposureUs}
                onChange={(event) => setInspectionNumber('cameraExposureUs', Number(event.target.value))}
              />
            </label>
            <label>
              <span>编码器脉冲 p/m</span>
              <input
                aria-label="后台编码器脉冲"
                type="number"
                min={500}
                max={10000}
                step={1}
                value={inspectionSettingsDraft.encoderPulsePerMeter}
                onChange={(event) => setInspectionNumber('encoderPulsePerMeter', Number(event.target.value))}
              />
            </label>
            <label>
              <span>报警音量</span>
              <input
                aria-label="后台报警音量"
                type="number"
                min={0}
                max={100}
                step={1}
                value={inspectionSettingsDraft.alarmVolume}
                onChange={(event) => setInspectionNumber('alarmVolume', Number(event.target.value))}
              />
            </label>
            <label className="admin-toggle-field">
              <input type="checkbox" checked={inspectionSettingsDraft.autoReview} onChange={(event) => setInspectionBoolean('autoReview', event.target.checked)} />
              <span>检测后自动进入复核队列</span>
            </label>
            <label className="admin-toggle-field">
              <input type="checkbox" checked={inspectionSettingsDraft.saveRawImages} onChange={(event) => setInspectionBoolean('saveRawImages', event.target.checked)} />
              <span>保存原始灰度与点云数据</span>
            </label>
            <div className="admin-inspection-settings-actions">
              <button type="button" onClick={() => setInspectionSettingsDraft(createDefaultInspectionSettingsDraft())}>
                恢复默认
              </button>
              <button type="button" className="primary" onClick={() => void saveInspectionSettings()}>
                <Save size={16} />
                保存规则
              </button>
            </div>
          </div>
        </Panel>
        ) : null}

        {selectedConfigurationModule === 'versions' ? (
        <Panel title="配置版本" className="parameter-card parameter-config-revision-card">
          <div className="admin-config-revision-list">
            {configRevisions.length === 0 ? (
              <div className="admin-empty-state">暂无配置版本</div>
            ) : configRevisions.map((revision) => (
              <div key={revision.id} className={`admin-config-revision ${revision.action}`}>
                <FileClock size={16} />
                <strong>{formatConfigKey(revision.key)}</strong>
                <span>{formatConfigAction(revision.action)}</span>
                <em>{revision.actor} / {formatTimestamp(revision.createdAt)} / {formatByteSize(revision.bytes)}</em>
                <button type="button" onClick={() => void previewRevision(revision)}>
                  预览
                </button>
                <button type="button" onClick={() => void restoreRevision(revision)}>
                  恢复
                </button>
              </div>
            ))}
          </div>
          {selectedRevisionDetail ? (
            <div className="admin-config-revision-preview">
              <div className="admin-config-revision-preview-head">
                <strong>{formatConfigKey(selectedRevisionDetail.key)} / {selectedRevisionDetail.id}</strong>
                <span>{selectedRevisionDiff ? formatConfigDiff(selectedRevisionDiff) : '-'}</span>
              </div>
              <JsonCodeEditor
                label="配置版本预览 JSON"
                value={selectedRevisionText}
                readOnly
              />
            </div>
          ) : null}
        </Panel>
        ) : null}

        {selectedConfigurationModule === 'data-source' || selectedConfigurationModule === 'plc' ? (
        <Panel title="连接配置 JSON" className="parameter-editor-card parameter-connection-editor">
          <div className="parameter-editor-toolbar">
            <ServerCog size={18} />
            <button type="button" onClick={saveConnection}>
              <Save size={16} />
              保存连接
            </button>
          </div>
          <JsonCodeEditor label="连接配置 JSON" value={connectionConfigText} onChange={setConnectionConfigText} />
        </Panel>
        ) : null}

        {selectedConfigurationModule === 'capture' ? (
        <Panel title="采集配置 JSON" className="parameter-editor-card parameter-capture-editor">
          <div className="parameter-editor-toolbar">
            <Database size={18} />
            <button type="button" onClick={saveCapture}>
              <Save size={16} />
              保存采集
            </button>
          </div>
          <JsonCodeEditor label="采集配置 JSON" value={captureConfig} onChange={setCaptureConfig} />
        </Panel>
        ) : null}

        {selectedConfigurationModule === 'conversion' ? (
          <Panel title="BKV 数据转换" className="parameter-card parameter-config-info-card">
            <div className="parameter-config-module-info">
              <strong>当前使用独立 BKV 转换服务</strong>
              <span>转换目录、任务进度与兼容参数统一在“全局配置”的运行配置兼容编辑器中维护。</span>
              <button type="button" onClick={() => setActiveSection('global-config')}>进入全局配置</button>
            </div>
          </Panel>
        ) : null}

        {selectedConfigurationModule === 'storage' ? (
          <Panel title="存储配置" className="parameter-card parameter-config-info-card">
            <div className="parameter-config-module-info">
              <strong>{siteConfiguration?.active.mode === 'bkv' ? '标准数据与转换目录' : '在线检测数据目录'}</strong>
              <span>存储位置属于现场配置包；请在全局配置中选择现场后进行兼容参数维护。</span>
              <button type="button" onClick={() => setActiveSection('global-config')}>进入全局配置</button>
            </div>
          </Panel>
        ) : null}

        {selectedConfigurationModule === 'camera-map' ? (
          <Panel title="BKV 相机映射" className="parameter-card parameter-config-info-card">
            <div className="parameter-config-module-info">
              <strong>{siteConfiguration?.active.cameraCount ?? 0} 个显示相机</strong>
              <span>映射由活动现场配置包的 runtime.json 管理，不使用在线相机目录。</span>
              <button type="button" onClick={() => setActiveSection('global-config')}>查看现场配置</button>
            </div>
          </Panel>
        ) : null}

        {selectedConfigurationModule === 'trigger' ? (
          <Panel title="触发配置" className="parameter-card parameter-config-info-card">
            <div className="parameter-config-module-info">
              <strong>线扫触发与编码器参数</strong>
              <span>触发参数由直连采集服务和现场配置共同提供，保存后随采集服务重新加载。</span>
            </div>
          </Panel>
        ) : null}

        {selectedConfigurationModule === 'reconstruction' ? (
          <Panel title="3D 重建" className="parameter-card parameter-config-info-card">
            <div className="parameter-config-module-info">
              <strong>当前现场已启用 3D 重建能力</strong>
              <span>重建服务参数由当前直连现场配置包管理。</span>
            </div>
          </Panel>
        ) : null}
        </section>
      </section>
      ) : null}

      {activeSection === 'global-config' ? (
        <GlobalConfigurationPanel
          canEdit={authSession.user.permissions.includes('admin.config')}
        />
      ) : null}

      {activeSection === 'rules' ? (
      <section className="parameter-grid parameter-rules-grid">
        <Panel title="告警规则" className="parameter-card parameter-alarm-rules-card">
          <div className="admin-alarm-rules-form">
            <label>
              <span>严重缺陷告警数</span>
              <input
                aria-label="后台严重缺陷告警数"
                type="number"
                min={1}
                max={100}
                step={1}
                value={alarmRulesDraft.severeDefectThreshold}
                onChange={(event) => setAlarmRuleNumber('severeDefectThreshold', Number(event.target.value))}
              />
            </label>
            <label>
              <span>待复核缺陷告警数</span>
              <input
                aria-label="后台待复核缺陷告警数"
                type="number"
                min={1}
                max={200}
                step={1}
                value={alarmRulesDraft.reviewDefectThreshold}
                onChange={(event) => setAlarmRuleNumber('reviewDefectThreshold', Number(event.target.value))}
              />
            </label>
            <label>
              <span>告警保留分钟</span>
              <input
                aria-label="后台告警保留分钟"
                type="number"
                min={1}
                max={1440}
                step={1}
                value={alarmRulesDraft.retainMinutes}
                onChange={(event) => setAlarmRuleNumber('retainMinutes', Number(event.target.value))}
              />
            </label>
            <label className="admin-toggle-field">
              <input aria-label="后台启用告警规则" type="checkbox" checked={alarmRulesDraft.enabled} onChange={(event) => setAlarmRuleBoolean('enabled', event.target.checked)} />
              <span>启用告警规则</span>
            </label>
            <label className="admin-toggle-field">
              <input aria-label="后台相机离线告警" type="checkbox" checked={alarmRulesDraft.cameraOffline} onChange={(event) => setAlarmRuleBoolean('cameraOffline', event.target.checked)} />
              <span>相机离线告警</span>
            </label>
            <label className="admin-toggle-field">
              <input aria-label="后台收发器端口异常告警" type="checkbox" checked={alarmRulesDraft.receiverPortFailure} onChange={(event) => setAlarmRuleBoolean('receiverPortFailure', event.target.checked)} />
              <span>收发器端口异常</span>
            </label>
            <label className="admin-toggle-field">
              <input aria-label="后台PLC异常告警" type="checkbox" checked={alarmRulesDraft.plcOffline} onChange={(event) => setAlarmRuleBoolean('plcOffline', event.target.checked)} />
              <span>PLC 异常告警</span>
            </label>
            <label className="admin-toggle-field">
              <input aria-label="后台L2异常告警" type="checkbox" checked={alarmRulesDraft.l2Offline} onChange={(event) => setAlarmRuleBoolean('l2Offline', event.target.checked)} />
              <span>L2 异常告警</span>
            </label>
            <label className="admin-toggle-field">
              <input aria-label="后台声音提醒" type="checkbox" checked={alarmRulesDraft.notifySound} onChange={(event) => setAlarmRuleBoolean('notifySound', event.target.checked)} />
              <span>声音提醒</span>
            </label>
            <label className="admin-toggle-field">
              <input aria-label="后台横幅提醒" type="checkbox" checked={alarmRulesDraft.notifyBanner} onChange={(event) => setAlarmRuleBoolean('notifyBanner', event.target.checked)} />
              <span>界面横幅提醒</span>
            </label>
            <div className="admin-alarm-rules-actions">
              <button type="button" onClick={() => setAlarmRulesDraft(createDefaultAlarmRulesDraft())}>
                恢复默认
              </button>
              <button type="button" className="primary" onClick={() => void saveAlarmRules()}>
                <Save size={16} />
                保存告警
              </button>
            </div>
          </div>
        </Panel>

        <Panel title="规则摘要" className="parameter-card parameter-alarm-summary-card">
          <div className="admin-alarm-summary">
            <div className={alarmRulesDraft.enabled ? 'active' : 'muted'}>
              <span>规则状态</span>
              <strong>{alarmRulesDraft.enabled ? '启用' : '停用'}</strong>
            </div>
            <div>
              <span>严重缺陷</span>
              <strong>{alarmRulesDraft.severeDefectThreshold} 个触发</strong>
            </div>
            <div>
              <span>待复核缺陷</span>
              <strong>{alarmRulesDraft.reviewDefectThreshold} 个触发</strong>
            </div>
            <div>
              <span>保留时间</span>
              <strong>{alarmRulesDraft.retainMinutes} 分钟</strong>
            </div>
          </div>
          <div className="admin-alarm-switches">
            {([
              ['相机离线', alarmRulesDraft.cameraOffline],
              ['收发器端口', alarmRulesDraft.receiverPortFailure],
              ['PLC', alarmRulesDraft.plcOffline],
              ['L2', alarmRulesDraft.l2Offline],
              ['声音', alarmRulesDraft.notifySound],
              ['横幅', alarmRulesDraft.notifyBanner],
            ] as Array<[string, boolean]>).map(([label, enabled]) => (
              <span key={String(label)} className={enabled ? 'on' : 'off'}>
                <BellRing size={15} />
                {label}
              </span>
            ))}
          </div>
        </Panel>

        <Panel title="外部系统接口" className="parameter-card parameter-external-integrations-card">
          <div className="admin-external-integrations-form">
            {([
              ['plc', 'PLC'],
              ['l2', 'L2'],
              ['mes', 'MES'],
            ] as Array<[ExternalIntegrationKey, string]>).map(([system, label]) => {
              const endpoint = externalIntegrationsDraft[system];
              return (
                <div key={system} className="admin-external-integration">
                  <div className="admin-external-integration-head">
                    <strong>{label}</strong>
                    <label className="admin-toggle-field">
                      <input
                        aria-label={`后台${label}接口启用`}
                        type="checkbox"
                        checked={endpoint.enabled}
                        onChange={(event) => setExternalIntegrationField(system, 'enabled', event.target.checked)}
                      />
                      <span>启用</span>
                    </label>
                  </div>
                  <label>
                    <span>协议</span>
                    <select
                      aria-label={`后台${label}接口协议`}
                      value={endpoint.protocol}
                      onChange={(event) => setExternalIntegrationField(system, 'protocol', event.target.value)}
                    >
                      <option value="modbus-tcp">Modbus TCP</option>
                      <option value="tcp">TCP</option>
                      <option value="http-json">HTTP JSON</option>
                      <option value="http">HTTP</option>
                    </select>
                  </label>
                  <label>
                    <span>主机</span>
                    <input
                      aria-label={`后台${label}接口主机`}
                      value={endpoint.host}
                      onChange={(event) => setExternalIntegrationField(system, 'host', event.target.value)}
                    />
                  </label>
                  <label>
                    <span>端口</span>
                    <input
                      aria-label={`后台${label}接口端口`}
                      type="number"
                      min={1}
                      max={65535}
                      value={endpoint.port}
                      onChange={(event) => setExternalIntegrationField(system, 'port', Number(event.target.value))}
                    />
                  </label>
                  <label>
                    <span>路径</span>
                    <input
                      aria-label={`后台${label}接口路径`}
                      value={endpoint.path}
                      onChange={(event) => setExternalIntegrationField(system, 'path', event.target.value)}
                    />
                  </label>
                  <label>
                    <span>超时 ms</span>
                    <input
                      aria-label={`后台${label}接口超时`}
                      type="number"
                      min={100}
                      max={60000}
                      value={endpoint.timeoutMs}
                      onChange={(event) => setExternalIntegrationField(system, 'timeoutMs', Number(event.target.value))}
                    />
                  </label>
                  <label>
                    <span>重试 ms</span>
                    <input
                      aria-label={`后台${label}接口重试间隔`}
                      type="number"
                      min={100}
                      max={300000}
                      value={endpoint.retryIntervalMs}
                      onChange={(event) => setExternalIntegrationField(system, 'retryIntervalMs', Number(event.target.value))}
                    />
                  </label>
                </div>
              );
            })}
            <div className="admin-external-integrations-actions">
              <button type="button" onClick={() => setExternalIntegrationsDraft(createDefaultExternalIntegrationsDraft())}>
                恢复默认
              </button>
              <button type="button" className="primary" onClick={() => void saveExternalIntegrations()}>
                <Save size={16} />
                保存接口
              </button>
            </div>
          </div>
        </Panel>
      </section>
      ) : null}

      {activeSection === 'users' ? (
      <section className="parameter-grid parameter-users-grid">
        <Panel title="账号编辑" className="parameter-card parameter-user-editor-card">
          <div className="admin-user-form">
            <label>
              <span>账号 ID</span>
              <input
                value={userDraft.id}
                placeholder="例如 inspector"
                onChange={(event) => setUserDraft((current) => ({ ...current, id: event.target.value.trim() }))}
              />
            </label>
            <label>
              <span>显示名称</span>
              <input
                value={userDraft.displayName}
                placeholder="例如 检测主管"
                onChange={(event) => setUserDraft((current) => ({ ...current, displayName: event.target.value }))}
              />
            </label>
            <label>
              <span>角色</span>
              <select value={userDraft.role} onChange={(event) => setUserDraft((current) => ({ ...current, role: event.target.value }))}>
                {adminRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>状态</span>
              <select value={userDraft.status} onChange={(event) => setUserDraft((current) => ({ ...current, status: event.target.value }))}>
                <option value="active">启用</option>
                <option value="disabled">停用</option>
              </select>
            </label>
            <label>
              <span>重置密码</span>
              <input
                type="password"
                value={userDraft.password ?? ''}
                placeholder="留空则不修改"
                onChange={(event) => setUserDraft((current) => ({ ...current, password: event.target.value }))}
              />
            </label>
            <label>
              <span>最近登录</span>
              <input
                value={userDraft.lastLoginAt}
                onChange={(event) => setUserDraft((current) => ({ ...current, lastLoginAt: event.target.value }))}
              />
            </label>
            <div className="admin-user-actions">
              <button type="button" onClick={() => setUserDraft(createEmptyUserDraft())}>
                新建账号
              </button>
              <button type="button" className="danger" onClick={() => void deleteUser()}>
                <Trash2 size={16} />
                删除账号
              </button>
              <button type="button" className="primary" onClick={saveUser}>
                <Save size={16} />
                保存账号
              </button>
            </div>
          </div>
        </Panel>

        <Panel title="后台账号" className="parameter-card parameter-users-card">
          <div className="admin-user-list interactive">
            {adminUsers.map((user) => (
              <button key={user.id} type="button" onClick={() => selectUser(user)}>
                <Users size={16} />
                <strong>{user.displayName}</strong>
                <span>{formatRole(user.role)} / {user.status === 'active' ? '启用' : '停用'}</span>
                <em>{formatTimestamp(user.lastLoginAt)}</em>
              </button>
            ))}
          </div>
        </Panel>
      </section>
      ) : null}

      {activeSection === 'security' ? (
      <section className="parameter-grid parameter-security-grid">
        <Panel title="当前账号安全" className="parameter-card parameter-password-card">
          <div className="admin-password-form">
            <label>
              <span>当前密码</span>
              <input
                type="password"
                value={passwordDraft.currentPassword}
                onChange={(event) => setPasswordDraft((current) => ({ ...current, currentPassword: event.target.value }))}
              />
            </label>
            <label>
              <span>新密码</span>
              <input
                type="password"
                value={passwordDraft.newPassword}
                onChange={(event) => setPasswordDraft((current) => ({ ...current, newPassword: event.target.value }))}
              />
            </label>
            <label>
              <span>确认新密码</span>
              <input
                type="password"
                value={passwordDraft.confirmPassword}
                onChange={(event) => setPasswordDraft((current) => ({ ...current, confirmPassword: event.target.value }))}
              />
            </label>
            <button type="button" className="primary" onClick={() => void changePassword()}>
              <ShieldCheck size={16} />
              修改密码
            </button>
          </div>
        </Panel>
        <Panel title="登录会话" className="parameter-card parameter-session-card">
          <div className="admin-session-list">
            {loginSessions.length === 0 ? (
              <div className="admin-empty-state">暂无登录会话</div>
            ) : loginSessions.map((session) => (
              <div key={session.id} className={session.current ? 'current' : ''}>
                <ShieldCheck size={16} />
                <strong>{session.current ? '当前会话' : '其他会话'}</strong>
                <span>{formatTimestamp(session.createdAt)} 至 {formatTimestamp(session.expiresAt)}</span>
                <em>{session.userAgent}</em>
                <button type="button" disabled={session.current} onClick={() => void revokeLoginSession(session)}>
                  {session.current ? '使用中' : '撤销'}
                </button>
              </div>
            ))}
          </div>
        </Panel>
        {canManageSecurityPolicy ? (
          <Panel title="安全策略" className="parameter-card parameter-security-policy-card">
            <div className="admin-audit-filter">
              <label>
                <span>审计保留默认天数</span>
                <input
                  aria-label="审计保留默认天数"
                  type="number"
                  min={securityPolicy?.limits?.minAuditRetentionDays ?? 1}
                  max={securityPolicy?.limits?.maxAuditRetentionDays ?? 3650}
                  value={securityPolicyDraft.auditRetentionDays}
                  onChange={(event) => setSecurityPolicyDraft((current) => ({
                    ...current,
                    auditRetentionDays: Number(event.target.value),
                  }))}
                />
              </label>
              <label>
                <span>登录失败阈值</span>
                <input
                  aria-label="登录失败阈值"
                  type="number"
                  min={securityPolicy?.limits?.minLoginMaxFailures ?? 1}
                  max={securityPolicy?.limits?.maxLoginMaxFailures ?? 20}
                  value={securityPolicyDraft.login.maxFailures}
                  onChange={(event) => setSecurityPolicyDraft((current) => ({
                    ...current,
                    login: { ...current.login, maxFailures: Number(event.target.value) },
                  }))}
                />
              </label>
              <label>
                <span>失败统计窗口 min</span>
                <input
                  aria-label="失败统计窗口分钟"
                  type="number"
                  min={securityPolicy?.limits?.minLoginWindowMinutes ?? 1}
                  max={securityPolicy?.limits?.maxLoginWindowMinutes ?? 1440}
                  value={securityPolicyDraft.login.failureWindowMinutes}
                  onChange={(event) => setSecurityPolicyDraft((current) => ({
                    ...current,
                    login: { ...current.login, failureWindowMinutes: Number(event.target.value) },
                  }))}
                />
              </label>
              <label>
                <span>锁定时长 min</span>
                <input
                  aria-label="登录锁定时长分钟"
                  type="number"
                  min={securityPolicy?.limits?.minLoginLockoutMinutes ?? 1}
                  max={securityPolicy?.limits?.maxLoginLockoutMinutes ?? 1440}
                  value={securityPolicyDraft.login.lockoutMinutes}
                  onChange={(event) => setSecurityPolicyDraft((current) => ({
                    ...current,
                    login: { ...current.login, lockoutMinutes: Number(event.target.value) },
                  }))}
                />
              </label>
              <label>
                <span>会话有效期 h</span>
                <input
                  aria-label="会话有效期小时"
                  type="number"
                  min={securityPolicy?.limits?.minSessionTtlHours ?? 1}
                  max={securityPolicy?.limits?.maxSessionTtlHours ?? 168}
                  value={securityPolicyDraft.session.ttlHours}
                  onChange={(event) => setSecurityPolicyDraft((current) => ({
                    ...current,
                    session: { ttlHours: Number(event.target.value) },
                  }))}
                />
              </label>
              <button type="button" className="primary" onClick={() => void saveSecurityPolicy()}>
                <Save size={16} />
                保存策略
              </button>
            </div>
            <div className="admin-api-summary">
              <ShieldCheck size={16} />
              <strong>{securityPolicy?.login?.maxFailures ?? '-'}</strong>
              <span>
                次失败锁定 {securityPolicy?.login?.lockoutMinutes ?? '-'} 分钟 / 会话 {securityPolicy?.session?.ttlHours ?? '-'} 小时 / 来源 {securityPolicy?.source ?? '-'}
              </span>
            </div>
          </Panel>
        ) : null}
      </section>
      ) : null}

      {activeSection === 'permissions' ? (
      <section className="parameter-grid parameter-permissions-grid">
        <Panel title="角色编辑" className="parameter-card parameter-role-editor-card">
          <div className="admin-role-form">
            <label>
              <span>角色 ID</span>
              <input value={roleDraft.id} placeholder="例如 reviewer" onChange={(event) => setRoleDraft((current) => ({ ...current, id: event.target.value.trim() }))} />
            </label>
            <label>
              <span>角色名称</span>
              <input value={roleDraft.label} placeholder="例如 复核员" onChange={(event) => setRoleDraft((current) => ({ ...current, label: event.target.value }))} />
            </label>
            <label>
              <span>说明</span>
              <input value={roleDraft.description} placeholder="角色职责说明" onChange={(event) => setRoleDraft((current) => ({ ...current, description: event.target.value }))} />
            </label>
            <label>
              <span>状态</span>
              <select value={roleDraft.status} onChange={(event) => setRoleDraft((current) => ({ ...current, status: event.target.value }))}>
                <option value="active">启用</option>
                <option value="disabled">停用</option>
              </select>
            </label>
            <div className="admin-permission-grid">
              {adminPermissions.map((permission) => (
                <label key={permission.id} className="admin-permission-option">
                  <input
                    type="checkbox"
                    aria-label={permission.label}
                    checked={roleDraft.permissions.includes(permission.id)}
                    onChange={() => toggleRolePermission(permission.id)}
                  />
                  <span>{permission.label}</span>
                  <em>{permission.group} / {permission.description}</em>
                </label>
              ))}
            </div>
            <div className="admin-role-actions">
              <button type="button" onClick={() => setRoleDraft(createEmptyRoleDraft())}>
                新建角色
              </button>
              <button type="button" className="danger" onClick={() => void deleteRole()}>
                <Trash2 size={16} />
                删除角色
              </button>
              <button type="button" className="primary" onClick={saveRole}>
                <Save size={16} />
                保存角色
              </button>
            </div>
          </div>
        </Panel>

        <Panel title="角色列表" className="parameter-card parameter-role-list-card">
          <div className="admin-role-list">
            {adminRoles.map((role) => (
              <button key={role.id} type="button" onClick={() => selectRole(role)}>
                <strong>{role.label}</strong>
                <span>{role.id} / {role.status === 'active' ? '启用' : '停用'}</span>
                <em>{role.permissions.length} 项权限</em>
              </button>
            ))}
          </div>
        </Panel>
      </section>
      ) : null}

      {activeSection === 'audit' ? (
      <section className="parameter-grid parameter-audit-grid">
        <Panel title="审计筛选" className="parameter-card parameter-audit-filter-card">
          <div className="admin-audit-filter">
            <label>
              <span>关键字</span>
              <input value={auditKeyword} placeholder="账号、动作、目标或内容" onChange={(event) => setAuditKeyword(event.target.value)} />
            </label>
            <label>
              <span>等级</span>
              <select value={auditLevel} onChange={(event) => setAuditLevel(event.target.value)}>
                <option value="all">全部</option>
                <option value="info">信息</option>
                <option value="warning">警告</option>
                <option value="error">错误</option>
              </select>
            </label>
            <button type="button" onClick={applyAuditFilter}>
              <RefreshCw size={16} />
              查询
            </button>
            <button type="button" onClick={() => void exportAuditLogs()}>
              <Download size={16} />
              导出 CSV
            </button>
            <label>
              <span>保留天数</span>
              <input
                type="number"
                min={1}
                max={3650}
                value={auditRetentionDays}
                onChange={(event) => setAuditRetentionDays(Number(event.target.value))}
              />
            </label>
            <button type="button" onClick={() => void applyAuditRetention(true)}>
              <FileClock size={16} />
              预览清理
            </button>
            <button type="button" className="danger" onClick={() => void applyAuditRetention(false)}>
              <Trash2 size={16} />
              清理旧日志
            </button>
          </div>
          {auditRetentionResult ? (
            <div className="admin-api-summary">
              <FileClock size={16} />
              <strong>{auditRetentionResult.dryRun ? auditRetentionResult.matched : auditRetentionResult.deleted}</strong>
              <span>{auditRetentionResult.dryRun ? '条旧审计日志可清理' : `条旧审计日志已清理，保留 ${auditRetentionResult.retentionDays} 天`}</span>
            </div>
          ) : null}
        </Panel>

        <Panel title="审计日志" className="parameter-card parameter-audit-card">
          <div className="admin-audit-list">
            {auditLogs.map((entry) => (
              <div key={entry.id} className={entry.level}>
                <FileClock size={16} />
                <span>{formatTimestamp(entry.createdAt)}</span>
                <strong>{entry.detail}</strong>
                <em>{entry.actor} / {entry.target}</em>
              </div>
            ))}
          </div>
          <div className="admin-record-pager admin-audit-pager">
            <span>共 {auditTotal} 条 / 第 {Math.floor((auditPage?.offset ?? 0) / AUDIT_PAGE_SIZE) + 1} 页</span>
            <div>
              <button type="button" disabled={!canPrevAudit} onClick={() => void loadAuditLogs(Math.max(0, auditOffset - AUDIT_PAGE_SIZE))}>
                上一页
              </button>
              <button type="button" disabled={!canNextAudit} onClick={() => void loadAuditLogs(auditOffset + AUDIT_PAGE_SIZE)}>
                下一页
              </button>
            </div>
          </div>
          <div className="admin-api-summary">
            <Activity size={16} />
            <strong>{adminOverview?.apiRoutes.length ?? 0}</strong>
            <span>个后台接口已纳入管理概览</span>
          </div>
        </Panel>
      </section>
      ) : null}
    </main>
  );
}
