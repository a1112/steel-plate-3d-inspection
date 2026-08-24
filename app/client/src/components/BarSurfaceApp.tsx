import { Canvas, useThree } from '@react-three/fiber';
import { AlertTriangle, ArrowLeft, Box, Camera, CircleDot, ExternalLink, FileJson, FolderOpen, Image as ImageIcon, Play, RefreshCw, Rotate3d, Square, Wrench } from 'lucide-react';
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type PointerEvent, type ReactNode } from 'react';
import {
  BufferGeometry,
  ClampToEdgeWrapping,
  DoubleSide,
  Float32BufferAttribute,
  MeshStandardMaterial,
  Texture,
  TextureLoader,
  Uint32BufferAttribute,
} from 'three';
import {
  barSurfaceFileUrl,
  cancelBarSurfaceProductionTask,
  captureBarSurfaceProductionOnce,
  fitBarSurfaceCalibration,
  fetchBarSurfaceCaptures,
  fetchBarSurfaceLatest,
  fetchBarSurfaceManifest,
  fetchBarSurfaceMesh,
  fetchBarSurfaceProductionStatus,
  fetchBarSurfaceRuns,
  runBarSurfaceProductionAlgorithm,
  sendBarSurfaceProductionEvent,
  type BarSurfaceCamera,
  type BarSurfaceCalibrationFitReport,
  type BarSurfaceCaptureMaterial,
  type BarSurfaceLatestResponse,
  type BarSurfaceManifest,
  type BarSurfaceMesh,
  type BarSurfaceProductionStatus,
  type BarSurfaceProductionTask,
  type BarSurfaceRun,
  type BarSurfaceRuntimeConfiguration,
} from '../services/bar-surface-api';
import {
  activateCaptureCalibration,
  chooseCaptureLocalFile,
  defaultCaptureProfileName,
  openCaptureLocalPath,
  readActiveCaptureCalibration,
  readCaptureLocalTextFile,
  type ActiveCaptureCalibration,
} from '../lib/capture-api';
import { hasStoredAdminSession } from '../services/inspection-api';
import { inferNotificationTone, notify } from '../state/notifications';
import { DEFAULT_SYSTEM_NAME } from '../lib/system-brand';

function numberText(value: number | undefined, fractionDigits = 0) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '-';
  }
  return value.toLocaleString('zh-CN', { maximumFractionDigits: fractionDigits });
}

function metricText(value: number | undefined, unit = 'mm', fractionDigits = 2) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '-';
  }
  return `${value.toLocaleString('zh-CN', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}${unit}`;
}

function percentText(value: number | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '-';
  }
  return `${(value * 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function byteText(value: number | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    return '-';
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toLocaleString('zh-CN', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}MB`;
  }
  return `${(value / 1024).toLocaleString('zh-CN', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}KB`;
}

function compactPath(value: string | undefined, keepSegments = 4) {
  if (!value) {
    return '-';
  }
  const parts = value.replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.length <= keepSegments) {
    return value;
  }
  return `.../${parts.slice(-keepSegments).join('/')}`;
}

function calibrationTone(path: string | undefined) {
  return path?.toLowerCase().includes('corrected') ? '已使用修正标定' : '原始/未修正标定';
}

function timestampSegment(date = new Date()) {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function createMaterialId() {
  return `BAR-${timestampSegment()}`;
}

function configNumber(camera: BarSurfaceCamera, key: string) {
  const value = camera.captureConfig?.[key];
  return typeof value === 'number' ? value : undefined;
}

function normalizeMeshPositions(positions: ArrayLike<number>) {
  if (positions.length === 0 || positions.length % 3 !== 0) {
    throw new Error('3D 网格顶点数据为空或格式不完整');
  }
  const normalized = new Float32Array(positions.length);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index];
    const y = positions[index + 1];
    const z = positions[index + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`3D 网格包含无效顶点（索引 ${index / 3}）`);
    }
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
  for (let index = 0; index < positions.length; index += 3) {
    normalized[index] = (positions[index] - centerX) * scale;
    normalized[index + 1] = (positions[index + 1] - centerY) * scale;
    normalized[index + 2] = (positions[index + 2] - centerZ) * scale;
  }
  return normalized;
}

function createGeometry(mesh: BarSurfaceMesh) {
  const vertexCount = mesh.positions.length / 3;
  if (mesh.uvs.length !== vertexCount * 2 || mesh.colors.length !== vertexCount * 3) {
    throw new Error('3D 网格顶点、UV 或颜色数量不一致');
  }
  if (mesh.indices.length === 0 || mesh.indices.length % 3 !== 0) {
    throw new Error('3D 网格三角面索引为空或格式不完整');
  }
  for (let index = 0; index < mesh.indices.length; index += 1) {
    if (!Number.isInteger(mesh.indices[index]) || mesh.indices[index] < 0 || mesh.indices[index] >= vertexCount) {
      throw new Error(`3D 网格包含越界索引（位置 ${index}）`);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(normalizeMeshPositions(mesh.positions), 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(new Float32Array(mesh.uvs), 2));
  geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(mesh.colors), 3));
  geometry.setIndex(new Uint32BufferAttribute(new Uint32Array(mesh.indices), 1));
  geometry.computeVertexNormals();
  return geometry;
}

function jetColor(value: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, value));
  const r = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 3)));
  const g = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 2)));
  const b = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 1)));
  return [r, g, b];
}

function createJetGeometry(mesh: BarSurfaceMesh) {
  const geometry = createGeometry(mesh);
  const radii: number[] = [];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    radii.push(Math.hypot(mesh.positions[index], mesh.positions[index + 2]));
  }
  const sorted = radii.filter(Number.isFinite).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const deviations = radii.map((value) => value - median);
  const absolute = deviations.map(Math.abs).sort((a, b) => a - b);
  const range = Math.max(absolute[Math.floor(absolute.length * 0.98)] ?? 0, 0.05);
  const colors = new Float32Array(radii.length * 3);
  deviations.forEach((value, index) => {
    const [r, g, b] = jetColor(0.5 + value / (2 * range));
    colors[index * 3] = r;
    colors[index * 3 + 1] = g;
    colors[index * 3 + 2] = b;
  });
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return geometry;
}

function createStitchBoundaryGeometry(mesh: BarSurfaceMesh) {
  const geometry = new BufferGeometry();
  const normalized = normalizeMeshPositions(mesh.positions);
  const fullCols = mesh.colsPerCamera * mesh.cameraCount;
  const positions: number[] = [];
  const addColumn = (col: number) => {
    for (let row = 0; row < mesh.rows - 1; row += 1) {
      const firstIndex = row * fullCols + col;
      const secondIndex = (row + 1) * fullCols + col;
      if ((mesh.validMask && (!mesh.validMask[firstIndex] || !mesh.validMask[secondIndex]))) continue;
      const first = firstIndex * 3;
      const second = secondIndex * 3;
      if (![normalized[first], normalized[first + 1], normalized[first + 2], normalized[second], normalized[second + 1], normalized[second + 2]].every(Number.isFinite)) continue;
      positions.push(
        normalized[first], normalized[first + 1], normalized[first + 2],
        normalized[second], normalized[second + 1], normalized[second + 2],
      );
    }
  };
  for (let boundary = 0; boundary < mesh.cameraCount; boundary += 1) {
    const rightColumn = boundary * mesh.colsPerCamera;
    const leftColumn = boundary === 0 ? fullCols - 1 : rightColumn - 1;
    addColumn(leftColumn);
    addColumn(rightColumn);
  }
  geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(positions), 3));
  return geometry;
}

type SectionCircleFit = {
  available: boolean;
  centerX: number;
  centerZ: number;
  radius: number;
  meanAbsResidual: number;
  maxAbsResidual: number;
  pointCount: number;
};

type SectionPoint = {
  x: number;
  z: number;
  cameraIndex: number;
  calibrated: boolean;
};

type CircleOverlay = {
  centerX: number;
  centerZ: number;
  radius: number;
};

function solve3x3(matrix: number[][], vector: number[]) {
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
        pivot = row;
      }
    }
    if (Math.abs(a[pivot][col]) < 1e-9) {
      return null;
    }
    if (pivot !== col) {
      [a[pivot], a[col]] = [a[col], a[pivot]];
    }
    const divisor = a[col][col];
    for (let item = col; item < 4; item += 1) {
      a[col][item] /= divisor;
    }
    for (let row = 0; row < 3; row += 1) {
      if (row === col) {
        continue;
      }
      const factor = a[row][col];
      for (let item = col; item < 4; item += 1) {
        a[row][item] -= factor * a[col][item];
      }
    }
  }
  return [a[0][3], a[1][3], a[2][3]];
}

function fitSectionCircle(points: SectionPoint[]): SectionCircleFit | null {
  if (points.length < 8) {
    return null;
  }
  let sxx = 0;
  let sxz = 0;
  let sx = 0;
  let szz = 0;
  let sz = 0;
  let sy = 0;
  let sxy = 0;
  let szy = 0;
  for (const point of points) {
    const y = point.x * point.x + point.z * point.z;
    const ax = 2 * point.x;
    const az = 2 * point.z;
    sxx += ax * ax;
    sxz += ax * az;
    sx += ax;
    szz += az * az;
    sz += az;
    sy += y;
    sxy += ax * y;
    szy += az * y;
  }
  const solved = solve3x3(
    [
      [sxx, sxz, sx],
      [sxz, szz, sz],
      [sx, sz, points.length],
    ],
    [sxy, szy, sy],
  );
  if (!solved) {
    return null;
  }
  const [centerX, centerZ, c] = solved;
  const radius = Math.sqrt(Math.max(c + centerX * centerX + centerZ * centerZ, 0));
  if (!Number.isFinite(radius) || radius <= 0) {
    return null;
  }
  let residualSum = 0;
  let maxAbsResidual = 0;
  for (const point of points) {
    const residual = Math.abs(Math.hypot(point.x - centerX, point.z - centerZ) - radius);
    residualSum += residual;
    maxAbsResidual = Math.max(maxAbsResidual, residual);
  }
  return {
    available: true,
    centerX,
    centerZ,
    radius,
    meanAbsResidual: residualSum / points.length,
    maxAbsResidual,
    pointCount: points.length,
  };
}

function sectionPointsForRow(mesh: BarSurfaceMesh, row: number): SectionPoint[] {
  const fullCols = mesh.colsPerCamera * mesh.cameraCount;
  const safeRow = Math.max(0, Math.min(mesh.rows - 1, row));
  const rowOffset = safeRow * fullCols;
  const points: SectionPoint[] = [];
  for (let col = 0; col < fullCols; col += 1) {
    const vertexIndex = rowOffset + col;
    if (mesh.validMask && !mesh.validMask[vertexIndex]) {
      continue;
    }
    const base = vertexIndex * 3;
    const x = Number(mesh.positions[base]);
    const z = Number(mesh.positions[base + 2]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      continue;
    }
    points.push({
      x,
      z,
      cameraIndex: Math.floor(col / Math.max(1, mesh.colsPerCamera)),
      calibrated: !!mesh.calibratedMask?.[vertexIndex],
    });
  }
  return points;
}

function circleFromManifest(manifest: BarSurfaceManifest): CircleOverlay | null {
  const circle = manifest.quality?.contourCrop?.circleFit ?? manifest.mesh.contourCrop?.circleFit ?? manifest.quality?.circleFit;
  if (!circle?.available || typeof circle.centerX !== 'number' || typeof circle.centerZ !== 'number' || typeof circle.radius !== 'number') {
    return null;
  }
  return { centerX: circle.centerX, centerZ: circle.centerZ, radius: circle.radius };
}

function BarSurfaceSectionView({
  mesh,
  manifest,
  row,
  zoom,
  onZoomChange,
}: {
  mesh: BarSurfaceMesh;
  manifest: BarSurfaceManifest;
  row: number;
  zoom: number;
  onZoomChange: (zoom: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const points = useMemo(() => sectionPointsForRow(mesh, row), [mesh, row]);
  const sectionFit = useMemo(() => fitSectionCircle(points), [points]);
  const contourCircle = useMemo(() => circleFromManifest(manifest), [manifest]);
  const yValue = points.length > 0 ? Number(mesh.positions[(Math.max(0, Math.min(mesh.rows - 1, row)) * mesh.colsPerCamera * mesh.cameraCount) * 3 + 1]) : undefined;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const width = rect.width;
      const height = rect.height;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#071825';
      ctx.fillRect(0, 0, width, height);

      const circles = [sectionFit, contourCircle].filter(Boolean) as Array<{ centerX: number; centerZ: number; radius: number }>;
      const xs = points.map((point) => point.x);
      const zs = points.map((point) => point.z);
      for (const circle of circles) {
        xs.push(circle.centerX - circle.radius, circle.centerX + circle.radius);
        zs.push(circle.centerZ - circle.radius, circle.centerZ + circle.radius);
      }
      if (xs.length === 0 || zs.length === 0) {
        ctx.fillStyle = '#9bdde9';
        ctx.font = '14px sans-serif';
        ctx.fillText('当前切面没有有效点', 24, 36);
        return;
      }
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minZ = Math.min(...zs);
      const maxZ = Math.max(...zs);
      const padding = 28;
      const spanX = Math.max(1, maxX - minX);
      const spanZ = Math.max(1, maxZ - minZ);
      const drawableWidth = Math.max(1, width - padding * 2);
      const drawableHeight = Math.max(1, height - padding * 2);
      const scale = Math.max(0.0001, Math.min(drawableWidth / spanX, drawableHeight / spanZ) * zoom);
      const centerX = (minX + maxX) / 2;
      const centerZ = (minZ + maxZ) / 2;
      const toX = (x: number) => width / 2 + (x - centerX) * scale;
      const toY = (z: number) => height / 2 - (z - centerZ) * scale;
      const cameraColors = ['#6ee7b7', '#7dd3fc', '#c4b5fd', '#fcd34d', '#fb7185', '#93c5fd'];

      ctx.strokeStyle = 'rgba(155, 221, 233, 0.12)';
      ctx.lineWidth = 1;
      for (let index = 0; index <= 4; index += 1) {
        const x = padding + ((width - padding * 2) * index) / 4;
        const y = padding + ((height - padding * 2) * index) / 4;
        ctx.beginPath();
        ctx.moveTo(x, padding);
        ctx.lineTo(x, height - padding);
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
      }

      if (contourCircle) {
        const radius = Math.max(0, contourCircle.radius * scale);
        ctx.setLineDash([7, 5]);
        ctx.strokeStyle = 'rgba(255, 196, 92, 0.78)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(toX(contourCircle.centerX), toY(contourCircle.centerZ), radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (sectionFit) {
        const radius = Math.max(0, sectionFit.radius * scale);
        ctx.strokeStyle = 'rgba(134, 239, 172, 0.9)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(toX(sectionFit.centerX), toY(sectionFit.centerZ), radius, 0, Math.PI * 2);
        ctx.stroke();
      }

      for (const point of points) {
        ctx.fillStyle = cameraColors[point.cameraIndex % cameraColors.length];
        ctx.globalAlpha = point.calibrated ? 0.88 : 0.46;
        ctx.beginPath();
        ctx.arc(toX(point.x), toY(point.z), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#dff8ff';
      ctx.font = '12px sans-serif';
      ctx.fillText('绿色=当前切面拟合，黄色虚线=全局轮廓', padding, height - 12);
    };
    draw();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
    if (observer) {
      observer.observe(canvas);
    }
    window.addEventListener('resize', draw);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', draw);
    };
  }, [contourCircle, manifest, mesh, points, row, sectionFit, zoom]);

  return (
    <div className="bar-surface-section-view">
      <canvas ref={canvasRef} aria-label="圆钢横截面拟合预览" />
      <div className="bar-surface-section-stats">
        <span>切面 {row + 1}/{mesh.rows}</span>
        <span>Y {metricText(yValue, 'mm', 1)}</span>
        <span>点 {numberText(points.length)}</span>
        <span>半径 {metricText(sectionFit?.radius)}</span>
        <span>残差 {metricText(sectionFit?.meanAbsResidual)}</span>
        <span>最大 {metricText(sectionFit?.maxAbsResidual)}</span>
      </div>
      <div className="bar-surface-section-zoom" role="group" aria-label="切面缩放">
        <button type="button" aria-label="缩小切面" onClick={() => onZoomChange(Math.max(0.5, Number((zoom - 0.25).toFixed(2))))}>−</button>
        <button type="button" aria-label="复位切面缩放" onClick={() => onZoomChange(1)}>{Math.round(zoom * 100)}%</button>
        <button type="button" aria-label="放大切面" onClick={() => onZoomChange(Math.min(6, Number((zoom + 0.25).toFixed(2))))}>+</button>
      </div>
    </div>
  );
}

function BarSurfaceCameraRig({ zoom }: { zoom: number }) {
  const { camera } = useThree();

  useEffect(() => {
    camera.position.set(0, 1.1, 5.2 / zoom);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, zoom]);

  return null;
}

const MODEL_MIN_ZOOM = 0.35;
const MODEL_MAX_ZOOM = 3.5;
const MODEL_ZOOM_STEP = 0.12;
const MODEL_YAW_SENSITIVITY = 0.009;
const MODEL_PITCH_SENSITIVITY = 0.007;
const MODEL_MIN_PITCH = -Math.PI * 0.49;
const MODEL_MAX_PITCH = Math.PI * 0.49;

function BarSurfaceMeshView({
  mesh,
  textureUrl,
  yaw,
  pitch,
  zoom,
  colorMode,
  showStitchRegions,
  onTextureError,
}: {
  mesh: BarSurfaceMesh;
  textureUrl: string;
  yaw: number;
  pitch: number;
  zoom: number;
  colorMode: 'texture' | 'jet';
  showStitchRegions: boolean;
  onTextureError: (message: string | null) => void;
}) {
  const geometry = useMemo(() => colorMode === 'jet' ? createJetGeometry(mesh) : createGeometry(mesh), [colorMode, mesh]);
  const stitchGeometry = useMemo(() => createStitchBoundaryGeometry(mesh), [mesh]);
  const [texture, setTexture] = useState<Texture | null>(null);

  useEffect(() => {
    let active = true;
    setTexture(null);
    onTextureError(null);
    const loader = new TextureLoader();
    loader.setCrossOrigin('anonymous');
    const pendingTexture = loader.load(
      textureUrl,
      (loadedTexture) => {
        if (!active) {
          loadedTexture.dispose();
          return;
        }
        loadedTexture.wrapS = ClampToEdgeWrapping;
        loadedTexture.wrapT = ClampToEdgeWrapping;
        loadedTexture.flipY = false;
        loadedTexture.needsUpdate = true;
        setTexture(loadedTexture);
      },
      undefined,
      () => {
        if (active) {
          setTexture(null);
          onTextureError('2D 贴图加载失败，已降级为顶点着色，3D 模型仍可操作');
        }
      },
    );
    return () => {
      active = false;
      pendingTexture.dispose();
    };
  }, [onTextureError, textureUrl]);

  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        map: colorMode === 'texture' ? texture : null,
        vertexColors: true,
        side: DoubleSide,
        roughness: 0.82,
        metalness: 0.04,
      }),
    [colorMode, texture],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      stitchGeometry.dispose();
      material.dispose();
    },
    [geometry, material, stitchGeometry],
  );

  return (
    <group rotation={[pitch, yaw, 0]} scale={[zoom, zoom, zoom]}>
      <mesh geometry={geometry} material={material} />
      {showStitchRegions ? (
        <lineSegments geometry={stitchGeometry} renderOrder={8}>
          <lineBasicMaterial color="#ffd43b" transparent opacity={0.96} depthTest={false} />
        </lineSegments>
      ) : null}
    </group>
  );
}

class BarSurface3DErrorBoundary extends Component<
  { children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : 'WebGL 渲染失败' };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Bar surface 3D renderer failed', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="bar-surface-empty" role="alert">
          <Box size={32} />
          <strong>3D 渲染已安全停止</strong>
          <span>{this.state.error}</span>
          <span>可切换重建版本或返回主界面，应用不会退出。</span>
        </div>
      );
    }
    return this.props.children;
  }
}

function BarSurfaceModelPanel({
  manifest,
  mesh,
  meshError,
  expectedCameraCount,
}: {
  manifest: BarSurfaceManifest;
  mesh: BarSurfaceMesh | null;
  meshError: string | null;
  expectedCameraCount: number;
}) {
  const [yaw, setYaw] = useState(-0.55);
  const [pitch, setPitch] = useState(-0.18);
  const [zoom, setZoom] = useState(1);
  const [sectionZoom, setSectionZoom] = useState(1);
  const [viewMode, setViewMode] = useState<'3d' | 'section'>('3d');
  const [colorMode, setColorMode] = useState<'texture' | 'jet'>(() => new URLSearchParams(window.location.search).get('view') === 'jet' ? 'jet' : 'texture');
  const [showStitchRegions, setShowStitchRegions] = useState(false);
  const [textureError, setTextureError] = useState<string | null>(null);
  const modelCanvasRef = useRef<HTMLDivElement | null>(null);
  const [sectionRow, setSectionRow] = useState(() => Math.max(0, Math.floor((mesh?.rows ?? manifest.mesh.rows) / 2)));
  const dragState = useRef<{ pointerId: number; x: number; y: number; yaw: number; pitch: number } | null>(null);
  const textureUrl = barSurfaceFileUrl(manifest.relative.texture || manifest.mesh.texture);
  const circleFit = manifest.quality?.circleFit;
  const seamGap = manifest.quality?.seamGapMm;
  const calibration = manifest.calibration;
  const inputCrop = manifest.inputCrop;
  const completeness = manifest.quality?.surfaceCompleteness;
  const contourCrop = manifest.quality?.contourCrop ?? manifest.mesh.contourCrop;
  const coordinateFrame = manifest.mesh.coordinateFrame ?? manifest.quality?.coordinateFrame;
  const angularSectorFit = manifest.mesh.angularSectorFit ?? manifest.quality?.angularSectorFit;
  const core = manifest.core;
  const acceptance = manifest.acceptance;
  const acceptanceStatus = acceptance?.status || (manifest.reports?.acceptanceReport ? 'ready' : '');
  const acceptanceReportUrl = manifest.reports?.acceptanceReport
    ? barSurfaceFileUrl(manifest.relative.acceptanceReport || manifest.reports.acceptanceReport)
    : '';
  const artifactIndexUrl = manifest.reports?.artifactIndex
    ? barSurfaceFileUrl(manifest.relative.artifactIndex || manifest.reports.artifactIndex)
    : '';
  const modelSource =
    mesh?.source === 'core-bsmesh'
      ? `C++ Core ${byteText(mesh.binaryBytes)}`
      : mesh?.source === 'json'
        ? 'JSON 回退'
        : core?.available
          ? `C++ Core ${byteText(core.summary?.outputBytes)}`
          : 'JSON';
  const handleTextureError = useCallback((message: string | null) => setTextureError(message), []);

  useEffect(() => {
    const rows = mesh?.rows ?? manifest.mesh.rows;
    setSectionRow((current) => Math.max(0, Math.min(Math.max(0, rows - 1), current)));
  }, [manifest.mesh.rows, mesh?.rows]);

  const stopDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) {
      return;
    }
    dragState.current = null;
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    const element = modelCanvasRef.current;
    if (!element) {
      return;
    }
    const handleWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      if (viewMode === '3d') {
        setZoom((current) => Math.max(MODEL_MIN_ZOOM, Math.min(MODEL_MAX_ZOOM, Number((current + direction * MODEL_ZOOM_STEP).toFixed(2)))));
      } else {
        setSectionZoom((current) => Math.max(0.5, Math.min(6, Number((current * (direction > 0 ? 1.12 : 1 / 1.12)).toFixed(2)))));
      }
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [viewMode]);

  return (
    <section className="bar-surface-panel bar-surface-model-panel">
      <header className="bar-surface-panel-header">
        <div>
          <span>3D 重建</span>
          <strong>{expectedCameraCount} 相机闭合表面 + 2D 贴图</strong>
        </div>
        <div className="bar-surface-icon-row">
          <div className="bar-surface-view-switch" role="tablist" aria-label="模型显示模式">
            <button type="button" className={viewMode === '3d' ? 'active' : ''} onClick={() => setViewMode('3d')}>
              3D
            </button>
            <button type="button" className={viewMode === 'section' ? 'active' : ''} onClick={() => setViewMode('section')}>
              切面
            </button>
          </div>
          <div className="bar-surface-view-switch" role="group" aria-label="模型着色模式">
            <button type="button" className={colorMode === 'texture' ? 'active' : ''} onClick={() => setColorMode('texture')}>贴图</button>
            <button type="button" className={colorMode === 'jet' ? 'active' : ''} onClick={() => setColorMode('jet')}>Jet 高度</button>
          </div>
          <button
            type="button"
            className={`bar-surface-stitch-toggle ${showStitchRegions ? 'active' : ''}`}
            aria-pressed={showStitchRegions}
            onClick={() => setShowStitchRegions((current) => !current)}
            disabled={viewMode !== '3d'}
          >
            拼接区域
          </button>
          <Rotate3d size={18} />
          <span>{numberText(manifest.mesh.vertexCount)} 顶点</span>
          <span>{numberText(manifest.mesh.triangleCount)} 面</span>
          {angularSectorFit?.applied ? (
            <span>
              扇区拟合 {angularSectorFit.cameras?.filter((camera) => (camera.resampledRows ?? 0) > 0).length ?? 0}/{manifest.cameraCount}
              {' · '}{angularSectorFit.direction === 'clockwise' ? '顺时针' : '逆时针'}
              {' · RMS '}{Number(angularSectorFit.fitScoreDegRms ?? 0).toFixed(2)}°
            </span>
          ) : null}
          {acceptanceStatus ? (
            <span className={`bar-surface-acceptance ${acceptanceStatus === 'pass' ? 'is-pass' : 'is-attention'}`}>
              验收 {acceptanceStatus}
            </span>
          ) : null}
          {acceptanceReportUrl ? (
            <a href={acceptanceReportUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={15} />
              验收
            </a>
          ) : null}
          {artifactIndexUrl ? (
            <a href={artifactIndexUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={15} />
              索引
            </a>
          ) : null}
        </div>
      </header>
      <div
        ref={modelCanvasRef}
        className={`bar-surface-canvas ${viewMode === 'section' ? 'is-section' : ''}`}
        onPointerDown={(event) => {
          if (viewMode !== '3d') {
            return;
          }
          if (event.button !== 0) {
            return;
          }
          dragState.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, yaw, pitch };
          if (typeof event.currentTarget.setPointerCapture === 'function') {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        }}
        onPointerMove={(event) => {
          if (viewMode !== '3d') {
            return;
          }
          const drag = dragState.current;
          if (!drag || drag.pointerId !== event.pointerId) {
            return;
          }
          setYaw(drag.yaw + (event.clientX - drag.x) * MODEL_YAW_SENSITIVITY);
          setPitch(Math.max(MODEL_MIN_PITCH, Math.min(MODEL_MAX_PITCH, drag.pitch + (event.clientY - drag.y) * MODEL_PITCH_SENSITIVITY)));
        }}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        {mesh ? (
          <>
          <div className={`bar-surface-three-view ${viewMode === '3d' ? '' : 'is-hidden'}`} aria-hidden={viewMode !== '3d'}>
          <BarSurface3DErrorBoundary key={`${manifest.runId}:${colorMode}`}>
            <Canvas camera={{ fov: 42, near: 0.1, far: 100 }} dpr={[1, 1.5]} frameloop="demand" gl={{ antialias: true }}>
              <BarSurfaceCameraRig zoom={zoom} />
              <color attach="background" args={['#071018']} />
              <ambientLight intensity={0.78} />
              <directionalLight position={[3, 4, 5]} intensity={1.4} />
              <directionalLight position={[-5, -2, -3]} intensity={0.45} />
              <BarSurfaceMeshView mesh={mesh} textureUrl={textureUrl} yaw={yaw} pitch={pitch} zoom={1} colorMode={colorMode} showStitchRegions={showStitchRegions} onTextureError={handleTextureError} />
            </Canvas>
          </BarSurface3DErrorBoundary>
          </div>
        {viewMode === 'section' ? (
          <>
                <BarSurfaceSectionView mesh={mesh} manifest={manifest} row={sectionRow} zoom={sectionZoom} onZoomChange={setSectionZoom} />
            <div className="bar-surface-section-slider">
              <span>头部</span>
              <input
                type="range"
                min={0}
                max={Math.max(0, mesh.rows - 1)}
                value={Math.max(0, Math.min(mesh.rows - 1, sectionRow))}
                onInput={(event) => setSectionRow(Number(event.currentTarget.value))}
                onChange={(event) => setSectionRow(Number(event.currentTarget.value))}
                aria-label="切面位置"
              />
              <span>尾部</span>
            </div>
          </>
        ) : null}
          </>
        ) : (
          <div className="bar-surface-empty">
            <Box size={32} />
            <strong>{meshError ? '3D 模型加载失败' : '正在加载 3D 模型'}</strong>
            <span>{meshError ?? '读取 G 盘 C++ bsmesh / mesh JSON 与贴图'}</span>
          </div>
        )}
        {viewMode === '3d' && colorMode === 'jet' ? (
          <div className="bar-surface-jet-legend" aria-label="Jet 高度色标">
            <span>内凹</span><i /><span>基准面</span><span>外凸</span>
          </div>
        ) : null}
        {viewMode === '3d' && textureError ? (
          <div className="bar-surface-stitch-legend" role="status">
            <strong>贴图降级</strong>
            <span>{textureError}</span>
          </div>
        ) : null}
        {viewMode === '3d' && showStitchRegions ? (
          <div className="bar-surface-stitch-legend" role="status">
            <strong>拼接边界</strong>
            <span>{manifest.cameraCount} 相机 · 每区 {Number(angularSectorFit?.sectorWidthDeg ?? (360 / Math.max(1, manifest.cameraCount))).toFixed(1)}°</span>
            <span>{angularSectorFit?.applied ? `角度拟合 RMS ${Number(angularSectorFit.fitScoreDegRms ?? 0).toFixed(2)}°` : '按相机列边界标记'}</span>
          </div>
        ) : null}
      </div>
      <footer className="bar-surface-model-meta">
        <span>帧数 {manifest.mesh.frameCount}</span>
        <span>网格 {manifest.mesh.rows} x {manifest.mesh.colsPerCamera * manifest.cameraCount}</span>
        <span>贴图 {manifest.mesh.textureSize.width} x {manifest.mesh.textureSize.height}</span>
        <span>标定 {calibration ? `${calibration.matchedCameras}/${calibration.totalCameras}` : '-'}</span>
        <span>2D裁剪 {inputCrop?.applied ? `${inputCrop.matchedCameras ?? 0}/${inputCrop.totalCameras ?? manifest.cameraCount}` : '-'}</span>
        <span>圆残差 {metricText(circleFit?.meanAbsResidual)}</span>
        {coordinateFrame?.applied ? (
          <span>
            圆心归零 ΔX {metricText(coordinateFrame.translationMm?.x)} / ΔZ {metricText(coordinateFrame.translationMm?.z)}
          </span>
        ) : null}
        <span>边界 gap {metricText(seamGap?.mean)}</span>
        <span>
          轮廓裁剪 {contourCrop?.applied ? `${percentText(contourCrop.keptPointRatio)} / ${metricText(contourCrop.radiusToleranceMm)}` : '-'}
        </span>
        <span>有效面 {percentText(completeness?.keptQuadRatio)}</span>
        <span>模型 {modelSource}</span>
        <span>算法版本 {manifest.algorithmVersion || '-'}</span>
        <span>配置版本 {manifest.configRevision || '-'}</span>
        <span>输入指纹 {manifest.inputSummarySha256 ? manifest.inputSummarySha256.slice(0, 12) : '-'}</span>
        <span>质量门禁 {manifest.qualityGate?.passed ? '通过' : '未通过'}</span>
        {acceptance ? <span>检查 {acceptance.passedChecks ?? 0}/{acceptance.totalChecks ?? 0}</span> : null}
        <span>Release {manifest.releaseCommit ? manifest.releaseCommit.slice(0, 12) : '-'}</span>
        <span>Qualification {manifest.acceptanceReportSha256 ? manifest.acceptanceReportSha256.slice(0, 12) : '-'}</span>
      </footer>
    </section>
  );
}

function BarSurfaceCameraTile({ camera }: { camera: BarSurfaceCamera }) {
  const intensityUrl = barSurfaceFileUrl(camera.relative.intensityPreview || camera.latest.intensityPreview);
  const depthUrl = barSurfaceFileUrl(camera.relative.depthPreview || camera.latest.depthPreview);
  const timeFreq = configNumber(camera, 'timeTriggerFreq');
  const maxFrameRate = configNumber(camera, 'maxFrameRate');
  const triggerLines = configNumber(camera, 'triggerLines');

  return (
    <article className="bar-surface-camera-tile" data-testid={`bar-surface-camera-${camera.name}`}>
      <header>
        <div>
          <strong>{camera.name}</strong>
          <span>{camera.ip}</span>
        </div>
        <span className="bar-surface-camera-frame">#{camera.latestFrame}</span>
      </header>
      <div className="bar-surface-camera-images">
        <figure>
          <img src={intensityUrl} alt={`${camera.name} intensity`} loading="eager" decoding="async" />
          <figcaption>亮度</figcaption>
        </figure>
        <figure>
          <img src={depthUrl} alt={`${camera.name} depth`} loading="eager" decoding="async" />
          <figcaption>深度</figcaption>
        </figure>
      </div>
      <dl>
        <div>
          <dt>帧</dt>
          <dd>{camera.frameCount}</dd>
        </div>
        <div>
          <dt>尺寸</dt>
          <dd>{camera.size.width} x {camera.size.height}</dd>
        </div>
        <div>
          <dt>触发行</dt>
          <dd>{numberText(triggerLines)}</dd>
        </div>
        <div>
          <dt>时间触发</dt>
          <dd>{numberText(timeFreq)} Hz</dd>
        </div>
        <div>
          <dt>最快帧率</dt>
          <dd>{numberText(maxFrameRate)} Hz</dd>
        </div>
        <div>
          <dt>SN</dt>
          <dd title={camera.sn}>{camera.sn || '-'}</dd>
        </div>
        <div>
          <dt>标定</dt>
          <dd>{camera.calibrationApplied ? '已匹配' : '未匹配'}</dd>
        </div>
        <div>
          <dt>裁剪</dt>
          <dd title={camera.cropSource || ''}>{camera.cropSource === 'calibrated-3d-contour' ? '3D轮廓' : '图像'}</dd>
        </div>
      </dl>
    </article>
  );
}

function BarSurfaceCalibrationPanel({
  manifest,
  expectedCameraCount,
  fitReport,
  activeCalibration,
  busy,
  fitRunning,
  activationBusy,
  message,
  onFit,
  onActivate,
  onImportFitReport,
  onRefreshActive,
  onOpenVersionDirectory,
  onRunWithCalibration,
  activationSupported,
  activationUnsupportedReason,
}: {
  manifest: BarSurfaceManifest;
  expectedCameraCount: number;
  fitReport: BarSurfaceCalibrationFitReport | null;
  activeCalibration: ActiveCaptureCalibration | null;
  busy: boolean;
  fitRunning: boolean;
  activationBusy: boolean;
  message: string;
  onFit: () => void;
  onActivate: () => void;
  onImportFitReport: () => void;
  onRefreshActive: () => void;
  onOpenVersionDirectory: () => void;
  onRunWithCalibration: (calibrationPath: string) => void;
  activationSupported: boolean;
  activationUnsupportedReason: string;
}) {
  const calibration = manifest.calibration;
  const currentPath = calibration?.path || '';
  const fittedPath = fitReport?.correctedXml || '';
  const beforeResidual = fitReport?.fitBefore?.meanAbsResidual;
  const afterResidual = fitReport?.fitAfter?.meanAbsResidual;
  const contourCrop = manifest.quality?.contourCrop ?? manifest.mesh.contourCrop;
  const correctedReady = Boolean(fittedPath);
  return (
    <section className="bar-surface-panel bar-surface-calibration-panel" data-testid="bar-surface-calibration-panel">
      <header className="bar-surface-panel-header">
        <div>
          <span>标定修正</span>
          <strong>当前阵列标定与横截面拟合</strong>
        </div>
        <div className="bar-surface-icon-row">
          <Wrench size={18} />
          <span className={currentPath.toLowerCase().includes('corrected') ? 'is-calibrated' : 'is-attention'}>
            {calibrationTone(currentPath)}
          </span>
          <span>{calibration ? `${calibration.matchedCameras}/${calibration.totalCameras}` : '-'}</span>
        </div>
      </header>
      <div className="bar-surface-calibration-body">
        <dl className="bar-surface-calibration-facts">
          <div>
            <dt>当前 XML</dt>
            <dd title={currentPath}>{compactPath(currentPath, 5)}</dd>
          </div>
          <div>
            <dt>输入裁剪</dt>
            <dd>{manifest.inputCrop?.source || '-'}</dd>
          </div>
          <div>
            <dt>轮廓裁剪</dt>
            <dd>{contourCrop?.applied ? `${percentText(contourCrop.keptPointRatio)} / ${metricText(contourCrop.radiusToleranceMm)}` : '-'}</dd>
          </div>
          <div>
            <dt>圆残差</dt>
            <dd>{metricText(manifest.quality?.circleFit?.meanAbsResidual)}</dd>
          </div>
          <div>
            <dt>最新拟合</dt>
            <dd>{fitReport ? `${fitReport.cameraCount ?? 0}/${fitReport.expectedCameras ?? expectedCameraCount}，相比 ${metricText(beforeResidual)} -> ${metricText(afterResidual)}` : '未运行'}</dd>
          </div>
          <div>
            <dt>修正 XML</dt>
            <dd title={fittedPath}>{compactPath(fittedPath, 5)}</dd>
          </div>
          <div>
            <dt>采集端当前版本</dt>
            <dd title={activeCalibration?.calibrationPath || ''}>
              {activeCalibration?.activeCalibration?.version || compactPath(activeCalibration?.calibrationFile || '', 4) || '未读取'}
            </dd>
          </div>
        </dl>
        <div className="bar-surface-calibration-actions">
          <button type="button" onClick={onImportFitReport} disabled={busy}>
            <FileJson size={16} />
            导入 fit_report
          </button>
          <button type="button" onClick={onRefreshActive} disabled={busy || !activationSupported} title={activationSupported ? undefined : activationUnsupportedReason}>
            <RefreshCw size={16} />
            刷新当前版本
          </button>
          <button type="button" onClick={onOpenVersionDirectory} disabled={busy || (!fitReport?.outputDir && !activeCalibration?.versionRoot)}>
            <FolderOpen size={16} />
            打开版本目录
          </button>
          <button type="button" onClick={onFit} disabled={busy}>
            <Wrench size={16} />
            {fitRunning ? '拟合中' : '自动标定修正'}
          </button>
          <button type="button" onClick={() => onRunWithCalibration(fittedPath || currentPath)} disabled={busy || (!fittedPath && !currentPath)}>
            <Play size={16} />
            {correctedReady ? '用新修正标定重建' : '用当前标定重建'}
          </button>
          <button type="button" onClick={onActivate} disabled={busy || !fittedPath || !activationSupported} title={activationSupported ? undefined : activationUnsupportedReason}>
            <Square size={16} />
            {activationBusy ? '激活中' : '手动激活当前修正'}
          </button>
        </div>
        {!activationSupported ? (
          <div className="capture-calibration-safety" role="note">
            <AlertTriangle size={16} />
            <span>{activationUnsupportedReason}拟合、对比和指定 XML 重建仍可使用。</span>
          </div>
        ) : null}
        {fitReport?.beforePreview || fitReport?.afterPreview ? (
          <div className="bar-surface-calibration-previews">
            {fitReport.beforePreview ? (
              <figure>
                <img src={barSurfaceFileUrl(fitReport.beforePreview)} alt="阵列标定修正前横截面" />
                <figcaption>修正前 · 平均残差 {metricText(beforeResidual)}</figcaption>
              </figure>
            ) : null}
            {fitReport.afterPreview ? (
              <figure>
                <img src={barSurfaceFileUrl(fitReport.afterPreview)} alt="阵列标定修正后横截面" />
                <figcaption>修正后 · 平均残差 {metricText(afterResidual)}</figcaption>
              </figure>
            ) : null}
          </div>
        ) : null}
        {fitReport?.corrections?.length ? (
          <div className="bar-surface-calibration-comparison-wrap">
            <table className="bar-surface-calibration-comparison">
              <thead>
                <tr><th>相机</th><th>SN</th><th>dx</th><th>dz</th><th>位移</th><th>修正前均值</th><th>修正前最大</th><th>修正后均值</th><th>修正后最大</th></tr>
              </thead>
              <tbody>
                {fitReport.corrections.map((item, index) => (
                  <tr key={`${item.ip || item.sn || 'camera'}-${index}`}>
                    <td>{item.ip || '-'}</td><td>{item.sn || '-'}</td>
                    <td>{metricText(item.dx)}</td><td>{metricText(item.dz)}</td>
                    <td>{metricText(item.shiftMagnitude)}</td>
                    <td>{metricText(item.before?.meanAbsResidual)}</td>
                    <td>{metricText(item.before?.maxAbsResidual)}</td>
                    <td>{metricText(item.after?.meanAbsResidual)}</td>
                    <td>{metricText(item.after?.maxAbsResidual)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="bar-surface-calibration-safety">
          阵列 XML 仅用于重建；逐相机 SDK 文件下发位于“采集配置 → 受控开发诊断”，必须先预检、支持回滚，且默认不持久化到设备。
        </p>
        {message ? <p className="bar-surface-calibration-message">{message}</p> : null}
      </div>
    </section>
  );
}

function BarSurfaceHeader({
  latest,
  manifest,
  expectedCameraCount,
  productionStatus,
  captureMaterials,
  selectedMaterialId,
  runs,
  selectedRunId,
  loading,
  running,
  workflowBusy,
  workflowMessage,
  activeTask,
  runtimeConfiguration,
  onRefresh,
  onSteelIn,
  onCaptureOnce,
  onSteelOut,
  onRun,
  onCancelTask,
  onMaterialChange,
  onRunChange,
}: {
  latest: BarSurfaceLatestResponse | null;
  manifest: BarSurfaceManifest | null;
  expectedCameraCount: number;
  productionStatus: BarSurfaceProductionStatus | null;
  captureMaterials: BarSurfaceCaptureMaterial[];
  selectedMaterialId: string;
  runs: BarSurfaceRun[];
  selectedRunId: string;
  loading: boolean;
  running: boolean;
  workflowBusy: boolean;
  workflowMessage: string;
  activeTask: BarSurfaceProductionTask<unknown> | null;
  runtimeConfiguration: BarSurfaceRuntimeConfiguration | null;
  onRefresh: () => void;
  onSteelIn: () => void;
  onCaptureOnce: () => void;
  onSteelOut: () => void;
  onRun: () => void;
  onCancelTask: () => void;
  onMaterialChange: (materialId: string) => void;
  onRunChange: (runId: string) => void;
}) {
  const latestInspection = productionStatus?.latestInspection;
  const runtimeConfigurationReady = runtimeConfiguration?.readback.ready !== false;
  const productionLabel = latestInspection
    ? `${latestInspection.status} / ${latestInspection.materialId}`
    : productionStatus?.capture?.phaseLabel || '-';
  return (
    <header className="bar-surface-header" data-testid="bar-surface-header">
      <div className="bar-surface-title">
        <button
          className="bar-surface-return-button"
          type="button"
          onClick={() => {
            window.location.href = '/?app=terminal';
          }}
        >
          <ArrowLeft size={16} />
          返回主界面
        </button>
        <span>棒材表面检测</span>
        <h1>3D 重建工作台</h1>
      </div>
      <div className="bar-surface-header-stack">
        <div className="bar-surface-status-strip">
          <div>
            <span>当前流水</span>
            <strong>{manifest?.materialId ?? (selectedMaterialId || '-')}</strong>
          </div>
          <div>
            <span>相机</span>
            <strong>{manifest ? `${manifest.cameraCount}/${expectedCameraCount}` : '-'}</strong>
          </div>
          <div>
            <span>算法数据</span>
            <strong>{latest?.root || runtimeConfiguration?.active.algorithmRoot || '等待服务端配置读取'}</strong>
          </div>
          <div>
            <span>算法配置</span>
            <strong className={runtimeConfigurationReady ? '' : 'status-error'}>
              {runtimeConfigurationReady
                ? runtimeConfiguration?.active.configRevision || manifest?.configRevision || '-'
                : '配置或目录不可用'}
            </strong>
          </div>
          <div>
            <span>更新时间</span>
            <strong>{latest?.latest.updatedAt ?? '-'}</strong>
          </div>
          <div>
            <span>生产检测</span>
            <strong>{productionLabel}</strong>
          </div>
          <div>
            <span>持久任务</span>
            <strong>
              {activeTask
                ? `${activeTask.kind} / ${activeTask.phase || activeTask.status} / ${activeTask.progress}%`
                : productionStatus?.tasks?.worker?.running
                  ? `空闲 / 队列 ${productionStatus.tasks.queueDepth ?? 0}`
                  : 'worker 离线'}
            </strong>
          </div>
        </div>
        <div className="bar-surface-calibration-summary">
          <span>标定</span>
          <strong>{manifest?.calibration ? `${manifest.calibration.matchedCameras}/${manifest.calibration.totalCameras} 已匹配` : '-'}</strong>
        </div>
        <div className="bar-surface-selector-row">
          <label>
            <span>采集流水</span>
            <select
              value={selectedMaterialId}
              onChange={(event) => onMaterialChange(event.target.value)}
              disabled={loading || running || captureMaterials.length === 0}
            >
              {captureMaterials.length === 0 ? <option value="">暂无采集流水</option> : null}
              {captureMaterials.map((item) => (
                <option key={item.materialId} value={item.materialId}>
                  {item.materialId} · {item.cameraCount}/{expectedCameraCount} · {item.minDepthFrames} 帧
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>重建版本</span>
            <select
              value={selectedRunId}
              onChange={(event) => onRunChange(event.target.value)}
              disabled={loading || running || runs.length === 0}
            >
              {runs.length === 0 ? <option value="">暂无重建版本</option> : null}
              {runs.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {run.runId} · {run.frameCount} 帧 · {numberText(run.vertexCount)} 点
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div className="bar-surface-actions">
        <button type="button" onClick={onRefresh} disabled={loading || running || workflowBusy}>
          <RefreshCw size={17} />
          刷新
        </button>
        <button type="button" onClick={onSteelIn} disabled={loading || running || workflowBusy}>
          <CircleDot size={17} />
          模拟进钢
        </button>
        <button type="button" onClick={onCaptureOnce} disabled={loading || running || workflowBusy}>
          <Camera size={17} />
          采集一轮
        </button>
        <button type="button" onClick={onSteelOut} disabled={loading || running || workflowBusy}>
          <Square size={17} />
          出钢结束
        </button>
        <button
          type="button"
          onClick={onRun}
          disabled={loading || running || workflowBusy || !runtimeConfigurationReady}
          title={runtimeConfigurationReady ? '运行当前服务端活动配置' : '请先修复算法配置、采集目录或算法输出目录'}
        >
          <Play size={17} />
          {running ? '生产重建中' : '运行生产重建'}
        </button>
        {activeTask && ['queued', 'running'].includes(activeTask.status) ? (
          <button type="button" onClick={onCancelTask}>
            <Square size={17} />
            取消任务
          </button>
        ) : null}
        {workflowMessage ? (
          <span className="bar-surface-workflow-message" aria-live="polite">
            {workflowMessage}
          </span>
        ) : null}
      </div>
    </header>
  );
}

export function BarSurfaceApp({
  expectedCameraCount = 8,
  systemName = DEFAULT_SYSTEM_NAME,
  captureProfileName,
  calibrationActivationSupported = true,
}: {
  expectedCameraCount?: number;
  systemName?: string;
  captureProfileName?: string;
  calibrationActivationSupported?: boolean;
}) {
  const calibrationProfileName = captureProfileName?.trim()
    || defaultCaptureProfileName(expectedCameraCount);
  const calibrationActivationUnsupportedReason = 'SICK Ranger3 采集 sidecar 不支持运行期写入阵列标定版本；';
  const [latest, setLatest] = useState<BarSurfaceLatestResponse | null>(null);
  const [mesh, setMesh] = useState<BarSurfaceMesh | null>(null);
  const [captureMaterials, setCaptureMaterials] = useState<BarSurfaceCaptureMaterial[]>([]);
  const [runs, setRuns] = useState<BarSurfaceRun[]>([]);
  const [productionStatus, setProductionStatus] = useState<BarSurfaceProductionStatus | null>(null);
  const [selectedMaterialId, setSelectedMaterialId] = useState(() => new URLSearchParams(window.location.search).get('materialId') || '');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [algorithmRoot, setAlgorithmRoot] = useState('');
  const [runtimeConfiguration, setRuntimeConfiguration] = useState<BarSurfaceRuntimeConfiguration | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [meshError, setMeshError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [workflowMessage, setWorkflowMessage] = useState('');
  const [activeTask, setActiveTask] = useState<BarSurfaceProductionTask<unknown> | null>(null);
  const [calibrationFitReport, setCalibrationFitReport] = useState<BarSurfaceCalibrationFitReport | null>(null);
  const [calibrationBusy, setCalibrationBusy] = useState(false);
  const [calibrationActivationBusy, setCalibrationActivationBusy] = useState(false);
  const [activeCalibration, setActiveCalibration] = useState<ActiveCaptureCalibration | null>(null);
  const [calibrationMessage, setCalibrationMessage] = useState('');

  useEffect(() => {
    if (!loadError) {
      return;
    }
    notify({ title: '3D 重建操作失败', message: loadError, tone: 'error' });
  }, [loadError]);

  useEffect(() => {
    if (!calibrationMessage) {
      return;
    }
    const tone = inferNotificationTone(calibrationMessage);
    notify({ title: tone === 'error' ? '标定操作失败' : '标定消息', message: calibrationMessage, tone });
  }, [calibrationMessage]);

  const refreshActiveCalibration = async () => {
    if (!calibrationActivationSupported) {
      setCalibrationMessage(`${calibrationActivationUnsupportedReason}当前页面仅读取算法标定产物。`);
      return null;
    }
    if (!hasStoredAdminSession()) {
      setCalibrationMessage('登录后台管理后可读取采集端当前标定；阵列重建标定不受影响。');
      return null;
    }
    try {
      const status = await readActiveCaptureCalibration();
      setActiveCalibration(status);
      setCalibrationMessage(`采集端当前标定已刷新：${status.activeCalibration?.version || compactPath(status.calibrationFile, 4)}`);
      return status;
    } catch (error) {
      setCalibrationMessage(error instanceof Error ? `采集端当前标定读取失败：${error.message}` : '采集端当前标定读取失败');
      return null;
    }
  };

  const handleImportCalibrationFitReport = async () => {
    try {
      const selected = await chooseCaptureLocalFile('导入阵列标定 fit_report', ['json']);
      if (!selected) {
        setCalibrationMessage('浏览器模式不能读取本地 fit_report；请使用 Tauri 桌面端。');
        return;
      }
      if (!selected.selected || !selected.path) {
        setCalibrationMessage('已取消导入 fit_report。');
        return;
      }
      const file = await readCaptureLocalTextFile(selected.path);
      if (!file) {
        setCalibrationMessage('浏览器模式不能读取本地 fit_report。');
        return;
      }
      const parsed = JSON.parse(file.text) as BarSurfaceCalibrationFitReport | { result?: BarSurfaceCalibrationFitReport };
      const report = 'result' in parsed && parsed.result ? parsed.result : parsed as BarSurfaceCalibrationFitReport;
      if (!report || typeof report !== 'object' || (!report.correctedXml && !report.outputDir)) {
        throw new Error('fit_report 缺少 correctedXml/outputDir');
      }
      setCalibrationFitReport(report);
      setCalibrationMessage(`已导入 fit_report：${file.path}（${file.bytes} bytes）`);
    } catch (error) {
      setCalibrationMessage(error instanceof Error ? `fit_report 导入失败：${error.message}` : 'fit_report 导入失败');
    }
  };

  const handleOpenCalibrationVersionDirectory = async () => {
    const path = calibrationFitReport?.outputDir || activeCalibration?.versionRoot || '';
    if (!path) {
      setCalibrationMessage('没有可打开的标定版本目录。');
      return;
    }
    try {
      const opened = await openCaptureLocalPath(path);
      setCalibrationMessage(opened ? `已打开标定版本目录：${path}` : '浏览器模式不能打开本地目录');
    } catch (error) {
      setCalibrationMessage(error instanceof Error ? error.message : '标定版本目录打开失败');
    }
  };

  const applyManifest = async (
    manifest: BarSurfaceManifest,
    nextLatest?: BarSurfaceLatestResponse,
    signal?: AbortSignal,
    run?: BarSurfaceRun,
  ) => {
    setLoadError(null);
    setMesh(null);
    setMeshError(null);
    const root = nextLatest?.root || algorithmRoot;
    setLatest(
      nextLatest ?? {
        code: 0,
        root,
        latest: {
          schema: 'steel.bar_surface.latest.v1',
          updatedAt: run?.createdAt || manifest.createdAt,
          algorithmRoot: root,
          materialId: manifest.materialId,
          runId: manifest.runId,
          runDir: manifest.runDir,
          manifestPath: run?.manifestPath || '',
        },
        manifest,
      },
    );
    setSelectedMaterialId(manifest.materialId);
    setSelectedRunId(manifest.runId);
    try {
      const nextMesh = await fetchBarSurfaceMesh(manifest, signal);
      setMesh(nextMesh);
    } catch (error) {
      if (!signal?.aborted) {
        setMeshError(error instanceof Error ? error.message : '3D 模型读取失败');
      }
    }
  };

  const refreshLists = async (materialId?: string, signal?: AbortSignal) => {
    const [capturesPayload, runsPayload, productionPayload] = await Promise.all([
      fetchBarSurfaceCaptures(signal),
      fetchBarSurfaceRuns(materialId, signal),
      fetchBarSurfaceProductionStatus(signal),
    ]);
    const materials = Array.isArray(capturesPayload.materials) ? capturesPayload.materials : [];
    const nextRuns = Array.isArray(runsPayload.runs) ? runsPayload.runs : [];
    const nextRoot = runsPayload.configuration?.active.algorithmRoot || runsPayload.root || algorithmRoot;
    setCaptureMaterials(materials);
    setRuns(nextRuns);
    setAlgorithmRoot(nextRoot);
    setRuntimeConfiguration(runsPayload.configuration ?? capturesPayload.configuration ?? null);
    setProductionStatus(productionPayload);
    return {
      captures: materials,
      runs: nextRuns,
      root: nextRoot,
      production: productionPayload,
    };
  };

  const loadLatest = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const requestedMaterialId = new URLSearchParams(window.location.search).get('materialId') || '';
      if (requestedMaterialId) {
        const listState = await refreshLists(requestedMaterialId, signal);
        const firstRun = listState.runs[0];
        setSelectedMaterialId(requestedMaterialId);
        if (!firstRun) {
          throw new Error(`流水 ${requestedMaterialId} 暂无重建结果`);
        }
        const manifest = await fetchBarSurfaceManifest(firstRun.manifestRelative || firstRun.manifestPath, signal);
        await applyManifest(manifest, undefined, signal, firstRun);
        return;
      }
      const [payload, listState] = await Promise.all([fetchBarSurfaceLatest(signal), refreshLists(undefined, signal)]);
      const materialId = payload.manifest.materialId || listState.captures[0]?.materialId || '';
      if (materialId) {
        const materialRuns = await fetchBarSurfaceRuns(materialId, signal);
        setRuns(materialRuns.runs);
        setAlgorithmRoot(materialRuns.root);
      }
      await applyManifest(payload.manifest, payload, signal);
    } catch (error) {
      if (signal?.aborted) {
        return;
      }
      try {
        const listState = await refreshLists(undefined, signal);
        const firstMaterial = listState.captures[0]?.materialId ?? '';
        setSelectedMaterialId(firstMaterial);
      } catch {
        // Keep the original algorithm-result error visible.
      }
      setLoadError(error instanceof Error ? error.message : '算法结果读取失败');
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    loadLatest(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!calibrationActivationSupported) {
      setCalibrationMessage(`${calibrationActivationUnsupportedReason}拟合与指定 XML 重建仍可使用。`);
      return;
    }
    if (!hasStoredAdminSession()) {
      setCalibrationMessage('登录后台管理后可读取采集端当前标定；阵列重建标定不受影响。');
      return;
    }
    let cancelled = false;
    readActiveCaptureCalibration(calibrationProfileName)
      .then((status) => {
        if (!cancelled) {
          setActiveCalibration(status);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCalibrationMessage(error instanceof Error ? `采集端当前标定读取失败：${error.message}` : '采集端当前标定读取失败');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [calibrationActivationSupported, calibrationProfileName]);

  useEffect(() => {
    document.title = `${systemName} - 3D 重建工作台`;
  }, [systemName]);

  const handleMaterialChange = async (materialId: string) => {
    setSelectedMaterialId(materialId);
    setSelectedRunId('');
    setCalibrationFitReport(null);
    setCalibrationMessage('');
    setLoading(true);
    setLoadError(null);
    try {
      const runsPayload = await fetchBarSurfaceRuns(materialId);
      setRuns(runsPayload.runs);
      setAlgorithmRoot(runsPayload.root);
      fetchBarSurfaceProductionStatus()
        .then(setProductionStatus)
        .catch(() => undefined);
      const firstRun = runsPayload.runs[0];
      if (firstRun) {
        const manifest = await fetchBarSurfaceManifest(firstRun.manifestRelative || firstRun.manifestPath);
        await applyManifest(manifest, undefined, undefined, firstRun);
      } else {
        setLatest(null);
        setMesh(null);
        setMeshError(null);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '重建版本读取失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRunChange = async (runId: string) => {
    setSelectedRunId(runId);
    setCalibrationFitReport(null);
    setCalibrationMessage('');
    const run = runs.find((item) => item.runId === runId);
    if (!run) {
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const manifest = await fetchBarSurfaceManifest(run.manifestRelative || run.manifestPath);
      await applyManifest(manifest, undefined, undefined, run);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '重建版本读取失败');
    } finally {
      setLoading(false);
    }
  };

  const refreshAfterWorkflow = async (materialId?: string) => {
    const listState = await refreshLists(materialId);
    if (materialId) {
      setSelectedMaterialId(materialId);
      setSelectedRunId('');
    }
    return listState;
  };

  const handleSteelIn = async () => {
    setWorkflowBusy(true);
    setLoadError(null);
    try {
      const materialId = createMaterialId();
      const payload = await sendBarSurfaceProductionEvent('steel-in', {
        materialId,
        acquisitionMode: 'manual',
        triggerMode: 'manual',
        autoCapture: false,
        steelType: 'round-bar',
      });
      const nextMaterialId = payload.materialId || materialId;
      setWorkflowMessage(`已进钢建档：${nextMaterialId}，采集保存已打开，等待手动采集。`);
      await refreshAfterWorkflow(nextMaterialId);
    } catch (error) {
      setWorkflowMessage('');
      setLoadError(error instanceof Error ? error.message : '模拟进钢失败');
    } finally {
      setWorkflowBusy(false);
    }
  };

  const handleCaptureOnce = async () => {
    setWorkflowBusy(true);
    setLoadError(null);
    try {
      let materialId =
        productionStatus?.activeSession?.materialId ||
        (productionStatus?.capture?.present ? selectedMaterialId : '') ||
        selectedMaterialId ||
        latest?.manifest.materialId ||
        '';
      if (!productionStatus?.capture?.present) {
        materialId = materialId || createMaterialId();
        await sendBarSurfaceProductionEvent('steel-in', {
          materialId,
          acquisitionMode: 'manual',
          triggerMode: 'manual',
          autoCapture: false,
          steelType: 'round-bar',
        });
      }
      const payload = await captureBarSurfaceProductionOnce({
        materialId,
        expectedCameras: expectedCameraCount,
        rounds: 1,
        lines: 1000,
        timeoutMs: 8000,
        intervalMs: 500,
        onTaskStatus: (task) => setActiveTask(task),
      });
      const provider = payload.provider;
      const successes = provider?.successes ?? 0;
      const attempts = provider?.attempts ?? 0;
      const completeFrames = provider?.completeFrames ?? 0;
      const failed = payload.code !== 0 || (provider?.code ?? payload.code) !== 0 || successes === 0;
      setWorkflowMessage(
        failed
          ? `采集一轮未完全成功：${materialId}，成功 ${successes}/${attempts}，完整帧 ${completeFrames}。`
          : `采集一轮完成：${materialId}，成功 ${successes}/${attempts}，完整帧 ${completeFrames}，未保存 SDK 派生图。`,
      );
      await refreshAfterWorkflow(materialId);
    } catch (error) {
      setWorkflowMessage('');
      setLoadError(error instanceof Error ? error.message : '采集一轮失败');
    } finally {
      setWorkflowBusy(false);
    }
  };

  const handleCancelTask = async () => {
    if (!activeTask || !['queued', 'running'].includes(activeTask.status)) {
      return;
    }
    try {
      const task = await cancelBarSurfaceProductionTask(activeTask.taskId);
      setActiveTask(task);
      setWorkflowMessage(
        task.status === 'cancelled'
          ? `任务已取消：${task.taskId}`
          : `已请求取消，等待当前采集边界：${task.taskId}`,
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '取消生产任务失败');
    }
  };

  const handleSteelOut = async () => {
    setWorkflowBusy(true);
    setLoadError(null);
    try {
      const materialId =
        productionStatus?.activeSession?.materialId ||
        selectedMaterialId ||
        latest?.manifest.materialId ||
        createMaterialId();
      await sendBarSurfaceProductionEvent('steel-out', {
        materialId,
        acquisitionMode: 'manual',
        triggerMode: 'manual',
        autoCapture: false,
      });
      setWorkflowMessage(`已出钢结束：${materialId}，采集保存关闭。`);
      await refreshAfterWorkflow(materialId);
    } catch (error) {
      setWorkflowMessage('');
      setLoadError(error instanceof Error ? error.message : '出钢结束失败');
    } finally {
      setWorkflowBusy(false);
    }
  };

  const runReconstruction = async (calibrationPath = '') => {
    setRunning(true);
    setLoadError(null);
    try {
      const materialId = selectedMaterialId || latest?.manifest.materialId || 'latest';
      const payload = await runBarSurfaceProductionAlgorithm({
        materialId,
        calibrationPath: calibrationPath || undefined,
        runCore: true,
        onTaskStatus: (task) => setActiveTask(task),
      });
      await applyManifest(payload.algorithm.result.manifest, payload.algorithm.result);
      const [runsPayload, productionPayload] = await Promise.all([
        fetchBarSurfaceRuns(payload.algorithm.result.manifest.materialId),
        fetchBarSurfaceProductionStatus(),
      ]);
      setRuns(runsPayload.runs);
      setAlgorithmRoot(runsPayload.root);
      setProductionStatus(productionPayload);
      if (calibrationPath) {
        setCalibrationMessage(`已按指定标定重建：${compactPath(calibrationPath, 5)}`);
      }
    } catch (error) {
      fetchBarSurfaceProductionStatus()
        .then(setProductionStatus)
        .catch(() => undefined);
      setLoadError(error instanceof Error ? error.message : '生产重建失败');
    } finally {
      setRunning(false);
      setLoading(false);
    }
  };

  const handleRun = async () => {
    await runReconstruction();
  };

  const handleRunWithCalibration = async (calibrationPath: string) => {
    if (!calibrationPath) {
      setCalibrationMessage('没有可用于重建的标定 XML。');
      return;
    }
    await runReconstruction(calibrationPath);
  };

  const handleCalibrationFit = async () => {
    setCalibrationBusy(true);
    setCalibrationMessage(`正在采集 ${expectedCameraCount} 相机标定帧；检测到有效圆形标定物且质量门通过后将生成可复核修正${calibrationActivationSupported ? '并自动激活' : ''}…`);
    setLoadError(null);
    try {
      const calibrationPath = latest?.manifest.calibration?.path || '';
      const payload = await fitBarSurfaceCalibration({
        calibrationPath,
        rows: '250,500,750',
        maxPointsPerCamera: 2400,
        maxShiftMm: 5,
        expectedCameras: expectedCameraCount,
        autoActivate: calibrationActivationSupported,
        profile: calibrationProfileName,
        onTaskStatus: (task) => setActiveTask(task),
      });
      setCalibrationFitReport(payload.result);
      const before = payload.result.fitBefore?.meanAbsResidual;
      const after = payload.result.fitAfter?.meanAbsResidual;
      if (!payload.result.targetDetection?.detected) {
        setCalibrationMessage(`${expectedCameraCount} 相机采集完成，但未检测到有效标定物：${payload.result.targetDetection?.reasons?.join('、') || '无有效圆形轮廓'}；未生成或激活修正。`);
      } else if (!payload.result.correctionAccepted) {
        setCalibrationMessage(`已检测到标定物，但修正质量门未通过：${payload.result.correctionQuality?.reasons?.join('、') || '拟合改善不足'}；未激活。`);
      } else if (payload.autoActivation?.activated) {
        const status = await readActiveCaptureCalibration(calibrationProfileName);
        setActiveCalibration(status);
        setCalibrationMessage(`${expectedCameraCount} 相机自动标定修正已激活：${payload.autoActivation.version || status.activeCalibration?.version || '新版本'}，残差 ${metricText(before)} -> ${metricText(after)}；未写入相机设备。`);
      } else {
        setCalibrationMessage(`${expectedCameraCount} 相机标定拟合完成：${payload.result.cameraCount ?? 0}/${expectedCameraCount}，残差 ${metricText(before)} -> ${metricText(after)}；自动激活未执行。`);
      }
    } catch (error) {
      setCalibrationMessage(error instanceof Error ? error.message : '自动标定修正失败');
    } finally {
      setCalibrationBusy(false);
    }
  };

  const handleActivateCalibration = async () => {
    if (!calibrationActivationSupported) {
      setCalibrationMessage(`${calibrationActivationUnsupportedReason}请完成离线审核后更新采集 Profile 并重启。`);
      return;
    }
    const report = calibrationFitReport;
    const correctedXml = report?.correctedXml || '';
    if (!report || !correctedXml) {
      setCalibrationMessage('请先完成自动标定拟合并复核修正结果。');
      return;
    }
    setCalibrationActivationBusy(true);
    setCalibrationMessage('正在激活已复核的阵列标定版本...');
    try {
      const outputDir = report.outputDir || correctedXml.split(/[\\/]/).slice(0, -1).join('\\');
      const version = outputDir.split(/[\\/]/).filter(Boolean).at(-1) || 'tauri-reviewed-calibration';
      const separator = outputDir.includes('\\') ? '\\' : '/';
      const fitReportPath = outputDir ? `${outputDir.replace(/[\\/]$/, '')}${separator}fit_report.json` : '';
      const status = await activateCaptureCalibration({
        name: calibrationProfileName,
        path: correctedXml,
        version,
        fitReport: fitReportPath,
        beforePreview: report.beforePreview,
        afterPreview: report.afterPreview,
        sourceCalibration: report.calibration,
        fitBefore: report.fitBefore,
        fitAfter: report.fitAfter,
        cameraParamDir: `config/camera-params/${calibrationProfileName}`,
        allowExternal: true,
        saveToDevice: false,
        appliedBy: 'tauri-calibration-review',
      });
      if (status.code !== 0 || !status.exists) {
        throw new Error(`采集端未接受标定版本（code ${status.code}）`);
      }
      setActiveCalibration(status);
      setCalibrationMessage(`阵列标定版本已激活：${status.activeCalibration?.version || version}；未写入相机设备。`);
    } catch (error) {
      setCalibrationMessage(error instanceof Error ? `标定版本激活失败：${error.message}` : '标定版本激活失败');
    } finally {
      setCalibrationActivationBusy(false);
    }
  };

  const manifest = latest?.manifest ?? null;

  return (
    <main className="bar-surface-shell" data-testid="bar-surface-app">
      <BarSurfaceHeader
        latest={latest}
        manifest={manifest}
        expectedCameraCount={expectedCameraCount}
        productionStatus={productionStatus}
        captureMaterials={captureMaterials}
        selectedMaterialId={selectedMaterialId}
        runs={runs}
        selectedRunId={selectedRunId}
        loading={loading}
        running={running}
        workflowBusy={workflowBusy}
        workflowMessage={workflowMessage}
        activeTask={activeTask}
        runtimeConfiguration={runtimeConfiguration}
        onRefresh={() => loadLatest()}
        onSteelIn={handleSteelIn}
        onCaptureOnce={handleCaptureOnce}
        onSteelOut={handleSteelOut}
        onRun={handleRun}
        onCancelTask={handleCancelTask}
        onMaterialChange={handleMaterialChange}
        onRunChange={handleRunChange}
      />
      {loadError ? (
        <section className="bar-surface-error">
          <strong>算法结果不可用</strong>
          <span>{loadError}</span>
          <button type="button" onClick={handleRun} disabled={running}>
            <Play size={16} />
            生成当前流水重建
          </button>
        </section>
      ) : null}
      {manifest ? (
        <>
          <BarSurfaceCalibrationPanel
            manifest={manifest}
            expectedCameraCount={expectedCameraCount}
            fitReport={calibrationFitReport}
            activeCalibration={activeCalibration}
            busy={calibrationBusy || calibrationActivationBusy || running}
            fitRunning={calibrationBusy}
            activationBusy={calibrationActivationBusy}
            message={calibrationMessage}
            onFit={handleCalibrationFit}
            onActivate={handleActivateCalibration}
            onImportFitReport={handleImportCalibrationFitReport}
            onRefreshActive={() => void refreshActiveCalibration()}
            onOpenVersionDirectory={() => void handleOpenCalibrationVersionDirectory()}
            onRunWithCalibration={handleRunWithCalibration}
            activationSupported={calibrationActivationSupported}
            activationUnsupportedReason={calibrationActivationUnsupportedReason}
          />
          <section className="bar-surface-main-grid">
          <div className="bar-surface-panel bar-surface-camera-panel">
            <header className="bar-surface-panel-header">
              <div>
                <span>2D 平铺</span>
                <strong>{expectedCameraCount} 相机最新裁剪图</strong>
              </div>
              <div className="bar-surface-icon-row">
                <ImageIcon size={18} />
                <span>{manifest.cameraCount} 路</span>
                <a href={barSurfaceFileUrl(manifest.relative.texture || manifest.mesh.texture)} target="_blank" rel="noreferrer">
                  <ExternalLink size={15} />
                  贴图
                </a>
              </div>
            </header>
            <div className="bar-surface-camera-grid" data-testid="bar-surface-camera-grid">
              {manifest.cameras.map((camera) => (
                <BarSurfaceCameraTile key={camera.name} camera={camera} />
              ))}
            </div>
          </div>
            <BarSurfaceModelPanel
              manifest={manifest}
              mesh={mesh}
              meshError={meshError}
              expectedCameraCount={expectedCameraCount}
            />
          </section>
        </>
      ) : (
        <section className="bar-surface-loading">
          <RefreshCw size={28} />
          <strong>{loading ? '正在读取 G 盘算法结果' : '暂无算法结果'}</strong>
          <span>先选择 H 盘采集流水，再生成或查看对应的 2D 与 3D 重建结果。</span>
        </section>
      )}
    </main>
  );
}
