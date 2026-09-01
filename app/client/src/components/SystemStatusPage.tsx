import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Box,
  CheckCircle2,
  CircleOff,
  Cpu,
  FileText,
  FolderOpen,
  Gauge,
  ListChecks,
  Network,
  Pause,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  SlidersHorizontal,
  StopCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeviceStatus } from '../data/inspection';
import { openBarSurfaceWindow, openCaptureManagementWindow } from '../lib/app-windows';
import type { AcquisitionMode } from '../lib/acquisition-mode';
import type { PublicRuntimeSimulationConfig, RuntimeCapabilities } from '../services/runtime-profile-api';
import {
  captureProductionOnce,
  fetchProductionStatus,
  fetchTriggerGatewayStatus,
  setTriggerGatewayMode,
  triggerGatewayManualSteelIn,
  triggerGatewayManualSteelInfo,
  triggerGatewayManualSteelOut,
  writeProductionSecondaryData,
  waitForProductionCommandTask,
  type ProductionCommandResult,
  type ProductionStatus,
  type TriggerGatewayMode,
  type TriggerGatewayStatus,
} from '../services/inspection-api';
import {
  applyCaptureConfig,
  applyCaptureContinuousSettings,
  captureStreamImageUrl,
  captureDepthMap,
  connectCaptureCamera,
  createDefaultCaptureCameras,
  createDefaultCaptureConfig,
  disconnectCaptureCamera,
  openCaptureLocalPath,
  readCaptureCameraStatuses,
  readCaptureContinuousSettings,
  readCaptureSimulationStatus,
  readLatestCaptureFile,
  setCaptureParam,
  setCaptureSoftwareTrigger,
  saveCapturePreviewFromUrl,
  pauseCaptureSimulation,
  resetCaptureSimulation,
  resumeCaptureSimulation,
  setCaptureOutputMode as applyCaptureOutputMode,
  startCaptureStream,
  startCaptureSimulation,
  stopCaptureStream,
  validateCaptureContinuousSettings,
  validateCaptureStreamStartOptions,
  type CaptureAppliedConfig,
  type CaptureCameraConfig,
  type CaptureCameraStatus,
  type CaptureCommandResult,
  type CaptureContinuousSettingsStatus,
  type CaptureImageKind,
  type CaptureLogEvent,
  type CaptureOutputMode,
  type CaptureSnapshot,
  type CaptureSimulationStatus,
  type CaptureStreamStartOptions,
} from '../lib/capture-api';
import type { OperationState, SystemAction } from '../state/operations';
import { CaptureOperationsPanel } from './CaptureOperationsPanel';
import { Panel } from './Panel';

type CaptureView = 'overview' | 'config' | 'logs' | 'api' | 'trigger';
type CaptureDetailTab = 'status' | 'capture' | 'image' | 'sdk';

const captureViews: Array<{ id: CaptureView; label: string; icon: typeof Gauge }> = [
  { id: 'overview', label: '状态总览', icon: Gauge },
  { id: 'config', label: '配置中心', icon: Settings2 },
  { id: 'logs', label: '日志记录', icon: FileText },
  { id: 'api', label: 'API 管理', icon: Cpu },
  { id: 'trigger', label: '触发设置', icon: Network },
];

const globalTriggerModes: Array<{ mode: TriggerGatewayMode; label: string; detail: string }> = [
  { mode: 'api', label: '外触发', detail: 'PLC / 外部 API 信号' },
  { mode: 'tcp', label: 'TCP 触发', detail: '长连接逐行 JSON 触发' },
  { mode: 'udp', label: 'UDP 触发', detail: '单数据报 JSON 触发' },
  { mode: 'secondary', label: '内触发', detail: '内部二级系统信号' },
  { mode: 'manual', label: '手动触发', detail: '由操作员控制进钢、出钢' },
  { mode: 'gray', label: '灰度触发', detail: '灰度信号兼容模式' },
];

const captureOutputModes: Array<{ mode: CaptureOutputMode; label: string; detail: string }> = [
  { mode: 'continuous', label: '连续出图', detail: '相机持续采集，进出钢仅控制保存' },
  { mode: 'on-demand', label: '按需出图', detail: '仅由手动采集或生产任务触发' },
  { mode: 'disabled', label: '停止出图', detail: '不自动请求相机帧' },
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

function captureKindLabel(kind: CaptureImageKind) {
  switch (kind) {
    case 'intensity': return '亮度图';
    case 'metadata': return '元数据';
    case 'sdk-derived': return 'SDK 派生图';
    default: return '深度图';
  }
}

const CAPTURE_CLIENT_LOG_LIMIT = 80;
const CAPTURE_VISIBLE_LOG_LIMIT = 100;

export function prependBoundedCaptureLog(
  logs: CaptureLogEvent[],
  event: CaptureLogEvent,
  limit = CAPTURE_CLIENT_LOG_LIMIT,
) {
  return [event, ...logs].slice(0, Math.max(1, limit));
}

export function mergeCaptureLogEvents(
  providerLogs: CaptureLogEvent[],
  systemEvents: OperationState['events'],
  clientLogs: CaptureLogEvent[] = [],
) {
  const candidates: CaptureLogEvent[] = [
    ...clientLogs.slice(0, CAPTURE_CLIENT_LOG_LIMIT),
    ...systemEvents.slice(0, 15).map((event) => ({
      ...event,
      source: 'system-operation' as const,
      cameraIp: null,
    })),
    ...providerLogs.slice(0, 5).map((event) => ({
      ...event,
      source: event.source ?? 'provider-snapshot',
    })),
  ];
  const seen = new Set<string>();
  return candidates.filter((event) => {
    const key = `${event.source || 'unknown'}:${event.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, CAPTURE_VISIBLE_LOG_LIMIT);
}

function captureLogSourceLabel(source?: CaptureLogEvent['source']) {
  switch (source) {
    case 'provider-log': return '采集服务';
    case 'client-operation': return '前端操作';
    case 'system-operation': return '系统操作';
    default: return 'Provider 快照';
  }
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

function createProductionMaterialId() {
  const now = new Date();
  return `BAR-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
}

function providerValue(capture: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!capture) {
    return '';
  }
  for (const key of keys) {
    const value = capture[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
  }
  return '';
}

function providerNumber(capture: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!capture) {
    return undefined;
  }
  for (const key of keys) {
    const value = capture[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
  }
  return undefined;
}

function providerRecord(capture: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!capture) {
    return undefined;
  }
  for (const key of keys) {
    const value = capture[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function continuousLineTriggerRateFromProductionStatus(capture: Record<string, unknown> | null | undefined) {
  const settings = providerRecord(capture, ['continuousSettings', 'continuous_settings']);
  return providerNumber(settings, ['lineTriggerFrequency', 'line_trigger_frequency', 'timeTriggerFreq', 'time_trigger_freq'])
    ?? providerNumber(capture, ['lineTriggerFrequency', 'line_trigger_frequency', 'timeTriggerFreq', 'time_trigger_freq']);
}

function isCaptureOutputMode(value: string): value is CaptureOutputMode {
  return value === 'continuous' || value === 'on-demand' || value === 'disabled';
}

function triggerGatewayModeLabel(mode?: string) {
  switch (mode) {
    case 'manual':
      return '手动';
    case 'gray':
      return '灰度';
    case 'secondary':
      return '二级';
    case 'api':
      return 'API';
    default:
      return mode || '离线';
  }
}

function getStatusTone(status: CaptureCameraStatus) {
  if (status.acquisitionState === 'disabled' || status.enabled === false) {
    return 'disabled';
  }
  if (status.connected) {
    const recentFrameDrops = status.transportFrameGapCount
      ?? status.lostPulseCounter
      ?? 0;
    if (recentFrameDrops > 0 || (status.bufferOverflowCounter ?? 0) > 0) {
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
    continuousFps: null,
    continuousFrameCount: 0,
    lastContinuousFrameAt: null,
    continuousAcquiring: false,
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
  const values = [
    status.deviceTemperature,
    status.temperatureJ28,
    status.temperatureJ29,
    status.temperatureJ30,
  ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) {
    return '-';
  }
  return `${Math.max(...values).toFixed(1)} C`;
}

function getTemperatureDetail(status: CaptureCameraStatus) {
  const current = getTemperature(status);
  if (current === '-') {
    return current;
  }
  const minimum = status.deviceTemperatureMin;
  const maximum = status.deviceTemperatureMax;
  return typeof minimum === 'number' && typeof maximum === 'number'
    ? `${current}（设备范围 ${minimum.toFixed(1)}–${maximum.toFixed(1)} C）`
    : current;
}

function getRecentFrameDropCount(status: CaptureCameraStatus) {
  return status.transportFrameGapCount ?? status.lostPulseCounter;
}

function getFrameDropReview(status: CaptureCameraStatus) {
  const drops = getRecentFrameDropCount(status);
  if (drops === undefined) {
    return '-';
  }
  const rounds = status.synchronizationWindowRounds;
  return `${drops} 帧${rounds ? ` / 最近 ${rounds} 轮` : ''}`;
}

function isSimulationCapture(capture: CaptureSnapshot) {
  // Formal data replay is identified only by the acquisition runtime mode.
  // The development connection can still use a simulated provider while the
  // formal mode remains online, and must not acquire replay semantics.
  return Boolean(
    capture.health
      && 'runtimeMode' in capture.health
      && capture.health.runtimeMode === 'simulation',
  );
}

function simulationProgressPercent(progress?: number | null) {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return 0;
  const percent = progress <= 1 ? progress * 100 : progress;
  return Math.max(0, Math.min(100, percent));
}

function formatSimulationDuration(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '--:--';
  const seconds = Math.floor(value / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

const simulationStateLabels: Record<CaptureSimulationStatus['state'], string> = {
  idle: '待机',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  error: '异常',
};

export function SimulationControlPanel({
  initialStatus = null,
  simulationConfig,
}: {
  initialStatus?: CaptureSimulationStatus | null;
  simulationConfig?: PublicRuntimeSimulationConfig;
}) {
  const [simulation, setSimulation] = useState<CaptureSimulationStatus | null>(initialStatus);
  const [speed, setSpeed] = useState(simulationConfig?.speed ?? initialStatus?.speed ?? 1);
  const [loop, setLoop] = useState(simulationConfig?.loop ?? initialStatus?.loop ?? false);
  const [gapMs, setGapMs] = useState(simulationConfig?.interSessionGapMs ?? initialStatus?.sessionGapMs ?? 1_500);
  const [busyAction, setBusyAction] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (initialStatus) setSimulation(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    const refresh = async () => {
      if (polling) return;
      polling = true;
      try {
        const next = await readCaptureSimulationStatus(controller.signal);
        if (!controller.signal.aborted) {
          setSimulation(next);
          setError('');
        }
      } catch (nextError) {
        if (!controller.signal.aborted) {
          setError(nextError instanceof Error ? nextError.message : '模拟采集状态读取失败');
        }
      } finally {
        polling = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  const runControl = async (
    action: 'start' | 'pause' | 'resume' | 'reset',
    request: () => Promise<CaptureSimulationStatus>,
  ) => {
    setBusyAction(action);
    setMessage('');
    setError('');
    try {
      const next = await request();
      setSimulation(next);
      setMessage(action === 'start' ? '模拟采集已启动' : action === 'pause' ? '模拟采集已暂停' : action === 'resume' ? '模拟采集已恢复' : '模拟采集已复位');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '模拟采集控制失败');
    } finally {
      setBusyAction('');
    }
  };

  const progress = simulationProgressPercent(simulation?.progress);
  const sourceAvailable = simulation?.sourceAvailable ?? simulationConfig?.configured ?? false;
  const state = simulation?.state ?? 'idle';
  const channels = simulation?.channels ?? [];

  return (
    <section className="simulation-control-panel" aria-label="模拟采集控制">
      <header>
        <div>
          <span>模拟采集</span>
          <strong>{simulationStateLabels[state]}</strong>
        </div>
        <em className={sourceAvailable ? 'ready' : 'warning'}>{sourceAvailable ? '数据源就绪' : '数据源不可用'}</em>
      </header>
      <div className="simulation-source-summary">
        <span>数据目录</span>
        <strong title={simulation?.sourceRoot || undefined}>{simulation?.sourceRoot || (simulationConfig?.configured ? '已配置（路径受保护）' : '未配置')}</strong>
        <dl className="simulation-source-evidence">
          <div>
            <dt>数据集 ID</dt>
            <dd title={simulation?.sourceDatasetId || undefined}>{simulation?.sourceDatasetId || '--'}</dd>
          </div>
          <div>
            <dt>当前会话</dt>
            <dd title={simulation?.currentSessionId || undefined}>{simulation?.currentSessionId || '--'}</dd>
          </div>
          <div>
            <dt>可用会话</dt>
            <dd>
              {simulation?.usableSessionCount ?? simulation?.sessionCount ?? 0}
              {' / '}{simulation?.candidateSessionCount ?? simulation?.sessionCount ?? 0}
            </dd>
          </div>
          <div>
            <dt>拒绝项</dt>
            <dd>{simulation?.rejectedSessionCount ?? 0} 会话 · {simulation?.rejectedTrackCount ?? 0} 通道</dd>
          </div>
        </dl>
        <em>已采集数据仅作为模拟输入，不计入物理相机在线数</em>
      </div>
      <div className="simulation-progress" aria-label={`模拟进度 ${Math.round(progress)}%`}>
        <div><span>播放进度</span><strong>{Math.round(progress)}%</strong></div>
        <i style={{ '--simulation-progress': `${progress}%` } as React.CSSProperties} />
        <p>
          {formatSimulationDuration(simulation?.positionMs)} / {formatSimulationDuration(simulation?.durationMs)}
          {' · '}批次 {simulation?.currentSessionIndex != null && simulation.currentSessionIndex >= 0 ? simulation.currentSessionIndex + 1 : 0}/{simulation?.sessionCount ?? 0}
          {simulation?.currentCoilId ? ` · ${simulation.currentCoilId}` : ''}
        </p>
      </div>
      <div className="simulation-control-settings">
        <label><span>播放速度</span><input aria-label="模拟控制播放速度" type="number" min={0.25} max={4} step={0.25} value={speed} disabled={state === 'running'} onChange={(event) => setSpeed(Number(event.target.value))} /></label>
        <label><span>批次间隔 ms</span><input aria-label="模拟控制批次间隔" type="number" min={1_001} max={3_600_000} step={100} value={gapMs} disabled={state === 'running'} onChange={(event) => setGapMs(Number(event.target.value))} /></label>
        <label className="simulation-loop-control"><input aria-label="模拟控制循环播放" type="checkbox" checked={loop} disabled={state === 'running'} onChange={(event) => setLoop(event.target.checked)} /><span>循环播放</span></label>
      </div>
      <div className="simulation-control-actions">
        <button type="button" className="primary" disabled={Boolean(busyAction) || !sourceAvailable || state === 'running'} onClick={() => void runControl('start', () => startCaptureSimulation({ speed, loop, sessionGapMs: gapMs }))}><Play size={15} />启动</button>
        <button type="button" disabled={Boolean(busyAction) || state !== 'running'} onClick={() => void runControl('pause', () => pauseCaptureSimulation())}><Pause size={15} />暂停</button>
        <button type="button" disabled={Boolean(busyAction) || state !== 'paused'} onClick={() => void runControl('resume', () => resumeCaptureSimulation())}><Play size={15} />继续</button>
        <button type="button" disabled={Boolean(busyAction) || state === 'idle'} onClick={() => void runControl('reset', () => resetCaptureSimulation())}><RotateCcw size={15} />复位</button>
      </div>
      {channels.length ? (
        <div className="simulation-channel-grid" aria-label="模拟通道状态">
          {channels.map((channel) => (
            <div key={`${channel.cameraId}-${channel.cameraKey}`}>
              <strong>{channel.cameraKey || `模拟通道 ${channel.cameraId}`}</strong>
              <span>模拟通道 · {channel.sourceFlow || '数据回放'}</span>
              <em>{channel.frameIndex >= 0 ? channel.frameIndex + 1 : 0}/{channel.frameCount} 帧</em>
            </div>
          ))}
        </div>
      ) : <div className="simulation-empty-channels">等待模拟数据集提供通道</div>}
      {simulation?.lastError ? <p className="simulation-control-error">{simulation.lastError}</p> : null}
      {error ? <p className="simulation-control-error" role="alert">{error}</p> : null}
      {message ? <p className="simulation-control-message" role="status">{message}</p> : null}
    </section>
  );
}

function sdkValue(value: number | string | undefined, unit = '') {
  if (value === undefined || value === '') {
    return '-';
  }
  return `${value}${unit}`;
}

function sdkSwitch(value?: number) {
  if (value === undefined) {
    return '-';
  }
  return `${value === 0 ? '关闭' : '开启'} (${value})`;
}

function CaptureSdkReadback({ status }: { status: CaptureCameraStatus }) {
  const config = status.captureConfig;
  return (
    <section className="capture-sdk-readback" aria-label="SDK 参数读回">
      <header>
        <strong>SDK 参数读回</strong>
        <span>{config?.available ? '设备当前生效值' : 'SDK 暂无可用参数块'}</span>
      </header>
      <dl>
        <div><dt>available</dt><dd>{config?.available ? '是' : '否'}</dd></div>
        <div><dt>controlMode</dt><dd>{config?.controlMode === undefined ? '-' : `${config.controlLabel || '-'} (${config.controlMode})`}</dd></div>
        <div><dt>ctrlType</dt><dd>{sdkValue(config?.ctrlType)}</dd></div>
        <div><dt>triggerInputType</dt><dd>{config?.triggerInputType === undefined ? '-' : `${config.triggerSourceLabel || '-'} (${config.triggerInputType})`}</dd></div>
        <div><dt>captureDataType</dt><dd>{sdkValue(config?.captureDataType)}</dd></div>
        <div><dt>triggerLines</dt><dd>{sdkValue(config?.triggerLines, ' line')}</dd></div>
        <div><dt>divRatio</dt><dd>{sdkValue(config?.divRatio)}</dd></div>
        <div><dt>timeTriggerFreq</dt><dd>{sdkValue(config?.timeTriggerFreq, ' Hz')}</dd></div>
        <div><dt>maxFrameRate</dt><dd>{sdkValue(config?.maxFrameRate, ' fps')}</dd></div>
        <div><dt>exposureTime</dt><dd>{sdkValue(config?.exposureTime, ' us')}</dd></div>
        <div><dt>gainK</dt><dd>{sdkValue(config?.gainK)}</dd></div>
        <div><dt>laserEnable</dt><dd>{sdkSwitch(config?.laserEnable)}</dd></div>
        <div><dt>laserPower</dt><dd>{sdkValue(config?.laserPower, '%')}</dd></div>
        <div><dt>laserLineSelect</dt><dd>{sdkValue(config?.laserLineSelect)}</dd></div>
        <div><dt>arrayEnable</dt><dd>{sdkSwitch(config?.arrayEnable)}</dd></div>
      </dl>
      <p>只读值来自 C++ 独占 SDK 会话；arrayEnable 是运行开关，不代表已执行阵列标定下发。</p>
    </section>
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
  const previewActive = Boolean(status.streamRunning);

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
          <dt>连续 FPS</dt>
          <dd>{formatNumber(status.continuousFps)}</dd>
        </div>
        <div>
          <dt>{previewActive ? '预览 FPS' : '采集帧数'}</dt>
          <dd>{previewActive ? formatNumber(status.streamFps) : (status.continuousFrameCount ?? '-')}</dd>
        </div>
        <div>
          <dt>温度</dt>
          <dd>{getTemperature(status)}</dd>
        </div>
        <div>
          <dt>最近丢帧</dt>
          <dd>{getRecentFrameDropCount(status) ?? '-'}</dd>
        </div>
        <div>
          <dt>最近采集</dt>
          <dd>{formatTime(status.lastContinuousFrameAt ?? status.lastFrameTime)}</dd>
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
  expectedCameraCount = capture.config?.cameras.length ?? capture.statuses.length,
  acquisitionMode = 'online',
  simulationConfig,
  onAction,
  className = '',
}: {
  status: DeviceStatus;
  operation: OperationState;
  capture: CaptureSnapshot;
  expectedCameraCount?: number;
  acquisitionMode?: AcquisitionMode;
  simulationConfig?: PublicRuntimeSimulationConfig;
  onAction: (action: SystemAction) => void;
  className?: string;
}) {
  const runtimeCameraCount = Number.isFinite(expectedCameraCount)
    ? Math.max(1, Math.trunc(expectedCameraCount))
    : Math.max(1, capture.config?.cameras.length ?? capture.statuses.length);
  const showReturnToTerminal = className.split(/\s+/).includes('standalone-capture-manager');
  const embeddedMode = className.split(/\s+/).includes('embedded-capture-manager');
  const simulationMode = acquisitionMode === 'simulation' || isSimulationCapture(capture);
  const [activeView, setActiveView] = useState<CaptureView>('overview');
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<CaptureDetailTab>('status');
  const [localConfig, setLocalConfig] = useState<CaptureAppliedConfig>(() => capture.config ?? createDefaultCaptureConfig());
  const [configDirty, setConfigDirty] = useState(false);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  const [capturePreview, setCapturePreview] = useState<{
    ip: string;
    kind: CaptureImageKind;
    url: string;
    output: string;
    content?: string;
  } | null>(null);
  const [previewKind, setPreviewKind] = useState<CaptureImageKind>('depth');
  const [previewMode, setPreviewMode] = useState<'latest' | 'stream'>('latest');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRefreshToken, setPreviewRefreshToken] = useState(0);
  const [previewStreamOptions, setPreviewStreamOptions] = useState({
    width: 0,
    dataMode: 3,
    fpsLimit: 5,
    hs: false,
  });
  const [clientOperationLogs, setClientOperationLogs] = useState<CaptureLogEvent[]>([]);
  const clientLogSequence = useRef(0);
  const [productionStatus, setProductionStatus] = useState<ProductionStatus | null>(null);
  const [triggerGatewayStatus, setTriggerGatewayStatus] = useState<TriggerGatewayStatus | null>(null);
  const [productionMode, setProductionMode] = useState<TriggerGatewayMode>('api');
  const [captureOutputMode, setCaptureOutputMode] = useState<CaptureOutputMode>('continuous');
  const [continuousLineTriggerFreq, setContinuousLineTriggerFreq] = useState(300);
  const [continuousLineTriggerFreqTouched, setContinuousLineTriggerFreqTouched] = useState(false);
  const [continuousSettingsStatus, setContinuousSettingsStatus] = useState<CaptureContinuousSettingsStatus | null>(null);
  const [continuousSettingsBusy, setContinuousSettingsBusy] = useState(false);
  const [continuousSettingsMessage, setContinuousSettingsMessage] = useState<string | null>(null);
  const [manualSimulationSeconds, setManualSimulationSeconds] = useState(30);
  const [triggerSecondaryData, setTriggerSecondaryData] = useState('{\n  "heatNo": "",\n  "grade": "Q355B"\n}');
  const [triggerTestOptions, setTriggerTestOptions] = useState({
    writeSecondaryDataOnSteelIn: true,
    generateTestData: false,
  });
  const [manualTriggerPhase, setManualTriggerPhase] = useState('待命');
  const [productionBusy, setProductionBusy] = useState(false);
  const [triggerGatewayBusy, setTriggerGatewayBusy] = useState(false);
  const [captureModeBusy, setCaptureModeBusy] = useState(false);
  const [productionMessage, setProductionMessage] = useState<string | null>(null);
  const [triggerGatewayMessage, setTriggerGatewayMessage] = useState<string | null>(null);
  const [productionDraftTouched, setProductionDraftTouched] = useState(false);
  const [productionDraft, setProductionDraft] = useState(() => ({
    materialId: createProductionMaterialId(),
    storageRoot: 'H:/',
    steelType: 'Q355B',
    width: 0,
    length: 0,
    thick: 0,
  }));
  const [siteSimulationRounds, setSiteSimulationRounds] = useState(3);
  const [siteSimulationPhase, setSiteSimulationPhase] = useState('待机');
  const [siteSimulationSummary, setSiteSimulationSummary] = useState<string | null>(null);
  const [liveCameraStatuses, setLiveCameraStatuses] = useState<CaptureCameraStatus[]>(capture.statuses);

  useEffect(() => {
    if (!configDirty) {
      setLocalConfig(capture.config);
    }
  }, [capture.config, configDirty]);

  useEffect(() => {
    setLiveCameraStatuses(capture.statuses);
  }, [capture.statuses]);

  useEffect(() => {
    if (simulationMode) return undefined;
    let cancelled = false;
    let requestRunning = false;
    const refresh = async () => {
      if (requestRunning) {
        return;
      }
      requestRunning = true;
      try {
        const statuses = await readCaptureCameraStatuses();
        if (!cancelled && statuses.length > 0) {
          setLiveCameraStatuses(statuses);
        }
      } catch {
        // Keep the latest known-good rows. The full snapshot refresh remains
        // the slower fallback when this lightweight telemetry call is absent.
      } finally {
        requestRunning = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [simulationMode]);

  const syncProductionDraftFromStatus = useCallback(
    (nextStatus: ProductionStatus) => {
      const providerCaptureMode = providerValue(nextStatus.capture, ['captureMode', 'capture_mode']);
      if (isCaptureOutputMode(providerCaptureMode)) {
        setCaptureOutputMode(providerCaptureMode);
      }
      if (!productionDraftTouched && nextStatus.activeSession?.materialId) {
        setProductionDraft((current) => ({
          ...current,
          materialId: nextStatus.activeSession?.materialId || current.materialId,
        }));
      }
    },
    [productionDraftTouched],
  );

  const refreshProductionStatus = useCallback(async () => {
    const nextStatus = await fetchProductionStatus();
    setProductionStatus(nextStatus);
    syncProductionDraftFromStatus(nextStatus);
    return nextStatus;
  }, [syncProductionDraftFromStatus]);

  useEffect(() => {
    if (simulationMode) return undefined;
    let cancelled = false;
    const refresh = async () => {
      try {
        const nextStatus = await fetchProductionStatus();
        if (!cancelled) {
          setProductionStatus(nextStatus);
          syncProductionDraftFromStatus(nextStatus);
        }
      } catch (error) {
        if (!cancelled) {
          setProductionMessage(error instanceof Error ? error.message : '生产采集状态读取失败');
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [simulationMode, syncProductionDraftFromStatus]);

  const refreshContinuousSettings = useCallback(async () => {
    const result = await readCaptureContinuousSettings();
    if (result.code !== 0) {
      throw new Error(result.error || result.message || `连续采集设置读取失败: code ${result.code}`);
    }
    setContinuousSettingsStatus(result.settings ?? null);
    return result.settings ?? null;
  }, []);

  useEffect(() => {
    if (simulationMode) return undefined;
    let cancelled = false;
    const refresh = async () => {
      try {
        const settings = await readCaptureContinuousSettings();
        if (!cancelled && settings.code === 0) {
          setContinuousSettingsStatus(settings.settings ?? null);
        }
      } catch {
        // Older capture providers have no continuous-settings endpoint. The
        // per-camera SDK readback remains a safe display-only fallback.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [simulationMode]);

  const refreshTriggerGatewayStatus = useCallback(async () => {
    const nextStatus = await fetchTriggerGatewayStatus();
    setTriggerGatewayStatus(nextStatus);
    const nextMode = nextStatus.mode;
    if (nextMode === 'api' || nextMode === 'tcp' || nextMode === 'udp' || nextMode === 'gray' || nextMode === 'secondary' || nextMode === 'manual') {
      setProductionMode(nextMode);
    }
    return nextStatus;
  }, []);

  useEffect(() => {
    if (simulationMode) return undefined;
    let cancelled = false;
    const refresh = async () => {
      try {
        const nextStatus = await fetchTriggerGatewayStatus();
        if (!cancelled) {
          setTriggerGatewayStatus(nextStatus);
          const nextMode = nextStatus.mode;
          if (nextMode === 'api' || nextMode === 'tcp' || nextMode === 'udp' || nextMode === 'gray' || nextMode === 'secondary' || nextMode === 'manual') {
            setProductionMode(nextMode);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setTriggerGatewayMessage(error instanceof Error ? error.message : '触发网关未连接');
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [simulationMode]);

  const overviewStatuses = useMemo(() => {
    const statusesByIp = new Map(liveCameraStatuses.map((item) => [item.ip, item]));
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
      ...liveCameraStatuses.filter((item) => !configuredIps.has(item.ip)),
    ];
  }, [liveCameraStatuses, localConfig.cameras]);

  const selectedStatus = selectedIp ? overviewStatuses.find((item) => item.ip === selectedIp) ?? null : null;
  const selectedConfig = selectedStatus ? localConfig.cameras.find((camera) => camera.ip === selectedStatus.ip || camera.id === selectedStatus.configId) ?? null : null;
  const connectedCount = overviewStatuses.filter((item) => item.connected).length;
  const enabledCount = localConfig.cameras.filter((camera) => camera.enabled).length;
  const warningCount = overviewStatuses.filter((item) => getStatusTone(item) === 'warning').length;
  const offlineCount = overviewStatuses.filter((item) => getStatusTone(item) === 'offline').length;
  const captureRunning = overviewStatuses.some((item) => item.continuousAcquiring || item.streamRunning);
  const previewStreamRequest = useMemo<CaptureStreamStartOptions>(() => ({
    ip: selectedStatus?.ip || '',
    lines: selectedConfig?.depthLines ?? 1280,
    ...previewStreamOptions,
  }), [previewStreamOptions, selectedConfig?.depthLines, selectedStatus?.ip]);
  const previewStreamValidation = selectedStatus
    ? validateCaptureStreamStartOptions(previewStreamRequest)
    : null;
  const recentLogs = useMemo(
    () => mergeCaptureLogEvents(capture.logs, operation.events, clientOperationLogs),
    [capture.logs, clientOperationLogs, operation.events],
  );
  const initialSimulationStatus = capture.health && 'simulation' in capture.health
    ? capture.health.simulation ?? null
    : null;
  const continuousSettingsIps = useMemo(
    () => overviewStatuses
      .filter((item) => item.enabled !== false && item.connected)
      .map((item) => item.ip),
    [overviewStatuses],
  );
  const continuousAcquiringCount = overviewStatuses.filter((item) => item.continuousAcquiring).length;
  const continuousLineTriggerRates = useMemo(
    () => Array.from(new Set(
      overviewStatuses
        .map((item) => item.captureConfig?.timeTriggerFreq)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0.1),
    )),
    [overviewStatuses],
  );
  const configuredLineTriggerRate = continuousSettingsStatus?.lineTriggerFrequency
    ?? continuousSettingsStatus?.timeTriggerFreq;
  const productionLineTriggerRate = continuousLineTriggerRateFromProductionStatus(productionStatus?.capture);
  const reportedContinuousLineTriggerRate = configuredLineTriggerRate !== undefined
    ? configuredLineTriggerRate
    : productionLineTriggerRate !== undefined
      ? productionLineTriggerRate
    : continuousLineTriggerRates.length === 1
      ? continuousLineTriggerRates[0]
      : undefined;
  const continuousLineTriggerRateLabel = reportedContinuousLineTriggerRate !== undefined
    ? `${formatNumber(reportedContinuousLineTriggerRate, 1)} Hz`
    : continuousSettingsStatus?.mixedLineTriggerFrequency || continuousLineTriggerRates.length > 1
      ? '相机参数不一致'
      : '-';
  const continuousSettingsValidation = validateCaptureContinuousSettings({
    timeTriggerFreq: continuousLineTriggerFreq,
    ips: continuousSettingsIps,
  });
  const continuousSettingsSupported = continuousSettingsStatus?.supported !== false;

  useEffect(() => {
    if (!continuousLineTriggerFreqTouched && reportedContinuousLineTriggerRate !== undefined) {
      setContinuousLineTriggerFreq(reportedContinuousLineTriggerRate);
    }
  }, [continuousLineTriggerFreqTouched, reportedContinuousLineTriggerRate]);

  const appendClientOperationLog = useCallback((
    level: CaptureLogEvent['level'],
    message: string,
    cameraIp?: string | null,
  ) => {
    clientLogSequence.current += 1;
    const event: CaptureLogEvent = {
      id: `CLIENT-${Date.now()}-${clientLogSequence.current}`,
      time: new Date().toISOString(),
      level,
      source: 'client-operation',
      cameraIp: cameraIp || null,
      message,
    };
    setClientOperationLogs((current) => prependBoundedCaptureLog(current, event));
  }, []);

  useEffect(() => {
    if (!selectedIp || previewMode !== 'latest') {
      setPreviewLoading(false);
      setPreviewError(null);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      if (!cancelled) {
        setPreviewLoading(true);
      }
      try {
        const latest = await readLatestCaptureFile(selectedIp, previewKind);
        if (!cancelled) {
          setCapturePreview({
            ip: latest.ip || selectedIp,
            kind: latest.kind,
            url: latest.imageUrl,
            output: latest.path,
            content: latest.content,
          });
          setPreviewError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setCapturePreview((current) =>
            current?.ip === selectedIp && current.kind === previewKind ? null : current,
          );
          setPreviewError(
            error instanceof Error && !error.message.includes('404')
              ? error.message
              : `暂无${captureKindLabel(previewKind)}`,
          );
        }
      } finally {
        inFlight = false;
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedIp, previewKind, previewMode, previewRefreshToken]);

  useEffect(() => {
    if (!selectedIp || previewMode !== 'stream' || (previewKind !== 'depth' && previewKind !== 'intensity')) {
      return;
    }
    const refresh = () => {
      setCapturePreview({
        ip: selectedIp,
        kind: previewKind,
        url: captureStreamImageUrl(selectedIp, previewKind),
        output: `${selectedIp} · ${captureKindLabel(previewKind)}实时流`,
      });
      setPreviewError(null);
    };
    refresh();
    const timer = window.setInterval(refresh, 400);
    return () => window.clearInterval(timer);
  }, [selectedIp, previewKind, previewMode]);

  const runCaptureCommand = async (
    action: () => Promise<CaptureCommandResult>,
    success: string,
    cameraIp?: string | null,
    silentSuccess = false,
  ) => {
    try {
      const result = await action();
      const message = result.code === 0
        ? (result.output ? `${success}: ${result.output}` : success)
        : `指令失败: ${result.code}${result.error ? ` · ${result.error}` : ''}`;
      setCaptureMessage(result.code === 0 && silentSuccess ? null : message);
      appendClientOperationLog(result.code === 0 ? 'info' : 'error', message, cameraIp ?? selectedIp);
      if (result.code === 0 && result.imageUrl) {
        setPreviewKind('depth');
        setCapturePreview({ ip: result.ip ?? selectedIp ?? '', kind: 'depth', url: result.imageUrl, output: result.output ?? '' });
        setPreviewError(null);
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : '指令失败';
      setCaptureMessage(message);
      appendClientOperationLog('error', message, cameraIp ?? selectedIp);
      return null;
    }
  };

  const handleContinuousSettings = async (applyToDevice: boolean) => {
    if (!continuousSettingsSupported) {
      setContinuousSettingsMessage('当前采集服务不支持连续采集线触发频率设置');
      return;
    }
    if (continuousSettingsValidation) {
      setContinuousSettingsMessage(continuousSettingsValidation);
      return;
    }
    if (continuousSettingsIps.length === 0) {
      setContinuousSettingsMessage('没有已连接的启用相机，无法修改连续采集设置');
      return;
    }

    setContinuousSettingsBusy(true);
    try {
      const result = await applyCaptureContinuousSettings({
        timeTriggerFreq: continuousLineTriggerFreq,
        ips: continuousSettingsIps,
        applyToDevice,
        restartContinuous: true,
      });
      if (result.code !== 0) {
        throw new Error(result.error || result.message || `连续采集设置失败: code ${result.code}`);
      }

      const appliedRate = result.lineTriggerFrequency ?? result.timeTriggerFreq ?? continuousLineTriggerFreq;
      if (Number.isFinite(appliedRate)) {
        setContinuousLineTriggerFreq(Number(appliedRate));
      }
      setContinuousLineTriggerFreqTouched(true);

      const results = result.results ?? [];
      const successCount = results.length
        ? results.filter((item) => item.code === 0).length
        : continuousSettingsIps.length;
      const targetCount = results.length || continuousSettingsIps.length;
      const action = result.dryRun || !applyToDevice ? '参数校验通过' : '已运行时下发';
      const message = `${action}：线触发 ${formatNumber(Number(appliedRate), 1)} Hz，${successCount}/${targetCount} 台相机${result.dryRun || !applyToDevice ? '' : '；连续采集已自动恢复'}`;
      setContinuousSettingsMessage(message);
      setCaptureMessage(message);
      appendClientOperationLog(successCount === targetCount ? 'info' : 'warning', message);
      await Promise.all([refreshProductionStatus(), refreshContinuousSettings()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : '连续采集设置失败';
      setContinuousSettingsMessage(message);
      appendClientOperationLog('error', message);
    } finally {
      setContinuousSettingsBusy(false);
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
    const message = `已下发连接: ${successCount}/${cameras.length}`;
    setCaptureMessage(message);
    appendClientOperationLog(successCount === cameras.length ? 'info' : 'warning', message);
  };

  const handleDisconnectAll = async () => {
    try {
      const result = await disconnectCaptureCamera();
      const results = result.results ?? [];
      const requested = result.requested ?? results.length;
      const disconnected = result.disconnected
        ?? results.filter((item) => item.code === 0 && item.disconnected !== false).length;
      const failed = result.failed ?? Math.max(0, requested - disconnected);
      const failedEvidence = results
        .filter((item) => item.code !== 0 || item.disconnected === false)
        .map((item) => `${item.ip || '未知相机'}: ${item.errorName || item.code}${item.operatorHint ? `（${item.operatorHint}）` : ''}`)
        .join('；');
      const message = failed === 0 && result.code === 0
        ? `全部相机已断开：${disconnected}/${requested}`
        : `相机批量断开完成：${disconnected}/${requested}，失败 ${failed}${failedEvidence ? `；${failedEvidence}` : ''}`;
      setCaptureMessage(message);
      appendClientOperationLog(failed === 0 && result.code === 0 ? 'info' : 'warning', message);
    } catch (error) {
      const message = error instanceof Error ? error.message : '相机批量断开失败';
      setCaptureMessage(message);
      appendClientOperationLog('error', message);
    }
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

  const handleStartPreview = async (ip: string, config?: CaptureCameraConfig | null) => {
    setPreviewError(null);
    setCaptureMessage(null);
    const request: CaptureStreamStartOptions = {
      ...previewStreamOptions,
      ip,
      lines: config?.depthLines ?? 1280,
    };
    const validationError = validateCaptureStreamStartOptions(request);
    if (validationError) {
      setPreviewError(validationError);
      setCaptureMessage(validationError);
      appendClientOperationLog('warning', validationError, ip);
      return;
    }
    const result = await runCaptureCommand(
      () => startCaptureStream(request),
      '实时预览已启动',
      ip,
      true,
    );
    setPreviewMode(result?.code === 0 ? 'stream' : 'latest');
  };

  const handleStopPreview = async (ip: string) => {
    await runCaptureCommand(() => stopCaptureStream(ip), '实时预览已停止', ip, true);
    setPreviewMode('latest');
  };

  const handleStopAllPreviews = async () => {
    const targets = overviewStatuses.filter((item) => item.streamRunning);
    if (targets.length === 0) {
      const message = '当前没有运行中的实时预览';
      setCaptureMessage(message);
      appendClientOperationLog('info', message);
      return;
    }
    let stopped = 0;
    for (const target of targets) {
      try {
        const result = await stopCaptureStream(target.ip);
        if (result.code === 0) {
          stopped += 1;
        }
      } catch {
        // Continue so one unreachable camera cannot leave the remaining
        // streams running without an attempted stop.
      }
    }
    setPreviewMode('latest');
    const message = `已停止实时预览 ${stopped}/${targets.length}`;
    setCaptureMessage(message);
    appendClientOperationLog(stopped === targets.length ? 'info' : 'warning', message);
  };

  const handleOpenLocalPath = async (path: string) => {
    try {
      const opened = await openCaptureLocalPath(path);
      setCaptureMessage(opened ? `已打开：${path}` : '浏览器模式不能打开本地路径');
    } catch (error) {
      setCaptureMessage(error instanceof Error ? error.message : '本地路径打开失败');
    }
  };

  const handleSaveCurrentPreview = async () => {
    if (!capturePreview) {
      return;
    }
    try {
      const safeIp = (capturePreview.ip || selectedIp || 'camera').replace(/[^0-9A-Za-z_-]+/g, '_');
      const extension = capturePreview.kind === 'metadata' ? 'json' : 'png';
      const saved = await saveCapturePreviewFromUrl(
        capturePreview.url,
        `${safeIp}-${capturePreview.kind || previewKind}-preview.${extension}`,
      );
      setCaptureMessage(saved
        ? (saved.saved ? `当前预览已保存：${saved.path || ''}` : '已取消保存当前预览')
        : '浏览器模式不能调用系统另存对话框');
    } catch (error) {
      setCaptureMessage(error instanceof Error ? error.message : '当前预览保存失败');
    }
  };

  const updateProductionDraft = (patch: Partial<typeof productionDraft>) => {
    setProductionDraftTouched(true);
    setProductionDraft((current) => ({ ...current, ...patch }));
  };

  const productionPayload = () => ({
    ...productionDraft,
    steelId: productionDraft.materialId,
    steelNo: productionDraft.materialId,
    source: 'capture-management-ui',
    mode: productionMode,
    triggerMode: productionMode,
    captureMode: captureOutputMode,
    autoCapture: captureOutputMode === 'continuous',
    generateTestData: triggerTestOptions.generateTestData,
    discardBlackFrames: true,
  });

  const productionResultText = (result: ProductionCommandResult, success: string) => {
    const code = result.code ?? 0;
    const materialId = result.materialId || productionDraft.materialId;
    const sessionId = result.sessionId ? ` / ${result.sessionId}` : '';
    if (code === 0 && result.task?.taskId) {
      return `${success}已入队：${materialId}${sessionId} / ${result.task.taskId} / ${result.task.status}`;
    }
    return code === 0 ? `${success}: ${materialId}${sessionId}` : `${success}返回异常: code ${code}`;
  };

  const runProductionCommand = async (action: () => Promise<ProductionCommandResult>, success: string) => {
    setProductionBusy(true);
    try {
      const result = await action();
      setProductionMessage(productionResultText(result, success));
      await refreshProductionStatus();
    } catch (error) {
      setProductionMessage(error instanceof Error ? error.message : '生产采集指令失败');
    } finally {
      setProductionBusy(false);
    }
  };

  const handleNewProductionMaterial = () => {
    updateProductionDraft({ materialId: createProductionMaterialId() });
    setProductionMessage('已生成新的钢管流水号');
  };

  const handleTriggerModeChange = async (mode: TriggerGatewayMode) => {
    setTriggerGatewayBusy(true);
    try {
      const status = await setTriggerGatewayMode(mode);
      setTriggerGatewayStatus(status);
      setProductionMode(mode);
      setTriggerGatewayMessage(`触发网关已切换到 ${triggerGatewayModeLabel(status.mode)}`);
    } catch (error) {
      setTriggerGatewayMessage(error instanceof Error ? error.message : '触发网关模式切换失败');
    } finally {
      setTriggerGatewayBusy(false);
    }
  };

  const handleCaptureOutputModeChange = async (mode: CaptureOutputMode) => {
    setCaptureModeBusy(true);
    try {
      const result = await applyCaptureOutputMode(mode);
      if (result.code !== 0) {
        throw new Error(result.error || result.message || `采集模式切换失败: code ${result.code}`);
      }
      const providerMode = typeof result.captureMode === 'string' ? result.captureMode : '';
      const appliedMode = isCaptureOutputMode(providerMode) ? providerMode : mode;
      setCaptureOutputMode(appliedMode);
      setTriggerGatewayMessage(`相机出图已切换为 ${captureOutputModes.find((item) => item.mode === appliedMode)?.label || appliedMode}`);
      await refreshProductionStatus();
    } catch (error) {
      setTriggerGatewayMessage(error instanceof Error ? error.message : '采集模式切换失败');
    } finally {
      setCaptureModeBusy(false);
    }
  };

  const handleWriteProductionRecord = () => {
    void runProductionCommand(() => triggerGatewayManualSteelInfo(productionPayload()), '检测记录已写入');
  };

  const writeConfiguredSecondaryData = async (sessionId?: string) => {
    if (!triggerTestOptions.writeSecondaryDataOnSteelIn) {
      return null;
    }
    return writeProductionSecondaryData({
      ...productionPayload(),
      sessionId,
      source: triggerTestOptions.generateTestData ? 'trigger-settings-test' : 'trigger-settings',
      payloadType: 'steel-in-secondary-data',
      secondaryData: triggerSecondaryData,
      generatedForTest: triggerTestOptions.generateTestData,
    });
  };

  const handleSteelIn = () => {
    setManualTriggerPhase('手动进钢');
    void runProductionCommand(async () => {
      const result = await triggerGatewayManualSteelIn({
        ...productionPayload(),
        autoCapture: captureOutputMode === 'continuous',
      });
      if (result.code === 0) {
        try {
          await writeConfiguredSecondaryData(result.sessionId);
        } catch (error) {
          setTriggerGatewayMessage(error instanceof Error ? error.message : '进钢后二级数据写入失败');
        }
      }
      return result;
    }, '进钢信号已下发，采集进入保存状态');
  };

  const handleCaptureProductionOnce = () => {
    void runProductionCommand(
      () =>
        captureProductionOnce({
          ...productionPayload(),
          rounds: 1,
          expectedCameras: runtimeCameraCount,
          lines: 1000,
          width: 0,
          timeoutMs: 8000,
          intervalMs: 500,
          retries: 0,
          connectFirst: false,
          stopStreams: true,
        }),
      '生产采集一轮完成',
    );
  };

  const handleSteelOut = () => {
    setManualTriggerPhase('手动出钢');
    void runProductionCommand(() => triggerGatewayManualSteelOut(productionPayload()), '出钢信号已下发，采集进入丢弃状态');
  };

  const handleTimedManualSimulation = async () => {
    if (productionMode !== 'manual') {
      setTriggerGatewayMessage('请先将进出钢模式切换为手动触发');
      return;
    }
    const durationSeconds = Math.min(3600, Math.max(1, Math.trunc(manualSimulationSeconds || 30)));
    const payload = productionPayload();
    let entered = false;
    let sessionId: string | undefined;
    setProductionBusy(true);
    try {
      setManualTriggerPhase('写入进钢记录');
      const info = await waitForProductionCommandTask(await triggerGatewayManualSteelInfo(payload));
      sessionId = info.sessionId;
      setManualTriggerPhase('手动进钢');
      const steelIn = await waitForProductionCommandTask(await triggerGatewayManualSteelIn({
        ...payload,
        sessionId,
        autoCapture: captureOutputMode === 'continuous',
      }));
      entered = true;
      sessionId = steelIn.sessionId || sessionId;
      await writeConfiguredSecondaryData(sessionId);
      setManualTriggerPhase(`模拟进钢中 · ${durationSeconds} 秒`);
      await new Promise<void>((resolve) => window.setTimeout(resolve, durationSeconds * 1000));
      setManualTriggerPhase('手动出钢');
      await waitForProductionCommandTask(await triggerGatewayManualSteelOut({ ...payload, sessionId }));
      entered = false;
      setManualTriggerPhase('完成');
      setProductionMessage(`已完成 ${durationSeconds} 秒模拟进出钢：${payload.materialId}`);
      await refreshProductionStatus();
    } catch (error) {
      if (entered) {
        await triggerGatewayManualSteelOut({ ...payload, sessionId }).catch(() => undefined);
      }
      setManualTriggerPhase('失败');
      setTriggerGatewayMessage(error instanceof Error ? error.message : '模拟进出钢失败');
      await refreshProductionStatus().catch(() => undefined);
    } finally {
      setProductionBusy(false);
    }
  };

  const handleRunSiteSimulation = async () => {
    if (!triggerGatewayStatus?.manualAllowed) {
      setSiteSimulationSummary('请先将触发网关切换到“手动”模式');
      return;
    }

    const rounds = Math.min(100, Math.max(1, Math.trunc(siteSimulationRounds || 1)));
    const basePayload = productionPayload();
    let entered = false;
    let sessionId: string | undefined;
    setProductionBusy(true);
    setSiteSimulationSummary(null);
    try {
      setSiteSimulationPhase('1/4 写入检测记录');
      const info = await waitForProductionCommandTask(
        await triggerGatewayManualSteelInfo(basePayload),
        (task) => setSiteSimulationPhase(`1/4 写入检测记录 · ${task.status} ${Math.round(task.progress ?? 0)}%`),
      );
      sessionId = info.sessionId || sessionId;

      const statusBeforeSteelIn = await refreshProductionStatus();
      const baselineCaptureCount = Number(providerValue(statusBeforeSteelIn.capture ?? null, ['captureSuccessCount'])) || 0;

      setSiteSimulationPhase('2/4 模拟进钢');
      const steelIn = await waitForProductionCommandTask(
        await triggerGatewayManualSteelIn({ ...basePayload, sessionId, autoCapture: true }),
        (task) => setSiteSimulationPhase(`2/4 模拟进钢 · ${task.status} ${Math.round(task.progress ?? 0)}%`),
      );
      entered = true;
      sessionId = steelIn.sessionId || sessionId;

      const targetCaptureCount = baselineCaptureCount + rounds * runtimeCameraCount;
      const captureDeadline = Date.now() + 60 * 60 * 1000;
      let currentCaptureCount = baselineCaptureCount;
      while (currentCaptureCount < targetCaptureCount) {
        if (Date.now() >= captureDeadline) {
          throw new Error(`连续采集在一小时内未完成 ${rounds} 轮`);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 400));
        const nextStatus = await refreshProductionStatus();
        currentCaptureCount = Number(providerValue(nextStatus.capture ?? null, ['captureSuccessCount'])) || 0;
        const completedFrames = Math.max(0, currentCaptureCount - baselineCaptureCount);
        setSiteSimulationPhase(`3/4 实机连续采集 · ${Math.min(rounds, Math.floor(completedFrames / runtimeCameraCount))}/${rounds} 轮`);
      }

      setSiteSimulationPhase('4/4 模拟出钢');
      await waitForProductionCommandTask(
        await triggerGatewayManualSteelOut({ ...basePayload, sessionId }),
        (task) => setSiteSimulationPhase(`4/4 模拟出钢 · ${task.status} ${Math.round(task.progress ?? 0)}%`),
      );
      entered = false;
      setSiteSimulationPhase('完成');
      setSiteSimulationSummary(`现场模拟完成：${basePayload.materialId}，${runtimeCameraCount} 台真实相机并行采集 ${rounds} 轮`);
      setProductionMessage(`现场模拟运行完成：${basePayload.materialId}`);
      await refreshProductionStatus();
    } catch (error) {
      if (entered) {
        try {
          await waitForProductionCommandTask(await triggerGatewayManualSteelOut({ ...basePayload, sessionId }));
        } catch {
          // Preserve the primary failure; the status refresh below exposes any
          // remaining active session for operator recovery.
        }
      }
      setSiteSimulationPhase('失败');
      setSiteSimulationSummary(error instanceof Error ? error.message : '现场模拟运行失败');
      await refreshProductionStatus().catch(() => undefined);
    } finally {
      setProductionBusy(false);
    }
  };

  const renderProductionPanel = () => {
    const captureState = productionStatus?.capture ?? null;
    const activeSession = productionStatus?.activeSession;
    const latestInspection = productionStatus?.latestInspection;
    const providerMaterial = providerValue(captureState, ['materialId', 'steelId', 'steelNo', 'id']);
    const providerPhase = providerValue(captureState, ['phase', 'state', 'status']);
    const providerSaveState = providerValue(captureState, ['captureSaveState', 'saveState', 'saveEnabled']);
    const providerRunning = providerValue(captureState, ['productionCaptureRunning', 'captureRunning', 'running']);
    const providerSteelPath = providerValue(captureState, ['steelDir', 'materialDir', 'captureDir', 'storagePath', 'outputDir']);
    const taskState = productionStatus?.tasks;
    const triggerManualAllowed = Boolean(triggerGatewayStatus?.manualAllowed);
    const triggerGatewayOnline = Boolean(triggerGatewayStatus && triggerGatewayStatus.code !== 503 && !triggerGatewayStatus.error);

    return (
      <Panel title="生产采集闭环" className="production-capture-panel">
        <div className="production-capture-head">
          <div>
            <span>触发网关模式</span>
            <div className="production-mode-toggle" role="group" aria-label="进出钢触发模式">
              <button type="button" className={productionMode === 'api' ? 'active' : ''} onClick={() => void handleTriggerModeChange('api')} disabled={triggerGatewayBusy}>
                API
              </button>
              <button type="button" className={productionMode === 'gray' ? 'active' : ''} onClick={() => void handleTriggerModeChange('gray')} disabled={triggerGatewayBusy}>
                灰度
              </button>
              <button type="button" className={productionMode === 'secondary' ? 'active' : ''} onClick={() => void handleTriggerModeChange('secondary')} disabled={triggerGatewayBusy}>
                二级
              </button>
              <button type="button" className={productionMode === 'manual' ? 'active' : ''} onClick={() => void handleTriggerModeChange('manual')} disabled={triggerGatewayBusy}>
                手动
              </button>
            </div>
          </div>
          <button type="button" onClick={handleNewProductionMaterial}>
            <RefreshCw size={15} />
            新流水号
          </button>
        </div>
        <div className="production-capture-form">
          <label>
            <span>钢管流水号</span>
            <input value={productionDraft.materialId} onChange={(event) => updateProductionDraft({ materialId: event.target.value })} />
          </label>
          <label>
            <span>存储根目录</span>
            <input value={productionDraft.storageRoot} onChange={(event) => updateProductionDraft({ storageRoot: event.target.value })} />
          </label>
          <label>
            <span>钢种</span>
            <input value={productionDraft.steelType} onChange={(event) => updateProductionDraft({ steelType: event.target.value })} />
          </label>
          <label>
            <span>外径/宽度 mm</span>
            <input type="number" value={productionDraft.width} onChange={(event) => updateProductionDraft({ width: Number(event.target.value) })} />
          </label>
          <label>
            <span>长度 mm</span>
            <input type="number" value={productionDraft.length} onChange={(event) => updateProductionDraft({ length: Number(event.target.value) })} />
          </label>
          <label>
            <span>壁厚 mm</span>
            <input type="number" value={productionDraft.thick} onChange={(event) => updateProductionDraft({ thick: Number(event.target.value) })} />
          </label>
          <label>
            <span>模拟采集轮数</span>
            <input
              aria-label="模拟采集轮数"
              type="number"
              min={1}
              max={100}
              value={siteSimulationRounds}
              onChange={(event) => setSiteSimulationRounds(Number(event.target.value))}
            />
          </label>
        </div>
        <section className="production-site-simulation" aria-label="模拟现场运行">
          <div>
            <span>模拟现场运行</span>
            <strong>{simulationMode ? '模拟通道数据源' : `当前 ${connectedCount}/${enabledCount} 台真实相机`}</strong>
            <em>{siteSimulationPhase}</em>
          </div>
          <button
            type="button"
            className="primary"
            onClick={() => void handleRunSiteSimulation()}
            disabled={productionBusy || !triggerManualAllowed || !productionDraft.materialId.trim() || connectedCount < enabledCount}
          >
            <Play size={16} />
            一键模拟现场运行
          </button>
        </section>
        <dl className="production-capture-facts">
          <div>
            <dt>活动会话</dt>
            <dd>{activeSession ? `${activeSession.materialId} · ${activeSession.status}` : '无活动会话'}</dd>
          </div>
          <div>
            <dt>最近检测</dt>
            <dd>{latestInspection ? `${latestInspection.status} · ${latestInspection.captureCount} 轮` : '-'}</dd>
          </div>
          <div>
            <dt>采集端材料</dt>
            <dd>{providerMaterial || '-'}</dd>
          </div>
          <div>
            <dt>采集端状态</dt>
            <dd>{[providerPhase, providerSaveState, providerRunning].filter(Boolean).join(' · ') || '-'}</dd>
          </div>
          <div>
            <dt>软件连续采集</dt>
            <dd>{providerRunning ? '持续运行 · 进出钢仅切换保存' : '等待启动'}</dd>
          </div>
          <div>
            <dt>触发网关</dt>
            <dd>{triggerGatewayOnline ? `${triggerGatewayModeLabel(triggerGatewayStatus?.mode)} · ${triggerManualAllowed ? '允许手动' : '自动/外部'}` : '离线'}</dd>
          </div>
          <div>
            <dt>持久任务队列</dt>
            <dd>
              {taskState
                ? `${taskState.queueDepth}/${taskState.capacity}${taskState.worker?.activeTaskId ? ` · ${taskState.worker.activeTaskId}` : ''}`
                : '-'}
            </dd>
          </div>
          <div>
            <dt>手动入口</dt>
            <dd>由 Tauri 经 Rust /api/trigger/* 受控代理</dd>
          </div>
        </dl>
        <div className="production-capture-actions">
          <button type="button" onClick={handleWriteProductionRecord} disabled={productionBusy || !triggerManualAllowed || !productionDraft.materialId.trim()}>
            <FileText size={16} />
            写检测记录
          </button>
          <button type="button" className="primary" onClick={handleSteelIn} disabled={productionBusy || !triggerManualAllowed || !productionDraft.materialId.trim()}>
            <Play size={16} />
            进钢开始保存
          </button>
          <button type="button" onClick={handleCaptureProductionOnce} disabled={productionBusy || !productionDraft.materialId.trim()}>
            <Gauge size={16} />
            采集一轮
          </button>
          <button type="button" onClick={handleSteelOut} disabled={productionBusy || !triggerManualAllowed || !productionDraft.materialId.trim()}>
            <StopCircle size={16} />
            出钢结束
          </button>
          <button type="button" onClick={() => void refreshTriggerGatewayStatus()} disabled={triggerGatewayBusy}>
            <RefreshCw size={16} />
            刷新触发网关
          </button>
          <button type="button" onClick={() => void handleOpenLocalPath(productionDraft.storageRoot)} disabled={!productionDraft.storageRoot.trim()}>
            <FolderOpen size={16} />打开存储根目录
          </button>
          <button type="button" onClick={() => void handleOpenLocalPath(providerSteelPath)} disabled={!providerSteelPath}>
            <FolderOpen size={16} />打开当前钢材目录
          </button>
          <button type="button" onClick={() => void handleOpenLocalPath(latestInspection?.summaryPath || '')} disabled={!latestInspection?.summaryPath}>
            <FolderOpen size={16} />打开最近 summary
          </button>
        </div>
        {!triggerManualAllowed ? (
          <div className="production-capture-warning">
            <AlertTriangle size={15} />
            <span>进钢/出钢手动控制需要先将触发网关切换到“手动”。灰度、二级和 API 模式由外部信号/API 触发。</span>
          </div>
        ) : null}
        {triggerGatewayMessage ? (
          <div className="production-capture-message trigger">
            <Network size={15} />
            <span>{triggerGatewayMessage}</span>
          </div>
        ) : null}
        {productionMessage ? (
          <div className="production-capture-message">
            <CheckCircle2 size={15} />
            <span>{productionMessage}</span>
          </div>
        ) : null}
        {siteSimulationSummary ? (
          <div className="production-capture-message site-simulation" role="status">
            <Activity size={15} />
            <span>{siteSimulationSummary}</span>
          </div>
        ) : null}
      </Panel>
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
        <section className="capture-continuous-settings" aria-label="连续采集设置" data-testid="continuous-capture-settings">
          <header>
            <div>
              <span>生产采集</span>
              <strong>连续采集设置</strong>
            </div>
            <i className={captureOutputMode === 'continuous' && continuousAcquiringCount > 0 ? 'running' : ''}>
              {captureOutputMode === 'continuous'
                ? continuousAcquiringCount > 0
                  ? '采集中'
                  : '待帧'
                : '未启用'}
            </i>
          </header>
          <dl>
            <div>
              <dt>连续采集状态</dt>
              <dd>{continuousAcquiringCount}/{continuousSettingsIps.length || enabledCount} 台采集</dd>
            </div>
            <div>
              <dt>当前线触发</dt>
              <dd>{continuousLineTriggerRateLabel}</dd>
            </div>
          </dl>
          <div className="capture-continuous-settings-form">
            <label>
              <span>线触发频率</span>
              <input
                aria-label="连续采集线触发频率"
                type="number"
                min={0.1}
                max={100000}
                step={0.1}
                value={continuousLineTriggerFreq}
                onChange={(event) => {
                  setContinuousLineTriggerFreq(Number(event.target.value));
                  setContinuousLineTriggerFreqTouched(true);
                }}
                disabled={continuousSettingsBusy}
              />
              <em>Hz</em>
            </label>
            <button
              type="button"
              onClick={() => void handleContinuousSettings(false)}
              disabled={!continuousSettingsSupported || continuousSettingsBusy || Boolean(continuousSettingsValidation) || continuousSettingsIps.length === 0}
            >
              <RefreshCw size={15} />
              校验
            </button>
            <button
              type="button"
              className="primary"
              data-testid="apply-continuous-settings"
              onClick={() => void handleContinuousSettings(true)}
              disabled={!continuousSettingsSupported || continuousSettingsBusy || Boolean(continuousSettingsValidation) || continuousSettingsIps.length === 0 || captureOutputMode !== 'continuous'}
            >
              <SlidersHorizontal size={15} />
              运行时应用
            </button>
          </div>
          <p>
            {!continuousSettingsSupported
              ? '当前采集服务尚未提供连续采集设置接口。'
              : captureOutputMode === 'continuous'
              ? `目标：${continuousSettingsIps.length} 台已连接相机。运行时应用会受控暂停并恢复连续采集，不写入相机持久化参数。`
              : '请先在触发设置中启用“连续出图”，再运行时应用线触发频率。'}
          </p>
          {continuousSettingsMessage ? <small role="status">{continuousSettingsMessage}</small> : null}
        </section>
        <div className="capture-control-grid">
          <button type="button" onClick={() => void handleConnectAll()}>
            <Network size={16} />
            全部连接
          </button>
          <button type="button" onClick={() => void handleDisconnectAll()}>
            <CircleOff size={16} />
            全部断开
          </button>
          <button
            type="button"
            onClick={() => {
              const target = overviewStatuses.find((item) => item.connected);
              if (!target) {
                setCaptureMessage('请先连接一台相机，再启动实时预览');
                return;
              }
              const targetConfig = localConfig.cameras.find((item) => item.ip === target.ip);
              setSelectedIp(target.ip);
              void handleStartPreview(target.ip, targetConfig);
            }}
          >
            <Play size={16} />
            启动实时预览
          </button>
          <button
            type="button"
            onClick={() => void handleStopAllPreviews()}
          >
            <StopCircle size={16} />
            停止全部预览
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
      {renderProductionPanel()}
      <Panel title="最新事件" className="capture-events-panel">
        <div className="capture-event-list compact">
          {recentLogs.slice(0, 5).map((event) => (
            <div key={`${event.source || 'unknown'}-${event.id}`} className={event.level}>
              <Activity size={15} />
              <span>{formatTime(event.time)}</span>
              <em>{captureLogSourceLabel(event.source)}</em>
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
          <dl className="capture-detail-live-summary" aria-label="相机实时摘要">
            <div>
              <dt>IP</dt>
              <dd>{selectedStatus.ip}</dd>
            </div>
            <div>
              <dt>温度</dt>
              <dd>{getTemperature(selectedStatus)}</dd>
            </div>
            <div>
              <dt>连续 FPS</dt>
              <dd>{formatNumber(selectedStatus.continuousFps)}</dd>
            </div>
            <div>
              <dt>{selectedStatus.streamRunning ? '预览 FPS' : '最近丢帧'}</dt>
              <dd>{selectedStatus.streamRunning ? formatNumber(selectedStatus.streamFps) : (getRecentFrameDropCount(selectedStatus) ?? '-')}</dd>
            </div>
            <div>
              <dt>连续帧数</dt>
              <dd>{selectedStatus.continuousFrameCount ?? '-'}</dd>
            </div>
          </dl>
          <i className={getStatusTone(selectedStatus)}>{getStatusLabel(selectedStatus)}</i>
        </header>
        <section className="capture-detail-grid">
          <Panel title="参数与控制" className="capture-detail-parameter-panel">
            <nav className="capture-detail-tabs" role="tablist" aria-label="单相机参数分类">
              <button type="button" role="tab" aria-selected={detailTab === 'status'} className={detailTab === 'status' ? 'active' : ''} onClick={() => setDetailTab('status')}>实时状态</button>
              <button type="button" role="tab" aria-selected={detailTab === 'capture'} className={detailTab === 'capture' ? 'active' : ''} onClick={() => setDetailTab('capture')}>采集控制</button>
              <button type="button" role="tab" aria-selected={detailTab === 'image'} className={detailTab === 'image' ? 'active' : ''} onClick={() => setDetailTab('image')}>图像参数</button>
              <button type="button" role="tab" aria-selected={detailTab === 'sdk'} className={detailTab === 'sdk' ? 'active' : ''} onClick={() => setDetailTab('sdk')}>SDK 参数</button>
            </nav>
            <div className="capture-detail-tab-content" role="tabpanel">
            {detailTab === 'status' ? <dl className="capture-detail-facts">
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
                <dt>连续采集 FPS</dt>
                <dd>{formatNumber(selectedStatus.continuousFps)}</dd>
              </div>
              <div>
                <dt>预览 FPS</dt>
                <dd>{selectedStatus.streamRunning ? formatNumber(selectedStatus.streamFps) : '-'}</dd>
              </div>
              <div>
                <dt>连续采集帧数</dt>
                <dd>{selectedStatus.continuousFrameCount ?? '-'}</dd>
              </div>
              <div>
                <dt>温度</dt>
                <dd>{getTemperatureDetail(selectedStatus)}</dd>
              </div>
              <div>
                <dt>温度更新时间</dt>
                <dd>{formatTime(selectedStatus.temperatureUpdatedAt)}</dd>
              </div>
              <div>
                <dt>最近窗口丢帧</dt>
                <dd>{getFrameDropReview(selectedStatus)}</dd>
              </div>
              <div>
                <dt>服务启动后累计丢帧</dt>
                <dd>{selectedStatus.lifetimeTransportFrameGapCount ?? selectedStatus.lostPulseCounter ?? '-'}</dd>
              </div>
              <div>
                <dt>最近丢帧率</dt>
                <dd>{selectedStatus.transportFrameDropPercent === undefined ? '-' : `${formatNumber(selectedStatus.transportFrameDropPercent, 4)}%`}</dd>
              </div>
              <div>
                <dt>GenTL 帧号</dt>
                <dd>{selectedStatus.transportFrameId ?? '-'}</dd>
              </div>
              <div>
                <dt>相机采集频率</dt>
                <dd>{selectedStatus.acquisitionFrameRate === undefined || selectedStatus.acquisitionFrameRate === null ? '-' : `${formatNumber(selectedStatus.acquisitionFrameRate)} Hz`}</dd>
              </div>
              <div>
                <dt>设备链路吞吐</dt>
                <dd>{selectedStatus.deviceLinkThroughputCurrent === undefined || selectedStatus.deviceLinkThroughputCurrent === null ? '-' : `${formatNumber(selectedStatus.deviceLinkThroughputCurrent / 1_000_000, 1)} MB/s`}</dd>
              </div>
              <div>
                <dt>缓存溢出</dt>
                <dd>{selectedStatus.bufferOverflowCounter ?? '-'}</dd>
              </div>
            </dl> : null}
            {detailTab === 'sdk' ? <CaptureSdkReadback status={selectedStatus} /> : null}
            {detailTab === 'image' ? (selectedConfig ? (
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
            )) : null}
            {detailTab === 'capture' ? <>
            <section className="capture-stream-settings" aria-label="实时预览参数">
              <label>
                <span>宽度（0=SDK）</span>
                <input
                  aria-label="实时预览宽度"
                  type="number"
                  min={0}
                  max={32768}
                  value={previewStreamOptions.width}
                  onChange={(event) => setPreviewStreamOptions((current) => ({ ...current, width: Number(event.target.value) }))}
                />
              </label>
              <label>
                <span>数据模式</span>
                <select
                  aria-label="实时预览数据模式"
                  value={previewStreamOptions.dataMode}
                  onChange={(event) => setPreviewStreamOptions((current) => ({ ...current, dataMode: Number(event.target.value) }))}
                >
                  <option value={1}>深度</option>
                  <option value={3}>深度 + 亮度</option>
                </select>
              </label>
              <label>
                <span>FPS 限制</span>
                <input
                  aria-label="实时预览 FPS 限制"
                  type="number"
                  min={1}
                  max={30}
                  value={previewStreamOptions.fpsLimit}
                  onChange={(event) => setPreviewStreamOptions((current) => ({ ...current, fpsLimit: Number(event.target.value) }))}
                />
              </label>
              <label className="capture-stream-hs-toggle">
                <input
                  aria-label="实时预览高速模式"
                  type="checkbox"
                  checked={previewStreamOptions.hs}
                  onChange={(event) => setPreviewStreamOptions((current) => ({ ...current, hs: event.target.checked }))}
                />
                高速模式
              </label>
            </section>
            {previewStreamValidation ? <p className="capture-stream-validation" role="alert">{previewStreamValidation}</p> : null}
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
              {selectedStatus.streamRunning ? (
                <button type="button" onClick={() => void handleStopPreview(selectedStatus.ip)}>
                  <StopCircle size={16} />
                  停止实时预览
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleStartPreview(selectedStatus.ip, selectedConfig)}
                  disabled={!selectedStatus.connected || Boolean(previewStreamValidation) || (previewKind !== 'depth' && previewKind !== 'intensity')}
                >
                  <Play size={16} />
                  启动实时预览
                </button>
              )}
            </div>
            </> : null}
            </div>
          </Panel>
          <Panel title="最新图像预览" className="capture-depth-preview-panel">
            <div className="capture-preview-toolbar">
              <div role="group" aria-label="图像预览模式">
                <button type="button" aria-pressed={previewMode === 'latest'} className={previewMode === 'latest' ? 'active' : ''} onClick={() => { setPreviewMode('latest'); setCaptureMessage(null); }}>
                  最新落盘
                </button>
                <button
                  type="button"
                  aria-pressed={previewMode === 'stream'}
                  className={previewMode === 'stream' ? 'active' : ''}
                  onClick={() => {
                    if (selectedStatus.streamRunning) {
                      setPreviewMode('stream');
                      setCaptureMessage(null);
                    } else {
                      void handleStartPreview(selectedStatus.ip, selectedConfig);
                    }
                  }}
                  disabled={!selectedStatus.connected}
                >
                  实时流
                </button>
                <button type="button" className={previewKind === 'depth' ? 'active' : ''} onClick={() => setPreviewKind('depth')}>
                  深度图
                </button>
                <button type="button" className={previewKind === 'intensity' ? 'active' : ''} onClick={() => setPreviewKind('intensity')}>
                  亮度图
                </button>
                <button type="button" className={previewKind === 'metadata' ? 'active' : ''} onClick={() => { setPreviewMode('latest'); setPreviewKind('metadata'); }}>
                  元数据
                </button>
                <button type="button" className={previewKind === 'sdk-derived' ? 'active' : ''} onClick={() => { setPreviewMode('latest'); setPreviewKind('sdk-derived'); }}>
                  SDK 派生图
                </button>
              </div>
              <button
                type="button"
                onClick={() => setPreviewRefreshToken((value) => value + 1)}
                disabled={previewLoading || previewMode === 'stream'}
              >
                <RefreshCw size={14} className={previewLoading ? 'spin' : ''} />
                {previewMode === 'stream' ? '实时刷新中' : previewLoading ? '读取中' : '刷新最新'}
              </button>
              <button type="button" disabled={!capturePreview} onClick={() => void handleSaveCurrentPreview()}>
                <Save size={14} />保存当前帧
              </button>
              <button type="button" disabled={!capturePreview || previewMode !== 'latest'} onClick={() => void handleOpenLocalPath(capturePreview?.output || '')}>
                <FolderOpen size={14} />打开落盘文件
              </button>
            </div>
            {capturePreview && (!capturePreview.ip || capturePreview.ip === selectedStatus.ip) && capturePreview.kind === previewKind ? (
              <div className="capture-depth-preview">
                {previewKind === 'metadata' ? (
                  <pre className="capture-metadata-preview" aria-label="最新采集元数据">
                    {capturePreview.content || '元数据文件为空'}
                  </pre>
                ) : (
                  <img
                    src={capturePreview.url}
                    alt={`${selectedStatus.name || selectedStatus.ip} ${previewKind === 'depth' ? 'depth map' : previewKind === 'intensity' ? 'intensity map' : 'SDK 派生图'}`}
                    onLoad={() => setPreviewError(null)}
                    onError={() => setPreviewError(`${captureKindLabel(previewKind)}实时帧读取失败，请检查采集流输出`)}
                  />
                )}
                {previewError ? <em className="capture-preview-image-error" role="alert">{previewError}</em> : null}
                <span title={capturePreview.output}>{capturePreview.output}</span>
              </div>
            ) : (
              <div className="capture-preview-empty" role="status">
                <Gauge size={28} />
                <strong>{previewLoading ? '正在读取最新图像' : previewError || '等待最新采集图像'}</strong>
                <span>{previewMode === 'stream' ? '前端每 400 毫秒经 Rust 服务读取实时帧' : '前端每 3 秒经 Rust 服务读取一次采集端最新文件'}</span>
              </div>
            )}
          </Panel>
          <Panel title="相机日志" className="capture-detail-log-panel">
            <div className="capture-event-list">
              {recentLogs
                .filter((event) => !event.cameraIp || event.cameraIp === selectedStatus.ip)
                .slice(0, 8)
                .map((event) => (
                  <div key={`${event.source || 'unknown'}-${event.id}`} className={event.level}>
                    <Activity size={15} />
                    <span>{formatTime(event.time)}</span>
                    <em>{captureLogSourceLabel(event.source)}</em>
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
          <div className="capture-side-title">
            <strong>采集管理</strong>
            {showReturnToTerminal ? (
              <a href="/?app=terminal" aria-label="返回主界面">
                <ArrowLeft size={15} />
                返回主界面
              </a>
            ) : null}
          </div>
          {captureViews.filter((item) => !simulationMode || item.id === 'overview' || item.id === 'logs').map((item) => {
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
          {!embeddedMode ? <header className={`capture-command-header ${simulationMode ? 'with-mode-banner' : ''}`}>
            {simulationMode ? (
              <div className="capture-mode-banner simulated">
                <AlertTriangle size={18} />
                <div>
                  <strong>模拟模式</strong>
                  <span>当前使用已采集数据模拟生产运行；模拟通道与物理相机状态严格分离。</span>
                </div>
              </div>
            ) : null}
            <div className="capture-workflow">
              <span>{simulationMode ? '读取数据集' : '选择配置'}</span>
              <i />
              <span>{simulationMode ? '启动模拟' : '应用配置'}</span>
              <i />
              <span>{simulationMode ? '通道进度' : '相机总览'}</span>
              <i />
              <span>{simulationMode ? '完成/循环' : '进入详情'}</span>
            </div>
            <div className="capture-status-strip">
              <div>
                <span>{simulationMode ? '运行模式' : '当前配置'}</span>
                <strong>{simulationMode ? '模拟' : localConfig.name}</strong>
              </div>
              <div>
                <span>{simulationMode ? '数据源' : '应用状态'}</span>
                <strong>{simulationMode ? (initialSimulationStatus?.sourceAvailable || simulationConfig?.configured ? '已配置' : '未就绪') : localConfig.applied && !configDirty ? '已应用' : '待应用'}</strong>
              </div>
              <div>
                <span>{simulationMode ? '模拟通道' : '在线相机'}</span>
                <strong>
                  {simulationMode ? initialSimulationStatus?.channels.length ?? 0 : `${connectedCount}/${enabledCount}`}
                </strong>
              </div>
              <div>
                <span>{simulationMode ? '模拟状态' : '采集状态'}</span>
                <strong>{simulationMode ? simulationStateLabels[initialSimulationStatus?.state ?? 'idle'] : captureRunning ? '运行' : '待机'}</strong>
              </div>
              <div>
                <span>{simulationMode ? '播放进度' : 'SDK'}</span>
                <strong>{simulationMode ? `${Math.round(simulationProgressPercent(initialSimulationStatus?.progress))}%` : capture.health?.sdkReady ? '正常' : '等待'}</strong>
              </div>
              <div>
                <span>{simulationMode ? '物理相机' : '报警'}</span>
                <strong>{simulationMode ? '未启用' : offlineCount + warningCount}</strong>
              </div>
            </div>
          </header> : null}

          {captureMessage ? (
            <div className="capture-message">
              <CheckCircle2 size={16} />
              <span>{captureMessage}</span>
            </div>
          ) : null}

          {simulationMode ? (
            activeView === 'logs' ? (
              <Panel title="模拟采集日志" className="capture-log-panel">
                <div className="capture-event-list">
                  {recentLogs.map((event) => (
                    <div key={`${event.source || 'unknown'}-${event.id}`} className={event.level}>
                      <Activity size={15} />
                      <span>{formatTime(event.time)}</span>
                      <em>{captureLogSourceLabel(event.source)}</em>
                      <strong>{event.message}</strong>
                    </div>
                  ))}
                </div>
              </Panel>
            ) : <SimulationControlPanel initialStatus={initialSimulationStatus} simulationConfig={simulationConfig} />
          ) : selectedIp ? (
            renderDetail()
          ) : activeView === 'overview' ? (
            renderOverview()
          ) : activeView === 'config' ? (
            <section className="capture-config-workspace">
              <ConfigTable
                config={localConfig}
                dirty={configDirty}
                onCreate={handleCreateConfig}
                onChange={updateCameraConfig}
                onApply={() => void handleApplyConfig()}
                onReset={handleResetConfig}
              />
              <CaptureOperationsPanel
                cameraIps={localConfig.cameras.filter((camera) => camera.enabled).map((camera) => camera.ip)}
                cameraStatuses={overviewStatuses}
                expectedCameraCount={runtimeCameraCount}
              />
            </section>
          ) : activeView === 'logs' ? (
            <Panel title="采集日志" className="capture-log-panel">
              <div className="capture-event-list">
                {recentLogs.map((event) => (
                  <div key={`${event.source || 'unknown'}-${event.id}`} className={event.level}>
                    <Activity size={15} />
                    <span>{formatTime(event.time)}</span>
                    <em>{captureLogSourceLabel(event.source)}</em>
                    <strong>{event.cameraIp ? `${event.cameraIp} · ${event.message}` : event.message}</strong>
                  </div>
                ))}
              </div>
            </Panel>
          ) : (
            <Panel
              title={activeView === 'trigger' ? '触发设置' : '驱动与 API 能力'}
              className={`capture-api-panel ${activeView === 'trigger' ? 'trigger-settings-page' : ''}`}
            >
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
                <section className="capture-trigger-settings trigger-console" aria-label="trigger-settings" data-testid="trigger-settings">
                  <header className="trigger-console-header">
                    <div>
                      <span>全局生产控制台</span>
                      <h3>触发设置</h3>
                      <p>采集模式只控制相机是否出图；进出钢模式只控制生产数据库与相机存储状态。</p>
                    </div>
                    <div className={`trigger-live-state ${triggerGatewayStatus?.code === 0 ? 'online' : 'offline'}`}>
                      <Activity size={16} />
                      <span>当前触发</span>
                      <strong>{triggerGatewayModeLabel(triggerGatewayStatus?.mode || productionMode)}</strong>
                    </div>
                  </header>

                  <dl className="trigger-status-grid" aria-label="当前触发状态">
                    <div>
                      <dt>触发网关</dt>
                      <dd>{triggerGatewayStatus?.code === 0 ? '在线' : '离线'}</dd>
                      <span>{triggerGatewayStatus?.manualAllowed ? '允许手动控制' : '等待外部信号'}</span>
                    </div>
                    <div>
                      <dt>相机出图</dt>
                      <dd>{captureOutputModes.find((item) => item.mode === captureOutputMode)?.label}</dd>
                      <span>{captureOutputMode === 'continuous' ? `${connectedCount}/${enabledCount} 相机持续采集` : '不自动请求相机帧'}</span>
                    </div>
                    <div>
                      <dt>进出钢状态</dt>
                      <dd>{providerValue(productionStatus?.capture, ['phase', 'state', 'status']) || '待机'}</dd>
                      <span>{providerValue(productionStatus?.capture, ['captureSaveState', 'saveState', 'saveEnabled']) || '未保存'}</span>
                    </div>
                    <div>
                      <dt>数据库会话</dt>
                      <dd>{productionStatus?.activeSession?.status || '无活动会话'}</dd>
                      <span>{productionStatus?.activeSession?.materialId || productionDraft.materialId}</span>
                    </div>
                  </dl>

                  <section className="trigger-policy-grid" aria-label="触发模式配置">
                    <label>
                      <span>采集模式</span>
                      <select
                        aria-label="采集模式"
                        data-testid="capture-output-mode"
                        value={captureOutputMode}
                        onChange={(event) => void handleCaptureOutputModeChange(event.target.value as CaptureOutputMode)}
                        disabled={captureModeBusy}
                      >
                        {captureOutputModes.map((item) => <option key={item.mode} value={item.mode}>{item.label}</option>)}
                      </select>
                      <em>{captureOutputModes.find((item) => item.mode === captureOutputMode)?.detail}</em>
                    </label>
                    <label>
                      <span>进出钢模式</span>
                      <select
                        aria-label="进出钢模式"
                        data-testid="steel-flow-mode"
                        value={productionMode}
                        onChange={(event) => void handleTriggerModeChange(event.target.value as TriggerGatewayMode)}
                        disabled={triggerGatewayBusy}
                      >
                        {globalTriggerModes.map((item) => (
                          <option
                            key={item.mode}
                            value={item.mode}
                            disabled={triggerGatewayStatus?.allowedModes?.length ? !triggerGatewayStatus.allowedModes.includes(item.mode) : false}
                          >
                            {item.label}
                          </option>
                        ))}
                      </select>
                      <em>{globalTriggerModes.find((item) => item.mode === productionMode)?.detail}</em>
                    </label>
                  </section>

                  <section className="trigger-manual-workbench" aria-label="手动触发控制">
                    <header>
                      <div>
                        <span>人工操作</span>
                        <h4>手动触发控制</h4>
                      </div>
                      <strong>{manualTriggerPhase}</strong>
                    </header>
                    <div className="trigger-manual-control-grid">
                      <div className="trigger-manual-actions">
                        <button
                          type="button"
                          className="primary"
                          data-testid="manual-steel-in"
                          onClick={handleSteelIn}
                          disabled={productionBusy || productionMode !== 'manual' || !productionDraft.materialId.trim()}
                        >
                          <Play size={16} />
                          手动进钢
                        </button>
                        <button
                          type="button"
                          data-testid="manual-steel-out"
                          onClick={handleSteelOut}
                          disabled={productionBusy || productionMode !== 'manual' || !productionDraft.materialId.trim()}
                        >
                          <StopCircle size={16} />
                          手动出钢
                        </button>
                        <label className="trigger-duration-field">
                          <span>模拟进出钢</span>
                          <input
                            aria-label="模拟进出钢秒数"
                            type="number"
                            min={1}
                            max={3600}
                            value={manualSimulationSeconds}
                            onChange={(event) => setManualSimulationSeconds(Number(event.target.value))}
                          />
                          <em>秒</em>
                        </label>
                        <button
                          type="button"
                          className="simulation"
                          onClick={() => void handleTimedManualSimulation()}
                          disabled={productionBusy || productionMode !== 'manual' || !productionDraft.materialId.trim()}
                        >
                          <RefreshCw size={16} />
                          模拟进出钢
                        </button>
                      </div>

                      <section className="trigger-secondary-data">
                        <header>
                          <div>
                            <span>进钢二级数据</span>
                            <strong>{triggerTestOptions.writeSecondaryDataOnSteelIn ? '将随进钢写入数据库' : '仅预览，不写入'}</strong>
                          </div>
                          <span>{productionDraft.materialId}</span>
                        </header>
                        <textarea
                          aria-label="进钢二级数据"
                          value={triggerSecondaryData}
                          onChange={(event) => setTriggerSecondaryData(event.target.value)}
                          spellCheck={false}
                        />
                        <div className="trigger-test-options" aria-label="测试生成选项">
                          <label>
                            <input
                              type="checkbox"
                              checked={triggerTestOptions.writeSecondaryDataOnSteelIn}
                              onChange={(event) => setTriggerTestOptions((current) => ({ ...current, writeSecondaryDataOnSteelIn: event.target.checked }))}
                            />
                            进钢写入二级数据
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={triggerTestOptions.generateTestData}
                              onChange={(event) => setTriggerTestOptions((current) => ({ ...current, generateTestData: event.target.checked }))}
                            />
                            标记为测试生成
                          </label>
                        </div>
                      </section>
                    </div>
                  </section>
                  {triggerGatewayMessage ? <p className="capture-trigger-message">{triggerGatewayMessage}</p> : null}
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
  acquisitionMode = 'online',
  simulationConfig,
  capabilities = {
    directCamera: true,
    captureManagement: true,
    reconstruction: true,
    offlineReplay: false,
  },
  cameraCount = capture.config?.cameras.length ?? capture.statuses.length,
  onAction,
}: {
  status: DeviceStatus;
  operation: OperationState;
  capture: CaptureSnapshot;
  expectedCameraCount?: number;
  acquisitionMode?: AcquisitionMode;
  simulationConfig?: PublicRuntimeSimulationConfig;
  capabilities?: RuntimeCapabilities;
  cameraCount?: number;
  onAction: (action: SystemAction) => void;
}) {
  const [embeddedManager, setEmbeddedManager] = useState(true);
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
  const captureRunning = overviewStatuses.some((camera) => camera.continuousAcquiring || camera.streamRunning);
  const recentLogs = useMemo(
    () => mergeCaptureLogEvents(capture.logs, operation.events),
    [capture.logs, operation.events],
  );
  const simulationMode = acquisitionMode === 'simulation' || isSimulationCapture(capture);
  const initialSimulationStatus = capture.health && 'simulation' in capture.health
    ? capture.health.simulation ?? null
    : null;

  if (acquisitionMode === 'offline' || !capabilities.captureManagement) {
    return (
      <main className="workspace-page capture-terminal-page runtime-capability-summary">
        <section className="mode-error-panel">
          <span>当前运行模式</span>
          <h1>离线运行状态</h1>
          <p>{cameraCount} 路配置相机</p>
          <p>当前不启动采集；历史查询、缺陷复核、报告和配置业务保持可用。</p>
        </section>
      </main>
    );
  }

  const openIndependentManager = async () => {
    try {
      const result = await openCaptureManagementWindow();
      setTerminalMessage(result.presentation === 'navigation' ? '正在进入采集管理' : '已打开独立采集管理窗口');
    } catch (error) {
      setTerminalMessage(error instanceof Error ? error.message : '采集管理打开失败');
    }
  };

  const openBarSurfaceWorkbench = async () => {
    try {
      const result = await openBarSurfaceWindow();
      setTerminalMessage(result.presentation === 'navigation' ? '正在进入 3D 重建工作台' : '已打开独立 3D 重建窗口');
    } catch (error) {
      setTerminalMessage(error instanceof Error ? error.message : '3D 重建工作台打开失败');
    }
  };

  if (embeddedManager) {
    return (
      <main className="workspace-page capture-page capture-terminal-page">
        <div className="capture-terminal-embed-bar">
          <div className="capture-terminal-embed-heading">
            <span>终端内嵌模式</span>
            <strong>{simulationMode ? '模拟采集管理界面' : '真实采集管理界面'}</strong>
          </div>
          <div className="capture-terminal-embed-workflow" aria-label="采集配置流程">
            <span>{simulationMode ? '读取数据集' : '选择配置'}</span>
            <i />
            <span>{simulationMode ? '启动模拟' : '应用配置'}</span>
            <i />
            <span>{simulationMode ? '通道进度' : '相机总览'}</span>
            <i />
            <span>{simulationMode ? '完成/循环' : '进入详情'}</span>
          </div>
          <div className="capture-terminal-embed-status" aria-label="采集状态摘要">
            <span title={config.name}>配置 <strong>{config.name}</strong></span>
            <span>应用 <strong>{config.applied ? '已应用' : '待应用'}</strong></span>
            <span>{simulationMode ? '模拟通道' : '相机'} <strong>{simulationMode ? initialSimulationStatus?.channels.length ?? 0 : `${connectedCount}/${enabledCount}`}</strong></span>
            <span>{simulationMode ? '模拟' : '采集'} <strong>{simulationMode ? simulationStateLabels[initialSimulationStatus?.state ?? 'idle'] : captureRunning ? '运行' : '待机'}</strong></span>
            <span>{simulationMode ? '进度' : 'SDK'} <strong>{simulationMode ? `${Math.round(simulationProgressPercent(initialSimulationStatus?.progress))}%` : capture.health?.sdkReady ? '正常' : '等待'}</strong></span>
            <span>{simulationMode ? '物理相机' : '报警'} <strong>{simulationMode ? '未启用' : offlineCount + warningCount}</strong></span>
            {simulationMode ? <em>模拟</em> : null}
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
          expectedCameraCount={cameraCount}
          acquisitionMode={acquisitionMode}
          simulationConfig={simulationConfig}
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
                <span>当前使用已采集数据模拟生产运行；模拟通道不代表物理相机在线。</span>
              </div>
            </div>
          ) : null}
          {simulationMode ? <SimulationControlPanel initialStatus={initialSimulationStatus} simulationConfig={simulationConfig} /> : <div className="capture-terminal-summary">
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
          </div>}
          {!simulationMode ? <div className="capture-terminal-camera-list">
            {overviewStatuses.map((camera) => (
              <button key={`${camera.configId}-${camera.ip}`} type="button" onClick={() => setEmbeddedManager(true)}>
                <i className={getStatusTone(camera)} />
                <strong>{camera.name || camera.ip}</strong>
                <span>{camera.ip}</span>
                <em>{getStatusLabel(camera)}</em>
              </button>
            ))}
          </div> : null}
        </Panel>

        <Panel title="采集管理入口" className="capture-terminal-entry-panel">
          <div className="capture-terminal-entry-actions">
            <button type="button" className="primary" onClick={() => void openIndependentManager()}>
              <ArrowRight size={16} />
              打开采集管理
            </button>
            <button type="button" onClick={() => setEmbeddedManager(true)}>
              <Gauge size={16} />
              内嵌{simulationMode ? '模拟' : '真实'}管理界面
            </button>
            {capabilities.reconstruction ? (
              <button type="button" onClick={openBarSurfaceWorkbench}>
                <Box size={16} />
                3D 重建工作台
              </button>
            ) : null}
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
              <dd>轻量概览，完整管理在专用界面</dd>
            </div>
          </dl>
          {terminalMessage ? <strong className="capture-terminal-message">{terminalMessage}</strong> : null}
        </Panel>

        <Panel title="最近采集事件" className="capture-terminal-log-panel">
          <div className="capture-event-list compact">
            {recentLogs.slice(0, 6).map((event) => (
              <div key={`${event.source || 'unknown'}-${event.id}`} className={event.level}>
                <Activity size={15} />
                <span>{formatTime(event.time)}</span>
                <em>{captureLogSourceLabel(event.source)}</em>
                <strong>{event.cameraIp ? `${event.cameraIp} · ${event.message}` : event.message}</strong>
              </div>
            ))}
          </div>
        </Panel>
      </section>
    </main>
  );
}
