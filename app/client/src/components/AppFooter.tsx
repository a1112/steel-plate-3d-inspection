import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, Box, Database, Download, History, MonitorCog, MoreHorizontal, Play, Radio, ServerCog, Settings2 } from 'lucide-react';
import type { DefectItem } from '../data/inspection';
import {
  formatResourceBreakdown,
  formatResourceBytes,
  formatResourcePercent,
  type AppResourceUsage,
} from '../lib/app-resource-usage';
import type { RuntimeDashboardMode } from '../lib/runtime-dashboard-mode';
import {
  openBarSurfaceWindow,
  openCaptureManagementWindow,
  openParameterManagementWindow,
} from '../lib/app-windows';
import { notify } from '../state/notifications';
import type { AnalysisViewMode } from './AlarmAnalysis';
import type { NavKey } from './TopNav';
import { DEFAULT_SYSTEM_NAME } from '../lib/system-brand';
import { acquisitionModeLabel } from '../lib/acquisition-mode';
import { SoftwareUpdateDialog } from './SoftwareUpdateDialog';
import { ServiceStatusDialog } from './ServiceStatusDialog';

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
  onConnectionSettingsOpen?: () => void;
  onParameterManagementOpen?: () => unknown;
  onCaptureManagementOpen?: () => unknown;
  onBarSurfaceOpen?: () => unknown;
  dashboardMode?: RuntimeDashboardMode;
  resourceUsage?: AppResourceUsage | null;
  resourceUsageStale?: boolean;
  connection?: {
    endpoint: string;
    state: 'online' | 'warning' | 'offline';
    detail?: string;
  };
  onlineWorkspace?: {
    mode: 'inspection' | 'camera';
    onToggle: () => void;
  };
}

const DEFAULT_DIRECT_DASHBOARD_MODE: RuntimeDashboardMode = {
  kind: 'direct',
  acquisitionMode: 'online',
  cameraCount: 8,
  requestsOnlineServices: true,
  requestsStandardRecords: false,
  showsHardwareStatus: true,
  showsCaptureManagement: true,
  showsReconstruction: true,
  supportsOfflineReplay: false,
  acquisitionDisabled: false,
  allowsAcquisitionWrites: true,
  readOnly: false,
  usesPhysicalHardware: true,
  usesSimulationSource: false,
  allowsProductionWrites: true,
};

const bkvAnalysisViewOptions: Array<{ id: AnalysisViewMode; label: string }> = [
  { id: 'diameter', label: '测径（外径）' },
  { id: 'defects', label: '缺陷' },
];

const defaultTerminalViews: FooterTerminalViews = {
  bkv: { available: false, active: false },
};

function formatConnectionEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '') || '--';
  }
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
  onConnectionSettingsOpen,
  onParameterManagementOpen = openParameterManagementWindow,
  onCaptureManagementOpen = openCaptureManagementWindow,
  onBarSurfaceOpen = openBarSurfaceWindow,
  dashboardMode = DEFAULT_DIRECT_DASHBOARD_MODE,
  resourceUsage = null,
  resourceUsageStale = false,
  connection,
  onlineWorkspace,
}: AppFooterProps) {
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [softwareUpdateOpen, setSoftwareUpdateOpen] = useState(false);
  const [serviceStatusOpen, setServiceStatusOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const activeAnalysis = activeNav === 'online' ? analysis : null;
  const visibleAnalysis = dashboardMode.kind === 'bkv' ? activeAnalysis : null;
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
  const connectionLabel = connection?.state === 'online'
    ? '已连接'
    : connection?.state === 'offline'
      ? '未连接'
      : '已连接·降级';
  const connectionEndpoint = connection ? formatConnectionEndpoint(connection.endpoint) : '--';

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

  const openTerminalView = (entry: FooterTerminalViewEntry) => {
    if (!entry.available) return;
    if (entry.onOpen) entry.onOpen();
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
    <>
      <footer className={`app-footer ${visibleAnalysis ? 'has-analysis-context' : ''}`} data-no-drag>
      <div className={`app-footer-runtime-mode mode-${dashboardMode.acquisitionMode}`} aria-label={`运行模式：${acquisitionModeLabel(dashboardMode.acquisitionMode)}`}>
        <i aria-hidden="true" />
        <span>运行模式</span>
        <strong>{acquisitionModeLabel(dashboardMode.acquisitionMode)}</strong>
      </div>
      {connection ? (
        <button
          type="button"
          className={`app-footer-connection ${connection.state}`}
          aria-label={`服务连接：${connectionLabel}，IP ${connectionEndpoint}`}
          aria-haspopup="dialog"
          title={`${connection.detail || `检测服务 ${connectionLabel}`}；点击配置服务 IP`}
          onClick={onConnectionSettingsOpen ?? onSettingsOpen}
        >
          <i aria-hidden="true" />
          <span>连接 IP</span>
          <strong>{connectionEndpoint}</strong>
          <em>{connectionLabel}</em>
        </button>
      ) : null}
      {visibleAnalysis ? (
        <div className="app-footer-analysis" aria-label="BKV 下方分析视图">
          <div className="app-footer-view-group bkv-analysis-views" role="group" aria-label="BKV 下方视图">
            {bkvAnalysisViewOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={!visibleAnalysis.collapsed && visibleAnalysis.analysisViewMode === option.id ? 'active' : ''}
                aria-pressed={!visibleAnalysis.collapsed && visibleAnalysis.analysisViewMode === option.id}
                onClick={() => changeAnalysisView(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
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
      <nav className="app-footer-nav" aria-label="非业务功能">
        <button type="button" onClick={onSettingsOpen}>
          <Settings2 size={15} />
          <span>配置中心</span>
        </button>
        <button type="button" onClick={() => void runWindowAction('后台管理', onParameterManagementOpen)}>
          <Database size={15} />
          <span>后台管理</span>
        </button>
        <button type="button" onClick={() => setServiceStatusOpen(true)}>
          <ServerCog size={15} />
          <span>服务状态</span>
        </button>
        {dashboardMode.showsReconstruction ? (
          <button type="button" onClick={() => void runWindowAction('3D 重建', onBarSurfaceOpen)}>
            <Box size={15} />
            <span>3D 重建</span>
          </button>
        ) : null}
        <div className="app-footer-more" ref={moreMenuRef}>
          <button
            type="button"
            className={moreMenuOpen || terminalViews.bkv.active ? 'active' : ''}
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
              {onFlowToggle ? (
                <button
                  type="button"
                  role="menuitem"
                  className={flowVisible ? 'active' : ''}
                  aria-pressed={flowVisible}
                  onClick={() => {
                    onFlowToggle();
                    setMoreMenuOpen(false);
                  }}
                >
                  <Play size={15} />
                  <span>全流程</span>
                </button>
              ) : null}
              {dashboardMode.showsCaptureManagement ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    void runWindowAction('采集管理', onCaptureManagementOpen);
                  }}
                >
                  <MonitorCog size={15} />
                  <span>采集管理</span>
                </button>
              ) : null}
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
                className={terminalViews.bkv.active ? 'active' : ''}
                aria-current={terminalViews.bkv.active ? 'page' : undefined}
                disabled={!terminalViews.bkv.available}
                onClick={() => openTerminalView(terminalViews.bkv)}
              >
                <History size={15} />
                <span>离线回放</span>
              </button>
              {!terminalViews.bkv.available ? <small>仅 BKV 模式可用</small> : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreMenuOpen(false);
                  setSoftwareUpdateOpen(true);
                }}
              >
                <Download size={15} />
                <span>软件更新</span>
              </button>
            </div>
          ) : null}
        </div>
        {onlineWorkspace ? (
          <button
            type="button"
            className={`app-footer-online-workspace ${onlineWorkspace.mode === 'camera' ? 'active' : ''}`}
            aria-pressed={onlineWorkspace.mode === 'camera'}
            title={onlineWorkspace.mode === 'camera' ? '返回在线检测结果' : '进入相机实时与历史回放'}
            onClick={onlineWorkspace.onToggle}
          >
            {onlineWorkspace.mode === 'camera' ? <ArrowLeft size={15} /> : <Radio size={15} />}
            <span>{onlineWorkspace.mode === 'camera' ? '返回检测' : '实时/回放'}</span>
          </button>
        ) : null}
      </nav>
      </footer>
      {softwareUpdateOpen ? <SoftwareUpdateDialog onClose={() => setSoftwareUpdateOpen(false)} /> : null}
      {serviceStatusOpen ? <ServiceStatusDialog onClose={() => setServiceStatusOpen(false)} /> : null}
    </>
  );
}
