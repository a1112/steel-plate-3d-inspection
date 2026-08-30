import { fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import type { CaptureFlowMeasurement } from '../lib/capture-api';
import { buildArtifactDiameterMeasurements, buildDiameterFitWarning, buildDiameterMeasurements, buildDiameterMetricSummary, buildDirectionalDiameterLines, DiameterTrendPanel } from './DiameterTrendPanel';

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

  it('does not multiply a production millimetre mesh by the nominal radius again', () => {
    const millimetreMesh = { ...mesh(), coordinateUnit: 'mm' };
    const samples = buildDiameterMeasurements(millimetreMesh, 200, 12_000);
    expect(samples[0].diameterMm).toBeCloseTo(2, 5);
  });

  it('renders one large fitted-diameter curve', () => {
    const { container } = render(createElement(DiameterTrendPanel, {
      mesh: mesh(),
      nominalDiameterMm: 200,
      lengthMm: 12_000,
      selectedPositionRatio: 0.25,
    }));

    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img', { name: '测径（外径）曲线，按钢管长度位置变化' })).toBeInTheDocument();
    expect(container.querySelector('.diameter-curve-card > header')).toBeNull();
    expect(container.querySelector('.diameter-trend-header')).toBeNull();
    expect(container.querySelector('.diameter-curve-card > footer')).toBeNull();
    expect(container.querySelectorAll('canvas')).toHaveLength(2);
    expect(screen.getByRole('img', { name: '测径（外径）曲线，按钢管长度位置变化' }))
      .toHaveAttribute('data-selected-axis-value', '3000.000');
    expect(screen.getByRole('group', { name: '测径曲线多选' })).toBeInTheDocument();
    const fittedSeries = screen.getByRole('checkbox', { name: '圆拟合外径' });
    expect(fittedSeries).toBeChecked();
    fireEvent.click(fittedSeries);
    expect(fittedSeries).not.toBeChecked();
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
  });

  it('uses accepted algorithm sections and a head-relative axis when no encoder is connected', () => {
    const artifact: CaptureFlowMeasurement = {
      schema: 'steel.ranger3-flow-measurement.v1',
      generatedAt: '2026-08-24T12:00:00Z',
      materialId: '3703',
      mode: 'metric',
      metricValid: true,
      qualityGate: { passed: true, reasons: [] },
      selectedSection: {},
      cameras: {},
      surfaceFit: {
        available: true,
        metricValid: true,
        absoluteLongitudinalScaleVerified: false,
        sectionsRequested: 3,
        sectionsAccepted: 2,
        diameterMeanMm: 45.1,
        diameterRangeMm: 0.2,
        roundnessMaximumMm: 0.15,
        fitResidualP95MaximumMm: 0.3,
        sections: [
          { anchorOrdinal: 0, elapsedFromHeadMs: 0, positionRatio: 0, metricValid: false, circleFit: { available: true, diameterMm: 41, p95AbsResidualMm: 3 } },
          { anchorOrdinal: 1, elapsedFromHeadMs: 100, positionRatio: 0.5, metricValid: true, circleFit: { available: true, diameterMm: 45, roundnessMm: 0.1, p95AbsResidualMm: 0.2, robustPointCount: 280 } },
          { anchorOrdinal: 2, elapsedFromHeadMs: 200, positionRatio: 1, metricValid: true, circleFit: { available: true, diameterMm: 45.2, roundnessMm: 0.15, p95AbsResidualMm: 0.3, robustPointCount: 282 } },
        ],
        diameterCurves: {
          model: 'opposed-radial-pairs-from-reconstructed-surface',
          angleConvention: 'array-x-axis-ccw-period-180',
          longitudinalCoordinate: 'head-relative-time',
          fixedAnglesDeg: [0, 90],
          sections: [
            { anchorOrdinal: 0, elapsedFromHeadMs: 0, positionRatio: 0, metricValid: false, diametersMm: [null, null], minimumMm: null, maximumMm: null, averageMm: null },
            { anchorOrdinal: 1, elapsedFromHeadMs: 100, positionRatio: 0.5, metricValid: true, diametersMm: [45, 45.2], minimumMm: 45, maximumMm: 45.2, averageMm: 45.1 },
            { anchorOrdinal: 2, elapsedFromHeadMs: 200, positionRatio: 1, metricValid: true, diametersMm: [45.1, 45.3], minimumMm: 45.1, maximumMm: 45.3, averageMm: 45.2 },
          ],
          series: [
            { id: 'angle-000', kind: 'fixed-angle', angleDeg: 0, label: '0°', valuesMm: [null, 45, 45.1] },
            { id: 'angle-090', kind: 'fixed-angle', angleDeg: 90, label: '90°', valuesMm: [null, 45.2, 45.3] },
            { id: 'minimum', kind: 'aggregate', label: '最小', valuesMm: [null, 45, 45.1] },
            { id: 'maximum', kind: 'aggregate', label: '最大', valuesMm: [null, 45.2, 45.3] },
            { id: 'average', kind: 'aggregate', label: '平均', valuesMm: [null, 45.1, 45.2] },
          ],
          summary: { minimumMm: 45, maximumMm: 45.3, averageMm: 45.15, validSectionCount: 2, validSampleCount: 4 },
        },
      },
    };
    expect(buildArtifactDiameterMeasurements(artifact, 45, 12_000)).toHaveLength(2);
    expect(buildDirectionalDiameterLines(artifact, 45, 12_000)).toHaveLength(5);
    expect(buildDiameterMetricSummary(artifact)).toMatchObject({
      qualified: true,
      validSectionCount: 2,
      requestedSectionCount: 3,
      fixedAngleCount: 2,
      minimumDiameterMm: 45,
      averageDiameterMm: 45.15,
      maximumDiameterMm: 45.3,
    });
    render(createElement(DiameterTrendPanel, { artifact, nominalDiameterMm: 45, lengthMm: 12_000 }));
    const grid = screen.getByTestId('diameter-trend-grid');
    expect(grid).toHaveAttribute('data-measurement-source', 'measurement-artifact');
    expect(grid).toHaveAttribute('data-curve-model', 'fixed-angle-reconstructed-surface');
    expect(grid).toHaveAttribute('data-fixed-angle-series', '2');
    expect(grid).toHaveAttribute('data-x-axis-mode', 'head-relative');
    expect(screen.queryByText('2 / 3')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('固定角度测径曲线图例')).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(5);
    fireEvent.click(screen.getByRole('checkbox', { name: '0°' }));
    expect(screen.getByRole('checkbox', { name: '0°' })).not.toBeChecked();
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(4);
    const chart = screen.getByRole('img', { name: '测径（外径）曲线，按头部相对位置变化' });
    Object.defineProperty(chart, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 600, bottom: 300, width: 600, height: 300, x: 0, y: 0, toJSON: () => ({}) }),
    });
    fireEvent.pointerMove(chart, { clientX: 330, clientY: 150 });
    expect(document.querySelector('.diameter-canvas-tooltip')).toHaveTextContent('%');
    expect(document.querySelectorAll('.diameter-canvas-tooltip span')).toHaveLength(4);
  });

  it('renders an explicitly unqualified trend without marking it as valid measurement', () => {
    const artifact: CaptureFlowMeasurement = {
      schema: 'steel.ranger3-flow-measurement.v1',
      generatedAt: '2026-08-25T12:00:00Z',
      materialId: '4023',
      mode: 'preview',
      metricValid: false,
      qualityGate: { passed: false, reasons: ['surface-quality-gate-failed'] },
      selectedSection: {},
      cameras: {},
      surfaceFit: {
        available: true,
        metricValid: false,
        sectionsRequested: 2,
        sectionsAccepted: 2,
        sections: [],
        diameterCurves: {
          available: true,
          metricValid: false,
          model: 'opposed-radial-pairs-from-reconstructed-surface',
          angleConvention: 'array-x-axis-ccw-period-180',
          longitudinalCoordinate: 'head-relative-time',
          fixedAnglesDeg: [0],
          sections: [
            { anchorOrdinal: 0, elapsedFromHeadMs: 0, positionRatio: 0, metricValid: true, diametersMm: [45], averageMm: 45 },
            { anchorOrdinal: 1, elapsedFromHeadMs: 100, positionRatio: 1, metricValid: true, diametersMm: [45.2], averageMm: 45.2 },
          ],
          series: [
            { id: 'angle-000', kind: 'fixed-angle', angleDeg: 0, label: '0°', valuesMm: [45, 45.2] },
            { id: 'average', kind: 'aggregate', label: '平均', valuesMm: [45, 45.2] },
          ],
          summary: { metricValid: false, minimumMm: 45, maximumMm: 45.2, averageMm: 45.1, validSectionCount: 2 },
        },
      },
    };

    expect(buildDirectionalDiameterLines(artifact, 45, 12_000)).toHaveLength(2);
    expect(buildDiameterFitWarning(artifact)).toBeNull();
    expect(buildDiameterMetricSummary(artifact)).toMatchObject({ qualified: false, qualityNote: '未通过整卷计量质量门，曲线仅用于趋势查看' });
    render(createElement(DiameterTrendPanel, { artifact, nominalDiameterMm: 45, lengthMm: 12_000 }));
    expect(screen.getByTestId('diameter-trend-grid')).toHaveAttribute('data-measurement-valid', 'false');
    expect(screen.queryByText('趋势预览')).not.toBeInTheDocument();
  });

  it('turns an unavailable outer-diameter fit into a detailed warning', () => {
    const artifact: CaptureFlowMeasurement = {
      schema: 'steel.ranger3-flow-measurement.v1',
      generatedAt: '2026-08-30T12:00:00Z',
      materialId: '5028',
      mode: 'preview',
      metricValid: false,
      qualityGate: {
        passed: false,
        reasons: [
          'not-enough-qualified-surface-sections',
          'camera-depth-precision-out-of-tolerance',
          'surface-quality-gate-failed',
        ],
      },
      selectedSection: {},
      cameras: {},
      surfaceFit: {
        available: false,
        metricValid: false,
        reason: 'not-enough-qualified-surface-sections',
        sectionsRequested: 6,
        sectionsAccepted: 0,
        sections: [
          {
            anchorOrdinal: 0,
            metricValid: false,
            qualityGate: { passed: false, reasons: ['circle-fit-residual-out-of-tolerance'] },
            circleFit: { available: false, reason: 'circle-fit-unavailable' },
          },
        ],
      },
    };

    expect(buildDiameterFitWarning(artifact)).toMatchObject({
      materialId: '5028',
      acceptedSectionCount: 0,
      requestedSectionCount: 6,
      reasons: expect.arrayContaining([
        'not-enough-qualified-surface-sections',
        'camera-depth-precision-out-of-tolerance',
        'circle-fit-residual-out-of-tolerance',
      ]),
    });

    render(createElement(DiameterTrendPanel, { artifact, nominalDiameterMm: 45, lengthMm: 12_000 }));
    const warning = screen.getByRole('alert');
    expect(warning).toHaveClass('diameter-fit-warning-empty');
    expect(warning).toHaveTextContent('外径拟合失败');
    expect(warning).toHaveTextContent('有效拟合截面 0/6');
    expect(warning).toHaveTextContent('相机深度精度超限');
  });
});
