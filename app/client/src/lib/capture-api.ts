import { invoke } from "@tauri-apps/api/core";
import {
  createAdminHeaders,
  getInspectionServiceOrigin,
  isWebHostedRuntime,
  parseBkvCaptureStatus,
  readAdminErrorMessage,
} from "../services/inspection-api";

export type CaptureDriverInfo = {
  id: string;
  name: string;
  vendor: string;
  transport: string;
  sdkVersion: string;
  supportedModels: string[];
  features: string[];
};

export type CaptureCamera = {
  ip: string;
  model: string;
  sn: string;
  cameraIndex?: number;
  cameraId?: string;
  name?: string;
  role?: string;
  storageRoot?: string;
  driverId?: string;
  source?: string;
  configured?: boolean;
};

export type PhysicalCaptureProvider = "headless-cpp" | "external-api" | "simulated";

export type BkvOfflineChannel = {
  index: number;
  status: "offline";
  source: "bkv";
};

export type PhysicalCaptureHealth = {
  service: string;
  time: string;
  provider?: PhysicalCaptureProvider;
  sdkReady: boolean;
  sdkCode: number;
  sdkVersion?: string;
  connected: boolean;
  ip: string;
  driverId?: string;
  driverName?: string;
  cameraCount?: number;
  expectedCameras?: number;
  acquisitionSynchronization?: CaptureSynchronizationStatus;
  storageQueue?: CaptureHealthStorageQueueStatus;
};

export type CaptureSynchronizationRound = {
  round: number;
  receivedCameras: number;
  complete: boolean;
  missingCameras: string[];
  hostCaptureSkewMs?: number | null;
  cameraSequenceSkew?: number | null;
  transportFrameIdsAvailable?: number;
  transportFrameGaps?: Record<string, number>;
};

export type CaptureSynchronizationStatus = {
  schema: "steel.capture-synchronization.v1" | string;
  status: "waiting" | "synchronized" | "degraded" | string;
  synchronized: boolean;
  expectedCameras: number;
  connectedCameras: number;
  windowRounds: number;
  completeRounds: number;
  incompleteRounds: number;
  completenessPercent: number;
  frameCounts: Record<string, number>;
  frameCountSkew: number;
  transportFrameGapCounts?: Record<string, number>;
  transportFrameGaps?: number;
  lifetimeTransportFrameGapCounts?: Record<string, number>;
  lifetimeTransportFrameGaps?: number;
  lastRound?: CaptureSynchronizationRound | null;
};

export type CaptureHealthStorageQueueStatus = {
  accepting?: boolean;
  capacityRounds?: number;
  pendingRounds?: number;
  activeRounds?: number;
  droppedRounds?: number;
  droppedFrames?: number;
  failedRounds?: number;
};

export type BkvCaptureHealth = {
  service: string;
  time: string;
  provider: "bkv";
  status: "bkv-offline";
  sdkRequired: false;
  sdkReady: null;
  connected: false;
  cameraCount: 6;
  channels: BkvOfflineChannel[];
  driverId?: never;
  sdkVersion?: never;
  sdkCode?: never;
  ip?: never;
  batchId?: string;
  contentId?: string;
  replay?: {
    index: number;
    total: number;
    status: "ready" | "replaying" | "completed";
    version: number;
    legacySeqNo?: number;
  };
};

export type CaptureHealth = PhysicalCaptureHealth | BkvCaptureHealth;

export type CaptureCameraStatus = {
  connected: boolean;
  deviceId: number;
  ip: string;
  driverId?: string;
  model?: string;
  sn?: string;
  configId?: string | null;
  name?: string | null;
  role?: string | null;
  enabled?: boolean;
  acquisitionState?:
    "connected" | "discovered" | "offline" | "disabled" | string;
  sdkStatus?: string;
  /**
   * Rolling rate of completed depth-map captures from the production
   * continuous-acquisition worker.  This is deliberately separate from the
   * preview stream's `streamRunning` / `streamFrames` telemetry.
   */
  continuousFps?: number | null;
  continuousFrameCount?: number | null;
  continuousFrameDelta?: number | null;
  continuousFinalizedCount?: number | null;
  continuousSuccessfulFrameCount?: number | null;
  continuousLastResultCode?: number | null;
  lastContinuousFrameAt?: string | null;
  continuousAcquiring?: boolean;
  fps?: number | null;
  bufferPercent?: number | null;
  lastFrameTime?: string | null;
  task?: number;
  status?: number;
  linkHealth?: number;
  temperatureJ28?: number;
  temperatureJ29?: number;
  temperatureJ30?: number;
  deviceTemperature?: number | null;
  deviceTemperatureMin?: number | null;
  deviceTemperatureMax?: number | null;
  temperatureUpdatedAt?: string | null;
  acquisitionFrameRate?: number | null;
  deviceLinkThroughputCurrent?: number | null;
  deviceLinkThroughputLimit?: number | null;
  transportFrameId?: number | null;
  transportFrameGapCount?: number;
  lifetimeTransportFrameGapCount?: number;
  transportFrameDropPercent?: number;
  synchronizationWindowRounds?: number;
  hasRecentFrameDrops?: boolean;
  lostPulseCounter?: number;
  bufferOverflowCounter?: number;
  streamRunning?: boolean;
  streamFrames?: number;
  streamFps?: number | null;
  streamLastFrameAt?: string | null;
  streamWidth?: number;
  streamHeight?: number;
  streamValidRoi?: number[] | null;
  streamDisplayWidth?: number;
  streamDisplayHeight?: number;
  storageRoot?: string;
  captureConfig?: CaptureSdkReadback;
  error?: string | null;
};

export type CaptureSdkReadback = {
  available?: boolean;
  controlMode?: number;
  ctrlType?: number;
  triggerInputType?: number;
  captureDataType?: number;
  triggerLines?: number;
  divRatio?: number;
  timeTriggerFreq?: number;
  maxFrameRate?: number;
  controlLabel?: string;
  triggerSourceLabel?: string;
  exposureTime?: number;
  gainK?: number;
  laserEnable?: number;
  arrayEnable?: number;
  laserPower?: number;
  laserLineSelect?: number;
};

export type CaptureCameraConfig = {
  id: string;
  name: string;
  ip: string;
  driverId: string;
  modelHint: string;
  role: string;
  enabled: boolean;
  triggerMode: string;
  exposureUs: number;
  gain: number;
  depthLines: number;
  outputPath: string;
};

export type CaptureAppliedConfig = {
  id: string;
  name: string;
  applied: boolean;
  updatedAt: string;
  cameras: CaptureCameraConfig[];
};

export type CaptureControlCapability = {
  id: string;
  label: string;
  scope: string;
  requiresConnection: boolean;
};

export type CaptureParameterCapability = {
  key: string;
  label: string;
  valueType: "int" | "float" | string;
  unit: string;
  min?: number | null;
  max?: number | null;
  writable: boolean;
};

export type CaptureApiCapability = {
  method: string;
  path: string;
  label: string;
  scope: string;
};

export type CaptureCapabilitySet = {
  driver: CaptureDriverInfo;
  controls: CaptureControlCapability[];
  parameters: CaptureParameterCapability[];
  api: CaptureApiCapability[];
};

export type CaptureLogEvent = {
  id: string;
  time: string;
  level: "info" | "warning" | "error" | string;
  source?: "provider-log" | "provider-snapshot" | "client-operation" | "system-operation";
  cameraIp?: string | null;
  message: string;
};

export type CaptureSnapshot = {
  health: CaptureHealth | null;
  driver: CaptureDriverInfo;
  config: CaptureAppliedConfig;
  cameras: CaptureCamera[];
  status: CaptureCameraStatus | null;
  statuses: CaptureCameraStatus[];
  capabilities: CaptureCapabilitySet;
  logs: CaptureLogEvent[];
  error: string | null;
};

export type SystemNetworkInterfaceSnapshot = {
  index: number;
  name: string;
  description?: string;
  status?: string;
  linkSpeed?: string;
  linkSpeedBitsPerSecond?: number;
  receivedBytes: number;
  transmittedBytes: number;
  packetsReceived?: number;
  packetsTransmitted?: number;
  uploadMbps?: number;
  downloadMbps?: number;
  bandwidthMbps?: number;
  online?: boolean;
};

export type SystemNetworkSnapshot = {
  code: number;
  source?: string;
  sampledAtMs: number;
  interfaces: SystemNetworkInterfaceSnapshot[];
  totalReceivedBytes: number;
  totalTransmittedBytes: number;
  totalUploadMbps?: number;
  totalDownloadMbps?: number;
  totalBandwidthMbps?: number;
  error?: string | null;
};

export type SystemNetworkRateInterface = SystemNetworkInterfaceSnapshot & {
  uploadMbps: number;
  downloadMbps: number;
  bandwidthMbps: number;
  online: boolean;
};

export type SystemNetworkRateSnapshot = {
  code: number;
  source?: string;
  sampledAtMs: number;
  interfaces: SystemNetworkRateInterface[];
  totalUploadMbps: number;
  totalDownloadMbps: number;
  totalBandwidthMbps: number;
  error?: string | null;
};

type ServiceConfigResponse = {
  service?: {
    name?: string;
    role?: string;
    capturePort?: number;
    captureOrigin?: string;
    updatedAt?: string;
  };
  capture?: {
    mode?: string;
    driver?: string;
    fallback?: string;
    cameras?: CaptureCameraConfig[];
  };
};

export type CaptureCommandResult = {
  code: number;
  connected?: boolean;
  ip?: string;
  key?: string;
  output?: string;
  imageUrl?: string;
  width?: number;
  lines?: number;
  error?: string;
  errorName?: string;
  operatorHint?: string;
  message?: string;
  value?: string | number;
  type?: string;
  calibrationCode?: number;
  calibrationPath?: string;
  roiCode?: number;
  roiPath?: string;
  path?: string;
  loadCode?: number;
  saveCode?: number;
  external?: boolean;
  saveToDevice?: boolean;
};

export type CaptureOutputMode = "continuous" | "on-demand" | "disabled";

export type CaptureOutputModeStatus = CaptureCommandResult & {
  captureMode?: CaptureOutputMode | string;
  automaticCaptureEnabled?: boolean;
  productionCaptureRunning?: boolean;
  captureModeChanged?: boolean;
};

export type CaptureContinuousSettingsInput = {
  /** Line trigger rate in Hz, not the completed depth-map FPS. */
  timeTriggerFreq: number;
  /** Defaults to the currently connected enabled cameras when omitted. */
  ips?: string[];
  /** False performs validation only; true applies a runtime-only SDK setting. */
  applyToDevice?: boolean;
  /** The provider pauses and resumes the continuous worker around a runtime update. */
  restartContinuous?: boolean;
};

export type CaptureContinuousSettingsResult = CaptureCommandResult & {
  timeTriggerFreq?: number;
  lineTriggerFrequency?: number;
  /** Provider compatibility: current C++ service returns the committed camera count. */
  applied?: number | boolean;
  appliedCount?: number;
  transactionCommitted?: boolean;
  validatedOnly?: boolean;
  runtimeOnly?: boolean;
  devicePersistent?: boolean;
  deviceReadbackVerified?: boolean;
  readbackSource?: string;
  dryRun?: boolean;
  restartContinuous?: boolean;
  captureMode?: CaptureOutputMode | string;
  results?: Array<CaptureCommandResult & {
    applied?: boolean;
    dryRun?: boolean;
    previousTimeTriggerFreq?: number;
    timeTriggerFreq?: number;
    lineTriggerFrequency?: number;
    sdkMaxAcquisitionFrameRate?: number;
    lineTriggerRateMaximumKnown?: boolean;
    deviceReadbackVerified?: boolean;
  }>;
  settings?: CaptureContinuousSettingsStatus;
};

export type CaptureContinuousSettingsStatus = {
  supported?: boolean;
  route?: string;
  connectedCameras?: number;
  configuredCameras?: number;
  timeTriggerFreq?: number;
  lineTriggerFrequency?: number;
  sdkMaxAcquisitionFrameRate?: number;
  lineTriggerRateMaximumKnown?: boolean;
  mixedLineTriggerFrequency?: boolean;
  requiresApplyToDevice?: boolean;
  runtimeOnly?: boolean;
  devicePersistent?: boolean;
  readbackSource?: string;
};

export type CaptureContinuousSettingsReadResult = CaptureCommandResult & {
  settings?: CaptureContinuousSettingsStatus;
};

export type CaptureImageKind = "depth" | "intensity" | "metadata" | "sdk-derived";

export type LatestCaptureFile = {
  code: number;
  ip: string;
  kind: CaptureImageKind;
  path: string;
  url: string;
  imageUrl: string;
  content?: string;
};

export type CaptureStreamStatus = CaptureCommandResult & {
  running: boolean;
  lines?: number;
  width?: number;
  dataMode?: number;
  fpsLimit?: number;
  hs?: boolean;
  frameCount?: number;
  latestDepthUrl?: string;
  latestIntensityUrl?: string;
};

export type CaptureStreamStartOptions = {
  ip: string;
  lines?: number;
  width?: number;
  dataMode?: number;
  fpsLimit?: number;
  hs?: boolean;
  controlMode?: number;
};

export type CaptureHistoryCameraFrame = {
  cameraId: string;
  cameraIndex: number;
  ip: string;
  artifactRef: string;
  storageIndex?: number;
  captureRound?: number;
  width: number;
  height: number;
  playbackWidth?: number;
  playbackHeight?: number;
  validRoi?: number[];
  sourceSize?: number[];
  displaySize?: number[];
  sourceOffset?: { x: number; y: number };
  regionState?: string;
  calibrationRevision?: string | null;
  bytes: number;
  storedAt: string;
};

export type CaptureHistoryFrame = {
  frameId: string;
  materialId: string;
  sequence: number;
  capturedAt: string;
  cameras: CaptureHistoryCameraFrame[];
};

export type CaptureHistoryResult = {
  code: number;
  storageRoot: string;
  total: number;
  count: number;
  hasMore: boolean;
  indexed?: boolean;
  catalogPath?: string;
  frames: CaptureHistoryFrame[];
};

export type CaptureRegionCamera = {
  cameraId: string;
  state: string;
  sourceSize: number[];
  stableCrop: number[] | null;
  sourceOffset: { x: number; y: number } | null;
  displaySize: number[];
  ownedColumnIntervals: number[][];
  overlapColumnIntervals: number[][];
};

export type CaptureRegionOverlapPair = {
  cameras: string[];
  angleIntervalsDeg: number[][];
  binCount: number;
};

export type CaptureRegionMap = {
  schema: "steel.capture-region-map.v1";
  materialId: string;
  state: string;
  backgroundReady: boolean;
  defectDetectionAllowed: boolean;
  qualityGate: { passed: boolean; reasons: string[] };
  calibration: { revision?: string | null; approved: boolean; sha256: string };
  ownership: {
    ready: boolean;
    reasons: string[];
    overlapPairCount?: number;
    pairs: CaptureRegionOverlapPair[];
  };
  cameras: Record<string, CaptureRegionCamera>;
};

export type CapturePlaybackCacheStatus = {
  code: number;
  schema: string;
  cacheRoot: string;
  cacheRoots: string[];
  renditionRoots: Array<{ cameraId: string; gray: string; jet: string }>;
  levels: ["thumbnail", "original"];
  modalities: ["gray", "jet"];
  generationPolicy: "full-flow-after-alignment";
  onDemandBuild: "recovery-only";
  catalogPath: string;
  catalogAvailable: boolean;
  memoryEntries: number;
  memoryHits: number;
  diskHits: number;
  renditionsBuilt: number;
  buildFailures: number;
  averageBuildMs?: number | null;
  twoLevelWarm?: Record<string, unknown>;
  fullHistory?: {
    state: string;
    policy: "full-history-after-alignment";
    catalogMaterialCount: number;
    catalogScannedCount: number;
    discoveredFlowCount: number;
    orphanFlowCount: number;
    rebuildableFlowCount: number;
    unreadyFlowCount: number;
    completedFlowCount: number;
    skippedCompleteFlowCount: number;
    failedFlowCount: number;
    retryCount: number;
    pendingRetryCount: number;
    currentMaterialId: string;
    currentSourceFrameCount: number;
    currentCommittedFrameCount: number;
    currentFailureCount: number;
    discoveryComplete: boolean;
    lastError: string;
    queueProgress: {
      position: number;
      total: number;
      depth: number;
      capacity: number;
    };
  };
};

export type CaptureMeasurementCamera = {
  available: boolean;
  storageIndex?: number;
  rowIndex?: number;
  rowClipped?: boolean;
  cropBox?: number[];
  validProfilePoints?: number;
  localProfile?: number[][];
  arrayProfile?: number[][] | null;
  calibrationApplied?: boolean;
  reason?: string;
};

export type CaptureMeasurementCircleFit = {
  available?: boolean;
  centerX?: number;
  centerZ?: number;
  radiusMm?: number;
  diameterMm?: number;
  meanAbsResidualMm?: number;
  p95AbsResidualMm?: number;
  maxAbsResidualMm?: number;
  roundnessMm?: number;
  pointCount?: number;
  robustPointCount?: number;
  reason?: string;
};

export type CaptureMeasurementSection = {
  anchorOrdinal?: number | null;
  elapsedFromHeadMs?: number | null;
  positionRatio?: number;
  rowMappingComplete?: boolean;
  metricValid?: boolean;
  qualityGate?: { passed: boolean; reasons: string[] };
  circleFit?: CaptureMeasurementCircleFit;
};

export type CaptureDirectionalDiameterSection = {
  anchorOrdinal?: number | null;
  elapsedFromHeadMs?: number | null;
  positionRatio?: number;
  metricValid?: boolean;
  qualityGate?: { passed: boolean; reasons: string[] };
  validAngleCount?: number;
  diametersMm: Array<number | null>;
  minimumMm?: number | null;
  maximumMm?: number | null;
  averageMm?: number | null;
};

export type CaptureDirectionalDiameterSeries = {
  id: string;
  kind: "fixed-angle" | "aggregate" | string;
  angleDeg?: number | null;
  label: string;
  valuesMm: Array<number | null>;
};

export type CaptureDirectionalDiameterCurves = {
  available?: boolean;
  metricValid?: boolean;
  model: "opposed-radial-pairs-from-reconstructed-surface" | string;
  angleConvention: string;
  longitudinalCoordinate: string;
  absoluteLongitudinalScaleVerified?: boolean;
  angularSampleHalfWindowDeg?: number;
  fixedAnglesDeg: number[];
  sections: CaptureDirectionalDiameterSection[];
  series: CaptureDirectionalDiameterSeries[];
  summary: {
    metricValid?: boolean;
    minimumMm?: number | null;
    maximumMm?: number | null;
    averageMm?: number | null;
    validSectionCount?: number;
    validSampleCount?: number;
    byAngle?: Array<{
      angleDeg: number;
      minimumMm?: number | null;
      maximumMm?: number | null;
      averageMm?: number | null;
      validSampleCount?: number;
    }>;
  };
};

export type CaptureFlowMeasurement = {
  schema: "steel.ranger3-flow-measurement.v1" | string;
  generatedAt: string;
  materialId: string;
  mode: "preview" | "metric" | string;
  metricValid: boolean;
  qualityGate: { passed: boolean; reasons: string[] };
  selectedSection: {
    anchorOrdinal?: number | null;
    elapsedFromHeadMs?: number | null;
    circleFit?: CaptureMeasurementCircleFit;
  };
  cameras: Record<string, CaptureMeasurementCamera>;
  surfaceFit?: {
    available?: boolean;
    metricValid?: boolean;
    absoluteLongitudinalScaleVerified?: boolean;
    reason?: string | null;
    model?: string;
    longitudinalCoordinate?: string;
    note?: string;
    maximumCircleResidualMm?: number;
    sectionsRequested?: number;
    sectionsAccepted?: number;
    sectionsRejected?: number;
    diameterMeanMm?: number;
    diameterMedianMm?: number;
    diameterMinimumMm?: number;
    diameterMaximumMm?: number;
    diameterStdDevMm?: number;
    diameterP05Mm?: number;
    diameterP95Mm?: number;
    diameterRangeMm?: number;
    roundnessMaximumMm?: number;
    fitResidualP95MaximumMm?: number;
    centerStraightnessMaximumMm?: number;
    headRelativeTimeSpanMs?: number;
    fullHeadRelativeTimeSpanMs?: number;
    sections?: CaptureMeasurementSection[];
    diameterCurves?: CaptureDirectionalDiameterCurves;
  };
};

export type CaptureMeasurementResponse = {
  code: number;
  path: string;
  measurement: CaptureFlowMeasurement;
};

export type CaptureSurfaceCameraTileRowAnchor = {
  row: number;
  anchorOrdinal?: number | null;
  elapsedFromHeadMs?: number | null;
  positionRatio?: number | null;
  storageIndex?: number | null;
  sourceRow?: number | null;
  sourceGlobalRow?: number | null;
  timeResidualMs?: number | null;
  interpolationResidualMs?: number | null;
  mappingMetricValid?: boolean;
  acceptedForSurface?: boolean;
  cropBox?: number[] | null;
};

export type CaptureSurfaceCameraTile = {
  cameraId: string;
  state: "ready" | "unavailable" | string;
  fixedAngleDeg?: number | null;
  sourceShape?: number[];
  cropBox?: number[];
  sourceOffset?: { x: number; y: number };
  rows: number;
  columns: number;
  coordinateLayout?: string;
  residualUnit?: "mm" | string;
  residuals?: Array<number | null>;
  validMask?: number[];
  sampleCounts?: number[];
  angleDegByColumn?: Array<number | null>;
  rowAnchors?: CaptureSurfaceCameraTileRowAnchor[];
  coverage?: {
    validSampleCount?: number;
    validRatio?: number;
    coverageAngleIntervalsDeg?: number[][];
    ownedAngleIntervalsDeg?: number[][];
    ownedColumnIntervals?: number[][];
    overlapColumnIntervals?: number[][];
  };
  jet?: {
    palette?: "JET" | string;
    minimumMm?: number;
    maximumMm?: number;
    zeroMm?: number;
    missingColor?: string;
    imagePath?: string;
  };
  defectMapping?: {
    coordinateSpace?: string;
    sourceCropBox?: number[];
    cameraRequired?: string;
    tileX?: string;
    tileXRatio?: string;
    tileRow?: string;
    longitudinalCoordinate?: string;
    angleLookup?: string;
  };
  reason?: string;
};

export type CaptureSurfaceCameraTiles = {
  schema: "steel.ranger3-camera-jet-tiles.v1" | string;
  coordinateSpace?: string;
  angleConvention?: string;
  rowOrder?: string;
  residualDefinition?: string;
  twoDimensionalCropSource?: string;
  regionManifestPath?: string;
  cameras: CaptureSurfaceCameraTile[];
};

export type CaptureFlowSurface = {
  schema: "steel.ranger3-flow-surface.v1" | string;
  generatedAt: string;
  materialId: string;
  state: "ready" | "unavailable" | string;
  quality: {
    crossSectionMetricValid: boolean;
    absoluteLongitudinalScaleVerified: boolean;
    geometrySynchronized: boolean;
    depthPrecisionMetricValid?: boolean;
    cameraCalibrationBiasMetricValid?: boolean;
    cameraOverlapMetricValid?: boolean;
    passed: boolean;
    reasons: string[];
    angularCoverageRatio: number;
  };
  depthPrecision?: {
    metricValid?: boolean;
    definition?: string;
    thresholdMm?: number;
    diagnosticSectionCount?: number;
    cameras?: Record<string, {
      sampledSectionCount?: number;
      depthPrecisionP95MedianMm?: number | null;
      depthPrecisionP95MaximumMm?: number | null;
      calibrationRadialBiasMedianMm?: number | null;
      calibrationRadialBiasP95AbsMm?: number | null;
      depthPrecisionMetricValid?: boolean;
      calibrationBiasMetricValid?: boolean;
    }>;
  };
  calibrationAccuracy?: {
    metricValid?: boolean;
    overlapP95ThresholdMm?: number;
    radialBiasThresholdMm?: number;
    diagnosticSectionCount?: number;
    worstOverlapPair?: {
      cameras?: string[];
      anchorOrdinal?: number | null;
      elapsedFromHeadMs?: number | null;
      sampleCount?: number;
      p95AbsRadialDifferenceMm?: number;
      maximumAbsRadialDifferenceMm?: number;
      metricValid?: boolean;
    } | null;
  };
  headAlignment?: {
    referenceCameraId?: string | null;
    origin?: string;
    aligned?: boolean;
    mode?: string;
    displayAligned?: boolean;
    referenceTimelinePositionFrames?: number | null;
    alignedTimelinePositionFrames?: number | null;
    timelineSpreadFrames?: number | null;
    maximumDisplayPaddingFrames?: number | null;
    cameras?: Record<string, {
      detected?: boolean;
      clipped?: boolean;
      confidence?: number | null;
      frameIndex?: number | null;
      row?: number | null;
      globalRow?: number | null;
      offsetRowsFromReference?: number | null;
      captureRound?: number | null;
      timelinePositionFrames?: number | null;
      offsetFramesFromReference?: number | null;
      offsetMsFromReference?: number | null;
      displayPaddingFrames?: number | null;
      displayPaddingRows?: number | null;
      alignedTimelinePositionFrames?: number | null;
      displayAligned?: boolean;
      expandedSearch?: boolean;
    }>;
  };
  summary: {
    sectionCount: number;
    acceptedSectionCount: number;
    diameterMeanMm: number | null;
    diameterMinimumMm: number | null;
    diameterMaximumMm: number | null;
    diameterStdDevMm: number | null;
    jetResidualRangeMm: number;
  };
  mesh: {
    rows: number;
    columns: number;
    displayMode?: "metric" | "quality-gated-preview" | "diagnostic-unqualified" | string;
    metricValid?: boolean;
    pointUnit?: "mm" | string;
    crossSectionLayout?: "fused-angular-bins" | string;
    longitudinal?: {
      source?: string;
      origin?: string;
      originElapsedFromHeadMs?: number;
      endElapsedFromHeadMs?: number;
      qualifiedDurationMs?: number;
      headTransitionTrimMs?: number;
      tailTransitionTrimMs?: number;
      commonSteelOverlapMs?: number;
      displaySpan?: number;
      displayUnit?: string;
      absoluteScaleVerified?: boolean;
    };
    positions: Array<number | null>;
    colors: number[];
    indices: number[];
    validMask: number[];
  };
  crossSections?: {
    schema: "steel.ranger3-cross-sections.v1" | string;
    coordinateSpace: string;
    pointSource: string;
    pointUnit: "mm" | string;
    angleConvention: string;
    angularBins: number;
    displayMode?: "metric" | "quality-gated-preview" | "diagnostic-unqualified" | string;
    metricValid: boolean;
    longitudinal?: CaptureFlowSurface["mesh"]["longitudinal"];
    sections: Array<{
      row: number;
      meshRow: number;
      anchorOrdinal?: number | null;
      elapsedFromHeadMs?: number | null;
      positionRatio?: number | null;
      longitudinalDisplayPosition?: number | null;
      available: boolean;
      metricValid: boolean;
      displayMode?: "metric" | "diagnostic-unqualified" | string;
      qualityGate?: { passed?: boolean; reasons?: string[] };
      validPointCount: number;
      angularPointCount: number;
      circleFit?: {
        available?: boolean;
        centerX?: number;
        centerZ?: number;
        radiusMm?: number;
        diameterMm?: number;
        meanAbsResidualMm?: number;
        p95AbsResidualMm?: number;
        maxAbsResidualMm?: number;
        roundnessMm?: number;
        pointCount?: number;
        robustPointCount?: number;
      };
    }>;
  };
  jet: {
    palette: "JET" | string;
    minimumMm: number;
    maximumMm: number;
    zeroMm: number;
    imagePath: string;
  };
  cameraTiles?: CaptureSurfaceCameraTiles;
  diameterCurves?: CaptureDirectionalDiameterCurves;
  sections: Array<{
    anchorOrdinal?: number;
    elapsedFromHeadMs?: number;
    mappingComplete: boolean;
    circleFit: {
      available?: boolean;
      diameterMm?: number;
      p95AbsResidualMm?: number;
    };
  }>;
};

export type CaptureSurfaceResponse = {
  code: number;
  path: string;
  surface: CaptureFlowSurface;
};

export type CaptureDetectedDefect = {
  id: string;
  cameraId: string;
  storageIndex: number;
  cameraFrameSequence?: number | null;
  capturedAt?: string | number | null;
  imageRect2d: { left: number; top: number; right: number; bottom: number };
  classId: string;
  className: string;
  classificationStage: string;
  fineGrainedClass?: string | null;
  externalClassId?: number | null;
  recognitionConfidence?: number | null;
  confidence: number;
  severity: "review" | string;
  modalities: Array<"2d" | "3d" | string>;
  reviewImage?: string;
  reviewImageWidth?: number;
  reviewImageHeight?: number;
};

export type CaptureFlowDefectDetection = {
  schema: "steel.sick-flow-defect-detection.v1" | string;
  generatedAt: string;
  materialId: string;
  state: "complete" | "degraded" | "failed" | "disabled" | string;
  temporaryModel: boolean;
  error?: string;
  quality: {
    reviewRequired: boolean;
    fineGrainedClassification: boolean;
    binaryDetectionOnly?: boolean;
    gpuAcceleration?: boolean;
    sampled?: boolean;
    reason?: string;
  };
  statistics?: {
    processedFrames?: number;
    skippedFrames?: number;
    inferenceCount?: number;
    recognitionInferenceCount?: number;
    rawCandidateCount?: number;
    overlapDuplicateFilteredCount?: number;
    boundaryArtifactFilteredCount?: number;
    pseudoDefectFilteredCount?: number;
    defectCount?: number;
    elapsedMs?: number;
    computeElapsedMs?: number;
    averageFrameMs?: number;
    throughputFramesPerSecond?: number;
    computeThroughputFramesPerSecond?: number;
    timingsMs?: {
      captureWaitMs?: number;
      sourceDecodeMs?: number;
      preprocessMs?: number;
      detectorInferenceMs?: number;
      classificationMs?: number;
      postprocessMs?: number;
    };
  };
  defects: CaptureDetectedDefect[];
};

export type CaptureDefectDetectionResponse = {
  code: number;
  path?: string;
  detection?: CaptureFlowDefectDetection;
  state?: string;
  materialId?: string;
  defectCount?: number;
  gpuAcceleration?: boolean;
  historyBackfill?: {
    state?: string;
    phase?: string;
    currentMaterialId?: string;
    pauseReason?: string | null;
    capturePhase?: string;
    captureQueue?: { pendingRounds?: number; activeRounds?: number };
    reprocessedMaterials?: number;
    materialCount?: number;
  } | null;
};

export type CaptureProfileEntry = {
  name: string;
  path?: string;
  folder?: string;
  format?: string;
  active?: boolean;
  driverMode?: string;
  expectedCameras?: number;
  autoConnect?: boolean;
  loadCameraParams?: boolean;
  saveToDevice?: boolean;
  changeStorage?: boolean;
};

export type CaptureProfilesStatus = CaptureCommandResult & {
  activeProfile: string;
  profiles: string[];
  profileEntries?: CaptureProfileEntry[];
  configRoot?: string;
  profileRoot?: string;
  cameraParamRoot?: string;
  storageRoot?: string;
};

export type CaptureCameraStorageRoot = {
  ip: string;
  root: string;
};

export type CaptureCameraStorageRootStatus = CaptureCameraStorageRoot & {
  exists?: boolean;
  writable?: boolean;
};

export type CaptureProfileCamera = Record<string, unknown> & {
  ip: string;
  name?: string;
  enabled?: boolean;
  model?: string;
  sn?: string;
  paramSource?: "device" | "file" | string;
  useDeviceParams?: boolean;
  paramFile?: string;
  cameraIndex?: number;
  storageRoot?: string;
  params?: Record<string, unknown> & {
    exposureTime?: number;
    gainK?: number;
    timeTriggerFreq?: number;
  };
};

export type CaptureProfileDocument = Record<string, unknown> & {
  schema?: string;
  name: string;
  updatedAt?: string;
  driverMode?: string;
  storageRoot?: string;
  cameraParamDir?: string;
  startupMode?: string;
  autoConnect?: boolean;
  expectedCameras?: number;
  changeStorage?: boolean;
  applySoftTrigger?: boolean;
  loadCameraParams?: boolean;
  saveToDevice?: boolean;
  cameraStorageRoots?: CaptureCameraStorageRoot[];
  cameras?: CaptureProfileCamera[];
};

export type CaptureParamType = "int" | "float" | "string";

export const SDK_PARAMETER_WRITE_CONFIRMATION = "WRITE SDK PARAMETER";
export const CAMERA_CALIBRATION_CONFIRMATION = "APPLY CAMERA CALIBRATION";
export const CAMERA_CALIBRATION_SET_CONFIRMATION = "APPLY CAMERA CALIBRATION SET";
export const CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION = "ROLLBACK CAMERA CALIBRATION";
export const CAMERA_ROI_CONFIRMATION = "APPLY CAMERA ROI";
export const CAMERA_DEVICE_PERSIST_CONFIRMATION = "PERSIST CAMERA PARAMETERS";

export function defaultCaptureProfileName(cameraCount: number) {
  const normalizedCount = Number.isFinite(cameraCount)
    ? Math.max(1, Math.trunc(cameraCount))
    : 1;
  return `current-${normalizedCount}-time-trigger`;
}

export type CaptureCalibrationStatus = CaptureCommandResult & {
  ip?: string;
  operationId?: string;
  rollbackToken?: string;
  rollbackMode?: string;
  rollbackCode?: number;
  rollbackTime?: string;
  calibrationTime?: string;
  roiTime?: string;
  validationCode?: number;
  validationPath?: string;
  validationTime?: string;
  maintenanceRecordPath?: string;
};

export type CaptureProfileMutationResult = CaptureCommandResult & {
  name?: string;
  path?: string;
  folder?: string;
  active?: boolean;
};

export type CaptureBatchOperationItem = {
  code: number;
  operationId?: string;
  ip?: string;
  file?: string;
  path?: string;
  calibrationPath?: string;
  artifactKind?: string;
  preflightCode?: number;
  applyCode?: number;
  persistCode?: number;
  rollbackCode?: number;
  rollbackMode?: string;
  loadCode?: number;
  saveCode?: number;
  saveDeviceCode?: number;
  attempted?: boolean;
  applied?: boolean;
  rolledBack?: boolean;
  skipped?: boolean;
  message?: string;
  connected?: boolean;
  disconnected?: boolean;
  alreadyConnected?: boolean;
  errorName?: string;
  operatorHint?: string;
  recoveryCode?: number;
};

export type CaptureBatchOperationResult = CaptureCommandResult & {
  name?: string;
  active?: boolean;
  expectedCameras?: number;
  expectedMet?: boolean;
  discovered?: number;
  connected?: number;
  requested?: number;
  disconnected?: number;
  saved?: number;
  loaded?: number;
  failed?: number;
  connectFailed?: number;
  paramApplied?: number;
  paramFailed?: number;
  applied?: number;
  skipped?: number;
  rolledBack?: number;
  rollbackToken?: string;
  rollbackPerformed?: boolean;
  rollbackComplete?: boolean;
  operationId?: string;
  applyOperationId?: string;
  status?: string;
  needsReconciliation?: boolean;
  complete?: boolean;
  dryRun?: boolean;
  cameraParamDir?: string;
  storageRoot?: string;
  results?: CaptureBatchOperationItem[];
};

export type CaptureCalibrationMapping = {
  ip: string;
  path: string;
  artifactType?: "camera-sdk" | "per-camera-sdk" | "sdk-camera-calibration";
  expectedSn?: string;
  rollbackPath?: string;
};

export type CaptureCalibrationSetInput = {
  name: string;
  path?: string;
  cameraCalibrations: CaptureCalibrationMapping[];
  ips?: string[];
  expectedCameras?: number;
  dryRun: boolean;
  stopStreams?: boolean;
  atomic?: boolean;
  rollbackOnFailure?: boolean;
  requireAllMapped?: boolean;
  persistActive?: boolean;
  saveCameraParams?: boolean;
  saveToDevice?: boolean;
  allowExternal?: boolean;
  operationId?: string;
  confirmation?: string;
  deviceConfirmation?: string;
};

export type CaptureCalibrationOperationRecord = {
  operationId?: string;
  id?: string;
  kind?: string;
  status?: string;
  needsReconciliation?: boolean;
  parentOperationId?: string | null;
  reconciliationOutcome?: string | null;
  reconciliationId?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  rowVersion?: number;
  requestHash?: string;
  request?: unknown;
  providerHttpStatus?: number;
  providerResponse?: unknown;
  rollbackToken?: string;
  actor?: string;
  createdAt?: string;
  dispatchStartedAt?: string;
  finishedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  replayed?: boolean;
  error?: string | null;
  response?: CaptureBatchOperationResult | null;
};

export type CaptureCalibrationOperationDetail = CaptureCommandResult &
  CaptureCalibrationOperationRecord & {
    operation?: CaptureCalibrationOperationRecord | null;
  };

export type CaptureReconciliationFenceOperation = {
  operationId: string;
  kind?: string;
  status?: string;
  error?: string | null;
  expectedApplyOperationId?: string;
  updatedAt?: string;
};

export type CaptureReconciliationFencePayload = {
  code: 423;
  error: "calibration_reconciliation_required" | string;
  requestTarget?: string;
  operationId?: string;
  unresolvedOperations?: CaptureReconciliationFenceOperation[];
};

export class CaptureApiError extends Error {
  readonly status: number;
  readonly payload?: unknown;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "CaptureApiError";
    this.status = status;
    this.payload = payload;
  }
}

export class CaptureAdminApiError extends CaptureApiError {
  constructor(message: string, status: number, payload?: unknown) {
    super(message, status, payload);
    this.name = "CaptureAdminApiError";
  }
}

export type LocalPathResult = {
  selected: boolean;
  path?: string | null;
};

export type LocalFileWriteResult = {
  saved: boolean;
  path?: string | null;
  bytes: number;
};

export type LocalTextFileResult = {
  path: string;
  text: string;
  bytes: number;
};

export type CaptureStorageQueueStatus = {
  workerCount: number;
  capacityItems: number;
  capacityBytes: number;
  pendingItems: number;
  pendingBytes: number;
  queued: number;
  queuedBytes: number;
  active: number;
  activeBytes: number;
  highWaterItems: number;
  highWaterBytes: number;
  completed: number;
  failed: number;
  rejected: number;
  enqueueTimeoutMs: number;
  accepting: boolean;
};

export type CaptureStorageStatus = CaptureCommandResult & {
  root: string;
  exists: boolean;
  writable: boolean;
  cameraRoots?: CaptureCameraStorageRootStatus[];
  queue?: CaptureStorageQueueStatus;
};

export type CaptureContinuousTestInput = {
  expectedCameras: number;
  rounds: number;
  lines: number;
  width?: number;
  timeoutMs: number;
  workerTimeoutMs?: number;
  intervalMs: number;
  retries: number;
  controlMode?: number;
  dataMode: number;
  outputDir: string;
  connectFirst: boolean;
  stopStreams: boolean;
  ips: string[];
  discardBlackFrames?: boolean;
  blackFrameThreshold?: number;
};

export type CaptureContinuousTestResult = {
  round: number;
  attempt: number;
  parallelIndex?: number;
  code: number;
  attemptsUsed?: number;
  requestedWidth?: number;
  requestedLines?: number;
  width?: number;
  lines?: number;
  dataMode?: number;
  depthDataFormat?: number;
  depthPersistenceMode?: string;
  timeoutMs?: number;
  retries?: number;
  fid?: number;
  sid?: number;
  lostLines?: number;
  triggerMinInterval?: number;
  triggerMaxInterval?: number;
  timestamp?: number;
  depthExists?: boolean;
  intensityExists?: boolean;
  metadataExists?: boolean;
  completeFrame?: boolean;
  storageAsync?: boolean;
  storageTicketId?: number;
  captureFinishedTickMs?: number;
  storageQueuedTickMs?: number;
  storageStartedTickMs?: number;
  storageFinishedTickMs?: number;
  simulated?: boolean;
  discarded?: boolean;
  ip: string;
  output?: string;
  depthOutput?: string;
  intensityOutput?: string;
  metadataOutput?: string;
  sdkOutput?: string;
  sdkDepthOutput?: string;
  sdkIntensityOutput?: string;
  errorName?: string;
  operatorHint?: string;
  error?: string;
  discardReason?: string;
  roundStartedAt?: string;
  workerStartedAt?: string;
  captureFinishedAt?: string;
  storageQueuedAt?: string;
  storageStartedAt?: string;
  storageFinishedAt?: string;
  workerFinishedAt?: string;
};

export type CaptureContinuousTestSummary = CaptureCommandResult & {
  schema: "steel.capture.continuous-test.summary.v1" | string;
  generatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  errorName?: string;
  operatorHint?: string;
  attempts: number;
  successes: number;
  failures: number;
  completeFrames: number;
  metadataFrames: number;
  discardedFrames?: number;
  blackFrames?: number;
  rounds: number;
  retries: number;
  cameraCount: number;
  expectedCameras: number;
  expectedMet: boolean;
  connectFirst?: boolean;
  parallel?: boolean;
  saveSdkDerived?: boolean;
  workerCount?: number;
  roundIntervalMs?: number;
  workerTimeoutMs?: number;
  storageAsyncFrames?: number;
  storagePendingTicketLimit?: number;
  captureStorageOverlappedRounds?: number;
  frameTransaction?: boolean;
  metadataCommitLast?: boolean;
  elapsedMs?: number;
  syncMode?: string;
  storageRoot?: string;
  outputDir?: string;
  summaryOutput?: string;
  summaryExists?: boolean;
  results: CaptureContinuousTestResult[];
};

export type ActiveCaptureCalibration = {
  code: number;
  profile: string;
  profilePath?: string;
  calibrationFile: string;
  calibrationPath: string;
  exists: boolean;
  versionRoot?: string;
  activeCalibration?: {
    version?: string;
    appliedAt?: string;
    appliedBy?: string;
    sourceCalibration?: string;
    correctedCalibration?: string;
    fitReport?: string;
    beforePreview?: string;
    afterPreview?: string;
    saveToDevice?: boolean;
  };
};

export type ActivateCaptureCalibrationInput = {
  name: string;
  path: string;
  version?: string;
  fitReport?: string;
  beforePreview?: string;
  afterPreview?: string;
  sourceCalibration?: string;
  fitBefore?: unknown;
  fitAfter?: unknown;
  cameraParamDir?: string;
  allowExternal?: boolean;
  saveToDevice: false;
  appliedBy: string;
};

const DEFAULT_CAPTURE_SERVICE_ORIGIN = "http://127.0.0.1:4873";
const DEFAULT_CAPTURE_STREAM_ORIGIN = "http://127.0.0.1:4317";

function getCaptureServiceOrigin() {
  // Mutations and JSON telemetry stay on the Rust control plane.
  return getInspectionServiceOrigin() || DEFAULT_CAPTURE_SERVICE_ORIGIN;
}

function getCaptureStreamOrigin() {
  // Live images are a high-rate, loopback-only data plane. Sending six image
  // reads through the thread-per-request Rust proxy caused cancelled browser
  // refreshes to accumulate proxy workers and saturate every CPU core. Keep
  // start/stop authorization on 4873 while reading immutable preview bytes
  // directly from the local capture provider.
  const controlOrigin = getCaptureServiceOrigin();
  if (isWebHostedRuntime()) {
    // Browser pages must keep preview traffic on the page origin as well;
    // otherwise an HTTPS UI would be blocked when it tried to read the local
    // HTTP capture sidecar directly.
    return controlOrigin;
  }
  try {
    const host = new URL(controlOrigin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
    return loopback ? DEFAULT_CAPTURE_STREAM_ORIGIN : controlOrigin;
  } catch {
    return DEFAULT_CAPTURE_STREAM_ORIGIN;
  }
}

function hasTauriRuntime() {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

async function invokeCapture<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!hasTauriRuntime()) {
    return null;
  }
  return invoke<T>(command, args);
}

export async function chooseCaptureLocalFile(
  title: string,
  extensions: string[] = [],
): Promise<LocalPathResult | null> {
  return invokeCapture<LocalPathResult>("choose_local_file", {
    title,
    extensions,
  });
}

export async function chooseCaptureLocalDirectory(
  title: string,
): Promise<LocalPathResult | null> {
  return invokeCapture<LocalPathResult>("choose_local_directory", { title });
}

export async function openCaptureLocalPath(
  path: string,
): Promise<LocalPathResult | null> {
  const normalized = path.trim();
  if (!normalized) {
    throw new Error("本地路径不能为空");
  }
  return invokeCapture<LocalPathResult>("open_local_path", { path: normalized });
}

export async function readCaptureLocalTextFile(
  path: string,
): Promise<LocalTextFileResult | null> {
  const normalized = path.trim();
  if (!normalized) {
    throw new Error("本地文本路径不能为空");
  }
  return invokeCapture<LocalTextFileResult>("read_local_text_file", {
    path: normalized,
  });
}

export async function saveCapturePreviewBytes(
  suggestedName: string,
  bytes: Uint8Array | number[],
): Promise<LocalFileWriteResult | null> {
  return invokeCapture<LocalFileWriteResult>("save_binary_file_with_dialog", {
    suggestedName,
    bytes: Array.from(bytes),
  });
}

export async function saveCapturePreviewFromUrl(
  imageUrl: string,
  suggestedName = "capture-preview.png",
): Promise<LocalFileWriteResult | null> {
  if (!hasTauriRuntime()) {
    return null;
  }
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`预览图读取失败（HTTP ${response.status}）`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return saveCapturePreviewBytes(suggestedName, bytes);
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(`${getCaptureServiceOrigin()}${path}`);
  if (!response.ok) {
    const payload = await response.clone().json().catch(() => undefined);
    throw new CaptureApiError(
      await readAdminErrorMessage(response, "采集服务请求失败"),
      response.status,
      payload,
    );
  }
  return response.json() as Promise<T>;
}

async function writeJson<T>(
  path: string,
  body: unknown = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${getCaptureServiceOrigin()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const payload = await response.clone().json().catch(() => undefined);
    throw new CaptureApiError(
      await readAdminErrorMessage(response, "采集服务操作失败"),
      response.status,
      payload,
    );
  }
  return response.json() as Promise<T>;
}

async function readAdminJson<T>(path: string): Promise<T> {
  const response = await fetch(`${getCaptureServiceOrigin()}${path}`, {
    headers: createAdminHeaders({ Accept: "application/json" }),
  });
  if (!response.ok) {
    const payload = await response.clone().json().catch(() => undefined);
    throw new CaptureAdminApiError(
      await readAdminErrorMessage(response, `capture api ${response.status}`),
      response.status,
      payload,
    );
  }
  return response.json() as Promise<T>;
}

async function writeAdminJson<T>(
  path: string,
  body: unknown = {},
): Promise<T> {
  const response = await fetch(`${getCaptureServiceOrigin()}${path}`, {
    method: "POST",
    headers: createAdminHeaders({
      Accept: "application/json",
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.clone().json().catch(() => undefined);
    throw new CaptureAdminApiError(
      await readAdminErrorMessage(response, `capture api ${response.status}`),
      response.status,
      payload,
    );
  }
  return response.json() as Promise<T>;
}

function timestamp() {
  return String(Date.now());
}

export function createDefaultCaptureCameras(): CaptureCameraConfig[] {
  const cameras = [
    { ip: "192.168.101.100", model: "LVM3450BE", role: "camera1 周向采集相机" },
    { ip: "192.168.102.100", model: "LVM3450CA", role: "camera2 周向采集相机" },
    { ip: "192.168.103.100", model: "LVM3450RE", role: "camera3 周向采集相机" },
    { ip: "192.168.104.100", model: "LVM3450GE(520)", role: "camera4 周向采集相机" },
    { ip: "192.168.105.100", model: "LVM3450BE", role: "camera5 周向采集相机" },
    { ip: "192.168.106.100", model: "LVM3450CA", role: "camera6 周向采集相机" },
    { ip: "192.168.107.100", model: "LVM3450RE", role: "camera7 周向采集相机" },
    { ip: "192.168.108.100", model: "LVM3450GE(520)", role: "camera8 周向采集相机" },
  ];
  return cameras.map((camera, index) => {
    const cameraNo = index + 1;
    const cameraId = `CAM-${String(cameraNo).padStart(2, "0")}`;
    return {
      id: cameraId,
      name: `${cameraNo} \u53f7\u91c7\u96c6\u76f8\u673a`,
      ip: camera.ip,
      role: camera.role,
      driverId: "lvm-nvt",
      modelHint: camera.model,
      enabled: true,
      triggerMode: "\u8f6f\u4ef6\u89e6\u53d1",
      exposureUs: 850,
      gain: 1,
      depthLines: 1280,
      outputPath: `captures/${cameraId}`,
    };
  });
}

export function createDefaultCaptureDriver(): CaptureDriverInfo {
  return {
    id: "lvm-nvt",
    name: "LVM/NVT 3D Camera SDK",
    vendor: "Capture 6.7 SDK",
    transport: "GigE/Network",
    sdkVersion: "",
    supportedModels: ["LVM3450CA", "LVM compatible 3D camera"],
    features: [
      "discover",
      "multi-connect",
      "parameters",
      "depth-map",
      "status-readback",
    ],
  };
}

export function createDefaultCaptureConfig(): CaptureAppliedConfig {
  return {
    id: "eight-camera-capture",
    name: "Eight-Camera-Capture",
    applied: true,
    updatedAt: timestamp(),
    cameras: createDefaultCaptureCameras(),
  };
}

export function createDefaultCaptureCapabilities(
  driver = createDefaultCaptureDriver(),
): CaptureCapabilitySet {
  return {
    driver,
    controls: [
      {
        id: "connect",
        label: "连接相机",
        scope: "camera",
        requiresConnection: false,
      },
      {
        id: "disconnect",
        label: "断开相机",
        scope: "camera",
        requiresConnection: true,
      },
      {
        id: "capture_depth_map",
        label: "采集深度图",
        scope: "camera",
        requiresConnection: true,
      },
      {
        id: "apply_config",
        label: "应用配置",
        scope: "system",
        requiresConnection: false,
      },
    ],
    parameters: [
      {
        key: "ExposureTime",
        label: "曝光",
        valueType: "int",
        unit: "us",
        min: 1,
        max: 20000,
        writable: true,
      },
      {
        key: "GainK",
        label: "增益",
        valueType: "float",
        unit: "x",
        min: 0,
        max: 16,
        writable: true,
      },
      {
        key: "DepthLines",
        label: "深度行数",
        valueType: "int",
        unit: "line",
        min: 64,
        max: 8192,
        writable: false,
      },
    ],
    api: [
      {
        method: "GET",
        path: "/api/config",
        label: "配置中心",
        scope: "system",
      },
      {
        method: "GET",
        path: "/api/camera/statuses",
        label: "相机状态",
        scope: "camera",
      },
      {
        method: "POST",
        path: "/api/camera/connect",
        label: "连接相机",
        scope: "camera",
      },
      {
        method: "POST",
        path: "/api/param",
        label: "下发参数",
        scope: "camera",
      },
      {
        method: "POST",
        path: "/api/capture/depth-map",
        label: "采集深度图",
        scope: "camera",
      },
      {
        method: "POST",
        path: "/api/steel/capture-mode",
        label: "切换相机出图模式",
        scope: "system",
      },
      {
        method: "GET",
        path: "/api/capture/continuous-settings",
        label: "读取连续采集设置",
        scope: "system",
      },
      {
        method: "POST",
        path: "/api/capture/continuous-settings",
        label: "运行时应用连续采集设置",
        scope: "system",
      },
    ],
  };
}

function createStatusFromConfig(
  config: CaptureCameraConfig,
  discovered?: CaptureCamera,
): CaptureCameraStatus {
  return {
    connected: false,
    deviceId: -1,
    ip: config.ip,
    driverId: config.driverId,
    model: discovered?.model || config.modelHint,
    sn: discovered?.sn || "",
    configId: config.id,
    name: config.name,
    role: config.role,
    enabled: config.enabled,
    acquisitionState: config.enabled
      ? discovered
        ? "discovered"
        : "offline"
      : "disabled",
    sdkStatus: "pending",
    continuousFps: null,
    continuousFrameCount: 0,
    lastContinuousFrameAt: null,
    continuousAcquiring: false,
    fps: null,
    bufferPercent: 0,
    lastFrameTime: null,
    error: config.enabled ? "not connected" : null,
  };
}

function createProviderCameraConfig(
  camera: CaptureCamera,
  index: number,
  providerStatus?: CaptureCameraStatus,
): CaptureCameraConfig {
  const sequence = camera.cameraIndex ?? providerStatus?.deviceId ?? index + 1;
  const id = camera.cameraId?.trim()
    || providerStatus?.configId?.trim()
    || `camera-${sequence}`;
  return {
    id,
    name: camera.name?.trim()
      || providerStatus?.name?.trim()
      || camera.cameraId?.trim()
      || `C${sequence}`,
    ip: camera.ip,
    driverId: camera.driverId
      || providerStatus?.driverId
      || "external-api",
    modelHint: camera.model || providerStatus?.model || "",
    role: camera.role
      || providerStatus?.role
      || `camera-${sequence}`,
    enabled: providerStatus?.enabled !== false,
    triggerMode: providerStatus?.continuousAcquiring ? "continuous" : "external",
    exposureUs: providerStatus?.captureConfig?.exposureTime ?? 0,
    gain: providerStatus?.captureConfig?.gainK ?? 0,
    depthLines: providerStatus?.captureConfig?.triggerLines ?? 0,
    outputPath: camera.storageRoot || providerStatus?.storageRoot || "",
  };
}

function hydrateSnapshot(
  partial: Partial<CaptureSnapshot> & { error?: string | null },
): CaptureSnapshot {
  const driver = partial.driver ?? createDefaultCaptureDriver();
  const config = partial.config ?? createDefaultCaptureConfig();
  const capabilities =
    partial.capabilities ?? createDefaultCaptureCapabilities(driver);
  const cameras = partial.cameras ?? [];
  const discoveredByIp = new Map(cameras.map((camera) => [camera.ip, camera]));
  const statuses =
    partial.statuses && partial.statuses.length > 0
      ? partial.statuses
      : config.cameras.map((camera) =>
          createStatusFromConfig(camera, discoveredByIp.get(camera.ip)),
        );

  return {
    health: partial.health ?? null,
    driver,
    config,
    cameras,
    status:
      partial.status ??
      statuses.find((status) => status.connected) ??
      statuses[0] ??
      null,
    statuses,
    capabilities,
    logs: partial.logs ?? [],
    error: partial.error ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCaptureHealth(value: unknown): CaptureHealth {
  if (!isRecord(value)) {
    throw new Error("invalid capture health response");
  }

  if (value.provider === "bkv") {
    const core = parseBkvCaptureStatus(value);
    if (
      typeof value.service !== "string" ||
      typeof value.time !== "string" ||
      value.connected !== false ||
      (value.replay !== undefined && core.replay === undefined)
    ) {
      throw new Error("invalid BKV capture health response");
    }
    return {
      service: value.service,
      time: value.time,
      provider: "bkv",
      status: "bkv-offline",
      sdkRequired: false,
      sdkReady: null,
      connected: false,
      cameraCount: 6,
      channels: core.channels,
      ...(core.batchId ? { batchId: core.batchId } : {}),
      ...(core.contentId ? { contentId: core.contentId } : {}),
      ...(core.replay ? { replay: core.replay } : {}),
    };
  }

  if (
    typeof value.service !== "string" ||
    typeof value.time !== "string" ||
    (value.provider !== undefined &&
      value.provider !== "headless-cpp" &&
      value.provider !== "external-api" &&
      value.provider !== "simulated") ||
    typeof value.sdkReady !== "boolean" ||
    typeof value.sdkCode !== "number" ||
    typeof value.connected !== "boolean" ||
    typeof value.ip !== "string"
  ) {
    throw new Error("invalid physical capture health response");
  }
  return {
    service: value.service,
    time: value.time,
    ...(value.provider !== undefined ? { provider: value.provider } : {}),
    sdkReady: value.sdkReady,
    sdkCode: value.sdkCode,
    ...(typeof value.sdkVersion === "string"
      ? { sdkVersion: value.sdkVersion }
      : {}),
    connected: value.connected,
    ip: value.ip,
    ...(typeof value.driverId === "string" ? { driverId: value.driverId } : {}),
    ...(typeof value.driverName === "string"
      ? { driverName: value.driverName }
      : {}),
    ...(typeof value.cameraCount === "number"
      ? { cameraCount: value.cameraCount }
      : {}),
    ...(typeof value.expectedCameras === "number"
      ? { expectedCameras: value.expectedCameras }
      : {}),
    ...(isRecord(value.acquisitionSynchronization)
      ? { acquisitionSynchronization: value.acquisitionSynchronization as CaptureSynchronizationStatus }
      : {}),
    ...(isRecord(value.storageQueue)
      ? { storageQueue: value.storageQueue as CaptureHealthStorageQueueStatus }
      : {}),
  };
}

function createPhysicalCaptureDriver(
  health: PhysicalCaptureHealth,
  cameras: CaptureCamera[],
): CaptureDriverInfo {
  const fallback = createDefaultCaptureDriver();
  const externalSick = health.provider === "external-api"
    || health.driverId?.toLowerCase().includes("sick") === true;
  if (!externalSick) {
    return {
      ...fallback,
      id: health.driverId?.trim() || fallback.id,
      name: health.driverName?.trim() || fallback.name,
      sdkVersion: health.sdkVersion ?? "",
    };
  }
  const supportedModels = [...new Set(
    cameras
      .map((camera) => camera.model.trim())
      .filter(Boolean),
  )];
  return {
    id: health.driverId?.trim() || "sick-gentl",
    name: health.driverName?.trim() || "SICK GenTL Producer",
    vendor: "SICK",
    transport: "GigE Vision / GenTL",
    sdkVersion: health.sdkVersion ?? "",
    supportedModels: supportedModels.length > 0
      ? supportedModels
      : ["Ranger3"],
    features: [
      "discover",
      "multi-connect",
      "continuous",
      "intensity",
      "depth-map",
      "status-readback",
    ],
  };
}

function createBkvOfflineSnapshot(
  health: BkvCaptureHealth,
  logs: CaptureLogEvent[],
): CaptureSnapshot {
  const driver: CaptureDriverInfo = {
    id: "bkv-offline",
    name: "BKV legacy offline replay",
    vendor: "BKV",
    transport: "offline",
    sdkVersion: "not-required",
    supportedModels: ["BKV legacy offline channel"],
    features: ["offline-replay"],
  };
  const cameras: CaptureCamera[] = health.channels.map((channel) => ({
    ip: `bkv://camera-${channel.index}`,
    model: "BKV legacy offline channel",
    sn: `BKV-${channel.index}`,
    driverId: driver.id,
    source: "bkv",
    configured: true,
  }));
  const cameraConfigs: CaptureCameraConfig[] = health.channels.map((channel) => ({
    id: `bkv-camera-${channel.index}`,
    name: `BKV camera ${channel.index}`,
    ip: `bkv://camera-${channel.index}`,
    driverId: driver.id,
    modelHint: "BKV legacy offline channel",
    role: `offline-${channel.index}`,
    enabled: false,
    triggerMode: "offline",
    exposureUs: 0,
    gain: 0,
    depthLines: 0,
    outputPath: "",
  }));
  const statuses: CaptureCameraStatus[] = cameraConfigs.map((camera) => ({
    ...createStatusFromConfig(camera),
    acquisitionState: "offline",
    sdkStatus: "not-required",
    error: null,
  }));

  return hydrateSnapshot({
    health,
    driver,
    config: {
      id: "bkv-offline",
      name: "BKV legacy offline replay",
      applied: true,
      updatedAt: health.time,
      cameras: cameraConfigs,
    },
    cameras,
    status: statuses[0] ?? null,
    statuses,
    capabilities: {
      driver,
      controls: [],
      parameters: [],
      api: [],
    },
    logs,
  });
}

export async function readCaptureSnapshot(): Promise<CaptureSnapshot> {
  const [configResult, health, camerasResult, status, statusesResult, logsResult] =
    await Promise.all([
      readAdminJson<ServiceConfigResponse>("/api/config").catch(
        (): ServiceConfigResponse => ({}),
      ),
      readJson<unknown>("/api/capture/health").then(parseCaptureHealth),
      readJson<{ cameras: CaptureCamera[] }>("/api/cameras"),
      readJson<CaptureCameraStatus>("/api/camera/status").catch(
        (): CaptureCameraStatus => ({ connected: false, deviceId: -1, ip: "" }),
      ),
      readJson<{ statuses: CaptureCameraStatus[] }>(
        "/api/camera/statuses",
      ).catch(() => ({ statuses: [] })),
      readJson<{ events: CaptureLogEvent[] }>("/api/capture/logs").catch(
        () => ({ events: [] }),
      ),
    ]);

  const logs = logsResult.events.map((event) => ({
    ...event,
    source: event.source ?? "provider-log" as const,
    cameraIp: event.cameraIp ?? null,
  }));
  if (health.provider === "bkv") {
    return createBkvOfflineSnapshot(health, logs);
  }

  const cameras = camerasResult.cameras.map((camera) => ({
    ...camera,
    driverId: camera.driverId ?? health.driverId ?? "lvm-nvt",
    source: camera.source ?? (health.provider === "external-api" ? "external-api" : "http-service"),
  }));
  const discoveredByIp = new Map(cameras.map((camera) => [camera.ip, camera]));
  const statusByIp = new Map(
    statusesResult.statuses.map((cameraStatus) => [
      cameraStatus.ip,
      cameraStatus,
    ]),
  );
  // The external SICK provider deliberately returns its full telemetry on
  // both /api/cameras and /api/camera/statuses.  Use the discovery rows as a
  // lossless fallback when an intermediate proxy temporarily omits the
  // status collection, instead of showing correctly discovered cameras as
  // offline.
  if (health.provider === "external-api") {
    cameras.forEach((camera) => {
      const providerStatus = camera as unknown as CaptureCameraStatus;
      if (!statusByIp.has(camera.ip) && typeof providerStatus.connected === "boolean") {
        statusByIp.set(camera.ip, providerStatus);
      }
    });
  }
  const providerTopology = cameras.length > 0
    ? cameras
    : statusesResult.statuses.map((providerStatus) => ({
        ip: providerStatus.ip,
        model: providerStatus.model ?? "",
        sn: providerStatus.sn ?? "",
        cameraIndex: providerStatus.deviceId,
        cameraId: providerStatus.configId ?? providerStatus.name ?? undefined,
        name: providerStatus.name ?? undefined,
        role: providerStatus.role ?? undefined,
        storageRoot: providerStatus.storageRoot,
        driverId: providerStatus.driverId,
        source: "external-api",
      }));
  const configuredCameras = configResult.capture?.cameras ?? [];
  const configuredTopologyOverlap = configuredCameras.filter((camera) => (
    providerTopology.some((providerCamera) => providerCamera.ip === camera.ip)
  )).length;
  const useProviderTopology = providerTopology.length > 0
    && (
      health.provider === "external-api"
      || configuredCameras.length === 0
      || configuredTopologyOverlap === 0
    );
  const config = {
    ...createDefaultCaptureConfig(),
    ...(configResult.capture ?? {}),
    cameras: useProviderTopology
      ? providerTopology.map((camera, index) => (
          createProviderCameraConfig(camera, index, statusByIp.get(camera.ip))
        ))
      : configuredCameras.length > 0
        ? configuredCameras
        : createDefaultCaptureConfig().cameras,
  };
  const statuses = config.cameras.map((camera) => {
    const backendStatus =
      statusByIp.get(camera.ip) ??
      (status.connected && status.ip === camera.ip ? status : null);
    if (backendStatus) {
      return {
        ...createStatusFromConfig(camera, discoveredByIp.get(camera.ip)),
        ...backendStatus,
        driverId: backendStatus.driverId ?? health.driverId ?? camera.driverId,
        name: camera.name,
        role: camera.role,
        configId: camera.id,
        acquisitionState: backendStatus.acquisitionState
          ?? (backendStatus.connected ? "connected" : "offline"),
        sdkStatus:
          backendStatus.sdkStatus ?? (health.sdkReady ? "ready" : "error"),
        error:
          backendStatus.error ??
          (backendStatus.connected
            ? null
            : camera.enabled
              ? "not connected"
              : null),
      };
    }
    return createStatusFromConfig(camera, discoveredByIp.get(camera.ip));
  });

  return hydrateSnapshot({
    health,
    driver: createPhysicalCaptureDriver(health, cameras),
    config,
    cameras,
    status,
    statuses,
    logs,
  });
}

function normalizeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeOptionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function bytesDeltaToMbps(bytes: number, elapsedSeconds: number) {
  if (
    !Number.isFinite(bytes) ||
    !Number.isFinite(elapsedSeconds) ||
    elapsedSeconds <= 0
  ) {
    return 0;
  }
  return (Math.max(0, bytes) * 8) / elapsedSeconds / 1_000_000;
}

export function calculateSystemNetworkRates(
  current: SystemNetworkSnapshot,
  previous: SystemNetworkSnapshot | null,
): SystemNetworkRateSnapshot {
  const elapsedSeconds = previous
    ? Math.max(0.001, (current.sampledAtMs - previous.sampledAtMs) / 1000)
    : 0;
  const previousByName = new Map(
    (previous?.interfaces ?? []).map((item) => [item.name, item]),
  );
  const interfaces = current.interfaces.map(
    (item): SystemNetworkRateInterface => {
      const previousItem = previousByName.get(item.name);
      const receivedDelta = previousItem
        ? normalizeNumber(item.receivedBytes) -
          normalizeNumber(previousItem.receivedBytes)
        : 0;
      const transmittedDelta = previousItem
        ? normalizeNumber(item.transmittedBytes) -
          normalizeNumber(previousItem.transmittedBytes)
        : 0;
      const bandwidthMbps =
        normalizeNumber(item.bandwidthMbps) ||
        normalizeNumber(item.linkSpeedBitsPerSecond) / 1_000_000;
      const calculatedUploadMbps = bytesDeltaToMbps(
        transmittedDelta,
        elapsedSeconds,
      );
      const calculatedDownloadMbps = bytesDeltaToMbps(
        receivedDelta,
        elapsedSeconds,
      );
      const apiUploadMbps = normalizeOptionalNumber(item.uploadMbps);
      const apiDownloadMbps = normalizeOptionalNumber(item.downloadMbps);
      return {
        ...item,
        receivedBytes: normalizeNumber(item.receivedBytes),
        transmittedBytes: normalizeNumber(item.transmittedBytes),
        packetsReceived: normalizeNumber(item.packetsReceived),
        packetsTransmitted: normalizeNumber(item.packetsTransmitted),
        uploadMbps: apiUploadMbps ?? calculatedUploadMbps,
        downloadMbps: apiDownloadMbps ?? calculatedDownloadMbps,
        bandwidthMbps,
        online:
          typeof item.online === "boolean"
            ? item.online
            : (item.status ?? "").toLowerCase() === "up" || bandwidthMbps > 0,
      };
    },
  );
  return {
    code: current.code,
    source: current.source,
    sampledAtMs: current.sampledAtMs,
    interfaces,
    totalUploadMbps: normalizeOptionalNumber(current.totalUploadMbps) ?? interfaces.reduce(
      (total, item) => total + item.uploadMbps,
      0,
    ),
    totalDownloadMbps: normalizeOptionalNumber(current.totalDownloadMbps) ?? interfaces.reduce(
      (total, item) => total + item.downloadMbps,
      0,
    ),
    totalBandwidthMbps: normalizeOptionalNumber(current.totalBandwidthMbps) ?? interfaces.reduce(
      (total, item) => total + item.bandwidthMbps,
      0,
    ),
    error: current.error,
  };
}

export async function readSystemNetworkSnapshot(): Promise<SystemNetworkSnapshot> {
  const snapshot = await readJson<SystemNetworkSnapshot>("/api/system/network");
  return {
    ...snapshot,
    sampledAtMs: normalizeNumber(snapshot.sampledAtMs) || Date.now(),
    interfaces: (snapshot.interfaces ?? []).map((item, index) => ({
      ...item,
      index: normalizeNumber(item.index) || index + 1,
      name: item.name || `network-${index + 1}`,
      receivedBytes: normalizeNumber(item.receivedBytes),
      transmittedBytes: normalizeNumber(item.transmittedBytes),
      linkSpeedBitsPerSecond: normalizeNumber(item.linkSpeedBitsPerSecond),
      packetsReceived: normalizeNumber(item.packetsReceived),
      packetsTransmitted: normalizeNumber(item.packetsTransmitted),
      uploadMbps: normalizeOptionalNumber(item.uploadMbps),
      downloadMbps: normalizeOptionalNumber(item.downloadMbps),
      bandwidthMbps: normalizeOptionalNumber(item.bandwidthMbps),
      online: typeof item.online === "boolean" ? item.online : undefined,
    })),
    totalReceivedBytes: normalizeNumber(snapshot.totalReceivedBytes),
    totalTransmittedBytes: normalizeNumber(snapshot.totalTransmittedBytes),
    totalUploadMbps: normalizeOptionalNumber(snapshot.totalUploadMbps),
    totalDownloadMbps: normalizeOptionalNumber(snapshot.totalDownloadMbps),
    totalBandwidthMbps: normalizeOptionalNumber(snapshot.totalBandwidthMbps),
  };
}

export function createEmptyCaptureSnapshot(
  error: string | null = null,
): CaptureSnapshot {
  return hydrateSnapshot({ error });
}

export async function applyCaptureConfig(config: CaptureAppliedConfig) {
  return writeAdminJson<CaptureCommandResult>("/api/config/capture", {
    service: {
      name: "steel-inspection-service",
      role: "api-config-capture-orchestrator",
      updatedAt: timestamp(),
    },
    capture: {
      mode: "eight-camera",
      driver: "lvm-nvt",
      fallback: "simulated",
      cameras: config.cameras,
    },
  });
}

export async function setCaptureOutputMode(
  mode: CaptureOutputMode,
): Promise<CaptureOutputModeStatus> {
  return writeJson<CaptureOutputModeStatus>("/api/steel/capture-mode", {
    captureMode: mode,
  });
}

export function validateCaptureContinuousSettings(
  input: CaptureContinuousSettingsInput,
): string | null {
  if (!Number.isFinite(input.timeTriggerFreq)
    || input.timeTriggerFreq < 0.1
    || input.timeTriggerFreq > 100000) {
    return "连续采集线触发频率必须在 0.1 到 100000 Hz 之间";
  }
  if (input.ips?.some((ip) => !ip.trim())) {
    return "连续采集设置中存在空相机 IP";
  }
  return null;
}

/**
 * Updates the production continuous-acquisition worker through the Rust
 * service.  `applyToDevice` is runtime-only: the provider does not persist a
 * camera parameter file or call SDK save-to-device.
 */
export async function applyCaptureContinuousSettings(
  input: CaptureContinuousSettingsInput,
): Promise<CaptureContinuousSettingsResult> {
  const request: CaptureContinuousSettingsInput = {
    ...input,
    timeTriggerFreq: Number(input.timeTriggerFreq),
    ips: input.ips?.map((ip) => ip.trim()).filter(Boolean),
    applyToDevice: input.applyToDevice ?? false,
    restartContinuous: input.restartContinuous ?? true,
  };
  const validationError = validateCaptureContinuousSettings(request);
  if (validationError) {
    throw new Error(validationError);
  }
  return writeJson<CaptureContinuousSettingsResult>(
    "/api/capture/continuous-settings",
    request,
  );
}

export async function readCaptureContinuousSettings(): Promise<CaptureContinuousSettingsReadResult> {
  return readJson<CaptureContinuousSettingsReadResult>(
    "/api/capture/continuous-settings",
  );
}

export async function readCaptureProfiles(): Promise<CaptureProfilesStatus> {
  return readAdminJson<CaptureProfilesStatus>("/api/config/profiles");
}

export async function readCaptureProfile(
  name: string,
): Promise<CaptureProfileDocument> {
  const query = new URLSearchParams({ name: name.trim() });
  return readAdminJson<CaptureProfileDocument>(
    `/api/config/profile?${query.toString()}`,
  );
}

export async function saveCaptureProfile(input: {
  name: string;
  profile: CaptureProfileDocument;
  makeActive?: boolean;
}): Promise<CaptureProfileMutationResult> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("配置名称不能为空");
  }
  const profile: CaptureProfileDocument = {
    ...input.profile,
    name,
    updatedAt: new Date().toISOString(),
    // A profile created in Tauri must never make a later apply persist to the
    // camera merely because an imported JSON happened to contain this flag.
    saveToDevice: false,
  };
  return writeAdminJson<CaptureProfileMutationResult>(
    "/api/config/profile/save",
    {
      name,
      makeActive: input.makeActive ?? false,
      profileJson: JSON.stringify(profile),
    },
  );
}

export async function importCaptureProfileFromProviderPath(input: {
  path: string;
  name?: string;
  overwrite?: boolean;
  makeActive?: boolean;
}): Promise<CaptureProfileMutationResult> {
  const path = input.path.trim();
  if (!path) {
    throw new Error("采集主机上的配置路径不能为空");
  }
  return writeAdminJson<CaptureProfileMutationResult>(
    "/api/config/profile/import",
    {
      path,
      name: input.name?.trim() || undefined,
      overwrite: input.overwrite ?? false,
      makeActive: input.makeActive ?? false,
    },
  );
}

export async function applyCaptureProfile(input: {
  name: string;
  expectedCameras?: number;
  autoConnect?: boolean;
  loadCameraParams?: boolean;
  saveToDevice?: false;
  changeStorage?: boolean;
}): Promise<CaptureBatchOperationResult> {
  return writeAdminJson<CaptureBatchOperationResult>(
    "/api/config/profile/apply",
    { ...input, saveToDevice: false },
  );
}

export async function connectAllCaptureCameras(input: {
  ips?: string[];
  expectedCameras?: number;
  devType?: number;
} = {}): Promise<CaptureBatchOperationResult> {
  return writeAdminJson<CaptureBatchOperationResult>(
    "/api/cameras/connect-all",
    input,
  );
}

export async function saveAllCaptureCameraParams(input: {
  name: string;
  ips?: string[];
  cameraParamDir?: string;
  applySoftTrigger?: boolean;
  saveToDevice?: false;
}): Promise<CaptureBatchOperationResult> {
  return writeAdminJson<CaptureBatchOperationResult>(
    "/api/config/camera-params/save-all",
    { ...input, saveToDevice: false },
  );
}

export async function persistAllCaptureCameraParams(input: {
  name: string;
  ips?: string[];
  cameraParamDir?: string;
  applySoftTrigger?: boolean;
}): Promise<CaptureBatchOperationResult> {
  return writeAdminJson<CaptureBatchOperationResult>(
    "/api/config/camera-params/save-all",
    {
      ...input,
      saveToDevice: true,
      deviceConfirmation: CAMERA_DEVICE_PERSIST_CONFIRMATION,
    },
  );
}

export async function loadAllCaptureCameraParams(input: {
  name: string;
  ips?: string[];
  cameraParamDir?: string;
  applySoftTrigger?: boolean;
  saveToDevice?: false;
  allowExternal?: boolean;
}): Promise<CaptureBatchOperationResult> {
  return writeAdminJson<CaptureBatchOperationResult>(
    "/api/config/camera-params/load-all",
    { ...input, saveToDevice: false },
  );
}

export async function recoverCaptureCameraParams(
  ip: string,
): Promise<CaptureBatchOperationResult> {
  return writeAdminJson<CaptureBatchOperationResult>("/api/param/recovery", {
    ip,
    confirmation: SDK_PARAMETER_WRITE_CONFIRMATION,
  });
}

export async function loadCaptureParamFile(input: {
  ip: string;
  path: string;
  allowExternal?: boolean;
  saveToDevice?: boolean;
}): Promise<CaptureCommandResult> {
  const saveToDevice = input.saveToDevice === true;
  return writeAdminJson<CaptureCommandResult>("/api/param/load-file", {
    ip: input.ip.trim(),
    path: input.path.trim(),
    allowExternal: input.allowExternal ?? false,
    applySoftTrigger: false,
    saveToDevice,
    deviceConfirmation: saveToDevice
      ? CAMERA_DEVICE_PERSIST_CONFIRMATION
      : undefined,
  });
}

export async function saveCaptureParamFile(input: {
  ip: string;
  path: string;
}): Promise<CaptureCommandResult> {
  return writeAdminJson<CaptureCommandResult>("/api/param/save-file", {
    ip: input.ip.trim(),
    path: input.path.trim(),
  });
}

export async function persistCaptureParamsToDevice(
  ip: string,
): Promise<CaptureCommandResult> {
  return writeAdminJson<CaptureCommandResult>("/api/param/save-device", {
    ip: ip.trim(),
    applySoftTrigger: false,
    deviceConfirmation: CAMERA_DEVICE_PERSIST_CONFIRMATION,
  });
}

export async function readCaptureStorageStatus(): Promise<CaptureStorageStatus> {
  return readAdminJson<CaptureStorageStatus>("/api/storage/status");
}

export async function applyCaptureStorageRoot(
  root: string,
): Promise<CaptureStorageStatus> {
  return writeAdminJson<CaptureStorageStatus>("/api/storage/config", {
    root,
  });
}

export async function applyCaptureCameraStorageRoots(input: {
  cameraRoots: CaptureCameraStorageRoot[];
  replace?: boolean;
}): Promise<CaptureStorageStatus> {
  const cameraRoots = input.cameraRoots
    .map((item) => ({ ip: item.ip.trim(), root: item.root.trim() }))
    .filter((item) => item.ip && item.root);
  if (cameraRoots.length === 0) {
    throw new Error("至少需要一个有效的相机落盘目录");
  }
  return writeAdminJson<CaptureStorageStatus>(
    "/api/storage/camera-roots",
    {
      replace: input.replace ?? true,
      cameraRoots,
    },
  );
}

export async function runCaptureContinuousTest(
  input: CaptureContinuousTestInput,
): Promise<CaptureContinuousTestSummary> {
  return writeAdminJson<CaptureContinuousTestSummary>(
    "/api/capture/continuous-test",
    {
      ...input,
      controlMode: input.controlMode ?? 0,
      discardBlackFrames: input.discardBlackFrames ?? true,
      // SDK-derived files are intentionally opt-in at provider level and are
      // not part of this operational regression workflow.
      saveSdkDerived: false,
    },
  );
}

export async function applyCaptureLineContinuousPreset(input: {
  lines: number;
  timeTriggerFreq: number;
  laserPower: number;
  laserLineSelect: number;
  controlMode: number;
  connectFirst?: boolean;
  saveToDevice?: boolean;
  confirmation: string;
  deviceConfirmation?: string;
}): Promise<CaptureBatchOperationResult> {
  return writeAdminJson<CaptureBatchOperationResult>(
    "/api/capture/preset/line-continuous",
    {
      ...input,
      connectFirst: input.connectFirst ?? false,
      saveToDevice: input.saveToDevice ?? false,
    },
  );
}

export async function connectCaptureCamera(ip: string, devType = -1) {
  return writeAdminJson<CaptureCommandResult>("/api/camera/connect", {
    ip,
    devType,
  });
}

export async function disconnectCaptureCamera(ip?: string) {
  return writeAdminJson<CaptureBatchOperationResult>(
    "/api/camera/disconnect",
    ip ? { ip } : {},
  );
}

export async function setCaptureParam(
  key: string,
  type: "int" | "float",
  value: number,
  ip?: string,
) {
  return writeAdminJson<CaptureCommandResult>("/api/param", {
    ip,
    key,
    type,
    value,
  });
}

export async function setCaptureSoftwareTrigger(ip?: string) {
  return writeAdminJson<CaptureCommandResult>("/api/param", {
    ip,
    key: "TriggerMode",
    type: "int",
    value: 0,
  });
}

export async function readCaptureParam(
  ip: string,
  key: string,
  type: CaptureParamType,
): Promise<CaptureCommandResult> {
  const query = new URLSearchParams({ ip: ip.trim(), key: key.trim(), type });
  return readAdminJson<CaptureCommandResult>(`/api/param?${query.toString()}`);
}

export async function writeCaptureParam(input: {
  ip: string;
  key: string;
  type: CaptureParamType;
  value: string | number;
}): Promise<CaptureCommandResult> {
  return writeAdminJson<CaptureCommandResult>("/api/param", {
    ...input,
    ip: input.ip.trim(),
    key: input.key.trim(),
    confirmation: SDK_PARAMETER_WRITE_CONFIRMATION,
  });
}

export async function captureDepthMap(
  lines = 1280,
  output = "capture-depth.png",
  ip?: string,
) {
  const result = await writeJson<CaptureCommandResult>(
    "/api/capture/depth-map",
    { ip, lines, output },
  );
  return {
    ...result,
    imageUrl: result.imageUrl?.startsWith("/")
      ? `${getCaptureServiceOrigin()}${result.imageUrl}`
      : result.imageUrl,
  };
}
export async function readLatestCaptureFile(
  ip: string,
  kind: CaptureImageKind = "depth",
): Promise<LatestCaptureFile> {
  const query = new URLSearchParams({ ip, kind, meta: "1" });
  const result = await readJson<Omit<LatestCaptureFile, "imageUrl">>(
    `/api/capture/latest?${query.toString()}`,
  );
  const resolvedUrl = result.url.startsWith("/")
    ? `${getCaptureServiceOrigin()}${result.url}`
    : result.url;
  const separator = resolvedUrl.includes("?") ? "&" : "?";
  const content = kind === "metadata"
    ? await fetch(resolvedUrl).then(async (response) => {
      if (!response.ok) {
        throw new Error(`capture metadata ${response.status}`);
      }
      return response.text();
    })
    : undefined;
  return {
    ...result,
    ip: result.ip || ip,
    kind: result.kind || kind,
    imageUrl: `${resolvedUrl}${separator}v=${Date.now()}`,
    content,
  };
}

export function validateCaptureStreamStartOptions(
  options: CaptureStreamStartOptions,
): string | null {
  if (!options.ip.trim()) {
    return "实时预览必须选择相机 IP";
  }
  if (options.lines !== undefined
    && (!Number.isInteger(options.lines) || options.lines < 1 || options.lines > 100000)) {
    return "实时预览行数必须是 1 到 100000 的整数";
  }
  if (options.width !== undefined
    && (!Number.isInteger(options.width) || options.width < 0 || options.width > 32768)) {
    return "实时预览宽度必须是 0 到 32768 的整数";
  }
  if (options.dataMode !== undefined && options.dataMode !== 1 && options.dataMode !== 3) {
    return "实时预览数据模式只允许 1（深度）或 3（深度 + 亮度）";
  }
  if (options.fpsLimit !== undefined
    && (!Number.isInteger(options.fpsLimit) || options.fpsLimit < 1 || options.fpsLimit > 30)) {
    return "实时预览 FPS 限制必须是 1 到 30 的整数";
  }
  if (options.hs !== undefined && typeof options.hs !== "boolean") {
    return "实时预览高速模式必须是布尔值";
  }
  return null;
}

export async function startCaptureStream(
  options: CaptureStreamStartOptions,
  signal?: AbortSignal,
): Promise<CaptureStreamStatus> {
  const request: CaptureStreamStartOptions = {
    lines: 1280,
    width: 0,
    dataMode: 3,
    fpsLimit: 5,
    hs: false,
    controlMode: 0,
    ...options,
    ip: options.ip.trim(),
  };
  const validationError = validateCaptureStreamStartOptions(request);
  if (validationError) {
    throw new Error(validationError);
  }
  return writeJson<CaptureStreamStatus>("/api/stream/start", request, signal);
}

export async function stopCaptureStream(
  ip: string,
  signal?: AbortSignal,
): Promise<CaptureStreamStatus> {
  return writeJson<CaptureStreamStatus>("/api/stream/stop", { ip }, signal);
}

export function captureStreamImageUrl(
  ip: string,
  kind: "depth" | "intensity" | "intensity-grid" = "depth",
  revision: string | number = Date.now(),
) {
  const query = new URLSearchParams({ ip, kind, region: "valid", v: String(revision) });
  return `${getCaptureStreamOrigin()}/api/stream/latest?${query.toString()}`;
}

/**
 * Read only the rapidly changing per-camera telemetry. This endpoint is safe
 * to poll more frequently than the full capture snapshot because it avoids
 * configuration, logs and history requests.
 */
export async function readCaptureCameraStatuses(): Promise<CaptureCameraStatus[]> {
  const result = await readJson<{ statuses?: CaptureCameraStatus[] }>(
    "/api/camera/statuses",
  );
  return Array.isArray(result.statuses) ? result.statuses : [];
}

export async function readCaptureHistory(
  limit = 240,
  materialId?: string,
): Promise<CaptureHistoryResult> {
  const query = new URLSearchParams({
    limit: String(Math.max(1, Math.min(500, Math.round(limit)))),
  });
  const normalizedMaterialId = materialId?.trim();
  if (normalizedMaterialId) {
    query.set("materialId", normalizedMaterialId);
  }
  return readJson<CaptureHistoryResult>(`/api/capture/history?${query.toString()}`);
}

export async function readCapturePlaybackCacheStatus(): Promise<CapturePlaybackCacheStatus> {
  return readJson<CapturePlaybackCacheStatus>("/api/capture/cache/status");
}

export async function readCaptureMeasurement(
  materialId: string,
): Promise<CaptureMeasurementResponse> {
  const query = new URLSearchParams({ materialId: materialId.trim() });
  return readJson<CaptureMeasurementResponse>(
    `/api/capture/measurement?${query.toString()}`,
  );
}

export async function readCaptureSurface(materialId: string): Promise<CaptureSurfaceResponse> {
  const query = new URLSearchParams({ materialId: materialId.trim() });
  return readJson<CaptureSurfaceResponse>(`/api/capture/surface?${query.toString()}`);
}

export async function readCaptureRegions(materialId: string): Promise<CaptureRegionMap> {
  const query = new URLSearchParams({ materialId: materialId.trim() });
  const response = await readJson<{ code: number; regions: CaptureRegionMap }>(
    `/api/capture/regions?${query.toString()}`,
  );
  return response.regions;
}

export async function rebuildCaptureMeasurement(materialId: string) {
  return writeJson<{ code: number; state: string; materialId: string }>(
    "/api/capture/measurement/rebuild",
    { materialId: materialId.trim() },
  );
}

export async function readCaptureDefects(
  materialId: string,
): Promise<CaptureDefectDetectionResponse> {
  const query = new URLSearchParams({ materialId: materialId.trim() });
  return readJson<CaptureDefectDetectionResponse>(
    `/api/capture/defects?${query.toString()}`,
  );
}

export async function rebuildCaptureDefects(materialId: string) {
  return writeJson<{ code: number; state: string; materialId: string }>(
    "/api/capture/defects/rebuild",
    { materialId: materialId.trim() },
  );
}

export function captureHistoryImageUrl(
  artifactRef: string,
  maxWidth: number,
  validRoi: readonly [number, number, number, number],
) {
  const query = new URLSearchParams({
    path: artifactRef,
    maxWidth: String(Math.max(160, Math.min(4096, Math.round(maxWidth)))),
    region: "valid",
  });
  if (validRoi.length === 4 && validRoi.every(Number.isFinite)) {
    const [left, top, right, bottom] = validRoi.map(Math.round);
    if (left >= 0 && top >= 0 && right > left && bottom > top) {
      query.set("cropX", String(left));
      query.set("cropY", String(top));
      query.set("cropWidth", String(right - left));
      query.set("cropHeight", String(bottom - top));
    }
  }
  return `${getCaptureServiceOrigin()}/api/capture/file?${query.toString()}`;
}

export type CaptureRenderModality = "gray" | "jet";
export type CaptureRenderLevel = "thumbnail" | "original";

export function captureRenderImageUrl(
  artifactRef: string,
  modality: CaptureRenderModality,
  level: CaptureRenderLevel,
) {
  const query = new URLSearchParams({
    path: artifactRef,
    modality,
    level,
  });
  return `${getCaptureServiceOrigin()}/api/capture/render?${query.toString()}`;
}

export function captureArtifactImageUrl(artifactRef: string, maxWidth = 320) {
  const query = new URLSearchParams({
    path: artifactRef,
    maxWidth: String(Math.max(64, Math.min(2048, Math.round(maxWidth)))),
  });
  return `${getCaptureServiceOrigin()}/api/capture/file?${query.toString()}`;
}

export function captureArtifactBinaryUrl(artifactRef: string) {
  const query = new URLSearchParams({ path: artifactRef });
  return `${getCaptureServiceOrigin()}/api/capture/file?${query.toString()}`;
}

export async function readActiveCaptureCalibration(
  profile?: string,
): Promise<ActiveCaptureCalibration> {
  const query = new URLSearchParams();
  if (profile?.trim()) {
    query.set("profile", profile.trim());
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return readAdminJson<ActiveCaptureCalibration>(
    `/api/calibration/active${suffix}`,
  );
}

export async function activateCaptureCalibration(
  input: ActivateCaptureCalibrationInput,
): Promise<ActiveCaptureCalibration> {
  return writeAdminJson<ActiveCaptureCalibration>("/api/calibration/active", {
    ...input,
    saveToDevice: false,
  });
}

export async function readCaptureCalibrationStatus(
  ip: string,
): Promise<CaptureCalibrationStatus> {
  const query = new URLSearchParams({ ip: ip.trim() });
  return readAdminJson<CaptureCalibrationStatus>(
    `/api/calibration/status?${query.toString()}`,
  );
}

export async function loadCaptureCalibration(input: {
  ip: string;
  path: string;
  allowExternal?: boolean;
  confirmation: string;
}): Promise<CaptureCalibrationStatus> {
  if (input.confirmation !== CAMERA_CALIBRATION_CONFIRMATION) {
    throw new Error(`应用相机标定必须输入 ${CAMERA_CALIBRATION_CONFIRMATION}`);
  }
  return writeAdminJson<CaptureCalibrationStatus>("/api/calibration/load", {
    ip: input.ip.trim(),
    path: input.path.trim(),
    allowExternal: input.allowExternal ?? false,
    confirmation: input.confirmation,
  });
}

export async function applyCaptureCalibrationSet(
  input: CaptureCalibrationSetInput,
): Promise<CaptureBatchOperationResult> {
  const cameraCalibrations = input.cameraCalibrations
    .map((item) => ({
      ...item,
      ip: item.ip.trim(),
      path: item.path.trim(),
      artifactType: item.artifactType || "camera-sdk",
      expectedSn: item.expectedSn?.trim() || undefined,
      rollbackPath: item.rollbackPath?.trim() || undefined,
    }))
    .filter((item) => item.ip && item.path);
  const saveToDevice = input.saveToDevice === true;
  const expectedCameras = Number.isInteger(input.expectedCameras)
    ? Number(input.expectedCameras)
    : cameraCalibrations.length;
  const uniqueIps = new Set(cameraCalibrations.map((item) => item.ip));
  if (
    expectedCameras < 1
    || cameraCalibrations.length !== expectedCameras
    || uniqueIps.size !== expectedCameras
  ) {
    throw new Error(`整组标定必须包含 ${expectedCameras} 台唯一相机`);
  }
  const uniqueCalibrationPaths = new Set(
    cameraCalibrations.map((item) => item.path.replaceAll("\\", "/").toUpperCase()),
  );
  if (uniqueCalibrationPaths.size !== cameraCalibrations.length) {
    throw new Error("整组标定必须为每台相机使用独立 SDK 标定文件");
  }
  if (cameraCalibrations.some((item) => !item.expectedSn)) {
    throw new Error("整组标定必须为每台相机填写期望 SN");
  }
  const uniqueExpectedSns = new Set(
    cameraCalibrations.map((item) => item.expectedSn?.toUpperCase()),
  );
  if (uniqueExpectedSns.size !== cameraCalibrations.length) {
    throw new Error("整组标定的期望 SN 必须逐相机唯一");
  }
  if (cameraCalibrations.some((item) => !item.rollbackPath)) {
    throw new Error("整组标定预检和应用必须为每台相机填写可跨重启恢复的回滚文件");
  }
  if (!input.dryRun && input.confirmation !== CAMERA_CALIBRATION_SET_CONFIRMATION) {
    throw new Error(`真实应用必须输入 ${CAMERA_CALIBRATION_SET_CONFIRMATION}`);
  }
  const operationId = input.operationId?.trim() || "";
  if (!input.dryRun && !operationId) {
    throw new Error("真实应用必须携带稳定 operationId");
  }
  if (saveToDevice && input.deviceConfirmation !== CAMERA_DEVICE_PERSIST_CONFIRMATION) {
    throw new Error(`设备持久化必须输入 ${CAMERA_DEVICE_PERSIST_CONFIRMATION}`);
  }
  return writeAdminJson<CaptureBatchOperationResult>(
    "/api/calibration/apply-all",
    {
      ...input,
      name: input.name.trim(),
      path: input.path?.trim() || undefined,
      cameraCalibrations,
      ips: cameraCalibrations.map((item) => item.ip),
      expectedCameras,
      stopStreams: true,
      atomic: true,
      rollbackOnFailure: true,
      requireAllMapped: true,
      persistActive: input.persistActive ?? false,
      saveCameraParams: false,
      saveToDevice,
      allowBestEffortDeviceRollback: false,
      operationId: input.dryRun ? undefined : operationId,
      confirmation: input.dryRun ? undefined : input.confirmation,
      deviceConfirmation: saveToDevice ? input.deviceConfirmation : undefined,
    },
  );
}

export async function rollbackCaptureCalibrationSet(input: {
  rollbackToken: string;
  operationId: string;
  applyOperationId: string;
  parentOperationId?: string;
  confirmation: string;
}): Promise<CaptureBatchOperationResult> {
  if (input.confirmation !== CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION) {
    throw new Error(`整组标定回滚必须输入 ${CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION}`);
  }
  const operationId = input.operationId.trim();
  if (!operationId) {
    throw new Error("整组标定回滚必须携带稳定 operationId");
  }
  const applyOperationId = input.applyOperationId.trim();
  if (!applyOperationId) {
    throw new Error("整组标定回滚必须携带原始 applyOperationId");
  }
  const parentOperationId = input.parentOperationId?.trim();
  if (input.parentOperationId !== undefined && !parentOperationId) {
    throw new Error("受控恢复回滚必须携带待协调 apply 的 parentOperationId");
  }
  return writeAdminJson<CaptureBatchOperationResult>(
    "/api/calibration/rollback",
    {
      rollbackToken: input.rollbackToken.trim(),
      operationId,
      applyOperationId,
      parentOperationId,
      stopStreams: true,
      confirmation: input.confirmation,
    },
  );
}

export async function readCaptureCalibrationOperationDetail(
  operationId: string,
): Promise<CaptureCalibrationOperationDetail> {
  const id = operationId.trim();
  if (!id) {
    throw new Error("标定 operationId 不能为空");
  }
  const query = new URLSearchParams({ id });
  const detail = await readAdminJson<CaptureCalibrationOperationDetail>(
    `/api/calibration/operations/detail?${query.toString()}`,
  );
  const record = detail.operation || detail;
  const needsReconciliation = record.needsReconciliation
    ?? record.status === "needs-reconciliation";
  return detail.operation
    ? {
      ...detail,
      needsReconciliation,
      operation: { ...detail.operation, needsReconciliation },
    }
    : { ...detail, needsReconciliation };
}

export async function loadCaptureRoi(input: {
  ip: string;
  path: string;
  allowExternal?: boolean;
  confirmation: string;
}): Promise<CaptureCalibrationStatus> {
  if (input.confirmation !== CAMERA_ROI_CONFIRMATION) {
    throw new Error(`应用相机 ROI 必须输入 ${CAMERA_ROI_CONFIRMATION}`);
  }
  return writeAdminJson<CaptureCalibrationStatus>("/api/roi/load", {
    ip: input.ip.trim(),
    path: input.path.trim(),
    allowExternal: input.allowExternal ?? false,
    confirmation: input.confirmation,
  });
}

export async function captureValidationFrame(input: {
  ip: string;
  output: string;
  lines?: number;
  width?: number;
  dataMode?: number;
  timeoutMs?: number;
}): Promise<CaptureCommandResult> {
  const result = await writeAdminJson<CaptureCommandResult>(
    "/api/capture/depth-map",
    {
      ...input,
      ip: input.ip.trim(),
      output: input.output.trim(),
      calibrationMaintenanceRecord: true,
    },
  );
  return {
    ...result,
    imageUrl: result.imageUrl?.startsWith("/")
      ? `${getCaptureServiceOrigin()}${result.imageUrl}`
      : result.imageUrl,
  };
}
