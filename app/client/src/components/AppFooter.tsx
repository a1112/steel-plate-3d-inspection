import { useEffect, useRef, useState } from 'react';
import { Box, Database, History, Monitor, MonitorCog, MoreHorizontal, Play, Settings2 } from 'lucide-react';
import type { DefectItem } from '../data/inspection';
import { severityLabels, surfaceLabels } from '../data/inspection';
import {
  openBarSurfaceWindow,
  openCaptureManagementWindow,
  openParameterManagementWindow,
} from '../lib/app-windows';
import { notify } from '../state/notifications';
import type { RuntimeCapabilities } from '../services/runtime-profile-api';
import type { AnalysisViewMode } from './AlarmAnalysis';
import type { PlateMapViewMode } from './PlateMap';
import type { NavKey } from './TopNav';

interface FooterAnalysisContext {
  defect: DefectItem;
  surfaceViewMode: PlateMapViewMode;
  analysisViewMode: AnalysisViewMode;
  collapsed: boolean;
  onSurfaceViewModeChange: (next: PlateMapViewMode) => void;
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
  capabilities?: RuntimeCapabilities;
}

const surfaceViewOptions: Array<{ id: PlateMapViewMode; label: string }> = [
  { id: '2d', label: '2D' },
  { id: '3d', label: '3D' },
  { id: 'point-cloud', label: '点云' },
];

const analysisViewOptions: Array<{ id: AnalysisViewMode; label: string }> = [
  { id: 'overview', label: '综合' },
  { id: 'image', label: '灰度' },
  { id: 'point-cloud', label: '局部点云' },
  { id: 'profile', label: '剖面' },
];

const defaultTerminalViews: FooterTerminalViews = {
  online: { available: true, active: true },
  bkv: { available: false, active: false },
};

function getDefectSizeLabel(defect: DefectItem) {
  return `${defect.widthMm.toFixed(2)}×${defect.heightMm.toFixed(2)}×${Math.abs(defect.depthMm).toFixed(2)}mm`;
}

export function AppFooter({
  activeNav,
  analysis,
  terminalViews = defaultTerminalViews,
  flowVisible = false,
  onFlowToggle,
  onSettingsOpen,
  onParameterManagementOpen = openParameterManagementWindow,
  onCaptureManagementOpen = openCaptureManagementWindow,
  onBarSurfaceOpen = openBarSurfaceWindow,
  capabilities = {
    directCamera: true,
    captureManagement: true,
    reconstruction: true,
    offlineReplay: false,
  },
}: AppFooterProps) {
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const activeAnalysis = activeNav === 'online' ? analysis : null;

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
    entry.onOpen?.();
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
      await action();
      notify({ title: '独立窗口', message: `已打开${label}窗口`, tone: 'success' });
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
          <div className="app-footer-view-group" role="group" aria-label="主检测视图">
            <span>主视图</span>
            {surfaceViewOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={activeAnalysis.surfaceViewMode === option.id ? 'active' : ''}
                aria-pressed={activeAnalysis.surfaceViewMode === option.id}
                onClick={() => activeAnalysis.onSurfaceViewModeChange(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
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
        </div>
      ) : (
        <div className="app-footer-context" aria-label="系统工具栏">
          <span>系统工具</span>
          <strong>钢管 3D 表面检测平台</strong>
        </div>
      )}
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
        {capabilities.captureManagement ? (
          <button type="button" onClick={() => void runWindowAction('采集管理', onCaptureManagementOpen)}>
            <MonitorCog size={15} />
            <span>采集管理</span>
          </button>
        ) : null}
        {capabilities.reconstruction ? (
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
                className={terminalViews.online.active ? 'active' : ''}
                aria-current={terminalViews.online.active ? 'page' : undefined}
                disabled={!terminalViews.online.available}
                onClick={() => openTerminalView(terminalViews.online)}
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
