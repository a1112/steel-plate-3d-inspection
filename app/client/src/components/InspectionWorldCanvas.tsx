import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import { clampWorldScale, fitWorldScale, getVisibleWorldTiles } from '../lib/inspection-world';
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

type ViewState = { x: number; y: number; scale: number };
type TileEntry = { tile: WorldTile; image: HTMLImageElement; loaded: boolean };

const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 600;

function initialView(meta: InspectionWorldMeta, width: number, height: number): ViewState {
  const scale = fitWorldScale(meta.world.width, meta.world.height, width, height);
  return {
    x: (meta.world.width - width / scale) / 2,
    y: (meta.world.height - height / scale) / 2,
    scale,
  };
}

function lodForScale(scale: number, maxLevel: number) {
  return Math.max(0, Math.min(maxLevel, Math.round(Math.log2(1 / Math.max(scale, Number.EPSILON)))));
}

export function InspectionWorldCanvas({ recordId, meta, defects, focusDefectId, className = '' }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tileCache = useRef(new Map<string, TileEntry>());
  const pending = useRef(new Set<string>());
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const previousRecord = useRef(recordId);
  const [size, setSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const [view, setView] = useState(() => initialView(meta, DEFAULT_WIDTH, DEFAULT_HEIGHT));
  const [failedKeys, setFailedKeys] = useState<Set<string>>(new Set());
  const [, setRevision] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const bounds = host.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width || DEFAULT_WIDTH));
      const height = Math.max(1, Math.round(bounds.height || DEFAULT_HEIGHT));
      setSize({ width, height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (previousRecord.current === recordId) return;
    previousRecord.current = recordId;
    tileCache.current.forEach((entry) => entry.tile.revoke());
    tileCache.current.clear();
    pending.current.clear();
    setFailedKeys(new Set());
    setView(initialView(meta, size.width, size.height));
  }, [recordId, meta, size.height, size.width]);

  useEffect(() => () => {
    tileCache.current.forEach((entry) => entry.tile.revoke());
    tileCache.current.clear();
  }, []);

  const level = lodForScale(view.scale, meta.world.maxLevel);
  const visibleTiles = useMemo(() => getVisibleWorldTiles({
    worldWidth: meta.world.width,
    worldHeight: meta.world.height,
    tileSize: meta.world.tileSize,
    level,
    viewport: { x: view.x, y: view.y, width: size.width / view.scale, height: size.height / view.scale },
    prefetch: 1,
  }), [level, meta.world.height, meta.world.tileSize, meta.world.width, size.height, size.width, view.scale, view.x, view.y]);

  useEffect(() => {
    const controller = new AbortController();
    for (const tile of visibleTiles) {
      const key = `${recordId}:${tile.level}:${tile.x}:${tile.y}`;
      if (tileCache.current.has(key) || pending.current.has(key) || failedKeys.has(key)) continue;
      pending.current.add(key);
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
        .finally(() => pending.current.delete(key));
    }
    return () => controller.abort();
  }, [failedKeys, recordId, visibleTiles]);

  const locatableDefects = useMemo(
    () => defects.filter((defect) => defect.locatable && defect.worldRect),
    [defects],
  );

  useEffect(() => {
    if (focusDefectId == null) return;
    const defect = locatableDefects.find((item) => String(item.id) === String(focusDefectId));
    if (!defect?.worldRect) return;
    const targetScale = clampWorldScale(
      Math.min(size.width / (defect.worldRect.width + 80), size.height / (defect.worldRect.height + 80)),
      fitWorldScale(meta.world.width, meta.world.height, size.width, size.height),
      4,
    );
    setView({
      scale: targetScale,
      x: defect.worldRect.x + defect.worldRect.width / 2 - size.width / targetScale / 2,
      y: defect.worldRect.y + defect.worldRect.height / 2 - size.height / targetScale / 2,
    });
  }, [focusDefectId, locatableDefects, meta.world.height, meta.world.width, size.height, size.width]);

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
      const screenX = (tile.x * span - view.x) * view.scale;
      const screenY = (tile.y * span - view.y) * view.scale;
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
      const x = (camera.offsetX - view.x) * view.scale;
      context.fillRect(x, 0, 1, size.height);
    }
    context.strokeStyle = '#ffb020';
    context.lineWidth = 2;
    for (const defect of locatableDefects) {
      const rect = defect.worldRect!;
      context.strokeRect(
        (rect.x - view.x) * view.scale,
        (rect.y - view.y) * view.scale,
        Math.max(3, rect.width * view.scale),
        Math.max(3, rect.height * view.scale),
      );
    }
  }, [failedKeys, level, locatableDefects, meta.world.cameras, meta.world.tileSize, recordId, size.height, size.width, view.scale, view.x, view.y, visibleTiles]);

  const onWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const screenX = event.clientX - bounds.left;
    const screenY = event.clientY - bounds.top;
    const worldX = view.x + screenX / view.scale;
    const worldY = view.y + screenY / view.scale;
    const minimum = fitWorldScale(meta.world.width, meta.world.height, size.width, size.height);
    const scale = clampWorldScale(view.scale * Math.exp(-event.deltaY * 0.001), minimum, 8);
    setView({ x: worldX - screenX / scale, y: worldY - screenY / scale, scale });
  };

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
    setView((value) => ({ ...value, x: value.x - dx / value.scale, y: value.y - dy / value.scale }));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  return <div ref={hostRef} className={`inspection-world-viewport ${className}`.trim()}>
    <canvas
      ref={canvasRef}
      width={size.width}
      height={size.height}
      role="img"
      aria-label={`${recordId} 检测图像世界`}
      data-testid="inspection-world-canvas"
      data-level={level}
      data-view-x={view.x.toFixed(3)}
      data-view-y={view.y.toFixed(3)}
      data-locatable-defects={locatableDefects.length}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
    <div className="inspection-world-camera-labels" aria-hidden="true">
      {meta.world.cameras.map((camera) => <span
        key={camera.cameraId}
        data-testid="inspection-world-camera"
        style={{ left: `${camera.offsetX / meta.world.width * 100}%`, width: `${camera.width / meta.world.width * 100}%` }}
      >C{camera.cameraId}</span>)}
    </div>
    <div className="inspection-world-tile-status" role="status">
      {failedKeys.size ? `${failedKeys.size} 个瓦片读取失败` : `LOD ${level} · ${visibleTiles.length} 个可见瓦片`}
    </div>
  </div>;
}
