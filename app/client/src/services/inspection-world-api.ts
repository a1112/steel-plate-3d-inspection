import { createAdminHeaders, getInspectionServiceOrigin } from './inspection-api';
import type { BarSurfaceMesh } from './bar-surface-api';

export type InspectionWorldProvider = 'bkv' | 'online';

export type WorldRect = { x: number; y: number; width: number; height: number };

export type InspectionWorldCamera = {
  cameraId: number;
  offsetX: number;
  width: number;
  height: number;
  rawHeight?: number;
  headOffsetY?: number;
  aligned?: boolean;
  alignmentConfidenceMilli?: number;
  frameWidth: number;
  frameHeight: number;
  frameNumbers: number[];
  orientation: {
    frameOrder: 'ascending' | 'descending';
    rotation: number;
    flipX: boolean;
    flipY: boolean;
  };
};

export type InspectionWorld = {
  width: number;
  height: number;
  tileSize: number;
  maxLevel: number;
  cameras: InspectionWorldCamera[];
};

export type InspectionWorldRecord = {
  recordId: string;
  legacySeqNo?: number;
  steelId?: string;
  steelType?: string;
  lengthMm?: number | null;
  outerDiameterMm?: number | null;
  wallThicknessMm?: number | null;
  inspectionTime?: string;
  defectCount: number;
  cameraCount?: number;
  sourceHash?: string;
};

export type InspectionWorldRecords = {
  schema: 'steel.inspection-world.records.v1';
  provider: InspectionWorldProvider;
  ready?: boolean;
  cameraCount?: number;
  batchId?: string;
  records: InspectionWorldRecord[];
};

export type InspectionWorldMeta = {
  schema: 'steel.inspection-world.meta.v1';
  provider: InspectionWorldProvider;
  recordId: string;
  legacySeqNo?: number;
  sourceFrameCount: number;
  sourceRevision: string;
  cache: {
    state: 'building' | 'complete' | 'unavailable';
    tileSize: number;
    maxLevel: number;
  };
  world: InspectionWorld;
  depthSurface?: {
    available: boolean;
    sourceFrameCount: number;
    path?: string | null;
    binaryPath?: string | null;
    parametersPath?: string | null;
    error?: string | null;
    coordinateUnit: string;
    calibrated: boolean;
  };
};

export type InspectionWorldReconstructionParameters = {
  schema: 'steel.bkv-depth-reconstruction-parameters.v1';
  recordId: string;
  algorithmRevision?: string;
  input: {
    format: 'NPZ';
    depthArray: string;
    depthType: string;
    sourceFrameCount: number;
    invalidDepthFloor: number;
  };
  sampling: {
    rows: number;
    colsPerCamera: number;
    cameraCount: number;
    frameSelection: string;
    rowSelection: string;
    columnSelection: string;
  };
  reconstruction: {
    geometry: string;
    longitudinalExtent: number;
    nominalRadius: number;
    nominalDiameter?: number;
    maximumRadialOffset: number;
    cameraNormalization: string;
    coordinateUnit: string;
    calibrated: boolean;
  };
  display: {
    mode: string;
    robustResidualP95: number;
    radialScale: number;
    unit: string;
  };
  output: {
    format: string;
    vertexCount: number;
    validPointCount: number;
    imputedPointCount?: number;
    indexCount: number;
    triangleCount: number;
    binaryBytes: number;
    topology?: string;
  };
  cameras: Array<{
    cameraId: number;
    frameCount: number;
    firstSequence: number;
    lastSequence: number;
    sourceRows: number;
    sourceColumns: number;
    baseline: number;
    columnBaselineMinimum?: number;
    columnBaselineMaximum?: number;
    normalization: string;
  }>;
};

export type InspectionWorldDefect = {
  id: string | number;
  className?: string;
  grade?: number;
  confidence?: number;
  cameraId?: number | null;
  imageIndex?: number | null;
  locatable: boolean;
  worldRect?: WorldRect | null;
  trace?: {
    sequenceNo?: number;
    artifacts?: {
      classNo?: number | string;
      imageRect2d?: {
        left?: number;
        top?: number;
        right?: number;
        bottom?: number;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

export type InspectionWorldDefects = {
  schema: 'steel.inspection-world.defects.v1';
  provider: InspectionWorldProvider;
  recordId: string;
  defects: InspectionWorldDefect[];
};

export type WorldTileRequest = {
  cameraId: number;
  level: number;
  x: number;
  y: number;
  revision: string;
  format?: 'jpeg' | 'png';
};

export type WorldTile = WorldTileRequest & { url: string; revoke: () => void };

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json() as {
        detail?: unknown;
        message?: unknown;
        error?: unknown;
      };
      const candidate = payload.detail ?? payload.message ?? payload.error;
      if (typeof candidate === 'string' && candidate.trim()) detail = candidate.trim();
    } catch {
      // Preserve the HTTP fallback when an error body is absent or not JSON.
    }
    throw new Error(`${fallback}${detail ? `：${detail}` : ''} (HTTP ${response.status})`);
  }
  return response.json() as Promise<T>;
}

function worldUrl(path: string, params?: URLSearchParams) {
  const suffix = params ? `?${params.toString()}` : '';
  return `${getInspectionServiceOrigin()}/api/inspection-world/${path}${suffix}`;
}

export async function fetchInspectionWorldRecords(signal?: AbortSignal): Promise<InspectionWorldRecords> {
  const payload = await readJson<InspectionWorldRecords>(await fetch(worldUrl('records'), {
    headers: createAdminHeaders({ Accept: 'application/json' }), signal,
  }), '检测世界记录读取失败');
  if (payload.schema !== 'steel.inspection-world.records.v1' || !Array.isArray(payload.records)) {
    throw new Error('检测世界记录格式无效');
  }
  return payload;
}

export async function fetchInspectionWorldMeta(recordId: string, signal?: AbortSignal): Promise<InspectionWorldMeta> {
  const payload = await readJson<InspectionWorldMeta>(await fetch(worldUrl('meta', new URLSearchParams({ recordId })), {
    headers: createAdminHeaders({ Accept: 'application/json' }), signal,
  }), '检测世界元数据读取失败');
  if (
    payload.schema !== 'steel.inspection-world.meta.v1'
    || typeof payload.sourceRevision !== 'string'
    || !payload.sourceRevision
    || !payload.cache
    || payload.cache.tileSize !== 128
    || !payload.world
    || !Array.isArray(payload.world.cameras)
  ) {
    throw new Error('检测世界元数据格式无效');
  }
  return payload;
}

export async function fetchInspectionWorldDefects(recordId: string, signal?: AbortSignal): Promise<InspectionWorldDefects> {
  const payload = await readJson<InspectionWorldDefects>(await fetch(worldUrl('defects', new URLSearchParams({ recordId })), {
    headers: createAdminHeaders({ Accept: 'application/json' }), signal,
  }), '检测世界缺陷读取失败');
  if (payload.schema !== 'steel.inspection-world.defects.v1' || !Array.isArray(payload.defects)) {
    throw new Error('检测世界缺陷格式无效');
  }
  return payload;
}

export function inspectionWorldFrameUrl(
  recordId: string,
  cameraId: number,
  sequenceNo: number,
  roi?: { x: number; y: number; width: number; height: number } | null,
) {
  const params = new URLSearchParams({
    recordId,
    cameraId: String(cameraId),
    sequenceNo: String(sequenceNo),
  });
  if (roi && roi.width > 0 && roi.height > 0) {
    params.set('cropX', String(Math.max(0, Math.round(roi.x))));
    params.set('cropY', String(Math.max(0, Math.round(roi.y))));
    params.set('cropWidth', String(Math.max(1, Math.round(roi.width))));
    params.set('cropHeight', String(Math.max(1, Math.round(roi.height))));
  }
  return worldUrl('frame', params);
}

const inspectionWorldSurfaceCache = new Map<string, BarSurfaceMesh>();
const INSPECTION_WORLD_SURFACE_CACHE_LIMIT = 8;

function rememberInspectionWorldSurface(recordId: string, mesh: BarSurfaceMesh) {
  inspectionWorldSurfaceCache.delete(recordId);
  inspectionWorldSurfaceCache.set(recordId, mesh);
  while (inspectionWorldSurfaceCache.size > INSPECTION_WORLD_SURFACE_CACHE_LIMIT) {
    const oldest = inspectionWorldSurfaceCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    inspectionWorldSurfaceCache.delete(oldest);
  }
  return mesh;
}

function requireSurfaceBytes(buffer: ArrayBuffer, offset: number, byteCount: number, label: string) {
  if (offset + byteCount > buffer.byteLength) {
    throw new Error(`三维网格二进制数据越界：${label}`);
  }
}

export function parseInspectionWorldSurfaceBinary(buffer: ArrayBuffer): BarSurfaceMesh {
  const headerBytes = 40;
  requireSurfaceBytes(buffer, 0, headerBytes, 'header');
  const magic = Array.from(new Uint8Array(buffer, 0, 8), (byte) => String.fromCharCode(byte)).join('');
  if (magic !== 'BSMESH01') throw new Error('三维网格二进制标识无效');
  const view = new DataView(buffer);
  if (view.getUint32(8, true) !== 1) throw new Error('三维网格二进制版本不支持');
  const vertexCount = view.getUint32(12, true);
  const indexCount = view.getUint32(16, true);
  const flags = view.getUint32(20, true);
  const rows = view.getUint32(24, true);
  const colsPerCamera = view.getUint32(28, true);
  const cameraCount = view.getUint32(32, true);
  let offset = headerBytes;

  const positionsBytes = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  requireSurfaceBytes(buffer, offset, positionsBytes, 'positions');
  const positions = new Float32Array(buffer, offset, vertexCount * 3);
  offset += positionsBytes;
  const uvsBytes = vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT;
  requireSurfaceBytes(buffer, offset, uvsBytes, 'uvs');
  const uvs = new Float32Array(buffer, offset, vertexCount * 2);
  offset += uvsBytes;
  const colorsBytes = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  requireSurfaceBytes(buffer, offset, colorsBytes, 'colors');
  const colors = new Float32Array(buffer, offset, vertexCount * 3);
  offset += colorsBytes;
  const indicesBytes = indexCount * Uint32Array.BYTES_PER_ELEMENT;
  requireSurfaceBytes(buffer, offset, indicesBytes, 'indices');
  const indices = new Uint32Array(buffer, offset, indexCount);
  offset += indicesBytes;

  let validMask: Uint8Array | undefined;
  if ((flags & 0x02) !== 0) {
    requireSurfaceBytes(buffer, offset, vertexCount, 'validMask');
    validMask = new Uint8Array(buffer, offset, vertexCount);
    offset += vertexCount;
  }
  let calibratedMask: Uint8Array | undefined;
  if ((flags & 0x04) !== 0) {
    requireSurfaceBytes(buffer, offset, vertexCount, 'calibratedMask');
    calibratedMask = new Uint8Array(buffer, offset, vertexCount);
  }
  return {
    schema: 'steel.bkv-depth-surface.bsmesh.v1',
    coordinateUnit: 'millimeter-normalized-radius',
    cameraCount,
    frameStems: [],
    rows,
    colsPerCamera,
    positions,
    uvs,
    colors,
    validMask,
    calibratedMask,
    indices,
    source: 'bkv-bsmesh',
    binaryBytes: buffer.byteLength,
  };
}

export async function fetchInspectionWorldSurface(
  recordId: string,
  signal?: AbortSignal,
  refresh = false,
): Promise<BarSurfaceMesh> {
  const cached = refresh ? undefined : inspectionWorldSurfaceCache.get(recordId);
  if (cached) {
    inspectionWorldSurfaceCache.delete(recordId);
    inspectionWorldSurfaceCache.set(recordId, cached);
    return cached;
  }
  try {
    const params = new URLSearchParams({ recordId, format: 'binary' });
    if (refresh) params.set('refresh', String(Date.now()));
    const binaryResponse = await fetch(worldUrl('surface', params), {
      cache: refresh ? 'no-store' : 'no-cache',
      headers: createAdminHeaders({ Accept: 'application/vnd.steel.bsmesh' }), signal,
    });
    if (binaryResponse.ok) {
      return rememberInspectionWorldSurface(
        recordId,
        parseInspectionWorldSurfaceBinary(await binaryResponse.arrayBuffer()),
      );
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const payload = await readJson<BarSurfaceMesh>(await fetch(worldUrl('surface', new URLSearchParams({ recordId })), {
    headers: createAdminHeaders({ Accept: 'application/json' }), signal,
  }), '三维深度表面读取失败');
  if (
    payload.schema !== 'steel.bkv-depth-surface.v1'
    || !Array.isArray(payload.positions)
    || !Array.isArray(payload.indices)
    || payload.positions.length < 3
  ) {
    throw new Error('三维深度表面格式无效');
  }
  return rememberInspectionWorldSurface(recordId, payload);
}

export async function fetchInspectionWorldReconstructionParameters(
  recordId: string,
  signal?: AbortSignal,
  rebuild = false,
): Promise<InspectionWorldReconstructionParameters> {
  const params = new URLSearchParams({ recordId });
  if (rebuild) params.set('rebuild', 'true');
  const payload = await readJson<InspectionWorldReconstructionParameters>(
    await fetch(
      worldUrl('reconstruction-parameters', params),
      {
        cache: rebuild ? 'no-store' : 'no-cache',
        headers: createAdminHeaders({ Accept: 'application/json' }),
        signal,
      },
    ),
    '三维重建参数计算失败',
  );
  if (
    payload.schema !== 'steel.bkv-depth-reconstruction-parameters.v1'
    || payload.recordId !== recordId
    || !Array.isArray(payload.cameras)
    || !Number.isFinite(payload.output?.vertexCount)
  ) {
    throw new Error('三维重建参数格式无效');
  }
  return payload;
}

export async function fetchInspectionWorldTile(
  recordId: string,
  request: WorldTileRequest,
  signal?: AbortSignal,
): Promise<WorldTile> {
  const format = request.format ?? 'jpeg';
  const params = new URLSearchParams({
    recordId,
    revision: request.revision,
    cameraId: String(request.cameraId),
    level: String(request.level),
    x: String(request.x),
    y: String(request.y),
    format,
  });
  let response = await fetch(worldUrl('tile', params), {
    headers: createAdminHeaders({ Accept: format === 'png' ? 'image/png' : 'image/jpeg' }), signal,
  });
  if (response.status === 409 && !signal?.aborted) {
    const refreshed = await fetchInspectionWorldMeta(recordId, signal);
    params.set('revision', refreshed.sourceRevision);
    response = await fetch(worldUrl('tile', params), {
      headers: createAdminHeaders({ Accept: format === 'png' ? 'image/png' : 'image/jpeg' }), signal,
    });
  }
  if (!response.ok) throw new Error(`检测世界瓦片读取失败 (HTTP ${response.status})`);
  const url = URL.createObjectURL(await response.blob());
  return { ...request, format, url, revoke: () => URL.revokeObjectURL(url) };
}
