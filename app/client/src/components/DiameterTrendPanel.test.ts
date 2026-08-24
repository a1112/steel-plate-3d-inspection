import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import { buildDiameterMeasurements, DiameterTrendPanel } from './DiameterTrendPanel';

function mesh(): BarSurfaceMesh {
  return {
    schema: 'test',
    coordinateUnit: 'millimeter-normalized-radius',
    cameraCount: 1,
    frameStems: [],
    rows: 2,
    colsPerCamera: 4,
    positions: new Float32Array([
      0, 1, 0,
      0, 0, 1,
      0, -1, 0,
      0, 0, -1,
      1, 1.01, 0,
      1, 0, 0.99,
      1, -1.01, 0,
      1, 0, -0.99,
    ]),
    uvs: new Float32Array(16),
    colors: new Float32Array(24),
    validMask: new Uint8Array(8).fill(1),
    indices: new Uint32Array(),
  };
}

describe('buildDiameterMeasurements', () => {
  it('reports fitted diameter, nominal deviation, and roundness in millimetres', () => {
    const samples = buildDiameterMeasurements(mesh(), 200, 12_000);

    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      positionMm: 0,
      diameterMm: 200,
      deviationMm: 0,
      roundnessMm: 0,
    });
    expect(samples[1].positionMm).toBe(12_000);
    expect(samples[1].diameterMm).toBeCloseTo(200, 4);
    expect(samples[1].roundnessMm).toBeCloseTo(2, 4);
  });

  it('renders one large fitted-diameter curve', () => {
    const { container } = render(createElement(DiameterTrendPanel, {
      mesh: mesh(),
      nominalDiameterMm: 200,
      lengthMm: 12_000,
    }));

    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img', { name: '测径（外径）曲线，按钢管长度位置变化' })).toBeInTheDocument();
    expect(container.querySelector('.diameter-curve-card > header')).toBeNull();
    expect(container.querySelector('.diameter-curve-card > footer')).toHaveTextContent('名义外径 200.000 mm');
    expect(screen.queryByText('外径偏差变化')).not.toBeInTheDocument();
    expect(screen.queryByText('圆度误差变化')).not.toBeInTheDocument();
  });

  it('switches the curve X axis from global length to the active visible range', () => {
    render(createElement(DiameterTrendPanel, {
      mesh: mesh(),
      nominalDiameterMm: 200,
      lengthMm: 12_000,
      visibleRange: [0.25, 0.75],
    }));

    const grid = screen.getByTestId('diameter-trend-grid');
    expect(grid).toHaveAttribute('data-x-axis-scope', 'visible');
    expect(grid).toHaveAttribute('data-x-axis-start-mm', '3000');
    expect(grid).toHaveAttribute('data-x-axis-end-mm', '9000');
    expect(screen.getByRole('img')).toHaveTextContent('3000');
    expect(screen.getByRole('img')).toHaveTextContent('9000 mm');
  });
});
