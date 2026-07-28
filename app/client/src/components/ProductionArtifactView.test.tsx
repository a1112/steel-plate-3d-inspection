import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import {
  buildRadialJetColors,
  ProductionArtifactView,
} from './ProductionArtifactView';

vi.mock('@react-three/fiber', () => ({
  Canvas: () => <div data-testid="mock-three-canvas" />,
  useThree: () => ({
    camera: {
      position: { set: vi.fn() },
      lookAt: vi.fn(),
      updateProjectionMatrix: vi.fn(),
      zoom: 1,
    },
    size: { height: 400, width: 800 },
  }),
}));

function fixture(): BarSurfaceMesh {
  return {
    schema: 'test',
    coordinateUnit: 'display',
    cameraCount: 1,
    frameStems: [],
    rows: 2,
    colsPerCamera: 2,
    positions: new Float32Array([
      0, 1, 0,
      0, 0, 1,
      1, -1, 0,
      1, 0, -1,
    ]),
    uvs: new Float32Array(8),
    colors: new Float32Array([
      1, 0, 0,
      0, 1, 0,
      0, 0, 1,
      1, 1, 1,
    ]),
    validMask: new Uint8Array([1, 0, 1, 0]),
    indices: new Uint32Array([0, 2, 1]),
  };
}

function radialFixture(): BarSurfaceMesh {
  return {
    schema: 'test',
    coordinateUnit: 'display',
    cameraCount: 1,
    frameStems: [],
    rows: 1,
    colsPerCamera: 4,
    positions: new Float32Array([
      0, 1.1, 0,
      0, 0, 0.9,
      0, -1.1, 0,
      0, 0, -0.9,
    ]),
    uvs: new Float32Array(8),
    colors: new Float32Array(12),
    validMask: new Uint8Array([1, 1, 1, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

describe('ProductionArtifactView', () => {
  it('maps signed residuals from the fitted section circle to Jet colors', () => {
    const result = buildRadialJetColors(radialFixture());

    expect(result.summary.fittedSectionCount).toBe(1);
    expect(result.summary.fittedPointCount).toBe(4);
    expect(result.summary.meanRadius).toBeCloseTo(1, 5);
    expect(result.summary.residualLimit).toBeCloseTo(0.1, 5);
    expect(result.colors[0]).toBeGreaterThan(result.colors[2]);
    expect(result.colors[5]).toBeGreaterThan(result.colors[3]);
  });

  it('filters nominal fill vertices from point-cloud mode', () => {
    render(
      <ProductionArtifactView
        mesh={fixture()}
        mode="points"
        testId="point-cloud"
        ariaLabel="有效点云"
      />,
    );

    expect(screen.getByTestId('point-cloud')).toHaveAttribute('data-artifact-points', '2');
    expect(screen.getByTestId('point-cloud')).toHaveAttribute('data-artifact-triangles', '0');
    expect(screen.getByText('生产记录产物 · 2 点 · 横向 · 1.00x')).toBeInTheDocument();
  });

  it('keeps the complete topology in surface mode', () => {
    render(
      <ProductionArtifactView
        mesh={fixture()}
        mode="surface"
        testId="surface"
        ariaLabel="三维表面"
      />,
    );

    expect(screen.getByTestId('surface')).toHaveAttribute('data-artifact-points', '4');
    expect(screen.getByTestId('surface')).toHaveAttribute('data-artifact-triangles', '1');
  });

  it('exposes the fitted-circle Jet legend in surface mode', () => {
    render(
      <ProductionArtifactView
        mesh={radialFixture()}
        mode="surface"
        testId="jet-surface"
        ariaLabel="Jet 三维表面"
        colorMode="radial-jet"
      />,
    );

    expect(screen.getByTestId('jet-surface')).toHaveAttribute(
      'data-artifact-color-mode',
      'radial-jet',
    );
    expect(screen.getByLabelText('Jet 拟合圆径向偏差图例')).toHaveTextContent(
      '1 个切面拟合 · 径向偏差单位 显示坐标',
    );
  });

  it('supports large multiplicative zoom and reports the active precision bucket', () => {
    const onZoomChange = vi.fn();
    render(
      <ProductionArtifactView
        mesh={fixture()}
        mode="surface"
        testId="zoom-surface"
        ariaLabel="可缩放三维表面"
        onZoomChange={onZoomChange}
      />,
    );

    const view = screen.getByTestId('zoom-surface');
    for (let index = 0; index < 16; index += 1) {
      fireEvent.wheel(view, { deltaY: -100 });
    }
    expect(view).toHaveAttribute('data-artifact-zoom', '10.00');
    expect(onZoomChange).toHaveBeenLastCalledWith(10);
  });

  it('exposes a millimetre ruler and scrolls the visible pipe-length range after zoom', () => {
    const onVisibleRangeChange = vi.fn();
    render(
      <ProductionArtifactView
        mesh={fixture()}
        mode="surface"
        testId="length-navigation-surface"
        ariaLabel="带长度导航的三维表面"
        lengthMm={12_000}
        onVisibleRangeChange={onVisibleRangeChange}
      />,
    );

    const view = screen.getByTestId('length-navigation-surface');
    const scrollbar = screen.getByRole('scrollbar', { name: '三维长度方向滚动条' });
    const ruler = screen.getByLabelText('三维长度毫米刻度');
    expect(ruler).toHaveTextContent('0 mm');
    expect(ruler).toHaveTextContent('3000 mm');
    expect(ruler).toHaveTextContent('6000 mm');
    expect(ruler).toHaveTextContent('9000 mm');
    expect(ruler).toHaveTextContent('12000 mm');
    expect(scrollbar).toHaveAttribute('aria-disabled', 'true');
    expect(onVisibleRangeChange).toHaveBeenLastCalledWith(null);

    fireEvent.wheel(view, { deltaY: -100 });
    expect(scrollbar).toHaveAttribute('aria-disabled', 'false');
    expect(view).toHaveAttribute('data-visible-range-start', '0.0833');
    expect(view).toHaveAttribute('data-visible-range-end', '0.9167');

    vi.spyOn(scrollbar, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 12, width: 100, height: 12,
      toJSON: () => ({}),
    });
    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(pointerDown, {
      clientX: { value: 55 },
      pointerId: { value: 9 },
    });
    fireEvent(scrollbar, pointerDown);
    expect(Number(view.getAttribute('data-visible-range-start'))).toBeCloseTo(0.1333, 3);
    expect(Number(view.getAttribute('data-visible-range-end'))).toBeCloseTo(0.9667, 3);

    Object.defineProperty(view, 'clientWidth', { value: 800, configurable: true });
    const viewPointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(viewPointerDown, {
      button: { value: 0 },
      clientX: { value: 500 },
      clientY: { value: 120 },
      pointerId: { value: 10 },
    });
    fireEvent(view, viewPointerDown);
    const viewPointerMove = new Event('pointermove', { bubbles: true });
    Object.defineProperties(viewPointerMove, {
      clientX: { value: 300 },
      clientY: { value: 120 },
      pointerId: { value: 10 },
    });
    fireEvent(view, viewPointerMove);
    expect(Number(view.getAttribute('data-visible-range-start'))).toBeGreaterThan(0.1333);
  });

  it('keeps the camera-facing orientation fixed while allowing unbounded axial roll', () => {
    render(
      <ProductionArtifactView
        mesh={fixture()}
        mode="surface"
        testId="roll-surface"
        ariaLabel="轴向旋转三维表面"
      />,
    );

    const view = screen.getByTestId('roll-surface');
    expect(view).toHaveAttribute('data-artifact-orientation', 'horizontal');
    const pointerDown = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(pointerDown, {
      button: { value: 0 },
      clientX: { value: 20 },
      clientY: { value: 20 },
      pointerId: { value: 7 },
    });
    fireEvent(view, pointerDown);
    const pointerMove = new Event('pointermove', { bubbles: true });
    Object.defineProperties(pointerMove, {
      clientX: { value: 700 },
      clientY: { value: 200 },
      pointerId: { value: 7 },
    });
    fireEvent(view, pointerMove);
    const pointerUp = new Event('pointerup', { bubbles: true });
    Object.defineProperty(pointerUp, 'pointerId', { value: 7 });
    fireEvent(view, pointerUp);

    expect(Number(view.getAttribute('data-artifact-roll'))).toBeGreaterThan(Math.PI * 2);
    expect(view).not.toHaveAttribute('data-artifact-yaw');
  });

  it('exposes the vertical pipe-axis preset without changing render mode', () => {
    render(
      <ProductionArtifactView
        mesh={fixture()}
        mode="points"
        testId="vertical-points"
        ariaLabel="纵向有效点云"
        orientation="vertical"
      />,
    );

    expect(screen.getByTestId('vertical-points')).toHaveAttribute('data-artifact-orientation', 'vertical');
    expect(screen.getByTestId('vertical-points')).toHaveAttribute('data-artifact-points', '2');
  });
});
