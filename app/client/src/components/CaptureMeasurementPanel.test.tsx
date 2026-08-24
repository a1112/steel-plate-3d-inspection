import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureMeasurementPanel } from './CaptureMeasurementPanel';

const readCaptureMeasurement = vi.fn();
const rebuildCaptureMeasurement = vi.fn();
const CaptureApiError = vi.hoisted(() => class extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
});

vi.mock('../lib/capture-api', () => ({
  CaptureApiError,
  readCaptureMeasurement: (...args: unknown[]) => readCaptureMeasurement(...args),
  rebuildCaptureMeasurement: (...args: unknown[]) => rebuildCaptureMeasurement(...args),
}));

describe('CaptureMeasurementPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readCaptureMeasurement.mockResolvedValue({
      code: 0,
      path: 'D:/steel-sick-data/measurements/FLOW-1.json',
      measurement: {
        schema: 'steel.ranger3-flow-measurement.v1',
        generatedAt: '2026-08-22T04:00:00Z',
        materialId: 'FLOW-1',
        mode: 'preview',
        metricValid: false,
        qualityGate: { passed: false, reasons: ['approved-array-calibration-missing'] },
        selectedSection: { circleFit: { available: false } },
        cameras: {
          C1: { available: true, localProfile: [[0, 1], [1, 2], [2, 1]] },
        },
      },
    });
    rebuildCaptureMeasurement.mockResolvedValue({ code: 0, state: 'building', materialId: 'FLOW-1' });
  });

  it('renders preview cross-section and keeps invalid metric output closed', async () => {
    render(<CaptureMeasurementPanel materialId="FLOW-1" />);
    expect(await screen.findByText('仅预览')).toBeInTheDocument();
    expect(screen.getByText('外径待标定')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '棒材截面曲线' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重新分析/ }));
    await waitFor(() => expect(rebuildCaptureMeasurement).toHaveBeenCalledWith('FLOW-1'));
  });

  it('treats a missing algorithm artifact as an actionable pending state', async () => {
    readCaptureMeasurement.mockRejectedValueOnce(new CaptureApiError('capture api 404', 404));
    render(<CaptureMeasurementPanel materialId="63" />);

    expect(await screen.findByText('尚未生成截面分析；已提交的任务会自动刷新')).toBeInTheDocument();
    expect(screen.queryByText('capture api 404')).not.toBeInTheDocument();
  });
});
