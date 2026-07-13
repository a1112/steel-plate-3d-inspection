import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  FolderCog,
  Link,
  RefreshCw,
  RotateCcw,
  Save,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyCaptureProfile,
  applyCaptureStorageRoot,
  chooseCaptureLocalDirectory,
  connectAllCaptureCameras,
  loadAllCaptureCameraParams,
  openCaptureLocalPath,
  readCaptureProfiles,
  readCaptureStorageStatus,
  recoverCaptureCameraParams,
  saveAllCaptureCameraParams,
  type CaptureBatchOperationResult,
  type CaptureCameraStatus,
  type CaptureProfilesStatus,
  type CaptureStorageStatus,
} from '../lib/capture-api';
import { CaptureAdvancedOperations } from './CaptureAdvancedOperations';
import { CaptureDiagnosticOperations } from './CaptureDiagnosticOperations';
import { Panel } from './Panel';

type OperationName =
  | 'refresh'
  | 'apply-profile'
  | 'connect-all'
  | 'save-params'
  | 'load-params'
  | 'recover-params'
  | 'apply-storage';

type OperationMessage = {
  tone: 'success' | 'warning' | 'error';
  text: string;
};

function bytesText(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '-';
  }
  if (value >= 1024 ** 3) {
    return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  }
  if (value >= 1024 ** 2) {
    return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  }
  return `${Math.round(value / 1024)} KiB`;
}

function resultSummary(result: CaptureBatchOperationResult) {
  const facts = [
    typeof result.connected === 'number' ? `连接 ${result.connected}` : '',
    typeof result.saved === 'number' ? `保存 ${result.saved}` : '',
    typeof result.loaded === 'number' ? `加载 ${result.loaded}` : '',
    typeof result.paramApplied === 'number' ? `参数应用 ${result.paramApplied}` : '',
    typeof result.failed === 'number' ? `失败 ${result.failed}` : '',
    typeof result.connectFailed === 'number' ? `连接失败 ${result.connectFailed}` : '',
    typeof result.paramFailed === 'number' ? `参数失败 ${result.paramFailed}` : '',
  ].filter(Boolean);
  return facts.join('，');
}

export function CaptureOperationsPanel({
  cameraIps,
  cameraStatuses = [],
}: {
  cameraIps: string[];
  cameraStatuses?: CaptureCameraStatus[];
}) {
  const normalizedIps = useMemo(
    () => Array.from(new Set(cameraIps.map((ip) => ip.trim()).filter(Boolean))),
    [cameraIps],
  );
  const [profiles, setProfiles] = useState<CaptureProfilesStatus | null>(null);
  const [storage, setStorage] = useState<CaptureStorageStatus | null>(null);
  const [selectedProfile, setSelectedProfile] = useState('current-6-soft-trigger');
  const [cameraParamDir, setCameraParamDir] = useState('config/camera-params/current-6-soft-trigger');
  const [storageRoot, setStorageRoot] = useState('H:/');
  const [recoveryIp, setRecoveryIp] = useState(normalizedIps[0] ?? '');
  const [autoConnect, setAutoConnect] = useState(true);
  const [loadParamsOnApply, setLoadParamsOnApply] = useState(false);
  const [changeStorageOnApply, setChangeStorageOnApply] = useState(false);
  const [confirmProfileApply, setConfirmProfileApply] = useState(false);
  const [confirmLoad, setConfirmLoad] = useState(false);
  const [confirmRecovery, setConfirmRecovery] = useState(false);
  const [confirmStorage, setConfirmStorage] = useState(false);
  const [busy, setBusy] = useState<OperationName | null>(null);
  const [message, setMessage] = useState<OperationMessage | null>(null);
  const [lastResult, setLastResult] = useState<CaptureBatchOperationResult | null>(null);

  const chooseDirectory = async (
    title: string,
    onSelected: (path: string) => void,
  ) => {
    try {
      const selected = await chooseCaptureLocalDirectory(title);
      if (!selected) {
        setMessage({ tone: 'warning', text: '浏览器模式不提供本地目录选择，请手工填写路径' });
      } else if (selected.selected && selected.path) {
        onSelected(selected.path);
      }
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '目录选择失败' });
    }
  };

  const openLocalPath = async (path: string) => {
    try {
      const opened = await openCaptureLocalPath(path);
      setMessage(opened
        ? { tone: 'success', text: `已在系统文件管理器中打开：${path}` }
        : { tone: 'warning', text: '浏览器模式不能打开本地路径' });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '本地路径打开失败' });
    }
  };

  useEffect(() => {
    if (!recoveryIp && normalizedIps.length > 0) {
      setRecoveryIp(normalizedIps[0]);
    }
  }, [normalizedIps, recoveryIp]);

  const refresh = useCallback(async () => {
    setBusy('refresh');
    try {
      const [nextProfiles, nextStorage] = await Promise.all([
        readCaptureProfiles(),
        readCaptureStorageStatus(),
      ]);
      setProfiles(nextProfiles);
      setStorage(nextStorage);
      const activeProfile = nextProfiles.activeProfile || nextProfiles.profiles?.[0];
      if (activeProfile) {
        setSelectedProfile(activeProfile);
        setCameraParamDir(`config/camera-params/${activeProfile}`);
      }
      if (nextStorage.root) {
        setStorageRoot(nextStorage.root);
      }
      setMessage({ tone: 'success', text: '运行配置与存储状态已刷新' });
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : '运行配置读取失败',
      });
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runOperation = async (
    name: OperationName,
    action: () => Promise<CaptureBatchOperationResult>,
    success: string,
  ) => {
    setBusy(name);
    setMessage(null);
    try {
      const result = await action();
      setLastResult(result);
      const detail = resultSummary(result);
      setMessage({
        tone: result.code === 0 ? 'success' : 'warning',
        text: `${success}${detail ? `：${detail}` : ''}${result.code === 0 ? '' : `（code ${result.code}）`}`,
      });
      return result;
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : `${success}失败`,
      });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const handleApplyProfile = async () => {
    const result = await runOperation(
      'apply-profile',
      () =>
        applyCaptureProfile({
          name: selectedProfile,
          expectedCameras: normalizedIps.length || 6,
          autoConnect,
          loadCameraParams: loadParamsOnApply,
          saveToDevice: false,
          changeStorage: changeStorageOnApply,
        }),
      `配置 ${selectedProfile} 已应用`,
    );
    if (result?.code === 0) {
      setConfirmProfileApply(false);
      setProfiles((current) =>
        current ? { ...current, activeProfile: selectedProfile } : current,
      );
    }
  };

  const handleApplyStorage = async () => {
    if (!confirmStorage) {
      setMessage({ tone: 'warning', text: '请先确认切换正式落盘根目录' });
      return;
    }
    setBusy('apply-storage');
    setMessage(null);
    try {
      const result = await applyCaptureStorageRoot(storageRoot.trim());
      setStorage(result);
      setConfirmStorage(false);
      setMessage({
        tone: result.code === 0 && result.writable ? 'success' : 'warning',
        text: result.writable
          ? `存储根目录已切换为 ${result.root}`
          : `存储目录不可写（code ${result.code}）`,
      });
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : '存储根目录切换失败',
      });
    } finally {
      setBusy(null);
    }
  };

  const queue = storage?.queue;
  const profileNames = profiles?.profiles?.length
    ? profiles.profiles
    : [selectedProfile];

  return (
    <Panel
      title="采集运行配置与设备参数"
      className="capture-operations-panel"
      action={
        <button type="button" onClick={() => void refresh()} disabled={busy !== null}>
          <RefreshCw size={15} className={busy === 'refresh' ? 'spin' : ''} />
          刷新运行状态
        </button>
      }
    >
      <div className="capture-operations-permission">
        所有操作经 Rust 服务的受控代理执行，需要后台“配置管理”权限；前端不会直连 C++ 或相机 SDK。
      </div>
      <div className="capture-operations-grid">
        <section>
          <header>
            <FolderCog size={17} />
            <div>
              <strong>全局 Profile</strong>
              <span>当前：{profiles?.activeProfile || '未读取'}</span>
            </div>
          </header>
          <label>
            <span>配置名称</span>
            <select
              value={selectedProfile}
              onChange={(event) => {
                setSelectedProfile(event.target.value);
                setCameraParamDir(`config/camera-params/${event.target.value}`);
              }}
            >
              {profileNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <div className="capture-operation-checks">
            <label><input type="checkbox" checked={autoConnect} onChange={(event) => setAutoConnect(event.target.checked)} />自动连接</label>
            <label><input type="checkbox" checked={loadParamsOnApply} onChange={(event) => setLoadParamsOnApply(event.target.checked)} />同时加载参数文件</label>
            <label><input type="checkbox" checked={changeStorageOnApply} onChange={(event) => setChangeStorageOnApply(event.target.checked)} />允许切换存储目录</label>
          </div>
          <label className="capture-danger-confirm">
            <input type="checkbox" checked={confirmProfileApply} onChange={(event) => setConfirmProfileApply(event.target.checked)} />
            我确认应用会改变相机当前运行参数，并可能连接设备
          </label>
          <button type="button" className="primary" disabled={busy !== null || !selectedProfile || !confirmProfileApply} onClick={() => void handleApplyProfile()}>
            <Upload size={15} />应用 Profile
          </button>
          <p>应用始终使用 <code>saveToDevice=false</code>，不会把参数永久写入相机。</p>
        </section>

        <section>
          <header>
            <Link size={17} />
            <div>
              <strong>六相机连接</strong>
              <span>{normalizedIps.length || 0} 个配置地址</span>
            </div>
          </header>
          <div className="capture-operation-ip-list">
            {normalizedIps.map((ip) => <span key={ip}>{ip}</span>)}
          </div>
          <button
            type="button"
            disabled={busy !== null || normalizedIps.length === 0}
            onClick={() => void runOperation(
              'connect-all',
              () => connectAllCaptureCameras({ ips: normalizedIps, expectedCameras: normalizedIps.length, devType: -1 }),
              '全部连接命令已完成',
            )}
          >
            <Link size={15} />发现并连接全部
          </button>
        </section>

        <section>
          <header>
            <DatabaseBackup size={17} />
            <div>
              <strong>相机参数文件</strong>
              <span>保存快照或受控加载</span>
            </div>
          </header>
          <label>
            <span>参数目录</span>
            <div className="capture-path-picker">
              <input value={cameraParamDir} onChange={(event) => setCameraParamDir(event.target.value)} />
              <button type="button" aria-label="选择相机参数目录" onClick={() => void chooseDirectory('选择相机参数目录', setCameraParamDir)}><FolderCog size={14} /></button>
            </div>
          </label>
          <div className="capture-operation-actions">
            <button
              type="button"
              disabled={busy !== null || !selectedProfile}
              onClick={() => void runOperation(
                'save-params',
                () => saveAllCaptureCameraParams({
                  name: selectedProfile,
                  ips: normalizedIps,
                  cameraParamDir,
                  applySoftTrigger: false,
                  saveToDevice: false,
                }),
                '相机参数快照已保存',
              )}
            >
              <Save size={15} />保存全部参数
            </button>
            <button
              type="button"
              disabled={busy !== null || !confirmLoad || !selectedProfile}
              onClick={() => void runOperation(
                'load-params',
                () => loadAllCaptureCameraParams({
                  name: selectedProfile,
                  ips: normalizedIps,
                  cameraParamDir,
                  applySoftTrigger: false,
                  saveToDevice: false,
                  allowExternal: false,
                }),
                '参数文件加载完成',
              ).then(() => setConfirmLoad(false))}
            >
              <Upload size={15} />加载全部参数
            </button>
          </div>
          <label className="capture-danger-confirm">
            <input type="checkbox" checked={confirmLoad} onChange={(event) => setConfirmLoad(event.target.checked)} />
            我确认当前没有采集或实时流，允许加载参数文件
          </label>
        </section>

        <section>
          <header>
            <RotateCcw size={17} />
            <div>
              <strong>单相机参数恢复</strong>
              <span>调用 SDK recovery，需单独确认</span>
            </div>
          </header>
          <label>
            <span>相机 IP</span>
            <select value={recoveryIp} onChange={(event) => setRecoveryIp(event.target.value)}>
              {normalizedIps.map((ip) => <option key={ip} value={ip}>{ip}</option>)}
            </select>
          </label>
          <label className="capture-danger-confirm">
            <input type="checkbox" checked={confirmRecovery} onChange={(event) => setConfirmRecovery(event.target.checked)} />
            我确认恢复该相机当前参数
          </label>
          <button
            type="button"
            className="danger"
            disabled={busy !== null || !confirmRecovery || !recoveryIp}
            onClick={() => void runOperation(
              'recover-params',
              () => recoverCaptureCameraParams(recoveryIp),
              `${recoveryIp} 参数恢复完成`,
            ).then(() => setConfirmRecovery(false))}
          >
            <RotateCcw size={15} />恢复选中相机
          </button>
        </section>

        <section className="capture-storage-operation">
          <header>
            <FolderCog size={17} />
            <div>
              <strong>正式存储根目录</strong>
              <span>{storage?.writable ? '当前可写' : '等待检查'}</span>
            </div>
          </header>
          <label>
            <span>根目录</span>
            <div className="capture-path-picker">
              <input value={storageRoot} onChange={(event) => setStorageRoot(event.target.value)} />
              <button type="button" aria-label="选择正式存储根目录" onClick={() => void chooseDirectory('选择正式存储根目录', setStorageRoot)}><FolderCog size={14} /></button>
              <button type="button" aria-label="打开正式存储根目录" onClick={() => void openLocalPath(storageRoot)}><FolderCog size={14} />打开</button>
            </div>
          </label>
          <label className="capture-danger-confirm">
            <input type="checkbox" checked={confirmStorage} onChange={(event) => setConfirmStorage(event.target.checked)} />
            我确认后续采集切换到这个落盘根目录
          </label>
          <button type="button" disabled={busy !== null || !storageRoot.trim()} onClick={() => void handleApplyStorage()}>
            <FolderCog size={15} />应用存储目录
          </button>
        </section>

        <section className="capture-queue-operation">
          <header>
            <DatabaseBackup size={17} />
            <div>
              <strong>Writer 队列</strong>
              <span>{queue?.accepting ? '接收任务' : '未就绪'}</span>
            </div>
          </header>
          <dl>
            <div><dt>worker</dt><dd>{queue?.workerCount ?? '-'}</dd></div>
            <div><dt>pending</dt><dd>{queue ? `${queue.pendingItems}/${queue.capacityItems}` : '-'}</dd></div>
            <div><dt>pending bytes</dt><dd>{queue ? `${bytesText(queue.pendingBytes)} / ${bytesText(queue.capacityBytes)}` : '-'}</dd></div>
            <div><dt>high-water</dt><dd>{queue ? `${queue.highWaterItems} / ${bytesText(queue.highWaterBytes)}` : '-'}</dd></div>
            <div><dt>完成/失败</dt><dd>{queue ? `${queue.completed}/${queue.failed}` : '-'}</dd></div>
            <div><dt>拒绝</dt><dd>{queue?.rejected ?? '-'}</dd></div>
          </dl>
        </section>
      </div>

      {message ? (
        <div className={`capture-operation-message ${message.tone}`} role="status">
          {message.tone === 'success' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          <span>{message.text}</span>
        </div>
      ) : null}

      {lastResult?.results?.length ? (
        <div className="capture-operation-results">
          <table>
            <thead><tr><th>相机</th><th>code</th><th>文件/状态</th><th>提示</th></tr></thead>
            <tbody>
              {lastResult.results.map((item, index) => (
                <tr key={`${item.ip ?? 'item'}-${index}`}>
                  <td>{item.ip || '-'}</td>
                  <td>{item.code}</td>
                  <td>{item.file || (item.connected ? '已连接' : item.errorName || '-')}</td>
                  <td>{item.operatorHint || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <CaptureAdvancedOperations
        cameraIps={normalizedIps}
        cameraStatuses={cameraStatuses}
        profiles={profiles}
        storage={storage}
        onProfilesChange={setProfiles}
        onStorageChange={setStorage}
      />
      <CaptureDiagnosticOperations cameraIps={normalizedIps} cameraStatuses={cameraStatuses} />
    </Panel>
  );
}
