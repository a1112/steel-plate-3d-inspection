import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, Suspense, startTransition, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchInspectionWorldTile, type InspectionWorldDefect, type InspectionWorldMeta } from '../services/inspection-world-api';
import { InspectionWorldCanvas } from './InspectionWorldCanvas';

vi.mock('../services/inspection-world-api', async () => {
  const actual = await vi.importActual<typeof import('../services/inspection-world-api')>('../services/inspection-world-api');
  return { ...actual, fetchInspectionWorldTile: vi.fn() };
});

const meta: InspectionWorldMeta = {
  schema: 'steel.inspection-world.meta.v1', provider: 'bkv', recordId: '1893700', sourceFrameCount: 126,
  world: {
    width: 600, height: 21504, tileSize: 512, maxLevel: 15,
    cameras: Array.from({ length: 6 }, (_, index) => ({
      cameraId: index + 1, offsetX: index * 100, width: 100, height: 21504,
      frameWidth: 100, frameHeight: 1024, frameNumbers: Array.from({ length: 21 }, (__, frame) => frame),
      orientation: { frameOrder: 'ascending', rotation: 0, flipX: false, flipY: false },
    })),
  },
};

const secondMeta: InspectionWorldMeta = {
  ...meta,
  recordId: '1893701',
  world: {
    ...meta.world,
    width: 800,
    cameras: meta.world.cameras.map((camera, index) => ({
      ...camera,
      offsetX: index * (800 / 6),
      width: 800 / 6,
      frameWidth: 800 / 6,
    })),
  },
};

const defects: InspectionWorldDefect[] = [
  { id: 2019096, className: '轧折', cameraId: 1, imageIndex: 12, locatable: true, worldRect: { x: 73, y: 13145, width: 10, height: 10 } },
  { id: 2, className: '不可定位', locatable: false, worldRect: null },
];

function inspectionViewport(canvas: HTMLElement) {
  const viewport = canvas.closest('.inspection-world-viewport');
  if (!(viewport instanceof HTMLDivElement)) throw new Error('inspection world viewport is missing');
  return viewport;
}

function installNativeScrollTo(viewport: HTMLDivElement) {
  viewport.scrollTo = ((optionsOrX: ScrollToOptions | number, y?: number) => {
    const options = typeof optionsOrX === 'number'
      ? { left: optionsOrX, top: y ?? viewport.scrollTop }
      : optionsOrX;
    if (options.left != null) viewport.scrollLeft = options.left;
    if (options.top != null) viewport.scrollTop = options.top;
  }) as typeof viewport.scrollTo;
}

describe('InspectionWorldCanvas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([], this); }
      unobserve() {}
      disconnect() {}
    });
    vi.mocked(fetchInspectionWorldTile).mockImplementation(async (_record, tile) => ({ ...tile, url: `blob:${tile.level}-${tile.x}-${tile.y}`, revoke: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(),
      save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requests only visible tiles and exposes configured camera boundaries', async () => {
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    expect(screen.getByRole('img', { name: '1893700 检测图像世界' })).toBeInTheDocument();
    expect(screen.getAllByTestId('inspection-world-camera')).toHaveLength(6);
    expect(screen.getByText('C1')).toBeInTheDocument();
    expect(screen.getByText('C6')).toBeInTheDocument();
    expect(screen.queryByText('C7')).not.toBeInTheDocument();
    expect(screen.getByTestId('inspection-world-canvas')).toHaveAttribute('data-locatable-defects', '1');
    await waitFor(() => expect(fetchInspectionWorldTile).toHaveBeenCalled());
    expect(vi.mocked(fetchInspectionWorldTile).mock.calls.length).toBeLessThan(126);
  });

  it('waits for the committed viewport measurement before selecting and fetching tiles', async () => {
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const viewport = screen.getByTestId('inspection-world-viewport');

    expect(fetchInspectionWorldTile).not.toHaveBeenCalled();

    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 256 },
    });
    await act(async () => resize?.([], {} as ResizeObserver));
    await waitFor(() => expect(fetchInspectionWorldTile).toHaveBeenCalled());

    expect(vi.mocked(fetchInspectionWorldTile).mock.calls.map(([, tile]) => ({
      level: tile.level, x: tile.x, y: tile.y,
    }))).toEqual([
      { level: 1, x: 0, y: 0 },
      { level: 1, x: 0, y: 1 },
    ]);
  });

  it('opens at the first frame with all cameras filling the viewport width', async () => {
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    expect(canvas).toHaveAttribute('data-view-x', '0.000');
    expect(canvas).toHaveAttribute('data-view-y', '0.000');
    expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(1000 / 600, 3);
    const firstCamera = screen.getByText('C1');
    expect(firstCamera).toHaveStyle({ left: '0px' });
    expect(Number.parseFloat(firstCamera.style.width)).toBeCloseTo(1000 / 6, 6);
    await waitFor(() => expect(fetchInspectionWorldTile).toHaveBeenCalled());
  });

  it('uses a native scroll viewport with a scaled lightweight world spacer', async () => {
    vi.mocked(fetchInspectionWorldTile).mockImplementation(() => new Promise(() => undefined));
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    await waitFor(() => expect(fetchInspectionWorldTile).toHaveBeenCalled());

    expect(screen.getByTestId('inspection-world-viewport')).toHaveAttribute('data-scroll-mode', 'native');
    expect(screen.getByTestId('inspection-world-viewport')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('inspection-world-viewport')).toHaveAccessibleName('1893700 检测图像滚动视图');
    expect(screen.getByTestId('inspection-world-scroll-space')).toHaveStyle({
      width: '1000px',
      height: '35840px',
    });
  });

  it('leaves a plain wheel event to native scrolling without changing scale', async () => {
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    const initialScale = canvas.getAttribute('data-view-scale');
    const wheel = new WheelEvent('wheel', {
      deltaY: 120,
      bubbles: true,
      cancelable: true,
    });

    await act(async () => {
      canvas.dispatchEvent(wheel);
    });

    expect(wheel.defaultPrevented).toBe(false);
    expect(canvas).toHaveAttribute('data-view-scale', initialScale);
  });

  it('zooms only with Ctrl+wheel and preserves the pointer anchor through native scroll offsets', async () => {
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    const viewport = inspectionViewport(canvas);
    installNativeScrollTo(viewport);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 120, top: 80, right: 1120, bottom: 680,
      x: 120, y: 80, width: 1000, height: 600,
      toJSON: () => undefined,
    });
    const initialScale = Number(canvas.getAttribute('data-view-scale'));
    const wheel = new WheelEvent('wheel', {
      deltaY: -400,
      ctrlKey: true,
      clientX: 620,
      clientY: 380,
      bubbles: true,
      cancelable: true,
    });

    await act(async () => {
      canvas.dispatchEvent(wheel);
    });

    expect(wheel.defaultPrevented).toBe(true);
    await waitFor(() => expect(Number(canvas.getAttribute('data-view-scale'))).not.toBe(initialScale));
    const nextScale = Number(canvas.getAttribute('data-view-scale'));
    expect(viewport.scrollLeft).toBeCloseTo(500 * (nextScale / initialScale - 1), 3);
    expect(viewport.scrollTop).toBeCloseTo(300 * (nextScale / initialScale - 1), 3);
  });

  it('chains rapid Ctrl+wheel events from the pending anchored scroll position', async () => {
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    const viewport = inspectionViewport(canvas);
    installNativeScrollTo(viewport);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 1000, bottom: 600,
      x: 0, y: 0, width: 1000, height: 600,
      toJSON: () => undefined,
    });
    const initialScale = Number(canvas.getAttribute('data-view-scale'));

    await act(async () => {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -100, ctrlKey: true, clientX: 500, clientY: 300,
        bubbles: true, cancelable: true,
      }));
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -100, ctrlKey: true, clientX: 500, clientY: 300,
        bubbles: true, cancelable: true,
      }));
    });

    const finalScale = Number(canvas.getAttribute('data-view-scale'));
    expect(finalScale).toBeCloseTo(initialScale * Math.exp(0.2), 5);
    expect(viewport.scrollLeft).toBeCloseTo(500 * (finalScale / initialScale - 1), 3);
    expect(viewport.scrollTop).toBeCloseTo(300 * (finalScale / initialScale - 1), 3);
  });

  it('applies one Ctrl+wheel anchor exactly once when StrictMode replays state updates', async () => {
    render(<StrictMode><InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} /></StrictMode>);
    const canvas = screen.getByTestId('inspection-world-canvas');
    const viewport = inspectionViewport(canvas);
    installNativeScrollTo(viewport);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 1000, bottom: 600,
      x: 0, y: 0, width: 1000, height: 600,
      toJSON: () => undefined,
    });
    const initialScale = Number(canvas.getAttribute('data-view-scale'));

    await act(async () => {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -100, ctrlKey: true, clientX: 500, clientY: 300,
        bubbles: true, cancelable: true,
      }));
    });

    const finalScale = Number(canvas.getAttribute('data-view-scale'));
    expect(finalScale).toBeCloseTo(initialScale * Math.exp(0.1), 5);
    expect(viewport.scrollLeft).toBeCloseTo(500 * (finalScale / initialScale - 1), 3);
    expect(viewport.scrollTop).toBeCloseTo(300 * (finalScale / initialScale - 1), 3);
  });

  it('retains a queued anchor when a later batched Ctrl+wheel event is clamped at maximum', async () => {
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    const viewport = inspectionViewport(canvas);
    installNativeScrollTo(viewport);
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 1000, bottom: 600,
      x: 0, y: 0, width: 1000, height: 600,
      toJSON: () => undefined,
    });
    const initialScale = Number(canvas.getAttribute('data-view-scale'));

    await act(async () => {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -10_000, ctrlKey: true, clientX: 500, clientY: 300,
        bubbles: true, cancelable: true,
      }));
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -100, ctrlKey: true, clientX: 500, clientY: 300,
        bubbles: true, cancelable: true,
      }));
    });

    expect(Number(canvas.getAttribute('data-view-scale'))).toBe(8);
    expect(viewport.scrollLeft).toBeCloseTo(500 * (8 / initialScale - 1), 3);
    expect(viewport.scrollTop).toBeCloseTo(300 * (8 / initialScale - 1), 3);
  });

  it('virtualizes tile requests from coalesced native scroll position', async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    const viewport = inspectionViewport(canvas);
    await waitFor(() => expect(fetchInspectionWorldTile).toHaveBeenCalled());
    const initialMaximumTileY = Math.max(...vi.mocked(fetchInspectionWorldTile).mock.calls.map(([, tile]) => tile.y));
    vi.mocked(fetchInspectionWorldTile).mockClear();

    viewport.scrollTop = 1_000;
    fireEvent.scroll(viewport);
    viewport.scrollTop = 6_000;
    fireEvent.scroll(viewport);
    viewport.scrollTop = 12_000;
    fireEvent.scroll(viewport);
    expect(animationFrames).toHaveLength(1);
    await act(async () => {
      animationFrames.splice(0).forEach((callback) => callback(0));
    });

    await waitFor(() => expect(canvas).toHaveAttribute('data-view-y', '7200.000'));
    await waitFor(() => expect(fetchInspectionWorldTile).toHaveBeenCalled());
    const laterTileYs = vi.mocked(fetchInspectionWorldTile).mock.calls.map(([, tile]) => tile.y);
    expect(Math.min(...laterTileYs)).toBeGreaterThan(initialMaximumTileY);
    expect(laterTileYs.length).toBeLessThan(30);
  });

  it('keeps overlapping pending tiles while aborting only requests that leave the active ring', async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    vi.mocked(fetchInspectionWorldTile).mockImplementation(() => new Promise(() => undefined));
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const viewport = screen.getByTestId('inspection-world-viewport');
    await waitFor(() => expect(fetchInspectionWorldTile).toHaveBeenCalled());

    const initialCalls = [...vi.mocked(fetchInspectionWorldTile).mock.calls];
    const retained = initialCalls.find(([, tile]) => tile.x === 0 && tile.y === 1);
    const departed = initialCalls.find(([, tile]) => tile.x === 0 && tile.y === 0);
    expect(retained).toBeDefined();
    expect(departed).toBeDefined();

    viewport.scrollTop = 2_400;
    fireEvent.scroll(viewport);
    await act(async () => {
      animationFrames.splice(0).forEach((callback) => callback(0));
    });
    await waitFor(() => expect(canvasTileCalls(0, 4)).toBeGreaterThan(0));

    expect(retained?.[2]?.aborted).toBe(false);
    expect(departed?.[2]?.aborted).toBe(true);
    expect(canvasTileCalls(0, 1)).toBe(1);
  });

  it('does not publish tile keys from a concurrent render that is discarded by Suspense', async () => {
    class LoadedImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', LoadedImage);
    const resolveTiles: Array<() => void> = [];
    vi.mocked(fetchInspectionWorldTile).mockImplementation((_record, tile) => new Promise((resolve) => {
      resolveTiles.push(() => resolve({ ...tile, url: `blob:${tile.level}-${tile.x}-${tile.y}`, revoke: vi.fn() }));
    }));
    const suspendedForever = new Promise<never>(() => undefined);
    let setDiscarded: ((value: boolean) => void) | undefined;
    function SuspendForever(): never { throw suspendedForever; }
    function ConcurrentHarness() {
      const [discarded, setDiscardedState] = useState(false);
      setDiscarded = setDiscardedState;
      return <Suspense fallback={<div>loading discarded world</div>}>
        <InspectionWorldCanvas
          recordId={discarded ? 'discarded-record' : '1893700'}
          meta={discarded ? { ...meta, recordId: 'discarded-record' } : meta}
          defects={defects}
        />
        {discarded ? <SuspendForever /> : null}
      </Suspense>;
    }
    render(<ConcurrentHarness />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    await waitFor(() => expect(resolveTiles.length).toBeGreaterThan(0));
    const initialRequestCount = vi.mocked(fetchInspectionWorldTile).mock.calls.length;

    act(() => {
      startTransition(() => setDiscarded?.(true));
    });
    expect(canvas).toHaveAccessibleName('1893700 检测图像世界');
    expect(fetchInspectionWorldTile).toHaveBeenCalledTimes(initialRequestCount);

    await act(async () => {
      resolveTiles.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
    });

    await waitFor(() => expect(Number(canvas.getAttribute('data-loaded-tiles'))).toBeGreaterThan(0));
  });

  it('ignores a delayed tile rejection after that tile leaves the committed active ring', async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    class NonSignalingAbortController {
      signal = { aborted: false } as AbortSignal;
      abort() {}
    }
    vi.stubGlobal('AbortController', NonSignalingAbortController);
    const rejectTiles = new Map<string, (error: Error) => void>();
    vi.mocked(fetchInspectionWorldTile).mockImplementation((_record, tile) => new Promise((_resolve, reject) => {
      rejectTiles.set(`${tile.x}:${tile.y}`, reject);
    }));
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const viewport = screen.getByTestId('inspection-world-viewport');
    await waitFor(() => expect(rejectTiles.has('0:0')).toBe(true));

    viewport.scrollTop = 2_400;
    fireEvent.scroll(viewport);
    await act(async () => {
      animationFrames.splice(0).forEach((callback) => callback(0));
    });
    await waitFor(() => expect(rejectTiles.has('0:4')).toBe(true));

    await act(async () => {
      rejectTiles.get('0:0')?.(new Error('late departed failure'));
      await Promise.resolve();
    });

    expect(screen.getByRole('status')).not.toHaveTextContent('瓦片读取失败');
  });

  it('restores native scroll and fit-width scale when switching records', async () => {
    const { rerender } = render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    const viewport = inspectionViewport(canvas);
    installNativeScrollTo(viewport);
    viewport.scrollLeft = 160;
    viewport.scrollTop = 1200;
    fireEvent.scroll(viewport);
    await act(async () => {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -400,
        ctrlKey: true,
        clientX: 500,
        clientY: 300,
        bubbles: true,
        cancelable: true,
      }));
    });
    await waitFor(() => expect(Number(canvas.getAttribute('data-view-scale'))).not.toBeCloseTo(1000 / 600, 3));

    rerender(<InspectionWorldCanvas recordId="1893701" meta={secondMeta} defects={defects} />);

    await waitFor(() => expect(viewport.scrollLeft).toBe(0));
    expect(viewport.scrollTop).toBe(0);
    expect(canvas).toHaveAttribute('data-view-y', '0.000');
    expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(1000 / 800, 3);
    expect(screen.getByTestId('inspection-world-scroll-space')).toHaveStyle({
      width: '1000px',
      height: '26880px',
    });
  });

  it('does not zoom out below fit-width scale', async () => {
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    const viewport = inspectionViewport(canvas);
    installNativeScrollTo(viewport);
    const fitWidthScale = 1000 / 600;

    await act(async () => {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 10_000,
        ctrlKey: true,
        clientX: 500,
        clientY: 300,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(fitWidthScale, 6);
    expect(screen.getByTestId('inspection-world-scroll-space')).toHaveStyle({ width: '1000px' });
  });

  it('uses literal fit-width for narrow worlds on initial view and record reset', async () => {
    const narrowMeta: InspectionWorldMeta = {
      ...meta,
      recordId: 'narrow-100',
      world: { ...meta.world, width: 100 },
    };
    const narrowerMeta: InspectionWorldMeta = {
      ...narrowMeta,
      recordId: 'narrow-50',
      world: { ...narrowMeta.world, width: 50 },
    };
    const { rerender } = render(<InspectionWorldCanvas
      recordId="narrow-100"
      meta={narrowMeta}
      defects={[]}
    />);
    const canvas = screen.getByTestId('inspection-world-canvas');

    await waitFor(() => expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(10, 6));
    canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 10_000, ctrlKey: true, clientX: 500, clientY: 300,
      bubbles: true, cancelable: true,
    }));
    expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(10, 6);

    rerender(<InspectionWorldCanvas recordId="narrow-50" meta={narrowerMeta} defects={[]} />);
    await waitFor(() => expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(20, 6));
    expect(screen.getByTestId('inspection-world-scroll-space')).toHaveStyle({ width: '1000px' });
  });

  it('recomputes fit-width on resize until the user zooms, then preserves user zoom', async () => {
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    const viewport = inspectionViewport(canvas);
    installNativeScrollTo(viewport);

    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 1_200 });
    await act(async () => resize?.([], {} as ResizeObserver));
    await waitFor(() => expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(2, 6));

    await act(async () => {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -200, ctrlKey: true, clientX: 500, clientY: 300,
        bubbles: true, cancelable: true,
      }));
    });
    const userScale = Number(canvas.getAttribute('data-view-scale'));
    expect(userScale).toBeGreaterThan(2);

    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 800 });
    await act(async () => resize?.([], {} as ResizeObserver));
    expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(userScale, 6);
  });

  it('keeps large-defect focus at or above fit-width scale', async () => {
    const narrowMeta: InspectionWorldMeta = {
      ...meta,
      world: { ...meta.world, width: 100 },
    };
    const largeDefect: InspectionWorldDefect = {
      id: 'large', className: '大型区域', cameraId: 1, imageIndex: 0, locatable: true,
      worldRect: { x: 0, y: 500, width: 100, height: 20_000 },
    };
    render(<InspectionWorldCanvas
      recordId="1893700"
      meta={narrowMeta}
      defects={[largeDefect]}
      focusDefectId="large"
    />);

    await waitFor(() => expect(Number(screen.getByTestId('inspection-world-canvas')
      .getAttribute('data-view-scale'))).toBeCloseTo(10, 6));
    expect(screen.getByTestId('inspection-world-scroll-space')).toHaveStyle({ width: '1000px' });
  });

  it('draws a tile after its blob image finishes loading', async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(), fillRect: vi.fn(), drawImage, strokeRect: vi.fn(), fillText: vi.fn(),
      save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    class LoadedImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', LoadedImage);

    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    await waitFor(() => expect(fetchInspectionWorldTile).toHaveBeenCalled());
    await waitFor(() => expect(drawImage).toHaveBeenCalled());
    expect(Number(screen.getByTestId('inspection-world-canvas').getAttribute('data-loaded-tiles'))).toBeGreaterThan(0);
  });

  it('restarts tiles cancelled by the StrictMode effect cleanup', async () => {
    class LoadedImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', LoadedImage);
    vi.mocked(fetchInspectionWorldTile).mockImplementation((_record, tile, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ...tile, url: `blob:${tile.level}-${tile.x}-${tile.y}`, revoke: vi.fn() }), 10);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }));

    render(<StrictMode><InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} /></StrictMode>);

    await waitFor(() => expect(Number(screen.getByTestId('inspection-world-canvas').getAttribute('data-loaded-tiles'))).toBeGreaterThan(0));
  });

  it('changes LOD on Ctrl+wheel zoom and pans with pointer dragging', async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    const viewport = inspectionViewport(canvas);
    installNativeScrollTo(viewport);
    await waitFor(() => expect(fetchInspectionWorldTile).toHaveBeenCalled());
    const initialScale = canvas.getAttribute('data-view-scale');

    fireEvent.wheel(canvas, { deltaY: -500, ctrlKey: true, clientX: 500, clientY: 300 });
    await waitFor(() => expect(canvas.getAttribute('data-view-scale')).not.toBe(initialScale));
    await act(async () => {
      animationFrames.splice(0).forEach((callback) => callback(0));
    });
    const initialX = canvas.getAttribute('data-view-x');
    const initialScrollLeft = viewport.scrollLeft;
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 500, clientY: 300 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 450, clientY: 300 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 450, clientY: 300 });
    expect(viewport.scrollLeft).not.toBe(initialScrollLeft);
    animationFrames.splice(0);
    fireEvent.scroll(viewport);
    expect(animationFrames).toHaveLength(1);
    await act(async () => {
      animationFrames.splice(0).forEach((callback) => callback(0));
    });
    await waitFor(() => expect(canvas.getAttribute('data-view-x')).not.toBe(initialX));
  });

  it('revokes tiles that leave the prefetched viewport', async () => {
    const revoke = vi.fn();
    class LoadedImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', LoadedImage);
    vi.mocked(fetchInspectionWorldTile).mockImplementation(async (_record, tile) => ({
      ...tile, url: `blob:${tile.level}-${tile.x}-${tile.y}`, revoke,
    }));
    const { rerender } = render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    await waitFor(() => expect(Number(canvas.getAttribute('data-cached-tiles'))).toBeGreaterThan(0));

    rerender(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} focusDefectId={2019096} />);

    await waitFor(() => expect(revoke).toHaveBeenCalled());
    expect(Number(canvas.getAttribute('data-cached-tiles'))).toBeLessThan(30);
  });

  it('detaches late image callbacks and refreshes cache count on eviction and unmount', async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    });
    const images: DelayedImage[] = [];
    class DelayedImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { images.push(this); }
    }
    vi.stubGlobal('Image', DelayedImage);
    const revoke = vi.fn();
    let requests = 0;
    vi.mocked(fetchInspectionWorldTile).mockImplementation(async (_record, tile) => {
      requests += 1;
      if (requests > 4) return new Promise(() => undefined);
      return { ...tile, url: `blob:${tile.level}-${tile.x}-${tile.y}`, revoke };
    });
    const { unmount } = render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    const viewport = inspectionViewport(canvas);
    await waitFor(() => expect(Number(canvas.getAttribute('data-cached-tiles'))).toBe(4));
    const departedImage = images[0];
    const lateDepartedError = departedImage.onerror;

    viewport.scrollTop = 2_400;
    fireEvent.scroll(viewport);
    await act(async () => {
      animationFrames.splice(0).forEach((callback) => callback(0));
    });

    await waitFor(() => expect(revoke).toHaveBeenCalled());
    await waitFor(() => expect(Number(canvas.getAttribute('data-cached-tiles'))).toBe(2));
    expect(departedImage.onload).toBeNull();
    expect(departedImage.onerror).toBeNull();
    act(() => lateDepartedError?.());
    expect(screen.getByRole('status')).not.toHaveTextContent('瓦片读取失败');

    const retainedImage = images.find((image) => image.onerror != null);
    const lateRetainedError = retainedImage?.onerror;
    unmount();
    expect(retainedImage?.onload).toBeNull();
    expect(retainedImage?.onerror).toBeNull();
    expect(() => lateRetainedError?.()).not.toThrow();
  });

  it('draws defect overlays only near the current world viewport', async () => {
    const strokeRect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), strokeRect, fillText: vi.fn(),
      save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.mocked(fetchInspectionWorldTile).mockImplementation(() => new Promise(() => undefined));
    const visibleDefect: InspectionWorldDefect = {
      id: 'visible', className: '可见', locatable: true,
      worldRect: { x: 50, y: 100, width: 10, height: 10 },
    };
    const farDefects: InspectionWorldDefect[] = Array.from({ length: 100 }, (_, index) => ({
      id: `far-${index}`, className: '远处', locatable: true,
      worldRect: { x: 50, y: 2_000 + index * 100, width: 10, height: 10 },
    }));

    render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={[visibleDefect, ...farDefects]} />);
    await waitFor(() => expect(strokeRect).toHaveBeenCalled());

    expect(strokeRect).toHaveBeenCalledTimes(1);
    expect(strokeRect.mock.calls[0][1]).toBeGreaterThanOrEqual(-32);
    expect(strokeRect.mock.calls[0][1]).toBeLessThanOrEqual(632);
  });

  it('focuses a locatable defect and reports a failed tile without shifting the world', async () => {
    vi.mocked(fetchInspectionWorldTile).mockImplementation(async (_record, tile) => {
      if (tile.y === 0) throw new Error('missing tile');
      return { ...tile, url: `blob:${tile.level}-${tile.x}-${tile.y}`, revoke: vi.fn() };
    });
    const { rerender } = render(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/\d+ 个瓦片读取失败/));
    const canvas = screen.getByTestId('inspection-world-canvas');
    const initialY = canvas.getAttribute('data-view-y');
    rerender(<InspectionWorldCanvas recordId="1893700" meta={meta} defects={defects} focusDefectId={2019096} />);
    await waitFor(() => expect(canvas.getAttribute('data-view-y')).not.toBe(initialY));
  });

  it('scrolls to a second same-sized defect even when the focus zoom is unchanged', async () => {
    const sameSizedDefects: InspectionWorldDefect[] = [
      { id: 'first', className: '第一处', cameraId: 1, imageIndex: 2, locatable: true, worldRect: { x: 20, y: 2_000, width: 10, height: 10 } },
      { id: 'second', className: '第二处', cameraId: 2, imageIndex: 8, locatable: true, worldRect: { x: 140, y: 8_000, width: 10, height: 10 } },
    ];
    const { rerender } = render(
      <InspectionWorldCanvas recordId="1893700" meta={meta} defects={sameSizedDefects} />,
    );
    const viewport = screen.getByTestId('inspection-world-viewport');

    rerender(<InspectionWorldCanvas
      recordId="1893700"
      meta={meta}
      defects={sameSizedDefects}
      focusDefectId="first"
    />);
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));
    const firstScrollTop = viewport.scrollTop;
    const firstScale = screen.getByTestId('inspection-world-canvas').getAttribute('data-view-scale');

    rerender(<InspectionWorldCanvas
      recordId="1893700"
      meta={meta}
      defects={sameSizedDefects}
      focusDefectId="second"
    />);

    await waitFor(() => expect(viewport.scrollTop).not.toBe(firstScrollTop));
    expect(screen.getByTestId('inspection-world-canvas')).toHaveAttribute('data-view-scale', firstScale);
  });

  it('recomputes the active defect focus after measuring and resizing the viewport', async () => {
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    const focusedDefect: InspectionWorldDefect = {
      id: 'measured-focus', className: '测量聚焦', locatable: true,
      worldRect: { x: 100, y: 1_000, width: 400, height: 200 },
    };
    render(<InspectionWorldCanvas
      recordId="1893700"
      meta={meta}
      defects={[focusedDefect]}
      focusDefectId="measured-focus"
    />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    const viewport = inspectionViewport(canvas);

    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 1_200 },
      clientHeight: { configurable: true, value: 400 },
    });
    await act(async () => resize?.([], {} as ResizeObserver));

    await waitFor(() => expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(2, 6));
    expect(viewport.scrollLeft).toBeCloseTo(0, 6);
    expect(viewport.scrollTop).toBeCloseTo(2_000, 6);

    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 900 },
    });
    await act(async () => resize?.([], {} as ResizeObserver));

    await waitFor(() => expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(1.875, 6));
    expect(viewport.scrollLeft).toBeCloseTo(112.5, 6);
    expect(viewport.scrollTop).toBeCloseTo(1_612.5, 6);
  });

  it('does not refocus when polling supplies a fresh but equivalent defects array', async () => {
    const { rerender } = render(<InspectionWorldCanvas
      recordId="1893700"
      meta={meta}
      defects={defects}
      focusDefectId={2019096}
    />);
    const canvas = screen.getByTestId('inspection-world-canvas');
    const viewport = inspectionViewport(canvas);
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(1_000));

    viewport.scrollTop = 1_000;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(canvas).toHaveAttribute('data-view-y', '250.000'));
    const equivalentDefects = defects.map((defect) => ({
      ...defect,
      worldRect: defect.worldRect ? { ...defect.worldRect } : null,
    }));

    rerender(<InspectionWorldCanvas
      recordId="1893700"
      meta={meta}
      defects={equivalentDefects}
      focusDefectId={2019096}
    />);
    await act(async () => Promise.resolve());

    expect(viewport.scrollTop).toBe(1_000);
    expect(canvas).toHaveAttribute('data-view-y', '250.000');
  });
});

function canvasTileCalls(x: number, y: number) {
  return vi.mocked(fetchInspectionWorldTile).mock.calls
    .filter(([, tile]) => tile.x === x && tile.y === y).length;
}
