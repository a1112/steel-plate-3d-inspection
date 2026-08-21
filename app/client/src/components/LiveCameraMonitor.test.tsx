import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CaptureCameraStatus } from '../lib/capture-api';
import { LiveMonitoringPage, StableStreamImage } from './LiveCameraMonitor';

const captureMocks = vi.hoisted(() => ({
  start: vi.fn(async ({ ip }: { ip: string }) => ({ code: 0, running: true, ip })),
  stop: vi.fn(async (ip: string) => ({ code: 0, running: false, ip })),
  history: vi.fn(async () => ({
    code: 0,
    storageRoot: 'D:\\steel-sick-data',
    total: 1,
    count: 1,
    hasMore: false,
    frames: [{
      frameId: 'MAT-001:000001',
      materialId: 'MAT-001',
      sequence: 1,
      capturedAt: '2026-08-21T04:00:00Z',
      cameras: [
        { cameraId: 'C1', cameraIndex: 1, ip: '192.168.101.144', artifactRef: 'C1/MAT-001/intensity/000001.png', width: 2560, height: 1280, bytes: 1234, storedAt: '2026-08-21T04:00:00Z' },
        { cameraId: 'C2', cameraIndex: 2, ip: '192.168.102.206', artifactRef: 'C2/MAT-001/intensity/000001.png', width: 2560, height: 1280, bytes: 1234, storedAt: '2026-08-21T04:00:00Z' },
      ],
    }],
  })),
}));

vi.mock('../lib/capture-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/capture-api')>();
  return {
    ...original,
    startCaptureStream: captureMocks.start,
    stopCaptureStream: captureMocks.stop,
    readCaptureHistory: captureMocks.history,
    captureStreamImageUrl: (ip: string, kind: string) => `/api/stream/latest?ip=${ip}&kind=${kind}`,
    captureHistoryImageUrl: (artifactRef: string, maxWidth: number) => `/api/capture/file?path=${artifactRef}&maxWidth=${maxWidth}`,
  };
});

const statuses: CaptureCameraStatus[] = [
  { connected: true, deviceId: 1, ip: '192.168.101.144', name: 'C1', continuousAcquiring: true },
  { connected: true, deviceId: 2, ip: '192.168.102.206', name: 'C2', continuousAcquiring: true },
];

describe('LiveMonitoringPage', () => {
  it('keeps the decoded frame visible until the next image has loaded', async () => {
    const onFrame = vi.fn();
    const onError = vi.fn();
    const view = render(
      <StableStreamImage src="/frame-a.png" alt="稳定实时帧" onFrame={onFrame} onError={onError} />,
    );
    const first = await screen.findByRole('img', { name: '稳定实时帧' });
    fireEvent.load(first);
    expect(screen.getByRole('img', { name: '稳定实时帧' })).toHaveAttribute('src', '/frame-a.png');

    view.rerender(
      <StableStreamImage src="/frame-b.png" alt="稳定实时帧" onFrame={onFrame} onError={onError} />,
    );
    expect(screen.getByRole('img', { name: '稳定实时帧' })).toHaveAttribute('src', '/frame-a.png');
    const pending = view.container.querySelector<HTMLImageElement>('.live-monitor-image-preload');
    expect(pending).toHaveAttribute('src', '/frame-b.png');
    fireEvent.load(pending!);

    expect(screen.getByRole('img', { name: '稳定实时帧' })).toHaveAttribute('src', '/frame-b.png');
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('renders a full monitoring page, auto-starts a stream, and switches cameras and image planes', async () => {
    render(<LiveMonitoringPage statuses={statuses} />);

    expect(screen.getByRole('main', { name: '相机监控页面' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '相机监控' })).toBeInTheDocument();

    await waitFor(() => expect(captureMocks.start).toHaveBeenCalledWith(expect.objectContaining({
      ip: '192.168.101.144',
      dataMode: 3,
      fpsLimit: 8,
    })));
    expect(screen.getByRole('img', { name: 'C1 实时灰度图' })).toHaveAttribute(
      'src',
      expect.stringContaining('kind=intensity-grid'),
    );

    expect(screen.getByLabelText('六相机实时画面网格')).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByRole('button', { name: '放大 C2 实时画面' }));
    await waitFor(() => expect(captureMocks.start).toHaveBeenCalledWith(expect.objectContaining({
      ip: '192.168.102.206',
    })));
    fireEvent.click(screen.getByRole('button', { name: '深度图' }));
    expect(screen.getByRole('img', { name: 'C2 实时深度图' })).toHaveAttribute(
      'src',
      expect.stringContaining('kind=depth'),
    );

    fireEvent.doubleClick(screen.getByRole('img', { name: 'C2 实时深度图' }));
    expect(screen.getByLabelText('六相机实时画面网格')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '暂停六相机实时播放' }));
    await waitFor(() => expect(captureMocks.stop).toHaveBeenCalledWith('192.168.102.206'));

    fireEvent.click(screen.getByRole('tab', { name: '回放' }));
    await waitFor(() => expect(captureMocks.history).toHaveBeenCalledWith(300));
    expect(screen.getByLabelText('历史六相机画面')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'C1 历史灰度图' })).toHaveAttribute(
      'src',
      expect.stringContaining('maxWidth=800'),
    );
  });
});
