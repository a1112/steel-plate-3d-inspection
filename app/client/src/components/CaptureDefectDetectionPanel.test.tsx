import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureDefectDetectionPanel } from './CaptureDefectDetectionPanel';

const readCaptureDefects = vi.fn();
const rebuildCaptureDefects = vi.fn();

vi.mock('../lib/capture-api', () => ({
  readCaptureDefects: (...args: unknown[]) => readCaptureDefects(...args),
  rebuildCaptureDefects: (...args: unknown[]) => rebuildCaptureDefects(...args),
}));

describe('CaptureDefectDetectionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readCaptureDefects.mockResolvedValue({
      code: 0,
      path: 'D:/steel-sick-data/defects/FLOW-1/manifest.json',
      detection: {
        schema: 'steel.sick-flow-defect-detection.v1',
        generatedAt: '2026-08-22T10:00:00Z',
        materialId: 'FLOW-1',
        state: 'complete',
        temporaryModel: true,
        quality: {
          reviewRequired: true,
          fineGrainedClassification: true,
          gpuAcceleration: true,
        },
        statistics: {
          defectCount: 1,
          boundaryArtifactFilteredCount: 2,
          pseudoDefectFilteredCount: 4,
        },
        defects: [{
          id: 'FLOW-1-C1-000001',
          cameraId: 'C1',
          storageIndex: 8,
          imageRect2d: { left: 1, top: 2, right: 30, bottom: 40 },
          classId: 'legacy-3',
          className: '划伤',
          classificationStage: 'fine-grained-temporary-model',
          confidence: 0.91,
          recognitionConfidence: 0.83,
          severity: 'review',
          modalities: ['2d', '3d'],
        }],
      },
    });
    rebuildCaptureDefects.mockResolvedValue({ code: 0, state: 'building', materialId: 'FLOW-1' });
  });

  it('shows temporary GPU detections and supports rebuilding', async () => {
    render(<CaptureDefectDetectionPanel materialId="FLOW-1" />);
    expect(await screen.findByText('1 个候选')).toBeInTheDocument();
    expect(screen.getByText('CUDA GPU · 二级识别临时模型')).toBeInTheDocument();
    expect(screen.getByText('已过滤 6 个边界/伪缺陷 · 结果仍需复核')).toBeInTheDocument();
    expect(screen.getByText('C1 · 第 8 帧 · 划伤')).toBeInTheDocument();
    expect(screen.getByText(/检出 91\.0% · 识别 83\.0% · 2D\+3D/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重新检出/ }));
    await waitFor(() => expect(rebuildCaptureDefects).toHaveBeenCalledWith('FLOW-1'));
  });
});
