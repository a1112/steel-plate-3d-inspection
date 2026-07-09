import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { getAllDefects, getPlateInspectionSnapshot, summarizeDefects } from './data/inspection';
import type { DefectItem, InspectionSnapshot, Severity } from './data/inspection';
import type { InspectionUiState } from './state/inspection-ui';
import {
  createInitialUiState,
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
  exportRowsAsCsv,
  filterDefectsForReport,
  getDeviceStatusWithOperation,
  getReportMetrics,
  runSystemAction,
  saveSettingsDraft,
  validateSettings,
} from './state/operations';
import type { InspectionSettings, ReportFilters, SystemAction } from './state/operations';
import { emptyRecordSearchFilters, filterInspectionRecords } from './state/record-search';
import type { RecordSearchFilters } from './state/record-search';
import { getResponsiveProfile, getResponsiveProfileClassName } from './state/responsive-layout';
import {
  createDefaultConnectionConfig,
  fetchConnectionConfig,
  fetchInspectionSnapshot,
  fetchInspectionSettings,
  saveConnectionConfig,
  type ConnectionConfig,
} from './services/inspection-api';
import { canStartTitlebarDrag } from './lib/titlebar-drag';
import { getTauriWindowApi } from './lib/tauri-window';
import {
  calculateSystemNetworkRates,
  createEmptyCaptureSnapshot,
  readCaptureSnapshot,
  readSystemNetworkSnapshot,
  type SystemNetworkSnapshot,
} from './lib/capture-api';
import { BrandHeader } from './components/BrandHeader';
import { AlarmAnalysis } from './components/AlarmAnalysis';
import { DefectDetectionList } from './components/DefectDetectionList';
import { LeftSidebar } from './components/LeftSidebar';
import { PlateMap } from './components/PlateMap';
import { ReportPage } from './components/ReportPage';
import { SettingsPage } from './components/SettingsPage';
import { StatisticsPanel } from './components/StatisticsPanel';
import { ParameterManagementApp } from './components/ParameterManagementApp';
import { CaptureManagementApp, SystemStatusPage } from './components/SystemStatusPage';
import { BarSurfaceApp } from './components/BarSurfaceApp';
import { Toast } from './components/Toast';
import './styles.css';

const DEFECT_PAGE_SIZE = 10;
const RECORD_PAGE_SIZE = 10;
const REPORT_PAGE_SIZE = 8;
const ALL_SEVERITY_FILTERS: Severity[] = ['severe', 'review', 'minor'];

function readViewportSize() {
  if (typeof window === 'undefined') {
    return { width: 1676, height: 945 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

function readAppMode() {
  if (typeof window === 'undefined') {
    return 'terminal';
  }
  const params = new URLSearchParams(window.location.search);
  const app = params.get('app');
  if (app === 'capture' || app === 'parameters' || app === 'bar-surface' || app === 'bar') {
    return app === 'bar' ? 'bar-surface' : app;
  }
  if (app === 'terminal' || app === 'inspection' || app === 'dashboard') {
    return 'terminal';
  }
  return 'terminal';
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
  const appMode = readAppMode();
  if (appMode === 'bar-surface') {
    return <BarSurfaceApp />;
  }

  const [snapshot, setSnapshot] = useState<InspectionSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchInspectionSnapshot(controller.signal)
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setLoadError(error instanceof Error ? error.message : '后台数据接口不可用');
      });
    return () => controller.abort();
  }, []);

  if (!snapshot) {
    return (
      <div className="app-shell theme-dark app-loading-shell">
        <section className="app-loading-panel" role="status" aria-live="polite">
          <span>后台数据系统</span>
          <h1>{loadError ? '后台连接失败' : '正在连接后台数据服务'}</h1>
          <p>{loadError ?? '正在从 Rust 数据服务获取钢管、缺陷、设备和历史记录数据...'}</p>
        </section>
      </div>
    );
  }

  return <InspectionDashboard snapshot={snapshot} onSnapshotChange={setSnapshot} />;
}

function InspectionDashboard({
  snapshot,
  onSnapshotChange,
}: {
  snapshot: InspectionSnapshot;
  onSnapshotChange: (snapshot: InspectionSnapshot) => void;
}) {
  const [appMode] = useState(readAppMode);
  const [uiState, setUiState] = useState(() => createInitialUiState(snapshot));
  const [onlineFilters, setOnlineFilters] = useState<ReportFilters>(() => createDefaultReportFilters());
  const [selectedOnlineSeverities, setSelectedOnlineSeverities] = useState<Set<Severity>>(() => new Set(ALL_SEVERITY_FILTERS));
  const [reportFilters, setReportFilters] = useState<ReportFilters>(() => createDefaultReportFilters());
  const [recordSearchFilters, setRecordSearchFilters] = useState<RecordSearchFilters>(emptyRecordSearchFilters);
  const [defectFilterOpen, setDefectFilterOpen] = useState(false);
  const [reportPage, setReportPage] = useState(1);
  const [savedSettings, setSavedSettings] = useState<InspectionSettings>(() => createDefaultSettings());
  const [settingsDraft, setSettingsDraft] = useState<InspectionSettings>(() => createDefaultSettings());
  const [settingsErrors, setSettingsErrors] = useState(() => validateSettings(createDefaultSettings()));
  const [connectionDraft, setConnectionDraft] = useState<ConnectionConfig>(() => createDefaultConnectionConfig());
  const [connectionStatus, setConnectionStatus] = useState<string | null>('读取中');
  const [operationState, setOperationState] = useState(() => createInitialOperationState());
  const [toast, setToast] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState(readViewportSize);
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [captureSnapshot, setCaptureSnapshot] = useState(() => createEmptyCaptureSnapshot('capture service pending'));
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

  useEffect(() => {
    const handleResize = () => setViewportSize(readViewportSize());
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
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
  }, []);

  useEffect(() => {
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
  }, []);

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
  }, []);

  useEffect(() => {
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
  }, []);

  const activeSnapshot = useMemo(() => getPlateInspectionSnapshot(snapshot, uiState.selectedRecordId), [snapshot, uiState.selectedRecordId]);
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
  const deviceStatus = useMemo(() => getDeviceStatusWithOperation(activeSnapshot.status, operationState), [activeSnapshot.status, operationState]);
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
  const filteredRecords = useMemo(
    () => filterInspectionRecords(snapshot.records, snapshot.inspections, recordSearchFilters),
    [snapshot.records, snapshot.inspections, recordSearchFilters],
  );
  const defectPageCount = getPageCount(visibleDefects.length, DEFECT_PAGE_SIZE);
  const recordPageCount = getPageCount(filteredRecords.length, RECORD_PAGE_SIZE);
  const reportPageCount = getPageCount(reportRows.length, REPORT_PAGE_SIZE);
  const pageDefects = paginateItems(visibleDefects, uiState.defectPage, DEFECT_PAGE_SIZE);
  const pageRecords = paginateItems(filteredRecords, uiState.recordPage, RECORD_PAGE_SIZE);
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
    setUiState((current) => selectDefect(current, allDefects, defectId));
  };

  const selectRecordByPlateNo = (plateNo: string) => {
    setUiState((current) => selectRecord(current, snapshot, plateNo));
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

  const openCurrentPlateReport = () => {
    setReportFilters({ ...createDefaultReportFilters(), keyword: activeSnapshot.currentPlate.plateNo });
    setReportPage(1);
    setState({ activeNav: 'report', selectedRecordId: activeSnapshot.currentPlate.plateNo });
    setToast('已切换到当前钢管报表');
  };

  const saveSettings = (message: string) => {
    const errors = validateSettings(settingsDraft);
    setSettingsErrors(errors);
    if (Object.keys(errors).length > 0) {
      setToast('参数校验未通过，请修正红色提示');
      return;
    }
    setSavedSettings((current) => saveSettingsDraft(current, settingsDraft));
    setToast(message);
  };

  const resetSettings = () => {
    const defaults = createDefaultSettings();
    setSettingsDraft(defaults);
    setSavedSettings(defaults);
    setSettingsErrors({});
    setToast('参数已恢复默认值');
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

  const handleSystemAction = (action: SystemAction) => {
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
      'clear-alarm': '报警计数已清零',
      'sync-time': '系统时间已同步',
      'export-log': '事件日志已导出',
    };
    setToast(messages[action]);
  };

  if (appMode === 'capture') {
    return (
      <div className={`app-shell theme-${uiState.theme} ${responsiveClassName} capture-standalone-shell`}>
        <Toast message={toast} tone="success" onClear={() => setToast(null)} />
        <main className="workspace-page capture-page capture-standalone-page">
          <CaptureManagementApp
            status={deviceStatus}
            operation={operationState}
            capture={captureSnapshot}
            onAction={handleSystemAction}
            className="standalone-capture-manager"
          />
        </main>
      </div>
    );
  }

  if (appMode === 'parameters') {
    return (
      <div className={`app-shell theme-${uiState.theme} ${responsiveClassName} parameter-standalone-shell`}>
        <Toast message={toast} tone="success" onClear={() => setToast(null)} />
        <ParameterManagementApp />
      </div>
    );
  }

  return (
    <div className={`app-shell theme-${uiState.theme} ${responsiveClassName}`}>
      <BrandHeader
        status={deviceStatus}
        theme={uiState.theme}
        capture={captureSnapshot}
        network={networkSnapshot}
        activeNav={uiState.activeNav}
        onNavChange={(activeNav) => setState({ activeNav })}
        onSettingsOpen={() => setSettingsModalOpen(true)}
        onDragMouseDown={(event) => void handleTitlebarMouseDown(event)}
      />
      <Toast message={toast} tone="success" onClear={() => setToast(null)} />

      {uiState.activeNav === 'online' ? (
        <div className="online-workspace">
          <LeftSidebar
            plate={activeSnapshot.currentPlate}
            summary={activeSummary}
            records={pageRecords}
            selectedRecordId={uiState.selectedRecordId}
            page={uiState.recordPage}
            pageCount={recordPageCount}
            searchFilters={recordSearchFilters}
            filteredCount={filteredRecords.length}
            totalCount={snapshot.records.length}
            onPageChange={(recordPage) => setState({ recordPage })}
            onRecordSelect={selectRecordByPlateNo}
            onSearchChange={updateRecordSearchFilters}
            onSearchReset={resetRecordSearchFilters}
          />
          <section className="online-main">
            <main className="dashboard-grid online-dashboard-grid">
              <section className={`center-column ${analysisCollapsed ? 'analysis-collapsed' : ''}`}>
                <PlateMap
                  defectTypes={snapshot.defectTypes}
                  defects={visibleDefects}
                  defectTypeCounts={defectTypeCounts}
                  hiddenTypeIds={uiState.hiddenDefectTypeIds}
                  selectedDefectId={selectedOnlineDefectId}
                  surfaceMode={uiState.surfaceDisplayMode}
                  previewPositionM={uiState.previewPositionM}
                  plateLengthM={activePlateLengthM}
                  onToggleType={(typeId) =>
                    setUiState((current) => ({
                      ...toggleDefectType(current, typeId),
                      defectPage: 1,
                    }))
                  }
                  onSurfaceModeChange={(surfaceDisplayMode) => setState({ surfaceDisplayMode, defectPage: 1 })}
                  onPreviewPositionChange={(previewPositionM) => setState({ previewPositionM: clampPreviewPositionM(previewPositionM, activePlateLengthM) })}
                  onSelectDefect={selectDefectById}
                />
                <AlarmAnalysis
                  selectedDefect={selectedOnlineDefect}
                  heightProfile={activeSnapshot.heightProfile}
                  headerless
                  collapsed={analysisCollapsed}
                  onCollapsedChange={setAnalysisCollapsed}
                />
              </section>
              <aside className="right-column">
                <DefectDetectionList
                  defects={pageDefects}
                  selectedDefectId={selectedOnlineDefectId}
                  page={uiState.defectPage}
                  pageCount={defectPageCount}
                  filters={onlineFilters}
                  filterOpen={defectFilterOpen}
                  onPageChange={(defectPage) => setState({ defectPage })}
                  onSelectDefect={selectDefectById}
                  onToggleFilter={() => setDefectFilterOpen((current) => !current)}
                  onFilterChange={updateOnlineFilters}
                  onClearFilters={() => {
                    setOnlineFilters(createDefaultReportFilters());
                    setState({ defectPage: 1 });
                  }}
                />
                <StatisticsPanel
                  plate={activeSnapshot.currentPlate}
                  summary={activeSummary}
                  selectedSeverityFilters={selectedOnlineSeverities}
                  onSeverityFilterToggle={toggleOnlineSeverity}
                  onOpenReport={openCurrentPlateReport}
                />
              </aside>
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
                downloadTextFile('defect-report.csv', exportRowsAsCsv(reportRows), 'text/csv;charset=utf-8');
                setToast('缺陷报表 CSV 已导出');
              }}
              onExportJson={() => {
                downloadTextFile('defect-report.json', JSON.stringify(reportRows, null, 2), 'application/json;charset=utf-8');
                setToast('缺陷报表 JSON 已导出');
              }}
            />
          ) : (
            <SystemStatusPage status={deviceStatus} operation={operationState} capture={captureSnapshot} onAction={handleSystemAction} />
          )}
        </>
      )}
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
                <span>系统参数</span>
                <h2 id="settings-modal-title">系统设置</h2>
              </div>
              <button type="button" aria-label="关闭系统设置" onClick={() => setSettingsModalOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <SettingsPage
              embedded
              theme={uiState.theme}
              draft={settingsDraft}
              saved={savedSettings}
              errors={settingsErrors}
              connection={connectionDraft}
              connectionStatus={connectionStatus}
              onThemeChange={(theme) => setState({ theme })}
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
    </div>
  );
}
