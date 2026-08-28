import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TextureLoader } from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import {
  buildDepthExaggeratedPositions,
  buildRadialJetColors,
  normalizeArtifactPositions,
  ProductionArtifactView,
  resolveArtifactDisplaySpans,
  unwrapTriangleTextureSeams,
} from './ProductionArtifactView';

const textureLifecycle = vi.hoisted(() => {
  const texture = {
    anisotropy: 0,
    colorSpace: '',
    dispose: vi.fn(),
    generateMipmaps: false,
    magFilter: 0,
    minFilter: 0,
    needsUpdate: false,
    wrapT: 0,
  };
  return {
    clear: vi.fn(),
    renderTextureMaterial: false,
    texture,
    useLoader: vi.fn(() => texture),
  };
});

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: unknown }) => {
    let textureMaterial: ReactNode = null;
    if (textureLifecycle.renderTextureMaterial) {
      const findTextureMaterial = (node: unknown): ReactNode => {
        if (Array.isArray(node)) {
          for (const child of node) {
            const found = findTextureMaterial(child);
            if (found) return found;
          }
          return null;
        }
        if (!node || typeof node !== 'object') return null;
        const element = node as {
          props?: { children?: unknown; textureUrl?: unknown };
          type?: unknown;
        };
        if (
          typeof element.type === 'function'
          && typeof element.props?.textureUrl === 'string'
        ) return node as ReactNode;
        return findTextureMaterial(element.props?.children);
      };
      textureMaterial = findTextureMaterial(children);
    }
    return <div data-testid="mock-three-canvas">{textureMaterial}</div>;
  },
  useLoader: Object.assign(textureLifecycle.useLoader, { clear: textureLifecycle.clear }),
  useThree: () => ({
    camera: {
      position: { set: vi.fn() },
      lookAt: vi.fn(),
      updateProjectionMatrix: vi.fn(),
      zoom: 1,
    },
    gl: {
      capabilities: { getMaxAnisotropy: () => 8 },
    },
    size: { height: 400, width: 800 },
  }),
}));

beforeEach(() => {
  textureLifecycle.renderTextureMaterial = false;
  textureLifecycle.clear.mockClear();
  textureLifecycle.texture.dispose.mockClear();
  textureLifecycle.useLoader.mockClear();
});

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
  it('fits bounds from valid vertices so null-fill zeros cannot crop an offset surface', () => {
    const normalized = normalizeArtifactPositions(
      new Float32Array([
        0, 0, 0,
        100, 40, 0,
        200, 60, 0,
      ]),
      new Uint8Array([0, 1, 1]),
    );

    expect(normalized[3]).toBeCloseTo(-2.1, 5);
    expect(normalized[6]).toBeCloseTo(2.1, 5);
    expect(normalized[4]).toBeCloseTo(-0.675, 5);
    expect(normalized[7]).toBeCloseTo(0.675, 5);
  });

  it('uses square texture pixels to preserve the full cylinder length-to-diameter ratio', () => {
    const spans = resolveArtifactDisplaySpans({
      longitudinalPixels: 134 * 1024,
      circumferencePixels: 6 * 450,
      pixelAspectRatio: 1,
    });
    expect(spans.lengthDiameterRatio).toBeCloseTo(
      Math.PI * 134 * 1024 / (6 * 450),
      6,
    );
    expect(spans.longitudinal / spans.crossSection).toBeCloseTo(spans.lengthDiameterRatio, 6);

    const normalized = normalizeArtifactPositions(
      new Float32Array([
        0, -1, 0,
        1, 1, 0,
      ]),
      undefined,
      spans,
    );
    expect(normalized[3] - normalized[0]).toBeCloseTo(spans.longitudinal, 4);
    expect(normalized[4] - normalized[1]).toBeCloseTo(spans.crossSection, 4);
  });

  it('identifies an owned-column gray texture as a 1:1 long-strip surface', () => {
    render(
      <ProductionArtifactView
        mesh={fixture()}
        mode="surface"
        testId="deduplicated-gray-texture"
        ariaLabel="去重灰度贴图表面"
        colorMode="texture"
        textureUrl="blob:gray-texture"
        textureModality="gray"
        textureMetrics={{
          longitudinalPixels: 134 * 1024,
          circumferencePixels: 6 * 450,
          pixelAspectRatio: 1,
          overlapPolicy: 'owned-columns-concatenated',
        }}
      />,
    );

    const view = screen.getByTestId('deduplicated-gray-texture');
    expect(view).toHaveAttribute('data-artifact-color-mode', 'texture');
    expect(view).toHaveAttribute('data-artifact-texture-modality', 'gray');
    expect(view).toHaveAttribute('data-artifact-overlap-policy', 'owned-columns-concatenated');
    expect(view).toHaveAttribute('data-artifact-pixel-aspect', '1.000');
    expect(Number(view.getAttribute('data-artifact-length-diameter-ratio'))).toBeCloseTo(159.64, 1);
    expect(screen.getByText('去重灰度贴图 · 像素 1:1')).toBeInTheDocument();
  });

  it('disposes a texture and clears its loader cache when the material unmounts', () => {
    textureLifecycle.renderTextureMaterial = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { unmount } = render(
        <ProductionArtifactView
          mesh={fixture()}
          mode="surface"
          testId="texture-cleanup"
          ariaLabel="纹理释放测试"
          colorMode="texture"
          textureUrl="blob:texture-cleanup"
        />,
      );

      expect(textureLifecycle.useLoader).toHaveBeenCalledWith(
        TextureLoader,
        'blob:texture-cleanup',
      );
      unmount();
      expect(textureLifecycle.texture.dispose).toHaveBeenCalledTimes(1);
      expect(textureLifecycle.clear).toHaveBeenCalledWith(
        TextureLoader,
        'blob:texture-cleanup',
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps texture interpolation local across the 0/360-degree UV seam', () => {
    const unwrapped = unwrapTriangleTextureSeams(new Float32Array([
      0, 0.98,
      0.5, 0.02,
      1, 0.04,
      0, 0.7,
      0.5, 0.5,
      1, 0.4,
    ]));
    expect(unwrapped[1]).toBeCloseTo(0.98);
    expect(unwrapped[3]).toBeCloseTo(1.02);
    expect(unwrapped[5]).toBeCloseTo(1.04);
    expect(unwrapped[7]).toBeCloseTo(0.7);
    expect(unwrapped[9]).toBeCloseTo(0.5);
    expect(unwrapped[11]).toBeCloseTo(0.4);
  });

  it('preserves non-zero seam width when circumference UVs use bin centers', () => {
    const unwrapped = unwrapTriangleTextureSeams(new Float32Array([
      0, 0.875,
      0.5, 0.125,
      1, 0.375,
    ]));
    const circumferenceCoordinates = [unwrapped[1], unwrapped[3], unwrapped[5]];

    expect(circumferenceCoordinates[0]).toBeCloseTo(0.875);
    expect(circumferenceCoordinates[1]).toBeCloseTo(1.125);
    expect(circumferenceCoordinates[2]).toBeCloseTo(1.375);
    expect(new Set(circumferenceCoordinates.map((value) => value.toFixed(6))).size).toBe(3);
    expect(Math.max(...circumferenceCoordinates) - Math.min(...circumferenceCoordinates))
      .toBeCloseTo(0.5);
    expect(circumferenceCoordinates.every((value) => value % 1 !== 0)).toBe(true);
  });

  it('moves observed points along the fitted section normal while preserving nominal fill points', () => {
    const observedMesh = radialFixture();
    const enhanced = buildDepthExaggeratedPositions(observedMesh, 3);

    expect(Math.hypot(enhanced[1], enhanced[2])).not.toBeCloseTo(
      Math.hypot(observedMesh.positions[1], observedMesh.positions[2]),
      4,
    );

    const meshWithFill = radialFixture();
    meshWithFill.validMask = new Uint8Array([1, 1, 1, 0]);
    const enhancedWithFill = buildDepthExaggeratedPositions(meshWithFill, 3);
    expect(enhancedWithFill[10]).toBe(meshWithFill.positions[10]);
    expect(enhancedWithFill[11]).toBe(meshWithFill.positions[11]);
  });

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
    expect(screen.getByText('生产记录产物 · 2 有效点 · 横向 · 1.00x')).toBeInTheDocument();
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

  it('renders an unverified capture surface with neutral material and percentage scale', () => {
    const mesh = {
      ...fixture(),
      displayMode: 'diagnostic-unqualified',
      metricValid: false,
      longitudinalAxis: { absoluteScaleVerified: false },
    };
    render(
      <ProductionArtifactView
        mesh={mesh}
        mode="surface"
        testId="capture-preview"
        ariaLabel="采集三维预览"
        colorMode="neutral"
      />,
    );

    expect(screen.getByTestId('capture-preview')).toHaveAttribute('data-artifact-color-mode', 'neutral');
    expect(screen.getByText(/趋势预览 · 2 切面 · 头部相对进度/)).toBeInTheDocument();
    expect(screen.getByLabelText('三维头部相对进度刻度')).toHaveTextContent('100%');
    expect(screen.getByRole('scrollbar', { name: '三维长度方向滚动条' })).toHaveAttribute('aria-valuemax', '100');
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
    expect(screen.getByTestId('jet-surface')).toHaveAttribute('data-artifact-depth-exaggeration', '1.0');
    fireEvent.change(screen.getByRole('slider', { name: '三维深度增强倍数' }), { target: { value: '6' } });
    expect(screen.getByTestId('jet-surface')).toHaveAttribute('data-artifact-depth-exaggeration', '6.0');
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
    expect(Number(view.getAttribute('data-artifact-render-dpr'))).toBeGreaterThan(1);
    expect(onZoomChange).toHaveBeenLastCalledWith(10);
  });

  it('keeps both axes under the pointer while zooming the horizontal pipe', () => {
    render(
      <ProductionArtifactView
        mesh={fixture()}
        mode="points"
        testId="pointer-anchored-zoom"
        ariaLabel="跟随鼠标缩放的点云"
        lengthMm={12_000}
      />,
    );

    const view = screen.getByTestId('pointer-anchored-zoom');
    vi.spyOn(view, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 500, width: 1000, height: 500,
      toJSON: () => ({}),
    });
    fireEvent.wheel(view, { deltaY: -100, clientX: 750, clientY: 100 });

    const start = Number(view.getAttribute('data-visible-range-start'));
    const end = Number(view.getAttribute('data-visible-range-end'));
    expect(start + 0.75 * (end - start)).toBeCloseTo(0.75, 3);
    expect(Number(view.getAttribute('data-artifact-axis-center'))).toBeCloseTo(0.5417, 3);
    expect(Number(view.getAttribute('data-artifact-pan-y'))).toBeCloseTo(-0.1239, 3);

    fireEvent.wheel(view, { deltaY: -100, clientX: 750, clientY: 480 });
    expect(Number(view.getAttribute('data-artifact-pan-y'))).toBeCloseTo(0.0344, 3);
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
    expect(ruler).toHaveTextContent('2000 mm');
    expect(ruler).toHaveTextContent('4500 mm');
  });

  it('keeps the camera-facing orientation fixed while allowing vertical drag to roll the pipe', () => {
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
      clientX: { value: 20 },
      clientY: { value: 700 },
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
