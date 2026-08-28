import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import {
  buildCaptureSectionDiameterExtremes,
  buildCaptureContourSegments,
  buildCaptureSection,
  captureSectionDiameterAtAngle,
  CaptureSectionView,
} from './CaptureSectionView';

function captureMesh(): BarSurfaceMesh {
  const rows = 3;
  const columns = 8;
  const positions: number[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const angle = column / columns * Math.PI * 2;
      const radius = row === 1 && column === 0 ? 51 : 50;
      positions.push(row * 10, Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
  }
  return {
    schema: 'steel.ranger3-flow-surface.v1',
    coordinateUnit: 'mm',
    materialId: '4034',
    displayMode: 'diagnostic-unqualified',
    metricValid: false,
    longitudinalAxis: {
      origin: 'detected-steel-head',
      displayUnit: 'head-relative-display',
      absoluteScaleVerified: false,
    },
    crossSections: [{
      row: 1,
      meshRow: 1,
      elapsedFromHeadMs: 250,
      positionRatio: 0.5,
      available: true,
      metricValid: false,
      displayMode: 'diagnostic-unqualified',
      qualityReasons: ['angular-coverage-below-threshold'],
      validPointCount: columns,
      angularPointCount: columns,
      circleFit: {
        available: true,
        centerX: 0,
        centerZ: 0,
        radiusMm: 50,
        diameterMm: 100,
        p95AbsResidualMm: 1,
        roundnessMm: 1,
      },
    }],
    cameraCount: 1,
    frameStems: [],
    rows,
    colsPerCamera: columns,
    positions: new Float32Array(positions),
    uvs: new Float32Array(rows * columns * 2),
    colors: new Float32Array(rows * columns * 3),
    validMask: new Uint8Array(rows * columns).fill(1),
    indices: new Uint32Array(),
    source: 'json',
  };
}

describe('CaptureSectionView', () => {
  it('closes a complete contour but does not bridge missing angular bins', () => {
    const point = (column: number) => ({ column, y: column, z: 0, residualMm: 0 });
    const complete = buildCaptureContourSegments(
      [point(0), point(1), point(2), point(3)],
      4,
    );
    expect(complete).toHaveLength(1);
    expect(complete[0].map((item) => item.column)).toEqual([0, 1, 2, 3, 0]);

    const incomplete = buildCaptureContourSegments(
      [point(0), point(1), point(3), point(4)],
      6,
    );
    expect(incomplete.map((segment) => segment.map((item) => item.column))).toEqual([
      [0, 1],
      [3, 4],
    ]);
  });

  it('uses millimetre capture coordinates directly without nominal-radius scaling', () => {
    const section = buildCaptureSection(captureMesh(), 1);
    expect(section.diameterMm).toBe(100);
    expect(section.radiusMm).toBe(50);
    expect(section.p95ResidualMm).toBe(1);
  });

  it('measures opposite radii through the fitted centre and finds the widest and narrowest diameters', () => {
    const section = buildCaptureSection(captureMesh(), 1);
    const horizontal = captureSectionDiameterAtAngle(section, 0);
    const extremes = buildCaptureSectionDiameterExtremes(section);

    expect(horizontal?.diameterMm).toBe(101);
    expect(horizontal?.y1).toBeCloseTo(0, 5);
    expect(horizontal?.y2).toBeCloseTo(0, 5);
    expect(extremes.maximum?.diameterMm).toBe(101);
    expect(extremes.minimum?.diameterMm).toBeCloseTo(100, 5);
  });

  it('shows head-relative progress for an unverified longitudinal scale and navigates rows', () => {
    const onRowChange = vi.fn();
    render(<CaptureSectionView mesh={captureMesh()} row={1} onRowChange={onRowChange} recordId="4034" />);

    expect(screen.getByTestId('capture-section-view')).toHaveAttribute('data-metric-valid', 'false');
    expect(screen.getByText('头部进度 50.0% · 250 ms')).toBeInTheDocument();
    expect(screen.getByText('拟合外径 100.000 mm')).toBeInTheDocument();
    expect(screen.getByText('趋势预览')).toBeInTheDocument();
    expect(screen.queryByText(/头部后 .* mm/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '下一个切面' }));
    expect(onRowChange).toHaveBeenCalledWith(2);

    fireEvent.change(screen.getByRole('slider', { name: '切面位置' }), { target: { value: '0' } });
    expect(onRowChange).toHaveBeenCalledWith(0);
    fireEvent.input(screen.getByRole('slider', { name: '切面位置' }), { target: { value: '2' } });
    expect(onRowChange).toHaveBeenCalledWith(2);
  });

  it('renders angle and extreme-diameter annotations and previews the diameter under the pointer', () => {
    render(<CaptureSectionView mesh={captureMesh()} row={1} onRowChange={vi.fn()} recordId="4034" />);

    expect(screen.getByLabelText('截面角度刻度')).toHaveTextContent('0°');
    expect(screen.getByTestId('maximum-diameter-annotation')).toHaveTextContent('最宽 101.000 mm');
    expect(screen.getByTestId('minimum-diameter-annotation')).toHaveTextContent('最窄 100.000 mm');

    const chart = screen.getByRole('img', { name: '4034 360 度融合横截面' });
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      toJSON: () => ({}),
    });
    const pointerMove = createEvent.pointerMove(chart);
    Object.defineProperties(pointerMove, {
      clientX: { value: 175 },
      clientY: { value: 100 },
    });
    fireEvent(chart, pointerMove);
    expect(screen.getByTestId('hover-diameter-annotation')).toHaveTextContent('当前 101.000 mm · 0°');
    fireEvent.pointerLeave(chart);
    expect(screen.queryByTestId('hover-diameter-annotation')).not.toBeInTheDocument();
  });

  it('fails closed when a row passes locally but the aggregate surface gate fails', () => {
    const mesh = captureMesh();
    if (mesh.crossSections?.[0]) mesh.crossSections[0].metricValid = true;
    const section = buildCaptureSection(mesh, 1);
    expect(section.metricValid).toBe(false);
  });
});
