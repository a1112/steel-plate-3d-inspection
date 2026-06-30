export interface PointCloudGridOptions {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  stepX: number;
  stepY: number;
  defectCenterX: number;
  defectCenterY: number;
  defectFalloff: number;
  defectDepth: number;
  waveX: number;
  waveY: number;
  waveAmplitudeX: number;
  waveAmplitudeY: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
}

export interface PointCloudGeometryArrays {
  positions: Float32Array;
  colors: Float32Array;
  pointCount: number;
  memoryBytes: number;
  zMin: number;
  zMax: number;
}

export interface PointCloudAcceptanceResult {
  pointCount: number;
  memoryBytes: number;
  durationMs: number;
  pointsPerMs: number;
  accepted: boolean;
  thresholds: {
    maxDurationMs: number;
    maxMemoryBytes: number;
    minPointCount: number;
  };
}

export const DEFAULT_POINT_CLOUD_GRID: PointCloudGridOptions = {
  xMin: -52,
  xMax: 52,
  yMin: -30,
  yMax: 30,
  stepX: 2,
  stepY: 2,
  defectCenterX: 16,
  defectCenterY: -5,
  defectFalloff: 90,
  defectDepth: -0.65,
  waveX: 0.18,
  waveY: 0.22,
  waveAmplitudeX: 0.08,
  waveAmplitudeY: 0.06,
  scaleX: 30,
  scaleY: 25,
  scaleZ: 1,
};

const BYTES_PER_FLOAT32 = 4;
const POSITION_COMPONENTS = 3;
const COLOR_COMPONENTS = 3;

function getAxisCount(min: number, max: number, step: number) {
  if (step <= 0 || max < min) {
    return 0;
  }
  return Math.floor((max - min) / step) + 1;
}

export function countPointCloudGridPoints(options: PointCloudGridOptions) {
  return getAxisCount(options.xMin, options.xMax, options.stepX) * getAxisCount(options.yMin, options.yMax, options.stepY);
}

export function estimatePointCloudMemoryBytes(pointCount: number) {
  return pointCount * (POSITION_COMPONENTS + COLOR_COMPONENTS) * BYTES_PER_FLOAT32;
}

export function createPointCloudGeometryArrays(options: PointCloudGridOptions = DEFAULT_POINT_CLOUD_GRID): PointCloudGeometryArrays {
  const xCount = getAxisCount(options.xMin, options.xMax, options.stepX);
  const yCount = getAxisCount(options.yMin, options.yMax, options.stepY);
  const pointCount = xCount * yCount;
  const positions = new Float32Array(pointCount * POSITION_COMPONENTS);
  const colors = new Float32Array(pointCount * COLOR_COMPONENTS);
  let zMin = Number.POSITIVE_INFINITY;
  let zMax = Number.NEGATIVE_INFINITY;
  let pointIndex = 0;

  for (let xIndex = 0; xIndex < xCount; xIndex += 1) {
    const x = options.xMin + xIndex * options.stepX;
    for (let yIndex = 0; yIndex < yCount; yIndex += 1) {
      const y = options.yMin + yIndex * options.stepY;
      const dip =
        Math.exp(-((x - options.defectCenterX) ** 2 + (y - options.defectCenterY) ** 2) / options.defectFalloff) *
        options.defectDepth;
      const wave = Math.sin(x * options.waveX) * options.waveAmplitudeX + Math.cos(y * options.waveY) * options.waveAmplitudeY;
      const z = (dip + wave) * options.scaleZ;
      const positionOffset = pointIndex * POSITION_COMPONENTS;
      const colorOffset = pointIndex * COLOR_COMPONENTS;
      const colorT = Math.max(0, Math.min(1, (z + 0.7) / 0.95));

      positions[positionOffset] = x / options.scaleX;
      positions[positionOffset + 1] = z;
      positions[positionOffset + 2] = y / options.scaleY;

      if (colorT < 0.5) {
        colors[colorOffset] = 0.04;
        colors[colorOffset + 1] = 0.28 + colorT * 1.25;
        colors[colorOffset + 2] = 0.96 - colorT * 1.1;
      } else {
        colors[colorOffset] = (colorT - 0.5) * 1.8;
        colors[colorOffset + 1] = 0.92 - (colorT - 0.5) * 0.32;
        colors[colorOffset + 2] = 0.12;
      }

      zMin = Math.min(zMin, z);
      zMax = Math.max(zMax, z);
      pointIndex += 1;
    }
  }

  return {
    positions,
    colors,
    pointCount,
    memoryBytes: estimatePointCloudMemoryBytes(pointCount),
    zMin: Number(zMin.toFixed(4)),
    zMax: Number(zMax.toFixed(4)),
  };
}

export function createPointCloudAcceptanceGrid(targetPointCount: number): PointCloudGridOptions {
  const safeTarget = Math.max(1, targetPointCount);
  const aspect = 12450 / 1500;
  const yCount = Math.max(24, Math.round(Math.sqrt(safeTarget / aspect)));
  const xCount = Math.max(24, Math.round(yCount * aspect));

  return {
    ...DEFAULT_POINT_CLOUD_GRID,
    xMin: -6225,
    xMax: 6225,
    yMin: -750,
    yMax: 750,
    stepX: 12450 / (xCount - 1),
    stepY: 1500 / (yCount - 1),
    defectCenterX: 1450,
    defectCenterY: -80,
    defectFalloff: 92000,
    defectDepth: -1.42,
    waveX: 0.008,
    waveY: 0.034,
    waveAmplitudeX: 0.18,
    waveAmplitudeY: 0.12,
    scaleX: 1400,
    scaleY: 900,
    scaleZ: 0.72,
  };
}

export function runPointCloudAcceptanceSimulation({
  targetPointCount = 220000,
  maxDurationMs = 850,
  maxMemoryBytes = 8 * 1024 * 1024,
  now = () => performance.now(),
}: {
  targetPointCount?: number;
  maxDurationMs?: number;
  maxMemoryBytes?: number;
  now?: () => number;
} = {}): PointCloudAcceptanceResult {
  const grid = createPointCloudAcceptanceGrid(targetPointCount);
  const startedAt = now();
  const geometry = createPointCloudGeometryArrays(grid);
  const durationMs = now() - startedAt;
  const thresholds = {
    maxDurationMs,
    maxMemoryBytes,
    minPointCount: targetPointCount,
  };

  return {
    pointCount: geometry.pointCount,
    memoryBytes: geometry.memoryBytes,
    durationMs: Number(durationMs.toFixed(2)),
    pointsPerMs: Number((geometry.pointCount / Math.max(durationMs, 0.01)).toFixed(2)),
    accepted:
      geometry.pointCount >= thresholds.minPointCount &&
      geometry.memoryBytes <= thresholds.maxMemoryBytes &&
      durationMs <= thresholds.maxDurationMs,
    thresholds,
  };
}
