import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CaptureFlowMeasurement } from '../lib/capture-api';
import { DiameterAnalysisPage } from './DiameterAnalysisPage';

const measurement: CaptureFlowMeasurement = {
  schema: 'steel.ranger3-flow-measurement.v1',
  generatedAt: '2026-08-27T14:00:00Z',
  materialId: '4034',
  mode: 'metric',
  metricValid: true,
  qualityGate: { passed: true, reasons: [] },
  selectedSection: {},
  cameras: {},
  surfaceFit: {
    available: true,
    metricValid: true,
    absoluteLongitudinalScaleVerified: true,
    sectionsRequested: 3,
    sectionsAccepted: 3,
    diameterMeanMm: 77.1,
    diameterMinimumMm: 77,
    diameterMaximumMm: 77.2,
    roundnessMaximumMm: 0.12,
    fitResidualP95MaximumMm: 0.08,
    sections: [
      { anchorOrdinal: 0, elapsedFromHeadMs: 0, positionRatio: 0, metricValid: true, circleFit: { available: true, diameterMm: 77, roundnessMm: 0.08, p95AbsResidualMm: 0.05, robustPointCount: 280 } },
      { anchorOrdinal: 1, elapsedFromHeadMs: 100, positionRatio: 0.5, metricValid: true, circleFit: { available: true, diameterMm: 77.2, roundnessMm: 0.12, p95AbsResidualMm: 0.08, robustPointCount: 282 } },
      { anchorOrdinal: 2, elapsedFromHeadMs: 200, positionRatio: 1, metricValid: true, circleFit: { available: true, diameterMm: 77.1, roundnessMm: 0.09, p95AbsResidualMm: 0.06, robustPointCount: 281 } },
    ],
    diameterCurves: {
      available: true,
      model: 'opposed-radial-pairs-from-reconstructed-surface',
      angleConvention: 'array-x-axis-ccw-period-180',
      longitudinalCoordinate: 'head-relative-time',
      fixedAnglesDeg: [0, 90],
      sections: [
        { anchorOrdinal: 0, elapsedFromHeadMs: 0, positionRatio: 0, metricValid: true, diametersMm: [77, 77.1], minimumMm: 77, maximumMm: 77.1, averageMm: 77.05 },
        { anchorOrdinal: 1, elapsedFromHeadMs: 100, positionRatio: 0.5, metricValid: true, diametersMm: [77.2, 77.15], minimumMm: 77.15, maximumMm: 77.2, averageMm: 77.175 },
        { anchorOrdinal: 2, elapsedFromHeadMs: 200, positionRatio: 1, metricValid: true, diametersMm: [77.1, 77.05], minimumMm: 77.05, maximumMm: 77.1, averageMm: 77.075 },
      ],
      series: [
        { id: 'fixed-0', label: '0°', kind: 'fixed-angle', angleDeg: 0, valuesMm: [77, 77.2, 77.1] },
        { id: 'fixed-90', label: '90°', kind: 'fixed-angle', angleDeg: 90, valuesMm: [77.1, 77.15, 77.05] },
        { id: 'minimum', label: '最小', kind: 'aggregate', valuesMm: [77, 77.15, 77.05] },
        { id: 'maximum', label: '最大', kind: 'aggregate', valuesMm: [77.1, 77.2, 77.1] },
        { id: 'average', label: '平均', kind: 'aggregate', valuesMm: [77.05, 77.175, 77.075] },
      ],
      summary: { metricValid: true, minimumMm: 77, maximumMm: 77.2, averageMm: 77.1, validSectionCount: 3, validSampleCount: 6 },
    },
  },
};

const failedMeasurement: CaptureFlowMeasurement = {
  schema: 'steel.ranger3-flow-measurement.v1',
  generatedAt: '2026-08-30T12:00:00Z',
  materialId: '5028',
  mode: 'preview',
  metricValid: false,
  qualityGate: {
    passed: false,
    reasons: ['not-enough-qualified-surface-sections', 'camera-depth-precision-out-of-tolerance'],
  },
  selectedSection: {},
  cameras: {},
  surfaceFit: {
    available: false,
    metricValid: false,
    reason: 'not-enough-qualified-surface-sections',
    sectionsRequested: 6,
    sectionsAccepted: 0,
    sections: [],
  },
};

const plate = {
  plateNo: '4034',
  widthMm: 77.1,
  lengthMm: 12_000,
  thicknessMm: 3.2,
  steelGrade: 'Q235B',
  detectedAt: '2026-08-27 14:00:00',
};

const records = [
  { id: 'R-001', time: '14:00', plateNo: '4034', status: 'completed' as const, defectCount: 2 },
  { id: 'R-002', time: '13:58', plateNo: '4033', status: 'detecting' as const, defectCount: 0 },
];

describe('DiameterAnalysisPage', () => {
  it('renders a standalone measurement workspace and exports the bound result', () => {
    const onRecordSelect = vi.fn();
    const onExport = vi.fn();
    render(
      <DiameterAnalysisPage
        plate={plate}
        records={records}
        selectedRecordId="R-001"
        inspectionId="INSP-4034"
        measurement={measurement}
        onRecordSelect={onRecordSelect}
        onExport={onExport}
      />,
    );

    expect(screen.getByRole('main', { name: '独立测径分析页面' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '测径分析' })).toBeInTheDocument();
    expect(screen.getByTestId('diameter-trend-grid')).toHaveAttribute('data-measurement-valid', 'true');
    expect(screen.getByText('3/3')).toBeInTheDocument();
    expect(screen.getByText('2 条')).toBeInTheDocument();
    expect(screen.getAllByText(/长度坐标已验证/)).toHaveLength(2);
    expect(screen.getByRole('img', { name: '当前截面圆度示意' })).toBeInTheDocument();

    const recordList = screen.getByRole('listbox', { name: '测径检测记录' });
    fireEvent.click(within(recordList).getByRole('option', { name: /4033/ }));
    expect(onRecordSelect).toHaveBeenCalledWith('R-002');

    fireEvent.change(screen.getByLabelText('公差（±）'), { target: { value: '0.05' } });
    expect(screen.getByText('超出规格')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '导出测径报告' }));
    expect(onExport).toHaveBeenCalledWith(expect.objectContaining({
      schema: 'steel.diameter-analysis-export.v1',
      inspectionId: 'INSP-4034',
      nominalDiameterMm: 77.1,
      toleranceMm: 0.05,
      qualified: false,
    }));
  });

  it('shows a record-bound empty state without enabling export', () => {
    render(
      <DiameterAnalysisPage
        plate={plate}
        records={records}
        selectedRecordId="R-001"
        inspectionId="INSP-4034"
        artifactStatus="measurement 尚未生成"
        onRecordSelect={vi.fn()}
        onExport={vi.fn()}
      />,
    );

    expect(screen.getByText('当前记录暂无测径产物')).toBeInTheDocument();
    expect(screen.getAllByText('measurement 尚未生成')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '导出测径报告' })).toBeDisabled();
  });

  it('shows a persistent warning when the completed record has no outer-diameter fit', () => {
    render(
      <DiameterAnalysisPage
        plate={plate}
        records={records}
        selectedRecordId="R-001"
        inspectionId="INSP-5028"
        measurement={failedMeasurement}
        onRecordSelect={vi.fn()}
        onExport={vi.fn()}
      />,
    );

    const pageWarning = document.querySelector('.diameter-fit-warning');
    expect(pageWarning).toHaveAttribute('role', 'alert');
    expect(pageWarning).toHaveTextContent('外径拟合失败');
    expect(pageWarning).toHaveTextContent('流水 5028');
    expect(pageWarning).toHaveTextContent('有效拟合截面 0/6');
    expect(pageWarning).toHaveTextContent('相机深度精度超限');
    expect(document.querySelector('.diameter-page-quality-chip.failed')).toHaveTextContent('外径拟合失败');
    expect(document.querySelector('.diameter-verdict-panel.failed')).toHaveTextContent('拟合失败');
    expect(within(screen.getByRole('option', { selected: true })).getByText('拟合失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出测径报告' })).toBeDisabled();
  });

  it('reuses the online shell without rendering a second left sidebar', () => {
    render(
      <DiameterAnalysisPage
        embedded
        plate={plate}
        records={records}
        selectedRecordId="R-001"
        inspectionId="INSP-4034"
        measurement={measurement}
        onRecordSelect={vi.fn()}
        onExport={vi.fn()}
      />,
    );

    expect(screen.getByRole('main', { name: '独立测径分析页面' })).toHaveClass('embedded');
    expect(screen.queryByRole('heading', { name: '钢管信息' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '记录查询' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '测径分析' })).toBeInTheDocument();
  });
});
