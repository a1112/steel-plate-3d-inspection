import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DefectItem, DefectType } from '../data/inspection';
import { PlateMap } from './PlateMap';

const defectTypes: DefectType[] = [
  { id: 'pit', label: '凹坑', color: '#2f6bff', shape: 'circle' },
  { id: 'roll', label: '辊印', color: '#ff7f1f', shape: 'square' },
];

const defects: DefectItem[] = [
  {
    id: 'D-TOP',
    plateNo: 'P-001',
    typeId: 'pit',
    typeLabel: '凹坑',
    surface: 'top',
    severity: 'severe',
    distanceHeadMm: 1000,
    operatorSideMm: 100,
    driveSideMm: 200,
    widthMm: 0.4,
    heightMm: 0.3,
    depthMm: -0.12,
    xRatio: 0.25,
    yOffsetMm: 0.5,
    previewX: 50,
    previewY: 50,
    previewImageUrl: '',
  },
  {
    id: 'D-BOTTOM',
    plateNo: 'P-001',
    typeId: 'roll',
    typeLabel: '辊印',
    surface: 'bottom',
    severity: 'minor',
    distanceHeadMm: 2000,
    operatorSideMm: 140,
    driveSideMm: 240,
    widthMm: 0.5,
    heightMm: 0.2,
    depthMm: -0.06,
    xRatio: 0.6,
    yOffsetMm: -0.4,
    previewX: 60,
    previewY: 60,
    previewImageUrl: '',
  },
];

const defectTypeCounts = {
  pit: 1,
  roll: 1,
};

describe('PlateMap', () => {
  it('shows clear selected and cancelled states for defect legend toggles', () => {
    const onToggleType = vi.fn();
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={[]}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set(['roll'])}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={onToggleType}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    const selectedToggle = screen.getByRole('button', { name: '凹坑 1 个已选中，点击取消' });
    const cancelledToggle = screen.getByRole('button', { name: '辊印 1 个已取消，点击选中' });

    expect(selectedToggle).toHaveAttribute('aria-pressed', 'true');
    expect(selectedToggle).toHaveClass('is-selected');
    expect(selectedToggle).toHaveTextContent('凹坑1');
    expect(cancelledToggle).toHaveAttribute('aria-pressed', 'false');
    expect(cancelledToggle).toHaveClass('is-cancelled');
    expect(cancelledToggle).toHaveTextContent('辊印1');

    fireEvent.click(cancelledToggle);
    expect(onToggleType).toHaveBeenCalledWith('roll');
  });

  it('switches between all, top and bottom surface display modes', () => {
    const onSurfaceModeChange = vi.fn();
    const { rerender } = render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={onSurfaceModeChange}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '显示全部' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('上表面')).toBeInTheDocument();
    expect(screen.getByText('下表面')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '显示上表' }));
    expect(onSurfaceModeChange).toHaveBeenCalledWith('top');

    rerender(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects.filter((defect) => defect.surface === 'top')}
        defectTypeCounts={{ pit: 1, roll: 0 }}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="top"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={onSurfaceModeChange}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '显示上表' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('上表面')).toBeInTheDocument();
    expect(screen.queryByText('下表面')).not.toBeInTheDocument();
  });

  it('keeps the existing map as 2D and can switch to the 3D plate view', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-TOP"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '2D' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('slider', { name: '预览位置' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '3D' }));

    expect(screen.getByRole('button', { name: '3D' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plate-map-3d-view')).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: '预览位置' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '2D' }));
    expect(screen.getByRole('slider', { name: '预览位置' })).toBeInTheDocument();
  });

  it('limits 3D view control to horizontal dragging', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-TOP"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    const view = screen.getByTestId('plate-map-3d-view');
    expect(view).toHaveAttribute('data-view-yaw', '0.000');

    const verticalPointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(verticalPointerDown, 'button', { value: 0 });
    Object.defineProperty(verticalPointerDown, 'clientX', { value: 300 });
    Object.defineProperty(verticalPointerDown, 'pointerId', { value: 8 });
    fireEvent(view, verticalPointerDown);

    const verticalPointerMove = new Event('pointermove', { bubbles: true, cancelable: true });
    Object.defineProperty(verticalPointerMove, 'clientX', { value: 300 });
    Object.defineProperty(verticalPointerMove, 'pointerId', { value: 8 });
    fireEvent(view, verticalPointerMove);
    expect(view).toHaveAttribute('data-view-yaw', '0.000');

    const verticalPointerUp = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.defineProperty(verticalPointerUp, 'pointerId', { value: 8 });
    fireEvent(view, verticalPointerUp);

    const horizontalPointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(horizontalPointerDown, 'button', { value: 0 });
    Object.defineProperty(horizontalPointerDown, 'clientX', { value: 300 });
    Object.defineProperty(horizontalPointerDown, 'pointerId', { value: 9 });
    fireEvent(view, horizontalPointerDown);

    const horizontalPointerMove = new Event('pointermove', { bubbles: true, cancelable: true });
    Object.defineProperty(horizontalPointerMove, 'clientX', { value: 360 });
    Object.defineProperty(horizontalPointerMove, 'pointerId', { value: 9 });
    fireEvent(view, horizontalPointerMove);
    expect(view).toHaveAttribute('data-view-yaw', '0.240');
  });

  it('zooms the 3D plate view with the mouse wheel', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-TOP"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    const view = screen.getByTestId('plate-map-3d-view');

    expect(view).toHaveAttribute('data-view-zoom', '1.00');
    expect(screen.getByText('缩放倍率')).toBeInTheDocument();
    expect(screen.getByText('1.00x')).toBeInTheDocument();

    fireEvent.wheel(view, { deltaY: -120 });
    expect(view).toHaveAttribute('data-view-zoom', '1.12');
    expect(screen.getByText('1.12x')).toBeInTheDocument();

    fireEvent.wheel(view, { deltaY: 120 });
    expect(view).toHaveAttribute('data-view-zoom', '1.00');
  });

  it('updates the preview position from click and drag on the length ruler', () => {
    const onPreviewPositionChange = vi.fn();
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={onPreviewPositionChange}
        onSelectDefect={vi.fn()}
      />,
    );

    const ruler = screen.getByRole('slider', { name: '预览位置' });
    Object.defineProperty(ruler, 'getBoundingClientRect', {
      value: vi.fn(
        () =>
          ({
            left: 100,
            right: 1300,
            width: 1200,
            height: 44,
            top: 0,
            bottom: 44,
            x: 100,
            y: 0,
            toJSON: () => ({}),
          }) as DOMRect,
      ),
    });

    const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(pointerDown, 'clientX', { value: 900 });
    Object.defineProperty(pointerDown, 'pointerId', { value: 1 });
    fireEvent(ruler, pointerDown);
    expect(onPreviewPositionChange).toHaveBeenLastCalledWith(8);

    const pointerMove = new Event('pointermove', { bubbles: true, cancelable: true });
    Object.defineProperty(pointerMove, 'clientX', { value: 1000 });
    Object.defineProperty(pointerMove, 'pointerId', { value: 1 });
    fireEvent(ruler, pointerMove);
    expect(onPreviewPositionChange).toHaveBeenLastCalledWith(9);

    const pointerUp = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.defineProperty(pointerUp, 'pointerId', { value: 1 });
    fireEvent(ruler, pointerUp);

    fireEvent.mouseDown(ruler, { clientX: 700 });
    expect(onPreviewPositionChange).toHaveBeenLastCalledWith(6);

    fireEvent.mouseMove(ruler, { clientX: 500 });
    expect(onPreviewPositionChange).toHaveBeenLastCalledWith(4);

    fireEvent.keyDown(ruler, { key: 'ArrowLeft' });
    expect(onPreviewPositionChange).toHaveBeenLastCalledWith(5.9);
  });

  it('renders synchronized preview cursors on top and bottom surface strips', () => {
    render(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId={null}
        surfaceMode="all"
        previewPositionM={3}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(screen.getByTestId('preview-cursor-top')).toHaveStyle({ left: '25%' });
    expect(screen.getByTestId('preview-cursor-bottom')).toHaveStyle({ left: '25%' });
    expect(screen.getByRole('slider', { name: '预览位置' })).toHaveAttribute('aria-valuenow', '3');
  });
});
