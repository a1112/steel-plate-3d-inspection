import { Canvas } from '@react-three/fiber';
import { Box, Image as ImageIcon, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  MeshStandardMaterial,
  Uint32BufferAttribute,
} from 'three';
import {
  CaptureApiError,
  captureArtifactImageUrl,
  readCaptureSurface,
  type CaptureFlowSurface,
} from '../lib/capture-api';

interface CaptureSurfacePanelProps {
  materialId: string;
}

function metric(value: number | null | undefined, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--';
}

function createSurfaceGeometry(surface: CaptureFlowSurface) {
  const source = surface.mesh.positions;
  const validPoints: Array<[number, number, number]> = [];
  for (let index = 0; index + 2 < source.length; index += 3) {
    const x = source[index];
    const y = source[index + 1];
    const z = source[index + 2];
    if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
      validPoints.push([x, y, z]);
    }
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of validPoints) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  const center = min.map((value, axis) => Number.isFinite(value) ? (value + max[axis]) / 2 : 0);
  const span = Math.max(1, ...max.map((value, axis) => Number.isFinite(value) ? value - min[axis] : 0));
  const scale = 2.7 / span;
  const positions = new Float32Array(source.length);
  for (let index = 0; index + 2 < source.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = source[index + axis];
      positions[index + axis] = typeof value === 'number' ? (value - center[axis]) * scale : 0;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(surface.mesh.colors), 3));
  geometry.setIndex(new Uint32BufferAttribute(new Uint32Array(surface.mesh.indices), 1));
  geometry.computeVertexNormals();
  return geometry;
}

function SurfaceMesh({ surface }: { surface: CaptureFlowSurface }) {
  const geometry = useMemo(() => createSurfaceGeometry(surface), [surface]);
  const material = useMemo(() => new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.72,
    metalness: 0.12,
    side: DoubleSide,
  }), []);
  useEffect(() => () => {
    geometry.dispose();
  }, [geometry]);
  useEffect(() => () => {
    material.dispose();
  }, [material]);
  return <mesh geometry={geometry} material={material} rotation={[0.18, -0.56, -0.08]} />;
}

export function CaptureSurfacePanel({ materialId }: CaptureSurfacePanelProps) {
  const [surface, setSurface] = useState<CaptureFlowSurface | null>(null);
  const [mode, setMode] = useState<'3d' | 'jet'>('3d');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!materialId) return;
    setLoading(true);
    try {
      const result = await readCaptureSurface(materialId);
      setSurface(result.surface);
      setError('');
    } catch (loadError) {
      setSurface(null);
      setError(loadError instanceof CaptureApiError && loadError.status === 404
        ? '尚未生成 3D 拟合结果'
        : loadError instanceof Error ? loadError.message : '3D 拟合结果读取失败');
    } finally {
      setLoading(false);
    }
  }, [materialId]);

  useEffect(() => {
    setSurface(null);
    setError('');
    void load();
  }, [load]);

  const hasMesh = Boolean(surface?.mesh.indices.length);
  return (
    <section className="capture-surface-panel" aria-label="同步三维拟合与 JET 表面图">
      <header>
        <div>
          <Box size={17} />
          <div><strong>3D 拟合与 JET</strong><span>{materialId}</span></div>
        </div>
        <div className="capture-surface-actions">
          <button type="button" className={mode === '3d' ? 'active' : ''} onClick={() => setMode('3d')}>
            <Box size={14} />3D
          </button>
          <button type="button" className={mode === 'jet' ? 'active' : ''} onClick={() => setMode('jet')}>
            <ImageIcon size={14} />JET
          </button>
          <button type="button" onClick={() => void load()} disabled={loading} aria-label="刷新三维拟合">
            <RefreshCw size={14} className={loading ? 'spin' : ''} />刷新
          </button>
        </div>
      </header>
      {surface ? (
        <div className="capture-surface-content">
          <div className="capture-surface-view">
            {mode === '3d' && hasMesh ? (
              <Canvas camera={{ position: [0, 0, 4.2], fov: 38, near: 0.1, far: 20 }} dpr={[1, 1.5]} frameloop="demand">
                <color attach="background" args={['#07121b']} />
                <ambientLight intensity={1.25} />
                <directionalLight position={[3, 4, 5]} intensity={2.1} />
                <directionalLight position={[-3, -1, -2]} intensity={0.8} />
                <SurfaceMesh surface={surface} />
              </Canvas>
            ) : mode === 'jet' && surface.jet.imagePath ? (
              <img
                src={captureArtifactImageUrl(surface.jet.imagePath, 1440)}
                alt={`${materialId} JET 径向偏差展开图`}
                decoding="async"
                loading="eager"
              />
            ) : (
              <span>当前流水号没有可显示的{mode === '3d' ? '三维网格' : ' JET 图'}</span>
            )}
          </div>
          <aside>
            <span className={surface.quality.crossSectionMetricValid ? 'metric-valid' : 'preview-only'}>
              {surface.quality.crossSectionMetricValid ? '截面毫米标定有效' : '拟合预览'}
            </span>
            <strong>平均外径 {metric(surface.summary.diameterMeanMm)} mm</strong>
            <small>截面 {surface.summary.acceptedSectionCount}/{surface.summary.sectionCount}</small>
            <small>范围 {metric(surface.summary.diameterMinimumMm)}–{metric(surface.summary.diameterMaximumMm)} mm</small>
            <small>JET ±{metric(surface.summary.jetResidualRangeMm)} mm · 覆盖 {(surface.quality.angularCoverageRatio * 100).toFixed(1)}%</small>
            <small>长度方向：软同步时序（待测速仪标定）</small>
          </aside>
        </div>
      ) : (
        <div className="capture-surface-empty">
          <RefreshCw size={22} className={loading ? 'spin' : ''} />
          <span>{loading ? '正在读取 3D 拟合结果…' : error}</span>
        </div>
      )}
    </section>
  );
}
