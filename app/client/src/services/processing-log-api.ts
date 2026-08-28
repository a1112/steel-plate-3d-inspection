import { getInspectionServiceOrigin } from './inspection-api';

export type ProcessingDataStatus = 'waiting' | 'processing' | 'completed' | 'degraded' | 'failed' | string;

export type ProcessingStage = {
  status: ProcessingDataStatus;
  statusLabel: string;
  startedAt?: number | null;
  finishedAt?: number | null;
  durationMs?: number | null;
  durationSource?: 'artifact-timestamps' | 'reported-timing' | string;
};

export type CaptureProcessingCamera = {
  cameraId: string;
  sequenceNo?: number | null;
  captureRound?: number | null;
  capturedAt?: string | null;
  artifactCount: number;
  artifactBytes: number;
};

export type ImageProcessingArtifact = {
  kind: string;
  size: number;
  sha256: string;
  updatedAt?: number | null;
  available: boolean;
};

export type CaptureProcessingLogRecord = {
  materialId: string;
  flowNo?: number | null;
  sessionId: string;
  dataStatus: ProcessingDataStatus;
  dataStatusLabel: string;
  updatedAt: number;
  capture: ProcessingStage & {
    state: string;
    latestCommittedRound?: number | null;
    expectedCameraCount?: number | null;
    actualCameraCount: number;
    complete: boolean;
    cameras: CaptureProcessingCamera[];
  };
  image: ProcessingStage & {
    complete: boolean;
    productionCameraPipeline: boolean;
    artifactCount: number;
    artifacts: ImageProcessingArtifact[];
  };
  algorithm: ProcessingStage & {
    state: string;
    defectState: string;
    mode?: string | null;
    frameCount: number;
    defectCount: number;
    processedFrames: number;
    skippedFrames: number;
    throughputFramesPerSecond?: number | null;
    timingsMs: Record<string, number>;
    metricValid: boolean;
    synchronized: boolean;
    riskTags: string[];
    qualityReason?: string | null;
    modelSetId?: string | null;
    algorithmRevision?: string | number | null;
    configHash?: string | null;
  };
};

export type CaptureProcessingLogPage = {
  code: number;
  schema: 'steel.capture-processing-log.v1' | string;
  updatedAt: string;
  total: number;
  records: CaptureProcessingLogRecord[];
};

function newestFirst(left: CaptureProcessingLogRecord, right: CaptureProcessingLogRecord) {
  const leftFlow = Number(left.flowNo ?? left.materialId);
  const rightFlow = Number(right.flowNo ?? right.materialId);
  if (Number.isFinite(leftFlow) && Number.isFinite(rightFlow) && leftFlow !== rightFlow) {
    return rightFlow - leftFlow;
  }
  return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
}

async function processingLogError(response: Response) {
  try {
    const payload = await response.json() as { detail?: string; error?: string; message?: string };
    return payload.detail || payload.message || payload.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export async function fetchCaptureProcessingLog(
  limit = 50,
  signal?: AbortSignal,
): Promise<CaptureProcessingLogPage> {
  const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 50));
  const response = await fetch(
    `${getInspectionServiceOrigin()}/api/production/processing-log?limit=${boundedLimit}`,
    { headers: { Accept: 'application/json' }, signal },
  );
  if (!response.ok) {
    throw new Error(`采集算法处理日志读取失败：${await processingLogError(response)}`);
  }
  const payload = await response.json() as CaptureProcessingLogPage;
  if (!payload || !Array.isArray(payload.records)) {
    throw new Error('采集算法处理日志响应格式无效');
  }
  const records = [...payload.records].sort(newestFirst);
  return { ...payload, total: records.length, records };
}
