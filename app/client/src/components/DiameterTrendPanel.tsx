import { useMemo } from 'react';
import type { CaptureFlowMeasurement } from '../lib/capture-api';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import { fitSurfaceCircle } from './ProductionArtifactView';
import { DiameterCanvasChart } from './DiameterCanvasChart';

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

export type DiameterMetricSummary = {
  qualified: boolean;
  validSectionCount: number;
  requestedSectionCount: number;
  fixedAngleCount: number;
  minimumDiameterMm: number | null;
  averageDiameterMm: number | null;
  maximumDiameterMm: number | null;
  maximumRoundnessMm: number | null;
  fitResidualP95MaximumMm: number | null;
  qualityNote: string;
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

function finiteOrNull(...values: Array<number | null | undefined>) {
  const value = values.find((candidate) => typeof candidate === 'number' && Number.isFinite(candidate));
  return value ?? null;
}

export function buildDiameterMetricSummary(artifact?: CaptureFlowMeasurement | null): DiameterMetricSummary | null {
  const surface = artifact?.surfaceFit;
  if (!surface?.available) return null;
  const curveSummary = surface.diameterCurves?.summary;
  const sectionDiameters = (surface.sections ?? []).flatMap((section) => {
    const value = Number(section.circleFit?.diameterMm);
    return section.metricValid !== false && Number.isFinite(value) ? [value] : [];
  });
  const sectionMinimum = sectionDiameters.length ? Math.min(...sectionDiameters) : null;
  const sectionMaximum = sectionDiameters.length ? Math.max(...sectionDiameters) : null;
  const sectionAverage = sectionDiameters.length
    ? sectionDiameters.reduce((sum, value) => sum + value, 0) / sectionDiameters.length
    : null;
  const qualified = Boolean(surface.metricValid && curveSummary?.metricValid !== false);
  const qualityNote = !qualified
    ? '未通过整卷计量质量门，曲线仅用于趋势查看'
    : surface.absoluteLongitudinalScaleVerified
      ? '编码器长度坐标已验证'
      : '无测速仪：横轴按软同步时间归一化，不输出伪长度';
  return {
    qualified,
    validSectionCount: curveSummary?.validSectionCount ?? surface.sectionsAccepted ?? sectionDiameters.length,
    requestedSectionCount: surface.sectionsRequested ?? sectionDiameters.length,
    fixedAngleCount: surface.diameterCurves?.series?.filter((series) => series.kind === 'fixed-angle').length
      ?? surface.diameterCurves?.fixedAnglesDeg?.length
      ?? 0,
    minimumDiameterMm: finiteOrNull(curveSummary?.minimumMm, surface.diameterMinimumMm, sectionMinimum),
    averageDiameterMm: finiteOrNull(curveSummary?.averageMm, surface.diameterMeanMm, sectionAverage),
    maximumDiameterMm: finiteOrNull(curveSummary?.maximumMm, surface.diameterMaximumMm, sectionMaximum),
    maximumRoundnessMm: finiteOrNull(surface.roundnessMaximumMm),
    fitResidualP95MaximumMm: finiteOrNull(surface.fitResidualP95MaximumMm),
    qualityNote,
  };
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

  const measurementQualified = buildDiameterMetricSummary(artifact)?.qualified ?? false;
  return (
    <div className="diameter-trend-grid" data-testid="diameter-trend-grid" data-measurement-unit="mm" data-measurement-source={artifact ? 'measurement-artifact' : 'surface-fallback'} data-measurement-valid={measurementQualified ? 'true' : 'false'} data-curve-model={directionalContract ? 'fixed-angle-reconstructed-surface' : 'circle-fit-legacy'} data-fixed-angle-series={directionalLines.filter((line) => line.kind === 'fixed-angle').length} data-section-count={allSamples.length} data-visible-section-count={samples.length} data-x-axis-scope={normalizedRange ? 'visible' : 'global'} data-x-axis-mode={axisMode} data-x-axis-start-ratio={rangeStartRatio.toFixed(4)} data-x-axis-end-ratio={rangeEndRatio.toFixed(4)} data-x-axis-start-mm={(rangeStartRatio * lengthMm).toFixed(0)} data-x-axis-end-mm={(rangeEndRatio * lengthMm).toFixed(0)}>
      <DiameterCanvasChart lines={visibleLines} nominalDiameterMm={nominalDiameterMm} axisMode={axisMode} axisStart={axisStart} axisEnd={axisEnd} />
    </div>
  );
}
