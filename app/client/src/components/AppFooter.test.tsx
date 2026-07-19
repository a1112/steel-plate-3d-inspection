import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DefectItem } from '../data/inspection';
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

describe('AppFooter', () => {
  it('groups the non-business entries in the footer', () => {
    render(<AppFooter activeNav="online" onNavChange={vi.fn()} onSettingsOpen={vi.fn()} />);

    expect(screen.getByRole('button', { name: '配置中心' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '后台管理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '采集管理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3D 重建' })).toBeInTheDocument();
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

  it('moves defect details and both view switchers into the online footer', () => {
    const onSurfaceViewModeChange = vi.fn();
    const onAnalysisViewModeChange = vi.fn();
    const onCollapsedChange = vi.fn();
    render(
      <AppFooter
        activeNav="online"
        analysis={{
          defect,
          surfaceViewMode: '2d',
          analysisViewMode: 'overview',
          collapsed: false,
          onSurfaceViewModeChange,
          onAnalysisViewModeChange,
          onCollapsedChange,
        }}
        onNavChange={vi.fn()}
        onSettingsOpen={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('选中缺陷分析工具')).toHaveTextContent('凹坑');
    expect(screen.getByLabelText('选中缺陷分析工具')).toHaveTextContent('0.42×0.36×0.12mm');
    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    fireEvent.click(screen.getByRole('button', { name: '局部点云' }));
    fireEvent.click(screen.getByRole('button', { name: '收起缺陷分析区' }));

    expect(onSurfaceViewModeChange).toHaveBeenCalledWith('3d');
    expect(onAnalysisViewModeChange).toHaveBeenCalledWith('point-cloud');
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
  });
});
