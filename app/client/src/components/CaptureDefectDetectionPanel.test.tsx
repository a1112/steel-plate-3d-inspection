import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureDefectDetectionPanel } from './CaptureDefectDetectionPanel';

const readCaptureDefects = vi.fn();
const rebuildCaptureDefects = vi.fn();
const CaptureApiError = vi.hoisted(() => class extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
});

vi.mock('../lib/capture-api', () => ({
  CaptureApiError,
  captureArtifactImageUrl: (path: string) => `/api/capture/file?path=${encodeURIComponent(path)}`,
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
          processedFrames: 620,
          elapsedMs: 241_900,
          computeElapsedMs: 63_100,
          throughputFramesPerSecond: 2.56,
          computeThroughputFramesPerSecond: 9.83,
          timingsMs: { captureWaitMs: 178_800 },
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
          reviewImage: 'D:/steel-sick-data/63/derived/defects/C1/review.png',
          reviewImageWidth: 64,
          reviewImageHeight: 64,
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
    expect(screen.getByText('计算 9.83 帧/秒 · 总计 241.9 秒 · 620 帧')).toBeInTheDocument();
    expect(screen.getByText('采集优先等待 178.8 秒 · 墙钟吞吐 2.56 帧/秒')).toBeInTheDocument();
    expect(screen.getByText('C1 · 第 8 帧 · 划伤')).toBeInTheDocument();
    expect(screen.getByText(/检出 91\.0% · 识别 83\.0% · 2D\+3D/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /缺陷小图/ })).toHaveAttribute('width', '64');
    fireEvent.click(screen.getByRole('button', { name: /重新检出/ }));
    await waitFor(() => expect(rebuildCaptureDefects).toHaveBeenCalledWith('FLOW-1'));
  });

  it('shows a missing result as pending instead of exposing a raw 404', async () => {
    readCaptureDefects.mockRejectedValue(new CaptureApiError('capture api 404', 404));
    render(<CaptureDefectDetectionPanel materialId="63" />);

    expect(await screen.findByText('尚未生成缺陷检出结果；已提交的任务会自动刷新')).toBeInTheDocument();
    expect(screen.queryByText('capture api 404')).not.toBeInTheDocument();
  });

  it('shows that history detection is truly paused while live steel is being captured', async () => {
    readCaptureDefects.mockResolvedValue({
      code: 0,
      state: 'paused-for-capture',
      historyBackfill: {
        state: 'paused',
        phase: 'rebuild:defect-batch-inference',
        pauseReason: 'steel-present',
        capturePhase: 'steel-in-saving',
        captureQueue: { pendingRounds: 12, activeRounds: 1 },
      },
    });
    render(<CaptureDefectDetectionPanel materialId="63" />);

    expect(await screen.findByText('来钢采集优先，历史重检已暂停')).toBeInTheDocument();
  });
});
