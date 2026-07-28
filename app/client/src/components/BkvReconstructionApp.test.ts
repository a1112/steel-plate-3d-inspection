import { describe, expect, it } from 'vitest';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import { buildBkvSection } from './BkvReconstructionApp';

function createMesh(): BarSurfaceMesh {
  return {
    schema: 'test',
    coordinateUnit: 'display',
    cameraCount: 2,
    frameStems: [],
    rows: 2,
    colsPerCamera: 2,
    positions: new Float32Array([
      0, 1, 0,
      0, 0, 1,
      0, -1, 0,
      0, 0, -1,
      10, 2, 0,
      10, 0, 2,
      10, -2, 0,
      10, 0, -2,
    ]),
    uvs: new Float32Array(16),
    colors: new Float32Array(24),
    validMask: new Uint8Array([1, 1, 1, 1, 1, 0, 1, 1]),
    indices: new Uint32Array(),
  };
}

describe('buildBkvSection', () => {
  it('extracts one longitudinal row and keeps camera ownership', () => {
    const section = buildBkvSection(createMesh(), 0);

    expect(section.row).toBe(0);
    expect(section.longitudinalPosition).toBe(0);
    expect(section.points).toHaveLength(4);
    expect(section.points.map((point) => point.cameraIndex)).toEqual([0, 0, 1, 1]);
    expect(section.centerY).toBeCloseTo(0);
    expect(section.centerZ).toBeCloseTo(0);
    expect(section.meanRadius).toBeCloseTo(1);
    expect(section.maximumResidual).toBeCloseTo(0);
  });

  it('clamps the requested row and excludes invalid points', () => {
    const section = buildBkvSection(createMesh(), 99);

    expect(section.row).toBe(1);
    expect(section.longitudinalPosition).toBe(10);
    expect(section.points).toHaveLength(4);
    expect(section.observedPointCount).toBe(3);
    expect(section.points.map((point) => point.cameraIndex)).toEqual([0, 0, 1, 1]);
    expect(section.points.map((point) => point.valid)).toEqual([true, false, true, true]);
  });
});
