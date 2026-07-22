import { createAdminHeaders, getInspectionServiceOrigin } from './inspection-api';

export type BkvStatus = {
  provider: 'bkv';
  ready: boolean;
  mode: 'offline-replay-no-camera-hardware';
  cameraMode: 'offline-file';
  cameraCount: number;
  physicalCamerasOnline: number;
  batchId: string;
  materialCount: number;
  nextIndex: number;
  nextLegacySeqNo: number | null;
  completed: boolean;
};

export type BkvArtifact = {
  path: string;
  size: number;
  sha256: string;
};

export type BkvFrame = BkvArtifact & { frameNo: number };

export type BkvCamera = {
  cameraId: number;
  mode: 'offline-file';
  twoDFrameCount: number;
  npzFrameCount: number;
  twoDFrames: BkvFrame[];
  npzFrames: BkvFrame[];
};

export type BkvDefect = {
  legacyDefectId: number;
  defectNo?: number;
  cameraId: number;
  classNo: number;
  className: string;
  grade: number;
  confidence: number;
  imageIndex?: number;
  area3d?: number | null;
  depth3d?: number | null;
};

export type BkvMaterial = {
  legacySeqNo: number;
  legacyCheckRecordSeqNo: number;
  steelId: string;
  steelType: string;
  lengthMm: number | null;
  outerDiameterLegacyValue: number | null;
  wallThicknessMm: number | null;
  inspectionTime: string;
  defects: BkvDefect[];
  cameras: BkvCamera[];
  artifacts: {
    unwrapped: BkvArtifact;
    cylinder: BkvArtifact;
    summary: BkvArtifact;
  };
};

export type BkvCylinderPreview = {
  schema: 'bkv-cylinder-preview.v1';
  sequence?: number;
  longitudinal_samples: number;
  angular_samples: number;
  display_residual: number[][];
  valid_mask: boolean[][];
};

export type BkvReplayResponse = {
  code: number;
  provider: 'bkv';
  completed?: boolean;
  capture?: { legacySeqNo?: number } | null;
  status?: BkvStatus;
};

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    let detail = fallback;
    try {
      const payload = await response.json() as { error?: string; message?: string };
      detail = payload.message || payload.error || detail;
    } catch {
      // Preserve the stable local fallback for non-JSON failures.
    }
    throw new Error(`${fallback}: ${detail} (HTTP ${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function fetchBkvStatus(signal?: AbortSignal): Promise<BkvStatus | null> {
  const response = await fetch(`${getInspectionServiceOrigin()}/api/bkv/status`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (response.status === 404) {
    return null;
  }
  const status = await readJson<BkvStatus>(response, 'BKV 状态读取失败');
  return status.provider === 'bkv' && status.ready ? status : null;
}

export async function fetchBkvMaterials(signal?: AbortSignal): Promise<BkvMaterial[]> {
  const response = await fetch(`${getInspectionServiceOrigin()}/api/bkv/materials`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  const payload = await readJson<{ provider: 'bkv'; materials: BkvMaterial[] }>(response, 'BKV 材料清单读取失败');
  return payload.materials;
}

export async function fetchBkvMaterial(legacySeqNo: number, signal?: AbortSignal): Promise<BkvMaterial> {
  const params = new URLSearchParams({ legacySeqNo: String(legacySeqNo) });
  const response = await fetch(`${getInspectionServiceOrigin()}/api/bkv/material?${params}`, {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  const payload = await readJson<{ provider: 'bkv'; material: BkvMaterial }>(response, 'BKV 材料读取失败');
  return payload.material;
}

export function bkvArtifactUrl(path: string) {
  const params = new URLSearchParams({ path });
  return `${getInspectionServiceOrigin()}/api/bkv/file?${params}`;
}

export async function fetchBkvArtifactBlobUrl(path: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(bkvArtifactUrl(path), {
    headers: createAdminHeaders({ Accept: '*/*' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`BKV 文件读取失败 (HTTP ${response.status})`);
  }
  return URL.createObjectURL(await response.blob());
}

export async function fetchBkvCylinder(path: string, signal?: AbortSignal): Promise<BkvCylinderPreview> {
  const response = await fetch(bkvArtifactUrl(path), {
    headers: createAdminHeaders({ Accept: 'application/json' }),
    signal,
  });
  return readJson<BkvCylinderPreview>(response, 'BKV 圆柱数据读取失败');
}

async function mutateReplay(path: 'next' | 'reset'): Promise<BkvReplayResponse> {
  const response = await fetch(`${getInspectionServiceOrigin()}/api/bkv/replay/${path}`, {
    method: 'POST',
    headers: createAdminHeaders({ Accept: 'application/json', 'Content-Type': 'application/json' }),
    body: '{}',
  });
  return readJson<BkvReplayResponse>(response, path === 'next' ? 'BKV 回放失败' : 'BKV 重置失败');
}

export const nextBkvReplay = () => mutateReplay('next');
export const resetBkvReplay = () => mutateReplay('reset');
