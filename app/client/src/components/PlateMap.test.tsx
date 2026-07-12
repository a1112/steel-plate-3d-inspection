import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { DefectItem, DefectType } from '../data/inspection';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import { PlateMap as ProductionPlateMap } from './PlateMap';

// These legacy interaction cases intentionally exercise the bundled demo/test
// visualization. Production behavior is covered separately below.
function PlateMap(props: ComponentProps<typeof ProductionPlateMap>) {
  return <ProductionPlateMap artifactMode="demo" {...props} />;
}

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
    previewImageUrl: '/mock-defect-pit.png',
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

const productionMesh: BarSurfaceMesh = {
  schema: 'steel.bar-surface.mesh.v1',
  coordinateUnit: 'mm',
  cameraCount: 1,
  frameStems: ['frame-001'],
  rows: 2,
  colsPerCamera: 2,
  positions: new Float32Array([
    0, 0, 0,
    1, 0, 0.1,
    0, 1, 0.2,
    1, 1, 0.3,
  ]),
  uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
  colors: new Float32Array([
    0.1, 0.5, 0.9,
    0.2, 0.6, 0.8,
    0.3, 0.7, 0.7,
    0.4, 0.8, 0.6,
  ]),
  indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
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
        artifactMode="demo"
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

  it('renders a single six-camera unfolded map instead of top and bottom surfaces', () => {
    const onSurfaceModeChange = vi.fn();
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
        onSurfaceModeChange={onSurfaceModeChange}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: '棒材圆周展开缺陷图' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '六相机圆周展开缺陷图' })).toBeInTheDocument();
    expect(screen.getByTestId('bar-unfolded-map')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '相机区显示切换' })).not.toBeInTheDocument();
    expect(screen.queryByText('上表面')).not.toBeInTheDocument();
    expect(screen.queryByText('下表面')).not.toBeInTheDocument();
    expect(screen.getByText('camera1')).toBeInTheDocument();
    expect(screen.getByText('camera6')).toBeInTheDocument();
    expect(onSurfaceModeChange).not.toHaveBeenCalled();
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

    fireEvent.click(screen.getByRole('button', { name: '点云' }));

    expect(screen.getByRole('button', { name: '点云' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plate-point-cloud-view')).toBeInTheDocument();
    expect(screen.queryByTestId('plate-map-3d-view')).not.toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: '预览位置' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '2D' }));
    expect(screen.getByRole('slider', { name: '预览位置' })).toBeInTheDocument();
  });

  it('renders point-cloud mode as camera-zone height unfolded maps', () => {
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

    fireEvent.click(screen.getByRole('button', { name: '点云' }));
    const view = screen.getByTestId('plate-point-cloud-view');

    expect(Number(view.getAttribute('data-point-cloud-points'))).toBeGreaterThan(5000);
    expect(screen.getByText('1-3号相机 3D 高度展开图')).toBeInTheDocument();
    expect(screen.getByText('4-6号相机 3D 高度展开图')).toBeInTheDocument();
    expect(screen.getByLabelText('1-3号相机高度色标')).toBeInTheDocument();
    expect(screen.getByLabelText('4-6号相机高度色标')).toBeInTheDocument();
    expect(screen.getByLabelText('凹坑点云标注，1-3号相机，距头1000mm')).toBeInTheDocument();
    expect(screen.getByLabelText('辊印点云标注，4-6号相机，距头2000mm')).toBeInTheDocument();
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

  it('shows a defect detail card on marker hover and keyboard focus', () => {
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

    const marker = screen.getByRole('button', { name: '凹坑，camera3，距头1000mm' });
    fireEvent.mouseEnter(marker);

    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '凹坑缺陷小图' })).toHaveAttribute('src', '/mock-defect-pit.png');
    expect(screen.getByText('D-TOP')).toBeInTheDocument();
    expect(screen.getByText('严重')).toBeInTheDocument();
    expect(screen.getByText('0.40 x 0.30 x 0.12mm')).toBeInTheDocument();

    fireEvent.mouseLeave(marker);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.focus(marker);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('switches selected defects with keyboard arrows and mouse wheel on the 2D strip', () => {
    const onSelectDefect = vi.fn();
    const { rerender } = render(
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
        onSelectDefect={onSelectDefect}
      />,
    );

    const unfoldedMap = screen.getByRole('region', { name: '六相机圆周展开缺陷图' });
    fireEvent.keyDown(unfoldedMap, { key: 'ArrowRight' });
    expect(onSelectDefect).toHaveBeenLastCalledWith('D-BOTTOM');

    rerender(
      <PlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-BOTTOM"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={onSelectDefect}
      />,
    );

    const rerenderedMap = screen.getByRole('region', { name: '六相机圆周展开缺陷图' });
    fireEvent.wheel(rerenderedMap, { deltaY: -120 });
    expect(onSelectDefect).toHaveBeenLastCalledWith('D-TOP');

    fireEvent.keyDown(rerenderedMap, { key: 'End' });
    expect(onSelectDefect).toHaveBeenLastCalledWith('D-BOTTOM');
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

  it('renders the preview cursor on the unfolded six-camera map', () => {
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

    expect(screen.getByTestId('preview-cursor-unfolded')).toHaveStyle({ left: '25%' });
    expect(screen.getByRole('slider', { name: '预览位置' })).toHaveAttribute('aria-valuenow', '3');
  });

  it('fails closed in production when the selected record has no 3D or point-cloud artifact', () => {
    render(
      <ProductionPlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-TOP"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        inspectionId="INS-PROD-1"
        artifactStatus="记录尚未生成算法产物"
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    expect(screen.getByRole('note')).toHaveTextContent('生产记录 INS-PROD-1');
    expect(screen.queryByText(/演示\/测试数据/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(screen.getByTestId('plate-production-surface-empty')).toHaveTextContent('暂无生产三维表面产物');
    expect(screen.queryByTestId('plate-map-3d-view')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '点云' }));
    expect(screen.getByTestId('plate-production-point-cloud-empty')).toHaveTextContent('暂无生产点云产物');
    expect(screen.queryByTestId('plate-point-cloud-view')).not.toBeInTheDocument();
  });

  it('renders only the record-bound production mesh in 3D and point-cloud modes', () => {
    render(
      <ProductionPlateMap
        defectTypes={defectTypes}
        defects={defects}
        defectTypeCounts={defectTypeCounts}
        hiddenTypeIds={new Set()}
        selectedDefectId="D-TOP"
        surfaceMode="all"
        previewPositionM={6}
        plateLengthM={12}
        inspectionId="INS-PROD-2"
        surfaceMesh={productionMesh}
        onToggleType={vi.fn()}
        onSurfaceModeChange={vi.fn()}
        onPreviewPositionChange={vi.fn()}
        onSelectDefect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(screen.getByTestId('plate-production-surface')).toHaveAttribute('data-artifact-source', 'production-record');
    expect(screen.getByTestId('plate-production-surface')).toHaveAttribute('data-artifact-points', '4');
    expect(screen.getByTestId('plate-production-surface')).toHaveAttribute('data-artifact-triangles', '2');

    fireEvent.click(screen.getByRole('button', { name: '点云' }));
    expect(screen.getByTestId('plate-production-point-cloud')).toHaveAttribute('data-artifact-source', 'production-record');
    expect(screen.queryByTestId('plate-point-cloud-view')).not.toBeInTheDocument();
  });
});
