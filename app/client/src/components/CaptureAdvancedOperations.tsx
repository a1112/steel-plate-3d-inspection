import {
  AlertTriangle,
  CheckCircle2,
  FileJson,
  FlaskConical,
  FolderInput,
  FolderOpen,
  HardDrive,
  Play,
  RefreshCw,
  Save,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyCaptureCameraStorageRoots,
  chooseCaptureLocalDirectory,
  chooseCaptureLocalFile,
  importCaptureProfileFromProviderPath,
  readCaptureProfile,
  readCaptureProfiles,
  runCaptureContinuousTest,
  saveCaptureProfile,
  type CaptureCameraStorageRoot,
  type CaptureCameraStatus,
  type CaptureContinuousTestSummary,
  type CaptureProfileCamera,
  type CaptureProfileDocument,
  type CaptureProfilesStatus,
  type CaptureStorageStatus,
} from '../lib/capture-api';

type AdvancedOperation =
  | 'read-profile'
  | 'save-profile'
  | 'import-profile'
  | 'camera-roots'
  | 'continuous-test';

type Message = {
  tone: 'success' | 'warning' | 'error';
  text: string;
};

type ContinuousDraft = {
  rounds: number;
  lines: number;
  width: number;
  timeoutMs: number;
  intervalMs: number;
  retries: number;
  dataMode: number;
  outputDir: string;
  connectFirst: boolean;
  stopStreams: boolean;
};

type CaptureAdvancedOperationsProps = {
  cameraIps: string[];
  expectedCameraCount?: number;
  profiles: CaptureProfilesStatus | null;
  storage: CaptureStorageStatus | null;
  cameraStatuses?: CaptureCameraStatus[];
  onProfilesChange: (profiles: CaptureProfilesStatus) => void;
  onStorageChange: (storage: CaptureStorageStatus) => void;
};

function normalizeIps(cameraIps: string[]) {
  return Array.from(new Set(cameraIps.map((ip) => ip.trim()).filter(Boolean)));
}

function joinProviderPath(root: string, leaf: string) {
  const normalized = root.trim().replace(/[\\/]+$/, '');
  return normalized ? `${normalized}/${leaf}` : leaf;
}

function initialCameraRoots(
  cameraIps: string[],
  storage: CaptureStorageStatus | null,
): CaptureCameraStorageRoot[] {
  const providerRoots = new Map(
    (storage?.cameraRoots ?? []).map((item) => [item.ip, item.root]),
  );
  return normalizeIps(cameraIps).map((ip, index) => ({
    ip,
    root:
      providerRoots.get(ip) ||
      joinProviderPath(storage?.root || 'H:/', `camera${index + 1}`),
  }));
}

function createStructuredProfileCamera(
  ip: string,
  index: number,
  storageRoot: string,
): CaptureProfileCamera {
  return {
    ip,
    name: `camera${index + 1}`,
    enabled: true,
    model: '',
    sn: '',
    paramSource: 'device',
    useDeviceParams: true,
    paramFile: '',
    cameraIndex: index + 1,
    storageRoot: joinProviderPath(storageRoot || 'H:/', `camera${index + 1}`),
    params: {
      exposureTime: 1000,
      gainK: 1,
      timeTriggerFreq: 300,
    },
  };
}

export function profileCamerasFromDocument(
  document: CaptureProfileDocument,
  fallbackIps: string[],
  storageRoot: string,
): CaptureProfileCamera[] {
  const cameras = Array.isArray(document.cameras) ? document.cameras : [];
  if (cameras.length === 0) {
    return normalizeIps(fallbackIps).map((ip, index) =>
      createStructuredProfileCamera(ip, index, storageRoot));
  }
  return cameras.map((camera, index) => {
    const base = createStructuredProfileCamera(camera.ip || '', index, storageRoot);
    const paramSource = camera.paramSource === 'file' ? 'file' : 'device';
    return {
      ...base,
      ...camera,
      ip: String(camera.ip || ''),
      enabled: camera.enabled !== false,
      paramSource,
      useDeviceParams: paramSource !== 'file',
      cameraIndex: Number(camera.cameraIndex) || index + 1,
      params: {
        ...base.params,
        ...(camera.params ?? {}),
      },
    };
  });
}

export function createSafeCaptureProfileDraft(
  name: string,
  cameraIps: string[],
  storageRoot: string,
  cameraRoots: CaptureCameraStorageRoot[],
  expectedCameraCount = cameraIps.length,
): CaptureProfileDocument {
  const normalizedName = name.trim() || 'new-capture-profile';
  const rootByIp = new Map(cameraRoots.map((item) => [item.ip, item.root]));
  const ips = normalizeIps(cameraIps);
  return {
    schema: 'steel.capture.profile.v1',
    name: normalizedName,
    updatedAt: new Date().toISOString(),
    driverMode: 'lvm',
    storageRoot: storageRoot || 'H:/',
    cameraParamDir: `config/camera-params/${normalizedName}`,
    startupMode: 'manual',
    autoConnect: false,
    expectedCameras: ips.length || expectedCameraCount,
    devType: -1,
    changeStorage: false,
    applySoftTrigger: false,
    loadCameraParams: false,
    saveToDevice: false,
    lines: 1000,
    width: 0,
    timeoutMs: 8000,
    dataMode: 3,
    controlMode: 0,
    triggerInputType: 4,
    divRatio: 4,
    timeTriggerFreq: 300,
    cameraStorageRoots: ips.map((ip, index) => ({
      ip,
      root:
        rootByIp.get(ip) ||
        joinProviderPath(storageRoot || 'H:/', `camera${index + 1}`),
    })),
    cameras: ips.map((ip, index) => ({
      ...createStructuredProfileCamera(ip, index, storageRoot),
      storageRoot:
        rootByIp.get(ip) ||
        joinProviderPath(storageRoot || 'H:/', `camera${index + 1}`),
    })),
  };
}

function parseProfileJson(text: string, name: string): CaptureProfileDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Profile JSON 不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Profile JSON 必须是对象');
  }
  return {
    ...(parsed as Record<string, unknown>),
    name: name.trim(),
    saveToDevice: false,
  } as CaptureProfileDocument;
}

function summaryTone(summary: CaptureContinuousTestSummary) {
  return summary.code === 0 && summary.failures === 0 && summary.expectedMet
    ? 'success'
    : 'warning';
}

export function CaptureAdvancedOperations({
  cameraIps,
  expectedCameraCount = cameraIps.length,
  profiles,
  storage,
  cameraStatuses = [],
  onProfilesChange,
  onStorageChange,
}: CaptureAdvancedOperationsProps) {
  const normalizedIps = useMemo(() => normalizeIps(cameraIps), [cameraIps]);
  const [selectedProfile, setSelectedProfile] = useState('');
  const [profileName, setProfileName] = useState('new-capture-profile');
  const [profileJson, setProfileJson] = useState('');
  const [profileCameras, setProfileCameras] = useState<CaptureProfileCamera[]>([]);
  const [makeProfileActive, setMakeProfileActive] = useState(false);
  const [confirmProfileSave, setConfirmProfileSave] = useState(false);
  const [providerImportPath, setProviderImportPath] = useState('');
  const [providerImportName, setProviderImportName] = useState('');
  const [overwriteImport, setOverwriteImport] = useState(false);
  const [makeImportActive, setMakeImportActive] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const [cameraRoots, setCameraRoots] = useState<CaptureCameraStorageRoot[]>([]);
  const [confirmCameraRoots, setConfirmCameraRoots] = useState(false);
  const [continuous, setContinuous] = useState<ContinuousDraft>({
    rounds: 3,
    lines: 1000,
    width: 0,
    timeoutMs: 8000,
    intervalMs: 500,
    retries: 2,
    dataMode: 3,
    outputDir: 'continuous-test/tauri-operations',
    connectFirst: false,
    stopStreams: true,
  });
  const [confirmContinuous, setConfirmContinuous] = useState(false);
  const [continuousScope, setContinuousScope] = useState<'all' | 'single'>('all');
  const [continuousSingleIp, setContinuousSingleIp] = useState(normalizedIps[0] || '');
  const [continuousSummary, setContinuousSummary] =
    useState<CaptureContinuousTestSummary | null>(null);
  const [busy, setBusy] = useState<AdvancedOperation | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const selectLocalFile = async (
    title: string,
    extensions: string[],
    onSelected: (path: string) => void,
  ) => {
    try {
      const selected = await chooseCaptureLocalFile(title, extensions);
      if (!selected) {
        setMessage({ tone: 'warning', text: '浏览器模式不提供本地文件选择，请手工填写采集主机路径' });
      } else if (selected.selected && selected.path) {
        onSelected(selected.path);
      }
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '本地文件选择失败' });
    }
  };

  const selectLocalDirectory = async (
    title: string,
    onSelected: (path: string) => void,
  ) => {
    try {
      const selected = await chooseCaptureLocalDirectory(title);
      if (!selected) {
        setMessage({ tone: 'warning', text: '浏览器模式不提供本地目录选择，请手工填写采集主机路径' });
      } else if (selected.selected && selected.path) {
        onSelected(selected.path);
      }
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '本地目录选择失败' });
    }
  };

  const loadProfile = useCallback(async (name: string) => {
    const normalizedName = name.trim();
    if (!normalizedName) {
      return;
    }
    setBusy('read-profile');
    setMessage(null);
    try {
      const document = await readCaptureProfile(normalizedName);
      setSelectedProfile(normalizedName);
      setProfileName(document.name || normalizedName);
      setProfileJson(JSON.stringify(document, null, 2));
      setProfileCameras(profileCamerasFromDocument(document, normalizedIps, storage?.root || 'H:/'));
      setMessage({ tone: 'success', text: `已从采集服务读取 Profile：${normalizedName}` });
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Profile 读取失败',
      });
    } finally {
      setBusy(null);
    }
  }, [normalizedIps, storage?.root]);

  useEffect(() => {
    const active = profiles?.activeProfile || profiles?.profiles?.[0] || '';
    if (!active) {
      return;
    }
    setSelectedProfile(active);
    void loadProfile(active);
  }, [loadProfile, profiles]);

  useEffect(() => {
    setCameraRoots(initialCameraRoots(normalizedIps, storage));
  }, [normalizedIps, storage]);

  useEffect(() => {
    if (!normalizedIps.includes(continuousSingleIp)) {
      setContinuousSingleIp(normalizedIps[0] || '');
    }
  }, [continuousSingleIp, normalizedIps]);

  const refreshProfiles = async (preferredName?: string) => {
    const nextProfiles = await readCaptureProfiles();
    onProfilesChange(nextProfiles);
    const nextName = preferredName || nextProfiles.activeProfile || nextProfiles.profiles?.[0];
    if (nextName) {
      setSelectedProfile(nextName);
    }
  };

  const handleNewProfile = () => {
    const draft = createSafeCaptureProfileDraft(
      profileName,
      normalizedIps,
      storage?.root || 'H:/',
      cameraRoots,
      expectedCameraCount,
    );
    setProfileName(draft.name);
    setProfileJson(JSON.stringify(draft, null, 2));
    setProfileCameras(profileCamerasFromDocument(draft, normalizedIps, storage?.root || 'H:/'));
    setConfirmProfileSave(false);
    setMessage({
      tone: 'warning',
      text: '已生成安全草稿；尚未写入。请审阅 JSON 并确认后保存。',
    });
  };

  const writeProfileCameras = (nextCameras: CaptureProfileCamera[]) => {
    try {
      const parsed = JSON.parse(profileJson || '{}') as CaptureProfileDocument;
      const normalized = nextCameras.map((camera, index) => ({
        ...camera,
        cameraIndex: index + 1,
        useDeviceParams: camera.paramSource !== 'file',
      }));
      setProfileCameras(normalized);
      setProfileJson(JSON.stringify({
        ...parsed,
        name: profileName.trim() || parsed.name || 'new-capture-profile',
        expectedCameras: normalized.filter((camera) => camera.enabled !== false && camera.ip.trim()).length,
        cameraStorageRoots: normalized
          .filter((camera) => camera.ip.trim() && camera.storageRoot?.trim())
          .map((camera) => ({ ip: camera.ip.trim(), root: camera.storageRoot?.trim() || '' })),
        cameras: normalized,
        saveToDevice: false,
      }, null, 2));
    } catch {
      setMessage({ tone: 'error', text: 'Profile JSON 无效，无法写入结构化相机配置' });
    }
  };

  const syncProfileCamerasFromJson = () => {
    try {
      const parsed = JSON.parse(profileJson || '{}') as CaptureProfileDocument;
      const next = profileCamerasFromDocument(parsed, normalizedIps, storage?.root || 'H:/');
      setProfileCameras(next);
      setMessage({ tone: 'success', text: `已从 Profile JSON 读取 ${next.length} 路相机配置` });
    } catch {
      setMessage({ tone: 'error', text: 'Profile JSON 不是合法 JSON，不能同步相机编辑器' });
    }
  };

  const syncCurrentCameraIps = () => {
    const existing = new Map(profileCameras.map((camera) => [camera.ip.trim(), camera]));
    const readbackByIp = new Map(cameraStatuses.map((status) => [status.ip, status]));
    const next = normalizedIps.map((ip, index) => ({
      ...createStructuredProfileCamera(ip, index, storage?.root || 'H:/'),
      ...(existing.get(ip) ?? {}),
      ip,
      cameraIndex: index + 1,
      model: readbackByIp.get(ip)?.model || existing.get(ip)?.model || '',
      sn: readbackByIp.get(ip)?.sn || existing.get(ip)?.sn || '',
      params: {
        ...(existing.get(ip)?.params ?? {}),
        exposureTime: readbackByIp.get(ip)?.captureConfig?.exposureTime
          ?? existing.get(ip)?.params?.exposureTime
          ?? 1000,
        gainK: readbackByIp.get(ip)?.captureConfig?.gainK
          ?? existing.get(ip)?.params?.gainK
          ?? 1,
        timeTriggerFreq: readbackByIp.get(ip)?.captureConfig?.timeTriggerFreq
          ?? existing.get(ip)?.params?.timeTriggerFreq
          ?? 300,
      },
    }));
    writeProfileCameras(next);
    setMessage({ tone: 'success', text: `已同步当前 ${next.length} 路相机 IP、型号、SN 与 SDK 参数读回到 Profile JSON` });
  };

  const updateProfileCamera = (index: number, patch: Partial<CaptureProfileCamera>) => {
    const next = profileCameras.map((camera, cameraIndex) =>
      cameraIndex === index ? { ...camera, ...patch } : camera);
    writeProfileCameras(next);
  };

  const updateProfileCameraParam = (
    index: number,
    key: 'exposureTime' | 'gainK' | 'timeTriggerFreq',
    value: number,
  ) => {
    const camera = profileCameras[index];
    if (!camera) {
      return;
    }
    updateProfileCamera(index, { params: { ...(camera.params ?? {}), [key]: value } });
  };

  const handleSaveProfile = async () => {
    if (!confirmProfileSave) {
      setMessage({ tone: 'warning', text: '请先确认写入 Profile 文件' });
      return;
    }
    const name = profileName.trim();
    if (!name) {
      setMessage({ tone: 'error', text: '配置名称不能为空' });
      return;
    }
    let document: CaptureProfileDocument;
    try {
      document = parseProfileJson(profileJson, name);
      const enabledIps = (document.cameras ?? [])
        .filter((camera) => camera.enabled !== false)
        .map((camera) => camera.ip.trim());
      if (enabledIps.some((ip) => !ip)) {
        throw new Error('启用的 Profile 相机必须填写 IP');
      }
      if (new Set(enabledIps).size !== enabledIps.length) {
        throw new Error('启用的 Profile 相机 IP 不能重复');
      }
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Profile JSON 无效' });
      return;
    }
    setBusy('save-profile');
    setMessage(null);
    try {
      const result = await saveCaptureProfile({
        name,
        profile: document,
        makeActive: makeProfileActive,
      });
      if (result.code !== 0) {
        setMessage({
          tone: 'warning',
          text: `Profile 保存未完成（code ${result.code}）：${result.error || result.message || 'provider 拒绝请求'}`,
        });
        return;
      }
      setConfirmProfileSave(false);
      await refreshProfiles(name);
      setMessage({
        tone: result.code === 0 ? 'success' : 'warning',
        text: `Profile ${name} 已保存${result.path ? `：${result.path}` : ''}`,
      });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Profile 保存失败' });
    } finally {
      setBusy(null);
    }
  };

  const handleImportProfile = async () => {
    if (!confirmImport) {
      setMessage({ tone: 'warning', text: '请先确认由采集主机读取本地路径' });
      return;
    }
    setBusy('import-profile');
    setMessage(null);
    try {
      const result = await importCaptureProfileFromProviderPath({
        path: providerImportPath,
        name: providerImportName,
        overwrite: overwriteImport,
        makeActive: makeImportActive,
      });
      if (result.code !== 0 || !result.name) {
        setMessage({
          tone: 'warning',
          text: `Profile 导入未完成（code ${result.code}）：${result.error || result.message || 'provider 拒绝请求'}`,
        });
        return;
      }
      setConfirmImport(false);
      await refreshProfiles(result.name);
      setMessage({
        tone: result.code === 0 ? 'success' : 'warning',
        text: `采集主机 Profile 已导入：${result.name}`,
      });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Profile 导入失败' });
    } finally {
      setBusy(null);
    }
  };

  const updateCameraRoot = (ip: string, root: string) => {
    setCameraRoots((current) =>
      current.map((item) => (item.ip === ip ? { ...item, root } : item)),
    );
  };

  const handleApplyCameraRoots = async () => {
    if (!confirmCameraRoots) {
      setMessage({ tone: 'warning', text: '请先确认替换逐相机落盘目录映射' });
      return;
    }
    setBusy('camera-roots');
    setMessage(null);
    try {
      const result = await applyCaptureCameraStorageRoots({
        replace: true,
        cameraRoots,
      });
      if (result.code !== 0) {
        setMessage({
          tone: 'warning',
          text: `相机落盘目录未应用（code ${result.code}）：${result.error || result.message || 'provider 拒绝请求'}`,
        });
        return;
      }
      onStorageChange(result);
      setConfirmCameraRoots(false);
      setMessage({
        tone: result.code === 0 && result.writable ? 'success' : 'warning',
        text: `已应用 ${cameraRoots.length} 路相机落盘目录`,
      });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '相机落盘目录应用失败' });
    } finally {
      setBusy(null);
    }
  };

  const handleContinuousTest = async () => {
    if (!confirmContinuous) {
      setMessage({ tone: 'warning', text: '请先确认执行并行连续采集测试' });
      return;
    }
    const numericParameters = [
      continuous.rounds,
      continuous.lines,
      continuous.width,
      continuous.timeoutMs,
      continuous.intervalMs,
      continuous.retries,
      continuous.dataMode,
    ];
    if (
      numericParameters.some((value) => !Number.isFinite(value) || !Number.isInteger(value)) ||
      continuous.rounds < 1 ||
      continuous.rounds > 10000 ||
      continuous.lines < 1 ||
      continuous.width < 0 ||
      continuous.timeoutMs < 1000 ||
      continuous.timeoutMs > 600000 ||
      continuous.intervalMs < 0 ||
      continuous.intervalMs > 600000 ||
      continuous.retries < 0 ||
      continuous.retries > 10 ||
      ![1, 2, 3].includes(continuous.dataMode)
    ) {
      setMessage({ tone: 'error', text: '连续测试参数超出允许范围，请检查轮数、行数、超时、间隔和重试次数' });
      return;
    }
    setBusy('continuous-test');
    setMessage(null);
    setContinuousSummary(null);
    try {
      const testIps = continuousScope === 'single'
        ? [continuousSingleIp].filter(Boolean)
        : normalizedIps;
      const result = await runCaptureContinuousTest({
        expectedCameras: testIps.length,
        rounds: continuous.rounds,
        lines: continuous.lines,
        width: continuous.width,
        timeoutMs: continuous.timeoutMs,
        intervalMs: continuous.intervalMs,
        retries: continuous.retries,
        controlMode: 0,
        dataMode: continuous.dataMode,
        outputDir: continuous.outputDir.trim(),
        connectFirst: continuous.connectFirst,
        stopStreams: continuous.stopStreams,
        ips: testIps,
        discardBlackFrames: true,
      });
      if (!Array.isArray(result.results)) {
        setMessage({
          tone: 'warning',
          text: `连续测试未启动（code ${result.code}）：${result.error || result.message || result.errorName || 'provider 拒绝请求'}`,
        });
        return;
      }
      setContinuousSummary(result);
      setConfirmContinuous(false);
      setMessage({
        tone: summaryTone(result),
        text: `连续测试完成：成功 ${result.successes}/${result.attempts}，完整帧 ${result.completeFrames}`,
      });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '连续采集测试失败' });
    } finally {
      setBusy(null);
    }
  };

  const profileNames = profiles?.profiles?.length ? profiles.profiles : [];
  const selectedEntry = profiles?.profileEntries?.find(
    (entry) => entry.name === selectedProfile,
  );

  return (
    <div className="capture-advanced-operations">
      <div className="capture-calibration-safety" role="note">
        <AlertTriangle size={16} />
        <span>
          自动标定页仍只更新阵列重建 active pointer；逐相机 SDK 标定整组预检、原子应用和回滚已迁至下方受控诊断/维护面板，
          默认 <code>saveToDevice=false</code>。
        </span>
      </div>

      <div className="capture-advanced-grid">
        <section className="capture-profile-editor-operation">
          <header>
            <FileJson size={17} />
            <div>
              <strong>Profile 读取、新建与保存</strong>
              <span title={selectedEntry?.path}>{selectedEntry?.path || profiles?.profileRoot || '等待采集服务路径'}</span>
            </div>
          </header>
          <div className="capture-profile-toolbar">
            <label>
              <span>已有 Profile</span>
              <select value={selectedProfile} onChange={(event) => setSelectedProfile(event.target.value)}>
                {profileNames.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <button type="button" disabled={busy !== null || !selectedProfile} onClick={() => void loadProfile(selectedProfile)}>
              <RefreshCw size={14} className={busy === 'read-profile' ? 'spin' : ''} />读取选中 Profile
            </button>
            <label>
              <span>草稿/保存名称</span>
              <input value={profileName} onChange={(event) => setProfileName(event.target.value)} />
            </label>
            <button type="button" disabled={busy !== null} onClick={handleNewProfile}>
              <FileJson size={14} />新建安全草稿
            </button>
          </div>
          <label className="capture-profile-json-editor">
            <span>Profile JSON</span>
            <textarea value={profileJson} onChange={(event) => setProfileJson(event.target.value)} spellCheck={false} />
          </label>
          <section className="capture-profile-camera-editor" aria-label={`Profile ${expectedCameraCount} 相机结构化编辑器`}>
            <header>
              <div>
                <strong>{expectedCameraCount} 相机结构化配置</strong>
                <span>字段变更立即同步到上方 Profile JSON；原始 JSON 手工修改后需重新读取。</span>
              </div>
              <div className="capture-operation-actions">
                <button type="button" onClick={syncProfileCamerasFromJson}>从 JSON 读取相机</button>
                <button type="button" onClick={syncCurrentCameraIps} disabled={normalizedIps.length === 0}>从当前相机 IP 同步</button>
                <button
                  type="button"
                  onClick={() => writeProfileCameras([
                    ...profileCameras,
                    createStructuredProfileCamera('', profileCameras.length, storage?.root || 'H:/'),
                  ])}
                >
                  添加相机
                </button>
              </div>
            </header>
            <div className="capture-profile-camera-table-wrap">
              <table className="capture-profile-camera-table">
                <thead>
                  <tr>
                    <th>#</th><th>启用</th><th>IP</th><th>型号</th><th>SN</th><th>参数来源</th><th>参数文件</th><th>落盘目录</th><th>曝光</th><th>增益</th><th>频率 Hz</th><th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {profileCameras.map((camera, index) => (
                    <tr key={index}>
                      <td>{index + 1}</td>
                      <td><input aria-label={`Profile 相机 ${index + 1} 启用`} type="checkbox" checked={camera.enabled !== false} onChange={(event) => updateProfileCamera(index, { enabled: event.target.checked })} /></td>
                      <td><input aria-label={`Profile 相机 ${index + 1} IP`} value={camera.ip} onChange={(event) => updateProfileCamera(index, { ip: event.target.value })} /></td>
                      <td><input aria-label={`Profile 相机 ${index + 1} 型号`} value={camera.model || ''} onChange={(event) => updateProfileCamera(index, { model: event.target.value })} /></td>
                      <td><input aria-label={`Profile 相机 ${index + 1} SN`} value={camera.sn || ''} onChange={(event) => updateProfileCamera(index, { sn: event.target.value })} /></td>
                      <td>
                        <select
                          aria-label={`Profile 相机 ${index + 1} 参数来源`}
                          value={camera.paramSource === 'file' ? 'file' : 'device'}
                          onChange={(event) => updateProfileCamera(index, {
                            paramSource: event.target.value,
                            useDeviceParams: event.target.value !== 'file',
                          })}
                        >
                          <option value="device">设备当前参数</option>
                          <option value="file">.nccfg 文件</option>
                        </select>
                      </td>
                      <td>
                        <div className="capture-path-picker">
                          <input aria-label={`Profile 相机 ${index + 1} 参数文件`} value={camera.paramFile || ''} disabled={camera.paramSource !== 'file'} onChange={(event) => updateProfileCamera(index, { paramFile: event.target.value })} />
                          <button type="button" aria-label={`选择 Profile 相机 ${index + 1} 参数文件`} disabled={camera.paramSource !== 'file'} onClick={() => void selectLocalFile('选择相机参数文件', ['nccfg', 'xml'], (path) => updateProfileCamera(index, { paramFile: path }))}><FolderOpen size={13} /></button>
                        </div>
                      </td>
                      <td>
                        <div className="capture-path-picker">
                          <input aria-label={`Profile 相机 ${index + 1} 存储目录`} value={camera.storageRoot || ''} onChange={(event) => updateProfileCamera(index, { storageRoot: event.target.value })} />
                          <button type="button" aria-label={`选择 Profile 相机 ${index + 1} 存储目录`} onClick={() => void selectLocalDirectory('选择相机落盘目录', (path) => updateProfileCamera(index, { storageRoot: path }))}><FolderOpen size={13} /></button>
                        </div>
                      </td>
                      <td><input aria-label={`Profile 相机 ${index + 1} 曝光`} type="number" min={1} value={Number(camera.params?.exposureTime ?? 1000)} onChange={(event) => updateProfileCameraParam(index, 'exposureTime', Number(event.target.value))} /></td>
                      <td><input aria-label={`Profile 相机 ${index + 1} 增益`} type="number" min={0} step="0.001" value={Number(camera.params?.gainK ?? 1)} onChange={(event) => updateProfileCameraParam(index, 'gainK', Number(event.target.value))} /></td>
                      <td><input aria-label={`Profile 相机 ${index + 1} 触发频率`} type="number" min={0.1} step="0.1" value={Number(camera.params?.timeTriggerFreq ?? 300)} onChange={(event) => updateProfileCameraParam(index, 'timeTriggerFreq', Number(event.target.value))} /></td>
                      <td>
                        <button type="button" aria-label={`删除 Profile 相机 ${index + 1}`} onClick={() => writeProfileCameras(profileCameras.filter((_, cameraIndex) => cameraIndex !== index))}>
                          删除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div className="capture-operation-checks">
            <label><input type="checkbox" checked={makeProfileActive} onChange={(event) => setMakeProfileActive(event.target.checked)} />保存后设为 active pointer</label>
          </div>
          <label className="capture-danger-confirm">
            <input type="checkbox" checked={confirmProfileSave} onChange={(event) => setConfirmProfileSave(event.target.checked)} />
            我已审阅 JSON，确认写入采集主机 Profile 文件（强制 saveToDevice=false）
          </label>
          <button type="button" className="primary" disabled={busy !== null || !confirmProfileSave || !profileName.trim()} onClick={() => void handleSaveProfile()}>
            <Save size={15} />保存 Profile
          </button>
        </section>

        <section className="capture-profile-import-operation">
          <header>
            <FolderInput size={17} />
            <div>
              <strong>从采集主机路径导入</strong>
              <span>由 Rust 代理让 provider 读取，不上传浏览器文件</span>
            </div>
          </header>
          <label>
            <span>provider 本地文件或目录路径</span>
            <div className="capture-path-picker">
              <input value={providerImportPath} onChange={(event) => setProviderImportPath(event.target.value)} placeholder="D:/capture-profiles/reviewed" />
              <button type="button" aria-label="选择 provider Profile JSON" onClick={() => void selectLocalFile('选择 Profile JSON', ['json'], setProviderImportPath)}><FileJson size={13} /></button>
              <button type="button" aria-label="选择 provider Profile 目录" onClick={() => void selectLocalDirectory('选择 Profile 目录', setProviderImportPath)}><FolderOpen size={13} /></button>
            </div>
          </label>
          <label>
            <span>导入名称（可选）</span>
            <input value={providerImportName} onChange={(event) => setProviderImportName(event.target.value)} placeholder="沿用 JSON 内名称" />
          </label>
          <div className="capture-operation-checks">
            <label><input type="checkbox" checked={overwriteImport} onChange={(event) => setOverwriteImport(event.target.checked)} />覆盖同名 Profile</label>
            <label><input type="checkbox" checked={makeImportActive} onChange={(event) => setMakeImportActive(event.target.checked)} />导入后设为 active pointer</label>
          </div>
          <label className="capture-danger-confirm">
            <input type="checkbox" checked={confirmImport} onChange={(event) => setConfirmImport(event.target.checked)} />
            我确认该路径位于采集服务主机，且已审阅覆盖/激活选项
          </label>
          <button type="button" disabled={busy !== null || !confirmImport || !providerImportPath.trim()} onClick={() => void handleImportProfile()}>
            <FolderInput size={15} />导入 provider Profile
          </button>
          <p>Tauri 桌面端可选择本机文件/目录；路径仍由 Rust 受控代理交给同机 provider 读取，不由浏览器上传。</p>
        </section>

        <section className="capture-camera-roots-operation">
          <header>
            <HardDrive size={17} />
            <div>
              <strong>逐相机落盘根目录</strong>
              <span>{cameraRoots.length} 路；一次性 replace 应用</span>
            </div>
          </header>
          <div className="capture-camera-root-list">
            {cameraRoots.map((item, index) => (
              <label key={item.ip}>
                <span>{index + 1}. {item.ip}</span>
                <div className="capture-path-picker">
                  <input
                    aria-label={`相机 ${item.ip} 落盘目录`}
                    value={item.root}
                    onChange={(event) => updateCameraRoot(item.ip, event.target.value)}
                  />
                  <button type="button" aria-label={`选择相机 ${item.ip} 落盘目录`} onClick={() => void selectLocalDirectory(`选择相机 ${item.ip} 落盘目录`, (path) => updateCameraRoot(item.ip, path))}><FolderOpen size={13} /></button>
                </div>
              </label>
            ))}
          </div>
          <label className="capture-danger-confirm">
            <input type="checkbox" checked={confirmCameraRoots} onChange={(event) => setConfirmCameraRoots(event.target.checked)} />
            我确认替换全部逐相机目录；后续生产帧将按新映射落盘
          </label>
          <button type="button" disabled={busy !== null || !confirmCameraRoots || cameraRoots.length === 0} onClick={() => void handleApplyCameraRoots()}>
            <HardDrive size={15} />应用逐相机目录
          </button>
        </section>

        <section className="capture-continuous-operation">
          <header>
            <FlaskConical size={17} />
            <div>
              <strong>并行连续采集测试</strong>
              <span>调用 /api/capture/continuous-test，返回结构化 summary/results</span>
            </div>
          </header>
          <div className="capture-continuous-form">
            <label>
              <span>测试范围</span>
              <select aria-label="连续测试范围" value={continuousScope} onChange={(event) => { setContinuousScope(event.target.value as 'all' | 'single'); setConfirmContinuous(false); }}>
                <option value="all">全部启用相机</option>
                <option value="single">单台相机</option>
              </select>
            </label>
            {continuousScope === 'single' ? (
              <label>
                <span>目标相机</span>
                <select aria-label="连续测试单台相机" value={continuousSingleIp} onChange={(event) => { setContinuousSingleIp(event.target.value); setConfirmContinuous(false); }}>
                  {normalizedIps.map((ip) => <option key={ip} value={ip}>{ip}</option>)}
                </select>
              </label>
            ) : null}
            <label><span>测试轮数</span><input type="number" min={1} max={10000} value={continuous.rounds} onChange={(event) => setContinuous({ ...continuous, rounds: Number(event.target.value) })} /></label>
            <label><span>每帧行数</span><input type="number" min={1} max={8192} value={continuous.lines} onChange={(event) => setContinuous({ ...continuous, lines: Number(event.target.value) })} /></label>
            <label><span>宽度（0=SDK）</span><input type="number" min={0} value={continuous.width} onChange={(event) => setContinuous({ ...continuous, width: Number(event.target.value) })} /></label>
            <label><span>单相机超时 ms</span><input type="number" min={1000} max={600000} value={continuous.timeoutMs} onChange={(event) => setContinuous({ ...continuous, timeoutMs: Number(event.target.value) })} /></label>
            <label><span>轮间隔 ms</span><input type="number" min={0} max={600000} value={continuous.intervalMs} onChange={(event) => setContinuous({ ...continuous, intervalMs: Number(event.target.value) })} /></label>
            <label><span>失败重试</span><input type="number" min={0} max={10} value={continuous.retries} onChange={(event) => setContinuous({ ...continuous, retries: Number(event.target.value) })} /></label>
            <label>
              <span>数据模式</span>
              <select value={continuous.dataMode} onChange={(event) => setContinuous({ ...continuous, dataMode: Number(event.target.value) })}>
                <option value={1}>深度</option>
                <option value={2}>亮度</option>
                <option value={3}>深度 + 亮度</option>
              </select>
            </label>
            <label className="capture-continuous-output"><span>provider 输出目录</span><input value={continuous.outputDir} onChange={(event) => setContinuous({ ...continuous, outputDir: event.target.value })} /></label>
          </div>
          <div className="capture-operation-checks">
            <label><input type="checkbox" checked={continuous.connectFirst} onChange={(event) => setContinuous({ ...continuous, connectFirst: event.target.checked })} />测试前发现并连接</label>
            <label><input type="checkbox" checked={continuous.stopStreams} onChange={(event) => setContinuous({ ...continuous, stopStreams: event.target.checked })} />测试前停止实时预览</label>
          </div>
          <label className="capture-danger-confirm">
            <input type="checkbox" checked={confirmContinuous} onChange={(event) => setConfirmContinuous(event.target.checked)} />
            我确认对 {continuousScope === 'single' ? 1 : normalizedIps.length} 路相机执行 {continuous.rounds} 轮并行触发，并接受实时预览可能停止
          </label>
          <button type="button" className="primary" disabled={busy !== null || !confirmContinuous || normalizedIps.length === 0 || !continuous.outputDir.trim()} onClick={() => void handleContinuousTest()}>
            <Play size={15} />{busy === 'continuous-test' ? '连续测试运行中' : '执行连续测试'}
          </button>

          {continuousSummary ? (
            <div className="capture-continuous-summary" data-tone={summaryTone(continuousSummary)}>
              <dl>
                <div><dt>成功/尝试</dt><dd>{continuousSummary.successes}/{continuousSummary.attempts}</dd></div>
                <div><dt>失败</dt><dd>{continuousSummary.failures}</dd></div>
                <div><dt>完整帧</dt><dd>{continuousSummary.completeFrames}</dd></div>
                <div><dt>元数据</dt><dd>{continuousSummary.metadataFrames}</dd></div>
                <div><dt>相机</dt><dd>{continuousSummary.cameraCount}/{continuousSummary.expectedCameras}</dd></div>
                <div><dt>耗时</dt><dd>{continuousSummary.elapsedMs ?? '-'} ms</dd></div>
                <div><dt>异步落盘帧</dt><dd>{continuousSummary.storageAsyncFrames ?? '-'}</dd></div>
                <div><dt>跨轮重叠</dt><dd>{continuousSummary.captureStorageOverlappedRounds ?? '-'}</dd></div>
                <div><dt>帧事务</dt><dd>{continuousSummary.frameTransaction ? '是' : '否/未报告'}</dd></div>
                <div><dt>metadata-last</dt><dd>{continuousSummary.metadataCommitLast ? '是' : '否/未报告'}</dd></div>
              </dl>
              <p title={continuousSummary.summaryOutput}>{continuousSummary.summaryExists ? 'summary 已落盘' : 'summary 未确认'} · {continuousSummary.syncMode || '-'}</p>
            </div>
          ) : null}

          {continuousSummary?.results?.length ? (
            <div className="capture-continuous-results">
              <table>
                <thead><tr><th>轮次</th><th>相机</th><th>code</th><th>完整帧</th><th>深度/亮度/元数据</th><th>storage ticket</th><th>输出</th><th>提示</th></tr></thead>
                <tbody>
                  {continuousSummary.results.map((item, index) => (
                    <tr key={`${item.round}-${item.ip}-${item.attempt}-${index}`}>
                      <td>{item.round}</td>
                      <td>{item.ip}</td>
                      <td>{item.code} {item.errorName || ''}</td>
                      <td>{item.completeFrame ? '是' : '否'}</td>
                      <td>{item.depthExists ? '✓' : '×'} / {item.intensityExists ? '✓' : '×'} / {item.metadataExists ? '✓' : '×'}</td>
                      <td>{item.storageAsync ? `async #${item.storageTicketId ?? '-'}` : 'sync/未报告'}</td>
                      <td title={item.output}>{item.output || '-'}</td>
                      <td>{item.operatorHint || item.error || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>

      {message ? (
        <div className={`capture-operation-message ${message.tone}`} role="status">
          {message.tone === 'success' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          <span>{message.text}</span>
        </div>
      ) : null}
    </div>
  );
}
