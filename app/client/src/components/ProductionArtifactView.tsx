import { Canvas, useLoader, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
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
// Start from the measured geometry. Operators may opt into exaggeration for
// visual inspection, but the default view must not amplify metric deviations.
const DEFAULT_DEPTH_EXAGGERATION = 1;

export type ArtifactColorMode = 'source' | 'neutral' | 'radial-jet' | 'texture';
export type ArtifactOrientation = 'horizontal' | 'vertical';

export type ArtifactTextureMetrics = {
  longitudinalPixels: number;
  circumferencePixels: number;
  pixelAspectRatio?: number;
  overlapPolicy?: 'owned-columns-concatenated' | string;
  projectionPolicy?: 'calibrated-angle-columns' | string;
};

export type ArtifactDisplaySpans = {
  longitudinal: number;
  crossSection: number;
  lengthDiameterRatio: number;
};

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

export function resolveArtifactDisplaySpans(
  textureMetrics?: ArtifactTextureMetrics | null,
): ArtifactDisplaySpans {
  const longitudinalPixels = Number(textureMetrics?.longitudinalPixels);
  const circumferencePixels = Number(textureMetrics?.circumferencePixels);
  const pixelAspectRatio = Number(textureMetrics?.pixelAspectRatio ?? 1);
  if (
    longitudinalPixels > 0
    && circumferencePixels > 0
    && pixelAspectRatio > 0
    && [longitudinalPixels, circumferencePixels, pixelAspectRatio].every(Number.isFinite)
  ) {
    // Texture height is the unwrapped circumference. At square source pixels,
    // circumference = PI * diameter, so a cylinder is PI times longer than the
    // flat texture's width/height ratio when expressed as length/diameter.
    const lengthDiameterRatio = Math.PI
      * longitudinalPixels
      * pixelAspectRatio
      / circumferencePixels;
    return {
      longitudinal: NORMALIZED_CROSS_SPAN * lengthDiameterRatio,
      crossSection: NORMALIZED_CROSS_SPAN,
      lengthDiameterRatio,
    };
  }
  return {
    longitudinal: NORMALIZED_LONGITUDINAL_SPAN,
    crossSection: NORMALIZED_CROSS_SPAN,
    lengthDiameterRatio: NORMALIZED_LONGITUDINAL_SPAN / NORMALIZED_CROSS_SPAN,
  };
}

export function unwrapTriangleTextureSeams(values: ArrayLike<number>) {
  const output = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) output[index] = Number(values[index]);
  // Non-indexed geometry stores three UV pairs per triangle. When a triangle
  // crosses the 0/360-degree seam, lift its low V coordinates into the next
  // repeat so interpolation remains local instead of sweeping across the
  // entire texture.
  for (let triangleStart = 0; triangleStart + 5 < output.length; triangleStart += 6) {
    const first = output[triangleStart + 1];
    const second = output[triangleStart + 3];
    const third = output[triangleStart + 5];
    if (Math.max(first, second, third) - Math.min(first, second, third) <= 0.5) continue;
    [triangleStart + 1, triangleStart + 3, triangleStart + 5].forEach((index) => {
      if (output[index] < 0.5) output[index] += 1;
    });
  }
  return output;
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

export function buildDepthExaggeratedPositions(
  mesh: BarSurfaceMesh,
  exaggeration: number,
): Float32Array {
  const factor = clamp(Number.isFinite(exaggeration) ? exaggeration : 1, 1, 8);
  const output = new Float32Array(mesh.positions.length);
  for (let index = 0; index < mesh.positions.length; index += 1) {
    output[index] = Number(mesh.positions[index]);
  }
  if (factor <= 1 || output.length < 9) return output;

  const pointCount = Math.floor(output.length / 3);
  const columns = mesh.colsPerCamera * mesh.cameraCount;
  const rowCount = columns > 0
    ? Math.min(mesh.rows, Math.floor(pointCount / columns))
    : 0;
  for (let row = 0; row < rowCount; row += 1) {
    const rowStart = row * columns;
    const observed: Array<{ pointIndex: number; y: number; z: number }> = [];
    for (let column = 0; column < columns; column += 1) {
      const pointIndex = rowStart + column;
      if (mesh.validMask && Number(mesh.validMask[pointIndex]) === 0) continue;
      const positionIndex = pointIndex * 3;
      const y = output[positionIndex + 1];
      const z = output[positionIndex + 2];
      if (Number.isFinite(y) && Number.isFinite(z)) observed.push({ pointIndex, y, z });
    }
    const fitted = fitSurfaceCircle(observed);
    if (!fitted) continue;
    for (const point of observed) {
      const dy = point.y - fitted.centerY;
      const dz = point.z - fitted.centerZ;
      const radius = Math.hypot(dy, dz);
      if (!Number.isFinite(radius) || radius <= 1e-9) continue;
      const residual = radius - fitted.radius;
      const enhancedRadius = Math.max(fitted.radius * 0.05, fitted.radius + residual * factor);
      const positionIndex = point.pointIndex * 3;
      output[positionIndex + 1] = fitted.centerY + dy / radius * enhancedRadius;
      output[positionIndex + 2] = fitted.centerZ + dz / radius * enhancedRadius;
    }
  }
  return output;
}

export function normalizeArtifactPositions(
  values: ArrayLike<number>,
  validMask?: ArrayLike<number>,
  spans: ArtifactDisplaySpans = resolveArtifactDisplaySpans(),
) {
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
  let boundedPointCount = 0;
  for (let index = 0; index + 2 < values.length; index += 3) {
    const pointIndex = Math.floor(index / 3);
    if (validMask && pointIndex < validMask.length && Number(validMask[pointIndex]) === 0) {
      continue;
    }
    const x = Number(values[index]);
    const y = Number(values[index + 1]);
    const z = Number(values[index + 2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
    boundedPointCount += 1;
  }
  if (boundedPointCount === 0) return normalized;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centerZ = (minZ + maxZ) / 2;
  // The backend's longitudinal coordinate is deliberately a head-relative
  // display axis until an encoder is connected. Fit that axis and the metric
  // circular cross-section independently; one unusually large calibrated
  // centre offset must not make the tube look cropped or fill the viewport.
  const longitudinalScale = spans.longitudinal / Math.max(maxX - minX, 1e-6);
  const crossSectionScale = spans.crossSection / Math.max(maxY - minY, maxZ - minZ, 1e-6);
  for (let index = 0; index + 2 < values.length; index += 3) {
    normalized[index] = (Number(values[index]) - centerX) * longitudinalScale;
    normalized[index + 1] = (Number(values[index + 1]) - centerY) * crossSectionScale;
    normalized[index + 2] = (Number(values[index + 2]) - centerZ) * crossSectionScale;
  }
  return normalized;
}

function createArtifactGeometry(
  mesh: BarSurfaceMesh,
  indexed: boolean,
  colorMode: ArtifactColorMode,
  radialUnitScale: number,
  depthExaggeration: number,
  spans: ArtifactDisplaySpans,
) {
  let geometry = new BufferGeometry();
  const pointCount = Math.floor(mesh.positions.length / 3);
  const jet = colorMode === 'radial-jet'
    ? buildRadialJetColors(mesh, radialUnitScale)
    : null;
  const sourceColors: ArrayLike<number> = colorMode === 'neutral' || colorMode === 'texture'
    ? new Float32Array()
    : jet?.colors ?? mesh.colors;
  const hasColors = sourceColors.length >= pointCount * 3;
  const validMask = mesh.validMask;
  const surfacePositions = indexed
    ? buildDepthExaggeratedPositions(mesh, depthExaggeration)
    : mesh.positions;
  let positions: ArrayLike<number> = surfacePositions;
  let colors: ArrayLike<number> = sourceColors;

  if (!indexed && validMask && validMask.length >= pointCount) {
    let validPointCount = 0;
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      if (Number(validMask[pointIndex]) !== 0) validPointCount += 1;
    }
    const validPositions = new Float32Array(validPointCount * 3);
    const validColors = hasColors ? new Float32Array(validPointCount * 3) : new Float32Array();
    let renderedPointIndex = 0;
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      if (Number(validMask[pointIndex]) === 0) continue;
      const sourceIndex = pointIndex * 3;
      const targetIndex = renderedPointIndex * 3;
      validPositions[targetIndex] = Number(mesh.positions[sourceIndex]);
      validPositions[targetIndex + 1] = Number(mesh.positions[sourceIndex + 1]);
      validPositions[targetIndex + 2] = Number(mesh.positions[sourceIndex + 2]);
      if (hasColors) {
        validColors[targetIndex] = Number(sourceColors[sourceIndex]);
        validColors[targetIndex + 1] = Number(sourceColors[sourceIndex + 1]);
        validColors[targetIndex + 2] = Number(sourceColors[sourceIndex + 2]);
      }
      renderedPointIndex += 1;
    }
    positions = validPositions;
    colors = validColors;
  }

  geometry.setAttribute('position', new Float32BufferAttribute(
    normalizeArtifactPositions(positions, indexed ? validMask : undefined, spans),
    3,
  ));
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
      // Sample angular bin centres. Using exact 0/1 endpoints makes the seam
      // unwrap collapse its first/last strip to zero width.
      uvs[pointIndex * 2 + 1] = columns > 1 ? 1 - (column + 0.5) / columns : 0.5;
    }
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geometry.setIndex(new Uint32BufferAttribute(new Uint32Array(mesh.indices), 1));
    if (colorMode === 'source' || colorMode === 'neutral') {
      geometry.computeVertexNormals();
    }
    if (colorMode === 'texture') {
      const seamSafe = geometry.toNonIndexed();
      geometry.dispose();
      geometry = seamSafe;
      const textureUvs = geometry.getAttribute('uv');
      geometry.setAttribute('uv', new Float32BufferAttribute(
        unwrapTriangleTextureSeams(textureUvs.array),
        2,
      ));
    }
  }
  return { geometry, jetSummary: jet?.summary ?? null };
}

function ArtifactCamera({
  zoom,
  orientation,
  spans,
}: {
  zoom: number;
  orientation: ArtifactOrientation;
  spans: ArtifactDisplaySpans;
}) {
  const { camera, size } = useThree();
  useEffect(() => {
    const perspective = camera as PerspectiveCamera;
    const verticalFov = perspective.fov * Math.PI / 180;
    const aspect = Math.max(size.width / Math.max(size.height, 1), 0.25);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
    const width = orientation === 'horizontal' ? spans.longitudinal : spans.crossSection;
    const height = orientation === 'horizontal' ? spans.crossSection : spans.longitudinal;
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
  }, [camera, orientation, size.height, size.width, spans, zoom]);
  return null;
}

function ArtifactTextureMaterial({ textureUrl }: { textureUrl: string }) {
  const texture = useLoader(TextureLoader, textureUrl);
  const { gl } = useThree();
  useEffect(() => {
    texture.colorSpace = SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.wrapT = RepeatWrapping;
    texture.anisotropy = Math.min(16, gl.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
  }, [gl, texture]);
  useEffect(() => () => {
    texture.dispose();
    useLoader.clear(TextureLoader, textureUrl);
  }, [texture, textureUrl]);
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
  textureModality,
  textureMetrics,
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
  textureModality?: 'gray' | 'jet';
  textureMetrics?: ArtifactTextureMetrics | null;
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
  const [depthExaggeration, setDepthExaggeration] = useState(DEFAULT_DEPTH_EXAGGERATION);
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
  const spans = useMemo(
    () => resolveArtifactDisplaySpans(textureMetrics),
    [
      textureMetrics?.circumferencePixels,
      textureMetrics?.longitudinalPixels,
      textureMetrics?.pixelAspectRatio,
    ],
  );
  const maximumZoom = Math.max(
    MAX_ZOOM,
    spans.lengthDiameterRatio / (NORMALIZED_LONGITUDINAL_SPAN / NORMALIZED_CROSS_SPAN),
  );
  const artifact = useMemo(
    () => createArtifactGeometry(
      mesh,
      mode === 'surface',
      colorMode,
      radialUnitScale,
      depthExaggeration,
      spans,
    ),
    [colorMode, depthExaggeration, mesh, mode, radialUnitScale, spans],
  );
  const { geometry, jetSummary } = artifact;
  const hasColors = geometry.getAttribute('color') !== undefined;
  const pointCount = geometry.getAttribute('position')?.count ?? 0;
  const validPointCount = useMemo(
    () => mesh.validMask
      ? Array.from(mesh.validMask).reduce(
        (count, value) => count + (Number(value) !== 0 ? 1 : 0),
        0,
      )
      : Math.floor(mesh.positions.length / 3),
    [mesh],
  );
  const renderDpr = clamp(
    (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1)
      * (1 + Math.min(0.75, Math.log2(Math.max(1, zoom)) / 4)),
    1,
    2.5,
  );
  const visibleFraction = Math.min(1, 1 / Math.max(1, zoom));
  const halfVisibleFraction = visibleFraction / 2;
  const minimumAxisCenter = halfVisibleFraction;
  const maximumAxisCenter = 1 - halfVisibleFraction;
  const visibleRange: [number, number] = [
    Math.max(0, axisCenter - halfVisibleFraction),
    Math.min(1, axisCenter + halfVisibleFraction),
  ];
  const axisOffset = (0.5 - axisCenter) * spans.longitudinal;
  const rulerTicks = Array.from({ length: 5 }, (_, index) => {
    const screenRatio = index / 4;
    const worldRatio = visibleRange[0] + screenRatio * (visibleRange[1] - visibleRange[0]);
    return { screenRatio, worldRatio, value: worldRatio * lengthMm };
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
    setZoom((current) => Math.min(current, maximumZoom));
  }, [maximumZoom]);
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
    const next = clamp(Number((zoom * factor).toFixed(2)), MIN_ZOOM, maximumZoom);
    if (next === zoom) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const hasPointerPosition = rect.width > 0
      && rect.height > 0
      && Number.isFinite(event.clientX)
      && Number.isFinite(event.clientY);
    const pointerX = hasPointerPosition
      ? clamp((event.clientX - rect.left) / rect.width, 0, 1)
      : 0.5;
    const pointerY = hasPointerPosition
      ? clamp((event.clientY - rect.top) / rect.height, 0, 1)
      : 0.5;
    const axialPointerRatio = orientation === 'horizontal' ? pointerX : pointerY;
    const previousVisibleFraction = Math.min(1, 1 / Math.max(1, zoom));
    const nextVisibleFraction = Math.min(1, 1 / Math.max(1, next));
    const anchoredWorldRatio = axisCenter
      - previousVisibleFraction / 2
      + axialPointerRatio * previousVisibleFraction;
    setAxisCenter(clamp(
      anchoredWorldRatio + (0.5 - axialPointerRatio) * nextVisibleFraction,
      nextVisibleFraction / 2,
      1 - nextVisibleFraction / 2,
    ));

    if (hasPointerPosition && orientation === 'vertical') {
      const aspect = Math.max(rect.width / rect.height, 0.25);
      const fitWidth = spans.crossSection;
      const fitHeight = spans.longitudinal;
      const baseViewHeight = Math.max(fitWidth / aspect, fitHeight) * 1.18;
      const baseViewWidth = baseViewHeight * aspect;
      const cursorX = (pointerX - 0.5) * baseViewWidth;
      const zoomDelta = 1 / next - 1 / zoom;
      setPan((current) => ({
        x: current.x + cursorX * zoomDelta,
        y: 0,
      }));
    } else if (orientation === 'horizontal') {
      // Length navigation remains pointer-anchored, while the pipe's cross-section
      // stays vertically centred at every zoom level.
      setPan((current) => current.y === 0 ? current : { ...current, y: 0 });
    }
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
      data-artifact-texture-modality={textureModality}
      data-artifact-overlap-policy={textureMetrics?.overlapPolicy}
      data-artifact-projection-policy={textureMetrics?.projectionPolicy}
      data-artifact-pixel-aspect={textureMetrics ? (textureMetrics.pixelAspectRatio ?? 1).toFixed(3) : undefined}
      data-artifact-longitudinal-pixels={textureMetrics?.longitudinalPixels}
      data-artifact-circumference-pixels={textureMetrics?.circumferencePixels}
      data-artifact-longitudinal-span={spans.longitudinal.toFixed(3)}
      data-artifact-length-diameter-ratio={spans.lengthDiameterRatio.toFixed(3)}
      data-artifact-depth-exaggeration={depthExaggeration.toFixed(1)}
      data-artifact-render-dpr={renderDpr.toFixed(2)}
      data-artifact-axis-center={axisCenter.toFixed(4)}
      data-artifact-pan-x={pan.x.toFixed(4)}
      data-artifact-pan-y={pan.y.toFixed(4)}
      data-artifact-metric-valid={mesh.metricValid === true ? 'true' : 'false'}
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
          const axialDelta = orientation === 'horizontal' ? deltaX : -deltaY;
          const rotationDelta = orientation === 'horizontal' ? deltaY : deltaX;
          if (visibleFraction < 0.995 && !event.shiftKey) {
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
          }
          setRoll((current) => current + rotationDelta * 0.012);
        } else {
          setPan((current) => ({
            x: orientation === 'vertical'
              ? current.x + deltaX * 0.006 / zoom
              : current.x,
            y: 0,
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
      <Canvas
        camera={{ position: [3.4, 2.7, 4.6], fov: 46 }}
        dpr={renderDpr}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
      >
        <ArtifactCamera zoom={zoom} orientation={orientation} spans={spans} />
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
        生产记录产物 · {validPointCount.toLocaleString('zh-CN')} 有效点 · {orientation === 'horizontal' ? '横向' : '纵向'} · {zoom.toFixed(2)}x
      </span>
      {mesh.displayMode ? (
        <span className={`production-artifact-quality-tag ${mesh.metricValid ? 'is-metric' : 'is-preview'}`}>
          {mesh.metricValid ? '计量有效' : '趋势预览'} · {mesh.rows} 切面
          {mesh.longitudinalAxis?.absoluteScaleVerified === true ? ' · 长度尺度已标定' : ' · 头部相对进度'}
        </span>
      ) : null}
      {colorMode === 'texture' ? (
        <span className="production-artifact-texture-tag">
          {textureModality
            ? textureUrl
              ? `去重${textureModality === 'jet' ? ' JET' : '灰度'}贴图 · 像素 1:1`
              : `去重${textureModality === 'jet' ? ' JET' : '灰度'}贴图准备中`
            : textureUrl ? '2D 检测图像贴图' : '贴图准备中 · 暂用基础色'}
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
      {mode === 'surface' ? (
        <label
          className="production-artifact-depth-control"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          <span>深度增强</span>
          <input
            type="range"
            min="1"
            max="8"
            step="0.5"
            value={depthExaggeration}
            aria-label="三维深度增强倍数"
            onChange={(event) => setDepthExaggeration(Number(event.target.value))}
          />
          <strong>{depthExaggeration.toFixed(1)}×</strong>
        </label>
      ) : null}
      <div
        className={`production-artifact-axis-navigation orientation-${orientation}`}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="production-artifact-length-ruler" aria-label={lengthMm > 0 ? '三维长度毫米刻度' : '三维头部相对进度刻度'}>
          {rulerTicks.map((tick, index) => (
            <span key={`${index}:${tick.worldRatio}`} style={{ left: `${tick.screenRatio * 100}%` }}>
              <i />
              <b>{lengthMm > 0 ? `${Math.round(tick.value)} mm` : `${Math.round(tick.worldRatio * 100)}%`}</b>
            </span>
          ))}
        </div>
        <div className="production-artifact-scrollbar-row">
          <div
            className={`production-artifact-scrollbar ${visibleFraction >= 0.995 ? 'is-disabled' : ''}`}
            role="scrollbar"
            aria-label="三维长度方向滚动条"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={lengthMm > 0 ? Math.round(lengthMm) : 100}
            aria-valuenow={lengthMm > 0
              ? Math.round(visibleRange[0] * lengthMm)
              : Math.round(visibleRange[0] * 100)}
            aria-valuetext={visibleFraction >= 0.995
              ? '全长'
              : lengthMm > 0
                ? `${Math.round(visibleRange[0] * lengthMm)} 至 ${Math.round(visibleRange[1] * lengthMm)} 毫米`
                : `头部进度 ${Math.round(visibleRange[0] * 100)}% 至 ${Math.round(visibleRange[1] * 100)}%`}
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
                title={lengthMm > 0
                  ? `当前缺陷位置 ${Math.round(clamp(focusPositionRatio, 0, 1) * lengthMm)} mm`
                  : `当前缺陷位于头部进度 ${Math.round(clamp(focusPositionRatio, 0, 1) * 100)}%`}
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
        </div>
      </div>
    </div>
  );
}
