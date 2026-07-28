import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  clampWorldScale,
  getVisibleCameraTiles,
  lodForScaleWithHysteresis,
  scaledWorldExtent,
  scrollPositionForZoom,
} from '../lib/inspection-world';
import { TileRequestQueue } from '../lib/tile-request-queue';
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
  focusDefectRevision?: number;
  className?: string;
  onFirstPaint?: () => void;
  colorMode?: 'gray' | 'jet';
};

type ViewState = { scrollLeft: number; scrollTop: number; scale: number };
type TileEntry = {
  tile: WorldTile;
  image: HTMLImageElement;
  loaded: boolean;
  lastUsed: number;
  jetCanvas?: HTMLCanvasElement | null;
};
type PendingTileRequest = { token: symbol };

const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 600;
const TILE_CACHE_BYTES = 64 * 1024 * 1024;
const WORLD_TOP_GUTTER_PX = 28;

function tileEntryBytes(entry: TileEntry) {
  const width = entry.image.naturalWidth || entry.image.width || 128;
  const height = entry.image.naturalHeight || entry.image.height || 128;
  return width * height * 4 * (entry.jetCanvas ? 2 : 1);
}

function fitWidthScale(worldWidth: number, viewportWidth: number) {
  return viewportWidth / Math.max(1, worldWidth);
}

function initialView(meta: InspectionWorldMeta, width: number): ViewState {
  const scale = fitWidthScale(meta.world.width, width);
  return { scrollLeft: 0, scrollTop: 0, scale };
}

function disposeTileEntry(entry: TileEntry) {
  entry.image.onload = null;
  entry.image.onerror = null;
  entry.tile.revoke();
  entry.jetCanvas = null;
}

function jetChannel(value: number, offset: number) {
  return Math.round(Math.max(0, Math.min(1, 1.5 - Math.abs(4 * value - offset))) * 255);
}

function jetTileSource(entry: TileEntry): CanvasImageSource {
  if (entry.jetCanvas) return entry.jetCanvas;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = entry.image.naturalWidth || entry.image.width;
    canvas.height = entry.image.naturalHeight || entry.image.height;
    const context = canvas.getContext('2d');
    if (!context || typeof context.getImageData !== 'function') return entry.image;
    context.drawImage(entry.image, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < image.data.length; index += 4) {
      const value = (
        image.data[index] * 0.2126
        + image.data[index + 1] * 0.7152
        + image.data[index + 2] * 0.0722
      ) / 255;
      image.data[index] = jetChannel(value, 3);
      image.data[index + 1] = jetChannel(value, 2);
      image.data[index + 2] = jetChannel(value, 1);
    }
    context.putImageData(image, 0, 0);
    entry.jetCanvas = canvas;
    return canvas;
  } catch {
    return entry.image;
  }
}

export function InspectionWorldCanvas({
  recordId,
  meta,
  defects,
  focusDefectId,
  focusDefectRevision = 0,
  className = '',
  onFirstPaint,
  colorMode = 'gray',
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tileCache = useRef(new Map<string, TileEntry>());
  const activeTileKeys = useRef(new Set<string>());
  const committedTileKeys = useRef(new Set<string>());
  const pending = useRef(new Map<string, PendingTileRequest>());
  const requestQueue = useRef(new TileRequestQueue<WorldTile>(6, 400));
  const cacheClock = useRef(0);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const pendingScroll = useRef<{ scrollLeft: number; scrollTop: number } | null>(null);
  const fitWidthMode = useRef(true);
  const consumedFocusRequest = useRef<string | null>(null);
  const lifecycleGeneration = useRef(0);
  const metaRef = useRef(meta);
  const onFirstPaintRef = useRef(onFirstPaint);
  const firstPaintReported = useRef(false);
  const measured = useRef(false);
  const [size, setSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const [viewportMeasured, setViewportMeasured] = useState(false);
  const [view, setView] = useState(() => initialView(meta, DEFAULT_WIDTH));
  const [level, setLevel] = useState(() => (
    lodForScaleWithHysteresis(view.scale, meta.world.maxLevel)
  ));
  const interactionView = useRef(view);
  const [failedKeys, setFailedKeys] = useState<Set<string>>(new Set());
  const [revision, setRevision] = useState(0);
  const [focusScrollRevision, setFocusScrollRevision] = useState(0);
  const worldRevision = useMemo(
    () => `${recordId}:${meta.sourceRevision}:${meta.sourceFrameCount}:${JSON.stringify(meta.world)}`,
    [meta.sourceFrameCount, meta.sourceRevision, meta.world, recordId],
  );
  const previousWorldRevision = useRef(worldRevision);

  useLayoutEffect(() => {
    metaRef.current = meta;
  }, [meta]);

  useLayoutEffect(() => {
    onFirstPaintRef.current = onFirstPaint;
  }, [onFirstPaint]);

  const scheduleScrollRead = useCallback(() => {
    if (scrollFrame.current != null) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null;
      const host = hostRef.current;
      if (!host) return;
      const scrollLeft = host.scrollLeft;
      const scrollTop = host.scrollTop;
      interactionView.current = {
        ...interactionView.current,
        scrollLeft,
        scrollTop,
      };
      setView((current) => {
        if (current.scrollLeft === scrollLeft && current.scrollTop === scrollTop) return current;
        return { ...current, scrollLeft, scrollTop };
      });
    });
  }, []);

  const evictInactiveTiles = useCallback(() => {
    let cacheBytes = [...tileCache.current.values()].reduce(
      (total, entry) => total + tileEntryBytes(entry),
      0,
    );
    if (cacheBytes <= TILE_CACHE_BYTES) return false;
    const currentCoverageReady = [...activeTileKeys.current].every(
      (key) => tileCache.current.get(key)?.loaded,
    );
    if (!currentCoverageReady) return false;
    const candidates = [...tileCache.current.entries()]
      .filter(([key]) => !activeTileKeys.current.has(key))
      .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
    let removed = false;
    for (const [key, entry] of candidates) {
      if (cacheBytes <= TILE_CACHE_BYTES) break;
      cacheBytes -= tileEntryBytes(entry);
      disposeTileEntry(entry);
      tileCache.current.delete(key);
      removed = true;
    }
    return removed;
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const hasResizeObserver = typeof ResizeObserver === 'function';
    const update = (allowFallback: boolean) => {
      const bounds = host.getBoundingClientRect();
      const measuredWidth = host.clientWidth || bounds.width;
      const measuredHeight = host.clientHeight || bounds.height;
      if (!allowFallback && (!measuredWidth || !measuredHeight)) return;
      const width = Math.max(1, Math.round(measuredWidth || DEFAULT_WIDTH));
      const height = Math.max(1, Math.round(measuredHeight || DEFAULT_HEIGHT));
      setSize({ width, height });
      if (!measured.current) {
        measured.current = true;
        const nextView = initialView(metaRef.current, width);
        interactionView.current = nextView;
        setView(nextView);
      } else if (fitWidthMode.current) {
        const current = interactionView.current;
        const scale = fitWidthScale(metaRef.current.world.width, width);
        if (scale !== current.scale) {
          const targetScroll = {
            scrollLeft: (current.scrollLeft / current.scale) * scale,
            scrollTop: (current.scrollTop / current.scale) * scale,
          };
          pendingScroll.current = targetScroll;
          interactionView.current = { ...current, ...targetScroll, scale };
          setView((state) => ({ ...state, ...targetScroll, scale }));
        }
      }
      setViewportMeasured(true);
    };
    update(!hasResizeObserver);
    if (!hasResizeObserver) return;
    const observer = new ResizeObserver(() => update(true));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (previousWorldRevision.current === worldRevision) return;
    previousWorldRevision.current = worldRevision;
    firstPaintReported.current = false;
    tileCache.current.forEach(disposeTileEntry);
    tileCache.current.clear();
    requestQueue.current.cancelAll();
    pending.current.clear();
    pendingScroll.current = null;
    drag.current = null;
    fitWidthMode.current = true;
    setFailedKeys(new Set());
    const nextView = initialView(meta, size.width);
    interactionView.current = nextView;
    setView(nextView);
    const host = hostRef.current;
    if (host) {
      host.scrollLeft = 0;
      host.scrollTop = 0;
      scheduleScrollRead();
    }
  }, [meta, scheduleScrollRead, size.height, size.width, worldRevision]);

  useEffect(() => {
    const generation = lifecycleGeneration.current + 1;
    lifecycleGeneration.current = generation;
    activeTileKeys.current = new Set(committedTileKeys.current);
    return () => {
      tileCache.current.forEach(disposeTileEntry);
      tileCache.current.clear();
      activeTileKeys.current.clear();
      if (scrollFrame.current != null) {
        window.cancelAnimationFrame(scrollFrame.current);
        scrollFrame.current = null;
      }
      queueMicrotask(() => {
        if (lifecycleGeneration.current !== generation) return;
        requestQueue.current.cancelAll();
        pending.current.clear();
      });
    };
  }, []);

  useLayoutEffect(() => {
    setLevel((current) => (
      lodForScaleWithHysteresis(view.scale, meta.world.maxLevel, current)
    ));
  }, [meta.world.maxLevel, view.scale]);

  const viewX = view.scrollLeft / view.scale;
  const viewY = view.scrollTop / view.scale;
  const visibleWorldY = Math.max(0, (view.scrollTop - WORLD_TOP_GUTTER_PX) / view.scale);
  const baseExtent = useMemo(
    () => scaledWorldExtent(meta.world.width, meta.world.height, view.scale, size.width, size.height),
    [meta.world.height, meta.world.width, size.height, size.width, view.scale],
  );
  const extent = useMemo(() => ({
    width: baseExtent.width,
    height: Math.max(size.height, meta.world.height * view.scale + WORLD_TOP_GUTTER_PX),
  }), [baseExtent.width, meta.world.height, size.height, view.scale]);
  const visibleTiles = useMemo(() => {
    if (!viewportMeasured) return [];
    return getVisibleCameraTiles({
      cameras: meta.world.cameras,
      tileSize: meta.world.tileSize,
      level,
      viewport: { x: viewX, y: visibleWorldY, width: size.width / view.scale, height: size.height / view.scale },
      prefetch: 1,
    });
  }, [level, meta.world.cameras, meta.world.tileSize, size.height, size.width, view.scale, viewX, viewportMeasured, visibleWorldY]);
  const directlyVisibleTiles = useMemo(() => {
    if (!viewportMeasured) return [];
    return getVisibleCameraTiles({
      cameras: meta.world.cameras,
      tileSize: meta.world.tileSize,
      level,
      viewport: {
        x: viewX,
        y: visibleWorldY,
        width: size.width / view.scale,
        height: size.height / view.scale,
      },
      prefetch: 0,
    });
  }, [level, meta.world.cameras, meta.world.tileSize, size.height, size.width, view.scale, viewX, viewportMeasured, visibleWorldY]);
  const loadCandidates = useMemo(() => {
    const candidates = [...visibleTiles];
    if (level < meta.world.maxLevel) {
      for (const tile of directlyVisibleTiles) {
        candidates.push({
          cameraId: tile.cameraId,
          level: level + 1,
          x: Math.floor(tile.x / 2),
          y: Math.floor(tile.y / 2),
        });
      }
    }
    return [...new Map(candidates.map((tile) => [
      `${tile.cameraId}:${tile.level}:${tile.x}:${tile.y}`,
      tile,
    ])).values()];
  }, [directlyVisibleTiles, level, meta.world.maxLevel, visibleTiles]);
  const visibleTileKeys = useMemo(
    () => new Set(visibleTiles.map((tile) => (
      `${recordId}:${tile.cameraId}:${tile.level}:${tile.x}:${tile.y}`
    ))),
    [recordId, visibleTiles],
  );
  const directlyVisibleTileKeys = useMemo(
    () => new Set(directlyVisibleTiles.map((tile) => (
      `${recordId}:${tile.cameraId}:${tile.level}:${tile.x}:${tile.y}`
    ))),
    [directlyVisibleTiles, recordId],
  );
  const loadCandidateKeys = useMemo(
    () => new Set(loadCandidates.map((tile) => (
      `${recordId}:${tile.cameraId}:${tile.level}:${tile.x}:${tile.y}`
    ))),
    [loadCandidates, recordId],
  );
  const cameraById = useMemo(
    () => new Map(meta.world.cameras.map((camera) => [camera.cameraId, camera])),
    [meta.world.cameras],
  );

  useLayoutEffect(() => {
    const committedKeys = new Set(loadCandidateKeys);
    committedTileKeys.current = committedKeys;
    activeTileKeys.current = new Set(committedKeys);
    committedKeys.forEach((key) => {
      const entry = tileCache.current.get(key);
      if (entry) entry.lastUsed = ++cacheClock.current;
    });
  }, [loadCandidateKeys]);

  useEffect(() => {
    const removedEntry = evictInactiveTiles();
    setFailedKeys((current) => {
      const retained = new Set([...current].filter((key) => visibleTileKeys.has(key)));
      return retained.size === current.size ? current : retained;
    });
    if (removedEntry) setRevision((value) => value + 1);
  }, [evictInactiveTiles, visibleTileKeys]);

  useEffect(() => {
    if (!failedKeys.size) return;
    const retry = window.setTimeout(() => setFailedKeys(new Set()), 5000);
    return () => window.clearTimeout(retry);
  }, [failedKeys]);

  useEffect(() => {
    pending.current.forEach((request, key) => {
      if (loadCandidateKeys.has(key)) return;
      requestQueue.current.cancel(key, false);
      pending.current.delete(key);
    });
    const prioritizedCandidates = [...loadCandidates].sort((left, right) => {
      const key = (tile: typeof left) => `${recordId}:${tile.cameraId}:${tile.level}:${tile.x}:${tile.y}`;
      const priority = (tile: typeof left) => {
        const candidate = key(tile);
        return directlyVisibleTileKeys.has(candidate)
          ? 0
          : visibleTileKeys.has(candidate) ? 1 : 2;
      };
      return priority(left) - priority(right);
    });
    for (const tile of prioritizedCandidates) {
      const key = `${recordId}:${tile.cameraId}:${tile.level}:${tile.x}:${tile.y}`;
      if (tileCache.current.has(key) || pending.current.has(key) || failedKeys.has(key)) continue;
      const requestToken = Symbol(key);
      pending.current.set(key, { token: requestToken });
      const priority = directlyVisibleTileKeys.has(key)
        ? 0
        : visibleTileKeys.has(key) ? 1 : 2;
      requestQueue.current.enqueue({
        key,
        scope: worldRevision,
        priority,
        run: (signal) => fetchInspectionWorldTile(
          recordId,
          { ...tile, revision: meta.sourceRevision, format: 'jpeg' },
          signal,
        ),
      })
        .then((worldTile) => {
          if (!activeTileKeys.current.has(key)) {
            worldTile.revoke();
            return;
          }
          const image = new Image();
          const entry: TileEntry = { tile: worldTile, image, loaded: false, lastUsed: ++cacheClock.current };
          image.onload = () => {
            if (tileCache.current.get(key) !== entry) return;
            entry.loaded = true;
            evictInactiveTiles();
            setRevision((value) => value + 1);
          };
          image.onerror = () => {
            if (tileCache.current.get(key) !== entry) return;
            tileCache.current.delete(key);
            disposeTileEntry(entry);
            if (activeTileKeys.current.has(key)) setFailedKeys((current) => new Set(current).add(key));
            setRevision((value) => value + 1);
          };
          tileCache.current.set(key, entry);
          image.src = worldTile.url;
          evictInactiveTiles();
          setRevision((value) => value + 1);
        })
        .catch((error: unknown) => {
          if (
            !(error instanceof DOMException && error.name === 'AbortError')
            && activeTileKeys.current.has(key)
          ) {
            setFailedKeys((current) => new Set(current).add(key));
          }
        })
        .finally(() => {
          if (pending.current.get(key)?.token === requestToken) pending.current.delete(key);
        });
    }
    // Lifecycle cleanup owns cancellation; this cleanup intentionally preserves
    // overlapping per-key requests while allowing StrictMode to replay setup.
    return () => undefined;
  }, [
    directlyVisibleTileKeys,
    failedKeys,
    loadCandidateKeys,
    loadCandidates,
    meta.sourceRevision,
    recordId,
    visibleTileKeys,
    worldRevision,
  ]);

  const locatableDefects = useMemo(
    () => defects.filter((defect) => defect.locatable && defect.worldRect),
    [defects],
  );
  const visibleDefects = useMemo(() => {
    const margin = 32 / view.scale;
    const left = viewX - margin;
    const top = visibleWorldY - margin;
    const right = viewX + size.width / view.scale + margin;
    const bottom = visibleWorldY + size.height / view.scale + margin;
    return locatableDefects.filter((defect) => {
      const rect = defect.worldRect!;
      return rect.x + rect.width >= left && rect.x <= right
        && rect.y + rect.height >= top && rect.y <= bottom;
    });
  }, [locatableDefects, size.height, size.width, view.scale, viewX, visibleWorldY]);
  const loadedTileCount = visibleTiles.filter((tile) => tileCache.current
    .get(`${recordId}:${tile.cameraId}:${tile.level}:${tile.x}:${tile.y}`)?.loaded).length;
  const focusedDefect = focusDefectId == null
    ? undefined
    : locatableDefects.find((item) => String(item.id) === String(focusDefectId));
  const focusedRect = focusedDefect?.worldRect;

  useEffect(() => {
    if (!focusedRect || !viewportMeasured) return;
    const requestKey = `${worldRevision}:${String(focusDefectId)}:${focusDefectRevision}`;
    if (consumedFocusRequest.current === requestKey) return;
    consumedFocusRequest.current = requestKey;
    const minimumScale = fitWidthScale(meta.world.width, size.width);
    const targetScale = clampWorldScale(
      Math.min(size.width / (focusedRect.width + 80), size.height / (focusedRect.height + 80)),
      minimumScale,
      Math.max(4, minimumScale),
    );
    fitWidthMode.current = false;
    const targetScroll = {
      scrollLeft: Math.max(0, (focusedRect.x + focusedRect.width / 2) * targetScale - size.width / 2),
      scrollTop: Math.max(0, (focusedRect.y + focusedRect.height / 2) * targetScale + WORLD_TOP_GUTTER_PX - size.height / 2),
    };
    pendingScroll.current = targetScroll;
    interactionView.current = { ...interactionView.current, ...targetScroll, scale: targetScale };
    setView((current) => ({ ...current, ...targetScroll, scale: targetScale }));
    setFocusScrollRevision((current) => current + 1);
  }, [
    focusDefectId,
    focusDefectRevision,
    focusedRect?.height,
    focusedRect?.width,
    focusedRect?.x,
    focusedRect?.y,
    viewportMeasured,
    worldRevision,
  ]);

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
    if (!viewportMeasured) return;
    context.clearRect(0, 0, size.width, size.height);
    context.fillStyle = '#07111c';
    context.fillRect(0, 0, size.width, size.height);
    let paintedTile = false;
    const span = meta.world.tileSize * 2 ** level;
    const fallbackEntries = [...tileCache.current.values()].filter((entry) => entry.loaded && entry.tile.level !== level);
    const fallbackLevelDistance = fallbackEntries.reduce(
      (nearest, entry) => Math.min(nearest, Math.abs(entry.tile.level - level)),
      Number.POSITIVE_INFINITY,
    );
    for (const entry of fallbackEntries) {
      if (Math.abs(entry.tile.level - level) !== fallbackLevelDistance) continue;
      const camera = cameraById.get(entry.tile.cameraId);
      if (!camera) continue;
      const fallbackSpan = meta.world.tileSize * 2 ** entry.tile.level;
      const screenX = (camera.offsetX + entry.tile.x * fallbackSpan) * view.scale - view.scrollLeft;
      const screenY = entry.tile.y * fallbackSpan * view.scale + WORLD_TOP_GUTTER_PX - view.scrollTop;
      const screenWidth = Math.min(fallbackSpan, camera.width - entry.tile.x * fallbackSpan) * view.scale;
      const screenHeight = Math.min(fallbackSpan, camera.height - entry.tile.y * fallbackSpan) * view.scale;
      if (screenX + screenWidth < 0 || screenX > size.width || screenY + screenHeight < 0 || screenY > size.height) continue;
      context.drawImage(
        colorMode === 'jet' ? jetTileSource(entry) : entry.image,
        screenX,
        screenY,
        screenWidth,
        screenHeight,
      );
      paintedTile = true;
    }
    for (const tile of visibleTiles) {
      const key = `${recordId}:${tile.cameraId}:${tile.level}:${tile.x}:${tile.y}`;
      const camera = cameraById.get(tile.cameraId);
      if (!camera) continue;
      const screenX = (camera.offsetX + tile.x * span) * view.scale - view.scrollLeft;
      const screenY = tile.y * span * view.scale + WORLD_TOP_GUTTER_PX - view.scrollTop;
      const screenWidth = Math.min(span, camera.width - tile.x * span) * view.scale;
      const screenHeight = Math.min(span, camera.height - tile.y * span) * view.scale;
      const entry = tileCache.current.get(key);
      if (entry?.loaded) {
        context.drawImage(
          colorMode === 'jet' ? jetTileSource(entry) : entry.image,
          screenX,
          screenY,
          screenWidth,
          screenHeight,
        );
        paintedTile = true;
      }
      else if (failedKeys.has(key)) {
        context.fillStyle = '#24181d';
        context.fillRect(screenX, screenY, screenWidth, screenHeight);
      }
    }
    context.fillStyle = 'rgba(0, 193, 255, .65)';
    const dividerTop = Math.max(0, WORLD_TOP_GUTTER_PX - view.scrollTop);
    for (const camera of meta.world.cameras) {
      const x = camera.offsetX * view.scale - view.scrollLeft;
      context.fillRect(x, dividerTop, 1, Math.max(0, size.height - dividerTop));
    }
    context.strokeStyle = '#ffb020';
    context.lineWidth = 2;
    for (const defect of visibleDefects) {
      const rect = defect.worldRect!;
      context.strokeRect(
        rect.x * view.scale - view.scrollLeft,
        rect.y * view.scale + WORLD_TOP_GUTTER_PX - view.scrollTop,
        Math.max(3, rect.width * view.scale),
        Math.max(3, rect.height * view.scale),
      );
    }
    if (paintedTile && !firstPaintReported.current) {
      firstPaintReported.current = true;
      onFirstPaintRef.current?.();
    }
  }, [cameraById, colorMode, failedKeys, level, meta.world.cameras, meta.world.tileSize, recordId, revision, size.height, size.width, view.scale, view.scrollLeft, view.scrollTop, viewportMeasured, visibleDefects, visibleTiles]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const bounds = canvas.getBoundingClientRect();
      const pointerX = event.clientX - bounds.left;
      const pointerY = event.clientY - bounds.top;
      const current = interactionView.current;
      const minimum = fitWidthScale(meta.world.width, size.width);
      const scale = clampWorldScale(
        current.scale * Math.exp(-event.deltaY * 0.001),
        minimum,
        Math.max(8, minimum),
      );
      if (scale === current.scale) return;
      fitWidthMode.current = false;
      const baseScroll = pendingScroll.current ?? {
        scrollLeft: hostRef.current?.scrollLeft ?? current.scrollLeft,
        scrollTop: hostRef.current?.scrollTop ?? current.scrollTop,
      };
      const targetScroll = scrollPositionForZoom({
        scrollLeft: baseScroll.scrollLeft,
        scrollTop: baseScroll.scrollTop,
        pointerX,
        pointerY,
        oldScale: current.scale,
        newScale: scale,
      });
      const pointerWorldY = Math.max(
        0,
        (baseScroll.scrollTop + pointerY - WORLD_TOP_GUTTER_PX) / current.scale,
      );
      targetScroll.scrollTop = Math.max(
        0,
        pointerWorldY * scale + WORLD_TOP_GUTTER_PX - pointerY,
      );
      pendingScroll.current = targetScroll;
      interactionView.current = { ...targetScroll, scale };
      setView((state) => ({ ...state, ...targetScroll, scale }));
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
    className={`inspection-world-viewport color-mode-${colorMode} ${className}`.trim()}
    data-testid="inspection-world-viewport"
    data-record-id={recordId}
    data-scroll-mode="native"
    data-top-gutter={WORLD_TOP_GUTTER_PX}
    data-color-mode={colorMode}
    tabIndex={0}
    aria-label={`${recordId} 检测图像滚动视图`}
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
          {failedKeys.size
            ? `${failedKeys.size} 个瓦片读取失败`
            : `LOD ${level} · ${meta.world.tileSize}px · ${visibleTiles.length} 个可见瓦片`}
        </div>
        {colorMode === 'jet' ? (
          <div className="inspection-world-jet-legend" aria-label="二维 Jet 灰度映射图例">
            <span>低灰度</span><i /><span>高灰度</span>
          </div>
        ) : null}
      </div>
    </div>
  </div>;
}
