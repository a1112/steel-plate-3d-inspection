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
  it('shows the service IP and live connection state in the lower-left corner', () => {
    const onConnectionSettingsOpen = vi.fn();
    const { rerender } = render(
      <AppFooter
        activeNav="online"
        connection={{
          endpoint: 'http://127.0.0.1:4873',
          state: 'online',
          detail: '检测服务已就绪',
        }}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
        onConnectionSettingsOpen={onConnectionSettingsOpen}
      />,
    );

    const connectionButton = screen.getByRole('button', { name: '服务连接：已连接，IP 127.0.0.1:4873' });
    expect(connectionButton).toHaveTextContent('连接 IP127.0.0.1:4873已连接');
    fireEvent.click(connectionButton);
    expect(onConnectionSettingsOpen).toHaveBeenCalledTimes(1);

    rerender(
      <AppFooter
        activeNav="online"
        connection={{
          endpoint: 'http://192.168.1.8:4873',
          state: 'offline',
          detail: '检测服务离线',
        }}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
        onConnectionSettingsOpen={onConnectionSettingsOpen}
      />,
    );

    expect(screen.getByLabelText('服务连接：未连接，IP 192.168.1.8:4873')).toHaveClass('offline');

    rerender(
      <AppFooter
        activeNav="online"
        connection={{
          endpoint: 'http://127.0.0.1:4873',
          state: 'warning',
          detail: '历史数据可用，实时采集未就绪',
        }}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
        onConnectionSettingsOpen={onConnectionSettingsOpen}
      />,
    );

    expect(screen.getByLabelText('服务连接：已连接·降级，IP 127.0.0.1:4873')).toHaveClass('warning');
  });

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
    expect(screen.getByRole('button', { name: '服务状态' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '采集管理' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3D 重建' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '更多功能' }));
    expect(screen.getByRole('menuitem', { name: '采集管理' })).toBeInTheDocument();
  });

  it('places the online real-time/playback toggle at the far right of the footer', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <AppFooter
        activeNav="online"
        onlineWorkspace={{ mode: 'inspection', onToggle }}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    const liveButton = screen.getByRole('button', { name: '实时/回放' });
    expect(liveButton).toHaveAttribute('aria-pressed', 'false');
    expect(liveButton).toBe(screen.getByRole('navigation', { name: '非业务功能' }).lastElementChild);
    fireEvent.click(liveButton);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <AppFooter
        activeNav="online"
        onlineWorkspace={{ mode: 'camera', onToggle }}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '返回检测' })).toHaveAttribute('aria-pressed', 'true');
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

    expect(screen.queryByLabelText('选中缺陷分析工具')).not.toBeInTheDocument();
    expect(screen.getByLabelText('BKV 下方分析视图')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '主检测视图' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'BKV 下方视图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测径（外径）' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '缺陷' }));
    expect(onAnalysisViewModeChange).toHaveBeenCalledWith('defects');
  });

  it('opens the more menu and disables offline replay outside BKV mode', () => {
    const onBkvOpen = vi.fn();
    render(
      <AppFooter
        activeNav="online"
        terminalViews={{
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
    const replayItem = screen.getByRole('menuitem', { name: '离线回放' });
    expect(screen.queryByRole('menuitem', { name: '在线检测' })).not.toBeInTheDocument();
    expect(replayItem).toBeDisabled();
    expect(screen.getByText('仅 BKV 模式可用')).toBeInTheDocument();
    fireEvent.click(replayItem);
    expect(onBkvOpen).not.toHaveBeenCalled();
  });

  it('does not duplicate the top-level online monitoring entry in the footer', () => {
    render(
      <AppFooter
        activeNav="online"
        terminalViews={{
          bkv: { available: true, active: true, onOpen: vi.fn() },
        }}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '更多功能' }));
    expect(screen.getByRole('menuitem', { name: '离线回放' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('menuitem', { name: '在线检测' })).not.toBeInTheDocument();
  });

  it('closes the more menu when Escape is pressed', () => {
    render(
      <AppFooter
        activeNav="online"
        terminalViews={{
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

  it('opens software update from the more menu', async () => {
    render(
      <AppFooter
        activeNav="online"
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '更多功能' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '软件更新' }));

    expect(await screen.findByRole('dialog', { name: '软件版本更新' })).toBeInTheDocument();
    expect(screen.getByText(/软件安装仅在正式桌面客户端中可用/)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: '更多功能' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '采集管理' }));
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

    expect(screen.queryByRole('button', { name: '全流程' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '更多功能' }));
    const flowButton = screen.getByRole('menuitem', { name: '全流程' });
    expect(flowButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(flowButton);
    expect(onFlowToggle).toHaveBeenCalledTimes(1);
  });

  it('removes direct-camera selected-defect information and analysis controls from the footer', () => {
    render(
      <AppFooter
        activeNav="online"
        analysis={{
          defect,
          analysisViewMode: 'overview',
          collapsed: true,
          onAnalysisViewModeChange: vi.fn(),
          onCollapsedChange: vi.fn(),
        }}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('选中缺陷分析工具')).not.toBeInTheDocument();
    expect(screen.queryByText('当前缺陷')).not.toBeInTheDocument();
    expect(screen.queryByText('0.42×0.36×0.12mm')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '主检测视图' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '3D' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '测径（外径）' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '收起缺陷分析区' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '展开缺陷分析区' })).not.toBeInTheDocument();
  });
});
