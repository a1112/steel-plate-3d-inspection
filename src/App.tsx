import { useEffect, useMemo, useState } from 'react';
import { getAllDefects, getMockInspectionSnapshot, getPlateInspectionSnapshot, summarizeDefects } from './data/inspection';
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
  toggleTheme,
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
import { canStartTitlebarDrag } from './lib/titlebar-drag';
import { getTauriWindowApi } from './lib/tauri-window';
import { BrandHeader } from './components/BrandHeader';
import { AlarmAnalysis } from './components/AlarmAnalysis';
import { DefectDetectionList } from './components/DefectDetectionList';
import { LeftSidebar } from './components/LeftSidebar';
import { PlateMap } from './components/PlateMap';
import { ReportPage } from './components/ReportPage';
import { SettingsPage } from './components/SettingsPage';
import { StatisticsPanel } from './components/StatisticsPanel';
import { SystemStatusPage } from './components/SystemStatusPage';
import { Toast } from './components/Toast';
import { TopNav } from './components/TopNav';
import './styles.css';

const DEFECT_PAGE_SIZE = 10;
const RECORD_PAGE_SIZE = 10;
const REPORT_PAGE_SIZE = 8;

function readViewportSize() {
  if (typeof window === 'undefined') {
    return { width: 1676, height: 945 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
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

export default function App() {
  const snapshot = useMemo(() => getMockInspectionSnapshot(), []);
  const [uiState, setUiState] = useState(() => createInitialUiState(snapshot));
  const [onlineFilters, setOnlineFilters] = useState<ReportFilters>(() => createDefaultReportFilters());
  const [reportFilters, setReportFilters] = useState<ReportFilters>(() => createDefaultReportFilters());
  const [recordSearchFilters, setRecordSearchFilters] = useState<RecordSearchFilters>(emptyRecordSearchFilters);
  const [defectFilterOpen, setDefectFilterOpen] = useState(false);
  const [reportPage, setReportPage] = useState(1);
  const [savedSettings, setSavedSettings] = useState<InspectionSettings>(() => createDefaultSettings());
  const [settingsDraft, setSettingsDraft] = useState<InspectionSettings>(() => createDefaultSettings());
  const [settingsErrors, setSettingsErrors] = useState(() => validateSettings(createDefaultSettings()));
  const [operationState, setOperationState] = useState(() => createInitialOperationState());
  const [toast, setToast] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState(readViewportSize);
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const windowApi = useMemo(() => getTauriWindowApi(), []);
  const responsiveClassName = getResponsiveProfileClassName(getResponsiveProfile(viewportSize));

  useEffect(() => {
    const handleResize = () => setViewportSize(readViewportSize());
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
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
    () => filterDefectsForReport(filterDefectsBySurfaceMode(currentPlateDefects, uiState.surfaceDisplayMode), onlineFilters),
    [currentPlateDefects, uiState.surfaceDisplayMode, onlineFilters],
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
    () => filterDefectsForReport(surfaceVisibleDefects, onlineFilters),
    [surfaceVisibleDefects, onlineFilters],
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
    setToast('已切换到当前钢板报表');
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

  return (
    <div className={`app-shell theme-${uiState.theme} ${responsiveClassName}`}>
      <BrandHeader
        status={deviceStatus}
        theme={uiState.theme}
        onThemeToggle={() => setUiState((current) => ({ ...current, theme: toggleTheme(current.theme) }))}
        onDragMouseDown={(event) => void handleTitlebarMouseDown(event)}
      />
      <Toast message={toast} tone="success" onClear={() => setToast(null)} />

      {uiState.activeNav === 'online' ? (
        <div className="online-workspace">
          <LeftSidebar
            plate={activeSnapshot.currentPlate}
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
            <TopNav
              active={uiState.activeNav}
              summary={activeSummary}
              onChange={(activeNav) => setState({ activeNav })}
              onDragMouseDown={(event) => void handleTitlebarMouseDown(event)}
            />
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
                  activeSeverityFilter={onlineFilters.severity}
                  onSeverityFilterChange={(severity) => updateOnlineFilters({ severity })}
                  onOpenReport={openCurrentPlateReport}
                />
              </aside>
            </main>
          </section>
        </div>
      ) : (
        <>
          <TopNav
            active={uiState.activeNav}
            summary={activeSummary}
            onChange={(activeNav) => setState({ activeNav })}
            onDragMouseDown={(event) => void handleTitlebarMouseDown(event)}
          />
          {uiState.activeNav === 'report' ? (
            <ReportPage
              defectTypes={snapshot.defectTypes}
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
          ) : uiState.activeNav === 'settings' ? (
            <SettingsPage
              draft={settingsDraft}
              saved={savedSettings}
              errors={settingsErrors}
              onDraftChange={(patch) => {
                const nextDraft = { ...settingsDraft, ...patch };
                setSettingsDraft(nextDraft);
                if (Object.keys(settingsErrors).length > 0) {
                  setSettingsErrors(validateSettings(nextDraft));
                }
              }}
              onSave={() => saveSettings('参数已保存')}
              onReset={resetSettings}
              onApplyToPlate={() => saveSettings('参数已应用到当前钢板')}
            />
          ) : (
            <SystemStatusPage status={deviceStatus} operation={operationState} onAction={handleSystemAction} />
          )}
        </>
      )}
    </div>
  );
}
