import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessingLogPage } from './ProcessingLogPage';

const page = {
  code: 0,
  schema: 'steel.capture-processing-log.v1',
  updatedAt: '1787922600000',
  total: 2,
  records: [
    {
      materialId: '4037', flowNo: 4037, sessionId: 'SESSION-4037', dataStatus: 'degraded', dataStatusLabel: '降级完成', updatedAt: 1787922570968,
      capture: { status: 'completed', statusLabel: '完成', state: 'closed', durationMs: 14200, latestCommittedRound: 1013, expectedCameraCount: 6, actualCameraCount: 6, complete: true, cameras: [{ cameraId: 'C1', sequenceNo: 100, artifactCount: 3, artifactBytes: 4096 }] },
      image: { status: 'completed', statusLabel: '完成', durationMs: 51000, complete: true, productionCameraPipeline: true, artifactCount: 1, artifacts: [{ kind: 'surface', size: 2048, sha256: 'abc', available: true }] },
      algorithm: { status: 'degraded', statusLabel: '降级完成', state: 'ready', defectState: 'degraded', durationMs: 33819.703, frameCount: 238, defectCount: 0, processedFrames: 238, skippedFrames: 11, throughputFramesPerSecond: 7.037, timingsMs: { detectorInferenceMs: 12349 }, metricValid: false, synchronized: false, riskTags: ['global-position-unavailable'], qualityReason: '需要复核' },
    },
    {
      materialId: '4036', flowNo: 4036, sessionId: 'SESSION-4036', dataStatus: 'processing', dataStatusLabel: '处理中', updatedAt: 1787922550000,
      capture: { status: 'completed', statusLabel: '完成', state: 'closed', durationMs: 1000, actualCameraCount: 6, complete: true, cameras: [] },
      image: { status: 'completed', statusLabel: '完成', durationMs: 2000, complete: true, productionCameraPipeline: true, artifactCount: 0, artifacts: [] },
      algorithm: { status: 'processing', statusLabel: '处理中', state: 'processing-defects', defectState: 'queued-for-defect', durationMs: 3000, frameCount: 20, defectCount: 0, processedFrames: 0, skippedFrames: 0, timingsMs: {}, metricValid: false, synchronized: false, riskTags: [] },
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProcessingLogPage', () => {
  it('shows newest-first stage timings and opens detailed data for a selected flow', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(page), { status: 200 })));
    render(<ProcessingLogPage />);

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('4037');
    expect(rows[1]).toHaveTextContent('最新');
    expect(rows[1]).toHaveTextContent('51.0 s');
    expect(screen.getByLabelText('流水号 4037 详细数据')).toHaveTextContent('缺陷推理');
    expect(screen.getByLabelText('流水号 4037 详细数据')).toHaveTextContent('C1');

    fireEvent.click(screen.getByLabelText('查看流水号 4036 详细数据'));
    await waitFor(() => expect(screen.getByLabelText('流水号 4036 详细数据')).toHaveTextContent('processing-defects'));
  });
});
