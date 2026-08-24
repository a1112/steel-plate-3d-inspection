import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DefectItem } from '../data/inspection';
import type { AppResourceUsage } from '../lib/app-resource-usage';
import type { RuntimeDashboardMode } from '../lib/runtime-dashboard-mode';
import { AppFooter } from './AppFooter';

const defect: DefectItem = {
  id: 'D-001',
  plateNo: 'P-001',
  typeId: 'pit',
  typeLabel: '凹坑',
  surface: 'top',
  severity: 'severe',
  distanceHeadMm: 8342,
  operatorSideMm: 1260,
  driveSideMm: 2240,
  widthMm: 0.42,
  heightMm: 0.36,
  depthMm: -0.12,
  xRatio: 0.68,
  yOffsetMm: 0.4,
  previewX: 50,
  previewY: 48,
  previewImageUrl: '',
};

const bkvDashboardMode: RuntimeDashboardMode = {
  kind: 'bkv',
  cameraCount: 6,
  requestsOnlineServices: false,
  requestsStandardRecords: true,
  showsHardwareStatus: false,
  showsCaptureManagement: false,
  showsReconstruction: false,
  supportsOfflineReplay: true,
};

const fullResourceUsage: AppResourceUsage = {
  cpuUsage: 12.36,
  memoryUsed: 448_790_528,
  memoryTotal: 16 * 1024 * 1024 * 1024,
  memoryPercent: 2.61,
  processCount: 5,
  pythonMemoryUsed: 128 * 1024 * 1024,
  rustMemoryUsed: 64 * 1024 * 1024,
  webviewMemoryUsed: 200 * 1024 * 1024,
  nodeMemoryUsed: 0,
  tauriMemoryUsed: 36 * 1024 * 1024,
  otherMemoryUsed: 0,
  largestProcessName: 'msedgewebview2.exe',
  largestProcessMemoryUsed: 200 * 1024 * 1024,
  sampledAtMs: Date.UTC(2026, 6, 26, 12, 0, 0),
  source: 'tauri',
  precision: 'full',
};

describe('AppFooter', () => {
  it('shows compact full-desktop resource usage with runtime details', () => {
    render(
      <AppFooter
        activeNav="online"
        resourceUsage={fullResourceUsage}
        resourceUsageStale={false}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    const monitor = screen.getByLabelText('应用性能：完整桌面应用');
    expect(monitor).toHaveTextContent('CPU 12.4%');
    expect(monitor).toHaveTextContent('内存 428.0 MB');
    expect(monitor).toHaveTextContent('5 进程');
    expect(monitor).toHaveAttribute('title', expect.stringContaining('WebView: 200.0 MB'));
    expect(monitor).toHaveAttribute('title', expect.stringContaining('最大进程: msedgewebview2.exe'));
  });

  it('labels browser fallback metrics and unavailable snapshots accurately', () => {
    const { rerender } = render(
      <AppFooter
        activeNav="online"
        resourceUsage={{ ...fullResourceUsage, source: 'service', precision: 'degraded' }}
        resourceUsageStale
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('应用性能：浏览器服务进程，数据暂时无法更新')).toBeInTheDocument();

    rerender(
      <AppFooter
        activeNav="online"
        resourceUsage={null}
        resourceUsageStale
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );
    const unavailable = screen.getByLabelText('应用性能：等待采样，数据暂时无法更新');
    expect(unavailable).toHaveTextContent('CPU --');
    expect(unavailable).toHaveTextContent('内存 --');
  });

  it('groups the non-business entries in the footer', () => {
    render(<AppFooter activeNav="online" onNavChange={vi.fn()} onSettingsOpen={vi.fn()} />);

    expect(screen.getByRole('button', { name: '配置中心' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '后台管理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '采集管理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3D 重建' })).toBeInTheDocument();
  });

  it('hides direct-camera tools in BKV mode while keeping backend management visible', () => {
    render(
      <AppFooter
        activeNav="online"
        dashboardMode={bkvDashboardMode}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '后台管理' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '采集管理' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '3D 重建' })).not.toBeInTheDocument();
  });

  it('keeps main BKV switching in the toolbar and moves lower analysis switching to the footer', () => {
    const onAnalysisViewModeChange = vi.fn();
    render(
      <AppFooter
        activeNav="online"
        dashboardMode={bkvDashboardMode}
        analysis={{
          defect,
          analysisViewMode: 'diameter',
          collapsed: false,
          onAnalysisViewModeChange,
          onCollapsedChange: vi.fn(),
        }}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('选中缺陷分析工具')).toHaveTextContent('凹坑');
    expect(screen.queryByRole('group', { name: '主检测视图' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'BKV 下方视图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '宽度曲线' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '缺陷' }));
    expect(onAnalysisViewModeChange).toHaveBeenCalledWith('defects');
  });

  it('opens the more menu and disables offline replay outside BKV mode', () => {
    const onOnlineOpen = vi.fn();
    const onBkvOpen = vi.fn();
    render(
      <AppFooter
        activeNav="online"
        terminalViews={{
          online: { available: true, active: true, onOpen: onOnlineOpen },
          bkv: { available: false, active: false, onOpen: onBkvOpen },
        }}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    const moreButton = screen.getByRole('button', { name: '更多功能' });
    expect(moreButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(moreButton);

    expect(moreButton).toHaveAttribute('aria-expanded', 'true');
    const onlineItem = screen.getByRole('menuitem', { name: '在线检测' });
    const replayItem = screen.getByRole('menuitem', { name: '离线回放' });
    expect(onlineItem).toBeEnabled();
    expect(onlineItem).toHaveAttribute('aria-current', 'page');
    expect(replayItem).toBeDisabled();
    expect(screen.getByText('仅 BKV 模式可用')).toBeInTheDocument();
    fireEvent.click(replayItem);
    expect(onOnlineOpen).not.toHaveBeenCalled();
    expect(onBkvOpen).not.toHaveBeenCalled();
  });

  it('opens the original online inspection view from BKV mode', () => {
    const onOnlineOpen = vi.fn();
    render(
      <AppFooter
        activeNav="online"
        terminalViews={{
          online: { available: true, active: false, onOpen: onOnlineOpen },
          bkv: { available: true, active: true, onOpen: vi.fn() },
        }}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '更多功能' }));
    expect(screen.getByRole('menuitem', { name: '离线回放' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('menuitem', { name: '在线检测' }));

    expect(onOnlineOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes the more menu when Escape is pressed', () => {
    render(
      <AppFooter
        activeNav="online"
        terminalViews={{
          online: { available: true, active: false, onOpen: vi.fn() },
          bkv: { available: true, active: true, onOpen: vi.fn() },
        }}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    const moreButton = screen.getByRole('button', { name: '更多功能' });
    fireEvent.click(moreButton);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(moreButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the system status page from the more menu', () => {
    const onNavChange = vi.fn();
    render(
      <AppFooter
        activeNav="online"
        onNavChange={onNavChange}
        onSettingsOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '更多功能' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '系统状态' }));

    expect(onNavChange).toHaveBeenCalledWith('status');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens management tools through independent-window callbacks', () => {
    const onSettingsOpen = vi.fn();
    const onParameterManagementOpen = vi.fn();
    const onCaptureManagementOpen = vi.fn();
    const onBarSurfaceOpen = vi.fn();
    render(
      <AppFooter
        activeNav="status"
        onNavChange={vi.fn()}
        onSettingsOpen={onSettingsOpen}
        onParameterManagementOpen={onParameterManagementOpen}
        onCaptureManagementOpen={onCaptureManagementOpen}
        onBarSurfaceOpen={onBarSurfaceOpen}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '配置中心' }));
    fireEvent.click(screen.getByRole('button', { name: '后台管理' }));
    fireEvent.click(screen.getByRole('button', { name: '采集管理' }));
    fireEvent.click(screen.getByRole('button', { name: '3D 重建' }));

    expect(onSettingsOpen).toHaveBeenCalledTimes(1);
    expect(onParameterManagementOpen).toHaveBeenCalledTimes(1);
    expect(onCaptureManagementOpen).toHaveBeenCalledTimes(1);
    expect(onBarSurfaceOpen).toHaveBeenCalledTimes(1);
  });

  it('opens the complete inspection flow from the footer without a floating launcher', () => {
    const onFlowToggle = vi.fn();
    render(
      <AppFooter
        activeNav="online"
        flowVisible={false}
        onFlowToggle={onFlowToggle}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    const flowButton = screen.getByRole('button', { name: '全流程' });
    expect(flowButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(flowButton);
    expect(onFlowToggle).toHaveBeenCalledTimes(1);
  });

  it('keeps only lower defect-analysis view switchers in the footer', () => {
    const onAnalysisViewModeChange = vi.fn();
    const onCollapsedChange = vi.fn();
    render(
      <AppFooter
        activeNav="online"
        analysis={{
          defect,
          analysisViewMode: 'overview',
          collapsed: true,
          onAnalysisViewModeChange,
          onCollapsedChange,
        }}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('选中缺陷分析工具')).toHaveTextContent('凹坑');
    expect(screen.getByLabelText('选中缺陷分析工具')).toHaveTextContent('0.42×0.36×0.12mm');
    expect(screen.queryByRole('group', { name: '主检测视图' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '3D' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '局部点云' }));

    expect(onAnalysisViewModeChange).toHaveBeenCalledWith('point-cloud');
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('button', { name: '收起缺陷分析区' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '展开缺陷分析区' })).not.toBeInTheDocument();
  });
});
