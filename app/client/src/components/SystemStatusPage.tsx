import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleOff,
  Cpu,
  FileText,
  Gauge,
  ListChecks,
  Network,
  Play,
  Power,
  RefreshCw,
  Save,
  Settings2,
  SlidersHorizontal,
  StopCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DeviceStatus } from '../data/inspection';
import {
  applyCaptureConfig,
  captureDepthMap,
  connectCaptureCamera,
  createDefaultCaptureCameras,
  createDefaultCaptureConfig,
  disconnectCaptureCamera,
  openCaptureManagementWindow,
  setCaptureParam,
  setCaptureSoftwareTrigger,
  type CaptureAppliedConfig,
  type CaptureCameraConfig,
  type CaptureCameraStatus,
  type CaptureCommandResult,
  type CaptureSnapshot,
} from '../lib/capture-api';
import type { OperationState, SystemAction } from '../state/operations';
import { Panel } from './Panel';

type CaptureView = 'overview' | 'config' | 'logs' | 'api';

const captureViews: Array<{ id: CaptureView; label: string; icon: typeof Gauge }> = [
  { id: 'overview', label: '状态总览', icon: Gauge },
  { id: 'config', label: '配置中心', icon: Settings2 },
  { id: 'logs', label: '日志记录', icon: FileText },
  { id: 'api', label: 'API 管理', icon: Cpu },
];

const stateLabels: Record<string, string> = {
  connected: '已连接',
  discovered: '已发现',
  offline: '离线',
  disabled: '停用',
};

function formatTime(value?: string | null) {
  if (!value) {
    return '-';
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 100000) {
    return new Date(numeric).toLocaleTimeString('zh-CN', { hour12: false });
  }
  return value;
}

function formatNumber(value?: number | null, digits = 1) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '-';
}

function getStatusTone(status: CaptureCameraStatus) {
  if (status.acquisitionState === 'disabled' || status.enabled === false) {
    return 'disabled';
  }
  if (status.connected) {
    if ((status.lostPulseCounter ?? 0) > 0 || (status.bufferOverflowCounter ?? 0) > 0) {
      return 'warning';
    }
    return 'online';
  }
  if (status.acquisitionState === 'discovered') {
    return 'warning';
  }
  return 'offline';
}

function createStatusFromConfig(config: CaptureCameraConfig): CaptureCameraStatus {
  return {
    connected: false,
    deviceId: -1,
    ip: config.ip,
    driverId: config.driverId,
    model: config.modelHint,
    sn: '',
    configId: config.id,
    name: config.name,
    role: config.role,
    enabled: config.enabled,
    acquisitionState: config.enabled ? 'offline' : 'disabled',
    sdkStatus: 'pending',
    fps: null,
    bufferPercent: 0,
    lastFrameTime: null,
    error: config.enabled ? 'not connected' : null,
  };
}

function getStatusLabel(status: CaptureCameraStatus) {
  const state = status.acquisitionState ?? (status.connected ? 'connected' : 'offline');
  return stateLabels[state] ?? state;
}

function getTemperature(status: CaptureCameraStatus) {
  const values = [status.temperatureJ28, status.temperatureJ29, status.temperatureJ30].filter((value): value is number => typeof value === 'number');
  if (values.length === 0) {
    return '-';
  }
  return `${Math.max(...values).toFixed(1)} C`;
}

function isSimulationCapture(capture: CaptureSnapshot) {
  return (
    capture.health?.driverId === 'simulated' ||
    capture.health?.service?.includes('simulated') ||
    capture.cameras.some((camera) => camera.driverId === 'simulated' || camera.source === 'service-fallback') ||
    capture.statuses.some((camera) => camera.driverId === 'simulated' || camera.sdkStatus === 'simulation')
  );
}

function CameraCard({
  status,
  onOpen,
}: {
  status: CaptureCameraStatus;
  onOpen: (ip: string) => void;
}) {
  const tone = getStatusTone(status);

  return (
    <button type="button" className={`capture-camera-card ${tone}`} onClick={() => onOpen(status.ip)}>
      <header>
        <div>
          <strong>{status.name || status.ip}</strong>
          <span>{status.role || status.model || '未配置角色'}</span>
        </div>
        <i>{getStatusLabel(status)}</i>
      </header>
      <dl>
        <div>
          <dt>IP</dt>
          <dd>{status.ip}</dd>
        </div>
        <div>
          <dt>FPS</dt>
          <dd>{formatNumber(status.fps)}</dd>
        </div>
        <div>
          <dt>缓存</dt>
          <dd>{formatNumber(status.bufferPercent, 0)}%</dd>
        </div>
        <div>
          <dt>温度</dt>
          <dd>{getTemperature(status)}</dd>
        </div>
        <div>
          <dt>丢脉冲</dt>
          <dd>{status.lostPulseCounter ?? 0}</dd>
        </div>
        <div>
          <dt>最新帧</dt>
          <dd>{formatTime(status.lastFrameTime)}</dd>
        </div>
      </dl>
      <footer>
        <span>{status.model || '通用相机驱动'}</span>
        <ArrowRight size={16} />
      </footer>
    </button>
  );
}

function ConfigTable({
  config,
  onCreate,
  onChange,
  onApply,
  onReset,
  dirty,
}: {
  config: CaptureAppliedConfig;
  onCreate: () => void;
  onChange: (cameraId: string, patch: Partial<CaptureCameraConfig>) => void;
  onApply: () => void;
  onReset: () => void;
  dirty: boolean;
}) {
  return (
    <Panel
      title="相机配置"
      className="capture-config-panel"
      action={
        <div className="capture-panel-actions">
          <button type="button" onClick={onCreate}>
            <ListChecks size={15} />
            创建配置
          </button>
          <button type="button" onClick={onReset}>
            <RefreshCw size={15} />
            恢复
          </button>
          <button type="button" className={dirty ? 'primary' : ''} onClick={onApply}>
            <Save size={15} />
            应用配置
          </button>
        </div>
      }
    >
      <div className="capture-config-meta">
        <span>当前配置</span>
        <strong>{config.name}</strong>
        <em>{config.applied ? '已应用' : '未应用'}</em>
      </div>
      <div className="capture-config-table-wrap">
        <table className="capture-config-table">
          <thead>
            <tr>
              <th>启用</th>
              <th>相机</th>
              <th>IP</th>
              <th>驱动</th>
              <th>角色</th>
              <th>触发</th>
              <th>曝光</th>
              <th>增益</th>
              <th>行数</th>
            </tr>
          </thead>
          <tbody>
            {config.cameras.map((camera) => (
              <tr key={camera.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={camera.enabled}
                    aria-label={`${camera.name} 启用状态`}
                    onChange={(event) => onChange(camera.id, { enabled: event.target.checked })}
                  />
                </td>
                <td>
                  <input value={camera.name} onChange={(event) => onChange(camera.id, { name: event.target.value })} />
                </td>
                <td>
                  <input value={camera.ip} onChange={(event) => onChange(camera.id, { ip: event.target.value })} />
                </td>
                <td>
                  <select value={camera.driverId} onChange={(event) => onChange(camera.id, { driverId: event.target.value })}>
                    <option value="lvm-nvt">LVM/NVT</option>
                    <option value="generic-gige">Generic GigE</option>
                    <option value="simulated">模拟相机</option>
                  </select>
                </td>
                <td>
                  <input value={camera.role} onChange={(event) => onChange(camera.id, { role: event.target.value })} />
                </td>
                <td>
                  <select value={camera.triggerMode} onChange={(event) => onChange(camera.id, { triggerMode: event.target.value })}>
                    <option value="软件触发">软件触发</option>
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={20000}
                    value={camera.exposureUs}
                    onChange={(event) => onChange(camera.id, { exposureUs: Number(event.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={0}
                    max={16}
                    step={0.1}
                    value={camera.gain}
                    onChange={(event) => onChange(camera.id, { gain: Number(event.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={64}
                    max={8192}
                    value={camera.depthLines}
                    onChange={(event) => onChange(camera.id, { depthLines: Number(event.target.value) })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function CaptureManagementApp({
  status,
  operation,
  capture,
  onAction,
  className = '',
}: {
  status: DeviceStatus;
  operation: OperationState;
  capture: CaptureSnapshot;
  onAction: (action: SystemAction) => void;
  className?: string;
}) {
  const [activeView, setActiveView] = useState<CaptureView>('overview');
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const [localConfig, setLocalConfig] = useState<CaptureAppliedConfig>(() => capture.config ?? createDefaultCaptureConfig());
  const [configDirty, setConfigDirty] = useState(false);
  const [captureRunning, setCaptureRunning] = useState(false);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  const [capturePreview, setCapturePreview] = useState<{ ip: string; url: string; output: string } | null>(null);

  useEffect(() => {
    if (!configDirty) {
      setLocalConfig(capture.config);
    }
  }, [capture.config, configDirty]);

  const overviewStatuses = useMemo(() => {
    const statusesByIp = new Map(capture.statuses.map((item) => [item.ip, item]));
    const configuredIps = new Set(localConfig.cameras.map((camera) => camera.ip));
    return [
      ...localConfig.cameras.map((camera) => ({
        ...createStatusFromConfig(camera),
        ...statusesByIp.get(camera.ip),
        name: statusesByIp.get(camera.ip)?.name ?? camera.name,
        role: statusesByIp.get(camera.ip)?.role ?? camera.role,
        configId: statusesByIp.get(camera.ip)?.configId ?? camera.id,
        enabled: camera.enabled,
      })),
      ...capture.statuses.filter((item) => !configuredIps.has(item.ip)),
    ];
  }, [capture.statuses, localConfig.cameras]);

  const selectedStatus = selectedIp ? overviewStatuses.find((item) => item.ip === selectedIp) ?? null : null;
  const selectedConfig = selectedStatus ? localConfig.cameras.find((camera) => camera.ip === selectedStatus.ip || camera.id === selectedStatus.configId) ?? null : null;
  const connectedCount = overviewStatuses.filter((item) => item.connected).length;
  const enabledCount = localConfig.cameras.filter((camera) => camera.enabled).length;
  const warningCount = overviewStatuses.filter((item) => getStatusTone(item) === 'warning').length;
  const offlineCount = overviewStatuses.filter((item) => getStatusTone(item) === 'offline').length;
  const recentLogs = capture.logs.length > 0 ? capture.logs : operation.events.map((event) => ({ ...event, cameraIp: null }));
  const simulationMode = isSimulationCapture(capture);

  const runCaptureCommand = async (action: () => Promise<CaptureCommandResult>, success: string) => {
    try {
      const result = await action();
      setCaptureMessage(result.code === 0 ? (result.output ? `${success}: ${result.output}` : success) : `指令失败: ${result.code}`);
      if (result.code === 0 && result.imageUrl) {
        setCapturePreview({ ip: result.ip ?? selectedIp ?? '', url: result.imageUrl, output: result.output ?? '' });
      }
    } catch (error) {
      setCaptureMessage(error instanceof Error ? error.message : '指令失败');
    }
  };

  const updateCameraConfig = (cameraId: string, patch: Partial<CaptureCameraConfig>) => {
    setLocalConfig((current) => ({
      ...current,
      applied: false,
      cameras: current.cameras.map((camera) => (camera.id === cameraId ? { ...camera, ...patch } : camera)),
    }));
    setConfigDirty(true);
  };

  const handleCreateConfig = () => {
    const suffix = new Date().toLocaleTimeString('zh-CN', { hour12: false }).replaceAll(':', '');
    setLocalConfig((current) => ({
      ...current,
      id: `config-${Date.now()}`,
      name: `采集配置-${suffix}`,
      applied: false,
      updatedAt: String(Date.now()),
      cameras: createDefaultCaptureCameras(),
    }));
    setConfigDirty(true);
    setActiveView('config');
  };

  const handleApplyConfig = async () => {
    const nextConfig = { ...localConfig, applied: true, updatedAt: String(Date.now()) };
    setLocalConfig(nextConfig);
    setConfigDirty(false);
    await runCaptureCommand(() => applyCaptureConfig(nextConfig), '配置已应用');
  };

  const handleResetConfig = () => {
    setLocalConfig(capture.config);
    setConfigDirty(false);
    setCaptureMessage('配置已恢复到当前应用版本');
  };

  const handleConnectAll = async () => {
    const cameras = localConfig.cameras.filter((camera) => camera.enabled);
    const results = await Promise.allSettled(cameras.map((camera) => connectCaptureCamera(camera.ip)));
    const successCount = results.filter((result) => result.status === 'fulfilled' && result.value.code === 0).length;
    setCaptureMessage(`已下发连接: ${successCount}/${cameras.length}`);
  };

  const handleDisconnectAll = async () => {
    await runCaptureCommand(() => disconnectCaptureCamera(), '全部相机已断开');
  };

  const handleApplySelectedParams = async () => {
    if (!selectedConfig) {
      return;
    }
    await runCaptureCommand(async () => {
      const trigger = await setCaptureSoftwareTrigger(selectedConfig.ip);
      if (trigger.code !== 0) {
        return trigger;
      }
      const exposure = await setCaptureParam('ExposureTime', 'int', selectedConfig.exposureUs, selectedConfig.ip);
      if (exposure.code !== 0) {
        return exposure;
      }
      return setCaptureParam('GainK', 'float', selectedConfig.gain, selectedConfig.ip);
    }, '参数已下发');
  };

  const handleCaptureSelected = async () => {
    if (!selectedConfig) {
      return;
    }
    await runCaptureCommand(
      () => captureDepthMap(selectedConfig.depthLines, `${selectedConfig.outputPath}/depth.png`, selectedConfig.ip),
      '深度图已采集',
    );
  };

  const renderOverview = () => (
    <section className="capture-overview-layout">
      <Panel title="相机状态总览" className="capture-overview-panel">
        <div className="capture-camera-grid">
          {overviewStatuses.map((cameraStatus) => (
            <CameraCard key={`${cameraStatus.configId ?? cameraStatus.ip}-${cameraStatus.ip}`} status={cameraStatus} onOpen={setSelectedIp} />
          ))}
        </div>
      </Panel>
      <Panel title="采集控制" className="capture-control-panel">
        <div className="capture-control-grid">
          <button type="button" onClick={() => void handleConnectAll()}>
            <Network size={16} />
            全部连接
          </button>
          <button type="button" onClick={() => void handleDisconnectAll()}>
            <CircleOff size={16} />
            全部断开
          </button>
          <button type="button" onClick={() => setCaptureRunning(true)}>
            <Play size={16} />
            开始采集
          </button>
          <button type="button" onClick={() => setCaptureRunning(false)}>
            <StopCircle size={16} />
            停止采集
          </button>
          <button type="button" onClick={() => onAction('self-check')}>
            <RefreshCw size={16} />
            刷新状态
          </button>
          <button type="button" onClick={() => void handleApplyConfig()}>
            <Save size={16} />
            应用配置
          </button>
        </div>
        <dl className="capture-driver-facts">
          <div>
            <dt>驱动</dt>
            <dd>{capture.driver.name}</dd>
          </div>
          <div>
            <dt>传输</dt>
            <dd>{capture.driver.transport}</dd>
          </div>
          <div>
            <dt>SDK</dt>
            <dd>{capture.health ? `${capture.health.sdkReady ? '正常' : '异常'} (${capture.health.sdkCode})` : capture.error}</dd>
          </div>
          <div>
            <dt>报警</dt>
            <dd>{status.alarmCount + warningCount}</dd>
          </div>
        </dl>
      </Panel>
      <Panel title="最新事件" className="capture-events-panel">
        <div className="capture-event-list compact">
          {recentLogs.slice(0, 5).map((event) => (
            <div key={event.id} className={event.level}>
              <Activity size={15} />
              <span>{formatTime(event.time)}</span>
              <strong>{event.cameraIp ? `${event.cameraIp} · ${event.message}` : event.message}</strong>
            </div>
          ))}
        </div>
      </Panel>
    </section>
  );

  const renderDetail = () => {
    if (!selectedStatus) {
      return null;
    }

    return (
      <section className="capture-detail-view">
        <header className="capture-detail-header">
          <button type="button" onClick={() => setSelectedIp(null)}>
            <ArrowLeft size={16} />
            返回总览
          </button>
          <div>
            <span>{selectedStatus.role || '单相机详情'}</span>
            <h1>{selectedStatus.name || selectedStatus.ip}</h1>
          </div>
          <i className={getStatusTone(selectedStatus)}>{getStatusLabel(selectedStatus)}</i>
        </header>
        <section className="capture-detail-grid">
          <Panel title="实时状态" className="capture-detail-status-panel">
            <dl className="capture-detail-facts">
              <div>
                <dt>IP</dt>
                <dd>{selectedStatus.ip}</dd>
              </div>
              <div>
                <dt>设备 ID</dt>
                <dd>{selectedStatus.deviceId}</dd>
              </div>
              <div>
                <dt>型号</dt>
                <dd>{selectedStatus.model || '-'}</dd>
              </div>
              <div>
                <dt>序列号</dt>
                <dd>{selectedStatus.sn || '-'}</dd>
              </div>
              <div>
                <dt>FPS</dt>
                <dd>{formatNumber(selectedStatus.fps)}</dd>
              </div>
              <div>
                <dt>缓存</dt>
                <dd>{formatNumber(selectedStatus.bufferPercent, 0)}%</dd>
              </div>
              <div>
                <dt>温度</dt>
                <dd>
                  {selectedStatus.temperatureJ28 === undefined
                    ? '-'
                    : `${selectedStatus.temperatureJ28?.toFixed(1)} / ${selectedStatus.temperatureJ29?.toFixed(1)} / ${selectedStatus.temperatureJ30?.toFixed(1)} C`}
                </dd>
              </div>
              <div>
                <dt>丢脉冲</dt>
                <dd>{selectedStatus.lostPulseCounter ?? 0}</dd>
              </div>
              <div>
                <dt>缓存溢出</dt>
                <dd>{selectedStatus.bufferOverflowCounter ?? 0}</dd>
              </div>
            </dl>
          </Panel>
          <Panel title="配置参数" className="capture-detail-config-panel">
            {selectedConfig ? (
              <div className="capture-detail-form">
                <label>
                  <span>相机名称</span>
                  <input value={selectedConfig.name} onChange={(event) => updateCameraConfig(selectedConfig.id, { name: event.target.value })} />
                </label>
                <label>
                  <span>相机 IP</span>
                  <input value={selectedConfig.ip} onChange={(event) => updateCameraConfig(selectedConfig.id, { ip: event.target.value })} />
                </label>
                <label>
                  <span>驱动</span>
                  <select value={selectedConfig.driverId} onChange={(event) => updateCameraConfig(selectedConfig.id, { driverId: event.target.value })}>
                    <option value="lvm-nvt">LVM/NVT</option>
                    <option value="generic-gige">Generic GigE</option>
                    <option value="simulated">模拟相机</option>
                  </select>
                </label>
                <label>
                  <span>触发模式</span>
                  <select value={selectedConfig.triggerMode} onChange={(event) => updateCameraConfig(selectedConfig.id, { triggerMode: event.target.value })}>
                    <option value="软件触发">软件触发</option>
                  </select>
                </label>
                <label>
                  <span>曝光 us</span>
                  <input
                    type="number"
                    min={1}
                    max={20000}
                    value={selectedConfig.exposureUs}
                    onChange={(event) => updateCameraConfig(selectedConfig.id, { exposureUs: Number(event.target.value) })}
                  />
                </label>
                <label>
                  <span>增益</span>
                  <input
                    type="number"
                    min={0}
                    max={16}
                    step={0.1}
                    value={selectedConfig.gain}
                    onChange={(event) => updateCameraConfig(selectedConfig.id, { gain: Number(event.target.value) })}
                  />
                </label>
                <label>
                  <span>深度行数</span>
                  <input
                    type="number"
                    min={64}
                    max={8192}
                    value={selectedConfig.depthLines}
                    onChange={(event) => updateCameraConfig(selectedConfig.id, { depthLines: Number(event.target.value) })}
                  />
                </label>
                <label>
                  <span>输出路径</span>
                  <input value={selectedConfig.outputPath} onChange={(event) => updateCameraConfig(selectedConfig.id, { outputPath: event.target.value })} />
                </label>
              </div>
            ) : (
              <div className="capture-empty-state">该相机尚未加入当前配置</div>
            )}
          </Panel>
          <Panel title="单相机控制" className="capture-detail-control-panel">
            <div className="capture-control-grid single">
              <button type="button" onClick={() => void runCaptureCommand(() => connectCaptureCamera(selectedStatus.ip), '相机已连接')}>
                <Power size={16} />
                连接
              </button>
              <button type="button" onClick={() => void runCaptureCommand(() => disconnectCaptureCamera(selectedStatus.ip), '相机已断开')}>
                <CircleOff size={16} />
                断开
              </button>
              <button type="button" onClick={() => void handleApplySelectedParams()} disabled={!selectedConfig}>
                <SlidersHorizontal size={16} />
                下发参数
              </button>
              <button type="button" onClick={() => void handleCaptureSelected()} disabled={!selectedConfig || !selectedStatus.connected}>
                <Gauge size={16} />
                采集深度图
              </button>
              <button type="button" onClick={() => void handleApplyConfig()}>
                <Save size={16} />
                应用配置
              </button>
              <button type="button" onClick={() => setCaptureMessage('设备复位指令已记录')}>
                <RefreshCw size={16} />
                复位设备
              </button>
            </div>
          </Panel>
          {capturePreview && (!capturePreview.ip || capturePreview.ip === selectedStatus.ip) ? (
            <Panel title="最近采集预览" className="capture-depth-preview-panel">
              <div className="capture-depth-preview">
                <img src={capturePreview.url} alt={`${selectedStatus.name || selectedStatus.ip} depth map`} />
                <span>{capturePreview.output}</span>
              </div>
            </Panel>
          ) : null}
          <Panel title="相机日志" className="capture-detail-log-panel">
            <div className="capture-event-list">
              {recentLogs
                .filter((event) => !event.cameraIp || event.cameraIp === selectedStatus.ip)
                .slice(0, 8)
                .map((event) => (
                  <div key={event.id} className={event.level}>
                    <Activity size={15} />
                    <span>{formatTime(event.time)}</span>
                    <strong>{event.message}</strong>
                  </div>
                ))}
            </div>
          </Panel>
        </section>
      </section>
    );
  };

  return (
      <section className={`capture-management-shell ${className}`.trim()}>
        <aside className="capture-side-nav">
          <strong>采集管理</strong>
          {captureViews.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={!selectedIp && activeView === item.id ? 'active' : ''}
                onClick={() => {
                  setSelectedIp(null);
                  setActiveView(item.id);
                }}
              >
                <Icon size={17} />
                {item.label}
              </button>
            );
          })}
        </aside>
        <section className={`capture-main ${simulationMode ? 'has-mode-banner' : ''}`}>
          <header className={`capture-command-header ${simulationMode ? 'with-mode-banner' : ''}`}>
            {simulationMode ? (
              <div className="capture-mode-banner simulated">
                <AlertTriangle size={18} />
                <div>
                  <strong>模拟模式</strong>
                  <span>当前采集数据来自服务兜底模拟，不是相机 SDK 的真实采集结果。</span>
                </div>
              </div>
            ) : null}
            <div className="capture-workflow">
              <span>选择配置</span>
              <i />
              <span>应用配置</span>
              <i />
              <span>相机总览</span>
              <i />
              <span>进入详情</span>
            </div>
            <div className="capture-status-strip">
              <div>
                <span>当前配置</span>
                <strong>{localConfig.name}</strong>
              </div>
              <div>
                <span>应用状态</span>
                <strong>{localConfig.applied && !configDirty ? '已应用' : '待应用'}</strong>
              </div>
              <div>
                <span>在线相机</span>
                <strong>
                  {connectedCount}/{enabledCount}
                </strong>
              </div>
              <div>
                <span>采集状态</span>
                <strong>{captureRunning ? '运行' : '待机'}</strong>
              </div>
              <div>
                <span>SDK</span>
                <strong>{capture.health?.sdkReady ? '正常' : '等待'}</strong>
              </div>
              <div>
                <span>报警</span>
                <strong>{offlineCount + warningCount}</strong>
              </div>
            </div>
          </header>

          {captureMessage ? (
            <div className="capture-message">
              <CheckCircle2 size={16} />
              <span>{captureMessage}</span>
            </div>
          ) : null}

          {selectedIp ? (
            renderDetail()
          ) : activeView === 'overview' ? (
            renderOverview()
          ) : activeView === 'config' ? (
            <ConfigTable
              config={localConfig}
              dirty={configDirty}
              onCreate={handleCreateConfig}
              onChange={updateCameraConfig}
              onApply={() => void handleApplyConfig()}
              onReset={handleResetConfig}
            />
          ) : activeView === 'logs' ? (
            <Panel title="采集日志" className="capture-log-panel">
              <div className="capture-event-list">
                {recentLogs.map((event) => (
                  <div key={event.id} className={event.level}>
                    <Activity size={15} />
                    <span>{formatTime(event.time)}</span>
                    <strong>{event.cameraIp ? `${event.cameraIp} · ${event.message}` : event.message}</strong>
                  </div>
                ))}
              </div>
            </Panel>
          ) : (
            <Panel title="驱动与 API 能力" className="capture-api-panel">
              <div className="capture-api-layout">
                <section>
                  <h3>驱动抽象</h3>
                  <dl className="capture-driver-facts">
                    <div>
                      <dt>驱动 ID</dt>
                      <dd>{capture.driver.id}</dd>
                    </div>
                    <div>
                      <dt>驱动名称</dt>
                      <dd>{capture.driver.name}</dd>
                    </div>
                    <div>
                      <dt>厂商</dt>
                      <dd>{capture.driver.vendor}</dd>
                    </div>
                    <div>
                      <dt>支持型号</dt>
                      <dd>{capture.driver.supportedModels.join(' / ')}</dd>
                    </div>
                  </dl>
                </section>
                <section>
                  <h3>控制 API</h3>
                  <div className="capture-api-list">
                    {capture.capabilities.api.map((api) => (
                      <div key={`${api.method}-${api.path}`}>
                        <span>{api.method}</span>
                        <strong>{api.path}</strong>
                        <em>{api.label}</em>
                      </div>
                    ))}
                  </div>
                </section>
                <section>
                  <h3>参数能力</h3>
                  <div className="capture-param-list">
                    {capture.capabilities.parameters.map((param) => (
                      <div key={param.key}>
                        <strong>{param.label}</strong>
                        <span>{param.key}</span>
                        <em>
                          {param.valueType} · {param.unit || '-'}
                        </em>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </Panel>
          )}
        </section>
      </section>
  );
}

export function SystemStatusPage({
  status,
  operation,
  capture,
  onAction,
}: {
  status: DeviceStatus;
  operation: OperationState;
  capture: CaptureSnapshot;
  onAction: (action: SystemAction) => void;
}) {
  const [embeddedManager, setEmbeddedManager] = useState(false);
  const [terminalMessage, setTerminalMessage] = useState<string | null>(null);
  const config = capture.config ?? createDefaultCaptureConfig();
  const overviewStatuses = useMemo(() => {
    const statusesByIp = new Map(capture.statuses.map((item) => [item.ip, item]));
    return config.cameras.map((camera) => ({
      ...createStatusFromConfig(camera),
      ...statusesByIp.get(camera.ip),
      name: statusesByIp.get(camera.ip)?.name ?? camera.name,
      role: statusesByIp.get(camera.ip)?.role ?? camera.role,
      configId: statusesByIp.get(camera.ip)?.configId ?? camera.id,
      enabled: camera.enabled,
    }));
  }, [capture.statuses, config.cameras]);
  const enabledCount = config.cameras.filter((camera) => camera.enabled).length;
  const connectedCount = overviewStatuses.filter((camera) => camera.connected).length;
  const warningCount = overviewStatuses.filter((camera) => getStatusTone(camera) === 'warning').length;
  const offlineCount = overviewStatuses.filter((camera) => getStatusTone(camera) === 'offline').length;
  const recentLogs = capture.logs.length > 0 ? capture.logs : operation.events.map((event) => ({ ...event, cameraIp: null }));
  const simulationMode = isSimulationCapture(capture);

  const openIndependentManager = async () => {
    try {
      await openCaptureManagementWindow();
      setTerminalMessage('已打开独立采集管理窗口');
    } catch (error) {
      setTerminalMessage(error instanceof Error ? error.message : '独立采集管理窗口打开失败');
    }
  };

  if (embeddedManager) {
    return (
      <main className="workspace-page capture-page capture-terminal-page">
        <div className="capture-terminal-embed-bar">
          <div>
            <span>终端内嵌模式</span>
            <strong>真实采集管理界面</strong>
          </div>
          <button type="button" onClick={() => setEmbeddedManager(false)}>
            <ArrowLeft size={16} />
            返回轻量概览
          </button>
        </div>
        <CaptureManagementApp
          status={status}
          operation={operation}
          capture={capture}
          onAction={onAction}
          className="embedded-capture-manager"
        />
      </main>
    );
  }

  return (
    <main className="workspace-page capture-terminal-page">
      <section className="capture-terminal-layout">
        <Panel title="采集状态概览" className="capture-terminal-overview-panel">
          {simulationMode ? (
            <div className="capture-mode-banner simulated compact">
              <AlertTriangle size={18} />
              <div>
                <strong>模拟模式</strong>
                <span>当前状态由服务 fallback 生成，真实相机采集服务尚未接管。</span>
              </div>
            </div>
          ) : null}
          <div className="capture-terminal-summary">
            <div>
              <span>当前配置</span>
              <strong>{config.name}</strong>
            </div>
            <div>
              <span>在线相机</span>
              <strong>
                {connectedCount}/{enabledCount}
              </strong>
            </div>
            <div>
              <span>SDK</span>
              <strong>{capture.health?.sdkReady ? '正常' : '等待'}</strong>
            </div>
            <div>
              <span>异常</span>
              <strong>{offlineCount + warningCount + status.alarmCount}</strong>
            </div>
          </div>
          <div className="capture-terminal-camera-list">
            {overviewStatuses.map((camera) => (
              <button key={`${camera.configId}-${camera.ip}`} type="button" onClick={() => setEmbeddedManager(true)}>
                <i className={getStatusTone(camera)} />
                <strong>{camera.name || camera.ip}</strong>
                <span>{camera.ip}</span>
                <em>{getStatusLabel(camera)}</em>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="采集管理入口" className="capture-terminal-entry-panel">
          <div className="capture-terminal-entry-actions">
            <button type="button" className="primary" onClick={() => void openIndependentManager()}>
              <ArrowRight size={16} />
              打开独立采集管理
            </button>
            <button type="button" onClick={() => setEmbeddedManager(true)}>
              <Gauge size={16} />
              内嵌真实管理界面
            </button>
            <button type="button" onClick={() => onAction('self-check')}>
              <RefreshCw size={16} />
              刷新终端状态
            </button>
          </div>
          <dl className="capture-terminal-facts">
            <div>
              <dt>内置驱动</dt>
              <dd>{capture.driver.name}</dd>
            </div>
            <div>
              <dt>驱动抽象</dt>
              <dd>{capture.driver.features.join(' / ')}</dd>
            </div>
            <div>
              <dt>终端显示</dt>
              <dd>轻量概览，完整管理在独立应用</dd>
            </div>
          </dl>
          {terminalMessage ? <strong className="capture-terminal-message">{terminalMessage}</strong> : null}
        </Panel>

        <Panel title="最近采集事件" className="capture-terminal-log-panel">
          <div className="capture-event-list compact">
            {recentLogs.slice(0, 6).map((event) => (
              <div key={event.id} className={event.level}>
                <Activity size={15} />
                <span>{formatTime(event.time)}</span>
                <strong>{event.cameraIp ? `${event.cameraIp} · ${event.message}` : event.message}</strong>
              </div>
            ))}
          </div>
        </Panel>
      </section>
    </main>
  );
}
