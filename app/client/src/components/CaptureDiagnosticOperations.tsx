import { AlertTriangle, Camera, FileSearch, FolderOpen, RefreshCw, SlidersHorizontal, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  applyCaptureLineContinuousPreset,
  applyCaptureCalibrationSet,
  CaptureAdminApiError,
  CAMERA_CALIBRATION_CONFIRMATION,
  CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION,
  CAMERA_CALIBRATION_SET_CONFIRMATION,
  CAMERA_DEVICE_PERSIST_CONFIRMATION,
  CAMERA_ROI_CONFIRMATION,
  captureValidationFrame,
  chooseCaptureLocalFile,
  loadCaptureCalibration,
  loadCaptureParamFile,
  loadCaptureRoi,
  persistAllCaptureCameraParams,
  persistCaptureParamsToDevice,
  readCaptureCalibrationStatus,
  readCaptureCalibrationOperationDetail,
  readCaptureParam,
  SDK_PARAMETER_WRITE_CONFIRMATION,
  rollbackCaptureCalibrationSet,
  saveCaptureParamFile,
  writeCaptureParam,
  type CaptureBatchOperationResult,
  type CaptureCalibrationMapping,
  type CaptureCalibrationOperationDetail,
  type CaptureReconciliationFencePayload,
  type CaptureCalibrationStatus,
  type CaptureCameraStatus,
  type CaptureCommandResult,
  type CaptureParamType,
} from '../lib/capture-api';

type DiagnosticOperation =
  | 'read-param'
  | 'write-param'
  | 'load-param-file'
  | 'save-param-file'
  | 'persist-param-device'
  | 'persist-param-all'
  | 'read-calibration'
  | 'load-calibration'
  | 'load-roi'
  | 'validation'
  | 'calibration-set-preflight'
  | 'calibration-set-apply'
  | 'calibration-set-rollback'
  | 'calibration-apply-reconcile'
  | 'calibration-rollback-reconcile'
  | 'line-preset';

export const LINE_PRESET_CONFIRMATION = 'APPLY LINE CONTINUOUS PRESET';
export const LINE_PRESET_DEVICE_CONFIRMATION = 'PERSIST LINE PRESET TO CAMERA DEVICES';
const EMPTY_CAMERA_STATUSES: CaptureCameraStatus[] = [];

function normalizeIps(cameraIps: string[]) {
  return Array.from(new Set(cameraIps.map((ip) => ip.trim()).filter(Boolean)));
}

export function createCalibrationOperationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function operationRecord(detail: CaptureCalibrationOperationDetail | null) {
  return detail?.operation || detail;
}

function reconciliationFencePayload(error: unknown) {
  if (!(error instanceof CaptureAdminApiError) || error.status !== 423) {
    return null;
  }
  const payload = error.payload as Partial<CaptureReconciliationFencePayload> | undefined;
  return payload?.code === 423 && payload.error === 'calibration_reconciliation_required'
    ? payload as CaptureReconciliationFencePayload
    : null;
}

function diagnosticFailureMessage(error: unknown) {
  const fallback = error instanceof Error ? error.message : '开发诊断操作失败';
  const fence = reconciliationFencePayload(error);
  if (!fence) {
    return fallback;
  }
  const operationIds = fence.unresolvedOperations
    ?.map((item) => item.operationId)
    .filter(Boolean)
    .join('、');
  return `HTTP 423 标定协调围栏已锁定设备变更${operationIds ? `（待协调 ${operationIds}）` : ''}；请刷新操作记录，并仅使用父操作绑定的受控恢复回滚。`;
}

function paramValue(type: CaptureParamType, value: string) {
  const normalized = value.trim();
  if (type === 'int') {
    const parsed = Number(normalized);
    if (!normalized || !Number.isInteger(parsed)) {
      throw new Error('int 参数值不是有效整数');
    }
    return parsed;
  }
  if (type === 'float') {
    const parsed = Number(normalized);
    if (!normalized || !Number.isFinite(parsed)) {
      throw new Error('float 参数值不是有效数字');
    }
    return parsed;
  }
  return value;
}

export function captureParamWritePhrase() {
  return SDK_PARAMETER_WRITE_CONFIRMATION;
}

export function captureMaintenancePhrase(ip: string) {
  return `维护 ${ip.trim()}`;
}

export function CaptureDiagnosticOperations({
  cameraIps,
  cameraStatuses = EMPTY_CAMERA_STATUSES,
}: {
  cameraIps: string[];
  cameraStatuses?: CaptureCameraStatus[];
}) {
  const normalizedIpSignature = normalizeIps(cameraIps).join('\u001f');
  const normalizedIps = useMemo(
    () => normalizedIpSignature ? normalizedIpSignature.split('\u001f') : [],
    [normalizedIpSignature],
  );
  const cameraStatusByIp = useMemo(
    () => new Map(cameraStatuses.map((status) => [status.ip, status])),
    [cameraStatuses],
  );
  const cameraSerialSignature = normalizedIps
    .map((ip) => `${ip}:${cameraStatusByIp.get(ip)?.sn || ''}`)
    .join('\u001f');
  const [selectedIp, setSelectedIp] = useState(normalizedIps[0] || '');
  const [paramKey, setParamKey] = useState('ExposureTime');
  const [paramType, setParamType] = useState<CaptureParamType>('int');
  const [paramDraft, setParamDraft] = useState('1000');
  const [paramConfirmation, setParamConfirmation] = useState('');
  const [paramFilePath, setParamFilePath] = useState('');
  const [paramSavePath, setParamSavePath] = useState('param-backup/tauri-camera.nccfg');
  const [paramFileAllowExternal, setParamFileAllowExternal] = useState(false);
  const [paramFileSaveToDevice, setParamFileSaveToDevice] = useState(false);
  const [paramFileMaintenanceConfirmation, setParamFileMaintenanceConfirmation] = useState('');
  const [paramFileDeviceConfirmation, setParamFileDeviceConfirmation] = useState('');
  const [paramSaveDeviceConfirmation, setParamSaveDeviceConfirmation] = useState('');
  const [batchPersistConfirmation, setBatchPersistConfirmation] = useState('');
  const [calibrationPath, setCalibrationPath] = useState('');
  const [roiPath, setRoiPath] = useState('');
  const [maintenanceAllowExternal, setMaintenanceAllowExternal] = useState(false);
  const [validationOutput, setValidationOutput] = useState('calibration/tauri-validation.png');
  const [validationLines, setValidationLines] = useState(1000);
  const [validationWidth, setValidationWidth] = useState(0);
  const [validationTimeoutMs, setValidationTimeoutMs] = useState(8000);
  const [calibrationConfirmation, setCalibrationConfirmation] = useState('');
  const [roiConfirmation, setRoiConfirmation] = useState('');
  const [validationConfirmation, setValidationConfirmation] = useState('');
  const [calibrationSetProfile, setCalibrationSetProfile] = useState('current-6-soft-trigger');
  const [arrayCalibrationPath, setArrayCalibrationPath] = useState('');
  const [calibrationMappings, setCalibrationMappings] = useState<CaptureCalibrationMapping[]>(() =>
    normalizedIps.map((ip) => ({
      ip,
      path: '',
      artifactType: 'camera-sdk',
      expectedSn: cameraStatusByIp.get(ip)?.sn || '',
    })),
  );
  const [calibrationSetPersistActive, setCalibrationSetPersistActive] = useState(false);
  const [calibrationSetSaveToDevice, setCalibrationSetSaveToDevice] = useState(false);
  const [calibrationSetAllowExternal, setCalibrationSetAllowExternal] = useState(false);
  const [calibrationSetConfirmation, setCalibrationSetConfirmation] = useState('');
  const [calibrationSetDeviceConfirmation, setCalibrationSetDeviceConfirmation] = useState('');
  const [calibrationSetPreflightSignature, setCalibrationSetPreflightSignature] = useState('');
  const [calibrationSetResult, setCalibrationSetResult] = useState<CaptureBatchOperationResult | null>(null);
  const [applyOperationId, setApplyOperationId] = useState('');
  const [applyOperationDetail, setApplyOperationDetail] = useState<CaptureCalibrationOperationDetail | null>(null);
  const [rollbackToken, setRollbackToken] = useState('');
  const [rollbackApplyOperationId, setRollbackApplyOperationId] = useState('');
  const [rollbackOperationId, setRollbackOperationId] = useState('');
  const [rollbackOperationDetail, setRollbackOperationDetail] = useState<CaptureCalibrationOperationDetail | null>(null);
  const [rollbackConfirmation, setRollbackConfirmation] = useState('');
  const [reconciliationFence, setReconciliationFence] = useState<CaptureReconciliationFencePayload | null>(null);
  const [presetLines, setPresetLines] = useState(1000);
  const [presetFrequency, setPresetFrequency] = useState(300);
  const [presetLaserPower, setPresetLaserPower] = useState(100);
  const [presetLaserLine, setPresetLaserLine] = useState(0);
  const [presetControlMode, setPresetControlMode] = useState(0);
  const [presetConnectFirst, setPresetConnectFirst] = useState(false);
  const [presetSaveToDevice, setPresetSaveToDevice] = useState(false);
  const [presetConfirmation, setPresetConfirmation] = useState('');
  const [presetDeviceConfirmation, setPresetDeviceConfirmation] = useState('');
  const [busy, setBusy] = useState<DiagnosticOperation | null>(null);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<CaptureCommandResult | null>(null);
  const [calibrationStatus, setCalibrationStatus] = useState<CaptureCalibrationStatus | null>(null);
  const writePhrase = captureParamWritePhrase();
  const maintenancePhrase = captureMaintenancePhrase(selectedIp);
  const writeConfirmed = Boolean(selectedIp && paramKey.trim() && paramConfirmation === writePhrase);
  const paramFileMaintenanceConfirmed = Boolean(selectedIp
    && paramFilePath.trim()
    && paramFileMaintenanceConfirmation === maintenancePhrase);
  const paramFileDeviceConfirmed = !paramFileSaveToDevice
    || paramFileDeviceConfirmation === CAMERA_DEVICE_PERSIST_CONFIRMATION;
  const paramSaveDeviceConfirmed = Boolean(selectedIp
    && paramSaveDeviceConfirmation === CAMERA_DEVICE_PERSIST_CONFIRMATION);
  const batchPersistConfirmed = Boolean(normalizedIps.length
    && batchPersistConfirmation === CAMERA_DEVICE_PERSIST_CONFIRMATION);
  const calibrationConfirmed = Boolean(selectedIp && calibrationConfirmation === CAMERA_CALIBRATION_CONFIRMATION);
  const roiConfirmed = Boolean(selectedIp && roiConfirmation === CAMERA_ROI_CONFIRMATION);
  const validationConfirmed = Boolean(selectedIp && validationConfirmation === maintenancePhrase);
  const presetConfirmed = presetConfirmation === LINE_PRESET_CONFIRMATION;
  const presetDeviceConfirmed = !presetSaveToDevice || presetDeviceConfirmation === LINE_PRESET_DEVICE_CONFIRMATION;
  const calibrationSetSignature = useMemo(() => JSON.stringify({
    profile: calibrationSetProfile.trim(),
    arrayCalibrationPath: arrayCalibrationPath.trim(),
    mappings: calibrationMappings.map((item) => ({
      ip: item.ip.trim(),
      path: item.path.trim(),
      expectedSn: item.expectedSn?.trim() || '',
      rollbackPath: item.rollbackPath?.trim() || '',
    })),
    persistActive: calibrationSetPersistActive,
    saveCameraParams: false,
    saveToDevice: calibrationSetSaveToDevice,
    allowExternal: calibrationSetAllowExternal,
  }), [
    arrayCalibrationPath,
    calibrationMappings,
    calibrationSetPersistActive,
    calibrationSetProfile,
    calibrationSetSaveToDevice,
    calibrationSetAllowExternal,
  ]);
  const calibrationMappingsComplete = calibrationMappings.length === 6
    && calibrationMappings.every((item) =>
      item.ip.trim() && item.path.trim() && item.expectedSn?.trim() && item.rollbackPath?.trim());
  const calibrationSetPreflightPassed = calibrationSetPreflightSignature === calibrationSetSignature;
  const calibrationSetConfirmed = calibrationSetConfirmation === CAMERA_CALIBRATION_SET_CONFIRMATION;
  const calibrationSetDeviceConfirmed = !calibrationSetSaveToDevice
    || calibrationSetDeviceConfirmation === CAMERA_DEVICE_PERSIST_CONFIRMATION;
  const applyReconciliation = operationRecord(applyOperationDetail);
  const rollbackReconciliation = operationRecord(rollbackOperationDetail);
  const fencedParentOperation = reconciliationFence?.unresolvedOperations
    ?.find((item) => item.status === 'needs-reconciliation')
    || null;
  const fencedParentOperationId = fencedParentOperation?.operationId || '';
  const recoveryParentOperationId = applyReconciliation?.status === 'needs-reconciliation'
    ? (applyReconciliation.operationId || applyReconciliation.id || applyOperationId)
    : fencedParentOperationId;
  const rollbackExpectedApplyOperationId = fencedParentOperation?.expectedApplyOperationId
    || rollbackApplyOperationId
    || applyOperationId;
  const rollbackConfirmed = Boolean(rollbackToken.trim()
    && rollbackExpectedApplyOperationId.trim()
    && rollbackConfirmation === CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION);
  const rollbackParentUnconfirmed = applyReconciliation?.needsReconciliation === true
    && applyReconciliation.status !== 'needs-reconciliation';
  const reconciliationFenceActive = Boolean(
    recoveryParentOperationId
    || reconciliationFence?.unresolvedOperations?.length,
  );

  useEffect(() => {
    if (!normalizedIps.includes(selectedIp)) {
      setSelectedIp(normalizedIps[0] || '');
      setParamConfirmation('');
      setParamFileMaintenanceConfirmation('');
      setParamFileDeviceConfirmation('');
      setParamSaveDeviceConfirmation('');
      setCalibrationConfirmation('');
      setRoiConfirmation('');
      setValidationConfirmation('');
      setCalibrationStatus(null);
    }
  }, [normalizedIps, selectedIp]);

  useEffect(() => {
    setCalibrationMappings((current) => {
      const byIp = new Map(current.map((item) => [item.ip, item]));
      return normalizedIps.map((ip) => ({
        ...(byIp.get(ip) || { ip, path: '', artifactType: 'camera-sdk' }),
        expectedSn: byIp.get(ip)?.expectedSn || cameraStatusByIp.get(ip)?.sn || '',
      }));
    });
    setCalibrationSetPreflightSignature('');
    setCalibrationSetConfirmation('');
    setCalibrationSetDeviceConfirmation('');
    setApplyOperationId('');
    setApplyOperationDetail(null);
    setBatchPersistConfirmation('');
  }, [cameraSerialSignature, normalizedIpSignature]);

  const selectIp = (ip: string) => {
    setSelectedIp(ip);
    setParamConfirmation('');
    setParamFileMaintenanceConfirmation('');
    setParamFileDeviceConfirmation('');
    setParamSaveDeviceConfirmation('');
    setCalibrationConfirmation('');
    setRoiConfirmation('');
    setValidationConfirmation('');
    setCalibrationStatus(null);
    setResult(null);
    setMessage('');
  };

  const invalidateCalibrationSetApproval = () => {
    setCalibrationSetPreflightSignature('');
    setCalibrationSetConfirmation('');
    setCalibrationSetDeviceConfirmation('');
    setApplyOperationId('');
    setApplyOperationDetail(null);
  };

  const invalidateLinePresetApproval = () => {
    setPresetConfirmation('');
    setPresetDeviceConfirmation('');
  };

  const selectLocalFile = async (
    title: string,
    extensions: string[],
    onSelected: (path: string) => void,
  ) => {
    try {
      const selected = await chooseCaptureLocalFile(title, extensions);
      if (!selected) {
        setMessage('浏览器模式不提供本地文件选择；可继续手工填写采集主机路径');
      } else if (selected.selected && selected.path) {
        onSelected(selected.path);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '本地文件选择失败');
    }
  };

  const updateCalibrationMapping = (
    index: number,
    patch: Partial<CaptureCalibrationMapping>,
  ) => {
    setCalibrationMappings((current) => current.map((item, itemIndex) =>
      itemIndex === index ? { ...item, ...patch } : item));
    invalidateCalibrationSetApproval();
  };

  const run = async <T extends CaptureCommandResult>(
    operation: DiagnosticOperation,
    action: () => Promise<T>,
    success: (response: T) => string,
    failure?: (error: unknown) => void,
  ) => {
    setBusy(operation);
    setMessage('');
    try {
      const response = await action();
      setResult(response);
      setMessage(response.code === 0 ? success(response) : `操作返回 code ${response.code}：${response.error || response.message || 'provider 未接受'}`);
      return response;
    } catch (error) {
      const fence = reconciliationFencePayload(error);
      if (fence) {
        setReconciliationFence(fence);
      }
      failure?.(error);
      setMessage(diagnosticFailureMessage(error));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const handleReadParam = async () => {
    const response = await run(
      'read-param',
      () => readCaptureParam(selectedIp, paramKey, paramType),
      (next) => `已读取 ${next.key || paramKey}`,
    );
    if (response?.value !== undefined) {
      setParamDraft(String(response.value));
    }
  };

  const handleWriteParam = async () => {
    if (!writeConfirmed) {
      setMessage(`请输入精确确认短语：${writePhrase}`);
      return;
    }
    let value: string | number;
    try {
      value = paramValue(paramType, paramDraft);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '参数值无效');
      return;
    }
    const response = await run(
      'write-param',
      () => writeCaptureParam({ ip: selectedIp, key: paramKey, type: paramType, value }),
      () => `已向 ${selectedIp} 写入 ${paramKey}`,
    );
    if (response?.code === 0) {
      setParamConfirmation('');
    }
  };

  const handleLoadParamFile = async () => {
    if (!paramFileMaintenanceConfirmed) {
      setMessage(`加载参数文件前请输入精确确认短语：${maintenancePhrase}`);
      return;
    }
    if (!paramFileDeviceConfirmed) {
      setMessage(`设备持久化还需输入：${CAMERA_DEVICE_PERSIST_CONFIRMATION}`);
      return;
    }
    const response = await run(
      'load-param-file',
      () => loadCaptureParamFile({
        ip: selectedIp,
        path: paramFilePath,
        allowExternal: paramFileAllowExternal,
        saveToDevice: paramFileSaveToDevice,
      }),
      (next) => `参数文件已加载到 ${selectedIp}${next.saveToDevice ? ' 并持久化到设备' : '（仅运行态）'}`,
    );
    if (response?.code === 0) {
      setParamFileMaintenanceConfirmation('');
      setParamFileDeviceConfirmation('');
    }
  };

  const handleSaveParamFile = async () => {
    if (!selectedIp || !paramSavePath.trim()) {
      setMessage('请填写参数快照输出路径');
      return;
    }
    await run(
      'save-param-file',
      () => saveCaptureParamFile({ ip: selectedIp, path: paramSavePath }),
      (next) => `参数快照已保存：${next.path || paramSavePath}`,
    );
  };

  const handlePersistParamDevice = async () => {
    if (!paramSaveDeviceConfirmed) {
      setMessage(`请输入精确确认短语：${CAMERA_DEVICE_PERSIST_CONFIRMATION}`);
      return;
    }
    const response = await run(
      'persist-param-device',
      () => persistCaptureParamsToDevice(selectedIp),
      () => `${selectedIp} 当前运行参数已持久化到设备`,
    );
    if (response?.code === 0) {
      setParamSaveDeviceConfirmation('');
    }
  };

  const handlePersistAllParams = async () => {
    if (!batchPersistConfirmed) {
      setMessage(`请输入精确确认短语：${CAMERA_DEVICE_PERSIST_CONFIRMATION}`);
      return;
    }
    const response = await run(
      'persist-param-all',
      () => persistAllCaptureCameraParams({
        name: calibrationSetProfile.trim() || 'current-6-soft-trigger',
        ips: normalizedIps,
        cameraParamDir: `config/camera-params/${calibrationSetProfile.trim() || 'current-6-soft-trigger'}`,
        applySoftTrigger: false,
      }),
      (next) => `全部相机参数快照/设备持久化完成：成功 ${next.saved ?? 0}，失败 ${next.failed ?? 0}`,
    );
    setCalibrationSetResult(response);
    if (response?.code === 0) {
      setBatchPersistConfirmation('');
    }
  };

  const handleReadCalibration = async () => {
    const response = await run(
      'read-calibration',
      () => readCaptureCalibrationStatus(selectedIp),
      () => `已刷新 ${selectedIp} 标定/ROI 状态`,
    );
    if (response) {
      setCalibrationStatus(response);
    }
  };

  const handleCalibrationMutation = async (
    operation: 'load-calibration' | 'load-roi' | 'validation',
  ) => {
    const requiredConfirmation = operation === 'load-calibration'
      ? CAMERA_CALIBRATION_CONFIRMATION
      : operation === 'load-roi'
        ? CAMERA_ROI_CONFIRMATION
        : maintenancePhrase;
    const confirmed = operation === 'load-calibration'
      ? calibrationConfirmed
      : operation === 'load-roi'
        ? roiConfirmed
        : validationConfirmed;
    if (!confirmed) {
      setMessage(`请输入精确确认短语：${requiredConfirmation}`);
      return;
    }
    if (operation === 'load-calibration' && !calibrationPath.trim()) {
      setMessage('请填写采集主机可访问的标定文件路径');
      return;
    }
    if (operation === 'load-roi' && !roiPath.trim()) {
      setMessage('请填写采集主机可访问的 ROI 文件路径');
      return;
    }
    if (operation === 'validation' && !validationOutput.trim()) {
      setMessage('请填写验证帧输出路径');
      return;
    }

    const response = operation === 'load-calibration'
      ? await run(operation, () => loadCaptureCalibration({ ip: selectedIp, path: calibrationPath, allowExternal: maintenanceAllowExternal, confirmation: calibrationConfirmation }), () => `标定文件已下发到 ${selectedIp}`)
      : operation === 'load-roi'
        ? await run(operation, () => loadCaptureRoi({ ip: selectedIp, path: roiPath, allowExternal: maintenanceAllowExternal, confirmation: roiConfirmation }), () => `ROI 文件已下发到 ${selectedIp}`)
        : await run(
          operation,
          () => captureValidationFrame({
            ip: selectedIp,
            output: validationOutput,
            lines: validationLines,
            width: validationWidth,
            dataMode: 3,
            timeoutMs: validationTimeoutMs,
          }),
          (next) => `验证帧已采集：${next.output || validationOutput}`,
        );
    if (response?.code === 0) {
      if (operation === 'load-calibration') {
        setCalibrationConfirmation('');
      } else if (operation === 'load-roi') {
        setRoiConfirmation('');
      } else {
        setValidationConfirmation('');
      }
      void handleReadCalibration();
    }
  };

  const calibrationSetPayload = (dryRun: boolean, operationId?: string) => ({
    name: calibrationSetProfile,
    path: arrayCalibrationPath,
    cameraCalibrations: calibrationMappings,
    ips: calibrationMappings.map((item) => item.ip),
    expectedCameras: 6,
    dryRun,
    stopStreams: true,
    atomic: true,
    rollbackOnFailure: true,
    requireAllMapped: true,
    persistActive: calibrationSetPersistActive,
    saveCameraParams: false,
    saveToDevice: calibrationSetSaveToDevice,
    allowExternal: calibrationSetAllowExternal,
    operationId: dryRun ? undefined : operationId,
    confirmation: dryRun ? undefined : calibrationSetConfirmation,
    deviceConfirmation: calibrationSetSaveToDevice
      ? calibrationSetDeviceConfirmation
      : undefined,
  });

  const handleCalibrationSetPreflight = async (newOperation = false) => {
    if (!calibrationSetProfile.trim() || !calibrationMappingsComplete) {
      setMessage('整组标定预检需要 6 台相机的唯一 IP、SDK 标定文件、期望 SN 和已知良好回滚文件');
      return;
    }
    if (calibrationSetPersistActive && !arrayCalibrationPath.trim()) {
      setMessage('更新 active pointer 时必须填写阵列重建 XML');
      return;
    }
    if (newOperation) {
      setCalibrationSetPreflightSignature('');
      setCalibrationSetConfirmation('');
      setCalibrationSetDeviceConfirmation('');
    }
    const signature = calibrationSetSignature;
    const response = await run(
      'calibration-set-preflight',
      () => applyCaptureCalibrationSet(calibrationSetPayload(true)),
      (next) => `整组标定预检通过：${next.results?.length ?? calibrationMappings.length} 台相机，未调用 SDK`,
    );
    setCalibrationSetResult(response);
    if (response?.code === 0 && response.dryRun === true) {
      setCalibrationSetPreflightSignature(signature);
      if (newOperation) {
        setApplyOperationId(createCalibrationOperationId());
        setApplyOperationDetail(null);
      } else {
        setApplyOperationId((current) => current || createCalibrationOperationId());
      }
    } else {
      setCalibrationSetPreflightSignature('');
    }
  };

  const handleCalibrationSetApply = async () => {
    if (!calibrationSetPreflightPassed) {
      setMessage('配置已变更或尚未通过 dryRun 预检，请重新预检');
      return;
    }
    if (!calibrationSetConfirmed) {
      setMessage(`请输入精确确认短语：${CAMERA_CALIBRATION_SET_CONFIRMATION}`);
      return;
    }
    if (!calibrationSetDeviceConfirmed) {
      setMessage(`设备持久化还需输入：${CAMERA_DEVICE_PERSIST_CONFIRMATION}`);
      return;
    }
    if (!applyOperationId) {
      setMessage('预检尚未生成稳定 operationId，请重新执行 dryRun 预检');
      return;
    }
    const operationId = applyOperationId;
    let dispatchError: unknown;
    setApplyOperationDetail({
      code: 0,
      operationId,
      status: 'submitting',
      needsReconciliation: false,
    });
    const response = await run(
      'calibration-set-apply',
      () => applyCaptureCalibrationSet(calibrationSetPayload(false, operationId)),
      (next) => `整组标定完成：应用 ${next.applied ?? 0}，失败 ${next.failed ?? 0}`,
      (error) => { dispatchError = error; },
    );
    setCalibrationSetResult(response);
    if (response) {
      setApplyOperationDetail({
        ...response,
        operationId: response.operationId || operationId,
        status: response.status || (response.code === 0 ? 'succeeded' : 'failed'),
        needsReconciliation: response.needsReconciliation
          ?? response.status === 'needs-reconciliation',
      });
    } else {
      const unresolved = reconciliationFencePayload(dispatchError)?.unresolvedOperations
        ?.find((item) => item.status === 'needs-reconciliation');
      if (unresolved?.operationId) {
        setApplyOperationId(unresolved.operationId);
        setApplyOperationDetail({
          code: 423,
          operationId: unresolved.operationId,
          kind: unresolved.kind || 'apply',
          status: 'needs-reconciliation',
          needsReconciliation: true,
          error: unresolved.error || 'calibration_reconciliation_required',
          updatedAt: unresolved.updatedAt,
        });
      } else {
        setApplyOperationDetail({
          code: 1,
          operationId,
          status: 'unknown',
          needsReconciliation: true,
        });
      }
    }
    if (response?.rollbackToken
      && !(response.rollbackPerformed === true && response.rollbackComplete === true)) {
      if (rollbackToken !== response.rollbackToken) {
        setRollbackOperationId('');
        setRollbackOperationDetail(null);
      }
      setRollbackToken(response.rollbackToken);
      setRollbackApplyOperationId(response.operationId || operationId);
    } else if (response?.rollbackPerformed === true && response.rollbackComplete === true) {
      setRollbackToken('');
      setRollbackApplyOperationId('');
      setRollbackConfirmation('');
      setRollbackOperationId('');
      setRollbackOperationDetail(null);
    }
    if (response?.code === 0) {
      setCalibrationSetConfirmation('');
      setCalibrationSetDeviceConfirmation('');
    }
  };

  const handleCalibrationSetRollback = async () => {
    if (!rollbackConfirmed) {
      setMessage(`请输入精确确认短语：${CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION}`);
      return;
    }
    const operationId = rollbackOperationId || createCalibrationOperationId();
    const parentOperationId = recoveryParentOperationId || undefined;
    if (!rollbackOperationId) {
      setRollbackOperationId(operationId);
    }
    setRollbackOperationDetail({
      code: 0,
      operationId,
      parentOperationId,
      status: 'submitting',
      needsReconciliation: false,
    });
    const response = await run(
      'calibration-set-rollback',
      () => rollbackCaptureCalibrationSet({
        rollbackToken,
        operationId,
        applyOperationId: rollbackExpectedApplyOperationId,
        parentOperationId,
        confirmation: rollbackConfirmation,
      }),
      (next) => `整组标定回滚${next.complete === false ? '未完整完成' : '完成'}`,
    );
    setCalibrationSetResult(response);
    setRollbackOperationDetail(response ? {
      ...response,
      operationId: response.operationId || operationId,
      parentOperationId,
      status: response.status || (response.code === 0 ? 'succeeded' : 'failed'),
      needsReconciliation: response.needsReconciliation
        ?? response.status === 'needs-reconciliation',
    } : {
      code: 1,
      operationId,
      status: 'unknown',
      needsReconciliation: true,
    });
    if (response?.code === 0) {
      setRollbackConfirmation('');
      if (parentOperationId) {
        const parentDetail = await run(
          'calibration-apply-reconcile',
          () => readCaptureCalibrationOperationDetail(parentOperationId),
          (next) => `受控恢复已提交，父操作状态：${operationRecord(next)?.status || 'unknown'}`,
        );
        if (parentDetail) {
          setApplyOperationDetail(parentDetail);
          const parentRecord = operationRecord(parentDetail);
          if (parentRecord?.status === 'reconciled'
            && parentRecord.needsReconciliation !== true) {
            setReconciliationFence(null);
          }
        }
      }
    }
  };

  const handleCalibrationOperationReconcile = async (
    kind: 'apply' | 'rollback',
  ) => {
    const operationId = kind === 'apply' ? applyOperationId : rollbackOperationId;
    if (!operationId) {
      setMessage('当前没有可对账的 operationId');
      return;
    }
    const response = await run(
      kind === 'apply' ? 'calibration-apply-reconcile' : 'calibration-rollback-reconcile',
      () => readCaptureCalibrationOperationDetail(operationId),
      (next) => {
        const record = operationRecord(next);
        return `标定操作对账已刷新：${record?.status || 'unknown'}`;
      },
    );
    if (kind === 'apply') {
      setApplyOperationDetail(response);
      const record = operationRecord(response);
      if (record?.status === 'reconciled' && record.needsReconciliation !== true) {
        setReconciliationFence(null);
      }
    } else {
      setRollbackOperationDetail(response);
    }
  };

  const handleLinePreset = async () => {
    if (!presetConfirmed) {
      setMessage(`请输入精确确认短语：${LINE_PRESET_CONFIRMATION}`);
      return;
    }
    if (!presetDeviceConfirmed) {
      setMessage(`设备持久化还需输入：${LINE_PRESET_DEVICE_CONFIRMATION}`);
      return;
    }
    const response = await run(
      'line-preset',
      () => applyCaptureLineContinuousPreset({
        lines: presetLines,
        timeTriggerFreq: presetFrequency,
        laserPower: presetLaserPower,
        laserLineSelect: presetLaserLine,
        controlMode: presetControlMode,
        connectFirst: presetConnectFirst,
        saveToDevice: presetSaveToDevice,
        confirmation: presetConfirmation,
        deviceConfirmation: presetSaveToDevice ? presetDeviceConfirmation : undefined,
      }),
      (next) => `线扫预设执行完成：应用 ${next.applied ?? 0}，失败 ${next.failed ?? 0}`,
    );
    if (response?.code === 0) {
      setPresetConfirmation('');
      setPresetDeviceConfirmation('');
    }
  };

  return (
    <section className="capture-diagnostic-operations" aria-label="受控开发诊断">
      <header>
        <AlertTriangle size={17} />
        <div>
          <strong>受控开发诊断</strong>
          <span>仅供 SDK 参数与单相机标定维护；正式生产流程请使用 Profile、自动标定与生产采集入口。</span>
        </div>
      </header>

      <label className="capture-diagnostic-camera-select">
        <span>目标相机</span>
        <select aria-label="诊断目标相机" value={selectedIp} onChange={(event) => selectIp(event.target.value)}>
          {normalizedIps.map((ip) => <option key={ip} value={ip}>{ip}</option>)}
        </select>
      </label>

      <div className="capture-diagnostic-grid">
        <section>
          <header><SlidersHorizontal size={16} /><strong>任意 SDK 参数读写</strong></header>
          <label><span>参数名</span><input aria-label="SDK 参数名" value={paramKey} onChange={(event) => { setParamKey(event.target.value); setParamConfirmation(''); }} /></label>
          <label>
            <span>类型</span>
            <select aria-label="SDK 参数类型" value={paramType} onChange={(event) => { setParamType(event.target.value as CaptureParamType); setParamConfirmation(''); }}>
              <option value="int">int</option><option value="float">float</option><option value="string">string</option>
            </select>
          </label>
          <label><span>值</span><input aria-label="SDK 参数值" value={paramDraft} onChange={(event) => { setParamDraft(event.target.value); setParamConfirmation(''); }} /></label>
          <div className="capture-operation-actions">
            <button type="button" disabled={busy !== null || !selectedIp || !paramKey.trim()} onClick={() => void handleReadParam()}>
              <FileSearch size={14} />读取参数
            </button>
          </div>
          <label className="capture-danger-confirm phrase">
            <span>输入 <code>{writePhrase}</code> 才能写入</span>
            <input aria-label="参数写入确认短语" value={paramConfirmation} onChange={(event) => setParamConfirmation(event.target.value)} autoComplete="off" />
          </label>
          <button type="button" className="danger" disabled={busy !== null || !writeConfirmed} onClick={() => void handleWriteParam()}>
            <Upload size={14} />写入参数
          </button>
          <div className="capture-param-file-diagnostic">
            <strong>.nccfg 参数文件 / 设备持久化</strong>
            <label>
              <span>加载文件</span>
              <div className="capture-path-picker">
                <input aria-label="单相机参数加载文件" value={paramFilePath} onChange={(event) => { setParamFilePath(event.target.value); setParamFileMaintenanceConfirmation(''); setParamFileDeviceConfirmation(''); }} />
                <button type="button" aria-label="选择单相机参数加载文件" onClick={() => void selectLocalFile('选择相机参数文件', ['nccfg', 'xml'], (path) => { setParamFilePath(path); setParamFileMaintenanceConfirmation(''); setParamFileDeviceConfirmation(''); })}><FolderOpen size={14} /></button>
              </div>
            </label>
            <div className="capture-operation-checks">
              <label><input aria-label="参数文件允许外部绝对路径" type="checkbox" checked={paramFileAllowExternal} onChange={(event) => { setParamFileAllowExternal(event.target.checked); setParamFileMaintenanceConfirmation(''); setParamFileDeviceConfirmation(''); }} />允许外部绝对路径（默认关闭）</label>
              <label><input aria-label="参数文件加载后持久化到设备" type="checkbox" checked={paramFileSaveToDevice} onChange={(event) => { setParamFileSaveToDevice(event.target.checked); setParamFileMaintenanceConfirmation(''); setParamFileDeviceConfirmation(''); }} />加载后持久化到设备（默认关闭）</label>
            </div>
            <label className="capture-danger-confirm phrase">
              <span>加载前输入 <code>{maintenancePhrase}</code></span>
              <input aria-label="参数文件加载确认短语" value={paramFileMaintenanceConfirmation} onChange={(event) => setParamFileMaintenanceConfirmation(event.target.value)} autoComplete="off" />
            </label>
            {paramFileSaveToDevice ? (
              <label className="capture-danger-confirm phrase">
                <span>设备持久化还需输入 <code>{CAMERA_DEVICE_PERSIST_CONFIRMATION}</code></span>
                <input aria-label="参数文件设备持久化确认短语" value={paramFileDeviceConfirmation} onChange={(event) => setParamFileDeviceConfirmation(event.target.value)} autoComplete="off" />
              </label>
            ) : null}
            <button type="button" disabled={busy !== null || !paramFileMaintenanceConfirmed || !paramFileDeviceConfirmed} onClick={() => void handleLoadParamFile()}>
              <Upload size={14} />加载参数文件{paramFileSaveToDevice ? '并持久化' : '到运行态'}
            </button>
            <label><span>保存快照路径</span><input aria-label="单相机参数保存文件" value={paramSavePath} onChange={(event) => setParamSavePath(event.target.value)} /></label>
            <button type="button" disabled={busy !== null || !selectedIp || !paramSavePath.trim()} onClick={() => void handleSaveParamFile()}>保存 .nccfg 快照</button>
            <label className="capture-danger-confirm phrase">
              <span>将当前运行参数写入设备：<code>{CAMERA_DEVICE_PERSIST_CONFIRMATION}</code></span>
              <input aria-label="单相机参数设备持久化确认短语" value={paramSaveDeviceConfirmation} onChange={(event) => setParamSaveDeviceConfirmation(event.target.value)} autoComplete="off" />
            </label>
            <button type="button" className="danger" disabled={busy !== null || !paramSaveDeviceConfirmed} onClick={() => void handlePersistParamDevice()}>持久化当前相机参数</button>
            <label className="capture-danger-confirm phrase">
              <span>批量保存快照并写入全部设备：<code>{CAMERA_DEVICE_PERSIST_CONFIRMATION}</code></span>
              <input aria-label="全部相机参数设备持久化确认短语" value={batchPersistConfirmation} onChange={(event) => setBatchPersistConfirmation(event.target.value)} autoComplete="off" />
            </label>
            <button type="button" className="danger" disabled={busy !== null || !batchPersistConfirmed} onClick={() => void handlePersistAllParams()}>持久化全部相机参数</button>
          </div>
        </section>

        <section>
          <header><Camera size={16} /><strong>单相机标定 / ROI / 验证</strong></header>
          <p>路径必须位于采集主机可访问位置。Tauri 桌面端可选择本机文件；浏览器测试/开发模式仍可手工填写路径。</p>
          <label>
            <span>标定文件</span>
            <div className="capture-path-picker">
              <input aria-label="单相机标定文件路径" value={calibrationPath} onChange={(event) => { setCalibrationPath(event.target.value); setCalibrationConfirmation(''); }} />
              <button type="button" aria-label="选择单相机标定文件" onClick={() => void selectLocalFile('选择单相机 SDK 标定文件', ['xml'], (path) => { setCalibrationPath(path); setCalibrationConfirmation(''); })}><FolderOpen size={14} /></button>
            </div>
          </label>
          <label>
            <span>ROI 文件</span>
            <div className="capture-path-picker">
              <input aria-label="单相机 ROI 文件路径" value={roiPath} onChange={(event) => { setRoiPath(event.target.value); setRoiConfirmation(''); }} />
              <button type="button" aria-label="选择单相机 ROI 文件" onClick={() => void selectLocalFile('选择单相机 ROI 文件', ['xml', 'json', 'roi', 'txt'], (path) => { setRoiPath(path); setRoiConfirmation(''); })}><FolderOpen size={14} /></button>
            </div>
          </label>
          <label className="capture-operation-checkbox-inline">
            <input
              aria-label="单相机维护允许外部绝对路径"
              type="checkbox"
              checked={maintenanceAllowExternal}
              onChange={(event) => {
                setMaintenanceAllowExternal(event.target.checked);
                setCalibrationConfirmation('');
                setRoiConfirmation('');
              }}
            />
            允许 storage/config 之外的绝对路径（默认关闭）
          </label>
          <div className="capture-validation-fields">
            <label><span>验证输出</span><input aria-label="验证帧输出路径" value={validationOutput} onChange={(event) => { setValidationOutput(event.target.value); setValidationConfirmation(''); }} /></label>
            <label><span>行数</span><input aria-label="验证帧行数" type="number" min={1} value={validationLines} onChange={(event) => { setValidationLines(Number(event.target.value)); setValidationConfirmation(''); }} /></label>
            <label><span>宽度</span><input aria-label="验证帧宽度" type="number" min={0} value={validationWidth} onChange={(event) => { setValidationWidth(Number(event.target.value)); setValidationConfirmation(''); }} /></label>
            <label><span>超时 ms</span><input aria-label="验证帧超时" type="number" min={100} value={validationTimeoutMs} onChange={(event) => { setValidationTimeoutMs(Number(event.target.value)); setValidationConfirmation(''); }} /></label>
          </div>
          <button type="button" disabled={busy !== null || !selectedIp} onClick={() => void handleReadCalibration()}>
            <RefreshCw size={14} />刷新标定状态
          </button>
          <div className="capture-diagnostic-confirm-grid">
            <label className="capture-danger-confirm phrase">
              <span>应用标定输入 <code>{CAMERA_CALIBRATION_CONFIRMATION}</code></span>
              <input aria-label="单相机标定确认短语" value={calibrationConfirmation} onChange={(event) => setCalibrationConfirmation(event.target.value)} autoComplete="off" />
              <button type="button" disabled={busy !== null || !calibrationConfirmed || !calibrationPath.trim()} onClick={() => void handleCalibrationMutation('load-calibration')}>应用标定</button>
            </label>
            <label className="capture-danger-confirm phrase">
              <span>应用 ROI 输入 <code>{CAMERA_ROI_CONFIRMATION}</code></span>
              <input aria-label="单相机 ROI 确认短语" value={roiConfirmation} onChange={(event) => setRoiConfirmation(event.target.value)} autoComplete="off" />
              <button type="button" disabled={busy !== null || !roiConfirmed || !roiPath.trim()} onClick={() => void handleCalibrationMutation('load-roi')}>应用 ROI</button>
            </label>
            <label className="capture-danger-confirm phrase">
              <span>验证采集输入 <code>{maintenancePhrase}</code></span>
              <input aria-label="验证帧确认短语" value={validationConfirmation} onChange={(event) => setValidationConfirmation(event.target.value)} autoComplete="off" />
              <button type="button" disabled={busy !== null || !validationConfirmed || !validationOutput.trim()} onClick={() => void handleCalibrationMutation('validation')}>采集验证帧</button>
            </label>
          </div>
          {calibrationStatus ? (
            <dl className="capture-diagnostic-status">
              <div><dt>标定 code</dt><dd>{calibrationStatus.calibrationCode ?? calibrationStatus.code}</dd></div>
              <div><dt>标定文件</dt><dd>{calibrationStatus.calibrationPath || '-'}</dd></div>
              <div><dt>ROI code</dt><dd>{calibrationStatus.roiCode ?? '-'}</dd></div>
              <div><dt>ROI 文件</dt><dd>{calibrationStatus.roiPath || '-'}</dd></div>
              <div><dt>验证 code</dt><dd>{calibrationStatus.validationCode ?? '-'}</dd></div>
              <div><dt>验证文件</dt><dd>{calibrationStatus.validationPath || '-'}</dd></div>
              <div><dt>验证时间</dt><dd>{calibrationStatus.validationTime || '-'}</dd></div>
              <div><dt>回滚模式</dt><dd>{calibrationStatus.rollbackMode || '-'}</dd></div>
              <div><dt>回滚 code</dt><dd>{calibrationStatus.rollbackCode ?? '-'}</dd></div>
              <div><dt>回滚时间</dt><dd>{calibrationStatus.rollbackTime || '-'}</dd></div>
              <div><dt>回滚 token</dt><dd>{calibrationStatus.rollbackToken || '-'}</dd></div>
              <div><dt>维护记录</dt><dd>{calibrationStatus.maintenanceRecordPath || '-'}</dd></div>
            </dl>
          ) : null}
          {result?.imageUrl ? <img className="capture-diagnostic-validation-image" src={result.imageUrl} alt={`${selectedIp} 验证帧`} /> : null}
        </section>

        <section className="capture-calibration-set-diagnostic">
          <header><Camera size={16} /><strong>六相机 SDK 标定整组下发</strong></header>
          <p>先执行 <code>dryRun=true</code> 预检；只有同一份配置预检通过后才能真实应用。默认原子下发、失败回滚、不更新 active pointer、不写设备。</p>
          <div className="capture-calibration-set-header-fields">
            <label>
              <span>Profile</span>
              <input aria-label="整组标定 Profile" value={calibrationSetProfile} onChange={(event) => { setCalibrationSetProfile(event.target.value); invalidateCalibrationSetApproval(); }} />
            </label>
            <label>
              <span>阵列重建 XML（可选）</span>
              <div className="capture-path-picker">
                <input aria-label="整组标定阵列 XML" value={arrayCalibrationPath} onChange={(event) => { setArrayCalibrationPath(event.target.value); invalidateCalibrationSetApproval(); }} />
                <button type="button" aria-label="选择整组标定阵列 XML" onClick={() => void selectLocalFile('选择阵列重建 XML', ['xml'], (path) => { setArrayCalibrationPath(path); invalidateCalibrationSetApproval(); })}><FolderOpen size={14} /></button>
              </div>
            </label>
          </div>
          <div className="capture-calibration-mapping-table-wrap">
            <table className="capture-calibration-mapping-table">
              <thead><tr><th>#</th><th>相机 IP</th><th>SDK 标定文件</th><th>期望 SN</th><th>回滚文件（可选）</th></tr></thead>
              <tbody>
                {calibrationMappings.map((mapping, index) => (
                  <tr key={mapping.ip || index}>
                    <td>{index + 1}</td>
                    <td><input aria-label={`整组标定相机 ${index + 1} IP`} value={mapping.ip} onChange={(event) => updateCalibrationMapping(index, { ip: event.target.value })} /></td>
                    <td>
                      <div className="capture-path-picker">
                        <input aria-label={`整组标定相机 ${index + 1} SDK 文件`} value={mapping.path} onChange={(event) => updateCalibrationMapping(index, { path: event.target.value })} />
                        <button type="button" aria-label={`选择整组标定相机 ${index + 1} SDK 文件`} onClick={() => void selectLocalFile(`选择相机 ${index + 1} SDK 标定文件`, ['xml'], (path) => updateCalibrationMapping(index, { path }))}><FolderOpen size={14} /></button>
                      </div>
                    </td>
                    <td><input aria-label={`整组标定相机 ${index + 1} SN`} value={mapping.expectedSn || ''} onChange={(event) => updateCalibrationMapping(index, { expectedSn: event.target.value })} /></td>
                    <td>
                      <div className="capture-path-picker">
                        <input aria-label={`整组标定相机 ${index + 1} 回滚文件`} value={mapping.rollbackPath || ''} onChange={(event) => updateCalibrationMapping(index, { rollbackPath: event.target.value })} />
                        <button type="button" aria-label={`选择整组标定相机 ${index + 1} 回滚文件`} onClick={() => void selectLocalFile(`选择相机 ${index + 1} 回滚标定文件`, ['xml'], (path) => updateCalibrationMapping(index, { rollbackPath: path }))}><FolderOpen size={14} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="capture-operation-checks">
            <label><input aria-label="整组标定允许外部绝对路径" type="checkbox" checked={calibrationSetAllowExternal} onChange={(event) => { setCalibrationSetAllowExternal(event.target.checked); invalidateCalibrationSetApproval(); }} />允许 storage/config 之外的绝对路径（默认关闭）</label>
            <label><input aria-label="整组标定更新 active pointer" type="checkbox" checked={calibrationSetPersistActive} onChange={(event) => { setCalibrationSetPersistActive(event.target.checked); invalidateCalibrationSetApproval(); }} />成功后更新 active pointer（默认关闭）</label>
            <span>标定原子事务不保存 .nccfg；需要时请在参数维护区另行保存，避免把文件副作用伪装成可回滚事务。</span>
            <label><input aria-label="整组标定持久化到设备" type="checkbox" checked={calibrationSetSaveToDevice} onChange={(event) => { setCalibrationSetSaveToDevice(event.target.checked); invalidateCalibrationSetApproval(); }} />持久化到设备（默认关闭）</label>
          </div>
          <div className="capture-operation-actions">
            <button type="button" disabled={busy !== null || !calibrationMappingsComplete || !calibrationSetProfile.trim()} onClick={() => void handleCalibrationSetPreflight()}>
              <FileSearch size={14} />dryRun 预检
            </button>
            <button type="button" disabled={busy !== null || !calibrationMappingsComplete || !calibrationSetProfile.trim()} onClick={() => void handleCalibrationSetPreflight(true)}>
              <RefreshCw size={14} />新建标定操作 / 重新预检
            </button>
            <span className={calibrationSetPreflightPassed ? 'capture-preflight-pass' : ''}>{calibrationSetPreflightPassed ? '当前配置已通过预检' : '真实应用前必须预检'}</span>
          </div>
          {applyOperationId ? (
            <div className="capture-calibration-operation-reconcile" aria-label="标定应用操作对账">
              <dl>
                <div><dt>operationId</dt><dd>{applyOperationId}</dd></div>
                <div><dt>status</dt><dd>{applyReconciliation?.status || (calibrationSetPreflightPassed ? 'ready' : 'pending')}</dd></div>
                <div><dt>needsReconciliation</dt><dd>{typeof applyReconciliation?.needsReconciliation === 'boolean' ? (applyReconciliation.needsReconciliation ? '是' : '否') : '待查询'}</dd></div>
                <div><dt>parentOperationId</dt><dd>{applyReconciliation?.parentOperationId || '-'}</dd></div>
                <div><dt>reconciliationOutcome</dt><dd>{applyReconciliation?.reconciliationOutcome || '-'}</dd></div>
                <div><dt>reconciliationId</dt><dd>{applyReconciliation?.reconciliationId || '-'}</dd></div>
                <div><dt>resolvedBy</dt><dd>{applyReconciliation?.resolvedBy || '-'}</dd></div>
                <div><dt>resolvedAt</dt><dd>{applyReconciliation?.resolvedAt || '-'}</dd></div>
                <div><dt>rowVersion</dt><dd>{applyReconciliation?.rowVersion ?? '-'}</dd></div>
              </dl>
              <button type="button" disabled={busy !== null} onClick={() => void handleCalibrationOperationReconcile('apply')}>
                <RefreshCw size={14} />刷新应用对账
              </button>
            </div>
          ) : null}
          {reconciliationFenceActive ? (
            <div className="capture-calibration-reconciliation-fence" role="alert">
              <strong>HTTP 423 标定协调围栏已生效</strong>
              <span>
                新标定和设备参数写入已锁定；不能手工标记成功或失败。
                {recoveryParentOperationId
                  ? ` 当前只允许使用已有 rollback token，为待协调 apply ${recoveryParentOperationId} 发起父操作绑定的受控恢复回滚。`
                  : ' 请先刷新待协调操作记录，确认父 apply operationId 后再恢复。'}
              </span>
            </div>
          ) : null}
          <label className="capture-danger-confirm phrase">
            <span>真实应用输入 <code>{CAMERA_CALIBRATION_SET_CONFIRMATION}</code></span>
            <input aria-label="整组标定应用确认短语" value={calibrationSetConfirmation} onChange={(event) => setCalibrationSetConfirmation(event.target.value)} autoComplete="off" />
          </label>
          {calibrationSetSaveToDevice ? (
            <label className="capture-danger-confirm phrase">
              <span>设备持久化还需输入 <code>{CAMERA_DEVICE_PERSIST_CONFIRMATION}</code></span>
              <input aria-label="整组标定设备持久化确认短语" value={calibrationSetDeviceConfirmation} onChange={(event) => setCalibrationSetDeviceConfirmation(event.target.value)} autoComplete="off" />
            </label>
          ) : null}
          <button type="button" className="danger" disabled={busy !== null || reconciliationFenceActive || !applyOperationId || !calibrationSetPreflightPassed || !calibrationSetConfirmed || !calibrationSetDeviceConfirmed} onClick={() => void handleCalibrationSetApply()}>
            原子应用整组标定
          </button>
          <div className="capture-calibration-rollback">
            <label><span>回滚 token</span><input aria-label="整组标定回滚 token" value={rollbackToken} onChange={(event) => { setRollbackToken(event.target.value); setRollbackApplyOperationId(''); setRollbackConfirmation(''); setRollbackOperationId(''); setRollbackOperationDetail(null); }} /></label>
            <label><span>原 apply operationId</span><input aria-label="整组标定回滚原 apply operationId" value={rollbackExpectedApplyOperationId} onChange={(event) => { setRollbackApplyOperationId(event.target.value); setRollbackConfirmation(''); setRollbackOperationId(''); setRollbackOperationDetail(null); }} readOnly={Boolean(fencedParentOperation?.expectedApplyOperationId)} /></label>
            <label className="capture-danger-confirm phrase">
              <span>回滚输入 <code>{CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION}</code></span>
              <input aria-label="整组标定回滚确认短语" value={rollbackConfirmation} onChange={(event) => setRollbackConfirmation(event.target.value)} autoComplete="off" />
            </label>
            <button type="button" className="danger" disabled={busy !== null || rollbackParentUnconfirmed || !rollbackConfirmed} onClick={() => void handleCalibrationSetRollback()}>
              {recoveryParentOperationId ? '受控恢复并协调整组标定' : '回滚整组标定'}
            </button>
            {rollbackParentUnconfirmed ? <span>应用结果未知；请先刷新应用对账，禁止无父操作绑定的恢复回滚。</span> : null}
          </div>
          {rollbackOperationId ? (
            <div className="capture-calibration-operation-reconcile" aria-label="标定回滚操作对账">
              <dl>
                <div><dt>operationId</dt><dd>{rollbackOperationId}</dd></div>
                <div><dt>status</dt><dd>{rollbackReconciliation?.status || 'pending'}</dd></div>
                <div><dt>needsReconciliation</dt><dd>{typeof rollbackReconciliation?.needsReconciliation === 'boolean' ? (rollbackReconciliation.needsReconciliation ? '是' : '否') : '待查询'}</dd></div>
                <div><dt>parentOperationId</dt><dd>{rollbackReconciliation?.parentOperationId || '-'}</dd></div>
                <div><dt>reconciliationOutcome</dt><dd>{rollbackReconciliation?.reconciliationOutcome || '-'}</dd></div>
                <div><dt>reconciliationId</dt><dd>{rollbackReconciliation?.reconciliationId || '-'}</dd></div>
                <div><dt>resolvedBy</dt><dd>{rollbackReconciliation?.resolvedBy || '-'}</dd></div>
                <div><dt>resolvedAt</dt><dd>{rollbackReconciliation?.resolvedAt || '-'}</dd></div>
                <div><dt>rowVersion</dt><dd>{rollbackReconciliation?.rowVersion ?? '-'}</dd></div>
              </dl>
              <button type="button" disabled={busy !== null} onClick={() => void handleCalibrationOperationReconcile('rollback')}>
                <RefreshCw size={14} />刷新回滚对账
              </button>
            </div>
          ) : null}
          {calibrationSetResult ? (
            <div className="capture-calibration-set-result" role="status">
              code {calibrationSetResult.code} · 应用 {calibrationSetResult.applied ?? 0} · 失败 {calibrationSetResult.failed ?? 0}
              {calibrationSetResult.rollbackToken ? ` · rollback ${calibrationSetResult.rollbackToken}` : ''}
            </div>
          ) : null}
          {calibrationSetResult?.results?.length ? (
            <div className="capture-calibration-result-table-wrap">
              <table className="capture-calibration-result-table">
                <thead>
                  <tr><th>相机</th><th>文件 / 类型</th><th>preflight</th><th>apply</th><th>persist</th><th>rollback</th><th>状态</th><th>消息</th></tr>
                </thead>
                <tbody>
                  {calibrationSetResult.results.map((item, index) => (
                    <tr key={`${item.ip || 'item'}-${index}`}>
                      <td>{item.ip || '-'}</td>
                      <td title={item.calibrationPath || item.path || item.file || ''}>
                        {item.calibrationPath || item.path || item.file || '-'}<br />{item.artifactKind || '-'}
                      </td>
                      <td>{item.preflightCode ?? item.code}</td>
                      <td>{item.applyCode ?? '-'}</td>
                      <td>{item.persistCode ?? '-'}</td>
                      <td>{item.rollbackCode ?? '-'}{item.rollbackMode ? ` · ${item.rollbackMode}` : ''}</td>
                      <td>{[
                        item.attempted ? 'attempted' : '',
                        item.applied ? 'applied' : '',
                        item.rolledBack ? 'rolledBack' : '',
                        item.skipped ? 'skipped' : '',
                      ].filter(Boolean).join(' / ') || '-'}</td>
                      <td>{item.message || item.operatorHint || item.errorName || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <section className="capture-line-preset-diagnostic">
          <header><AlertTriangle size={16} /><strong>危险线扫预设</strong></header>
          <p>该入口由 Rust 的 <code>admin.config</code> 代理校验。默认不自动连接、不写相机设备；生产 Profile 不会自动调用它。</p>
          <div className="capture-line-preset-fields">
            <label><span>触发行数</span><input aria-label="线扫预设触发行数" type="number" min={1} value={presetLines} onChange={(event) => { setPresetLines(Number(event.target.value)); invalidateLinePresetApproval(); }} /></label>
            <label><span>触发频率 Hz</span><input aria-label="线扫预设触发频率" type="number" min={0.1} step="0.1" value={presetFrequency} onChange={(event) => { setPresetFrequency(Number(event.target.value)); invalidateLinePresetApproval(); }} /></label>
            <label><span>激光功率</span><input aria-label="线扫预设激光功率" type="number" min={0} max={100} value={presetLaserPower} onChange={(event) => { setPresetLaserPower(Number(event.target.value)); invalidateLinePresetApproval(); }} /></label>
            <label><span>激光线选择</span><input aria-label="线扫预设激光线" type="number" min={0} value={presetLaserLine} onChange={(event) => { setPresetLaserLine(Number(event.target.value)); invalidateLinePresetApproval(); }} /></label>
            <label><span>控制模式</span><input aria-label="线扫预设控制模式" type="number" min={0} value={presetControlMode} onChange={(event) => { setPresetControlMode(Number(event.target.value)); invalidateLinePresetApproval(); }} /></label>
          </div>
          <div className="capture-operation-checks">
            <label><input aria-label="线扫预设执行前自动连接" type="checkbox" checked={presetConnectFirst} onChange={(event) => { setPresetConnectFirst(event.target.checked); invalidateLinePresetApproval(); }} />执行前自动连接（默认关闭）</label>
            <label><input aria-label="线扫预设持久化到设备" type="checkbox" checked={presetSaveToDevice} onChange={(event) => { setPresetSaveToDevice(event.target.checked); invalidateLinePresetApproval(); }} />持久化到相机设备（默认关闭）</label>
          </div>
          <label className="capture-danger-confirm phrase">
            <span>输入 <code>{LINE_PRESET_CONFIRMATION}</code></span>
            <input aria-label="线扫预设确认短语" value={presetConfirmation} onChange={(event) => setPresetConfirmation(event.target.value)} autoComplete="off" />
          </label>
          {presetSaveToDevice ? (
            <label className="capture-danger-confirm phrase">
              <span>设备持久化还需输入 <code>{LINE_PRESET_DEVICE_CONFIRMATION}</code></span>
              <input aria-label="线扫预设设备持久化确认短语" value={presetDeviceConfirmation} onChange={(event) => setPresetDeviceConfirmation(event.target.value)} autoComplete="off" />
            </label>
          ) : null}
          <button type="button" className="danger" disabled={busy !== null || !presetConfirmed || !presetDeviceConfirmed} onClick={() => void handleLinePreset()}>
            应用线扫预设
          </button>
        </section>
      </div>
      {message ? <div className="capture-operation-message" role="status">{message}</div> : null}
    </section>
  );
}
