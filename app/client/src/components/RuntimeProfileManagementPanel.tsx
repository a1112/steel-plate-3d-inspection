import { useEffect, useState } from 'react';
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
} from '../services/runtime-profile-api';
import { Panel } from './Panel';

type RuntimeProfileManagementPanelProps = {
  canEdit: boolean;
};

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
    setBusyAction('save');
    setMessage('');
    try {
      const result = await saveAdminRuntimeProfile(draft);
      setProfileState((current) => current ? {
        ...current,
        savedProfile: draft,
        savedConfigHash: result.savedConfigHash,
        restartRequired: result.restartRequired,
      } : current);
      setMessage(result.restartRequired ? '配置已保存，重启后生效' : '配置已保存');
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
  const latestJob = importStatus?.latestJob;
  const converted = latestJob?.convertedRecords ?? 0;
  const total = latestJob?.totalRecords ?? 0;
  const quarantined = latestJob?.quarantinedRecords ?? 0;

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
                <em>{activeProfile.provider} / {activeProfile.dataSource}</em>
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
              <div className="runtime-profile-restart-notice">已保存新配置，需要重启服务后生效</div>
            ) : null}

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
