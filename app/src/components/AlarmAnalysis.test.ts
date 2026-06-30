import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { ChartPoint, DefectItem } from '../data/inspection';
import { createSectionProfiles } from '../lib/section-profiles';
import { AlarmAnalysis } from './AlarmAnalysis';

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

const points: ChartPoint[] = Array.from({ length: 5 }, (_, index) => ({
  x: index * 20,
  z: Number((-0.02 * index).toFixed(3)),
}));

describe('createSectionProfiles', () => {
  it('keeps the length section and adds an independent width section', () => {
    const profiles = createSectionProfiles(points, defect);

    expect(profiles).toHaveLength(points.length);
    expect(profiles[2].lengthSection).toBe(points[2].z);
    expect(profiles.some((point) => point.widthSection !== point.lengthSection)).toBe(true);
    expect(Math.min(...profiles.map((point) => point.widthSection))).toBeLessThan(-0.08);
  });
});

describe('AlarmAnalysis', () => {
  it('can show the lower analysis charts without the removed panel title', () => {
    render(createElement(AlarmAnalysis, { selectedDefect: defect, heightProfile: points, headerless: true }));

    expect(screen.queryByRole('heading', { name: '缺陷检测报警图' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '灰度图' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '点云图' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '缺陷高度剖面图' })).toBeInTheDocument();
    expect(screen.getByText('长度切面')).toBeInTheDocument();
    expect(screen.getByText('宽度切面')).toBeInTheDocument();
  });

  it('collapses the analysis area to a single summary line and restores it', () => {
    render(createElement(AlarmAnalysis, { selectedDefect: defect, heightProfile: points, headerless: true }));

    const collapseButton = screen.getByRole('button', { name: '收起缺陷分析区' });
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(collapseButton);
    expect(screen.queryByRole('heading', { name: '灰度图' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '点云图' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '缺陷高度剖面图' })).not.toBeInTheDocument();
    expect(screen.getByTestId('analysis-collapsed-summary')).toHaveTextContent('距头 8342mm');
    expect(screen.getByRole('button', { name: '展开缺陷分析区' })).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('button', { name: '展开缺陷分析区' }));
    expect(screen.getByRole('heading', { name: '灰度图' })).toBeInTheDocument();
    expect(screen.queryByTestId('analysis-collapsed-summary')).not.toBeInTheDocument();
  });

  it('adds horizontal drag and wheel zoom controls to the point cloud', () => {
    render(createElement(AlarmAnalysis, { selectedDefect: defect, heightProfile: points, headerless: true }));

    const viewer = screen.getByTestId('point-cloud-viewer');
    expect(viewer).toHaveAttribute('data-point-cloud-yaw', '-0.320');
    expect(viewer).toHaveAttribute('data-point-cloud-zoom', '1.00');
    expect(viewer).toHaveAttribute('data-point-cloud-points', '1643');
    expect(Number(viewer.getAttribute('data-point-cloud-memory-bytes'))).toBeLessThan(40000);
    expect(screen.getByText('缩放 1.00x')).toBeInTheDocument();

    const verticalPointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(verticalPointerDown, 'button', { value: 0 });
    Object.defineProperty(verticalPointerDown, 'clientX', { value: 400 });
    Object.defineProperty(verticalPointerDown, 'pointerId', { value: 2 });
    fireEvent(viewer, verticalPointerDown);

    const verticalPointerMove = new Event('pointermove', { bubbles: true, cancelable: true });
    Object.defineProperty(verticalPointerMove, 'clientX', { value: 400 });
    Object.defineProperty(verticalPointerMove, 'pointerId', { value: 2 });
    fireEvent(viewer, verticalPointerMove);
    expect(viewer).toHaveAttribute('data-point-cloud-yaw', '-0.320');

    const verticalPointerUp = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.defineProperty(verticalPointerUp, 'pointerId', { value: 2 });
    fireEvent(viewer, verticalPointerUp);

    const horizontalPointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(horizontalPointerDown, 'button', { value: 0 });
    Object.defineProperty(horizontalPointerDown, 'clientX', { value: 400 });
    Object.defineProperty(horizontalPointerDown, 'pointerId', { value: 3 });
    fireEvent(viewer, horizontalPointerDown);

    const horizontalPointerMove = new Event('pointermove', { bubbles: true, cancelable: true });
    Object.defineProperty(horizontalPointerMove, 'clientX', { value: 460 });
    Object.defineProperty(horizontalPointerMove, 'pointerId', { value: 3 });
    fireEvent(viewer, horizontalPointerMove);
    expect(viewer).toHaveAttribute('data-point-cloud-yaw', '0.040');

    fireEvent.wheel(viewer, { deltaY: -120 });
    expect(viewer).toHaveAttribute('data-point-cloud-zoom', '1.12');
    expect(screen.getByText('缩放 1.12x')).toBeInTheDocument();

    fireEvent.wheel(viewer, { deltaY: 120 });
    expect(viewer).toHaveAttribute('data-point-cloud-zoom', '1.00');
  });

  it('adjusts the height chart coordinate range with the mouse wheel', () => {
    render(createElement(AlarmAnalysis, { selectedDefect: defect, heightProfile: points, headerless: true }));

    const chart = screen.getByTestId('height-profile-chart');
    expect(chart).toHaveAttribute('data-axis-zoom', '1.00');
    expect(chart).toHaveAttribute('data-x-domain', '0.00,80.00');
    expect(chart).toHaveAttribute('data-y-domain', '-1.00,1.00');
    expect(screen.getByText('坐标 1.00x')).toBeInTheDocument();

    fireEvent.wheel(chart, { deltaY: -120 });
    expect(chart).toHaveAttribute('data-axis-zoom', '1.20');
    expect(chart).toHaveAttribute('data-x-domain', '6.67,73.33');
    expect(chart).toHaveAttribute('data-y-domain', '-0.83,0.83');
    expect(screen.getByText('坐标 1.20x')).toBeInTheDocument();

    fireEvent.wheel(chart, { deltaY: 120 });
    expect(chart).toHaveAttribute('data-axis-zoom', '1.00');
    expect(chart).toHaveAttribute('data-x-domain', '0.00,80.00');
    expect(chart).toHaveAttribute('data-y-domain', '-1.00,1.00');
  });
});
