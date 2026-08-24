import { useEffect, useRef, useState } from 'react';
import { Activity, Box, Database, History, Monitor, MonitorCog, MoreHorizontal, Play, Settings2 } from 'lucide-react';
import type { DefectItem } from '../data/inspection';
import {
  formatResourceBreakdown,
  formatResourceBytes,
  formatResourcePercent,
  type AppResourceUsage,
} from '../lib/app-resource-usage';
import type { RuntimeDashboardMode } from '../lib/runtime-dashboard-mode';
import { severityLabels, surfaceLabels } from '../data/inspection';
import {
  openBarSurfaceWindow,
  openCaptureManagementWindow,
  openParameterManagementWindow,
} from '../lib/app-windows';
import { notify } from '../state/notifications';
import type { AnalysisViewMode } from './AlarmAnalysis';
import type { NavKey } from './TopNav';
import { DEFAULT_SYSTEM_NAME } from '../lib/system-brand';

interface FooterAnalysisContext {
  defect: DefectItem;
  analysisViewMode: AnalysisViewMode;
  collapsed: boolean;
  onAnalysisViewModeChange: (next: AnalysisViewMode) => void;
  onCollapsedChange: (collapsed: boolean) => void;
}

interface FooterTerminalViewEntry {
  available: boolean;
  active?: boolean;
  onOpen?: () => void;
}

interface FooterTerminalViews {
  online: FooterTerminalViewEntry;
  bkv: FooterTerminalViewEntry;
}

interface AppFooterProps {
  systemName?: string;
  activeNav: NavKey;
  analysis?: FooterAnalysisContext | null;
  terminalViews?: FooterTerminalViews;
  flowVisible?: boolean;
  onFlowToggle?: () => void;
  onNavChange: (next: NavKey) => void;
  onSettingsOpen: () => void;
  onParameterManagementOpen?: () => unknown;
  onCaptureManagementOpen?: () => unknown;
  onBarSurfaceOpen?: () => unknown;
  dashboardMode?: RuntimeDashboardMode;
  resourceUsage?: AppResourceUsage | null;
  resourceUsageStale?: boolean;
}

const DEFAULT_DIRECT_DASHBOARD_MODE: RuntimeDashboardMode = {
  kind: 'direct',
  cameraCount: 8,
  requestsOnlineServices: true,
  requestsStandardRecords: false,
  showsHardwareStatus: true,
  showsCaptureManagement: true,
  showsReconstruction: true,
  supportsOfflineReplay: false,
};

const analysisViewOptions: Array<{ id: AnalysisViewMode; label: string }> = [
  { id: 'diameter', label: '测径（外径）' },
];

const bkvAnalysisViewOptions: Array<{ id: AnalysisViewMode; label: string }> = [
  { id: 'diameter', label: '测径（外径）' },
  { id: 'defects', label: '缺陷' },
];

const defaultTerminalViews: FooterTerminalViews = {
  online: { available: true, active: true },
  bkv: { available: false, active: false },
};

function getDefectSizeLabel(defect: DefectItem) {
  return `${defect.widthMm.toFixed(2)}×${defect.heightMm.toFixed(2)}×${Math.abs(defect.depthMm).toFixed(2)}mm`;
}

export function AppFooter({
  systemName = DEFAULT_SYSTEM_NAME,
  activeNav,
  analysis,
  terminalViews = defaultTerminalViews,
  flowVisible = false,
  onFlowToggle,
  onNavChange,
  onSettingsOpen,
  onParameterManagementOpen = openParameterManagementWindow,
  onCaptureManagementOpen = openCaptureManagementWindow,
  onBarSurfaceOpen = openBarSurfaceWindow,
  dashboardMode = DEFAULT_DIRECT_DASHBOARD_MODE,
  resourceUsage = null,
  resourceUsageStale = false,
}: AppFooterProps) {
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const activeAnalysis = activeNav === 'online' ? analysis : null;
  const resourceSourceLabel = resourceUsage
    ? resourceUsage.precision === 'full' ? '完整桌面应用' : '浏览器服务进程'
    : '等待采样';
  const resourceAriaLabel = `应用性能：${resourceSourceLabel}${resourceUsageStale ? '，数据暂时无法更新' : ''}`;
  const resourceTitle = resourceUsage
    ? [
      `来源：${resourceSourceLabel}${resourceUsageStale ? '（暂时无法更新，显示最近快照）' : ''}`,
      `采样时间：${new Date(resourceUsage.sampledAtMs).toLocaleString()}`,
      `应用内存占系统：${formatResourcePercent(resourceUsage.memoryPercent)}`,
      `进程明细：${formatResourceBreakdown(resourceUsage)}`,
    ].join('\n')
    : `来源：${resourceSourceLabel}${resourceUsageStale ? '（暂时无法更新）' : ''}`;

  useEffect(() => {
    if (!moreMenuOpen) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMoreMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [moreMenuOpen]);

  const openTerminalView = (entry: FooterTerminalViewEntry, fallback?: () => void) => {
    if (!entry.available) return;
    if (entry.onOpen) entry.onOpen();
    else fallback?.();
    setMoreMenuOpen(false);
  };
  const changeAnalysisView = (next: AnalysisViewMode) => {
    activeAnalysis?.onAnalysisViewModeChange(next);
    if (activeAnalysis?.collapsed) {
      activeAnalysis.onCollapsedChange(false);
    }
  };
  const runWindowAction = async (label: string, action: () => unknown) => {
    try {
      const result = await action();
      const navigated = Boolean(
        result
        && typeof result === 'object'
        && 'presentation' in result
        && result.presentation === 'navigation',
      );
      notify({
        title: navigated ? '页面跳转' : '独立窗口',
        message: navigated ? `正在进入${label}` : `已打开${label}窗口`,
        tone: 'success',
      });
    } catch (error) {
      notify({
        title: `${label}打开失败`,
        message: error instanceof Error ? error.message : 'Tauri 窗口创建失败',
        tone: 'error',
      });
    }
  };

  return (
    <footer className={`app-footer ${activeAnalysis ? 'has-analysis-context' : ''}`} data-no-drag>
      {activeAnalysis ? (
        <div className="app-footer-analysis" aria-label="选中缺陷分析工具">
          {dashboardMode.kind === 'bkv' ? (
            <div className="app-footer-view-group bkv-analysis-views" role="group" aria-label="BKV 下方视图">
              {bkvAnalysisViewOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={!activeAnalysis.collapsed && activeAnalysis.analysisViewMode === option.id ? 'active' : ''}
                  aria-pressed={!activeAnalysis.collapsed && activeAnalysis.analysisViewMode === option.id}
                  onClick={() => changeAnalysisView(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="app-footer-defect-summary" title={`缺陷 ${activeAnalysis.defect.id} · ${activeAnalysis.defect.plateNo}`}>
            <span className="app-footer-kicker">当前缺陷</span>
            <strong>{activeAnalysis.defect.typeLabel}</strong>
            <em className={activeAnalysis.defect.severity}>{severityLabels[activeAnalysis.defect.severity]}</em>
            <span>{surfaceLabels[activeAnalysis.defect.surface]}</span>
            <b>{getDefectSizeLabel(activeAnalysis.defect)}</b>
            <span>距头 {activeAnalysis.defect.distanceHeadMm}mm</span>
            <span>操作 {activeAnalysis.defect.operatorSideMm}mm</span>
            <span>传动 {activeAnalysis.defect.driveSideMm}mm</span>
            <span>周期 {activeAnalysis.defect.typeId === 'roll' ? '是' : '否'}</span>
          </div>
          {dashboardMode.kind === 'bkv' ? null : (
            <div className="app-footer-view-group analysis-views" role="group" aria-label="缺陷分析视图">
                <span>分析</span>
                {analysisViewOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={!activeAnalysis.collapsed && activeAnalysis.analysisViewMode === option.id ? 'active' : ''}
                  aria-pressed={!activeAnalysis.collapsed && activeAnalysis.analysisViewMode === option.id}
                  onClick={() => changeAnalysisView(option.id)}
                >
                  {option.label}
                </button>
                ))}
            </div>
          )}
        </div>
      ) : (
        <div className="app-footer-context" aria-label="系统工具栏">
          <span>系统工具</span>
          <strong>{systemName}</strong>
        </div>
      )}
      <div
        className={`app-footer-performance ${resourceUsageStale ? 'stale' : ''}`}
        aria-label={resourceAriaLabel}
        title={resourceTitle}
      >
        <span><b>CPU</b> <strong>{formatResourcePercent(resourceUsage?.cpuUsage)}</strong></span>
        <span><b>内存</b> <strong>{formatResourceBytes(resourceUsage?.memoryUsed)}</strong></span>
        <span className="app-footer-process-count">
          <strong>{resourceUsage ? resourceUsage.processCount : '--'}</strong> 进程
        </span>
      </div>
      {onFlowToggle ? (
        <button
          type="button"
          className={`app-footer-flow-button ${flowVisible ? 'active' : ''}`}
          aria-pressed={flowVisible}
          title={flowVisible ? '关闭完整检测流程工具' : '打开完整检测流程工具'}
          onClick={onFlowToggle}
        >
          <Play size={14} />
          <span>全流程</span>
        </button>
      ) : null}
      <nav className="app-footer-nav" aria-label="非业务功能">
        <button type="button" onClick={onSettingsOpen}>
          <Settings2 size={15} />
          <span>配置中心</span>
        </button>
        <button type="button" onClick={() => void runWindowAction('后台管理', onParameterManagementOpen)}>
          <Database size={15} />
          <span>后台管理</span>
        </button>
        {dashboardMode.showsCaptureManagement ? (
          <button type="button" onClick={() => void runWindowAction('采集管理', onCaptureManagementOpen)}>
            <MonitorCog size={15} />
            <span>采集管理</span>
          </button>
        ) : null}
        {dashboardMode.showsReconstruction ? (
          <button type="button" onClick={() => void runWindowAction('3D 重建', onBarSurfaceOpen)}>
            <Box size={15} />
            <span>3D 重建</span>
          </button>
        ) : null}
        <div className="app-footer-more" ref={moreMenuRef}>
          <button
            type="button"
            className={moreMenuOpen || terminalViews.online.active || terminalViews.bkv.active ? 'active' : ''}
            aria-label="更多功能"
            aria-haspopup="menu"
            aria-expanded={moreMenuOpen}
            onClick={() => setMoreMenuOpen((open) => !open)}
          >
            <MoreHorizontal size={15} />
            <span>更多</span>
          </button>
          {moreMenuOpen ? (
            <div className="app-footer-more-menu" role="menu" aria-label="更多功能菜单">
              <button
                type="button"
                role="menuitem"
                className={activeNav === 'status' ? 'active' : ''}
                aria-current={activeNav === 'status' ? 'page' : undefined}
                onClick={() => {
                  onNavChange('status');
                  setMoreMenuOpen(false);
                }}
              >
                <Activity size={15} />
                <span>系统状态</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={terminalViews.online.active ? 'active' : ''}
                aria-current={terminalViews.online.active ? 'page' : undefined}
                disabled={!terminalViews.online.available}
                onClick={() => openTerminalView(terminalViews.online, () => onNavChange('online'))}
              >
                <Monitor size={15} />
                <span>在线检测</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={terminalViews.bkv.active ? 'active' : ''}
                aria-current={terminalViews.bkv.active ? 'page' : undefined}
                disabled={!terminalViews.bkv.available}
                onClick={() => openTerminalView(terminalViews.bkv)}
              >
                <History size={15} />
                <span>离线回放</span>
              </button>
              {!terminalViews.bkv.available ? <small>仅 BKV 模式可用</small> : null}
            </div>
          ) : null}
        </div>
      </nav>
    </footer>
  );
}
