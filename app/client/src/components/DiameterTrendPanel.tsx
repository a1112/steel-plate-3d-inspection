import { useMemo } from 'react';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import { fitSurfaceCircle } from './ProductionArtifactView';

export type DiameterMeasurement = {
  row: number;
  positionMm: number;
  diameterMm: number;
  deviationMm: number;
  roundnessMm: number;
  validPointCount: number;
};

export function buildDiameterMeasurements(
  mesh: BarSurfaceMesh,
  nominalDiameterMm: number,
  lengthMm: number,
) {
  const columns = mesh.colsPerCamera * mesh.cameraCount;
  if (columns <= 0 || nominalDiameterMm <= 0 || lengthMm <= 0) return [];
  const radialScaleMm = nominalDiameterMm / 2;
  const rowCount = Math.min(mesh.rows, Math.floor(mesh.positions.length / 3 / columns));
  const measurements: DiameterMeasurement[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const points: Array<{ y: number; z: number }> = [];
    for (let column = 0; column < columns; column += 1) {
      const pointIndex = row * columns + column;
      if (mesh.validMask && Number(mesh.validMask[pointIndex]) === 0) continue;
      const positionIndex = pointIndex * 3;
      const y = Number(mesh.positions[positionIndex + 1]);
      const z = Number(mesh.positions[positionIndex + 2]);
      if (Number.isFinite(y) && Number.isFinite(z)) points.push({ y, z });
    }
    const fitted = fitSurfaceCircle(points);
    if (!fitted) continue;
    const radii = points.map((point) => (
      Math.hypot(point.y - fitted.centerY, point.z - fitted.centerZ)
    ));
    const diameterMm = fitted.radius * radialScaleMm * 2;
    measurements.push({
      row,
      positionMm: row / Math.max(1, rowCount - 1) * lengthMm,
      diameterMm,
      deviationMm: diameterMm - nominalDiameterMm,
      roundnessMm: (Math.max(...radii) - Math.min(...radii)) * radialScaleMm,
      validPointCount: points.length,
    });
  }
  return measurements;
}

function format(value: number, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : '--';
}

function DiameterCurve({
  title,
  samples,
  value,
  reference,
  color,
  description,
  axisStartMm,
  axisEndMm,
}: {
  title: string;
  samples: DiameterMeasurement[];
  value: (sample: DiameterMeasurement) => number;
  reference: number;
  color: string;
  description: string;
  axisStartMm: number;
  axisEndMm: number;
}) {
  const values = samples.map(value);
  const dataMinimum = values.length ? Math.min(...values) : 0;
  const dataMaximum = values.length ? Math.max(...values) : 0;
  const span = Math.max(0.001, dataMaximum - dataMinimum);
  const minimum = Math.min(dataMinimum, reference) - span * 0.12;
  const maximum = Math.max(dataMaximum, reference) + span * 0.12;
  const width = 1200;
  const height = 230;
  const left = 56;
  const right = 22;
  const top = 22;
  const bottom = 34;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const x = (positionMm: number) => (
    left + Math.max(0, Math.min(1, (
      positionMm - axisStartMm
    ) / Math.max(1, axisEndMm - axisStartMm))) * chartWidth
  );
  const y = (measurement: number) => (
    top + (maximum - measurement) / Math.max(0.001, maximum - minimum) * chartHeight
  );
  const points = samples.map((sample) => `${x(sample.positionMm)},${y(value(sample))}`).join(' ');
  const latest = values.at(-1) ?? 0;

  return (
    <section className="diameter-curve-card">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}，按钢管长度位置变化`}
      >
        <line x1={left} y1={y(reference)} x2={width - right} y2={y(reference)} className="diameter-reference" />
        <line x1={left} y1={top} x2={left} y2={height - bottom} className="diameter-axis" />
        <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} className="diameter-axis" />
        <polyline points={points} fill="none" stroke={color} strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
        <text x={left - 5} y={top + 4} textAnchor="end">{format(maximum)}</text>
        <text x={left - 5} y={height - bottom} textAnchor="end">{format(minimum)}</text>
        <text x={left} y={height - 7}>{format(axisStartMm, 0)}</text>
        <text x={width - right} y={height - 7} textAnchor="end">
          {format(axisEndMm, 0)} mm
        </text>
      </svg>
      <footer>
        <span className="diameter-nominal">{description}</span>
        <span>最小 {format(dataMinimum)} mm</span>
        <span>平均 {format(values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : 0)} mm</span>
        <span>最大 {format(dataMaximum)} mm</span>
        <strong>当前 {format(latest)} mm</strong>
      </footer>
    </section>
  );
}

export function DiameterTrendPanel({
  mesh,
  nominalDiameterMm,
  lengthMm,
  visibleRange = null,
}: {
  mesh: BarSurfaceMesh;
  nominalDiameterMm: number;
  lengthMm: number;
  visibleRange?: [number, number] | null;
}) {
  const allSamples = useMemo(
    () => buildDiameterMeasurements(mesh, nominalDiameterMm, lengthMm),
    [lengthMm, mesh, nominalDiameterMm],
  );
  const normalizedRange = useMemo<[number, number] | null>(() => {
    if (!visibleRange) return null;
    const start = Math.max(0, Math.min(1, visibleRange[0]));
    const end = Math.max(start, Math.min(1, visibleRange[1]));
    return end - start >= 0.995 ? null : [start, end];
  }, [visibleRange]);
  const axisStartMm = (normalizedRange?.[0] ?? 0) * lengthMm;
  const axisEndMm = (normalizedRange?.[1] ?? 1) * lengthMm;
  const samples = useMemo(() => {
    if (!normalizedRange) return allSamples;
    const inside = allSamples.filter((sample) => (
      sample.positionMm >= axisStartMm && sample.positionMm <= axisEndMm
    ));
    const before = [...allSamples].reverse().find((sample) => sample.positionMm < axisStartMm);
    const after = allSamples.find((sample) => sample.positionMm > axisEndMm);
    return [
      ...(before ? [before] : []),
      ...inside,
      ...(after ? [after] : []),
    ];
  }, [allSamples, axisEndMm, axisStartMm, normalizedRange]);
  if (!allSamples.length) {
    return (
      <div className="production-artifact-empty compact" role="status">
        <strong>暂无可拟合的外径曲线</strong>
        <span>有效切面点不足，无法计算拟合外径。</span>
      </div>
    );
  }
  return (
    <div
      className="diameter-trend-grid"
      data-testid="diameter-trend-grid"
      data-measurement-unit="mm"
      data-section-count={allSamples.length}
      data-visible-section-count={samples.length}
      data-x-axis-scope={normalizedRange ? 'visible' : 'global'}
      data-x-axis-start-mm={axisStartMm.toFixed(0)}
      data-x-axis-end-mm={axisEndMm.toFixed(0)}
    >
      <DiameterCurve
        title="拟合外径变化"
        description={`名义外径 ${format(nominalDiameterMm)} mm`}
        samples={samples}
        value={(sample) => sample.diameterMm}
        reference={nominalDiameterMm}
        color="#0d9bd7"
        axisStartMm={axisStartMm}
        axisEndMm={axisEndMm}
      />
    </div>
  );
}
