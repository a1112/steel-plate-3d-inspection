import { useMemo, type CSSProperties } from 'react';
import type { CaptureFlowMeasurement } from '../lib/capture-api';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import { fitSurfaceCircle } from './ProductionArtifactView';

export type DiameterMeasurement = {
  row: number;
  positionRatio: number;
  positionMm: number;
  elapsedFromHeadMs: number | null;
  diameterMm: number;
  deviationMm: number;
  roundnessMm: number;
  fitResidualP95Mm: number;
  validPointCount: number;
};

export type DiameterCurveLine = {
  id: string;
  label: string;
  kind: 'fixed-angle' | 'minimum' | 'maximum' | 'average' | 'legacy';
  angleDeg: number | null;
  color: string;
  samples: DiameterMeasurement[];
};

const FIXED_ANGLE_COLORS = ['#00d8ff', '#8bda55', '#ffd166', '#ff8c42', '#ef5da8', '#9d8cff'];

export function buildDiameterMeasurements(mesh: BarSurfaceMesh, nominalDiameterMm: number, lengthMm: number) {
  const columns = mesh.colsPerCamera * mesh.cameraCount;
  if (columns <= 0 || lengthMm <= 0) return [];
  // SICK/BKV production meshes are already millimetres. Only the legacy
  // normalized-radius mesh needs conversion with the nominal radius.
  const radialScaleMm = mesh.coordinateUnit.toLowerCase().includes('normalized') ? nominalDiameterMm / 2 : 1;
  if (!Number.isFinite(radialScaleMm) || radialScaleMm <= 0) return [];
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
    const radii = points.map((point) => Math.hypot(point.y - fitted.centerY, point.z - fitted.centerZ));
    const diameterMm = fitted.radius * radialScaleMm * 2;
    const ratio = row / Math.max(1, rowCount - 1);
    measurements.push({
      row,
      positionRatio: ratio,
      positionMm: ratio * lengthMm,
      elapsedFromHeadMs: null,
      diameterMm,
      deviationMm: nominalDiameterMm > 0 ? diameterMm - nominalDiameterMm : 0,
      roundnessMm: (Math.max(...radii) - Math.min(...radii)) * radialScaleMm,
      fitResidualP95Mm: 0,
      validPointCount: points.length,
    });
  }
  return measurements;
}

export function buildArtifactDiameterMeasurements(artifact: CaptureFlowMeasurement, nominalDiameterMm: number, lengthMm: number) {
  const surface = artifact.surfaceFit;
  if (!surface?.metricValid || !surface.available) return [];
  const sections = surface.sections ?? [];
  const elapsed = sections.map((section) => Number(section.elapsedFromHeadMs)).filter(Number.isFinite);
  const start = Math.min(...elapsed, 0);
  const end = Math.max(...elapsed, 0);
  const span = Math.max(0, end - start);
  return sections.flatMap((section, index): DiameterMeasurement[] => {
    const fit = section.circleFit;
    const diameterMm = Number(fit?.diameterMm);
    const accepted = section.metricValid ?? section.qualityGate?.passed ?? true;
    if (!accepted || !fit?.available || !Number.isFinite(diameterMm)) return [];
    const sectionElapsed = Number(section.elapsedFromHeadMs);
    const positionRatio = Number.isFinite(section.positionRatio)
      ? Math.max(0, Math.min(1, Number(section.positionRatio)))
      : span > 0 && Number.isFinite(sectionElapsed)
        ? Math.max(0, Math.min(1, (sectionElapsed - start) / span))
        : index / Math.max(1, sections.length - 1);
    return [{
      row: Number(section.anchorOrdinal ?? index),
      positionRatio,
      positionMm: positionRatio * lengthMm,
      elapsedFromHeadMs: Number.isFinite(sectionElapsed) ? sectionElapsed : null,
      diameterMm,
      deviationMm: nominalDiameterMm > 0 ? diameterMm - nominalDiameterMm : 0,
      roundnessMm: Number(fit.roundnessMm ?? 0),
      fitResidualP95Mm: Number(fit.p95AbsResidualMm ?? 0),
      validPointCount: Number(fit.robustPointCount ?? fit.pointCount ?? 0),
    }];
  });
}

export function buildDirectionalDiameterLines(
  artifact: CaptureFlowMeasurement,
  nominalDiameterMm: number,
  lengthMm: number,
): DiameterCurveLine[] {
  const curves = artifact.surfaceFit?.diameterCurves;
  if (!curves || curves.available === false) return [];
  const sections = curves.sections ?? [];
  const fitByAnchor = new Map(
    (artifact.surfaceFit?.sections ?? []).map((section, index) => [
      Number(section.anchorOrdinal ?? index),
      section.circleFit,
    ]),
  );
  const elapsed = sections
    .map((section) => Number(section.elapsedFromHeadMs))
    .filter(Number.isFinite);
  const start = elapsed.length ? Math.min(...elapsed) : 0;
  const end = elapsed.length ? Math.max(...elapsed) : start;
  const span = Math.max(0, end - start);
  const toSamples = (values: Array<number | null>): DiameterMeasurement[] => sections.flatMap((section, index) => {
    const diameterMm = Number(values[index]);
    if (section.metricValid === false || !Number.isFinite(diameterMm)) return [];
    const sectionElapsed = Number(section.elapsedFromHeadMs);
    const positionRatio = Number.isFinite(section.positionRatio)
      ? Math.max(0, Math.min(1, Number(section.positionRatio)))
      : span > 0 && Number.isFinite(sectionElapsed)
        ? Math.max(0, Math.min(1, (sectionElapsed - start) / span))
        : index / Math.max(1, sections.length - 1);
    const anchor = Number(section.anchorOrdinal ?? index);
    const fit = fitByAnchor.get(anchor);
    return [{
      row: anchor,
      positionRatio,
      positionMm: positionRatio * lengthMm,
      elapsedFromHeadMs: Number.isFinite(sectionElapsed) ? sectionElapsed : null,
      diameterMm,
      deviationMm: nominalDiameterMm > 0 ? diameterMm - nominalDiameterMm : 0,
      roundnessMm: Number(fit?.roundnessMm ?? 0),
      fitResidualP95Mm: Number(fit?.p95AbsResidualMm ?? 0),
      validPointCount: Number(fit?.robustPointCount ?? fit?.pointCount ?? 0),
    }];
  });

  return (curves.series ?? []).flatMap((series, index): DiameterCurveLine[] => {
    const samples = toSamples(series.valuesMm ?? []);
    if (!samples.length) return [];
    const aggregate = series.kind === 'aggregate';
    const normalizedId = series.id.toLowerCase();
    const kind: DiameterCurveLine['kind'] = !aggregate
      ? 'fixed-angle'
      : normalizedId.includes('minimum')
        ? 'minimum'
        : normalizedId.includes('maximum')
          ? 'maximum'
          : 'average';
    const color = kind === 'minimum'
      ? '#4da3ff'
      : kind === 'maximum'
        ? '#ff5c70'
        : kind === 'average'
          ? '#f5fbff'
          : FIXED_ANGLE_COLORS[index % FIXED_ANGLE_COLORS.length];
    return [{
      id: series.id,
      label: kind === 'minimum'
        ? '最小'
        : kind === 'maximum'
          ? '最大'
          : kind === 'average'
            ? '平均'
            : series.label || (typeof series.angleDeg === 'number' ? `${series.angleDeg}°` : series.id),
      kind,
      angleDeg: typeof series.angleDeg === 'number' ? series.angleDeg : null,
      color,
      samples,
    }];
  });
}

function format(value: number | null | undefined, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--';
}

const qualityReasonLabels: Record<string, string> = {
  'cross-section-not-synchronized': '截面软同步未通过',
  'cross-section-row-clipped': '同步截面落在帧边界',
  'approved-array-calibration-missing': '阵列标定未批准',
  'camera-extrinsics-incomplete': '相机外参不完整',
  'circle-fit-residual-out-of-tolerance': '圆拟合残差超限',
  'not-enough-valid-sections': '有效测径截面不足',
};

function DiameterCurve({ lines, nominalDiameterMm, axisMode, axisStart, axisEnd }: {
  lines: DiameterCurveLine[];
  nominalDiameterMm: number;
  axisMode: 'length-mm' | 'head-relative';
  axisStart: number;
  axisEnd: number;
}) {
  const values = lines.flatMap((line) => line.samples.map((sample) => sample.diameterMm));
  const dataMinimum = Math.min(...values);
  const dataMaximum = Math.max(...values);
  const dataMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const span = Math.max(0.01, dataMaximum - dataMinimum);
  const showNominal = nominalDiameterMm > 0 && Math.abs(nominalDiameterMm - dataMean) <= Math.max(10, dataMean * 0.3);
  const scaleValues = showNominal ? [...values, nominalDiameterMm] : values;
  const minimum = Math.min(...scaleValues) - span * 0.18;
  const maximum = Math.max(...scaleValues) + span * 0.18;
  const width = 1200;
  const height = 250;
  const left = 62;
  const right = 24;
  const top = 20;
  const bottom = 42;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const axisValue = (sample: DiameterMeasurement) => axisMode === 'length-mm' ? sample.positionMm : sample.positionRatio * 100;
  const x = (sample: DiameterMeasurement) => left + ((axisValue(sample) - axisStart) / Math.max(0.0001, axisEnd - axisStart)) * chartWidth;
  const y = (value: number) => top + (maximum - value) / Math.max(0.001, maximum - minimum) * chartHeight;
  const minimumLine = lines.find((line) => line.kind === 'minimum');
  const maximumLine = lines.find((line) => line.kind === 'maximum');
  const envelopePoints = minimumLine && maximumLine
    ? [
        ...maximumLine.samples.map((sample) => `${x(sample)},${y(sample.diameterMm)}`),
        ...[...minimumLine.samples].reverse().map((sample) => `${x(sample)},${y(sample.diameterMm)}`),
      ].join(' ')
    : '';

  return (
    <section className="diameter-curve-card">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`测径（外径）曲线，按${axisMode === 'length-mm' ? '钢管长度位置' : '头部相对位置'}变化`}>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const value = maximum - ratio * (maximum - minimum);
          return <g key={ratio}>
            <line x1={left} y1={y(value)} x2={width - right} y2={y(value)} className="diameter-grid-line" />
            <text x={left - 6} y={y(value) + 4} textAnchor="end">{format(value)}</text>
          </g>;
        })}
        {showNominal ? <line x1={left} y1={y(nominalDiameterMm)} x2={width - right} y2={y(nominalDiameterMm)} className="diameter-reference" /> : null}
        <line x1={left} y1={top} x2={left} y2={height - bottom} className="diameter-axis" />
        <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} className="diameter-axis" />
        {envelopePoints ? <polygon points={envelopePoints} className="diameter-range-envelope" /> : null}
        {lines.map((line) => <polyline
          key={line.id}
          points={line.samples.map((sample) => `${x(sample)},${y(sample.diameterMm)}`).join(' ')}
          fill="none"
          className={`diameter-series-line kind-${line.kind}`}
          style={{ '--diameter-series-color': line.color } as CSSProperties}
          vectorEffect="non-scaling-stroke"
        />)}
        {lines.filter((line) => line.kind === 'average' || line.kind === 'legacy').flatMap((line) => line.samples.map((sample) => <circle key={`${line.id}:${sample.row}:${sample.positionRatio}`} cx={x(sample)} cy={y(sample.diameterMm)} r="3.2" className="diameter-sample-point" vectorEffect="non-scaling-stroke">
          <title>{`${line.label} · ${axisMode === 'length-mm' ? `${format(sample.positionMm, 0)} mm` : `${format(sample.positionRatio * 100, 1)}% / ${format(sample.elapsedFromHeadMs, 0)} ms`}：外径 ${format(sample.diameterMm)} mm，圆度 ${format(sample.roundnessMm)} mm，P95残差 ${format(sample.fitResidualP95Mm)} mm`}</title>
        </circle>))}
        <text x={left} y={height - 13}>{axisMode === 'length-mm' ? `${format(axisStart, 0)} mm` : `${format(axisStart, 1)}%`}</text>
        <text x={width - right} y={height - 13} textAnchor="end">{axisMode === 'length-mm' ? `${format(axisEnd, 0)} mm` : `${format(axisEnd, 1)}%`}</text>
        <text x={width / 2} y={height - 8} textAnchor="middle" className="diameter-axis-title">{axisMode === 'length-mm' ? '距头部长度' : '头部相对位置（无测速仪）'}</text>
      </svg>
      {lines.length > 1 ? <div className="diameter-series-legend" aria-label="固定角度测径曲线图例">
        {lines.map((line) => <span key={line.id} className={`kind-${line.kind}`}><i style={{ '--diameter-series-color': line.color } as CSSProperties} />{line.label}</span>)}
      </div> : null}
      <footer>
        <span>{showNominal ? `名义外径 ${format(nominalDiameterMm)} mm` : '名义外径未配置'}</span>
        <span>最小 {format(dataMinimum)} mm</span>
        <span>平均 {format(dataMean)} mm</span>
        <span>最大 {format(dataMaximum)} mm</span>
        <strong>极差 {format(dataMaximum - dataMinimum)} mm</strong>
      </footer>
    </section>
  );
}

export function DiameterTrendPanel({ mesh, artifact, nominalDiameterMm, lengthMm, visibleRange = null }: {
  mesh?: BarSurfaceMesh | null;
  artifact?: CaptureFlowMeasurement | null;
  nominalDiameterMm: number;
  lengthMm: number;
  visibleRange?: [number, number] | null;
}) {
  const artifactSamples = useMemo(() => artifact ? buildArtifactDiameterMeasurements(artifact, nominalDiameterMm, lengthMm) : [], [artifact, lengthMm, nominalDiameterMm]);
  const directionalLines = useMemo(() => artifact ? buildDirectionalDiameterLines(artifact, nominalDiameterMm, lengthMm) : [], [artifact, lengthMm, nominalDiameterMm]);
  const meshSamples = useMemo(() => !artifact && mesh ? buildDiameterMeasurements(mesh, nominalDiameterMm, lengthMm) : [], [artifact, lengthMm, mesh, nominalDiameterMm]);
  const directionalContract = Boolean(artifact?.surfaceFit?.diameterCurves);
  const primaryDirectionalLine = directionalLines.find((line) => line.kind === 'average')
    ?? directionalLines.find((line) => line.kind === 'fixed-angle')
    ?? directionalLines[0];
  const allSamples = directionalContract
    ? primaryDirectionalLine?.samples ?? []
    : artifact ? artifactSamples : meshSamples;
  const normalizedRange = useMemo<[number, number] | null>(() => {
    if (!visibleRange) return null;
    const start = Math.max(0, Math.min(1, visibleRange[0]));
    const end = Math.max(start, Math.min(1, visibleRange[1]));
    return end - start >= 0.995 ? null : [start, end];
  }, [visibleRange]);
  const samples = useMemo(() => {
    if (!normalizedRange) return allSamples;
    const inside = allSamples.filter((sample) => sample.positionRatio >= normalizedRange[0] && sample.positionRatio <= normalizedRange[1]);
    const before = [...allSamples].reverse().find((sample) => sample.positionRatio < normalizedRange[0]);
    const after = allSamples.find((sample) => sample.positionRatio > normalizedRange[1]);
    return [...(before ? [before] : []), ...inside, ...(after ? [after] : [])];
  }, [allSamples, normalizedRange]);
  const visibleLines = useMemo(() => {
    const sourceLines = directionalContract
      ? directionalLines
      : [{
          id: 'fitted-diameter',
          label: '圆拟合外径',
          kind: 'legacy' as const,
          angleDeg: null,
          color: '#00d8ff',
          samples: allSamples,
        }];
    if (!normalizedRange) return sourceLines;
    return sourceLines.map((line) => {
      const inside = line.samples.filter((sample) => sample.positionRatio >= normalizedRange[0] && sample.positionRatio <= normalizedRange[1]);
      const before = [...line.samples].reverse().find((sample) => sample.positionRatio < normalizedRange[0]);
      const after = line.samples.find((sample) => sample.positionRatio > normalizedRange[1]);
      return { ...line, samples: [...(before ? [before] : []), ...inside, ...(after ? [after] : [])] };
    }).filter((line) => line.samples.length);
  }, [allSamples, directionalContract, directionalLines, normalizedRange]);
  const surface = artifact?.surfaceFit;
  const axisMode = surface?.absoluteLongitudinalScaleVerified ? 'length-mm' : artifact ? 'head-relative' : 'length-mm';
  const rangeStartRatio = normalizedRange?.[0] ?? 0;
  const rangeEndRatio = normalizedRange?.[1] ?? 1;
  const axisStart = axisMode === 'length-mm' ? rangeStartRatio * lengthMm : rangeStartRatio * 100;
  const axisEnd = axisMode === 'length-mm' ? rangeEndRatio * lengthMm : rangeEndRatio * 100;

  if (!allSamples.length) {
    const reasons = artifact?.qualityGate.reasons ?? [];
    return <div className="production-artifact-empty compact" role="status">
      <strong>{artifact ? '测径结果未通过计量质量门' : '暂无可拟合的外径曲线'}</strong>
      <span>{reasons.length
        ? reasons.map((reason) => qualityReasonLabels[reason] ?? reason).join('；')
        : surface?.reason === 'not-enough-valid-sections'
          ? '有效测径截面不足，至少需要两个合格截面。'
          : '有效切面点不足，无法计算拟合外径。'}</span>
    </div>;
  }

  const diameters = allSamples.map((sample) => sample.diameterMm);
  const curveSummary = surface?.diameterCurves?.summary;
  const minimumDiameter = curveSummary?.minimumMm ?? surface?.diameterMinimumMm ?? Math.min(...diameters);
  const maximumDiameter = curveSummary?.maximumMm ?? surface?.diameterMaximumMm ?? Math.max(...diameters);
  const averageDiameter = curveSummary?.averageMm ?? surface?.diameterMeanMm ?? diameters.reduce((sum, value) => sum + value, 0) / diameters.length;
  const roundnessMaximum = Math.max(...allSamples.map((sample) => sample.roundnessMm));
  const residualMaximum = Math.max(...allSamples.map((sample) => sample.fitResidualP95Mm));
  const measurementQualified = Boolean(surface?.metricValid && curveSummary?.metricValid !== false);
  return (
    <div className="diameter-trend-grid" data-testid="diameter-trend-grid" data-measurement-unit="mm" data-measurement-source={artifact ? 'measurement-artifact' : 'surface-fallback'} data-measurement-valid={measurementQualified ? 'true' : 'false'} data-curve-model={directionalContract ? 'fixed-angle-reconstructed-surface' : 'circle-fit-legacy'} data-fixed-angle-series={directionalLines.filter((line) => line.kind === 'fixed-angle').length} data-section-count={allSamples.length} data-visible-section-count={samples.length} data-x-axis-scope={normalizedRange ? 'visible' : 'global'} data-x-axis-mode={axisMode} data-x-axis-start-ratio={rangeStartRatio.toFixed(4)} data-x-axis-end-ratio={rangeEndRatio.toFixed(4)} data-x-axis-start-mm={(rangeStartRatio * lengthMm).toFixed(0)} data-x-axis-end-mm={(rangeEndRatio * lengthMm).toFixed(0)}>
      <div className="diameter-metric-summary">
        <span className={measurementQualified ? 'valid' : 'preview'}>{measurementQualified ? '计量有效' : '趋势预览'}</span>
        <dl><dt>有效截面</dt><dd>{curveSummary?.validSectionCount ?? surface?.sectionsAccepted ?? allSamples.length} / {surface?.sectionsRequested ?? allSamples.length}</dd></dl>
        {directionalContract ? <dl><dt>固定角度</dt><dd>{directionalLines.filter((line) => line.kind === 'fixed-angle').length} 条</dd></dl> : null}
        <dl><dt>最小外径</dt><dd>{format(minimumDiameter)} mm</dd></dl>
        <dl><dt>平均外径</dt><dd>{format(averageDiameter)} mm</dd></dl>
        <dl><dt>最大外径</dt><dd>{format(maximumDiameter)} mm</dd></dl>
        <dl><dt>最大圆度</dt><dd>{format(surface?.roundnessMaximumMm ?? roundnessMaximum)} mm</dd></dl>
        <dl><dt>拟合 P95</dt><dd>{format(surface?.fitResidualP95MaximumMm ?? residualMaximum)} mm</dd></dl>
        <em>{!measurementQualified ? '未通过整卷计量质量门，曲线仅用于趋势查看' : axisMode === 'head-relative' ? '无测速仪：横轴按软同步时间归一化，不输出伪长度' : '编码器长度坐标已验证'}</em>
      </div>
      <DiameterCurve lines={visibleLines} nominalDiameterMm={nominalDiameterMm} axisMode={axisMode} axisStart={axisStart} axisEnd={axisEnd} />
    </div>
  );
}
