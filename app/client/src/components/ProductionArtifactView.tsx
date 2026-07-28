import { Canvas, useLoader, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  SRGBColorSpace,
  TextureLoader,
  Uint32BufferAttribute,
  type PerspectiveCamera,
} from 'three';
import type { BarSurfaceMesh } from '../services/bar-surface-api';

const MIN_ZOOM = 0.72;
const MAX_ZOOM = 10;
const ZOOM_FACTOR = 1.2;
const NORMALIZED_LONGITUDINAL_SPAN = 4.2;
const NORMALIZED_CROSS_SPAN = 1.35;

export type ArtifactColorMode = 'source' | 'radial-jet' | 'texture';
export type ArtifactOrientation = 'horizontal' | 'vertical';

export type RadialJetSummary = {
  fittedSectionCount: number;
  fittedPointCount: number;
  meanRadius: number;
  meanAbsoluteResidual: number;
  maximumAbsoluteResidual: number;
  residualLimit: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function fitSurfaceCircle(points: Array<{ y: number; z: number }>) {
  if (points.length < 3) return null;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const meanZ = points.reduce((sum, point) => sum + point.z, 0) / points.length;
  let sumYY = 0;
  let sumYZ = 0;
  let sumZZ = 0;
  let sumYR2 = 0;
  let sumZR2 = 0;
  for (const point of points) {
    const y = point.y - meanY;
    const z = point.z - meanZ;
    const radiusSquared = y * y + z * z;
    sumYY += y * y;
    sumYZ += y * z;
    sumZZ += z * z;
    sumYR2 += y * radiusSquared;
    sumZR2 += z * radiusSquared;
  }
  const determinant = sumYY * sumZZ - sumYZ * sumYZ;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  const centerY = meanY + (sumYR2 * sumZZ - sumZR2 * sumYZ) / (2 * determinant);
  const centerZ = meanZ + (sumZR2 * sumYY - sumYR2 * sumYZ) / (2 * determinant);
  const radius = points.reduce(
    (sum, point) => sum + Math.hypot(point.y - centerY, point.z - centerZ),
    0,
  ) / points.length;
  return Number.isFinite(radius) && radius > 0 ? { centerY, centerZ, radius } : null;
}

function jetColor(normalizedResidual: number): [number, number, number] {
  const value = (clamp(normalizedResidual, -1, 1) + 1) / 2;
  return [
    clamp(1.5 - Math.abs(4 * value - 3), 0, 1),
    clamp(1.5 - Math.abs(4 * value - 2), 0, 1),
    clamp(1.5 - Math.abs(4 * value - 1), 0, 1),
  ];
}

export function buildRadialJetColors(mesh: BarSurfaceMesh, radialUnitScale = 1): {
  colors: Float32Array;
  summary: RadialJetSummary;
} {
  const pointCount = Math.floor(mesh.positions.length / 3);
  const columns = mesh.colsPerCamera * mesh.cameraCount;
  const rowCount = columns > 0
    ? Math.min(mesh.rows, Math.floor(pointCount / columns))
    : 0;
  const colors = new Float32Array(pointCount * 3);
  const residuals = new Float64Array(pointCount);
  const fittedMask = new Uint8Array(pointCount);
  const radii: number[] = [];
  const absoluteResiduals: number[] = [];
  let fittedSectionCount = 0;

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    colors[pointIndex * 3] = 0.025;
    colors[pointIndex * 3 + 1] = 0.045;
    colors[pointIndex * 3 + 2] = 0.065;
  }

  for (let row = 0; row < rowCount; row += 1) {
    const rowStart = row * columns;
    const rowPoints: Array<{ pointIndex: number; y: number; z: number }> = [];
    for (let column = 0; column < columns; column += 1) {
      const pointIndex = rowStart + column;
      if (mesh.validMask && Number(mesh.validMask[pointIndex]) === 0) continue;
      const positionIndex = pointIndex * 3;
      const y = Number(mesh.positions[positionIndex + 1]);
      const z = Number(mesh.positions[positionIndex + 2]);
      if (Number.isFinite(y) && Number.isFinite(z)) {
        rowPoints.push({ pointIndex, y, z });
      }
    }
    const fitted = fitSurfaceCircle(rowPoints);
    if (!fitted) continue;
    fittedSectionCount += 1;
    radii.push(fitted.radius);
    for (const point of rowPoints) {
      const residual = Math.hypot(
        point.y - fitted.centerY,
        point.z - fitted.centerZ,
      ) - fitted.radius;
      residuals[point.pointIndex] = residual;
      fittedMask[point.pointIndex] = 1;
      absoluteResiduals.push(Math.abs(residual) * radialUnitScale);
    }
  }

  absoluteResiduals.sort((left, right) => left - right);
  const residualLimit = Math.max(
    absoluteResiduals[Math.floor(Math.max(0, absoluteResiduals.length - 1) * 0.95)] ?? 0,
    1e-6,
  );
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    if (fittedMask[pointIndex] === 0) continue;
    const [red, green, blue] = jetColor(
      residuals[pointIndex] * radialUnitScale / residualLimit,
    );
    const colorIndex = pointIndex * 3;
    colors[colorIndex] = red;
    colors[colorIndex + 1] = green;
    colors[colorIndex + 2] = blue;
  }

  return {
    colors,
    summary: {
      fittedSectionCount,
      fittedPointCount: absoluteResiduals.length,
      meanRadius: radii.length
        ? radii.reduce((sum, radius) => sum + radius, 0) / radii.length * radialUnitScale
        : 0,
      meanAbsoluteResidual: absoluteResiduals.length
        ? absoluteResiduals.reduce((sum, residual) => sum + residual, 0) / absoluteResiduals.length
        : 0,
      maximumAbsoluteResidual: absoluteResiduals.at(-1) ?? 0,
      residualLimit,
    },
  };
}

function normalizePositions(values: ArrayLike<number>) {
  const normalized = new Float32Array(values.length);
  if (values.length < 3) {
    return normalized;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let index = 0; index + 2 < values.length; index += 3) {
    const x = Number(values[index]);
    const y = Number(values[index + 1]);
    const z = Number(values[index + 2]);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const largestSpan = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
  const scale = 4.2 / largestSpan;
  for (let index = 0; index + 2 < values.length; index += 3) {
    normalized[index] = (Number(values[index]) - centerX) * scale;
    normalized[index + 1] = (Number(values[index + 1]) - centerY) * scale;
    normalized[index + 2] = (Number(values[index + 2]) - centerZ) * scale;
  }
  return normalized;
}

function createArtifactGeometry(
  mesh: BarSurfaceMesh,
  indexed: boolean,
  colorMode: ArtifactColorMode,
  radialUnitScale: number,
) {
  const geometry = new BufferGeometry();
  const pointCount = Math.floor(mesh.positions.length / 3);
  const jet = colorMode === 'radial-jet'
    ? buildRadialJetColors(mesh, radialUnitScale)
    : null;
  const sourceColors: ArrayLike<number> = jet?.colors ?? mesh.colors;
  const hasColors = sourceColors.length >= pointCount * 3;
  const validMask = mesh.validMask;
  let positions: ArrayLike<number> = mesh.positions;
  let colors: ArrayLike<number> = sourceColors;

  if (!indexed && validMask && validMask.length >= pointCount) {
    const validPositions: number[] = [];
    const validColors: number[] = [];
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      if (Number(validMask[pointIndex]) === 0) continue;
      const positionIndex = pointIndex * 3;
      validPositions.push(
        Number(mesh.positions[positionIndex]),
        Number(mesh.positions[positionIndex + 1]),
        Number(mesh.positions[positionIndex + 2]),
      );
      if (hasColors) {
        validColors.push(
          Number(sourceColors[positionIndex]),
          Number(sourceColors[positionIndex + 1]),
          Number(sourceColors[positionIndex + 2]),
        );
      }
    }
    positions = validPositions;
    colors = validColors;
  }

  geometry.setAttribute('position', new Float32BufferAttribute(normalizePositions(positions), 3));
  const renderedPointCount = Math.floor(positions.length / 3);
  if (colors.length >= renderedPointCount * 3) {
    geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(colors), 3));
  }
  if (indexed && mesh.indices.length >= 3) {
    const columns = Math.max(1, mesh.colsPerCamera * mesh.cameraCount);
    const rows = Math.max(1, Math.min(mesh.rows, Math.floor(pointCount / columns)));
    const uvs = new Float32Array(pointCount * 2);
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      const row = Math.floor(pointIndex / columns);
      const column = pointIndex % columns;
      uvs[pointIndex * 2] = rows > 1 ? Math.min(row, rows - 1) / (rows - 1) : 0;
      uvs[pointIndex * 2 + 1] = columns > 1 ? 1 - column / (columns - 1) : 0;
    }
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geometry.setIndex(new Uint32BufferAttribute(new Uint32Array(mesh.indices), 1));
    geometry.computeVertexNormals();
  }
  return { geometry, jetSummary: jet?.summary ?? null };
}

function ArtifactCamera({
  zoom,
  orientation,
}: {
  zoom: number;
  orientation: ArtifactOrientation;
}) {
  const { camera, size } = useThree();
  useEffect(() => {
    const perspective = camera as PerspectiveCamera;
    const verticalFov = perspective.fov * Math.PI / 180;
    const aspect = Math.max(size.width / Math.max(size.height, 1), 0.25);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
    const width = orientation === 'horizontal' ? NORMALIZED_LONGITUDINAL_SPAN : NORMALIZED_CROSS_SPAN;
    const height = orientation === 'horizontal' ? NORMALIZED_CROSS_SPAN : NORMALIZED_LONGITUDINAL_SPAN;
    const distance = Math.max(
      width / (2 * Math.tan(horizontalFov / 2)),
      height / (2 * Math.tan(verticalFov / 2)),
      1,
    ) * 1.18;
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, distance);
    camera.lookAt(0, 0, 0);
    perspective.near = 0.01;
    perspective.far = Math.max(100, distance * 20);
    perspective.zoom = zoom;
    perspective.updateProjectionMatrix();
  }, [camera, orientation, size.height, size.width, zoom]);
  return null;
}

function ArtifactTextureMaterial({ textureUrl }: { textureUrl: string }) {
  const texture = useLoader(TextureLoader, textureUrl);
  texture.colorSpace = SRGBColorSpace;
  return <meshBasicMaterial color="#ffffff" map={texture} side={DoubleSide} />;
}

export function ProductionArtifactView({
  mesh,
  mode,
  testId,
  ariaLabel,
  className = '',
  colorMode = 'source',
  textureUrl,
  radialUnitScale = 1,
  radialUnit = '显示坐标',
  orientation = 'horizontal',
  onZoomChange,
  lengthMm = 0,
  onVisibleRangeChange,
  focusPositionRatio,
  focusRevision = 0,
}: {
  mesh: BarSurfaceMesh;
  mode: 'surface' | 'points';
  testId: string;
  ariaLabel: string;
  className?: string;
  colorMode?: ArtifactColorMode;
  textureUrl?: string | null;
  radialUnitScale?: number;
  radialUnit?: string;
  orientation?: ArtifactOrientation;
  onZoomChange?: (zoom: number) => void;
  lengthMm?: number;
  onVisibleRangeChange?: (range: [number, number] | null) => void;
  focusPositionRatio?: number | null;
  focusRevision?: number;
}) {
  const [roll, setRoll] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [axisCenter, setAxisCenter] = useState(0.5);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number;
    button: number;
    x: number;
    y: number;
  } | null>(null);
  const scrollDrag = useRef<{
    pointerId: number;
    grabOffsetRatio: number;
  } | null>(null);
  const artifact = useMemo(
    () => createArtifactGeometry(mesh, mode === 'surface', colorMode, radialUnitScale),
    [colorMode, mesh, mode, radialUnitScale],
  );
  const { geometry, jetSummary } = artifact;
  const hasColors = geometry.getAttribute('color') !== undefined;
  const pointCount = geometry.getAttribute('position')?.count ?? 0;
  const visibleFraction = Math.min(1, 1 / Math.max(1, zoom));
  const halfVisibleFraction = visibleFraction / 2;
  const minimumAxisCenter = halfVisibleFraction;
  const maximumAxisCenter = 1 - halfVisibleFraction;
  const visibleRange: [number, number] = [
    Math.max(0, axisCenter - halfVisibleFraction),
    Math.min(1, axisCenter + halfVisibleFraction),
  ];
  const axisOffset = (0.5 - axisCenter) * NORMALIZED_LONGITUDINAL_SPAN;
  const rulerTicks = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    return { ratio, value: ratio * lengthMm };
  });

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setAxisCenter(0.5);
  }, [orientation]);
  useEffect(() => {
    setAxisCenter((current) => clamp(current, minimumAxisCenter, maximumAxisCenter));
  }, [maximumAxisCenter, minimumAxisCenter]);
  useEffect(() => {
    if (focusPositionRatio == null || !Number.isFinite(focusPositionRatio)) return;
    setAxisCenter(clamp(focusPositionRatio, minimumAxisCenter, maximumAxisCenter));
  }, [focusPositionRatio, focusRevision, maximumAxisCenter, minimumAxisCenter]);
  useEffect(() => {
    if (!onVisibleRangeChange) return;
    onVisibleRangeChange(visibleFraction >= 0.995 ? null : visibleRange);
  }, [axisCenter, onVisibleRangeChange, visibleFraction]);

  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) {
      return;
    }
    drag.current = null;
    setDragging(false);
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
    const next = clamp(Number((zoom * factor).toFixed(2)), MIN_ZOOM, MAX_ZOOM);
    setZoom(next);
    onZoomChange?.(next);
  };

  return (
    <div
      className={`production-artifact-view ${mode} ${dragging ? 'is-dragging' : ''} ${className}`.trim()}
      data-testid={testId}
      data-artifact-source="production-record"
      data-artifact-points={pointCount}
      data-artifact-triangles={mode === 'surface' ? Math.floor(mesh.indices.length / 3) : 0}
      data-artifact-orientation={orientation}
      data-artifact-roll={roll.toFixed(3)}
      data-artifact-zoom={zoom.toFixed(2)}
      data-artifact-color-mode={colorMode}
      data-visible-range-start={visibleRange[0].toFixed(4)}
      data-visible-range-end={visibleRange[1].toFixed(4)}
      aria-label={ariaLabel}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (![0, 1, 2].includes(event.button)) {
          return;
        }
        drag.current = {
          pointerId: event.pointerId,
          button: event.button,
          x: event.clientX,
          y: event.clientY,
        };
        setDragging(true);
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }}
      onPointerMove={(event) => {
        if (!drag.current || drag.current.pointerId !== event.pointerId) {
          return;
        }
        const deltaX = event.clientX - drag.current.x;
        const deltaY = event.clientY - drag.current.y;
        if (drag.current.button === 0) {
          if (visibleFraction < 0.995 && !event.shiftKey) {
            const axialDelta = orientation === 'horizontal' ? deltaX : -deltaY;
            const viewportPixels = Math.max(
              1,
              orientation === 'horizontal'
                ? event.currentTarget.clientWidth
                : event.currentTarget.clientHeight,
            );
            setAxisCenter((current) => clamp(
              current - axialDelta / viewportPixels * visibleFraction,
              minimumAxisCenter,
              maximumAxisCenter,
            ));
          } else {
            setRoll((current) => current + deltaX * 0.012);
          }
        } else {
          setPan((current) => ({
            x: orientation === 'vertical'
              ? current.x + deltaX * 0.006 / zoom
              : current.x,
            y: orientation === 'horizontal'
              ? current.y - deltaY * 0.006 / zoom
              : current.y,
          }));
        }
        drag.current = {
          ...drag.current,
          x: event.clientX,
          y: event.clientY,
        };
      }}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onWheel={handleWheel}
    >
      <Canvas camera={{ position: [3.4, 2.7, 4.6], fov: 46 }} dpr={[1, 1.5]}>
        <ArtifactCamera zoom={zoom} orientation={orientation} />
        <color attach="background" args={['#081118']} />
        <ambientLight intensity={0.82} />
        <directionalLight position={[3, 5, 6]} intensity={1.1} />
        <group position={[pan.x, pan.y, 0]} rotation={[0, 0, orientation === 'vertical' ? Math.PI / 2 : 0]}>
          <group position={[axisOffset, 0, 0]}>
            <group rotation={[roll, 0, 0]}>
              {mode === 'surface' ? (
                <mesh geometry={geometry}>
                  {colorMode === 'texture' && textureUrl ? (
                    <ArtifactTextureMaterial textureUrl={textureUrl} />
                  ) : colorMode === 'radial-jet' ? (
                    <meshBasicMaterial color="#ffffff" vertexColors side={DoubleSide} />
                  ) : (
                    <meshStandardMaterial color={hasColors ? '#ffffff' : '#8ba2ad'} vertexColors={hasColors} roughness={0.62} metalness={0.08} side={DoubleSide} />
                  )}
                </mesh>
              ) : (
                <points geometry={geometry}>
                  <pointsMaterial color={hasColors ? '#ffffff' : '#42c9ff'} vertexColors={hasColors} size={0.025} sizeAttenuation />
                </points>
              )}
            </group>
          </group>
        </group>
      </Canvas>
      <span className="production-artifact-tag">
        生产记录产物 · {pointCount.toLocaleString('zh-CN')} 点 · {orientation === 'horizontal' ? '横向' : '纵向'} · {zoom.toFixed(2)}x
      </span>
      {colorMode === 'texture' ? (
        <span className="production-artifact-texture-tag">
          {textureUrl ? '2D 检测图像贴图' : '贴图准备中 · 暂用基础色'}
        </span>
      ) : null}
      {jetSummary ? (
        <div className="production-artifact-jet-legend" aria-label="Jet 拟合圆径向偏差图例">
          <strong>Jet · 拟合圆径向偏差</strong>
          <div>
            <span>内凹 −{jetSummary.residualLimit.toFixed(3)}{radialUnit}</span>
            <i />
            <span>+{jetSummary.residualLimit.toFixed(3)}{radialUnit} 外凸</span>
          </div>
          <small>{jetSummary.fittedSectionCount} 个切面拟合 · 径向偏差单位 {radialUnit}</small>
        </div>
      ) : null}
      <div
        className={`production-artifact-axis-navigation orientation-${orientation}`}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="production-artifact-length-ruler" aria-label="三维长度毫米刻度">
          {rulerTicks.map((tick, index) => (
            <span key={`${index}:${tick.ratio}`} style={{ left: `${tick.ratio * 100}%` }}>
              <i />
              <b>{lengthMm > 0 ? `${Math.round(tick.value)} mm` : `${Math.round(tick.ratio * 100)}%`}</b>
            </span>
          ))}
        </div>
        <div className="production-artifact-scrollbar-row">
          <span>长度视口</span>
          <div
            className={`production-artifact-scrollbar ${visibleFraction >= 0.995 ? 'is-disabled' : ''}`}
            role="scrollbar"
            aria-label="三维长度方向滚动条"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={Math.round(lengthMm)}
            aria-valuenow={Math.round(visibleRange[0] * lengthMm)}
            aria-valuetext={visibleFraction >= 0.995
              ? '全长'
              : `${Math.round(visibleRange[0] * lengthMm)} 至 ${Math.round(visibleRange[1] * lengthMm)} 毫米`}
            aria-disabled={visibleFraction >= 0.995}
            onPointerDown={(event) => {
              if (visibleFraction >= 0.995) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const pointerRatio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
              const thumb = (event.target as HTMLElement).closest('.production-artifact-scrollbar-thumb');
              const grabOffsetRatio = thumb
                ? clamp(pointerRatio - visibleRange[0], 0, visibleFraction)
                : halfVisibleFraction;
              scrollDrag.current = { pointerId: event.pointerId, grabOffsetRatio };
              event.currentTarget.setPointerCapture?.(event.pointerId);
              if (!thumb) {
                setAxisCenter(clamp(pointerRatio, minimumAxisCenter, maximumAxisCenter));
              }
            }}
            onPointerMove={(event) => {
              if (scrollDrag.current?.pointerId !== event.pointerId) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const pointerRatio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
              const nextStart = pointerRatio - scrollDrag.current.grabOffsetRatio;
              setAxisCenter(clamp(
                nextStart + halfVisibleFraction,
                minimumAxisCenter,
                maximumAxisCenter,
              ));
            }}
            onPointerUp={(event) => {
              if (scrollDrag.current?.pointerId !== event.pointerId) return;
              scrollDrag.current = null;
              event.currentTarget.releasePointerCapture?.(event.pointerId);
            }}
            onPointerCancel={() => {
              scrollDrag.current = null;
            }}
          >
            <i className="production-artifact-scrollbar-track" />
            {focusPositionRatio != null ? (
              <span
                className="production-artifact-scrollbar-focus"
                style={{ left: `${clamp(focusPositionRatio, 0, 1) * 100}%` }}
                title={`当前缺陷位置 ${Math.round(clamp(focusPositionRatio, 0, 1) * lengthMm)} mm`}
              />
            ) : null}
            <b
              className="production-artifact-scrollbar-thumb"
              style={{
                left: `${visibleRange[0] * 100}%`,
                width: `${visibleFraction * 100}%`,
              }}
            />
          </div>
          <strong>
            {visibleFraction >= 0.995
              ? '全长'
              : `${Math.round(visibleRange[0] * lengthMm)}–${Math.round(visibleRange[1] * lengthMm)} mm`}
          </strong>
        </div>
      </div>
    </div>
  );
}
