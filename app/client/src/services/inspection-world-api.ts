import { createAdminHeaders, getInspectionServiceOrigin } from './inspection-api';

export type InspectionWorldProvider = 'bkv' | 'online';

export type WorldRect = { x: number; y: number; width: number; height: number };

export type InspectionWorldCamera = {
  cameraId: number;
  offsetX: number;
  width: number;
  height: number;
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
  inspectionTime?: string;
  defectCount: number;
};

export type InspectionWorldRecords = {
  schema: 'steel.inspection-world.records.v1';
  provider: InspectionWorldProvider;
  records: InspectionWorldRecord[];
};

export type InspectionWorldMeta = {
  schema: 'steel.inspection-world.meta.v1';
  provider: InspectionWorldProvider;
  recordId: string;
  legacySeqNo?: number;
  sourceFrameCount: number;
  world: InspectionWorld;
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
  trace?: Record<string, unknown>;
};

export type InspectionWorldDefects = {
  schema: 'steel.inspection-world.defects.v1';
  provider: InspectionWorldProvider;
  recordId: string;
  defects: InspectionWorldDefect[];
};

export type WorldTileRequest = {
  level: number;
  x: number;
  y: number;
  format?: 'jpeg' | 'png';
};

export type WorldTile = WorldTileRequest & { url: string; revoke: () => void };

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw new Error(`${fallback} (HTTP ${response.status})`);
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
  if (payload.schema !== 'steel.inspection-world.meta.v1' || !payload.world || !Array.isArray(payload.world.cameras)) {
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

export async function fetchInspectionWorldTile(
  recordId: string,
  request: WorldTileRequest,
  signal?: AbortSignal,
): Promise<WorldTile> {
  const format = request.format ?? 'jpeg';
  const params = new URLSearchParams({
    recordId,
    level: String(request.level),
    x: String(request.x),
    y: String(request.y),
    format,
  });
  const response = await fetch(worldUrl('tile', params), {
    headers: createAdminHeaders({ Accept: format === 'png' ? 'image/png' : 'image/jpeg' }), signal,
  });
  if (!response.ok) throw new Error(`检测世界瓦片读取失败 (HTTP ${response.status})`);
  const url = URL.createObjectURL(await response.blob());
  return { ...request, format, url, revoke: () => URL.revokeObjectURL(url) };
}
