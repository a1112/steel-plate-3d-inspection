import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { CaptureCameraStatus, CaptureHealth } from '../lib/capture-api';
import { gridStreamRevision, LiveMonitoringPage, StableStreamImage } from './LiveCameraMonitor';

const captureMocks = vi.hoisted(() => ({
  start: vi.fn(async ({ ip }: { ip: string }, _signal?: AbortSignal) => ({ code: 0, running: true, ip })),
  stop: vi.fn(async (ip: string, _signal?: AbortSignal) => ({ code: 0, running: false, ip })),
  history: vi.fn(async () => ({
    code: 0,
    storageRoot: 'D:\\steel-sick-data',
    total: 1,
    count: 1,
    hasMore: false,
    indexed: true,
    frames: [{
      frameId: 'MAT-001:000001',
      materialId: 'MAT-001',
      sequence: 1,
      capturedAt: '2026-08-21T04:00:00Z',
      cameras: [
        { cameraId: 'C1', cameraIndex: 1, ip: '192.168.101.144', artifactRef: '1/capture/C1/2d/1.png', width: 2560, height: 1280, playbackWidth: 600, playbackHeight: 1280, validRoi: [100, 0, 700, 1280], regionState: 'ready', bytes: 1234, storedAt: '2026-08-21T04:00:00Z' },
        { cameraId: 'C2', cameraIndex: 2, ip: '192.168.102.206', artifactRef: '1/capture/C2/2d/1.png', width: 2560, height: 1280, playbackWidth: 600, playbackHeight: 1280, validRoi: [200, 0, 800, 1280], regionState: 'ready', bytes: 1234, storedAt: '2026-08-21T04:00:00Z' },
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
    captureStreamImageUrl: (ip: string, kind: string, revision: string | number) => (
      `/api/stream/latest?ip=${ip}&kind=${kind}&region=valid&v=${revision}`
    ),
    captureHistoryImageUrl: (
      artifactRef: string,
      maxWidth: number,
      roi: readonly [number, number, number, number],
    ) => `/api/capture/file?path=${artifactRef}&maxWidth=${maxWidth}&region=valid&cropX=${roi[0]}&cropY=${roi[1]}&cropWidth=${roi[2] - roi[0]}&cropHeight=${roi[3] - roi[1]}`,
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

  it('times out a stalled preload, keeps the committed frame, and retries', async () => {
    vi.useFakeTimers();
    const onFrame = vi.fn();
    const onError = vi.fn();
    const view = render(
      <StableStreamImage src="/frame-a.png" alt="超时保护实时帧" onFrame={onFrame} onError={onError} />,
    );

    try {
      fireEvent.load(view.container.querySelector<HTMLImageElement>('.live-monitor-image-preload')!);
      view.rerender(
        <StableStreamImage src="/frame-b.png" alt="超时保护实时帧" onFrame={onFrame} onError={onError} />,
      );
      expect(screen.getByRole('img', { name: '超时保护实时帧' })).toHaveAttribute('src', '/frame-a.png');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000);
      });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('img', { name: '超时保护实时帧' })).toHaveAttribute('src', '/frame-a.png');
      expect(view.container.querySelector('.live-monitor-image-preload')).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(view.container.querySelector('.live-monitor-image-preload')).toHaveAttribute('src', '/frame-b.png');
      expect(screen.getByRole('img', { name: '超时保护实时帧' })).toHaveAttribute('src', '/frame-a.png');
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('starts the 500ms refresh clock before initially empty statuses become available', async () => {
    vi.useFakeTimers();
    const view = render(<LiveMonitoringPage statuses={[]} />);

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      view.rerender(<LiveMonitoringPage statuses={[{
        ...statuses[0],
        streamRunning: true,
        streamFrames: 1,
      }]} />);

      const preload = view.container.querySelector<HTMLImageElement>('.live-monitor-image-preload');
      expect(preload).toHaveAttribute('src', expect.stringMatching(/region=valid.*v=2/));
      expect(screen.getByText('C1 等待首帧')).toBeVisible();
      fireEvent.error(preload!);
      expect(screen.getByText('C1 等待首帧，正在重试')).toBeVisible();
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('keeps six committed frames visible while staggered refreshes load or fail', async () => {
    vi.useFakeTimers();
    const sixStatuses: CaptureCameraStatus[] = Array.from({ length: 6 }, (_, index) => ({
      connected: true,
      deviceId: index + 1,
      ip: `192.168.10${index + 1}.100`,
      name: `C${index + 1}`,
      continuousAcquiring: true,
      streamRunning: true,
      streamFrames: 10,
    }));
    const view = render(<LiveMonitoringPage statuses={sixStatuses} />);

    try {
      const initialPreloads = [...view.container.querySelectorAll<HTMLImageElement>(
        '.live-monitor-image-preload',
      )];
      expect(initialPreloads).toHaveLength(6);
      expect(initialPreloads.every((image) => (
        image.src.includes('region=valid') && image.src.includes('v=0')
      ))).toBe(true);
      initialPreloads.forEach((image) => fireEvent.load(image));

      const initialFrames = screen.getAllByRole('img', { name: /C\d 实时灰度图/ });
      expect(initialFrames).toHaveLength(6);
      const initialSources = new Map(initialFrames.map((image) => [image.getAttribute('alt'), image.getAttribute('src')]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });

      const refreshPreloads = [...view.container.querySelectorAll<HTMLImageElement>(
        '.live-monitor-image-preload',
      )];
      expect(refreshPreloads).toHaveLength(2);
      expect(refreshPreloads.every((image) => (
        image.src.includes('region=valid') && image.src.includes('v=1')
      ))).toBe(true);
      expect(screen.getAllByRole('img', { name: /C\d 实时灰度图/ })).toHaveLength(6);

      refreshPreloads.forEach((image, index) => {
        if (index % 2 === 0) fireEvent.load(image);
        else fireEvent.error(image);
      });

      const settledFrames = screen.getAllByRole('img', { name: /C\d 实时灰度图/ });
      expect(settledFrames).toHaveLength(6);
      settledFrames.forEach((image, index) => {
        expect(image).toHaveAttribute('src', expect.stringContaining('region=valid'));
        if (index === 0) {
          expect(image).toHaveAttribute('src', expect.stringContaining('v=1'));
        } else {
          expect(image.getAttribute('src')).toBe(initialSources.get(image.getAttribute('alt')));
        }
      });
      expect(view.container.querySelectorAll('.live-monitor-grid-empty')).toHaveLength(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      const nextBatch = [...view.container.querySelectorAll<HTMLImageElement>(
        '.live-monitor-image-preload',
      )];
      expect(nextBatch).toHaveLength(3);
      expect(nextBatch.filter((image) => image.src.includes('192.168.103.100')).length).toBe(1);
      expect(nextBatch.filter((image) => image.src.includes('192.168.104.100')).length).toBe(1);

      view.rerender(<LiveMonitoringPage statuses={sixStatuses.map((status) => ({
        ...status,
        streamFrames: (status.streamFrames ?? 0) + 1,
      }))} />);
      expect(screen.getAllByRole('img', { name: /C\d 实时灰度图/ })).toHaveLength(6);
      expect(view.container.querySelectorAll('.live-monitor-grid-empty')).toHaveLength(0);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it('keeps the first-frame window quiet and then rotates grid refreshes in two-camera batches', () => {
    expect(Array.from({ length: 6 }, (_, index) => gridStreamRevision(5, index, 6))).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
    expect(Array.from({ length: 6 }, (_, index) => gridStreamRevision(6, index, 6))).toEqual([
      1, 1, 0, 0, 0, 0,
    ]);
    expect(Array.from({ length: 6 }, (_, index) => gridStreamRevision(7, index, 6))).toEqual([
      1, 1, 1, 1, 0, 0,
    ]);
    expect(Array.from({ length: 6 }, (_, index) => gridStreamRevision(8, index, 6))).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
    expect(Array.from({ length: 6 }, (_, index) => gridStreamRevision(9, index, 6))).toEqual([
      2, 2, 1, 1, 1, 1,
    ]);
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
      }), expect.anything());
      expect(captureMocks.start).toHaveBeenCalledWith(expect.objectContaining({
        ip: '192.168.102.206',
        dataMode: 3,
        fpsLimit: 2,
      }), expect.anything());
    });
    view.rerender(
      <LiveMonitoringPage
        statuses={statuses.map((status) => ({ ...status, streamRunning: true, streamFrames: 1 }))}
        health={health}
      />,
    );
    expect(screen.getByRole('img', { name: 'C1 实时灰度图' })).toHaveAttribute(
      'src',
      expect.stringMatching(/kind=intensity-grid.*region=valid/),
    );
    expect(screen.getByRole('img', { name: 'C2 实时灰度图' })).toHaveAttribute(
      'src',
      expect.stringMatching(/kind=intensity-grid.*region=valid/),
    );

    expect(screen.getByLabelText('六相机实时画面网格')).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByRole('button', { name: '放大 C2 实时画面' }));
    expect(captureMocks.start).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '深度图' }));
    expect(screen.getByRole('img', { name: 'C2 实时深度图' })).toHaveAttribute(
      'src',
      expect.stringMatching(/kind=depth.*region=valid/),
    );

    fireEvent.doubleClick(screen.getByRole('img', { name: 'C2 实时深度图' }));
    expect(screen.getByLabelText('六相机实时画面网格')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '暂停六相机实时播放' }));
    await waitFor(() => {
      expect(captureMocks.stop).toHaveBeenCalledWith('192.168.101.144', expect.anything());
      expect(captureMocks.stop).toHaveBeenCalledWith('192.168.102.206', expect.anything());
    });

    fireEvent.click(screen.getByRole('tab', { name: '回放' }));
    await waitFor(() => expect(captureMocks.history).toHaveBeenCalledWith(300));
    expect(screen.getByLabelText('历史六相机画面')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'C1 历史灰度图' })).toHaveAttribute(
      'src',
      expect.stringMatching(
        /path=1%2Fcapture%2FC1%2F2d%2F1\.png.*modality=gray.*level=thumbnail/,
      ),
    );
    expect(screen.getByRole('img', { name: 'C2 历史灰度图' })).toHaveAttribute(
      'src',
      expect.stringMatching(
        /path=1%2Fcapture%2FC2%2F2d%2F1\.png.*modality=gray.*level=thumbnail/,
      ),
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

  it('does not cancel a successful in-flight start or leak busy when topology polling changes', async () => {
    let resolveStart!: (value: { code: number; running: boolean; ip: string }) => void;
    captureMocks.start.mockImplementationOnce((_options, _signal) => new Promise((resolve) => {
      resolveStart = resolve;
    }));
    const initialStatus = statuses[0];
    const view = render(<LiveMonitoringPage statuses={[initialStatus]} />);

    await waitFor(() => expect(captureMocks.start).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: '暂停六相机实时播放' })).toBeDisabled();

    view.rerender(<LiveMonitoringPage statuses={[{
      ...initialStatus,
      streamRunning: true,
      streamFrames: 0,
    }]} />);
    await act(async () => {
      resolveStart({ code: 0, running: true, ip: initialStatus.ip });
      await Promise.resolve();
    });

    await waitFor(() => expect(
      screen.getByRole('button', { name: '暂停六相机实时播放' }),
    ).not.toBeDisabled());
    expect(captureMocks.stop).not.toHaveBeenCalled();
    view.unmount();
  });

  it('aborts an in-flight start when leaving realtime mode without an unhandled rejection', async () => {
    let observedSignal: AbortSignal | undefined;
    captureMocks.start.mockImplementationOnce((_options, signal) => new Promise((_resolve, reject) => {
      observedSignal = signal;
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const view = render(<LiveMonitoringPage statuses={[statuses[0]]} />);

    await waitFor(() => expect(observedSignal).toBeDefined());
    fireEvent.click(screen.getByRole('tab', { name: '回放' }));

    await waitFor(() => expect(observedSignal?.aborted).toBe(true));
    await waitFor(() => expect(screen.getByLabelText('历史六相机画面')).toBeInTheDocument());
    view.unmount();
  });

  it('best-effort stops an in-flight start when the monitor unmounts', async () => {
    let observedSignal: AbortSignal | undefined;
    captureMocks.start.mockImplementationOnce((_options, signal) => new Promise((_resolve, reject) => {
      observedSignal = signal;
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const view = render(<LiveMonitoringPage statuses={[statuses[0]]} />);

    await waitFor(() => expect(observedSignal).toBeDefined());
    view.unmount();

    expect(observedSignal?.aborted).toBe(true);
    await waitFor(() => expect(captureMocks.stop).toHaveBeenCalledWith(
      statuses[0].ip,
      expect.anything(),
    ));
  });

  it('keeps the other camera previews running when a focused camera is paused', async () => {
    render(<LiveMonitoringPage statuses={statuses} />);

    await waitFor(() => expect(captureMocks.start).toHaveBeenCalledTimes(2));
    fireEvent.doubleClick(screen.getByRole('button', { name: '放大 C2 实时画面' }));
    fireEvent.click(screen.getByRole('button', { name: '暂停相机实时播放' }));

    await waitFor(() => expect(captureMocks.stop).toHaveBeenCalledWith('192.168.102.206', expect.anything()));
    expect(captureMocks.stop).not.toHaveBeenCalledWith('192.168.101.144', expect.anything());
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
    await waitFor(() => expect(captureMocks.stop).toHaveBeenCalledWith('192.168.102.206', expect.anything()));
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
    }), expect.anything()));
    expect(captureMocks.start).toHaveBeenCalledTimes(1);
  });
});
