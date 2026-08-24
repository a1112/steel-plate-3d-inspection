import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
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
  type WorldRect,
  type WorldTile,
} from '../services/inspection-world-api';

type Props = {
  recordId: string;
  meta: InspectionWorldMeta;
  defects: InspectionWorldDefect[];
  focusDefectId?: string | number | null;
  selectedDefectId?: string | number | null;
  focusDefectRevision?: number;
  focusCameraId?: number | null;
  focusPositionRatio?: number | null;
  className?: string;
  onFirstPaint?: () => void;
  onFirstScreenReady?: () => void;
  onTileLoadingChange?: (state: InspectionWorldTileLoading) => void;
  suspendLoading?: boolean;
  onVisibleRangeChange?: (range: [number, number] | null) => void;
  onDefectClick?: (defectId: string | number) => void;
  colorMode?: 'gray' | 'jet';
};

export type InspectionWorldTileLoading = {
  recordId: string;
  level: number;
  tileSize: number;
  firstScreenTiles: number;
  loadedFirstScreenTiles: number;
  visibleTiles: number;
  loadedVisibleTiles: number;
  loadCandidates: number;
  pendingTiles: number;
  activeRequests: number;
  activeRequestBytes: number;
  pendingRequestBytes: number;
  failedTiles: number;
  ready: boolean;
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
const TILE_REQUEST_CONCURRENCY = 8;

function tileEntryBytes(entry: TileEntry) {
  const width = entry.image.naturalWidth || entry.image.width || 128;
  const height = entry.image.naturalHeight || entry.image.height || 128;
  return width * height * 4 * (entry.jetCanvas ? 2 : 1);
}

function fitWidthScale(worldWidth: number, viewportWidth: number) {
  return viewportWidth / Math.max(1, worldWidth);
}

function initialView(worldWidth: number, width: number): ViewState {
  const scale = fitWidthScale(worldWidth, width);
  return { scrollLeft: 0, scrollTop: 0, scale };
}

function disposeTileEntry(entry: TileEntry) {
  entry.image.onload = null;
  entry.image.onerror = null;
  entry.tile.revoke();
  entry.jetCanvas = null;
}

function finiteNumber(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function validWorldRect(value: unknown): WorldRect | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const x = finiteNumber(candidate.x);
  const y = finiteNumber(candidate.y);
  const width = finiteNumber(candidate.width);
  const height = finiteNumber(candidate.height);
  if (x == null || y == null || width == null || height == null || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function localRectFromArtifacts(artifacts: unknown): WorldRect | null {
  if (!artifacts || typeof artifacts !== 'object') return null;
  const values = artifacts as Record<string, unknown>;
  const imageRect = values.imageRect2d;
  if (imageRect && typeof imageRect === 'object') {
    const edges = imageRect as Record<string, unknown>;
    const left = finiteNumber(edges.left);
    const top = finiteNumber(edges.top);
    const right = finiteNumber(edges.right);
    const bottom = finiteNumber(edges.bottom);
    if (left != null && top != null && right != null && bottom != null
      && right > left && bottom > top) {
      return { x: left, y: top, width: right - left, height: bottom - top };
    }
  }
  const roi = values.roi;
  if (roi && typeof roi === 'object') {
    const rect = validWorldRect(roi);
    if (rect) return rect;
  }
  const nested = values.source;
  if (nested && typeof nested === 'object') {
    const nestedArtifacts = (nested as Record<string, unknown>).artifacts;
    const rect = localRectFromArtifacts(nestedArtifacts);
    if (rect) return rect;
  }
  return null;
}

function worldRectForDefect(defect: InspectionWorldDefect, meta: InspectionWorldMeta): WorldRect | null {
  const explicit = validWorldRect(defect.worldRect);
  if (explicit) return explicit;
  const local = localRectFromArtifacts(defect.trace?.artifacts);
  if (!local || defect.cameraId == null) return null;
  const camera = meta.world.cameras.find((item) => item.cameraId === defect.cameraId);
  if (!camera) return null;
  const frameIndex = finiteNumber(defect.imageIndex ?? defect.trace?.sequenceNo);
  if (frameIndex == null || !camera.frameNumbers.includes(frameIndex)) return null;
  const x = camera.offsetX + local.x;
  const y = frameIndex * camera.frameHeight + local.y - (camera.aligned ? (camera.headOffsetY ?? 0) : 0);
  const rect = { x, y, width: local.width, height: local.height };
  if (rect.x < camera.offsetX || rect.x + rect.width > camera.offsetX + camera.width
    || rect.y < 0 || rect.y + rect.height > meta.world.height) {
    return null;
  }
  return rect;
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
    const context = canvas.getContext('2d', { willReadFrequently: true });
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
  selectedDefectId,
  focusDefectRevision = 0,
  focusCameraId,
  focusPositionRatio,
  className = '',
  onFirstPaint,
  onFirstScreenReady,
  onTileLoadingChange,
  suspendLoading = false,
  onVisibleRangeChange,
  onDefectClick,
  colorMode = 'gray',
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tileCache = useRef(new Map<string, TileEntry>());
  const activeTileKeys = useRef(new Set<string>());
  const committedTileKeys = useRef(new Set<string>());
  const pending = useRef(new Map<string, PendingTileRequest>());
  const requestQueue = useRef(new TileRequestQueue<WorldTile>(TILE_REQUEST_CONCURRENCY, 400));
  const cacheClock = useRef(0);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const pendingScroll = useRef<{ scrollLeft: number; scrollTop: number } | null>(null);
  const fitWidthMode = useRef(true);
  const rangeFollowing = useRef(false);
  const consumedFocusRequest = useRef<string | null>(null);
  const lifecycleGeneration = useRef(0);
  const onFirstPaintRef = useRef(onFirstPaint);
  const onFirstScreenReadyRef = useRef(onFirstScreenReady);
  const onTileLoadingChangeRef = useRef(onTileLoadingChange);
  const firstPaintReported = useRef(false);
  const firstScreenReadyReported = useRef(false);
  const lastLoadingSignature = useRef<string | null>(null);
  const measured = useRef(false);
  const [size, setSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const [viewportMeasured, setViewportMeasured] = useState(false);
  const [isolatedCameraId, setIsolatedCameraId] = useState<number | null>(null);
  const displayCameras = useMemo(() => {
    if (isolatedCameraId == null) return meta.world.cameras;
    const selected = meta.world.cameras.find((camera) => camera.cameraId === isolatedCameraId);
    return selected ? [{ ...selected, offsetX: 0 }] : meta.world.cameras;
  }, [isolatedCameraId, meta.world.cameras]);
  const displayWorldWidth = isolatedCameraId == null
    ? meta.world.width
    : displayCameras[0]?.width ?? meta.world.width;
  const displayWorldWidthRef = useRef(displayWorldWidth);
  displayWorldWidthRef.current = displayWorldWidth;
  const [view, setView] = useState(() => initialView(meta.world.width, DEFAULT_WIDTH));
  const [level, setLevel] = useState(() => (
    lodForScaleWithHysteresis(view.scale, meta.world.maxLevel)
  ));
  const interactionView = useRef(view);
  const [failedKeys, setFailedKeys] = useState<Set<string>>(new Set());
  const [revision, setRevision] = useState(0);
  const [loadingRevision, setLoadingRevision] = useState(0);
  const [focusScrollRevision, setFocusScrollRevision] = useState(0);
  const worldRevision = useMemo(
    () => `${recordId}:${meta.sourceRevision}:${meta.sourceFrameCount}:${isolatedCameraId ?? 'all'}:${JSON.stringify(meta.world)}`,
    [isolatedCameraId, meta.sourceFrameCount, meta.sourceRevision, meta.world, recordId],
  );
  const previousWorldRevision = useRef(worldRevision);

  useLayoutEffect(() => {
    onFirstPaintRef.current = onFirstPaint;
  }, [onFirstPaint]);

  useLayoutEffect(() => {
    onFirstScreenReadyRef.current = onFirstScreenReady;
    onTileLoadingChangeRef.current = onTileLoadingChange;
  }, [onFirstScreenReady, onTileLoadingChange]);

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
        const nextView = initialView(displayWorldWidthRef.current, width);
        interactionView.current = nextView;
        setView(nextView);
      } else if (fitWidthMode.current) {
        const current = interactionView.current;
        const scale = fitWidthScale(displayWorldWidthRef.current, width);
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
    firstScreenReadyReported.current = false;
    lastLoadingSignature.current = null;
    tileCache.current.forEach(disposeTileEntry);
    tileCache.current.clear();
    requestQueue.current.cancelAll();
    pending.current.clear();
    pendingScroll.current = null;
    drag.current = null;
    fitWidthMode.current = true;
    rangeFollowing.current = false;
    onVisibleRangeChange?.(null);
    setFailedKeys(new Set());
    const nextView = initialView(displayWorldWidth, size.width);
    interactionView.current = nextView;
    setView(nextView);
    const host = hostRef.current;
    if (host) {
      host.scrollLeft = 0;
      host.scrollTop = 0;
      scheduleScrollRead();
    }
  }, [displayWorldWidth, meta, onVisibleRangeChange, scheduleScrollRead, size.height, size.width, worldRevision]);

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
    () => scaledWorldExtent(displayWorldWidth, meta.world.height, view.scale, size.width, size.height),
    [displayWorldWidth, meta.world.height, size.height, size.width, view.scale],
  );
  const extent = useMemo(() => ({
    width: baseExtent.width,
    height: Math.max(size.height, meta.world.height * view.scale + WORLD_TOP_GUTTER_PX),
  }), [baseExtent.width, meta.world.height, size.height, view.scale]);
  const visibleTiles = useMemo(() => {
    if (!viewportMeasured) return [];
    return getVisibleCameraTiles({
      cameras: displayCameras,
      tileSize: meta.world.tileSize,
      level,
      viewport: { x: viewX, y: visibleWorldY, width: size.width / view.scale, height: size.height / view.scale },
      prefetch: 1,
    });
  }, [displayCameras, level, meta.world.tileSize, size.height, size.width, view.scale, viewX, viewportMeasured, visibleWorldY]);
  const directlyVisibleTiles = useMemo(() => {
    if (!viewportMeasured) return [];
    return getVisibleCameraTiles({
      cameras: displayCameras,
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
  }, [displayCameras, level, meta.world.tileSize, size.height, size.width, view.scale, viewX, viewportMeasured, visibleWorldY]);
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
    () => new Map(displayCameras.map((camera) => [camera.cameraId, camera])),
    [displayCameras],
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
    if (!suspendLoading) return;
    requestQueue.current.cancelAll();
    pending.current.clear();
    setLoadingRevision((value) => value + 1);
  }, [suspendLoading]);

  useEffect(() => {
    if (!failedKeys.size) return;
    const retry = window.setTimeout(() => setFailedKeys(new Set()), 5000);
    return () => window.clearTimeout(retry);
  }, [failedKeys]);

  useEffect(() => {
    if (suspendLoading) return;
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
    let queued = false;
    for (const tile of prioritizedCandidates) {
      const key = `${recordId}:${tile.cameraId}:${tile.level}:${tile.x}:${tile.y}`;
      if (tileCache.current.has(key) || pending.current.has(key) || failedKeys.has(key)) continue;
      queued = true;
      const requestToken = Symbol(key);
      pending.current.set(key, { token: requestToken });
      const priority = directlyVisibleTileKeys.has(key)
        ? 0
        : visibleTileKeys.has(key) ? 1 : 2;
      requestQueue.current.enqueue({
        key,
        scope: worldRevision,
        priority,
        // Budget decoded RGBA memory, which is the meaningful browser-side
        // pressure rather than the usually much smaller JPEG transfer size.
        estimatedBytes: meta.world.tileSize * meta.world.tileSize * 4,
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
          setLoadingRevision((value) => value + 1);
        });
    }
    if (queued) setLoadingRevision((value) => value + 1);
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
    suspendLoading,
    visibleTileKeys,
    worldRevision,
  ]);

  const locatableDefects = useMemo(() => {
    const selectedSourceCamera = isolatedCameraId == null
      ? null
      : meta.world.cameras.find((camera) => camera.cameraId === isolatedCameraId);
    return defects
      .map((defect) => {
        const worldRect = worldRectForDefect(defect, meta);
        if (!worldRect || (isolatedCameraId != null && defect.cameraId !== isolatedCameraId)) {
          return null;
        }
        return {
          ...defect,
          worldRect,
        };
      })
      .filter((defect): defect is InspectionWorldDefect & { worldRect: WorldRect } => defect != null)
      .map((defect) => (
        selectedSourceCamera
          ? {
            ...defect,
            worldRect: {
              ...defect.worldRect,
              x: defect.worldRect.x - selectedSourceCamera.offsetX,
            },
          }
          : defect
      ));
  }, [defects, isolatedCameraId, meta]);
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
  const loadedFirstScreenTileCount = directlyVisibleTiles.filter((tile) => tileCache.current
    .get(`${recordId}:${tile.cameraId}:${tile.level}:${tile.x}:${tile.y}`)?.loaded).length;
  const pendingTileCount = [...pending.current.keys()].filter((key) => loadCandidateKeys.has(key)).length;
  const firstScreenReady = viewportMeasured
    && (directlyVisibleTiles.length === 0 || loadedFirstScreenTileCount >= directlyVisibleTiles.length);

  useEffect(() => {
    if (!viewportMeasured) return;
    const queueTelemetry = requestQueue.current.telemetry();
    const loading: InspectionWorldTileLoading = {
      recordId,
      level,
      tileSize: meta.world.tileSize,
      firstScreenTiles: directlyVisibleTiles.length,
      loadedFirstScreenTiles: loadedFirstScreenTileCount,
      visibleTiles: visibleTiles.length,
      loadedVisibleTiles: loadedTileCount,
      loadCandidates: loadCandidates.length,
      pendingTiles: pendingTileCount,
      activeRequests: requestQueue.current.activeCount,
      activeRequestBytes: queueTelemetry.activeBytes,
      pendingRequestBytes: queueTelemetry.pendingBytes,
      failedTiles: failedKeys.size,
      ready: firstScreenReady,
    };
    const signature = [
      loading.level,
      loading.firstScreenTiles,
      loading.loadedFirstScreenTiles,
      loading.visibleTiles,
      loading.loadedVisibleTiles,
      loading.loadCandidates,
      loading.pendingTiles,
      loading.activeRequests,
      loading.activeRequestBytes,
      loading.pendingRequestBytes,
      loading.failedTiles,
      loading.ready,
    ].join(':');
    if (signature !== lastLoadingSignature.current) {
      lastLoadingSignature.current = signature;
      onTileLoadingChangeRef.current?.(loading);
    }
    if (firstScreenReady && !firstScreenReadyReported.current) {
      firstScreenReadyReported.current = true;
      onFirstScreenReadyRef.current?.();
    }
  }, [
    directlyVisibleTiles,
    failedKeys.size,
    firstScreenReady,
    level,
    loadingRevision,
    loadCandidates.length,
    loadedFirstScreenTileCount,
    loadedTileCount,
    meta.world.tileSize,
    pendingTileCount,
    recordId,
    revision,
    viewportMeasured,
    visibleTiles.length,
  ]);
  const focusedDefect = focusDefectId == null
    ? undefined
    : locatableDefects.find((item) => String(item.id) === String(focusDefectId));
  const focusedRect = focusedDefect?.worldRect;

  useEffect(() => {
    const hasLongitudinalFocus = focusPositionRatio != null && Number.isFinite(focusPositionRatio);
    if ((!focusedRect && !hasLongitudinalFocus) || !viewportMeasured) return;
    const requestKey = `${worldRevision}:${String(focusDefectId)}:${focusDefectRevision}:${focusCameraId ?? '-'}:${focusPositionRatio ?? '-'}`;
    if (consumedFocusRequest.current === requestKey) return;
    consumedFocusRequest.current = requestKey;
    const minimumScale = fitWidthScale(displayWorldWidth, size.width);
    const targetScale = focusedRect
      ? clampWorldScale(
        Math.min(size.width / (focusedRect.width + 80), size.height / (focusedRect.height + 80)),
        minimumScale,
        Math.max(4, minimumScale),
      )
      : Math.max(minimumScale, interactionView.current.scale);
    const focusCamera = focusCameraId == null
      ? null
      : displayCameras.find((camera) => camera.cameraId === focusCameraId);
    const focusX = focusedRect
      ? focusedRect.x + focusedRect.width / 2
      : focusCamera
        ? focusCamera.offsetX + focusCamera.width / 2
        : displayWorldWidth / 2;
    const focusY = focusedRect
      ? focusedRect.y + focusedRect.height / 2
      : Math.max(0, Math.min(1, Number(focusPositionRatio))) * meta.world.height;
    fitWidthMode.current = false;
    rangeFollowing.current = true;
    const targetScroll = {
      scrollLeft: Math.max(0, focusX * targetScale - size.width / 2),
      scrollTop: Math.max(0, focusY * targetScale + WORLD_TOP_GUTTER_PX - size.height / 2),
    };
    pendingScroll.current = targetScroll;
    interactionView.current = { ...interactionView.current, ...targetScroll, scale: targetScale };
    setView((current) => ({ ...current, ...targetScroll, scale: targetScale }));
    setFocusScrollRevision((current) => current + 1);
  }, [
    displayCameras,
    displayWorldWidth,
    focusDefectId,
    focusDefectRevision,
    focusCameraId,
    focusPositionRatio,
    focusedRect?.height,
    focusedRect?.width,
    focusedRect?.x,
    focusedRect?.y,
    meta.world.height,
    size.height,
    size.width,
    viewportMeasured,
    worldRevision,
  ]);

  useEffect(() => {
    if (!onVisibleRangeChange) return;
    if (!rangeFollowing.current) {
      onVisibleRangeChange(null);
      return;
    }
    const start = Math.max(0, Math.min(1, visibleWorldY / Math.max(1, meta.world.height)));
    const end = Math.max(
      start,
      Math.min(1, (visibleWorldY + size.height / view.scale) / Math.max(1, meta.world.height)),
    );
    onVisibleRangeChange(end - start >= 0.995 ? null : [start, end]);
  }, [meta.world.height, onVisibleRangeChange, size.height, view.scale, visibleWorldY]);

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
    for (const camera of displayCameras) {
      const x = camera.offsetX * view.scale - view.scrollLeft;
      context.fillRect(x, dividerTop, 1, Math.max(0, size.height - dividerTop));
    }
    context.lineWidth = 2;
    for (const defect of visibleDefects) {
      const rect = defect.worldRect!;
      const selected = String(defect.id) === String(selectedDefectId ?? focusDefectId ?? '');
      const screenX = rect.x * view.scale - view.scrollLeft;
      const screenY = rect.y * view.scale + WORLD_TOP_GUTTER_PX - view.scrollTop;
      const screenWidth = Math.max(3, rect.width * view.scale);
      const screenHeight = Math.max(3, rect.height * view.scale);
      context.fillStyle = selected ? 'rgba(255, 70, 104, .22)' : 'rgba(255, 176, 32, .12)';
      context.fillRect(screenX, screenY, screenWidth, screenHeight);
      context.strokeStyle = selected ? '#ff4668' : '#ffb020';
      context.lineWidth = selected ? 3 : 2;
      context.strokeRect(screenX, screenY, screenWidth, screenHeight);
    }
    if (paintedTile && !firstPaintReported.current) {
      firstPaintReported.current = true;
      onFirstPaintRef.current?.();
    }
  }, [cameraById, colorMode, displayCameras, failedKeys, focusDefectId, level, meta.world.tileSize, recordId, revision, selectedDefectId, size.height, size.width, view.scale, view.scrollLeft, view.scrollTop, viewportMeasured, visibleDefects, visibleTiles]);

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
      const minimum = fitWidthScale(displayWorldWidth, size.width);
      const scale = clampWorldScale(
        current.scale * Math.exp(-event.deltaY * 0.001),
        minimum,
        Math.max(8, minimum),
      );
      if (scale === current.scale) return;
      fitWidthMode.current = false;
      rangeFollowing.current = true;
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
  }, [displayWorldWidth, meta.world.height, size.height, size.width]);

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
  const handleDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (isolatedCameraId != null) {
      setIsolatedCameraId(null);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const worldX = (event.clientX - bounds.left + view.scrollLeft) / view.scale;
    const camera = meta.world.cameras.find((item) => (
      worldX >= item.offsetX && worldX <= item.offsetX + item.width
    ));
    if (camera) setIsolatedCameraId(camera.cameraId);
  };
  const visiblePixelStart = Math.round(Number.isFinite(visibleWorldY) ? visibleWorldY : 0);
  const visiblePixelEnd = Math.round(Math.min(
    meta.world.height,
    (Number.isFinite(visibleWorldY) ? visibleWorldY : 0) + size.height / view.scale,
  ));

  return <div
    ref={hostRef}
    className={`inspection-world-viewport color-mode-${colorMode} ${className}`.trim()}
    data-testid="inspection-world-viewport"
    data-record-id={recordId}
    data-scroll-mode="native"
    data-top-gutter={WORLD_TOP_GUTTER_PX}
    data-color-mode={colorMode}
    data-isolated-camera={isolatedCameraId == null ? 'all' : isolatedCameraId}
    tabIndex={0}
    aria-label={`${recordId} 检测图像滚动视图`}
    onScroll={() => {
      rangeFollowing.current = true;
      scheduleScrollRead();
    }}
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
          data-first-screen-tiles={directlyVisibleTiles.length}
          data-loaded-first-screen-tiles={loadedFirstScreenTileCount}
          data-pending-tiles={pendingTileCount}
          data-active-requests={requestQueue.current.activeCount}
          data-load-candidates={loadCandidates.length}
          data-max-concurrent={TILE_REQUEST_CONCURRENCY}
          data-first-screen-ready={firstScreenReady ? 'true' : 'false'}
          data-cached-tiles={tileCache.current.size}
          data-visible-pixel-start={visiblePixelStart}
          data-visible-pixel-end={visiblePixelEnd}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={handleDoubleClick}
        />
        <div
          className="inspection-world-defect-overlay-layer"
          data-testid="inspection-world-defect-overlays"
          data-visible-defects={visibleDefects.length}
          aria-label="检测缺陷框标注"
        >
          {visibleDefects.map((defect) => {
            const rect = defect.worldRect!;
            const selected = String(defect.id) === String(selectedDefectId ?? focusDefectId ?? '');
            const label = defect.className || `缺陷 ${defect.id}`;
            return <button
              key={String(defect.id)}
              type="button"
              className={`inspection-world-defect-box${selected ? ' is-selected' : ''}`}
              data-testid="inspection-world-defect-box"
              data-defect-id={String(defect.id)}
              aria-label={`${label}，编号 ${defect.id}`}
              title={`${label} · ${defect.id}`}
              tabIndex={onDefectClick ? 0 : -1}
              style={{
                left: `${rect.x * view.scale - view.scrollLeft}px`,
                top: `${rect.y * view.scale + WORLD_TOP_GUTTER_PX - view.scrollTop}px`,
                width: `${Math.max(7, rect.width * view.scale)}px`,
                height: `${Math.max(7, rect.height * view.scale)}px`,
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onDefectClick?.(defect.id);
              }}
            >
              <span>{label}</span>
            </button>;
          })}
        </div>
        <div className="inspection-world-camera-labels" aria-hidden="true">
          {displayCameras.map((camera) => {
            const cameraIndex = meta.world.cameras.findIndex((item) => item.cameraId === camera.cameraId);
            const angleStart = cameraIndex / Math.max(1, meta.world.cameras.length) * 360;
            const angleEnd = (cameraIndex + 1) / Math.max(1, meta.world.cameras.length) * 360;
            return <span
              key={camera.cameraId}
              data-testid="inspection-world-camera"
              style={{ left: `${camera.offsetX * view.scale - view.scrollLeft}px`, width: `${camera.width * view.scale}px` }}
            >C{camera.cameraId}<small>{angleStart.toFixed(0)}°–{angleEnd.toFixed(0)}°</small></span>;
          })}
        </div>
        <div className="inspection-world-length-ruler" aria-label={`当前长度像素 ${visiblePixelStart} 至 ${visiblePixelEnd}`}>
          <span>{visiblePixelStart}px</span>
          <b>长度像素</b>
          <span>{visiblePixelEnd}px</span>
        </div>
        <div className="inspection-world-tile-status" role="status">
          {failedKeys.size
            ? `${failedKeys.size} 个瓦片读取失败`
            : firstScreenReady
              ? `首屏已就绪 · LOD ${level} · ${meta.world.tileSize}px · 首屏 ${directlyVisibleTiles.length} 块`
              : `正在加载首屏 ${loadedFirstScreenTileCount}/${directlyVisibleTiles.length} 块 · 并发 ${requestQueue.current.activeCount}/${TILE_REQUEST_CONCURRENCY} · 预取 ${Math.max(0, loadCandidates.length - directlyVisibleTiles.length)} 块`}
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
