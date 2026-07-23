import { describe, expect, it } from 'vitest';
import {
  clampWorldScale,
  fitWorldScale,
  focusWorldRect,
  getVisibleCameraTiles,
  getVisibleWorldTiles,
  scaledWorldExtent,
  scrollPositionForZoom,
  screenPointToWorld,
} from './inspection-world';

describe('inspection world viewport math', () => {
  it('fits the complete world and clamps interactive zoom', () => {
    expect(fitWorldScale(4000, 20000, 1000, 800)).toBeCloseTo(0.04);
    expect(clampWorldScale(0.001, 0.02, 8)).toBe(0.02);
    expect(clampWorldScale(20, 0.02, 8)).toBe(8);
  });

  it('converts a screen point through the current world viewport', () => {
    expect(screenPointToWorld({ x: 200, y: 100 }, { x: 1000, y: 2000, scale: 0.5 })).toEqual({ x: 1400, y: 2200 });
  });

  it('returns visible and one-ring prefetched tiles at the requested LOD', () => {
    const tiles = getVisibleWorldTiles({
      worldWidth: 4096,
      worldHeight: 21504,
      tileSize: 512,
      level: 2,
      viewport: { x: 0, y: 4096, width: 1000, height: 800 },
      prefetch: 1,
    });
    expect(tiles).toContainEqual({ level: 2, x: 0, y: 1 });
    expect(tiles).toContainEqual({ level: 2, x: 1, y: 2 });
    expect(tiles.every((tile) => tile.x >= 0 && tile.y >= 0)).toBe(true);
  });

  it('clamps partial edge tiles to valid world tile coordinates', () => {
    const tiles = getVisibleWorldTiles({
      worldWidth: 1000,
      worldHeight: 700,
      tileSize: 512,
      level: 0,
      viewport: { x: 800, y: 500, width: 400, height: 400 },
      prefetch: 0,
    });
    expect(tiles).toEqual([{ level: 0, x: 1, y: 0 }, { level: 0, x: 1, y: 1 }]);
  });

  it('selects camera-local tiles without crossing real-width camera boundaries', () => {
    const tiles = getVisibleCameraTiles({
      cameras: [
        { cameraId: 1, offsetX: 0, width: 682, height: 21504 },
        { cameraId: 2, offsetX: 682, width: 646, height: 20738 },
      ],
      tileSize: 512,
      level: 0,
      viewport: { x: 640, y: 0, width: 120, height: 400 },
      prefetch: 0,
    });

    expect(tiles).toEqual([
      { cameraId: 1, level: 0, x: 1, y: 0 },
      { cameraId: 2, level: 0, x: 0, y: 0 },
    ]);
    expect(tiles.every((tile) => tile.x * 512 < (tile.cameraId === 1 ? 682 : 646))).toBe(true);
  });

  it('centres a defect rectangle with bounded padding', () => {
    expect(focusWorldRect({ x: 473, y: 13145, width: 10, height: 10 }, 1000, 600, 20))
      .toEqual({ x: -22, y: 12850, width: 1000, height: 600 });
  });

  it('uses the scaled world as native scroll extent without shrinking below the viewport', () => {
    expect(scaledWorldExtent(600, 21504, 1000 / 600, 1000, 600)).toEqual({
      width: 1000,
      height: 35840,
    });
    expect(scaledWorldExtent(600, 100, 1, 1000, 600)).toEqual({ width: 1000, height: 600 });
  });

  it('keeps the world point below the pointer when zoom changes', () => {
    expect(scrollPositionForZoom({
      scrollLeft: 0,
      scrollTop: 400,
      pointerX: 250,
      pointerY: 200,
      oldScale: 1,
      newScale: 2,
    })).toEqual({ scrollLeft: 250, scrollTop: 1000 });
  });

  it('keeps malformed scroll math finite and nonnegative', () => {
    expect(scaledWorldExtent(Number.POSITIVE_INFINITY, -1, Number.NaN, 1000, 600))
      .toEqual({ width: 1000, height: 600 });
    expect(scrollPositionForZoom({
      scrollLeft: -10,
      scrollTop: Number.NaN,
      pointerX: Number.POSITIVE_INFINITY,
      pointerY: -20,
      oldScale: 0,
      newScale: Number.NaN,
    })).toEqual({ scrollLeft: 0, scrollTop: 0 });
  });
});
