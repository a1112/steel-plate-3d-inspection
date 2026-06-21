import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POINT_CLOUD_GRID,
  countPointCloudGridPoints,
  createPointCloudAcceptanceGrid,
  createPointCloudGeometryArrays,
  estimatePointCloudMemoryBytes,
  runPointCloudAcceptanceSimulation,
} from './point-cloud-simulator';

describe('point-cloud simulator', () => {
  it('creates typed-array geometry without expandable array intermediates', () => {
    const pointCount = countPointCloudGridPoints(DEFAULT_POINT_CLOUD_GRID);
    const geometry = createPointCloudGeometryArrays(DEFAULT_POINT_CLOUD_GRID);

    expect(pointCount).toBe(1643);
    expect(geometry.pointCount).toBe(pointCount);
    expect(geometry.positions).toBeInstanceOf(Float32Array);
    expect(geometry.colors).toBeInstanceOf(Float32Array);
    expect(geometry.positions).toHaveLength(pointCount * 3);
    expect(geometry.colors).toHaveLength(pointCount * 3);
    expect(geometry.memoryBytes).toBe(estimatePointCloudMemoryBytes(pointCount));
    expect(geometry.zMin).toBeLessThan(-0.45);
    expect(geometry.zMax).toBeGreaterThan(0.1);
  });

  it('sizes the high-density internal simulator close to the requested surface point budget', () => {
    const targetPointCount = 220000;
    const grid = createPointCloudAcceptanceGrid(targetPointCount);
    const pointCount = countPointCloudGridPoints(grid);

    expect(pointCount).toBeGreaterThanOrEqual(targetPointCount);
    expect(pointCount).toBeLessThan(targetPointCount * 1.02);
    expect(estimatePointCloudMemoryBytes(pointCount)).toBeLessThan(8 * 1024 * 1024);
  });

  it('passes the high-density point-cloud acceptance envelope', () => {
    const result = runPointCloudAcceptanceSimulation({
      targetPointCount: 220000,
      maxDurationMs: 850,
      maxMemoryBytes: 8 * 1024 * 1024,
    });

    expect(result.accepted, JSON.stringify(result)).toBe(true);
    expect(result.pointCount).toBeGreaterThanOrEqual(result.thresholds.minPointCount);
    expect(result.durationMs).toBeLessThanOrEqual(result.thresholds.maxDurationMs);
    expect(result.memoryBytes).toBeLessThanOrEqual(result.thresholds.maxMemoryBytes);
    expect(result.pointsPerMs).toBeGreaterThan(0);
  });
});
