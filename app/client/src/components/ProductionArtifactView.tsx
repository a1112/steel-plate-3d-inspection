import { Canvas, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Uint32BufferAttribute,
  type PerspectiveCamera,
} from 'three';
import type { BarSurfaceMesh } from '../services/bar-surface-api';

const MIN_ZOOM = 0.72;
const MAX_ZOOM = 2.2;
const ZOOM_STEP = 0.12;
const MAX_YAW = 0.9;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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

function createArtifactGeometry(mesh: BarSurfaceMesh, indexed: boolean) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(normalizePositions(mesh.positions), 3));
  const pointCount = Math.floor(mesh.positions.length / 3);
  if (mesh.colors.length >= pointCount * 3) {
    geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(mesh.colors), 3));
  }
  if (indexed && mesh.indices.length >= 3) {
    geometry.setIndex(new Uint32BufferAttribute(new Uint32Array(mesh.indices), 1));
    geometry.computeVertexNormals();
  }
  return geometry;
}

function ArtifactCamera({ zoom }: { zoom: number }) {
  const { camera, size } = useThree();
  useEffect(() => {
    const perspective = camera as PerspectiveCamera;
    camera.position.set(3.4, 2.7, 4.6);
    camera.lookAt(0, 0, 0);
    perspective.zoom = zoom;
    perspective.updateProjectionMatrix();
  }, [camera, size.height, size.width, zoom]);
  return null;
}

export function ProductionArtifactView({
  mesh,
  mode,
  testId,
  ariaLabel,
  className = '',
}: {
  mesh: BarSurfaceMesh;
  mode: 'surface' | 'points';
  testId: string;
  ariaLabel: string;
  className?: string;
}) {
  const [yaw, setYaw] = useState(-0.28);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startYaw: number } | null>(null);
  const geometry = useMemo(() => createArtifactGeometry(mesh, mode === 'surface'), [mesh, mode]);
  const hasColors = geometry.getAttribute('color') !== undefined;
  const pointCount = Math.floor(mesh.positions.length / 3);

  useEffect(() => () => geometry.dispose(), [geometry]);

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
    const direction = event.deltaY < 0 ? 1 : -1;
    setZoom((current) => clamp(Number((current + direction * ZOOM_STEP).toFixed(2)), MIN_ZOOM, MAX_ZOOM));
  };

  return (
    <div
      className={`production-artifact-view ${mode} ${dragging ? 'is-dragging' : ''} ${className}`.trim()}
      data-testid={testId}
      data-artifact-source="production-record"
      data-artifact-points={pointCount}
      data-artifact-triangles={Math.floor(mesh.indices.length / 3)}
      data-artifact-yaw={yaw.toFixed(3)}
      data-artifact-zoom={zoom.toFixed(2)}
      aria-label={ariaLabel}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startYaw: yaw };
        setDragging(true);
        if (typeof event.currentTarget.setPointerCapture === 'function') {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }}
      onPointerMove={(event) => {
        if (!drag.current || drag.current.pointerId !== event.pointerId) {
          return;
        }
        setYaw(clamp(drag.current.startYaw + (event.clientX - drag.current.startX) * 0.006, -MAX_YAW, MAX_YAW));
      }}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onWheel={handleWheel}
    >
      <Canvas camera={{ position: [3.4, 2.7, 4.6], fov: 46 }} dpr={[1, 1.5]}>
        <ArtifactCamera zoom={zoom} />
        <color attach="background" args={['#081118']} />
        <ambientLight intensity={0.82} />
        <directionalLight position={[4, 5, 4]} intensity={1.1} />
        <group rotation={[0.2, yaw, 0]}>
          {mode === 'surface' ? (
            <mesh geometry={geometry}>
              <meshStandardMaterial color={hasColors ? '#ffffff' : '#8ba2ad'} vertexColors={hasColors} roughness={0.62} metalness={0.08} side={DoubleSide} />
            </mesh>
          ) : (
            <points geometry={geometry}>
              <pointsMaterial color={hasColors ? '#ffffff' : '#42c9ff'} vertexColors={hasColors} size={0.025} sizeAttenuation />
            </points>
          )}
        </group>
      </Canvas>
      <span className="production-artifact-tag">生产记录产物 · {pointCount.toLocaleString('zh-CN')} 点 · {zoom.toFixed(2)}x</span>
    </div>
  );
}
