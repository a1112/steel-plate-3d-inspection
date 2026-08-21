import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getMockInspectionSnapshot } from '../data/inspection';
import { fetchBkvOnlineStatus } from '../services/bkv-online-api';
import { BkvConversionStatusDialog } from './BkvConversionStatusDialog';

vi.mock('../services/bkv-online-api', () => ({
  fetchBkvOnlineStatus: vi.fn().mockResolvedValue({
    enabled: true,
    running: true,
    source: 'bkv-online-mysql',
    databaseConnected: true,
    hasSnapshot: true,
    recordLimit: 500,
    recordCount: 500,
    previewImageCount: 6,
    latestRecord: {
      id: '1902341',
      plateNo: 'STEEL-1 / 1902341',
      time: '18:38',
      defectCount: 0,
    },
    refreshIntervalMs: 5_000,
    refreshAttempts: 54,
    refreshSuccesses: 54,
    lastSuccessAtMs: 1_784_891_000_000,
    lastError: null,
    lastErrorDetail: null,
    processingLogPath: 'D:/steel-inspection/algorithm-data/processing-times.jsonl',
    processingLog: [{
      operation: 'inspection-world',
      recordId: '1902341',
      elapsedMs: 1234,
      completedAtMs: 1_784_891_000_000,
    }],
    dailyHistory: [{
      date: '2026-07-24',
      recordCount: 18,
      successCount: 17,
      abnormalCount: 1,
      timedCount: 15,
      elapsedMs: 75_000,
      averageElapsedMs: 5_000,
      latestRecordId: '1902341',
      latestCompletedAtMs: 1_784_891_000_000,
    }],
  }),
}));

describe('BkvConversionStatusDialog', () => {
  it('shows live conversion counters and actual camera image URLs', async () => {
    const snapshot = {
      ...getMockInspectionSnapshot(),
      source: 'bkv-online-mysql',
      captureImages: Array.from({ length: 6 }, (_, index) => ({
        id: `camera-${index + 1}`,
        cameraId: `camera${index + 1}`,
        cameraIp: `CamImageSource${index + 1}`,
        dataName: 'intensity',
        sequenceNo: 0,
        fileType: 'bmp',
        path: `CamImageSource${index + 1}/1902341/2D/0000.bmp`,
        url: `http://127.0.0.1:4873/api/bkv-online/image?camera=${index + 1}&seq=1902341&index=0&kind=2d`,
        createdAt: '2026-07-24 18:38:44',
      })),
    };
    const onClose = vi.fn();

    render(<BkvConversionStatusDialog snapshot={snapshot} onClose={onClose} />);

    expect(await screen.findByText('转换循环运行正常')).toBeInTheDocument();
    expect(screen.getByText('500 条')).toBeInTheDocument();
    expect(screen.getByText('6 张')).toBeInTheDocument();
    expect(screen.getByText('每日转换记录')).toBeInTheDocument();
    expect(screen.getByText('2026-07-24')).toBeInTheDocument();
    expect(screen.getByText('1.3 分钟')).toBeInTheDocument();
    expect(screen.getByText('5.0 秒')).toBeInTheDocument();
    expect(screen.getByText('最近转换明细')).toBeInTheDocument();
    const expectedLogTime = new Date(1_784_891_000_000).toLocaleTimeString('zh-CN', { hour12: false });
    expect(screen.getByText(`记录 1902341 · ${expectedLogTime}`)).toBeInTheDocument();
    expect(screen.getByText('1.2 秒')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /实际2D图像/ })).toHaveLength(6);
    expect(screen.getByRole('img', { name: 'camera1 实际2D图像' })).toHaveAttribute(
      'src',
      expect.stringContaining('/api/bkv-online/image?camera=1'),
    );
    await waitFor(() => expect(fetchBkvOnlineStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: '关闭转换状态弹窗' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('resolves a relative BKV depth image through the inspection service origin', async () => {
    const fixture = getMockInspectionSnapshot();
    const snapshot = {
      ...fixture,
      source: 'bkv-online-mysql',
      defects: fixture.defects.map((defect, index) => index === 0 ? {
        ...defect,
        artifacts: {
          schema: 'steel.surface.defect.artifacts.v1',
          cameraId: 'camera3',
          frameId: '1902351-6',
          sequenceNo: 6,
          roi: { x: 0, y: 0, width: 10, height: 10 },
          sourceFrame: {
            depth: '/api/bkv-online/image?camera=3&seq=1902351&index=6&kind=depth',
          },
        },
      } : defect),
    };

    render(<BkvConversionStatusDialog snapshot={snapshot} onClose={vi.fn()} />);

    expect(await screen.findByRole('img', { name: /实际3D图像/ })).toHaveAttribute(
      'src',
      'http://127.0.0.1:4873/api/bkv-online/image?camera=3&seq=1902351&index=6&kind=depth',
    );
  });
});
