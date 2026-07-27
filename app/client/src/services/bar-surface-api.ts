import { getInspectionServiceOrigin } from './inspection-api';

export type BarSurfaceCamera = {
  name: string;
  ip: string;
  sn: string;
  root: string;
  frameCount: number;
  latestFrame: string;
  size: { width: number; height: number };
  cropBox: number[];
  cropSource?: string;
  medianDepth: number;
  depthSpread: number;
  calibrationApplied?: boolean;
  calibrationSn?: string;
  calibrationRotateY?: number | null;
  captureConfig?: Record<string, unknown>;
  latest: {
    depthPreview: string;
    intensityPreview: string;
    metadata: string;
    sourceDepth: string;
    sourceIntensity: string;
  };
  relative: {
    depthPreview: string;
    intensityPreview: string;
    intensityStrip: string;
    depthStrip: string;
  };
};

export type BarSurfaceManifest = {
  schema: string;
  algorithmName?: string;
  algorithmVersion?: string;
  configRevision?: string;
  configSha256?: string;
  scriptSha256?: string;
  coreSha256?: string;
  releaseCommit?: string;
  acceptanceReportSha256?: string;
  datasetRevision?: string;
  datasetSha256?: string;
  evaluatorRevision?: string;
  evaluatorSha256?: string;
  calibrationRevision?: string;
  calibrationSha256?: string;
  inputSummarySha256?: string;
  inputFrameIds?: string[];
  inputArtifactCount?: number;
  inputArtifacts?: Array<{
    camera: string;
    frameId: string;
    kind: string;
    path: string;
    bytes: number;
    sha256: string;
  }>;
  thresholds?: Record<string, number | boolean>;
  qualification?: Record<string, string>;
  qualityGate?: {
    passed?: boolean;
    reasons?: string[];
  };
  realDefectCount?: number;
  syntheticDefectCount?: number;
  materialId: string;
  runId: string;
  createdAt: string;
  captureRoot: string;
  algorithmRoot: string;
  runDir: string;
  cameraCount: number;
  calibration?: {
    mode: string;
    path: string;
    available: boolean;
    matchedCameras: number;
    totalCameras: number;
    revision?: string;
    sha256?: string;
  };
  inputCrop?: {
    schema?: string;
    source?: string;
    applied?: boolean;
    reason?: string;
    radiusToleranceMm?: number;
    toleranceMode?: string;
    matchedCameras?: number;
    totalCameras?: number;
    circleFit?: BarSurfaceContourCrop['circleFit'];
    perCamera?: Record<string, {
      camera?: string;
      ip?: string;
      sn?: string;
      source?: string;
      reason?: string;
      pointCount?: number;
      keptPointCount?: number;
      keptPointRatio?: number;
      radiusToleranceMm?: number;
      imageCropBox?: number[];
      cropBox?: number[];
    }>;
  };
  quality?: {
    schema?: string;
    stitchMode?: string;
    calibratedCameraCount?: number;
    validPointCount?: number;
    calibratedPointCount?: number;
    boundsMm?: Record<string, [number, number]>;
    circleFit?: {
      available?: boolean;
      centerX?: number;
      centerZ?: number;
      radius?: number;
      diameter?: number;
      meanAbsResidual?: number;
      stdResidual?: number;
      maxAbsResidual?: number;
      pointCount?: number;
      robustPointCount?: number;
      reason?: string;
    };
    seamGapMm?: {
      available?: boolean;
      mean?: number;
      p95?: number;
      max?: number;
      sampleCount?: number;
    };
    contourCrop?: BarSurfaceContourCrop;
    coordinateFrame?: BarSurfaceCoordinateFrame;
    angularSectorFit?: BarSurfaceAngularSectorFit;
    topology?: BarSurfaceTopology;
    surfaceCompleteness?: {
      keptQuadRatio?: number;
      triangleCount?: number;
    };
  };
  mesh: {
    json: string;
    obj: string;
    mtl: string;
    texture: string;
    textureSize: { width: number; height: number };
    vertexCount: number;
    triangleCount: number;
    frameCount: number;
    rows: number;
    colsPerCamera: number;
    topology?: BarSurfaceTopology;
    contourCrop?: BarSurfaceContourCrop;
    coordinateFrame?: BarSurfaceCoordinateFrame;
    angularSectorFit?: BarSurfaceAngularSectorFit;
  };
  core?: BarSurfaceCoreInfo;
  reports?: {
    artifactIndex?: string;
    acceptanceReport?: string;
  };
  acceptance?: {
    status?: string;
    generatedAt?: string;
    report?: string;
    reportRelative?: string;
    passedChecks?: number;
    totalChecks?: number;
    failedChecks?: string[];
    sdkDerivedDisabled?: boolean;
    frontendReady?: boolean;
  };
  relative: {
    meshJson: string;
    quality?: string;
    obj: string;
    mtl: string;
    texture: string;
    artifactIndex?: string;
    acceptanceReport?: string;
  };
  cameras: BarSurfaceCamera[];
  notes?: string[];
};

export type BarSurfaceCoreInfo = {
  available?: boolean;
  summaryPath?: string;
  summaryRelative?: string;
  binary?: string;
  binaryRelative?: string;
  summary?: {
    schema?: string;
    coordinateUnit?: string;
    vertexCount?: number;
    triangleCount?: number;
    indexCount?: number;
    inputBytes?: number;
    outputBytes?: number;
    rows?: number;
    colsPerCamera?: number;
    cameraCount?: number;
    calibratedCameraCount?: number;
    hasValidMask?: boolean;
    hasCalibratedMask?: boolean;
  };
};

export type BarSurfaceContourCrop = {
  enabled?: boolean;
  applied?: boolean;
  source?: string;
  reason?: string;
  toleranceMode?: string;
  radiusToleranceMm?: number;
  baseValidPointCount?: number;
  keptPointCount?: number;
  removedPointCount?: number;
  keptPointRatio?: number;
  minKeepRatio?: number;
  minRowCoverage?: number;
  autoPercentile?: number;
  fallbackToleranceMm?: number;
  rowCoverage?: {
    min?: number;
    mean?: number;
    max?: number;
  };
  residualMm?: {
    median?: number;
    p90?: number;
    p95?: number;
    p99?: number;
    max?: number;
  };
  circleFit?: {
    available?: boolean;
    centerX?: number;
    centerZ?: number;
    radius?: number;
    diameter?: number;
    meanAbsResidual?: number;
    stdResidual?: number;
    maxAbsResidual?: number;
    pointCount?: number;
    robustPointCount?: number;
    reason?: string;
  };
};

export type BarSurfaceLatest = {
  schema: string;
  updatedAt: string;
  algorithmRoot: string;
  materialId: string;
  runId: string;
  runDir: string;
  manifestPath: string;
};

export type BarSurfaceLatestResponse = {
  code: number;
  root: string;
  latest: BarSurfaceLatest;
  manifest: BarSurfaceManifest;
};

export type BarSurfaceMesh = {
  schema: string;
  coordinateUnit: string;
  coordinateFrame?: BarSurfaceCoordinateFrame;
  cameraCount: number;
  frameStems: string[];
  rows: number;
  colsPerCamera: number;
  positions: ArrayLike<number>;
  uvs: ArrayLike<number>;
  colors: ArrayLike<number>;
  validMask?: ArrayLike<number>;
  calibratedMask?: ArrayLike<number>;
  indices: ArrayLike<number>;
  source?: 'core-bsmesh' | 'bkv-bsmesh' | 'json';
  binaryBytes?: number;
};

export type BarSurfaceTopology = {
  maxFaceEdgeMm?: number;
  candidateQuads?: number;
  keptQuads?: number;
  skippedInvalidQuads?: number;
  skippedGapQuads?: number;
};

export type BarSurfaceCaptureCamera = {
  name: string;
  root: string;
  path: string;
  present: boolean;
  depthCount: number;
  intensityCount: number;
  metadataCount: number;
};

export type BarSurfaceCaptureMaterial = {
  materialId: string;
  path: string;
  complete: boolean;
  cameraCount: number;
  minDepthFrames: number;
  updatedAtMillis: number;
  cameras: BarSurfaceCaptureCamera[];
};

export type BarSurfaceCapturesResponse = {
  code: number;
  captureRoot: string;
  configuration?: BarSurfaceRuntimeConfiguration;
  materials: BarSurfaceCaptureMaterial[];
};

export type BarSurfaceRuntimeConfiguration = {
  schema: 'steel.algorithm-runtime-config.v1' | string;
  desired: { captureRoot: string; algorithmRoot: string; algorithmConfig: string; algorithmCalibration?: string };
  active: {
    captureRoot: string;
    algorithmRoot: string;
    algorithmConfig: string;
    algorithmCalibration?: string;
    algorithmName?: string;
    algorithmVersion?: string;
    configRevision?: string;
    configSha256?: string;
    thresholds?: Record<string, number | boolean>;
  };
  readback: {
    ready: boolean;
    configValid: boolean;
    algorithmRootExists: boolean;
    captureRootExists: boolean;
    paths?: {
      ok: boolean;
      status: string;
      captureRoot: { path: string; absolute: boolean; exists: boolean; typeValid: boolean; ready: boolean };
      algorithmRoot: { path: string; absolute: boolean; exists: boolean; typeValid: boolean; ready: boolean };
      algorithmConfig: { path: string; absolute: boolean; exists: boolean; typeValid: boolean; ready: boolean };
      algorithmCalibration: { path: string; absolute: boolean; exists: boolean; typeValid: boolean; ready: boolean; reason?: string };
    };
  };
};

export type BarSurfaceRun = {
  materialId: string;
  runId: string;
  createdAt: string;
  runDir: string;
  manifestPath: string;
  manifestRelative: string;
  cameraCount: number;
  frameCount: number;
  vertexCount: number;
  triangleCount: number;
  coreAvailable?: boolean;
  coreOutputBytes?: number;
  coreBinaryRelative?: string;
  coreSummaryRelative?: string;
  updatedAtMillis: number;
};

export type BarSurfaceRunsResponse = {
  code: number;
  root: string;
  configuration?: BarSurfaceRuntimeConfiguration;
  runs: BarSurfaceRun[];
};

export type BarSurfaceProductionStatus = {
  code: number;
  database?: {
    engine?: string;
    path?: string;
  };
  latestSession?: {
    id: string;
    materialId: string;
    status: string;
    controlMode?: string;
    triggerMode?: string;
    updatedAt?: string;
  } | null;
  activeSession?: {
    id: string;
    materialId: string;
    status: string;
    controlMode?: string;
    triggerMode?: string;
    updatedAt?: string;
  } | null;
  latestInspection?: {
    id: string;
    materialId: string;
    sessionId: string;
    status: string;
    summaryPath: string;
    captureCount: number;
    defectCount: number;
    startedAt: string;
    finishedAt: string;
  } | null;
  capture?: {
    phase?: string;
    phaseLabel?: string;
    present?: boolean;
    saveEnabled?: boolean;
    saveSdkDerivedDefault?: boolean;
    connectedCameras?: number;
    streamingCameras?: number;
    productionCaptureRunning?: boolean;
    productionCaptureStartedAt?: string;
    productionCaptureFinishedAt?: string;
    algorithmPhase?: string;
  };
  tasks?: {
    queueDepth?: number;
    capacity?: number;
    worker?: {
      running?: boolean;
      activeTaskId?: string | null;
      heartbeatAgeMs?: number;
      lastError?: string;
    };
  };
};

export type BarSurfaceProductionTask<T = unknown> = {
  id: string;
  taskId: string;
  kind: 'capture-once' | 'algorithm-run' | string;
  materialId: string;
  sessionId: string;
  chainId?: string;
  dependsOnTaskId?: string | null;
  dependencyPolicy?: 'require-success' | 'always-run' | string;
  blockedReason?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'blocked' | string;
  phase: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  cancelRequested: boolean;
  result: T | null;
  error: string;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  updatedAt: string;
};

type ProductionTaskEnvelope<T> = {
  code: number;
  duplicate?: boolean;
  task: BarSurfaceProductionTask<T>;
};

function productionTaskRequestId(kind: string) {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId || `${kind}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function waitForProductionTask<T>(
  kind: 'capture-once' | 'algorithm-run',
  payload: Record<string, unknown>,
  onTaskStatus?: (task: BarSurfaceProductionTask<T>) => void,
): Promise<T> {
  const response = await fetch(`${origin()}/api/production/tasks`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind,
      idempotencyKey: productionTaskRequestId(kind),
      maxAttempts: 1,
      payload,
    }),
  });
  let envelope = await readJsonResponse<ProductionTaskEnvelope<T>>(response, 'production task enqueue failed');
  onTaskStatus?.(envelope.task);
  const deadline = Date.now() + 60 * 60 * 1000;
  while (!['succeeded', 'failed', 'cancelled', 'interrupted', 'blocked'].includes(envelope.task.status)) {
    if (Date.now() >= deadline) {
      throw new Error(`production task ${envelope.task.taskId} did not finish within one hour`);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    const detailResponse = await fetch(
      `${origin()}/api/production/tasks/detail?id=${encodeURIComponent(envelope.task.taskId)}`,
      { headers: { Accept: 'application/json' } },
    );
    envelope = await readJsonResponse<ProductionTaskEnvelope<T>>(
      detailResponse,
      'production task status failed',
    );
    onTaskStatus?.(envelope.task);
  }
  if (envelope.task.status !== 'succeeded' || !envelope.task.result) {
    throw new Error(
      envelope.task.error || `production task ${envelope.task.taskId} ended as ${envelope.task.status}`,
    );
  }
  return envelope.task.result;
}

export async function cancelBarSurfaceProductionTask<T = unknown>(taskId: string) {
  const response = await fetch(`${origin()}/api/production/tasks/cancel`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId }),
  });
  const payload = await readJsonResponse<ProductionTaskEnvelope<T>>(
    response,
    'production task cancellation failed',
  );
  return payload.task;
}

export type BarSurfaceProductionRunResponse = {
  code: number;
  materialId: string;
  sessionId: string;
  inspectionId: string;
  record: {
    id: string;
    status: string;
    summaryPath: string;
    captureCount: number;
    defectCount: number;
  };
  algorithm: {
    code: number;
    stdout?: string;
    stderr?: string;
    core?: {
      attempted?: boolean;
      available?: boolean;
      status?: number;
      stdout?: string;
      stderr?: string;
      error?: string;
    };
    result: BarSurfaceLatestResponse;
  };
};

export type BarSurfaceProductionEventResponse = {
  code: number;
  materialId: string;
  sessionId: string;
  inspectionId: string;
  triggerEventId?: number;
  mode?: string;
  triggerMode?: string;
  flow?: {
    recordWrittenBeforeCapture?: boolean;
    captureSaveState?: string;
    saveEnabled?: boolean;
    discardBlackFrames?: boolean;
    algorithmPhase?: string;
  };
  provider?: Record<string, unknown>;
};

export type BarSurfaceProductionCaptureResponse = {
  code: number;
  materialId: string;
  sessionId: string;
  provider?: {
    code?: number;
    attempts?: number;
    successes?: number;
    failures?: number;
    completeFrames?: number;
    metadataFrames?: number;
    discardedFrames?: number;
    blackFrames?: number;
    summaryOutput?: string;
    saveSdkDerived?: boolean;
    results?: Array<Record<string, unknown>>;
  };
  record?: {
    code?: number;
    materialId?: string;
    sessionId?: string;
    inspectionId?: string;
    captureFileRows?: number;
  };
};

export type BarSurfaceCalibrationFitReport = {
  schema?: string;
  status?: 'corrected' | 'skipped-no-target' | 'rejected-quality' | string;
  calibration?: string;
  dataDir?: string;
  captureRoot?: string;
  materialId?: string;
  rows?: number[];
  outputDir?: string;
  correctedXml?: string;
  beforePreview?: string;
  afterPreview?: string;
  correctionsCsv?: string;
  pointsCsv?: string;
  cameraCount?: number;
  expectedCameras?: number;
  maxShiftMm?: number;
  targetDetection?: {
    detected?: boolean;
    reasons?: string[];
    expectedCameras?: number;
    cameraCount?: number;
    pointCount?: number;
    diameterMm?: number;
    angularCoverageDeg?: number;
    meanAbsResidualMm?: number;
    residualLimitMm?: number;
    robustInlierRatio?: number;
  };
  correctionAccepted?: boolean;
  correctionQuality?: {
    accepted?: boolean;
    reasons?: string[];
    beforeMeanAbsResidualMm?: number;
    afterMeanAbsResidualMm?: number;
    improvementRatio?: number;
    minimumImprovementRatio?: number;
    saturatedCameras?: string[];
  };
  fitBefore?: {
    radius?: number;
    diameter?: number;
    meanAbsResidual?: number;
    maxAbsResidual?: number;
    pointCount?: number;
    robustPointCount?: number;
  };
  fitAfter?: {
    radius?: number;
    diameter?: number;
    meanAbsResidual?: number;
    maxAbsResidual?: number;
    pointCount?: number;
    robustPointCount?: number;
  };
  corrections?: Array<{
    ip?: string;
    sn?: string;
    dx?: number;
    dz?: number;
    shiftMagnitude?: number;
    before?: { meanAbsResidual?: number; maxAbsResidual?: number };
    after?: { meanAbsResidual?: number; maxAbsResidual?: number };
    depthPath?: string;
  }>;
  note?: string;
};

export type BarSurfaceCalibrationFitResponse = {
  code: number;
  stdout?: string;
  stderr?: string;
  capture?: {
    code?: number;
    successes?: number;
    failures?: number;
    completeFrames?: number;
    metadataFrames?: number;
    summaryOutput?: string;
  };
  fit?: {
    code?: number;
    stdout?: string;
    stderr?: string;
  };
  autoActivation?: {
    attempted?: boolean;
    activated?: boolean;
    saveToDevice?: boolean;
    reason?: string;
    profile?: string;
    version?: string;
    calibrationPath?: string;
  };
  result: BarSurfaceCalibrationFitReport;
};

export type BarSurfaceCoordinateFrame = {
  schema?: string;
  applied?: boolean;
  origin?: string;
  targetOrigin?: string;
  axis?: string;
  fitSource?: string;
  translationMm?: { x?: number; y?: number; z?: number };
  reason?: string;
};

export type BarSurfaceAngularSectorFit = {
  schema?: string;
  applied?: boolean;
  method?: string;
  direction?: 'clockwise' | 'counter-clockwise' | string;
  phaseDeg?: number;
  sectorWidthDeg?: number;
  fitScoreDegRms?: number;
  reason?: string;
  cameras?: Array<{
    cameraIndex?: number;
    observedCenterDeg?: number;
    targetCenterDeg?: number;
    angularCorrectionDeg?: number;
    sectorWidthDeg?: number;
    inputPointCount?: number;
    resampledRows?: number;
  }>;
};

function origin() {
  return getInspectionServiceOrigin();
}

export function barSurfaceFileUrl(pathOrRelative: string) {
  const params = new URLSearchParams();
  const normalized = pathOrRelative.replaceAll('\\', '/');
  if (/^[A-Za-z]:\//.test(normalized)) {
    params.set('path', pathOrRelative);
  } else {
    params.set('relative', normalized);
  }
  return `${origin()}/api/algorithm/bar-surface/file?${params.toString()}`;
}

async function readJsonResponse<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    let message = fallback;
    try {
      const payload = (await response.json()) as { error?: string };
      message = payload.error || message;
    } catch {
      message = await response.text();
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

function listOrEmpty<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function requireBytes(buffer: ArrayBuffer, offset: number, byteCount: number, label: string) {
  if (offset + byteCount > buffer.byteLength) {
    throw new Error(`invalid bsmesh: ${label} exceeds file size`);
  }
}

function parseBarSurfaceBsmesh(buffer: ArrayBuffer, manifest: BarSurfaceManifest): BarSurfaceMesh {
  const headerBytes = 40;
  requireBytes(buffer, 0, headerBytes, 'header');
  const magic = Array.from(new Uint8Array(buffer, 0, 8), (byte) => String.fromCharCode(byte)).join('');
  if (magic !== 'BSMESH01') {
    throw new Error(`invalid bsmesh magic: ${magic}`);
  }
  const view = new DataView(buffer);
  const version = view.getUint32(8, true);
  if (version !== 1) {
    throw new Error(`unsupported bsmesh version: ${version}`);
  }

  const vertexCount = view.getUint32(12, true);
  const indexCount = view.getUint32(16, true);
  const flags = view.getUint32(20, true);
  const rows = view.getUint32(24, true);
  const colsPerCamera = view.getUint32(28, true);
  const cameraCount = view.getUint32(32, true);
  let offset = headerBytes;

  const positionsBytes = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  requireBytes(buffer, offset, positionsBytes, 'positions');
  const positions = new Float32Array(buffer, offset, vertexCount * 3);
  offset += positionsBytes;

  const uvBytes = vertexCount * 2 * Float32Array.BYTES_PER_ELEMENT;
  requireBytes(buffer, offset, uvBytes, 'uvs');
  const uvs = new Float32Array(buffer, offset, vertexCount * 2);
  offset += uvBytes;

  const colorBytes = vertexCount * 3 * Float32Array.BYTES_PER_ELEMENT;
  requireBytes(buffer, offset, colorBytes, 'colors');
  const colors = new Float32Array(buffer, offset, vertexCount * 3);
  offset += colorBytes;

  const indexBytes = indexCount * Uint32Array.BYTES_PER_ELEMENT;
  requireBytes(buffer, offset, indexBytes, 'indices');
  const indices = new Uint32Array(buffer, offset, indexCount);
  offset += indexBytes;

  let validMask: Uint8Array | undefined;
  if ((flags & 0x02) !== 0) {
    requireBytes(buffer, offset, vertexCount, 'validMask');
    validMask = new Uint8Array(buffer, offset, vertexCount);
    offset += vertexCount;
  }

  let calibratedMask: Uint8Array | undefined;
  if ((flags & 0x04) !== 0) {
    requireBytes(buffer, offset, vertexCount, 'calibratedMask');
    calibratedMask = new Uint8Array(buffer, offset, vertexCount);
  }

  return {
    schema: 'steel.bar_surface.mesh.bsmesh.v1',
    coordinateUnit: manifest.core?.summary?.coordinateUnit || 'mm',
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
    source: 'core-bsmesh',
    binaryBytes: buffer.byteLength,
  };
}

export async function fetchBarSurfaceLatest(signal?: AbortSignal): Promise<BarSurfaceLatestResponse> {
  const response = await fetch(`${origin()}/api/algorithm/bar-surface/latest`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  return readJsonResponse<BarSurfaceLatestResponse>(response, 'bar surface latest unavailable');
}

export async function fetchBarSurfaceMesh(manifest: BarSurfaceManifest, signal?: AbortSignal): Promise<BarSurfaceMesh> {
  const binaryPath = manifest.core?.available ? manifest.core.binaryRelative || manifest.core.binary || '' : '';
  if (binaryPath) {
    try {
      const binaryResponse = await fetch(barSurfaceFileUrl(binaryPath), {
        headers: { Accept: 'application/octet-stream' },
        signal,
      });
      if (!binaryResponse.ok) {
        throw new Error(`bar surface core mesh unavailable (${binaryResponse.status})`);
      }
      return parseBarSurfaceBsmesh(await binaryResponse.arrayBuffer(), manifest);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      console.warn('Falling back to JSON bar surface mesh', error);
    }
  }
  const response = await fetch(barSurfaceFileUrl(manifest.relative.meshJson || manifest.mesh.json), {
    headers: { Accept: 'application/json' },
    signal,
  });
  const mesh = await readJsonResponse<BarSurfaceMesh>(response, 'bar surface mesh unavailable');
  return { ...mesh, source: 'json' };
}

export async function fetchBarSurfaceManifest(relativeOrPath: string, signal?: AbortSignal): Promise<BarSurfaceManifest> {
  const params = new URLSearchParams();
  const normalized = relativeOrPath.replaceAll('\\', '/');
  if (/^[A-Za-z]:\//.test(normalized)) {
    params.set('path', relativeOrPath);
  } else {
    params.set('relative', normalized);
  }
  const response = await fetch(`${origin()}/api/algorithm/bar-surface/manifest?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  return readJsonResponse<BarSurfaceManifest>(response, 'bar surface manifest unavailable');
}

export async function fetchBarSurfaceCaptures(signal?: AbortSignal): Promise<BarSurfaceCapturesResponse> {
  const response = await fetch(`${origin()}/api/algorithm/bar-surface/captures`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  const payload = await readJsonResponse<Partial<BarSurfaceCapturesResponse>>(response, 'bar surface captures unavailable');
  return {
    code: typeof payload.code === 'number' ? payload.code : 0,
    captureRoot: payload.captureRoot || '',
    configuration: payload.configuration,
    materials: listOrEmpty(payload.materials),
  };
}

export async function fetchBarSurfaceRuns(materialId?: string, signal?: AbortSignal): Promise<BarSurfaceRunsResponse> {
  const params = new URLSearchParams();
  if (materialId) {
    params.set('materialId', materialId);
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const response = await fetch(`${origin()}/api/algorithm/bar-surface/runs${suffix}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  const payload = await readJsonResponse<Partial<BarSurfaceRunsResponse>>(response, 'bar surface runs unavailable');
  return {
    code: typeof payload.code === 'number' ? payload.code : 0,
    root: payload.root || '',
    configuration: payload.configuration,
    runs: listOrEmpty(payload.runs),
  };
}

export async function fetchBarSurfaceProductionStatus(signal?: AbortSignal): Promise<BarSurfaceProductionStatus> {
  const response = await fetch(`${origin()}/api/production/status`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  return readJsonResponse<BarSurfaceProductionStatus>(response, 'production status unavailable');
}

export async function sendBarSurfaceProductionEvent(
  event: 'steel-info' | 'steel-in' | 'steel-out',
  options: {
    materialId?: string;
    sessionId?: string;
    acquisitionMode?: string;
    triggerMode?: string;
    autoCapture?: boolean;
    steelType?: string;
    lengthMm?: number;
    widthMm?: number;
    thicknessMm?: number;
  } = {},
): Promise<BarSurfaceProductionEventResponse> {
  const body: Record<string, unknown> = {
    source: 'bar-surface-ui',
    mode: 'manual',
    triggerMode: options.triggerMode ?? 'manual',
    acquisitionMode: options.acquisitionMode ?? 'manual',
    autoCapture: options.autoCapture ?? false,
    discardBlackFrames: true,
    saveSdkDerived: false,
    steelType: options.steelType ?? 'round-bar',
    lengthMm: options.lengthMm ?? 0,
    widthMm: options.widthMm ?? 0,
    thicknessMm: options.thicknessMm ?? 0,
  };
  if (options.materialId) {
    body.materialId = options.materialId;
    body.steelId = options.materialId;
  }
  if (options.sessionId) {
    body.sessionId = options.sessionId;
  }
  const response = await fetch(`${origin()}/api/production/${event}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJsonResponse<BarSurfaceProductionEventResponse>(response, `production ${event} failed`);
}

export async function captureBarSurfaceProductionOnce(options: {
  materialId?: string;
  sessionId?: string;
  rounds?: number;
  lines?: number;
  timeoutMs?: number;
  intervalMs?: number;
  onTaskStatus?: (task: BarSurfaceProductionTask<BarSurfaceProductionCaptureResponse>) => void;
} = {}): Promise<BarSurfaceProductionCaptureResponse> {
  const body: Record<string, unknown> = {
    materialId: options.materialId || 'latest',
    expectedCameras: 8,
    rounds: options.rounds ?? 1,
    lines: options.lines ?? 1000,
    width: 0,
    timeoutMs: options.timeoutMs ?? 8000,
    intervalMs: options.intervalMs ?? 500,
    retries: 0,
    controlMode: 0,
    dataMode: 3,
    connectFirst: false,
    stopStreams: true,
    productionLayout: true,
    steelStateAware: true,
    requireSteelPresent: true,
    discardBlackFrames: true,
    saveSdkDerived: false,
  };
  if (options.sessionId) {
    body.sessionId = options.sessionId;
  }
  return waitForProductionTask<BarSurfaceProductionCaptureResponse>(
    'capture-once',
    body,
    options.onTaskStatus,
  );
}

export async function runBarSurfacePrototype(options: {
  materialId?: string;
  calibrationPath?: string;
  maxFrames?: number;
  meshRows?: number;
  meshColsPerCamera?: number;
  maxFaceEdgeMm?: number;
  contourCrop?: boolean;
  contourRadiusToleranceMm?: number;
  contourMinKeepRatio?: number;
  contourMinRowCoverage?: number;
  contourAutoPercentile?: number;
  runCore?: boolean;
} = {}): Promise<BarSurfaceLatestResponse> {
  const body: Record<string, unknown> = {
    materialId: options.materialId || 'latest',
    maxFrames: options.maxFrames ?? 24,
    meshRows: options.meshRows ?? 144,
    meshColsPerCamera: options.meshColsPerCamera ?? 72,
    maxFaceEdgeMm: options.maxFaceEdgeMm ?? 8,
    contourCrop: options.contourCrop ?? true,
    contourRadiusToleranceMm: options.contourRadiusToleranceMm ?? 0,
    contourMinKeepRatio: options.contourMinKeepRatio ?? 0.55,
    contourMinRowCoverage: options.contourMinRowCoverage ?? 0.25,
    contourAutoPercentile: options.contourAutoPercentile ?? 96,
    runCore: options.runCore ?? true,
  };
  if (options.calibrationPath) {
    body.calibrationPath = options.calibrationPath;
  }
  const response = await fetch(`${origin()}/api/algorithm/bar-surface/run`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await readJsonResponse<{ result?: BarSurfaceLatestResponse }>(response, 'bar surface run failed');
  if (!payload.result) {
    throw new Error('bar surface run returned no result');
  }
  return payload.result;
}

export async function runBarSurfaceProductionAlgorithm(options: {
  materialId?: string;
  sessionId?: string;
  inspectionId?: string;
  calibrationPath?: string;
  runCore?: boolean;
  onTaskStatus?: (task: BarSurfaceProductionTask<BarSurfaceProductionRunResponse>) => void;
} = {}): Promise<BarSurfaceProductionRunResponse> {
  const body: Record<string, unknown> = {
    materialId: options.materialId || 'latest',
    runCore: options.runCore ?? true,
  };
  if (options.sessionId) {
    body.sessionId = options.sessionId;
  }
  if (options.inspectionId) {
    body.inspectionId = options.inspectionId;
  }
  if (options.calibrationPath) {
    body.calibrationPath = options.calibrationPath;
  }
  return waitForProductionTask<BarSurfaceProductionRunResponse>(
    'algorithm-run',
    body,
    options.onTaskStatus,
  );
}

export async function fitBarSurfaceCalibration(options: {
  materialId?: string;
  captureRoot?: string;
  calibrationPath?: string;
  rows?: string;
  outputRoot?: string;
  maxPointsPerCamera?: number;
  maxShiftMm?: number;
  minPointsPerCamera?: number;
  minDiameterMm?: number;
  maxDiameterMm?: number;
  minAngularCoverageDeg?: number;
  maxFitResidualMm?: number;
  maxRelativeResidual?: number;
  minImprovementRatio?: number;
  autoActivate?: boolean;
  profile?: string;
  expectedCameras?: number;
  lines?: number;
  width?: number;
  timeoutMs?: number;
  dataMode?: number;
  captureOutputDir?: string;
  ips?: string[];
  onTaskStatus?: (task: BarSurfaceProductionTask<BarSurfaceCalibrationFitResponse>) => void;
} = {}): Promise<BarSurfaceCalibrationFitResponse> {
  const body: Record<string, unknown> = {
    operation: 'calibration-capture-fit',
    captureRoot: options.captureRoot || 'H:\\',
    rows: options.rows || '250,500,750',
    maxPointsPerCamera: options.maxPointsPerCamera ?? 2400,
    maxShiftMm: options.maxShiftMm ?? 5,
    expectedCameras: options.expectedCameras ?? 8,
    minPointsPerCamera: options.minPointsPerCamera ?? 100,
    minDiameterMm: options.minDiameterMm ?? 20,
    maxDiameterMm: options.maxDiameterMm ?? 1000,
    minAngularCoverageDeg: options.minAngularCoverageDeg ?? 220,
    maxFitResidualMm: options.maxFitResidualMm ?? 8,
    maxRelativeResidual: options.maxRelativeResidual ?? 0.08,
    minImprovementRatio: options.minImprovementRatio ?? 0.03,
    autoActivate: options.autoActivate ?? true,
    profile: options.profile || 'current-8-time-trigger',
    lines: options.lines ?? 1000,
    width: options.width ?? 0,
    timeoutMs: options.timeoutMs ?? 8000,
    dataMode: options.dataMode ?? 3,
  };
  if (options.materialId) {
    body.materialId = options.materialId;
  }
  if (options.calibrationPath) {
    body.calibrationPath = options.calibrationPath;
  }
  if (options.outputRoot) {
    body.outputRoot = options.outputRoot;
  }
  if (options.captureOutputDir) {
    body.captureOutputDir = options.captureOutputDir;
  }
  if (options.ips?.length) {
    body.ips = options.ips;
  }
  return waitForProductionTask<BarSurfaceCalibrationFitResponse>(
    'algorithm-run',
    body,
    options.onTaskStatus,
  );
}
