import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { CaptureCameraStatus, CaptureHealth } from '../lib/capture-api';
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('does not request a new image merely because a decoded frame updates parent state', () => {
    function Harness() {
      const [frames, setFrames] = useState(0);
      return <>
        <span data-testid="frame-count">{frames}</span>
        <StableStreamImage
          src="/stable-frame.png?v=7"
          alt="单一在途实时帧"
          onFrame={() => setFrames((value) => value + 1)}
          onError={() => undefined}
        />
      </>;
    }
    const view = render(<Harness />);
    const pending = view.container.querySelector<HTMLImageElement>('.live-monitor-image-preload');
    expect(pending).toHaveAttribute('src', '/stable-frame.png?v=7');
    fireEvent.load(pending!);

    expect(screen.getByTestId('frame-count')).toHaveTextContent('1');
    expect(view.container.querySelectorAll('img')).toHaveLength(1);
    expect(view.container.querySelector('.live-monitor-image-preload')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: '单一在途实时帧' })).toHaveAttribute('src', '/stable-frame.png?v=7');
  });

  it('surfaces transport gaps even when all cameras have equal frame counts', () => {
    render(<LiveMonitoringPage statuses={statuses.map((status) => ({ ...status, connected: false }))} health={{
      service: 'steel_sick_capture_sidecar',
      time: '2026-08-24T00:00:00Z',
      provider: 'external-api',
      sdkReady: true,
      sdkCode: 0,
      connected: true,
      ip: statuses[0].ip,
      cameraCount: 2,
      expectedCameras: 2,
      acquisitionSynchronization: {
        schema: 'steel.capture-synchronization.v1',
        status: 'degraded',
        synchronized: false,
        expectedCameras: 2,
        connectedCameras: 2,
        windowRounds: 120,
        completeRounds: 120,
        incompleteRounds: 0,
        completenessPercent: 100,
        frameCounts: { C1: 120, C2: 120 },
        frameCountSkew: 0,
        transportFrameGaps: 9,
      },
    }} />);

    expect(screen.getByText('同步降级')).toBeInTheDocument();
    expect(screen.getByText('2/2 · 偏差 0 · 丢帧 9')).toBeInTheDocument();
  });

  it('renders a full monitoring page, auto-starts a stream, and switches cameras and image planes', async () => {
    const health: CaptureHealth = {
      service: 'steel_sick_capture_sidecar',
      time: '2026-08-21T04:00:00Z',
      provider: 'external-api',
      sdkReady: true,
      sdkCode: 0,
      connected: true,
      ip: statuses[0].ip,
      cameraCount: 2,
      expectedCameras: 2,
      acquisitionSynchronization: {
        schema: 'steel.capture-synchronization.v1',
        status: 'synchronized',
        synchronized: true,
        expectedCameras: 2,
        connectedCameras: 2,
        windowRounds: 20,
        completeRounds: 20,
        incompleteRounds: 0,
        completenessPercent: 100,
        frameCounts: { C1: 120, C2: 120 },
        frameCountSkew: 0,
      },
    };
    const view = render(<LiveMonitoringPage statuses={statuses} health={health} />);

    expect(screen.getByRole('main', { name: '相机监控页面' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '相机监控' })).toBeInTheDocument();
    expect(screen.getByText('2/2 · 偏差 0')).toBeInTheDocument();

    await waitFor(() => {
      expect(captureMocks.start).toHaveBeenCalledTimes(2);
      expect(captureMocks.start).toHaveBeenCalledWith(expect.objectContaining({
        ip: '192.168.101.144',
        dataMode: 3,
        fpsLimit: 2,
      }));
      expect(captureMocks.start).toHaveBeenCalledWith(expect.objectContaining({
        ip: '192.168.102.206',
        dataMode: 3,
        fpsLimit: 2,
      }));
    });
    view.rerender(
      <LiveMonitoringPage
        statuses={statuses.map((status) => ({ ...status, streamRunning: true, streamFrames: 1 }))}
        health={health}
      />,
    );
    expect(screen.getByRole('img', { name: 'C1 实时灰度图' })).toHaveAttribute(
      'src',
      expect.stringContaining('kind=intensity-grid'),
    );

    expect(screen.getByLabelText('六相机实时画面网格')).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByRole('button', { name: '放大 C2 实时画面' }));
    expect(captureMocks.start).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '深度图' }));
    expect(screen.getByRole('img', { name: 'C2 实时深度图' })).toHaveAttribute(
      'src',
      expect.stringContaining('kind=depth'),
    );

    fireEvent.doubleClick(screen.getByRole('img', { name: 'C2 实时深度图' }));
    expect(screen.getByLabelText('六相机实时画面网格')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '暂停六相机实时播放' }));
    await waitFor(() => {
      expect(captureMocks.stop).toHaveBeenCalledWith('192.168.101.144');
      expect(captureMocks.stop).toHaveBeenCalledWith('192.168.102.206');
    });

    fireEvent.click(screen.getByRole('tab', { name: '回放' }));
    await waitFor(() => expect(captureMocks.history).toHaveBeenCalledWith(300));
    expect(screen.getByLabelText('历史六相机画面')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'C1 历史灰度图' })).toHaveAttribute(
      'src',
      expect.stringContaining('maxWidth=560'),
    );
  });

  it('waits for provider warm-up when a newly owned stream is running without a frame', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const initialStatus = statuses[0];
    const view = render(<LiveMonitoringPage statuses={[initialStatus]} />);

    try {
      await waitFor(() => expect(captureMocks.start).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(
        screen.getByRole('button', { name: '暂停六相机实时播放' }),
      ).not.toBeDisabled());
      view.rerender(
        <LiveMonitoringPage statuses={[{ ...initialStatus, streamRunning: true, streamFrames: 0 }]} />,
      );

      expect(screen.queryByRole('img', { name: 'C1 实时灰度图' })).not.toBeInTheDocument();

      now.mockReturnValue(5_001);
      view.rerender(
        <LiveMonitoringPage statuses={[{ ...initialStatus, streamRunning: true, streamFrames: 0 }]} />,
      );

      expect(screen.getByRole('img', { name: 'C1 实时灰度图' })).toHaveAttribute(
        'src',
        expect.stringContaining('kind=intensity-grid'),
      );
    } finally {
      view.unmount();
      now.mockRestore();
    }
  });

  it('keeps the other camera previews running when a focused camera is paused', async () => {
    render(<LiveMonitoringPage statuses={statuses} />);

    await waitFor(() => expect(captureMocks.start).toHaveBeenCalledTimes(2));
    fireEvent.doubleClick(screen.getByRole('button', { name: '放大 C2 实时画面' }));
    fireEvent.click(screen.getByRole('button', { name: '暂停相机实时播放' }));

    await waitFor(() => expect(captureMocks.stop).toHaveBeenCalledWith('192.168.102.206'));
    expect(captureMocks.stop).not.toHaveBeenCalledWith('192.168.101.144');
  });

  it('does not request a stopped camera through stale running telemetry before restart', async () => {
    const runningStatuses = statuses.map((status) => ({
      ...status,
      streamRunning: true,
      streamFrames: 12,
    }));
    const view = render(<LiveMonitoringPage statuses={runningStatuses} />);

    fireEvent.doubleClick(screen.getByRole('button', { name: '放大 C2 实时画面' }));
    fireEvent.click(screen.getByRole('button', { name: '暂停相机实时播放' }));
    await waitFor(() => expect(captureMocks.stop).toHaveBeenCalledWith('192.168.102.206'));
    await waitFor(() => expect(
      screen.getByRole('button', { name: '启动相机实时播放' }),
    ).not.toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: '启动相机实时播放' }));
    view.rerender(<LiveMonitoringPage statuses={runningStatuses} />);

    expect(screen.queryByRole('img', { name: 'C2 实时灰度图' })).not.toBeInTheDocument();
    expect(captureMocks.start).not.toHaveBeenCalled();

    view.rerender(
      <LiveMonitoringPage statuses={runningStatuses.map((status) => status.name === 'C2'
        ? { ...status, streamRunning: false, streamFrames: 0 }
        : status)} />,
    );
    await waitFor(() => expect(captureMocks.start).toHaveBeenCalledWith(expect.objectContaining({
      ip: '192.168.102.206',
    })));
    expect(captureMocks.start).toHaveBeenCalledTimes(1);
  });
});
