import type { WorldRect } from '../services/inspection-world-api';

export type WorldViewTransform = { x: number; y: number; scale: number };
export type WorldViewport = { x: number; y: number; width: number; height: number };
export type VisibleWorldTile = { level: number; x: number; y: number };

function finiteNonnegative(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function scaledWorldExtent(
  worldWidth: number,
  worldHeight: number,
  scale: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  const safeScale = finiteNonnegative(scale);
  const scaledWidth = finiteNonnegative(finiteNonnegative(worldWidth) * safeScale);
  const scaledHeight = finiteNonnegative(finiteNonnegative(worldHeight) * safeScale);
  return {
    width: Math.max(finiteNonnegative(viewportWidth), scaledWidth),
    height: Math.max(finiteNonnegative(viewportHeight), scaledHeight),
  };
}

export function scrollPositionForZoom(input: {
  scrollLeft: number;
  scrollTop: number;
  pointerX: number;
  pointerY: number;
  oldScale: number;
  newScale: number;
}) {
  const scrollLeft = finiteNonnegative(input.scrollLeft);
  const scrollTop = finiteNonnegative(input.scrollTop);
  const pointerX = finiteNonnegative(input.pointerX);
  const pointerY = finiteNonnegative(input.pointerY);
  const oldScale = Number.isFinite(input.oldScale) && input.oldScale > 0 ? input.oldScale : 1;
  const newScale = finiteNonnegative(input.newScale);
  const worldX = finiteNonnegative((scrollLeft + pointerX) / oldScale);
  const worldY = finiteNonnegative((scrollTop + pointerY) / oldScale);
  return {
    scrollLeft: finiteNonnegative(worldX * newScale - pointerX),
    scrollTop: finiteNonnegative(worldY * newScale - pointerY),
  };
}

export function fitWorldScale(worldWidth: number, worldHeight: number, viewportWidth: number, viewportHeight: number) {
  if (worldWidth <= 0 || worldHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return 1;
  return Math.min(viewportWidth / worldWidth, viewportHeight / worldHeight);
}

export function clampWorldScale(scale: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, scale));
}

export function screenPointToWorld(point: { x: number; y: number }, transform: WorldViewTransform) {
  return {
    x: transform.x + point.x / transform.scale,
    y: transform.y + point.y / transform.scale,
  };
}

export function getVisibleWorldTiles(input: {
  worldWidth: number;
  worldHeight: number;
  tileSize: number;
  level: number;
  viewport: WorldViewport;
  prefetch?: number;
}): VisibleWorldTile[] {
  const scale = 2 ** input.level;
  const span = input.tileSize * scale;
  const maxX = Math.max(0, Math.ceil(input.worldWidth / span) - 1);
  const maxY = Math.max(0, Math.ceil(input.worldHeight / span) - 1);
  const prefetch = Math.max(0, Math.floor(input.prefetch ?? 0));
  const startX = Math.max(0, Math.floor(input.viewport.x / span) - prefetch);
  const startY = Math.max(0, Math.floor(input.viewport.y / span) - prefetch);
  const endX = Math.min(maxX, Math.floor((input.viewport.x + input.viewport.width - 1) / span) + prefetch);
  const endY = Math.min(maxY, Math.floor((input.viewport.y + input.viewport.height - 1) / span) + prefetch);
  const tiles: VisibleWorldTile[] = [];
  for (let x = startX; x <= endX; x += 1) {
    for (let y = startY; y <= endY; y += 1) tiles.push({ level: input.level, x, y });
  }
  return tiles;
}

export function focusWorldRect(
  rect: WorldRect,
  viewportWidth: number,
  viewportHeight: number,
  padding: number,
): WorldViewport {
  const width = Math.max(viewportWidth, rect.width + padding * 2);
  const height = Math.max(viewportHeight, rect.height + padding * 2);
  return {
    x: rect.x + rect.width / 2 - width / 2,
    y: rect.y + rect.height / 2 - height / 2,
    width,
    height,
  };
}
