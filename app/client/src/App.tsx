import { useEffect, useMemo, useRef, useState } from 'react';
import { PanelRightOpen, X } from 'lucide-react';
import { getAllDefects, getPlateInspectionSnapshot, summarizeDefects } from './data/inspection';
import type { DefectItem, InspectionSnapshot, Severity } from './data/inspection';
import type { InspectionUiState } from './state/inspection-ui';
import {
  createInitialUiState,
  persistTheme,
  persistThemeStyle,
  readStoredTheme,
  readStoredThemeStyle,
  filterDefectsBySurfaceMode,
  getPageCount,
  getVisibleDefects,
  paginateItems,
  selectRecord,
  selectDefect,
  clampPreviewPositionM,
  toggleDefectType,
} from './state/inspection-ui';
import {
  applyInspectionSettingsToDefects,
  createDefaultReportFilters,
  createDefaultSettings,
  createInitialOperationState,
  createReportMetadata,
  exportReportAsJson,
  exportRowsAsCsv,
  filterDefectsForReport,
  getDeviceStatusWithOperation,
  getReportMetrics,
  runSystemAction,
  validateSettings,
} from './state/operations';
import type { InspectionSettings, ReportFilters, SystemAction } from './state/operations';
import { emptyRecordSearchFilters, filterInspectionRecords } from './state/record-search';
import type { RecordSearchFilters } from './state/record-search';
import { getResponsiveProfile, getResponsiveProfileClassName } from './state/responsive-layout';
import {
  useAppResourceUsage,
  type AppResourceUsageState,
} from './hooks/use-app-resource-usage';
import {
  createDefaultConnectionConfig,
  fetchConnectionConfig,
  fetchServiceHealthDetails,
  fetchTriggerGatewayStatus,
  fetchInspectionSnapshot,
  fetchInspectionSettings,
  fetchInspectionReportArchives,
  fetchInspectionReportArchive,
  fetchProductionStatus,
  saveAdminInspectionSettings,
  saveConnectionConfig,
  type ConnectionConfig,
  type TriggerGatewayStatus,
  getInspectionServiceOrigin,
  getTriggerGatewayOrigin,
  issueInspectionReportArchive,
  type InspectionReportArchiveSummary,
} from './services/inspection-api';
import { exportInspectionArchiveAsPrintableHtml } from './lib/report-export';
import { canStartTitlebarDrag } from './lib/titlebar-drag';
import { getTauriWindowApi } from './lib/tauri-window';
import {
  calculateSystemNetworkRates,
  createEmptyCaptureSnapshot,
  readCaptureSnapshot,
  readSystemNetworkSnapshot,
  type SystemNetworkSnapshot,
} from './lib/capture-api';
import { createSequentialCameraLanes } from './lib/camera-display';
import { BrandHeader, type BkvDataHealth } from './components/BrandHeader';
import { AppFooter } from './components/AppFooter';
import { AlarmAnalysis, type AnalysisViewMode } from './components/AlarmAnalysis';
import { AlarmCenter } from './components/AlarmCenter';
import { DefectDetectionList } from './components/DefectDetectionList';
import { DefectImagePanel } from './components/DefectImagePanel';
import { LeftSidebar } from './components/LeftSidebar';
import { PlateMap, type PlateMapViewMode } from './components/PlateMap';
import { ReportPage } from './components/ReportPage';
import { SettingsPage } from './components/SettingsPage';
import { DefectFilterPanel } from './components/StatisticsPanel';
import { ParameterManagementApp } from './components/ParameterManagementApp';
import { CaptureManagementApp, SystemStatusPage } from './components/SystemStatusPage';
import { BarSurfaceApp } from './components/BarSurfaceApp';
import { BkvReconstructionApp } from './components/BkvReconstructionApp';
import {
  buildStandardBkvInspectionSnapshot,
  mergeStandardBkvDefects,
} from './lib/bkv-inspection-adapter';
import {
  fetchInspectionWorldDefects,
  fetchInspectionWorldRecords,
  fetchInspectionWorldSurface,
  type InspectionWorldRecords,
} from './services/inspection-world-api';
import {
  fetchBarSurfaceManifest,
  fetchBarSurfaceMesh,
  type BarSurfaceCamera,
  type BarSurfaceMesh,
} from './services/bar-surface-api';
import { InspectionFlowTool } from './components/InspectionFlowTool';
import { StandaloneWindowTitlebar } from './components/StandaloneWindowTitlebar';
import { BkvConversionStatusDialog } from './components/BkvConversionStatusDialog';
import { inferNotificationTone, notify } from './state/notifications';
import { resolveAppRoute, type AppRoute } from './lib/app-windows';
import {
  fetchRuntimeProfile,
  type PublicRuntimeProfile,
} from './services/runtime-profile-api';
import {
  createRuntimeDashboardMode,
  type RuntimeDashboardMode,
} from './lib/runtime-dashboard-mode';
import './styles.css';
import './styles/theme-system.css';

const REPORT_PAGE_SIZE = 8;
const ALL_SEVERITY_FILTERS: Severity[] = ['severe', 'review', 'minor'];
const UNKNOWN_SERVICE_ENDPOINT = 'unknown';

export function formatStorageBytes(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return '--';
  }
  const gib = value / (1024 ** 3);
  return `${gib.toFixed(gib >= 100 ? 0 : 1)} GiB`;
}

export function formatStorageWarning(check?: {
  freeBytes?: number | null;
  freePercent?: number | null;
  estimatedRemainingSeconds?: number | null;
}) {
  const percent = typeof check?.freePercent === 'number' ? `${check.freePercent.toFixed(1)}%` : '--';
  const remainingHours = typeof check?.estimatedRemainingSeconds === 'number'
    ? `${(check.estimatedRemainingSeconds / 3600).toFixed(1)} 小时`
    : '按当前吞吐暂无法估算';
  return `存储容量预警：剩余 ${formatStorageBytes(check?.freeBytes)} / ${percent}，预计 ${remainingHours}`;
}

type ServiceConnectionState = 'online' | 'warning' | 'offline';

type ServiceStatusPanelItem = {
  name: string;
  state: ServiceConnectionState;
  detail: string;
  endpoint: string;
};

type ServiceStatusPanel = {
  inspectionService: ServiceStatusPanelItem;
  captureService: ServiceStatusPanelItem;
  triggerGateway: ServiceStatusPanelItem;
};

type RecordBoundSurfaceArtifact = {
  inspectionId: string;
  loading: boolean;
  mesh: BarSurfaceMesh | null;
  status: string;
  cameras?: BarSurfaceCamera[];
};

type AppMode = AppRoute;

function buildUnknownService(name: string, endpoint: string): ServiceStatusPanelItem {
  return {
    name,
    state: 'warning',
    detail: '未检查',
    endpoint,
  };
}

function readViewportSize() {
  if (typeof window === 'undefined') {
    return { width: 1676, height: 945 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

function readAppMode(): AppMode {
  if (typeof window === 'undefined') {
    return 'terminal';
  }
  return resolveAppRoute(window.location.search, window.location.hash);
}

function writeTerminalViewMode(view: 'online' | 'bkv') {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('view', view);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function downloadTextFile(filename: string, content: string, mimeType = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function filterDefectsBySelectedSeverities(defects: DefectItem[], selectedSeverities: ReadonlySet<Severity>) {
  return defects.filter((defect) => selectedSeverities.has(defect.severity));
}

export default function App() {
  const [runtimeProfile, setRuntimeProfile] = useState<PublicRuntimeProfile | null>(null);
  const [runtimeProfileError, setRuntimeProfileError] = useState('');
  const requestedAppMode = readAppMode();

  useEffect(() => {
    const controller = new AbortController();
    fetchRuntimeProfile(controller.signal)
      .then((profile) => {
        if (!controller.signal.aborted) {
          setRuntimeProfile(profile);
          setRuntimeProfileError('');
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setRuntimeProfileError(error instanceof Error ? error.message : '运行配置读取失败');
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!runtimeProfile || typeof window === 'undefined') {
      return;
    }
    const dashboardMode = createRuntimeDashboardMode(runtimeProfile);
    const directOnlyRouteBlocked =
      (requestedAppMode === 'capture' && !dashboardMode.showsCaptureManagement)
      || (requestedAppMode === 'bar-surface' && !dashboardMode.showsReconstruction);
    if (!directOnlyRouteBlocked) {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('app', 'terminal');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [requestedAppMode, runtimeProfile]);

  if (!runtimeProfile) {
    return (
      <div className="app-shell app-loading-shell">
        <section className="app-loading-panel" role="status" aria-live="polite">
          <span>运行模式</span>
          <h1>{runtimeProfileError ? '运行配置不可用' : '正在读取运行配置'}</h1>
          <p>{runtimeProfileError || '正在确认相机拓扑与可用功能…'}</p>
        </section>
      </div>
    );
  }

  const dashboardMode = createRuntimeDashboardMode(runtimeProfile);
  const blockedLabel = requestedAppMode === 'capture' && !dashboardMode.showsCaptureManagement
    ? '采集管理'
    : requestedAppMode === 'bar-surface' && !dashboardMode.showsReconstruction
      ? '3D 重建'
      : null;
  const appMode = blockedLabel ? 'terminal' : requestedAppMode;

  return (
    <ConfiguredApp
      runtimeProfile={runtimeProfile}
      dashboardMode={dashboardMode}
      appMode={appMode}
      capabilityMessage={blockedLabel ? `当前运行模式不支持${blockedLabel}，已返回检测终端` : undefined}
    />
  );
}

function ConfiguredApp({
  runtimeProfile,
  dashboardMode,
  appMode,
  capabilityMessage,
}: {
  runtimeProfile: PublicRuntimeProfile;
  dashboardMode: RuntimeDashboardMode;
  appMode: AppMode;
  capabilityMessage?: string;
}) {
  if (appMode === 'bar-surface') {
    const theme = readStoredTheme();
    const themeStyle = readStoredThemeStyle();
    return (
      <div className={`app-shell theme-${theme} style-${themeStyle} standalone-tool-shell bar-surface-standalone-shell`}>
        <StandaloneWindowTitlebar kind="bar-surface" title="3D 重建工作台" />
        {dashboardMode.kind === 'bkv' ? (
          <BkvReconstructionApp expectedCameraCount={runtimeProfile.cameraCount} />
        ) : (
          <BarSurfaceApp expectedCameraCount={runtimeProfile.cameraCount} />
        )}
      </div>
    );
  }

  const [snapshot, setSnapshot] = useState<InspectionSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bkvRecords, setBkvRecords] = useState<InspectionWorldRecords | null>(null);
  const [bkvDataHealth, setBkvDataHealth] = useState<BkvDataHealth>({
    state: 'loading',
    detail: '正在读取 BKV 标准离线仓库',
  });
  const [loadRevision, setLoadRevision] = useState(0);
  const resolvedTerminalMode = dashboardMode.kind === 'bkv' ? 'bkv' : 'online';
  const resourceUsageState = useAppResourceUsage();

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(null);
    setLoadError(null);
    setBkvRecords(null);
    if (dashboardMode.requestsStandardRecords || dashboardMode.kind === 'bkv-online') {
      setBkvDataHealth({
        state: 'loading',
        detail: dashboardMode.kind === 'bkv-online'
          ? '正在连接 BKV MySQL 与六个共享图像目录'
          : '正在读取 BKV 标准离线仓库',
      });
    }
    writeTerminalViewMode(resolvedTerminalMode);
    const loadSnapshot = dashboardMode.requestsStandardRecords
      ? fetchInspectionWorldRecords(controller.signal).then((records) => {
        if (controller.signal.aborted) {
          throw new DOMException('BKV record load aborted', 'AbortError');
        }
        setBkvRecords(records);
        setBkvDataHealth({
          state: 'ready',
          detail: records.records.length
            ? `${records.records.length} 支标准离线检测记录已就绪`
            : 'BKV 标准离线仓库可读，暂无检测记录',
        });
        return buildStandardBkvInspectionSnapshot(records);
      })
      : fetchInspectionSnapshot(controller.signal);
    loadSnapshot
      .then((nextSnapshot) => {
        if (!controller.signal.aborted) {
          setSnapshot(nextSnapshot);
          if (dashboardMode.kind === 'bkv-online') {
            setBkvDataHealth({
              state: 'ready',
              detail: `${nextSnapshot.records.length} 条在线记录、${nextSnapshot.captureImages?.length ?? 0} 路实际图像已就绪`,
            });
          }
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          const detail = error instanceof Error ? error.message : '后台数据接口不可用';
          setLoadError(detail);
          if (dashboardMode.requestsStandardRecords || dashboardMode.kind === 'bkv-online') {
            setBkvDataHealth({ state: 'store-error', detail });
          }
        }
      });
    return () => controller.abort();
  }, [dashboardMode.kind, dashboardMode.requestsStandardRecords, loadRevision, resolvedTerminalMode]);

  const retryBkvLoad = () => {
    setSnapshot(null);
    setLoadError(null);
    setBkvRecords(null);
    setBkvDataHealth({
      state: 'loading',
      detail: '正在读取 BKV 标准离线仓库',
    });
    setLoadRevision((current) => current + 1);
  };

  if (resolvedTerminalMode === 'bkv' && loadError) {
    const theme = readStoredTheme();
    const themeStyle = readStoredThemeStyle();
    const status = buildStandardBkvInspectionSnapshot({
      schema: 'steel.inspection-world.records.v1',
      provider: 'bkv',
      ready: false,
      cameraCount: dashboardMode.cameraCount,
      batchId: '无离线批次',
      records: [],
    }).status;
    return (
      <div className={`app-shell theme-${theme} style-${themeStyle} bkv-mode-error-shell`}>
        <BrandHeader
          status={status}
          theme={theme}
          expectedCameraCount={runtimeProfile.cameraCount}
          activeNav="online"
          dashboardMode={dashboardMode}
          bkvData={{
            cameraCount: dashboardMode.cameraCount,
            availableCameraCount: 0,
            batchId: bkvRecords?.batchId ?? '未连接',
            health: bkvDataHealth,
          }}
          onNavChange={() => undefined}
          onDragMouseDown={() => undefined}
        />
        <main className="mode-error-workspace">
          <section className="mode-error-panel" role="alert">
            <span>BKV 兼容模式</span>
            <h1>BKV 数据读取失败</h1>
            <p>{loadError}</p>
            <button type="button" onClick={retryBkvLoad}>重新检查 BKV 数据</button>
          </section>
        </main>
        <AppFooter
          activeNav="online"
          dashboardMode={dashboardMode}
          resourceUsage={resourceUsageState.usage}
          resourceUsageStale={resourceUsageState.stale}
          terminalViews={{
            online: { available: false, active: false },
            bkv: { available: true, active: true, onOpen: retryBkvLoad },
          }}
          onNavChange={() => undefined}
          onSettingsOpen={() => undefined}
        />
      </div>
    );
  }

  if (!snapshot) {
    const loadingTheme = readStoredTheme();
    const loadingThemeStyle = readStoredThemeStyle();
    return (
      <div className={`app-shell theme-${loadingTheme} style-${loadingThemeStyle} app-loading-shell`}>
        <section className="app-loading-panel" role="status" aria-live="polite">
          <span>后台数据系统</span>
          <h1>{loadError ? '后台连接失败' : '正在连接后台数据服务'}</h1>
          <p>{loadError ?? '正在从 Rust 数据服务获取钢管、缺陷、设备和历史记录数据...'}</p>
        </section>
      </div>
    );
  }

  return (
    <InspectionDashboard
      key={resolvedTerminalMode}
      snapshot={snapshot}
      runtimeProfile={runtimeProfile}
      dashboardMode={dashboardMode}
      bkvRecords={bkvRecords}
      bkvDataHealth={bkvDataHealth}
      capabilityMessage={capabilityMessage}
      resourceUsageState={resourceUsageState}
      onSnapshotChange={setSnapshot}
    />
  );
}

function InspectionDashboard({
  snapshot,
  runtimeProfile,
  dashboardMode,
  bkvRecords,
  bkvDataHealth,
  capabilityMessage,
  resourceUsageState,
  onSnapshotChange,
}: {
  snapshot: InspectionSnapshot;
  runtimeProfile: PublicRuntimeProfile;
  dashboardMode: RuntimeDashboardMode;
  bkvRecords: InspectionWorldRecords | null;
  bkvDataHealth: BkvDataHealth;
  capabilityMessage?: string;
  resourceUsageState: AppResourceUsageState;
  onSnapshotChange: (snapshot: InspectionSnapshot) => void;
}) {
  const terminalMode = dashboardMode.kind === 'bkv' ? 'bkv' : 'online';
  const [appMode] = useState(readAppMode);
  const [uiState, setUiState] = useState(() => createInitialUiState(snapshot));

  useEffect(() => {
    document.documentElement.dataset.theme = uiState.theme;
    persistTheme(uiState.theme);
  }, [uiState.theme]);
  useEffect(() => {
    document.documentElement.dataset.themeStyle = uiState.themeStyle;
    persistThemeStyle(uiState.themeStyle);
  }, [uiState.themeStyle]);
  const [onlineFilters, setOnlineFilters] = useState<ReportFilters>(() => createDefaultReportFilters());
  const [selectedOnlineSeverities, setSelectedOnlineSeverities] = useState<Set<Severity>>(() => new Set(ALL_SEVERITY_FILTERS));
  const [reportFilters, setReportFilters] = useState<ReportFilters>(() => createDefaultReportFilters());
  const [recordSearchFilters, setRecordSearchFilters] = useState<RecordSearchFilters>(emptyRecordSearchFilters);
  const [defectFilterOpen, setDefectFilterOpen] = useState(false);
  const [reportPage, setReportPage] = useState(1);
  const [reportArchives, setReportArchives] = useState<InspectionReportArchiveSummary[]>([]);
  const [reportArchiveStatus, setReportArchiveStatus] = useState('请选择单个生产检测记录');
  const [savedSettings, setSavedSettings] = useState<InspectionSettings>(() => createDefaultSettings());
  const [settingsDraft, setSettingsDraft] = useState<InspectionSettings>(() => createDefaultSettings());
  const [settingsErrors, setSettingsErrors] = useState(() => validateSettings(createDefaultSettings()));
  const [connectionDraft, setConnectionDraft] = useState<ConnectionConfig>(() => createDefaultConnectionConfig());
  const [connectionStatus, setConnectionStatus] = useState<string | null>('读取中');
  const [operationState, setOperationState] = useState(() => createInitialOperationState());
  const [toast, setToast] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState(readViewportSize);
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const [analysisViewMode, setAnalysisViewMode] = useState<AnalysisViewMode>(
    terminalMode === 'bkv' ? 'diameter' : 'overview',
  );
  const [plateMapViewMode, setPlateMapViewMode] = useState<PlateMapViewMode>('2d');
  const [longitudinalVisibleRange, setLongitudinalVisibleRange] = useState<[number, number] | null>(null);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [worldFocusRequest, setWorldFocusRequest] = useState({
    defectId: null as string | null,
    revision: 0,
  });
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [bkvConversionStatusOpen, setBkvConversionStatusOpen] = useState(false);
  const [inspectionFlowVisible, setInspectionFlowVisible] = useState(false);
  const [snapshotTracking, setSnapshotTracking] = useState<'latest' | 'history'>(terminalMode === 'bkv' ? 'history' : 'latest');
  const [snapshotSyncState, setSnapshotSyncState] = useState('等待实时同步');
  const [captureSnapshot, setCaptureSnapshot] = useState(() => createEmptyCaptureSnapshot('capture service pending'));
  const [recordBoundSurface, setRecordBoundSurface] = useState<RecordBoundSurfaceArtifact>({
    inspectionId: '',
    loading: false,
    mesh: null,
    status: '尚未选择生产检测记录',
  });
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusPanel>(() => ({
    inspectionService: buildUnknownService('Rust服务', getInspectionServiceOrigin()),
    captureService: buildUnknownService('采集服务', UNKNOWN_SERVICE_ENDPOINT),
    triggerGateway: buildUnknownService('触发网关', getTriggerGatewayOrigin()),
  }));
  const [triggerGatewayStatus, setTriggerGatewayStatus] = useState<TriggerGatewayStatus | null>(null);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const tone = inferNotificationTone(toast);
    notify({
      title: tone === 'error' ? '操作失败' : tone === 'warning' ? '操作提醒' : tone === 'success' ? '操作完成' : '系统消息',
      message: toast,
      tone,
    });
    setToast(null);
  }, [toast]);
  const [networkSnapshot, setNetworkSnapshot] = useState(() => calculateSystemNetworkRates({
    code: 1,
    sampledAtMs: Date.now(),
    interfaces: [],
    totalReceivedBytes: 0,
    totalTransmittedBytes: 0,
    error: 'network monitor pending',
  }, null));
  const previousNetworkSnapshotRef = useRef<SystemNetworkSnapshot | null>(null);
  const windowApi = useMemo(() => getTauriWindowApi(), []);
  const responsiveClassName = getResponsiveProfileClassName(getResponsiveProfile(viewportSize));
  const runtimeCameraLanes = createSequentialCameraLanes(runtimeProfile.cameraCount);

  useEffect(() => {
    const handleResize = () => setViewportSize(readViewportSize());
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (terminalMode !== 'online') return;
    const controller = new AbortController();
    fetchConnectionConfig(controller.signal)
      .then((config) => {
        setConnectionDraft(config);
        setConnectionStatus(config.mode === 'online' ? '在线配置已加载' : '演示模式已加载');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setConnectionStatus(error instanceof Error ? error.message : '连接配置读取失败');
        }
      });
    return () => controller.abort();
  }, [terminalMode]);

  useEffect(() => {
    if (terminalMode !== 'online') return;
    const controller = new AbortController();
    fetchInspectionSettings(controller.signal)
      .then((settings) => {
        setSavedSettings(settings);
        setSettingsDraft(settings);
        setSettingsErrors(validateSettings(settings));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setToast(error instanceof Error ? error.message : '检测规则读取失败');
        }
      });
    return () => controller.abort();
  }, [terminalMode]);

  useEffect(() => {
    if (!settingsModalOpen) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSettingsModalOpen(false);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [settingsModalOpen]);

  useEffect(() => {
    if (terminalMode !== 'online') return;
    let cancelled = false;
    const refreshCapture = async () => {
      try {
        const snapshot = await readCaptureSnapshot();
        if (!cancelled) {
          setCaptureSnapshot(snapshot);
        }
      } catch (error) {
        if (!cancelled) {
          setCaptureSnapshot(createEmptyCaptureSnapshot(error instanceof Error ? error.message : 'capture service offline'));
        }
      }
    };
    void refreshCapture();
    const timer = window.setInterval(() => void refreshCapture(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [terminalMode]);

  useEffect(() => {
    if (terminalMode !== 'online') return;
    let cancelled = false;
    let inFlight = false;
    const refreshSnapshot = async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        const nextSnapshot = await fetchInspectionSnapshot();
        if (cancelled) {
          return;
        }
        onSnapshotChange(nextSnapshot);
        setSnapshotSyncState(`已同步 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
        if (snapshotTracking === 'latest') {
          const latestPlateNo = nextSnapshot.records[0]?.plateNo ?? nextSnapshot.currentPlate.plateNo;
          setUiState((current) => selectRecord(current, nextSnapshot, latestPlateNo));
        }
      } catch (error) {
        if (!cancelled) {
          setSnapshotSyncState(error instanceof Error ? `同步失败：${error.message}` : '实时同步失败');
        }
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => void refreshSnapshot(), 8000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [onSnapshotChange, snapshotTracking, terminalMode]);

  useEffect(() => {
    if (terminalMode !== 'online') return;
    let cancelled = false;
    let requestInFlight = false;
    const refreshNetwork = async () => {
      if (requestInFlight) {
        return;
      }
      requestInFlight = true;
      try {
        const snapshot = await readSystemNetworkSnapshot();
        const rates = calculateSystemNetworkRates(snapshot, previousNetworkSnapshotRef.current);
        previousNetworkSnapshotRef.current = snapshot;
        if (!cancelled) {
          setNetworkSnapshot(rates);
        }
      } catch (error) {
        previousNetworkSnapshotRef.current = null;
        if (!cancelled) {
          setNetworkSnapshot(calculateSystemNetworkRates({
            code: 1,
            sampledAtMs: Date.now(),
            interfaces: [],
            totalReceivedBytes: 0,
            totalTransmittedBytes: 0,
            error: error instanceof Error ? error.message : 'network monitor offline',
          }, null));
        }
      } finally {
        requestInFlight = false;
      }
    };
    void refreshNetwork();
    const timer = window.setInterval(() => void refreshNetwork(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [terminalMode]);

  useEffect(() => {
    if (terminalMode !== 'online') return;
    let cancelled = false;
    let inFlight = false;

    const refreshServices = async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;

      try {
        const apiOrigin = getInspectionServiceOrigin();
        const [response, health] = await Promise.all([
          fetch(`${apiOrigin}/api/services`),
          fetchServiceHealthDetails(),
        ]);
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          setServiceStatus((current) => ({
            ...current,
            inspectionService: {
              ...current.inspectionService,
              state: 'offline',
              detail: `检测服务不可达 HTTP ${response.status}`,
            },
          }));
        } else {
          const payload = (await response.json()) as {
            api?: { name?: string; running?: boolean; origin?: string };
            capture?: { name?: string; running?: boolean; origin?: string };
          };
          const checks = health.checks ?? {};
          const blockingChecks = Object.entries(checks).filter(([, check]) =>
            check && check.ok !== true && check.readyContribution !== true,
          );
          const blockingCheckDetail = blockingChecks.map(([name, check]) => {
            if (name === 'calibrationReconciliation') {
              const operationIds = check?.unresolvedOperations
                ?.map((operation) => operation.operationId)
                .filter(Boolean)
                .join('、');
              return `标定协调围栏(${check?.unresolvedCount ?? '?'} 项${operationIds ? `：${operationIds}` : ''})`;
            }
            return `${name}${check?.reason ? `(${check.reason})` : ''}`;
          });
          const healthDetail = health.ok
            ? '检测服务已就绪'
            : `检测服务降级：${blockingCheckDetail.join('、') || health.status}`;
          const storageWarning = checks.storage?.level === 'warning';
          const captureHealthy = checks.capture?.ok === true && checks.storage?.ok === true && !storageWarning;
          const captureReachable = checks.capture?.apiReachable === true || checks.capture?.status === 'simulated';
          setServiceStatus((current) => ({
            ...current,
            inspectionService: {
              name: payload.api?.name || current.inspectionService.name || 'steel-inspection-service',
              state: payload.api?.running === true ? (health.ok ? 'online' : 'warning') : 'offline',
              detail: payload.api?.running === true ? healthDetail : '检测服务离线',
              endpoint: payload.api?.origin || apiOrigin,
            },
            captureService: {
              ...current.captureService,
              name: payload.capture?.name || current.captureService.name || 'steel-capture-service',
              state:
                payload.capture?.running === false
                  ? 'offline'
                  : captureHealthy
                    ? 'online'
                    : captureReachable
                      ? 'warning'
                      : 'offline',
              detail:
                captureHealthy
                  ? '采集 API、SDK 与存储均就绪'
                  : storageWarning
                    ? formatStorageWarning(checks.storage)
                    : captureReachable
                      ? `采集服务降级：${checks.capture?.reason || checks.storage?.reason || '依赖未就绪'}`
                      : payload.capture?.running === false
                        ? '采集服务离线'
                        : '采集服务不可达',
              endpoint: payload.capture?.origin || current.captureService.endpoint,
            },
          }));
        }
      } catch (error) {
        if (!cancelled) {
          setServiceStatus((current) => ({
            ...current,
            inspectionService: {
              ...current.inspectionService,
              state: 'offline',
              detail: error instanceof Error ? error.message : '检测服务连接失败',
            },
          }));
        }
      }

      try {
        const triggerStatus = await fetchTriggerGatewayStatus();
        if (cancelled) {
          return;
        }
        setServiceStatus((current) => ({
          ...current,
          triggerGateway: {
            name: 'trigger-gateway',
            state: triggerStatus.code === 0 && !triggerStatus.error ? 'online' : 'offline',
            detail: triggerStatus.modeLabel ? `模式 ${triggerStatus.modeLabel}` : triggerStatus.mode || '未知',
            endpoint: getTriggerGatewayOrigin(),
          },
        }));
        setTriggerGatewayStatus(triggerStatus);
      } catch (error) {
        if (!cancelled) {
          setTriggerGatewayStatus(null);
          setServiceStatus((current) => ({
            ...current,
            triggerGateway: {
              ...current.triggerGateway,
              state: 'offline',
              detail: error instanceof Error ? error.message : '触发网关连接失败',
            },
          }));
        }
      } finally {
        inFlight = false;
      }
    };

    void refreshServices();
    const timer = window.setInterval(() => {
      void refreshServices();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [terminalMode]);

  const activeSnapshot = useMemo(() => getPlateInspectionSnapshot(snapshot, uiState.selectedRecordId), [snapshot, uiState.selectedRecordId]);
  const activeInspection = useMemo(
    () => snapshot.inspections.find((inspection) => inspection.plate.plateNo === activeSnapshot.currentPlate.plateNo) ?? null,
    [activeSnapshot.currentPlate.plateNo, snapshot.inspections],
  );
  const artifactMode: 'production' | 'demo' = snapshot.source === 'demo' || snapshot.source === 'test' ? 'demo' : 'production';
  const loadedBkvDefectRecordsRef = useRef(new Set<string>());

  useEffect(() => {
    if (dashboardMode.kind !== 'bkv') return;
    const recordId = activeInspection?.inspectionId?.trim();
    if (!recordId || loadedBkvDefectRecordsRef.current.has(recordId)) return;
    const controller = new AbortController();
    fetchInspectionWorldDefects(recordId, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        loadedBkvDefectRecordsRef.current.add(recordId);
        onSnapshotChange(mergeStandardBkvDefects(snapshot, recordId, payload));
      })
      .catch(() => {
        // A record-local world or defect failure must not start online fallback polling.
      });
    return () => controller.abort();
  }, [activeInspection?.inspectionId, dashboardMode.kind]);

  useEffect(() => {
    const inspectionId = activeInspection?.inspectionId?.trim() || '';
    const materialId = activeSnapshot.currentPlate.plateNo;
    const recordSummaryPath = activeInspection?.summaryPath?.trim() || '';
    if (terminalMode === 'bkv' || dashboardMode.kind === 'bkv-online') {
      if (!inspectionId) {
        setRecordBoundSurface({
          inspectionId: '',
          loading: false,
          mesh: null,
          status: '尚未选择可转换的 BKV 在线记录',
        });
        return;
      }
      const controller = new AbortController();
      let loaded = false;
      let inFlight = false;
      setRecordBoundSurface({
        inspectionId,
        loading: true,
        mesh: null,
        status: terminalMode === 'bkv'
          ? '正在读取当前离线记录的 NPZ 三维表面…'
          : '正在转换并读取当前流水号的 D3IMG 三维表面…',
      });
      const loadDepthSurface = async () => {
        if (loaded || inFlight || controller.signal.aborted) return;
        inFlight = true;
        try {
          const mesh = await fetchInspectionWorldSurface(inspectionId, controller.signal);
          if (controller.signal.aborted) return;
          setRecordBoundSurface({
            inspectionId,
            loading: false,
            mesh,
            status: terminalMode === 'bkv'
              ? `NPZ 已恢复 · ${Math.floor(mesh.positions.length / 3).toLocaleString('zh-CN')} 点 · 深度单位 mm`
              : `D3IMG 已转换并存储 · ${Math.floor(mesh.positions.length / 3).toLocaleString('zh-CN')} 点`,
          });
          loaded = true;
        } catch (error) {
          if (!controller.signal.aborted) {
            setRecordBoundSurface({
              inspectionId,
              loading: false,
              mesh: null,
              status: error instanceof Error
                ? `${terminalMode === 'bkv' ? 'NPZ' : 'D3IMG'} 三维表面暂不可用：${error.message}`
                : `${terminalMode === 'bkv' ? 'NPZ' : 'D3IMG'} 三维表面暂不可用`,
            });
          }
        } finally {
          inFlight = false;
        }
      };
      void loadDepthSurface();
      const timer = window.setInterval(() => void loadDepthSurface(), 8000);
      return () => {
        controller.abort();
        window.clearInterval(timer);
      };
    }
    if (artifactMode === 'demo') {
      setRecordBoundSurface({
        inspectionId,
        loading: false,
        mesh: null,
        status: '演示/测试模式使用显式 demo 产物',
      });
      return;
    }
    if (!inspectionId) {
      setRecordBoundSurface({
        inspectionId: '',
        loading: false,
        mesh: null,
        status: '当前数据未绑定 production inspection，禁止使用全局最新或模拟点云',
      });
      return;
    }

    const controller = new AbortController();
    setRecordBoundSurface({
      inspectionId,
      loading: true,
      mesh: null,
      status: '正在核对检测记录绑定的算法产物…',
    });
    let inFlight = false;
    let artifactLoaded = false;
    const loadRecordArtifact = async () => {
      if (inFlight || artifactLoaded || controller.signal.aborted) {
        return;
      }
      inFlight = true;
      try {
        let summaryPath = recordSummaryPath;
        if (!summaryPath) {
          const production = await fetchProductionStatus(controller.signal);
          if (controller.signal.aborted) {
            return;
          }
          const latest = production.latestInspection;
          if (!latest || latest.id !== inspectionId || latest.materialId !== materialId) {
            setRecordBoundSurface({
              inspectionId,
              loading: false,
              mesh: null,
              status: '所选记录未提供算法产物路径，且不是 production/status 的最新检测；未使用全局 latest 以避免串记录',
            });
            return;
          }
          summaryPath = latest.summaryPath?.trim() || '';
          if (!summaryPath) {
            setRecordBoundSurface({
              inspectionId,
              loading: false,
              mesh: null,
              status: `生产状态 ${latest.status || 'unknown'}，暂无记录绑定的三维产物`,
            });
            return;
          }
        }
        const manifest = await fetchBarSurfaceManifest(summaryPath, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        if (manifest.materialId !== materialId) {
          throw new Error('算法 manifest 与当前检测材料号不一致，已拒绝展示');
        }
        const mesh = await fetchBarSurfaceMesh(manifest, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        if (mesh.positions.length < 3) {
          throw new Error('记录绑定的算法 mesh 没有有效点数据');
        }
        setRecordBoundSurface({
          inspectionId,
          loading: false,
          mesh,
          cameras: manifest.cameras,
          status: `已绑定 ${manifest.runId} · ${Math.floor(mesh.positions.length / 3).toLocaleString('zh-CN')} 点`,
        });
        artifactLoaded = true;
      } catch (error) {
        if (!controller.signal.aborted) {
          setRecordBoundSurface({
            inspectionId,
            loading: false,
            mesh: null,
            status: error instanceof Error ? `生产产物不可用：${error.message}` : '生产产物不可用',
          });
        }
      } finally {
        inFlight = false;
      }
    };
    void loadRecordArtifact();
    const timer = window.setInterval(() => void loadRecordArtifact(), 8000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [activeInspection?.inspectionId, activeInspection?.summaryPath, activeSnapshot.currentPlate.plateNo, artifactMode, dashboardMode.kind, terminalMode]);

  const activePlateLengthM = activeSnapshot.currentPlate.lengthMm / 1000;
  const currentPlateDefects = useMemo(
    () => applyInspectionSettingsToDefects(activeSnapshot.defects, savedSettings),
    [activeSnapshot.defects, savedSettings],
  );
  const allDefects = useMemo(
    () => applyInspectionSettingsToDefects(getAllDefects(snapshot), savedSettings),
    [snapshot, savedSettings],
  );
  const activeSummary = useMemo(() => summarizeDefects(currentPlateDefects), [currentPlateDefects]);
  const baseDeviceStatus = useMemo(() => getDeviceStatusWithOperation(activeSnapshot.status, operationState), [activeSnapshot.status, operationState]);
  const serviceAlarmCount = useMemo(() => {
    if (terminalMode === 'bkv') return 0;
    return Object.values(serviceStatus).reduce((count, service) => count + (service.state === 'offline' || service.state === 'warning' ? 1 : 0), 0);
  }, [serviceStatus, terminalMode]);
  const deviceStatus = useMemo(
    () => ({
      ...baseDeviceStatus,
      alarmCount: baseDeviceStatus.alarmCount + serviceAlarmCount,
    }),
    [baseDeviceStatus, serviceAlarmCount],
  );
  const categoryVisibleDefects = useMemo(() => getVisibleDefects(currentPlateDefects, uiState), [currentPlateDefects, uiState]);
  const legendCountDefects = useMemo(
    () =>
      filterDefectsBySelectedSeverities(
        filterDefectsForReport(filterDefectsBySurfaceMode(currentPlateDefects, uiState.surfaceDisplayMode), onlineFilters),
        selectedOnlineSeverities,
      ),
    [currentPlateDefects, uiState.surfaceDisplayMode, onlineFilters, selectedOnlineSeverities],
  );
  const defectTypeCounts = useMemo(
    () =>
      legendCountDefects.reduce<Record<string, number>>((counts, defect) => {
        counts[defect.typeId] = (counts[defect.typeId] ?? 0) + 1;
        return counts;
      }, {}),
    [legendCountDefects],
  );
  const surfaceVisibleDefects = useMemo(
    () => filterDefectsBySurfaceMode(categoryVisibleDefects, uiState.surfaceDisplayMode),
    [categoryVisibleDefects, uiState.surfaceDisplayMode],
  );
  const visibleDefects = useMemo(
    () => filterDefectsBySelectedSeverities(filterDefectsForReport(surfaceVisibleDefects, onlineFilters), selectedOnlineSeverities),
    [surfaceVisibleDefects, onlineFilters, selectedOnlineSeverities],
  );
  const reportRows = useMemo(() => filterDefectsForReport(allDefects, reportFilters), [allDefects, reportFilters]);
  const reportMetrics = useMemo(() => getReportMetrics(reportRows), [reportRows]);
  const reportScopeInspections = useMemo(() => {
    const exactRecord = reportFilters.keyword.trim().toLowerCase();
    if (!exactRecord) {
      return snapshot.inspections;
    }
    const exactMatches = snapshot.inspections.filter((inspection) =>
      inspection.plate.plateNo.toLowerCase() === exactRecord || inspection.inspectionId?.toLowerCase() === exactRecord,
    );
    return exactMatches.length > 0 ? exactMatches : snapshot.inspections;
  }, [reportFilters.keyword, snapshot.inspections]);
  const reportMetadata = useMemo(
    () => createReportMetadata(reportScopeInspections, reportRows),
    [reportRows, reportScopeInspections],
  );
  const reportInspectionId = reportMetadata.inspectionIds.length === 1 ? reportMetadata.inspectionIds[0] : '';

  useEffect(() => {
    if (terminalMode !== 'online') {
      setReportArchives([]);
      setReportArchiveStatus('BKV 离线记录不使用在线归档');
      return;
    }
    if (uiState.activeNav !== 'report' || !reportInspectionId) {
      setReportArchives([]);
      setReportArchiveStatus('请选择单个生产检测记录');
      return;
    }
    let cancelled = false;
    setReportArchiveStatus('正在读取归档记录');
    fetchInspectionReportArchives(reportInspectionId)
      .then((result) => {
        if (!cancelled) {
          setReportArchives(result.reports);
          setReportArchiveStatus(result.reports.length > 0 ? `已读取 ${result.reports.length} 份归档` : '尚未签发归档报告');
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setReportArchives([]);
          setReportArchiveStatus(error instanceof Error ? error.message : '归档记录读取失败');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reportInspectionId, terminalMode, uiState.activeNav]);
  const filteredRecords = useMemo(
    () => filterInspectionRecords(snapshot.records, snapshot.inspections, recordSearchFilters),
    [snapshot.records, snapshot.inspections, recordSearchFilters],
  );
  const reportPageCount = getPageCount(reportRows.length, REPORT_PAGE_SIZE);
  const reportPageRows = paginateItems(reportRows, reportPage, REPORT_PAGE_SIZE);
  const selectedOnlineDefect = visibleDefects.find((defect) => defect.id === uiState.selectedDefectId) ?? visibleDefects[0] ?? null;
  const selectedOnlineDefectId = selectedOnlineDefect?.id ?? null;
  const selectedReportDefect =
    reportRows.find((defect) => defect.id === uiState.selectedDefectId) ?? reportRows[0] ?? null;

  const handleTitlebarMouseDown = async (event: React.MouseEvent<HTMLElement>) => {
    if (!windowApi.isAvailable || event.button !== 0) {
      return;
    }
    if (!canStartTitlebarDrag(event.target)) {
      return;
    }
    try {
      if (event.detail === 2) {
        await windowApi.toggleMaximize();
      } else {
        await windowApi.startDragging();
      }
    } catch {
      // Browser preview has no native window API.
    }
  };

  const setState = (patch: Partial<InspectionUiState>) => {
    setUiState((current) => ({ ...current, ...patch }));
  };

  const selectDefectById = (defectId: string) => {
    const defect = allDefects.find((item) => item.id === defectId);
    const latestPlateNo = snapshot.records[0]?.plateNo ?? snapshot.currentPlate.plateNo;
    if (defect) {
      setSnapshotTracking(defect.plateNo === latestPlateNo ? 'latest' : 'history');
    }
    setUiState((current) => selectDefect(current, allDefects, defectId));
    setWorldFocusRequest((current) => ({
      defectId,
      revision: current.revision + 1,
    }));
  };

  const selectRecordByPlateNo = (plateNo: string) => {
    const latestPlateNo = snapshot.records[0]?.plateNo ?? snapshot.currentPlate.plateNo;
    setSnapshotTracking(plateNo === latestPlateNo ? 'latest' : 'history');
    setUiState((current) => selectRecord(current, snapshot, plateNo));
    setWorldFocusRequest((current) => ({
      defectId: null,
      revision: current.revision + 1,
    }));
  };

  const followLatestSnapshot = () => {
    const latestPlateNo = snapshot.records[0]?.plateNo ?? snapshot.currentPlate.plateNo;
    setSnapshotTracking('latest');
    setUiState((current) => selectRecord(current, snapshot, latestPlateNo));
    setWorldFocusRequest((current) => ({
      defectId: null,
      revision: current.revision + 1,
    }));
  };

  const updateOnlineFilters = (patch: Partial<ReportFilters>) => {
    setOnlineFilters((current) => ({ ...current, ...patch }));
    if (patch.severity) {
      setSelectedOnlineSeverities(new Set(patch.severity === 'all' ? ALL_SEVERITY_FILTERS : [patch.severity]));
    }
    setState({ defectPage: 1 });
  };

  const toggleOnlineSeverity = (severity: Severity) => {
    setOnlineFilters((current) => (current.severity === 'all' ? current : { ...current, severity: 'all' }));
    setSelectedOnlineSeverities((current) => {
      const next = new Set(current);
      if (next.has(severity)) {
        next.delete(severity);
      } else {
        next.add(severity);
      }
      return next;
    });
    setState({ defectPage: 1 });
  };

  const updateReportFilters = (patch: Partial<ReportFilters>) => {
    setReportFilters((current) => ({ ...current, ...patch }));
    setReportPage(1);
  };

  const updateRecordSearchFilters = (patch: Partial<RecordSearchFilters>) => {
    setRecordSearchFilters((current) => ({ ...current, ...patch }));
    setState({ recordPage: 1 });
  };

  const resetRecordSearchFilters = () => {
    setRecordSearchFilters(emptyRecordSearchFilters);
    setState({ recordPage: 1 });
  };

  const saveSettings = async (message: string) => {
    const errors = validateSettings(settingsDraft);
    setSettingsErrors(errors);
    if (Object.keys(errors).length > 0) {
      setToast('参数校验未通过，请修正红色提示');
      return;
    }
    try {
      const saved = await saveAdminInspectionSettings(settingsDraft);
      setSavedSettings(saved);
      setSettingsDraft(saved);
      setSettingsErrors({});
      setToast(message);
    } catch (error) {
      setToast(error instanceof Error ? `参数保存失败：${error.message}` : '参数保存失败');
    }
  };

  const resetSettings = () => {
    const defaults = createDefaultSettings();
    setSettingsDraft(defaults);
    setSettingsErrors({});
    setToast('默认参数已填入，保存后生效');
  };

  const updateConnectionDraft = (patch: Partial<ConnectionConfig>) => {
    setConnectionDraft((current) => ({
      ...current,
      ...patch,
      port: patch.port === undefined ? current.port : Math.max(1, Math.min(65535, Math.round(patch.port))),
    }));
  };

  const saveConnection = async () => {
    try {
      await saveConnectionConfig(connectionDraft);
      setConnectionStatus(connectionDraft.mode === 'online' ? '在线模式已保存' : '演示模式已保存');
      const nextSnapshot = await fetchInspectionSnapshot();
      onSnapshotChange(nextSnapshot);
      setUiState(createInitialUiState(nextSnapshot));
      setToast(connectionDraft.mode === 'online' ? '已切换到服务端数据库数据' : '已切换到本地演示数据');
    } catch (error) {
      setConnectionStatus(error instanceof Error ? error.message : '连接设置保存失败');
      setToast('连接设置保存失败');
    }
  };

  const handleSystemAction = async (action: SystemAction) => {
    if (action === 'self-check') {
      setToast('系统自检中');
      const [inspectionResult, captureResult, triggerResult] = await Promise.allSettled([
        fetchInspectionSnapshot(),
        readCaptureSnapshot(),
        fetchTriggerGatewayStatus(),
      ]);
      if (inspectionResult.status === 'fulfilled') {
        onSnapshotChange(inspectionResult.value);
      }
      if (captureResult.status === 'fulfilled') {
        setCaptureSnapshot(captureResult.value);
      }
      const failures = [inspectionResult, captureResult, triggerResult].filter((result) => result.status === 'rejected').length;
      if (failures > 0) {
        setToast(`系统自检发现 ${failures} 项服务不可用，请查看顶部服务状态`);
        return;
      }
      setOperationState((current) => runSystemAction(current, action));
      setToast('系统自检已完成，Rust、采集和触发服务均可达');
      return;
    }
    setOperationState((current) => {
      const next = runSystemAction(current, action);
      if (action === 'export-log') {
        queueMicrotask(() => {
          const text = next.events.map((event) => `${event.time},${event.level},${event.message}`).join('\n');
          downloadTextFile('system-events.csv', `时间,等级,事件\n${text}`, 'text/csv;charset=utf-8');
        });
      }
      return next;
    });
    const messages: Record<SystemAction, string> = {
      'self-check': '系统自检已完成',
      'clear-alarm': '本地临时报警已清零，服务端报警保持不变',
      'sync-time': '系统时间已同步',
      'export-log': '事件日志已导出',
    };
    setToast(messages[action]);
  };

  if (appMode === 'capture') {
    return (
      <div className={`app-shell theme-${uiState.theme} style-${uiState.themeStyle} ${responsiveClassName} capture-standalone-shell`}>
        <StandaloneWindowTitlebar kind="capture" title="采集管理" />
        <main className="workspace-page capture-page capture-standalone-page">
          <CaptureManagementApp
            status={deviceStatus}
            operation={operationState}
            capture={captureSnapshot}
            expectedCameraCount={runtimeProfile.cameraCount}
            onAction={handleSystemAction}
            className="standalone-capture-manager"
          />
        </main>
        <InspectionFlowTool onSnapshot={onSnapshotChange} />
      </div>
    );
  }

  if (appMode === 'parameters') {
    return (
      <div className={`app-shell theme-${uiState.theme} style-${uiState.themeStyle} ${responsiveClassName} parameter-standalone-shell`}>
        <StandaloneWindowTitlebar kind="parameters" title="后台管理" />
        <ParameterManagementApp />
      </div>
    );
  }

  return (
    <div className={`app-shell theme-${uiState.theme} style-${uiState.themeStyle} ${responsiveClassName}`}>
      <BrandHeader
        status={deviceStatus}
        theme={uiState.theme}
        expectedCameraCount={runtimeProfile.cameraCount}
        capture={captureSnapshot}
        network={networkSnapshot}
        trigger={triggerGatewayStatus}
        services={serviceStatus}
        activeNav={uiState.activeNav}
        dashboardMode={dashboardMode}
        bkvData={dashboardMode.kind === 'bkv' ? {
          cameraCount: bkvRecords?.cameraCount ?? dashboardMode.cameraCount,
          availableCameraCount: bkvRecords?.ready ? (bkvRecords.cameraCount ?? dashboardMode.cameraCount) : 0,
          batchId: bkvRecords?.batchId ?? '读取中',
          health: bkvDataHealth,
        } : dashboardMode.kind === 'bkv-online' ? {
          cameraCount: dashboardMode.cameraCount,
          availableCameraCount: new Set((snapshot.captureImages ?? []).map((image) => image.cameraId)).size,
          batchId: snapshot.records[0]?.id ?? '读取中',
          health: bkvDataHealth,
        } : undefined}
        onBkvConversionStatusOpen={dashboardMode.kind === 'bkv-online'
          ? () => setBkvConversionStatusOpen(true)
          : undefined}
        analysisCollapse={uiState.activeNav === 'online' ? {
          collapsed: analysisCollapsed,
          onToggle: () => setAnalysisCollapsed((current) => !current),
        } : undefined}
        onNavChange={(activeNav) => setState({ activeNav })}
        onDragMouseDown={(event) => void handleTitlebarMouseDown(event)}
      />
      {capabilityMessage ? (
        <div className="runtime-capability-message" role="status">{capabilityMessage}</div>
      ) : null}
      {bkvConversionStatusOpen ? (
        <BkvConversionStatusDialog
          snapshot={snapshot}
          onClose={() => setBkvConversionStatusOpen(false)}
        />
      ) : null}
      {uiState.activeNav === 'online' ? (
        <div className={`online-workspace ${terminalMode === 'bkv' ? 'runtime-bkv-workspace' : ''}`}>
          <LeftSidebar
            runtimeMode={terminalMode}
            plate={activeSnapshot.currentPlate}
            summary={activeSummary}
            records={filteredRecords}
            inspections={snapshot.inspections}
            selectedRecordId={uiState.selectedRecordId}
            searchFilters={recordSearchFilters}
            filteredCount={filteredRecords.length}
            totalCount={snapshot.records.length}
            onRecordSelect={selectRecordByPlateNo}
            onSearchChange={updateRecordSearchFilters}
            onSearchReset={resetRecordSearchFilters}
          />
          <section className="online-main">
            <main className={`dashboard-grid online-dashboard-grid ${rightSidebarCollapsed ? 'right-sidebar-collapsed' : ''}`}>
              <section className={`center-column ${analysisCollapsed ? 'analysis-collapsed' : ''}`}>
                <PlateMap
                  defectTypes={snapshot.defectTypes}
                  defects={visibleDefects}
                  defectTypeCounts={defectTypeCounts}
                  hiddenTypeIds={uiState.hiddenDefectTypeIds}
                  selectedDefectId={selectedOnlineDefectId}
                  worldFocusRequest={worldFocusRequest}
                  surfaceMode={uiState.surfaceDisplayMode}
                  previewPositionM={uiState.previewPositionM}
                  plateLengthM={activePlateLengthM}
                  nominalDiameterMm={activeSnapshot.currentPlate.widthMm}
                  artifactMode={artifactMode}
                  inspectionId={activeInspection?.inspectionId}
                  requireInspectionWorld={dashboardMode.kind === 'bkv' || dashboardMode.kind === 'bkv-online'}
                  captureImages={activeSnapshot.captureImages ?? []}
                  cameraLanes={runtimeCameraLanes}
                  surfaceMesh={recordBoundSurface.inspectionId === activeInspection?.inspectionId ? recordBoundSurface.mesh : null}
                  surfaceCameras={recordBoundSurface.inspectionId === activeInspection?.inspectionId ? recordBoundSurface.cameras : undefined}
                  artifactStatus={recordBoundSurface.loading ? '正在加载当前检测记录的生产产物…' : recordBoundSurface.status}
                  viewMode={plateMapViewMode}
                  integratedToolbar
                  toolbarExtra={
                    <>
                      {terminalMode === 'bkv' ? (
                        <div className="snapshot-follow-summary bkv-record-summary" aria-label="BKV 检测数据状态">
                          <i className="history" />
                          <strong>BKV 离线记录</strong>
                          <span>流水号 {activeInspection?.inspectionId ?? '--'} · 批次 {bkvRecords?.batchId ?? '--'}</span>
                        </div>
                      ) : (
                        <>
                        <div className="snapshot-follow-summary" aria-label="检测数据状态">
                          <i className={snapshotTracking === 'latest' ? 'live' : 'history'} />
                          <strong>{snapshotTracking === 'latest' ? '实时跟随最新检测' : `固定查看 ${activeSnapshot.currentPlate.plateNo}`}</strong>
                          <span>{snapshotSyncState} · 每 8 秒刷新</span>
                        </div>
                        <div className="snapshot-follow-actions" role="group" aria-label="检测记录跟随模式">
                          <button type="button" className={snapshotTracking === 'latest' ? 'active' : ''} onClick={followLatestSnapshot}>
                            跟随最新
                          </button>
                          <button type="button" className={snapshotTracking === 'history' ? 'active' : ''} onClick={() => setSnapshotTracking('history')}>
                            固定当前
                          </button>
                        </div>
                        </>
                      )}
                      {rightSidebarCollapsed ? (
                        <button
                          type="button"
                          className="right-sidebar-expand-button"
                          aria-label="展开右侧栏"
                          title="展开缺陷侧栏"
                          onClick={() => setRightSidebarCollapsed(false)}
                        >
                          <PanelRightOpen size={14} />
                          <span>缺陷侧栏</span>
                        </button>
                      ) : null}
                    </>
                  }
                  onToggleType={(typeId) =>
                    setUiState((current) => ({
                      ...toggleDefectType(current, typeId),
                      defectPage: 1,
                    }))
                  }
                  onSurfaceModeChange={(surfaceDisplayMode) => setState({ surfaceDisplayMode, defectPage: 1 })}
                  onPreviewPositionChange={(previewPositionM) => setState({ previewPositionM: clampPreviewPositionM(previewPositionM, activePlateLengthM) })}
                  onSelectDefect={selectDefectById}
                  onViewModeChange={(nextViewMode) => {
                    setLongitudinalVisibleRange(null);
                    setPlateMapViewMode(nextViewMode);
                  }}
                  onVisibleRangeChange={setLongitudinalVisibleRange}
                />
                <AlarmAnalysis
                  selectedDefect={selectedOnlineDefect}
                  heightProfile={activeSnapshot.heightProfile}
                  captureImages={activeSnapshot.captureImages}
                  defects={visibleDefects}
                  artifactMode={artifactMode}
                  inspectionId={activeInspection?.inspectionId}
                  surfaceMesh={recordBoundSurface.inspectionId === activeInspection?.inspectionId ? recordBoundSurface.mesh : null}
                  artifactStatus={recordBoundSurface.loading ? '正在加载当前检测记录的生产产物…' : recordBoundSurface.status}
                  headerless
                  collapsed={analysisCollapsed}
                  viewMode={analysisViewMode}
                  diameterMeasurement={terminalMode === 'bkv' ? {
                    nominalDiameterMm: activeSnapshot.currentPlate.widthMm,
                    lengthMm: activeSnapshot.currentPlate.lengthMm,
                  } : undefined}
                  diameterVisibleRange={longitudinalVisibleRange}
                />
              </section>
              {rightSidebarCollapsed ? null : <aside className="right-column">
                <DefectImagePanel
                  inspectionId={activeInspection?.inspectionId}
                  defect={selectedOnlineDefect}
                  onSidebarCollapse={() => setRightSidebarCollapsed(true)}
                />
                <DefectFilterPanel
                  summary={activeSummary}
                  defectTypes={snapshot.defectTypes}
                  defectTypeCounts={defectTypeCounts}
                  hiddenDefectTypeIds={uiState.hiddenDefectTypeIds}
                  selectedSeverityFilters={selectedOnlineSeverities}
                  onDefectTypeToggle={(typeId) =>
                    setUiState((current) => ({
                      ...toggleDefectType(current, typeId),
                      defectPage: 1,
                    }))
                  }
                  onSeverityFilterToggle={toggleOnlineSeverity}
                />
                <DefectDetectionList
                  defects={visibleDefects}
                  inspectionId={activeInspection?.inspectionId}
                  selectedDefectId={selectedOnlineDefectId}
                  filters={onlineFilters}
                  filterOpen={defectFilterOpen}
                  onSelectDefect={selectDefectById}
                  onToggleFilter={() => setDefectFilterOpen((current) => !current)}
                  onFilterChange={updateOnlineFilters}
                  onClearFilters={() => {
                    setOnlineFilters(createDefaultReportFilters());
                    setState({ defectPage: 1 });
                  }}
                />
              </aside>}
            </main>
          </section>
        </div>
      ) : (
        <>
          {uiState.activeNav === 'report' ? (
            <ReportPage
              defectTypes={snapshot.defectTypes}
              inspections={snapshot.inspections}
              rows={reportRows}
              pageRows={reportPageRows}
              metrics={reportMetrics}
              metadata={reportMetadata}
              filters={reportFilters}
              page={reportPage}
              pageCount={reportPageCount}
              selectedDefect={selectedReportDefect}
              selectedDefectId={uiState.selectedDefectId}
              onFilterChange={updateReportFilters}
              onReset={() => {
                setReportFilters(createDefaultReportFilters());
                setReportPage(1);
                setToast('报表筛选已重置');
              }}
              onApply={() => {
                setReportPage(1);
                setToast(`已查询到 ${reportRows.length} 条缺陷记录`);
              }}
              onPageChange={setReportPage}
              onSelectDefect={selectDefectById}
              onExportCsv={() => {
                downloadTextFile(`${reportMetadata.reportId}.csv`, exportRowsAsCsv(reportRows), 'text/csv;charset=utf-8');
                setToast('缺陷报表 CSV 已导出');
              }}
              onExportJson={() => {
                downloadTextFile(`${reportMetadata.reportId}.json`, exportReportAsJson(reportMetadata, reportRows), 'application/json;charset=utf-8');
                setToast('缺陷报表 JSON 已导出');
              }}
              issueArchiveDisabled={reportMetadata.inspectionIds.length !== 1}
              printArchiveDisabled={reportMetadata.inspectionIds.length !== 1 || reportArchives.length === 0}
              archiveReports={reportArchives}
              archiveStatus={reportArchiveStatus}
              onPrintArchive={(selectedArchive) => {
                if (!selectedArchive || reportMetadata.inspectionIds.length !== 1) {
                  setToast('请先选择单个检测记录并签发归档报告');
                  return;
                }
                void fetchInspectionReportArchive(selectedArchive.inspectionId, selectedArchive.reportId)
                  .then(({ archive }) => {
                    downloadTextFile(
                      `${archive.reportId}.print.html`,
                      exportInspectionArchiveAsPrintableHtml(archive),
                      'text/html;charset=utf-8',
                    );
                    setToast(`归档打印版已生成：${archive.reportId}`);
                  })
                  .catch((error: unknown) => setToast(error instanceof Error ? error.message : '归档打印版生成失败'));
              }}
              onIssueArchive={() => {
                const inspectionId = reportMetadata.inspectionIds[0];
                if (!inspectionId || reportMetadata.inspectionIds.length !== 1) {
                  setToast('请选择单个生产检测记录后再签发归档报告');
                  return;
                }
                void issueInspectionReportArchive(inspectionId)
                  .then((result) => {
                    downloadTextFile(`${result.reportId}.json`, JSON.stringify(result.archive, null, 2), 'application/json;charset=utf-8');
                    setToast(result.created ? `检测报告已签发：${result.reportId}` : `已读取相同归档报告：${result.reportId}`);
                    return fetchInspectionReportArchives(inspectionId);
                  })
                  .then((archivePage) => {
                    setReportArchives(archivePage.reports);
                    setReportArchiveStatus(archivePage.reports.length > 0 ? `已读取 ${archivePage.reports.length} 份归档` : '尚未签发归档报告');
                  })
                  .catch((error: unknown) => setToast(error instanceof Error ? error.message : '检测报告签发失败'));
              }}
            />
          ) : uiState.activeNav === 'alarms' ? (
            <AlarmCenter />
          ) : (
            <SystemStatusPage
              status={deviceStatus}
              operation={operationState}
              capture={captureSnapshot}
              capabilities={runtimeProfile.capabilities}
              cameraCount={runtimeProfile.cameraCount}
              onAction={handleSystemAction}
            />
          )}
        </>
      )}
      <AppFooter
        activeNav={uiState.activeNav}
        dashboardMode={dashboardMode}
        resourceUsage={resourceUsageState.usage}
        resourceUsageStale={resourceUsageState.stale}
        terminalViews={{
          online: { available: dashboardMode.kind !== 'bkv', active: dashboardMode.kind !== 'bkv' },
          bkv: { available: dashboardMode.kind === 'bkv', active: dashboardMode.kind === 'bkv' },
        }}
        flowVisible={inspectionFlowVisible}
        onFlowToggle={() => setInspectionFlowVisible((current) => !current)}
        analysis={selectedOnlineDefect ? {
          defect: selectedOnlineDefect,
          surfaceViewMode: plateMapViewMode,
          analysisViewMode,
          collapsed: analysisCollapsed,
          onSurfaceViewModeChange: setPlateMapViewMode,
          onAnalysisViewModeChange: setAnalysisViewMode,
          onCollapsedChange: setAnalysisCollapsed,
        } : null}
        onNavChange={(activeNav) => setState({ activeNav })}
        onSettingsOpen={() => setSettingsModalOpen(true)}
      />
      {settingsModalOpen ? (
        <div
          className="settings-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSettingsModalOpen(false);
            }
          }}
        >
          <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" data-no-drag>
            <header className="settings-modal-header">
              <div>
                <span>系统配置</span>
                <h2 id="settings-modal-title">配置中心</h2>
              </div>
              <button type="button" aria-label="关闭系统设置" onClick={() => setSettingsModalOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <SettingsPage
              embedded
              theme={uiState.theme}
              themeStyle={uiState.themeStyle}
              draft={settingsDraft}
              saved={savedSettings}
              errors={settingsErrors}
              connection={connectionDraft}
              connectionStatus={connectionStatus}
              onThemeChange={(theme) => setState({ theme })}
              onThemeStyleChange={(themeStyle) => setState({ themeStyle })}
              onDraftChange={(patch) => {
                const nextDraft = { ...settingsDraft, ...patch };
                setSettingsDraft(nextDraft);
                if (Object.keys(settingsErrors).length > 0) {
                  setSettingsErrors(validateSettings(nextDraft));
                }
              }}
              onConnectionChange={updateConnectionDraft}
              onConnectionSave={() => void saveConnection()}
              onSave={() => saveSettings('参数已保存')}
              onReset={resetSettings}
              onApplyToPlate={() => saveSettings('参数已应用到当前钢管')}
            />
          </section>
        </div>
      ) : null}
      <InspectionFlowTool
        visible={inspectionFlowVisible}
        onVisibleChange={setInspectionFlowVisible}
        onSnapshot={onSnapshotChange}
      />
    </div>
  );
}
