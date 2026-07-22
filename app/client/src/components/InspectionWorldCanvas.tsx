import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  clampWorldScale,
  fitWorldScale,
  getVisibleWorldTiles,
  scaledWorldExtent,
  scrollPositionForZoom,
} from '../lib/inspection-world';
import {
  fetchInspectionWorldTile,
  type InspectionWorldDefect,
  type InspectionWorldMeta,
  type WorldTile,
} from '../services/inspection-world-api';

type Props = {
  recordId: string;
  meta: InspectionWorldMeta;
  defects: InspectionWorldDefect[];
  focusDefectId?: string | number | null;
  className?: string;
};

type ViewState = { scrollLeft: number; scrollTop: number; scale: number };
type TileEntry = { tile: WorldTile; image: HTMLImageElement; loaded: boolean };
type PendingTileRequest = { token: symbol; controller: AbortController };

const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 600;

function initialView(meta: InspectionWorldMeta, width: number, height: number): ViewState {
  const scale = Math.min(8, width / Math.max(1, meta.world.width));
  return { scrollLeft: 0, scrollTop: 0, scale };
}

function lodForScale(scale: number, maxLevel: number) {
  return Math.max(0, Math.min(maxLevel, Math.round(Math.log2(1 / Math.max(scale, Number.EPSILON)))));
}

export function InspectionWorldCanvas({ recordId, meta, defects, focusDefectId, className = '' }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tileCache = useRef(new Map<string, TileEntry>());
  const pending = useRef(new Map<string, PendingTileRequest>());
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const pendingScroll = useRef<{ scrollLeft: number; scrollTop: number } | null>(null);
  const measured = useRef(false);
  const [size, setSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const [view, setView] = useState(() => initialView(meta, DEFAULT_WIDTH, DEFAULT_HEIGHT));
  const [failedKeys, setFailedKeys] = useState<Set<string>>(new Set());
  const [revision, setRevision] = useState(0);
  const [focusScrollRevision, setFocusScrollRevision] = useState(0);
  const worldRevision = useMemo(
    () => `${recordId}:${meta.sourceFrameCount}:${JSON.stringify(meta.world)}`,
    [meta.sourceFrameCount, meta.world, recordId],
  );
  const previousWorldRevision = useRef(worldRevision);

  const scheduleScrollRead = useCallback(() => {
    if (scrollFrame.current != null) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null;
      const host = hostRef.current;
      if (!host) return;
      setView((current) => {
        if (current.scrollLeft === host.scrollLeft && current.scrollTop === host.scrollTop) return current;
        return { ...current, scrollLeft: host.scrollLeft, scrollTop: host.scrollTop };
      });
    });
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const bounds = host.getBoundingClientRect();
      const width = Math.max(1, Math.round(host.clientWidth || bounds.width || DEFAULT_WIDTH));
      const height = Math.max(1, Math.round(host.clientHeight || bounds.height || DEFAULT_HEIGHT));
      setSize({ width, height });
      if (!measured.current) {
        measured.current = true;
        setView(initialView(meta, width, height));
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (previousWorldRevision.current === worldRevision) return;
    previousWorldRevision.current = worldRevision;
    tileCache.current.forEach((entry) => entry.tile.revoke());
    tileCache.current.clear();
    pending.current.forEach((request) => request.controller.abort());
    pending.current.clear();
    pendingScroll.current = null;
    drag.current = null;
    setFailedKeys(new Set());
    setView(initialView(meta, size.width, size.height));
    const host = hostRef.current;
    if (host) {
      host.scrollLeft = 0;
      host.scrollTop = 0;
      scheduleScrollRead();
    }
  }, [meta, scheduleScrollRead, size.height, size.width, worldRevision]);

  useEffect(() => () => {
    tileCache.current.forEach((entry) => entry.tile.revoke());
    tileCache.current.clear();
    pending.current.forEach((request) => request.controller.abort());
    pending.current.clear();
    if (scrollFrame.current != null) {
      window.cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    }
  }, []);

  const level = lodForScale(view.scale, meta.world.maxLevel);
  const viewX = view.scrollLeft / view.scale;
  const viewY = view.scrollTop / view.scale;
  const extent = useMemo(
    () => scaledWorldExtent(meta.world.width, meta.world.height, view.scale, size.width, size.height),
    [meta.world.height, meta.world.width, size.height, size.width, view.scale],
  );
  const visibleTiles = useMemo(() => getVisibleWorldTiles({
    worldWidth: meta.world.width,
    worldHeight: meta.world.height,
    tileSize: meta.world.tileSize,
    level,
    viewport: { x: viewX, y: viewY, width: size.width / view.scale, height: size.height / view.scale },
    prefetch: 1,
  }), [level, meta.world.height, meta.world.tileSize, meta.world.width, size.height, size.width, view.scale, viewX, viewY]);

  useEffect(() => {
    const visibleKeys = new Set(visibleTiles.map((tile) => `${recordId}:${tile.level}:${tile.x}:${tile.y}`));
    tileCache.current.forEach((entry, key) => {
      if (visibleKeys.has(key)) return;
      entry.tile.revoke();
      tileCache.current.delete(key);
    });
    setFailedKeys((current) => {
      const retained = new Set([...current].filter((key) => visibleKeys.has(key)));
      return retained.size === current.size ? current : retained;
    });
  }, [recordId, visibleTiles]);

  useEffect(() => {
    if (!failedKeys.size) return;
    const retry = window.setTimeout(() => setFailedKeys(new Set()), 5000);
    return () => window.clearTimeout(retry);
  }, [failedKeys]);

  useEffect(() => {
    const activeKeys = new Set(visibleTiles.map((tile) => `${recordId}:${tile.level}:${tile.x}:${tile.y}`));
    pending.current.forEach((request, key) => {
      if (activeKeys.has(key)) return;
      request.controller.abort();
      pending.current.delete(key);
    });
    for (const tile of visibleTiles) {
      const key = `${recordId}:${tile.level}:${tile.x}:${tile.y}`;
      if (tileCache.current.has(key) || pending.current.has(key) || failedKeys.has(key)) continue;
      const controller = new AbortController();
      const requestToken = Symbol(key);
      pending.current.set(key, { token: requestToken, controller });
      fetchInspectionWorldTile(recordId, { ...tile, format: 'jpeg' }, controller.signal)
        .then((worldTile) => {
          if (controller.signal.aborted) {
            worldTile.revoke();
            return;
          }
          const image = new Image();
          const entry: TileEntry = { tile: worldTile, image, loaded: false };
          image.onload = () => {
            entry.loaded = true;
            setRevision((value) => value + 1);
          };
          image.onerror = () => {
            if (tileCache.current.get(key) === entry) {
              tileCache.current.delete(key);
              worldTile.revoke();
            }
            setFailedKeys((current) => new Set(current).add(key));
            setRevision((value) => value + 1);
          };
          image.src = worldTile.url;
          tileCache.current.set(key, entry);
          setRevision((value) => value + 1);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailedKeys((current) => new Set(current).add(key));
        })
        .finally(() => {
          if (pending.current.get(key)?.token === requestToken) pending.current.delete(key);
        });
    }
  }, [failedKeys, recordId, visibleTiles]);

  const locatableDefects = useMemo(
    () => defects.filter((defect) => defect.locatable && defect.worldRect),
    [defects],
  );
  const loadedTileCount = visibleTiles.filter((tile) => tileCache.current
    .get(`${recordId}:${tile.level}:${tile.x}:${tile.y}`)?.loaded).length;

  useEffect(() => {
    if (focusDefectId == null) return;
    const defect = locatableDefects.find((item) => String(item.id) === String(focusDefectId));
    if (!defect?.worldRect) return;
    const targetScale = clampWorldScale(
      Math.min(size.width / (defect.worldRect.width + 80), size.height / (defect.worldRect.height + 80)),
      fitWorldScale(meta.world.width, meta.world.height, size.width, size.height),
      4,
    );
    pendingScroll.current = {
      scrollLeft: Math.max(0, (defect.worldRect.x + defect.worldRect.width / 2) * targetScale - size.width / 2),
      scrollTop: Math.max(0, (defect.worldRect.y + defect.worldRect.height / 2) * targetScale - size.height / 2),
    };
    setView((current) => ({ ...current, scale: targetScale }));
    setFocusScrollRevision((current) => current + 1);
  }, [focusDefectId, locatableDefects, meta.world.height, meta.world.width, size.height, size.width]);

  useLayoutEffect(() => {
    const target = pendingScroll.current;
    const host = hostRef.current;
    if (!target || !host) return;
    pendingScroll.current = null;
    host.scrollLeft = target.scrollLeft;
    host.scrollTop = target.scrollTop;
    scheduleScrollRead();
  }, [focusScrollRevision, scheduleScrollRead, view.scale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, size.width, size.height);
    context.fillStyle = '#07111c';
    context.fillRect(0, 0, size.width, size.height);
    const span = meta.world.tileSize * 2 ** level;
    for (const tile of visibleTiles) {
      const key = `${recordId}:${tile.level}:${tile.x}:${tile.y}`;
      const screenX = tile.x * span * view.scale - view.scrollLeft;
      const screenY = tile.y * span * view.scale - view.scrollTop;
      const screenSize = span * view.scale;
      const entry = tileCache.current.get(key);
      if (entry?.loaded) context.drawImage(entry.image, screenX, screenY, screenSize, screenSize);
      else if (failedKeys.has(key)) {
        context.fillStyle = '#24181d';
        context.fillRect(screenX, screenY, screenSize, screenSize);
      }
    }
    context.fillStyle = 'rgba(0, 193, 255, .65)';
    for (const camera of meta.world.cameras) {
      const x = camera.offsetX * view.scale - view.scrollLeft;
      context.fillRect(x, 0, 1, size.height);
    }
    context.strokeStyle = '#ffb020';
    context.lineWidth = 2;
    for (const defect of locatableDefects) {
      const rect = defect.worldRect!;
      context.strokeRect(
        rect.x * view.scale - view.scrollLeft,
        rect.y * view.scale - view.scrollTop,
        Math.max(3, rect.width * view.scale),
        Math.max(3, rect.height * view.scale),
      );
    }
  }, [failedKeys, level, locatableDefects, meta.world.cameras, meta.world.tileSize, recordId, revision, size.height, size.width, view.scale, view.scrollLeft, view.scrollTop, visibleTiles]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const bounds = canvas.getBoundingClientRect();
      const pointerX = event.clientX - bounds.left;
      const pointerY = event.clientY - bounds.top;
      setView((current) => {
        const minimum = Math.min(8, size.width / Math.max(1, meta.world.width));
        const scale = clampWorldScale(current.scale * Math.exp(-event.deltaY * 0.001), minimum, 8);
        if (scale === current.scale) {
          pendingScroll.current = null;
          return current;
        }
        pendingScroll.current = scrollPositionForZoom({
          scrollLeft: hostRef.current?.scrollLeft ?? current.scrollLeft,
          scrollTop: hostRef.current?.scrollTop ?? current.scrollTop,
          pointerX,
          pointerY,
          oldScale: current.scale,
          newScale: scale,
        });
        return { ...current, scale };
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [meta.world.height, meta.world.width, size.height, size.width]);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    drag.current = { pointerId: current.pointerId, x: event.clientX, y: event.clientY };
    const host = hostRef.current;
    if (!host) return;
    host.scrollLeft -= dx;
    host.scrollTop -= dy;
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  return <div
    ref={hostRef}
    className={`inspection-world-viewport ${className}`.trim()}
    data-testid="inspection-world-viewport"
    data-scroll-mode="native"
    onScroll={scheduleScrollRead}
  >
    <div
      className="inspection-world-scroll-space"
      data-testid="inspection-world-scroll-space"
      style={{ width: extent.width, height: extent.height }}
    >
      <div className="inspection-world-stage" style={{ width: size.width, height: size.height }}>
        <canvas
          ref={canvasRef}
          width={size.width}
          height={size.height}
          role="img"
          aria-label={`${recordId} 检测图像世界`}
          data-testid="inspection-world-canvas"
          data-level={level}
          data-view-x={viewX.toFixed(3)}
          data-view-y={viewY.toFixed(3)}
          data-view-scale={view.scale.toFixed(6)}
          data-locatable-defects={locatableDefects.length}
          data-loaded-tiles={loadedTileCount}
          data-cached-tiles={tileCache.current.size}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <div className="inspection-world-camera-labels" aria-hidden="true">
          {meta.world.cameras.map((camera) => <span
            key={camera.cameraId}
            data-testid="inspection-world-camera"
            style={{ left: `${camera.offsetX * view.scale - view.scrollLeft}px`, width: `${camera.width * view.scale}px` }}
          >C{camera.cameraId}</span>)}
        </div>
        <div className="inspection-world-tile-status" role="status">
          {failedKeys.size ? `${failedKeys.size} 个瓦片读取失败` : `LOD ${level} · ${visibleTiles.length} 个可见瓦片`}
        </div>
      </div>
    </div>
  </div>;
}
