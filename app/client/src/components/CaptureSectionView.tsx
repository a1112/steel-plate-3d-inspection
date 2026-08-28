import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState, type PointerEvent } from 'react';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import { fitSurfaceCircle } from './ProductionArtifactView';

type CaptureSectionPoint = {
  column: number;
  y: number;
  z: number;
  residualMm: number;
};

export type CaptureSectionDiameter = {
  angleDeg: number;
  diameterMm: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type CaptureSection = {
  row: number;
  points: CaptureSectionPoint[];
  centerY: number;
  centerZ: number;
  radiusMm: number;
  diameterMm: number;
  meanResidualMm: number;
  p95ResidualMm: number;
  maximumResidualMm: number;
  roundnessMm: number;
  metricValid: boolean;
  displayMode: string;
  elapsedFromHeadMs: number | null;
  positionRatio: number;
  qualityReasons: string[];
};

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

export function buildCaptureSection(mesh: BarSurfaceMesh, requestedRow: number): CaptureSection {
  const row = Math.max(0, Math.min(Math.max(0, mesh.rows - 1), Math.round(requestedRow)));
  const columns = Math.max(1, mesh.colsPerCamera * mesh.cameraCount);
  const observed: Array<{ column: number; y: number; z: number }> = [];
  for (let column = 0; column < columns; column += 1) {
    const vertexIndex = row * columns + column;
    if (mesh.validMask && Number(mesh.validMask[vertexIndex]) === 0) continue;
    const positionIndex = vertexIndex * 3;
    const y = Number(mesh.positions[positionIndex + 1]);
    const z = Number(mesh.positions[positionIndex + 2]);
    if (Number.isFinite(y) && Number.isFinite(z)) observed.push({ column, y, z });
  }

  const metadata = mesh.crossSections?.find((section) => section.meshRow === row || section.row === row);
  const metadataFit = metadata?.circleFit;
  const fitted = fitSurfaceCircle(observed);
  const centerY = Number.isFinite(metadataFit?.centerX) ? Number(metadataFit?.centerX) : fitted?.centerY ?? 0;
  const centerZ = Number.isFinite(metadataFit?.centerZ) ? Number(metadataFit?.centerZ) : fitted?.centerZ ?? 0;
  const radiusMm = Number.isFinite(metadataFit?.radiusMm) ? Number(metadataFit?.radiusMm) : fitted?.radius ?? 0;
  const signedResiduals = observed.map((point) => Math.hypot(point.y - centerY, point.z - centerZ) - radiusMm);
  const absoluteResiduals = signedResiduals.map(Math.abs);
  const minimumRadius = observed.length
    ? Math.min(...observed.map((point) => Math.hypot(point.y - centerY, point.z - centerZ)))
    : 0;
  const maximumRadius = observed.length
    ? Math.max(...observed.map((point) => Math.hypot(point.y - centerY, point.z - centerZ)))
    : 0;
  const positionRatio = Number.isFinite(metadata?.positionRatio)
    ? Math.max(0, Math.min(1, Number(metadata?.positionRatio)))
    : row / Math.max(1, mesh.rows - 1);

  return {
    row,
    points: observed.map((point, index) => ({ ...point, residualMm: signedResiduals[index] })),
    centerY,
    centerZ,
    radiusMm,
    diameterMm: Number.isFinite(metadataFit?.diameterMm) ? Number(metadataFit?.diameterMm) : radiusMm * 2,
    meanResidualMm: Number.isFinite(metadataFit?.meanAbsResidualMm)
      ? Number(metadataFit?.meanAbsResidualMm)
      : absoluteResiduals.length
        ? absoluteResiduals.reduce((sum, value) => sum + value, 0) / absoluteResiduals.length
        : 0,
    p95ResidualMm: Number.isFinite(metadataFit?.p95AbsResidualMm)
      ? Number(metadataFit?.p95AbsResidualMm)
      : percentile(absoluteResiduals, 0.95),
    maximumResidualMm: Number.isFinite(metadataFit?.maxAbsResidualMm)
      ? Number(metadataFit?.maxAbsResidualMm)
      : absoluteResiduals.length ? Math.max(...absoluteResiduals) : 0,
    roundnessMm: Number.isFinite(metadataFit?.roundnessMm)
      ? Number(metadataFit?.roundnessMm)
      : Math.max(0, maximumRadius - minimumRadius),
    // A locally accepted row must never override a failed aggregate surface
    // quality gate. This keeps the operator-facing state fail-closed.
    metricValid: mesh.metricValid === true && (metadata?.metricValid ?? true),
    displayMode: metadata?.displayMode || mesh.displayMode || 'diagnostic-unqualified',
    elapsedFromHeadMs: Number.isFinite(metadata?.elapsedFromHeadMs) ? Number(metadata?.elapsedFromHeadMs) : null,
    positionRatio,
    qualityReasons: metadata?.qualityReasons ?? [],
  };
}

function formatMm(value: number, positiveOnly = false) {
  return Number.isFinite(value) && (positiveOnly ? value > 0 : value >= 0)
    ? `${value.toFixed(3)} mm`
    : '--';
}

export function buildCaptureContourSegments(
  points: CaptureSectionPoint[],
  columnCount: number,
): CaptureSectionPoint[][] {
  if (points.length === 0) return [];
  const ordered = [...points].sort((left, right) => left.column - right.column);
  const segments: CaptureSectionPoint[][] = [[ordered[0]]];
  for (let index = 1; index < ordered.length; index += 1) {
    const point = ordered[index];
    const previous = ordered[index - 1];
    if (point.column === previous.column + 1) {
      segments.at(-1)?.push(point);
    } else {
      segments.push([point]);
    }
  }
  const coversSeam = segments.length > 1
    && segments[0][0]?.column === 0
    && segments.at(-1)?.at(-1)?.column === columnCount - 1;
  if (coversSeam) {
    const first = segments.shift() ?? [];
    segments[segments.length - 1].push(...first);
  }
  if (points.length === columnCount && segments.length === 1) {
    segments[0].push(segments[0][0]);
  }
  return segments;
}

function jetColor(residual: number, limit: number) {
  const normalized = Math.max(-1, Math.min(1, residual / Math.max(limit, 1e-6)));
  const value = (normalized + 1) / 2;
  const channel = (offset: number) => Math.round(Math.max(0, Math.min(1, 1.5 - Math.abs(4 * value - offset))) * 255);
  return `rgb(${channel(3)}, ${channel(2)}, ${channel(1)})`;
}

function normalizeAngle(angle: number) {
  const fullTurn = Math.PI * 2;
  return ((angle % fullTurn) + fullTurn) % fullTurn;
}

function angularDistance(left: number, right: number) {
  const difference = Math.abs(normalizeAngle(left) - normalizeAngle(right));
  return Math.min(difference, Math.PI * 2 - difference);
}

function pointAngle(point: CaptureSectionPoint, section: CaptureSection) {
  return normalizeAngle(Math.atan2(point.z - section.centerZ, point.y - section.centerY));
}

function radialDistance(point: CaptureSectionPoint, section: CaptureSection) {
  return Math.hypot(point.y - section.centerY, point.z - section.centerZ);
}

/** Builds a diameter through the fitted centre using the nearest measured point on each side. */
export function captureSectionDiameterAtAngle(
  section: CaptureSection,
  requestedAngle: number,
): CaptureSectionDiameter | null {
  if (section.points.length < 2) return null;
  const angle = normalizeAngle(requestedAngle);
  const oppositeAngle = normalizeAngle(angle + Math.PI);
  const nearest = (target: number) => section.points.reduce((best, point) => (
    angularDistance(pointAngle(point, section), target) < angularDistance(pointAngle(best, section), target)
      ? point
      : best
  ));
  const positivePoint = nearest(angle);
  const negativePoint = nearest(oppositeAngle);
  if (positivePoint === negativePoint) return null;
  const positiveRadius = radialDistance(positivePoint, section);
  const negativeRadius = radialDistance(negativePoint, section);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    angleDeg: normalizeAngle(angle) * 180 / Math.PI,
    diameterMm: positiveRadius + negativeRadius,
    x1: -cos * negativeRadius,
    y1: sin * negativeRadius,
    x2: cos * positiveRadius,
    y2: -sin * positiveRadius,
  };
}

export function buildCaptureSectionDiameterExtremes(section: CaptureSection) {
  const candidates = section.points
    .map((point) => captureSectionDiameterAtAngle(section, pointAngle(point, section)))
    .filter((diameter): diameter is CaptureSectionDiameter => diameter !== null)
    .filter((diameter) => diameter.angleDeg < 180);
  if (!candidates.length) return { minimum: null, maximum: null };
  return {
    minimum: candidates.reduce((minimum, diameter) => (
      diameter.diameterMm < minimum.diameterMm ? diameter : minimum
    )),
    maximum: candidates.reduce((maximum, diameter) => (
      diameter.diameterMm > maximum.diameterMm ? diameter : maximum
    )),
  };
}

function longitudinalLabel(mesh: BarSurfaceMesh, section: CaptureSection) {
  const longitudinal = mesh.longitudinalAxis;
  const displayPosition = mesh.crossSections?.find(
    (item) => item.meshRow === section.row || item.row === section.row,
  )?.longitudinalDisplayPosition;
  if (longitudinal?.absoluteScaleVerified === true
    && longitudinal.displayUnit === 'mm'
    && Number.isFinite(displayPosition)) {
    return `头部后 ${Number(displayPosition).toFixed(1)} mm`;
  }
  const progress = `头部进度 ${(section.positionRatio * 100).toFixed(1)}%`;
  return section.elapsedFromHeadMs == null
    ? progress
    : `${progress} · ${section.elapsedFromHeadMs.toFixed(0)} ms`;
}

export function CaptureSectionView({
  mesh,
  row,
  onRowChange,
  recordId,
}: {
  mesh: BarSurfaceMesh;
  row: number;
  onRowChange: (row: number) => void;
  recordId: string;
}) {
  const section = useMemo(() => buildCaptureSection(mesh, row), [mesh, row]);
  const [hoverAngle, setHoverAngle] = useState<number | null>(null);
  const extent = Math.max(
    1,
    section.radiusMm + section.maximumResidualMm,
    ...section.points.flatMap((point) => [
      Math.abs(point.y - section.centerY),
      Math.abs(point.z - section.centerZ),
    ]),
  ) * 1.18;
  const residualLimit = Math.max(section.p95ResidualMm, 0.001);
  const contourSegments = buildCaptureContourSegments(
    section.points,
    mesh.colsPerCamera * mesh.cameraCount,
  );
  const diameterExtremes = useMemo(
    () => buildCaptureSectionDiameterExtremes(section),
    [section],
  );
  const hoverDiameter = hoverAngle === null
    ? null
    : captureSectionDiameterAtAngle(section, hoverAngle);
  const angleTicks = Array.from({ length: 12 }, (_, index) => index * 30);
  const handleSectionPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dx = (event.clientX - rect.left - rect.width / 2) / rect.width;
    const dy = (event.clientY - rect.top - rect.height / 2) / rect.height;
    setHoverAngle(normalizeAngle(Math.atan2(-dy, dx)));
  };

  const renderDiameter = (
    diameter: CaptureSectionDiameter | null,
    kind: 'minimum' | 'maximum',
    label: string,
  ) => diameter ? (
    <g className={`section-diameter-annotation is-${kind}`} data-testid={`${kind}-diameter-annotation`}>
      <line x1={diameter.x1} y1={diameter.y1} x2={diameter.x2} y2={diameter.y2} />
      <text x={diameter.x2 * 0.72} y={diameter.y2 * 0.72 - extent * 0.025}>
        {label} {diameter.diameterMm.toFixed(3)} mm · {diameter.angleDeg.toFixed(0)}°
      </text>
    </g>
  ) : null;

  return (
    <div
      className="capture-section-view bkv-reconstruction-section"
      data-testid="capture-section-view"
      data-metric-valid={section.metricValid ? 'true' : 'false'}
    >
      <div className="bkv-reconstruction-section-chart">
        <svg
          viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`}
          role="img"
          aria-label={`${recordId} 360 度融合横截面`}
          preserveAspectRatio="xMidYMid meet"
          onPointerMove={handleSectionPointerMove}
          onPointerLeave={() => setHoverAngle(null)}
        >
          <line x1={-extent} y1={0} x2={extent} y2={0} className="section-axis" />
          <line x1={0} y1={-extent} x2={0} y2={extent} className="section-axis" />
          <circle r={section.radiusMm} className="section-fit-circle" />
          <g className="section-angle-scale" aria-label="截面角度刻度">
            {angleTicks.map((degrees) => {
              const angle = degrees * Math.PI / 180;
              const innerRadius = section.radiusMm + extent * 0.025;
              const outerRadius = section.radiusMm + extent * 0.055;
              const labelRadius = section.radiusMm + extent * 0.095;
              return <g key={degrees}>
                <line
                  x1={Math.cos(angle) * innerRadius}
                  y1={-Math.sin(angle) * innerRadius}
                  x2={Math.cos(angle) * outerRadius}
                  y2={-Math.sin(angle) * outerRadius}
                />
                <text
                  x={Math.cos(angle) * labelRadius}
                  y={-Math.sin(angle) * labelRadius}
                >{degrees}°</text>
              </g>;
            })}
          </g>
          {renderDiameter(diameterExtremes.maximum, 'maximum', '最宽')}
          {renderDiameter(diameterExtremes.minimum, 'minimum', '最窄')}
          {contourSegments.map((segment, index) => (
            <polyline
              key={`${segment[0]?.column ?? 0}:${index}`}
              className="capture-section-contour"
              points={segment
                .map((point) => `${point.y - section.centerY},${-(point.z - section.centerZ)}`)
                .join(' ')}
            />
          ))}
          {section.points.map((point, index) => (
            <circle
              key={index}
              cx={point.y - section.centerY}
              cy={-(point.z - section.centerZ)}
              r={extent * 0.011}
              fill={jetColor(point.residualMm, residualLimit)}
            />
          ))}
          {hoverDiameter ? (
            <g className="section-hover-diameter" data-testid="hover-diameter-annotation">
              <line
                x1={hoverDiameter.x1}
                y1={hoverDiameter.y1}
                x2={hoverDiameter.x2}
                y2={hoverDiameter.y2}
              />
              <circle cx={hoverDiameter.x1} cy={hoverDiameter.y1} r={extent * 0.018} />
              <circle cx={hoverDiameter.x2} cy={hoverDiameter.y2} r={extent * 0.018} />
              <text x={hoverDiameter.x2 * 0.62} y={hoverDiameter.y2 * 0.62 - extent * 0.035}>
                当前 {hoverDiameter.diameterMm.toFixed(3)} mm · {hoverDiameter.angleDeg.toFixed(0)}°
              </text>
            </g>
          ) : null}
          <circle r={extent * 0.012} className="section-center-point" />
        </svg>
        <div className="bkv-reconstruction-section-stats">
          <span>切面 {section.row + 1}/{mesh.rows}</span>
          <span>融合点 {section.points.length}/{mesh.colsPerCamera * mesh.cameraCount}</span>
          <span>{longitudinalLabel(mesh, section)}</span>
          <span>拟合外径 {formatMm(section.diameterMm, true)}</span>
          <span>圆度 {formatMm(section.roundnessMm)}</span>
          <span>P95 残差 {formatMm(section.p95ResidualMm)}</span>
          <strong className={section.metricValid ? 'is-metric' : 'is-preview'}>
            {section.metricValid ? '计量有效' : '趋势预览'}
          </strong>
        </div>
        <div className="capture-section-legend" aria-label="切面径向偏差图例">
          <strong>360° 融合轮廓</strong>
          <span>内凹 −{residualLimit.toFixed(3)} mm</span>
          <i />
          <span>+{residualLimit.toFixed(3)} mm 外凸</span>
          {section.qualityReasons.length ? (
            <small title={section.qualityReasons.join('；')}>质量门未通过 · {section.qualityReasons.length} 项</small>
          ) : null}
        </div>
      </div>
      <div className="capture-section-navigation">
        <button
          type="button"
          aria-label="上一个切面"
          disabled={section.row <= 0}
          onClick={() => onRowChange(section.row - 1)}
        ><ChevronLeft size={16} /></button>
        <label className="bkv-reconstruction-section-slider">
          <span>头部至尾部</span>
          <input
            type="range"
            min={0}
            max={Math.max(0, mesh.rows - 1)}
            step={1}
            value={section.row}
            onInput={(event) => onRowChange(Number(event.currentTarget.value))}
            onChange={(event) => onRowChange(Number(event.currentTarget.value))}
            aria-label="切面位置"
          />
          <strong>{(section.positionRatio * 100).toFixed(1)}%</strong>
        </label>
        <button
          type="button"
          aria-label="下一个切面"
          disabled={section.row >= mesh.rows - 1}
          onClick={() => onRowChange(section.row + 1)}
        ><ChevronRight size={16} /></button>
      </div>
    </div>
  );
}
