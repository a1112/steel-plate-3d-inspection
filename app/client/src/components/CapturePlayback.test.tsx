import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CaptureCameraStatus,
  CaptureHistoryCameraFrame,
  CaptureHistoryResult,
} from '../lib/capture-api';
import { CapturePlayback } from './CapturePlayback';

const playbackMocks = vi.hoisted(() => ({
  readHistory: vi.fn(),
  imageUrl: vi.fn((
    artifactRef: string,
    maxWidth: number,
    roi: readonly [number, number, number, number],
  ) => (
    `/api/capture/file?path=${encodeURIComponent(artifactRef)}`
    + `&maxWidth=${maxWidth}&region=valid`
    + `&cropX=${roi[0]}&cropY=${roi[1]}`
    + `&cropWidth=${roi[2] - roi[0]}&cropHeight=${roi[3] - roi[1]}`
  )),
}));

vi.mock('../lib/capture-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/capture-api')>();
  return {
    ...original,
    readCaptureHistory: playbackMocks.readHistory,
    captureHistoryImageUrl: playbackMocks.imageUrl,
  };
});

vi.mock('./CaptureMeasurementPanel', () => ({
  CaptureMeasurementPanel: ({ materialId }: { materialId: string }) => (
    <div data-testid="measurement-panel">{materialId}</div>
  ),
}));

vi.mock('./CaptureDefectDetectionPanel', () => ({
  CaptureDefectDetectionPanel: ({ materialId }: { materialId: string }) => (
    <div data-testid="defect-panel">{materialId}</div>
  ),
}));

const statuses: CaptureCameraStatus[] = [
  { connected: true, deviceId: 1, ip: '192.168.101.144', name: 'C1' },
  { connected: true, deviceId: 2, ip: '192.168.102.206', name: 'C2' },
  { connected: true, deviceId: 3, ip: '192.168.103.167', name: 'C3' },
];

function savedCamera(
  cameraIndex: number,
  overrides: Partial<CaptureHistoryCameraFrame> = {},
): CaptureHistoryCameraFrame {
  return {
    cameraId: `C${cameraIndex}`,
    cameraIndex,
    ip: statuses[cameraIndex - 1].ip,
    artifactRef: `63/capture/C${cameraIndex}/2d/12.png`,
    width: 2560,
    height: 1280,
    playbackWidth: 600,
    playbackHeight: 980,
    validRoi: [100, 20, 700, 1000],
    regionState: 'ready',
    bytes: 128_000,
    storedAt: '2026-08-24T02:00:00.000Z',
    ...overrides,
  };
}

function history(cameras: CaptureHistoryCameraFrame[]): CaptureHistoryResult {
  return {
    code: 0,
    storageRoot: 'D:\\steel-sick-data',
    total: 1,
    count: 1,
    hasMore: false,
    indexed: true,
    frames: [{
      frameId: '63:000000000012',
      materialId: '63',
      sequence: 12,
      capturedAt: '2026-08-24T02:00:00.000Z',
      cameras,
    }],
  };
}

describe('CapturePlayback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders only ready, in-bounds algorithm ROI images and never falls back to raw frames', async () => {
    playbackMocks.readHistory.mockResolvedValue(history([
      savedCamera(1),
      savedCamera(2, { regionState: 'background-missing' }),
      savedCamera(3, { validRoi: [100, 0, 2561, 1280] }),
    ]));

    render(<CapturePlayback statuses={statuses} />);

    await waitFor(() => expect(playbackMocks.readHistory).toHaveBeenCalledWith(300));
    const readyImage = await screen.findByRole('img', { name: 'C1 历史灰度图' });
    expect(readyImage).toHaveAttribute(
      'src',
      expect.stringMatching(
        /path=63%2Fcapture%2FC1%2F2d%2F12\.png&maxWidth=\d+&region=valid&cropX=100&cropY=20&cropWidth=600&cropHeight=980/,
      ),
    );
    expect(readyImage).toHaveAttribute('width', '600');
    expect(readyImage).toHaveAttribute('height', '980');
    expect(screen.queryByRole('img', { name: 'C2 历史灰度图' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'C3 历史灰度图' })).not.toBeInTheDocument();
    expect(screen.getAllByText('该帧无算法裁剪图')).toHaveLength(2);
    expect(playbackMocks.imageUrl).toHaveBeenCalled();
    expect(playbackMocks.imageUrl).toHaveBeenCalledWith(
      '63/capture/C1/2d/12.png',
      expect.any(Number),
      [100, 20, 700, 1000],
    );
    for (const [artifactRef, , roi] of playbackMocks.imageUrl.mock.calls) {
      expect(artifactRef).toBe('63/capture/C1/2d/12.png');
      expect(roi).toEqual([100, 20, 700, 1000]);
    }
  });
});
