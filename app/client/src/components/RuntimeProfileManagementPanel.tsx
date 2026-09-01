import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import {
  fetchAdminBkvImportJobs,
  fetchAdminRuntimeProfile,
  retryAdminBkvImportJob,
  saveAdminRuntimeProfile,
  startAdminBkvImportJob,
  validateAdminRuntimeProfile,
  type AdminRuntimeProfileState,
  type BkvImportStatus,
  type RuntimeProfileDocument,
  type RuntimeSimulationConfig,
} from '../services/runtime-profile-api';
import {
  acquisitionModeDetail,
  acquisitionModeLabel,
  acquisitionModeOptions,
  isAcquisitionMode,
  type AcquisitionMode,
} from '../lib/acquisition-mode';
import { chooseCaptureLocalDirectory } from '../lib/capture-api';
import { waitForSupervisorAcquisitionMode } from '../lib/background-monitor';
import { Panel } from './Panel';

type RuntimeProfileManagementPanelProps = {
  canEdit: boolean;
};

const DEFAULT_SIMULATION_CONFIG: RuntimeSimulationConfig = {
  sourceRoot: '',
  speed: 1,
  loop: false,
  interSessionGapMs: 1_500,
};

function profileAcquisitionMode(profile: Pick<RuntimeProfileDocument, 'acquisitionMode' | 'dataSource' | 'provider' | 'cameraConnection'>): AcquisitionMode {
  if (isAcquisitionMode(profile.acquisitionMode)) return profile.acquisitionMode;
  if (profile.dataSource === 'converted-local') return 'offline';
  if (profile.provider === 'simulated' || profile.cameraConnection === 'simulated') return 'simulation';
  return 'online';
}

function supportsCapturePipelineModes(profile: Pick<RuntimeProfileDocument, 'provider' | 'cameraConnection' | 'capabilities'>) {
  return profile.provider === 'external-api'
    && profile.cameraConnection === 'headless-cpp'
    && profile.capabilities.directCamera
    && profile.capabilities.captureManagement;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function RuntimeProfileManagementPanel({
  canEdit,
}: RuntimeProfileManagementPanelProps) {
  const [profileState, setProfileState] = useState<AdminRuntimeProfileState | null>(null);
  const [draft, setDraft] = useState<RuntimeProfileDocument | null>(null);
  const [importStatus, setImportStatus] = useState<BkvImportStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [loadError, setLoadError] = useState('');
  const [converterError, setConverterError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetchAdminRuntimeProfile(controller.signal)
      .then(async (nextProfile) => {
        setProfileState(nextProfile);
        setDraft(nextProfile.savedProfile);
        setLoadError('');
        if (nextProfile.savedProfile.provider !== 'bkv') {
          setImportStatus(null);
          setConverterError('');
          return;
        }
        try {
          setImportStatus(await fetchAdminBkvImportJobs(controller.signal));
          setConverterError('');
        } catch (error) {
          if (!controller.signal.aborted) {
            setConverterError(errorMessage(error, '转换服务状态暂不可用'));
          }
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(errorMessage(error, '运行模式配置读取失败'));
        }
      });
    return () => controller.abort();
  }, []);

  const updateStorage = (key: keyof RuntimeProfileDocument['storage'], value: string) => {
    setDraft((current) => current ? {
      ...current,
      storage: { ...current.storage, [key]: value },
    } : current);
  };

  const updateAcquisitionMode = (acquisitionMode: AcquisitionMode) => {
    setDraft((current) => {
      if (!current) return current;
      if (acquisitionMode !== 'offline' && !supportsCapturePipelineModes(current)) {
        setMessage('当前站点无六相机采集管线，请切换或配置 SICK 站点');
        return current;
      }
      return {
        ...current,
        acquisitionMode,
        ...(acquisitionMode === 'simulation' && !current.simulation
          ? { simulation: DEFAULT_SIMULATION_CONFIG }
          : {}),
      };
    });
  };

  const updateSimulation = <K extends keyof RuntimeSimulationConfig>(key: K, value: RuntimeSimulationConfig[K]) => {
    setDraft((current) => current ? {
      ...current,
      simulation: {
        ...(current.simulation ?? DEFAULT_SIMULATION_CONFIG),
        [key]: value,
      },
    } : current);
  };

  const chooseSimulationSource = async () => {
    try {
      const selected = await chooseCaptureLocalDirectory('选择模拟采集数据目录');
      if (!selected) {
        setMessage('浏览器模式不能选择本机目录，请手工填写采集主机路径');
        return;
      }
      if (selected.selected && selected.path) {
        updateSimulation('sourceRoot', selected.path);
        setMessage(`已选择模拟数据目录：${selected.path}`);
      }
    } catch (error) {
      setMessage(errorMessage(error, '模拟数据目录选择失败'));
    }
  };

  const validateProfile = async () => {
    if (!draft) return;
    setBusyAction('validate');
    setMessage('');
    try {
      const result = await validateAdminRuntimeProfile(draft);
      setMessage('配置校验通过');
      if (result.restartRequired) {
        setProfileState((current) => current ? { ...current, restartRequired: true } : current);
      }
    } catch (error) {
      setMessage(errorMessage(error, '运行配置校验失败'));
    } finally {
      setBusyAction('');
    }
  };

  const saveProfile = async () => {
    if (!draft) return;
    const savedDraft = draft;
    const acquisitionMode = profileAcquisitionMode(savedDraft);
    setBusyAction('save');
    setMessage('');
    try {
      const result = await saveAdminRuntimeProfile(savedDraft);
      setProfileState((current) => current ? {
        ...current,
        savedProfile: savedDraft,
        savedConfigHash: result.savedConfigHash,
        restartRequired: result.restartRequired,
      } : current);
      if (!result.modeTransitionAccepted) {
        setMessage(result.restartRequired
          ? '配置已保存；非模式配置将在下次运行服务重启后生效'
          : '配置已保存，当前运行服务无需切换');
        return;
      }
      const targetMode = result.targetAcquisitionMode;
      setMessage(result.recoveryRequired
        ? `配置已保存，模式提交正在恢复并切换至${acquisitionModeLabel(targetMode)}…`
        : `配置已保存，服务端正在自动切换至${acquisitionModeLabel(targetMode)}…`);
      try {
        await waitForSupervisorAcquisitionMode(targetMode);
        setProfileState((current) => current ? {
          ...current,
          activeProfile: {
            ...current.activeProfile,
            profileId: savedDraft.id,
            displayName: savedDraft.displayName,
            provider: savedDraft.provider,
            dataSource: savedDraft.dataSource,
            cameraConnection: savedDraft.cameraConnection,
            cameraCount: savedDraft.cameraCount,
            cameras: savedDraft.cameras,
            capabilities: {
              ...savedDraft.capabilities,
              directCamera: targetMode === 'online' && savedDraft.capabilities.directCamera,
              captureManagement: targetMode !== 'offline' && savedDraft.capabilities.captureManagement,
              reconstruction: targetMode !== 'offline' && savedDraft.capabilities.reconstruction,
              offlineReplay: targetMode !== 'online' || savedDraft.capabilities.offlineReplay,
            },
            acquisitionMode: targetMode,
            simulation: targetMode === 'simulation' && savedDraft.simulation ? {
              configured: Boolean(savedDraft.simulation.sourceRoot.trim()),
              speed: savedDraft.simulation.speed,
              loop: savedDraft.simulation.loop,
              interSessionGapMs: savedDraft.simulation.interSessionGapMs,
            } : undefined,
            configHash: result.savedConfigHash,
          },
          activeConfigHash: result.savedConfigHash,
          restartRequired: false,
        } : current);
        setMessage(`已应用${acquisitionModeLabel(targetMode)}，运行服务切换完成`);
      } catch (error) {
        setMessage(result.recoveryRequired
          ? `配置已保存，但模式提交恢复尚未完成：${errorMessage(error, '暂未确认恢复结果')}`
          : `配置已保存，服务端仍在自动切换：${errorMessage(error, '暂未确认切换结果')}`);
      }
    } catch (error) {
      setMessage(errorMessage(error, '运行配置保存失败'));
    } finally {
      setBusyAction('');
    }
  };

  const refreshImportStatus = async () => {
    setImportStatus(await fetchAdminBkvImportJobs());
  };

  const startImport = async () => {
    setBusyAction('start');
    setMessage('');
    try {
      await startAdminBkvImportJob();
      await refreshImportStatus();
      setMessage('转换任务已启动');
    } catch (error) {
      setMessage(errorMessage(error, '转换任务启动失败'));
    } finally {
      setBusyAction('');
    }
  };

  const retryImport = async () => {
    const jobId = importStatus?.latestJob?.id;
    if (!jobId) return;
    setBusyAction('retry');
    setMessage('');
    try {
      await retryAdminBkvImportJob(jobId);
      await refreshImportStatus();
      setMessage('转换任务已重试');
    } catch (error) {
      setMessage(errorMessage(error, '转换任务重试失败'));
    } finally {
      setBusyAction('');
    }
  };

  const activeProfile = profileState?.activeProfile;
  const activeAcquisitionMode = activeProfile
    ? (isAcquisitionMode(activeProfile.acquisitionMode)
      ? activeProfile.acquisitionMode
      : activeProfile.dataSource === 'converted-local'
        ? 'offline'
        : activeProfile.provider === 'simulated' || activeProfile.cameraConnection === 'simulated'
          ? 'simulation'
          : 'online')
    : 'online';
  const latestJob = importStatus?.latestJob;
  const converted = latestJob?.convertedRecords ?? 0;
  const total = latestJob?.totalRecords ?? 0;
  const quarantined = latestJob?.quarantinedRecords ?? 0;
  const capturePipelineModesAvailable = draft ? supportsCapturePipelineModes(draft) : false;

  return (
    <div className="runtime-profile-management" data-testid="runtime-profile-management">
      <Panel title="运行模式与数据转换" className="parameter-card runtime-profile-card">
        {loadError ? <div className="runtime-profile-message error">{loadError}</div> : null}
        {!draft || !activeProfile ? (
          <div className="admin-empty-state">正在读取运行模式配置…</div>
        ) : (
          <>
            <div className="runtime-profile-summary">
              <div>
                <span>当前运行模式</span>
                <strong>{activeProfile.displayName}</strong>
                <em>{acquisitionModeLabel(activeAcquisitionMode)} · {activeProfile.provider} / {activeProfile.dataSource}</em>
              </div>
              <div>
                <span>相机布局</span>
                <strong>{activeProfile.cameraCount} 个相机</strong>
                <em>{activeProfile.cameraConnection === 'none' ? '离线数据源' : activeProfile.cameraConnection}</em>
              </div>
              <div>
                <span>功能能力</span>
                <strong>{activeProfile.capabilities.offlineReplay ? '离线回放' : '在线采集'}</strong>
                <em>
                  采集管理 {activeProfile.capabilities.captureManagement ? '开启' : '关闭'}
                  {' · '}3D 重建 {activeProfile.capabilities.reconstruction ? '开启' : '关闭'}
                </em>
              </div>
            </div>

            {profileState.restartRequired ? (
              <div className="runtime-profile-restart-notice">
                <span>
                  {profileAcquisitionMode(profileState.savedProfile) !== activeAcquisitionMode
                    ? '已保存新模式；服务端监控正在自动切换运行服务，无需手工逐项重启'
                    : '已保存非模式配置，将在下次运行服务重启后生效'}
                </span>
              </div>
            ) : null}

            <section className="runtime-acquisition-mode" aria-label="采集运行模式配置">
              <header>
                <div>
                  <span>采集运行模式</span>
                  <strong>{acquisitionModeLabel(profileAcquisitionMode(draft))}</strong>
                </div>
                <em>{acquisitionModeDetail(profileAcquisitionMode(draft))}</em>
              </header>
              <div className="runtime-acquisition-mode-options" role="radiogroup" aria-label="采集运行模式">
                {acquisitionModeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={profileAcquisitionMode(draft) === option.value}
                    className={profileAcquisitionMode(draft) === option.value ? 'active' : ''}
                    disabled={!canEdit || Boolean(busyAction) || (option.value !== 'offline' && !capturePipelineModesAvailable)}
                    title={option.value !== 'offline' && !capturePipelineModesAvailable
                      ? '当前站点无六相机采集管线，请切换或配置 SICK 站点'
                      : undefined}
                    onClick={() => updateAcquisitionMode(option.value)}
                  >
                    <strong>{option.label}</strong>
                    <span>{option.detail}</span>
                  </button>
                ))}
              </div>
              {!capturePipelineModesAvailable ? (
                <div className="runtime-acquisition-mode-note" role="status">
                  当前站点无六相机采集管线，请切换或配置 SICK 站点；此站点仅支持离线（历史模式）。
                </div>
              ) : null}
              {profileAcquisitionMode(draft) === 'simulation' ? (
                <div className="runtime-simulation-form" data-testid="runtime-simulation-form">
                  <label className="runtime-simulation-source">
                    <span>模拟数据目录</span>
                    <div>
                      <input
                        aria-label="模拟数据目录"
                        value={draft.simulation?.sourceRoot ?? ''}
                        disabled={!canEdit}
                        placeholder="例如 H:\\captured-data"
                        onChange={(event) => updateSimulation('sourceRoot', event.target.value)}
                      />
                      <button type="button" aria-label="选择模拟数据目录" disabled={!canEdit} onClick={() => void chooseSimulationSource()}>
                        <FolderOpen size={15} />
                      </button>
                    </div>
                  </label>
                  <label>
                    <span>播放速度</span>
                    <input
                      aria-label="模拟播放速度"
                      type="number"
                      min={0.25}
                      max={4}
                      step={0.25}
                      value={draft.simulation?.speed ?? DEFAULT_SIMULATION_CONFIG.speed}
                      disabled={!canEdit}
                      onChange={(event) => updateSimulation('speed', Number(event.target.value))}
                    />
                  </label>
                  <label>
                    <span>批次间隔</span>
                    <input
                      aria-label="模拟批次间隔毫秒"
                      type="number"
                      min={1_001}
                      max={3_600_000}
                      step={100}
                      value={draft.simulation?.interSessionGapMs ?? DEFAULT_SIMULATION_CONFIG.interSessionGapMs}
                      disabled={!canEdit}
                      onChange={(event) => updateSimulation('interSessionGapMs', Number(event.target.value))}
                    />
                  </label>
                  <label className="runtime-simulation-loop">
                    <input
                      aria-label="模拟循环播放"
                      type="checkbox"
                      checked={draft.simulation?.loop ?? DEFAULT_SIMULATION_CONFIG.loop}
                      disabled={!canEdit}
                      onChange={(event) => updateSimulation('loop', event.target.checked)}
                    />
                    <span>数据集结束后循环播放</span>
                  </label>
                </div>
              ) : null}
            </section>

            <div className="runtime-profile-camera-grid" aria-label="运行模式相机列表">
              {draft.cameras
                .slice()
                .sort((left, right) => left.displayOrder - right.displayOrder)
                .map((camera) => (
                  <div key={camera.id}>
                    <strong>{camera.id}</strong>
                    <span>源相机 {camera.sourceCameraId}</span>
                    <em>{camera.sourceDirectory || camera.role || '-'}</em>
                  </div>
                ))}
            </div>

            <div className="runtime-profile-storage-form">
              <label>
                <span>BKV 源目录</span>
                <input
                  aria-label="BKV 源目录"
                  value={draft.storage.sourceRoot}
                  disabled={!canEdit}
                  onChange={(event) => updateStorage('sourceRoot', event.target.value)}
                />
              </label>
              <label>
                <span>标准存储目录</span>
                <input
                  aria-label="标准存储目录"
                  value={draft.storage.convertedRoot}
                  disabled={!canEdit}
                  onChange={(event) => updateStorage('convertedRoot', event.target.value)}
                />
              </label>
              <label>
                <span>目录数据库</span>
                <input
                  aria-label="目录数据库"
                  value={draft.storage.catalogPath}
                  disabled={!canEdit}
                  onChange={(event) => updateStorage('catalogPath', event.target.value)}
                />
              </label>
              <label>
                <span>转换服务地址</span>
                <input
                  aria-label="转换服务地址"
                  value={draft.storage.converterOrigin}
                  disabled={!canEdit}
                  onChange={(event) => updateStorage('converterOrigin', event.target.value)}
                />
              </label>
            </div>

            <div className="runtime-profile-actions">
              <button type="button" disabled={!canEdit || Boolean(busyAction)} onClick={() => void validateProfile()}>
                校验运行配置
              </button>
              <button className="primary" type="button" disabled={!canEdit || Boolean(busyAction)} onClick={() => void saveProfile()}>
                保存运行配置
              </button>
            </div>

            {draft.provider === 'bkv' ? (
              <>
                {converterError ? (
                  <div className="runtime-profile-message error">转换服务状态暂不可用</div>
                ) : null}
                <div className="bkv-import-status">
                  <div>
                    <span>转换服务</span>
                    <strong>{importStatus?.ready ? '就绪' : '不可用'}</strong>
                  </div>
                  <div>
                    <span>最近任务</span>
                    <strong>{latestJob?.status ?? '暂无任务'}</strong>
                  </div>
                  <div>
                    <span>转换进度</span>
                    <strong>{converted} / {total} 已转换</strong>
                  </div>
                  <div>
                    <span>异常数据</span>
                    <strong>隔离 {quarantined}</strong>
                  </div>
                  <div className="bkv-import-actions">
                    <button
                      type="button"
                      disabled={!canEdit || Boolean(busyAction) || Boolean(converterError)}
                      onClick={() => void startImport()}
                    >
                      启动转换
                    </button>
                    <button
                      type="button"
                      disabled={!canEdit || Boolean(busyAction) || !latestJob?.id || Boolean(converterError)}
                      onClick={() => void retryImport()}
                    >
                      重试任务
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </>
        )}
        {message ? <div className="runtime-profile-message" role="status">{message}</div> : null}
      </Panel>
    </div>
  );
}
