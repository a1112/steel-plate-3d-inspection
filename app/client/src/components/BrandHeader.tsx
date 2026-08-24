import { Activity, Camera, Cpu, Server } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import ustbLogoDark from '../assets/USTB-dark.png';
import ustbLogo from '../assets/USTB.png';
import type { DeviceStatus, ThemeMode } from '../data/inspection';
import type { TriggerGatewayStatus } from '../services/inspection-api';
import type { CaptureCameraStatus, CaptureSnapshot, SystemNetworkRateInterface, SystemNetworkRateSnapshot } from '../lib/capture-api';
import type { RuntimeDashboardMode } from '../lib/runtime-dashboard-mode';
import { NotificationCenter } from './NotificationCenter';
import { TopNav, type NavKey } from './TopNav';
import { WindowControls } from './WindowControls';
import { DEFAULT_SYSTEM_NAME } from '../lib/system-brand';

export type BkvDataHealth =
  | { state: 'loading'; detail: string }
  | { state: 'ready'; detail: string }
  | { state: 'store-error'; detail: string };

export type BkvHeaderData = {
  cameraCount: number;
  availableCameraCount: number;
  batchId: string;
  health: BkvDataHealth;
};

interface BrandHeaderProps {
  systemName?: string;
  status: DeviceStatus;
  theme: ThemeMode;
  expectedCameraCount?: number;
  capture?: CaptureSnapshot;
  network?: SystemNetworkRateSnapshot | null;
  trigger?: TriggerGatewayStatus | null;
  services?: ServiceStatusPanel;
  activeNav: NavKey;
  dashboardMode?: RuntimeDashboardMode;
  bkvData?: BkvHeaderData;
  onBkvConversionStatusOpen?: () => void;
  analysisCollapse?: {
    collapsed: boolean;
    onToggle: () => void;
  };
  onNavChange: (next: NavKey) => void;
  onDragMouseDown: (event: MouseEvent<HTMLElement>) => void;
}

const DEFAULT_DIRECT_DASHBOARD_MODE: RuntimeDashboardMode = {
  kind: 'direct',
  cameraCount: 8,
  requestsOnlineServices: true,
  requestsStandardRecords: false,
  showsHardwareStatus: true,
  showsCaptureManagement: true,
  showsReconstruction: true,
  supportsOfflineReplay: false,
};

type ServiceConnectionState = 'online' | 'warning' | 'offline';

type ServiceStatusPanelItem = {
  name: string;
  state: ServiceConnectionState;
  detail: string;
  endpoint: string;
};

type ServiceStatusPanel = {
  inspectionService: ServiceStatusPanelItem;
  captureService: ServiceStatusPanelItem;
  triggerGateway: ServiceStatusPanelItem;
};

function serviceStatusText(state: ServiceConnectionState) {
  switch (state) {
    case 'online':
      return '在线';
    case 'warning':
      return '异常';
    case 'offline':
    default:
      return '离线';
  }
}

function serviceStatusTone(state: ServiceConnectionState) {
  if (state === 'online') {
    return 'ok';
  }
  if (state === 'warning') {
    return 'warning';
  }
  return 'error';
}

function makeUnknownService(name: string): ServiceStatusPanelItem {
  return {
    name,
    state: 'offline',
    detail: '离线',
    endpoint: '--',
  };
}

type Port = { index: number; ok: boolean; title?: string };

interface CameraDetail {
  index: number;
  station: string;
  ip: string;
  model: string;
  sn: string;
  status: string;
  frameRate: string;
  temperature: string;
  sdkStatus: string;
  buffer: string;
  lastFrame: string;
}

interface ReceiverDetail {
  index: number;
  channel: string;
  ip: string;
  throughput: string;
  latency: string;
  status: string;
  uploadMbps: number;
  downloadMbps: number;
  bandwidthMbps: number;
  realtime?: boolean;
}

type ReceiverNetworkTotals = {
  upload: number;
  download: number;
  bandwidth: number;
};

const cameraStations = Array.from({ length: 8 }, (_, index) => `${index + 1}号采集相机`);
const DEFAULT_CAMERA_COUNT = 8;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatTime(value?: string | null) {
  if (!value) {
    return '--';
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleTimeString('zh-CN', { hour12: false });
  }
  return value.includes('T') ? value.slice(11, 19) : value;
}

function formatFrameRate(value?: number | null) {
  if (!isFiniteNumber(value) || value <= 0) {
    return '--';
  }
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} Hz`;
}

function formatMbps(value?: number | null) {
  if (!isFiniteNumber(value) || value <= 0) {
    return '0';
  }
  if (value >= 100) {
    return value.toLocaleString('zh-CN', { maximumFractionDigits: 0, useGrouping: false });
  }
  if (value >= 10) {
    return value.toLocaleString('zh-CN', { maximumFractionDigits: 1, useGrouping: false });
  }
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2, useGrouping: false });
}

function formatNetworkSampleTime(value?: number | null) {
  if (!isFiniteNumber(value) || value <= 0) {
    return '--';
  }
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function formatPercent(value?: number | null) {
  if (!isFiniteNumber(value)) {
    return '--';
  }
  return `${value.toFixed(0)}%`;
}

function formatCameraTemperature(camera: CaptureCameraStatus) {
  const values = [camera.temperatureJ28, camera.temperatureJ29, camera.temperatureJ30].filter(isFiniteNumber);
  if (!values.length) {
    return '--';
  }
  return `${Math.max(...values).toFixed(1)} C`;
}

function cameraFrameRate(camera: CaptureCameraStatus) {
  // The capture dashboard reports completed production depth-map FPS.  Preview
  // stream telemetry and the SDK's maximum frame-rate are different metrics.
  return formatFrameRate(camera.continuousFps);
}

function cameraStation(camera: CaptureCameraStatus, index: number) {
  return camera.name || camera.role || camera.configId || cameraStations[index] || `相机 ${index + 1}`;
}

function cameraStatusText(camera: CaptureCameraStatus) {
  if (camera.enabled === false) {
    return '停用';
  }
  if (camera.connected) {
    return camera.error ? '异常' : '在线';
  }
  if (camera.acquisitionState === 'discovered') {
    return '已发现';
  }
  return '离线';
}

function isCameraHealthy(camera: CaptureCameraStatus) {
  const sdkStatus = (camera.sdkStatus ?? '').toLowerCase();
  return cameraStatusText(camera) === '在线' && !sdkStatus.includes('error') && !sdkStatus.includes('fail') && !sdkStatus.includes('offline');
}

function isReceiverDetailOk(detail: ReceiverDetail) {
  return detail.status === '已连接' || detail.status === '运行中' || detail.status === '正常' || detail.status === '在线';
}

function createCameraDetails(ports: Port[]): CameraDetail[] {
  return ports.map((port, index) => ({
    index: port.index,
    station: cameraStations[index] ?? `相机 ${port.index}`,
    ip: `192.168.20.${100 + port.index}`,
    model: '模拟链路',
    sn: '--',
    status: port.ok ? '在线' : '链路异常',
    frameRate: port.ok ? `${(24.6 + (index % 3) * 0.2).toFixed(1)} kHz` : '--',
    temperature: port.ok ? `${38 + index} C` : '--',
    sdkStatus: port.ok ? 'ready' : 'error',
    buffer: '--',
    lastFrame: '--',
  }));
}

function receiverNetworkScore(item: SystemNetworkRateInterface) {
  const text = `${item.name} ${item.description ?? ''}`.toLowerCase();
  const trafficBytes = Math.max(0, item.receivedBytes) + Math.max(0, item.transmittedBytes);
  const packets = Math.max(0, item.packetsReceived ?? 0) + Math.max(0, item.packetsTransmitted ?? 0);
  const realtimeMbps = Math.max(0, item.uploadMbps) + Math.max(0, item.downloadMbps);
  let score = 0;
  if (item.online) score += 100;
  if (text.includes('slot') || text.includes('端口') || text.includes('i350') || text.includes('ethernet')) score += 30;
  if (text.includes('wlan') || text.includes('wifi') || text.includes('wireless')) score -= 40;
  if (item.bandwidthMbps > 0) score += 10;
  if (trafficBytes > 0) score += 20;
  if (packets > 0) score += 10;
  if (realtimeMbps > 0) score += Math.min(30, realtimeMbps);
  return score;
}

function selectReceiverNetworkInterfaces(network?: SystemNetworkRateSnapshot | null) {
  if (!network?.interfaces.length) {
    return [];
  }
  return [...network.interfaces]
    .sort((left, right) => {
      const scoreDelta = receiverNetworkScore(right) - receiverNetworkScore(left);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return left.name.localeCompare(right.name, 'zh-CN', { numeric: true });
    })
    .slice(0, 8);
}

function createReceiverDetailsFromNetwork(network?: SystemNetworkRateSnapshot | null): ReceiverDetail[] {
  const interfaces = selectReceiverNetworkInterfaces(network);
  if (!interfaces.length) {
    return [];
  }
  return interfaces.map((item, index) => ({
    index: index + 1,
    channel: item.name || `网口 ${index + 1}`,
    ip: item.description || '本机网卡',
    throughput: `↑ ${formatMbps(item.uploadMbps)} / ↓ ${formatMbps(item.downloadMbps)} Mbps`,
    latency: formatNetworkSampleTime(network?.sampledAtMs),
    status: item.online ? '在线' : '离线',
    uploadMbps: item.uploadMbps,
    downloadMbps: item.downloadMbps,
    bandwidthMbps: item.bandwidthMbps > 0 ? item.bandwidthMbps : Math.max(1000, item.uploadMbps + item.downloadMbps),
    realtime: true,
  }));
}

function createNetworkMonitorPlaceholder(network: SystemNetworkRateSnapshot): ReceiverDetail[] {
  const message = network.error?.trim() || (network.code === 0 ? '未发现网卡' : '/api/system/network 离线');
  return [
    {
      index: 1,
      channel: '网络监控',
      ip: message,
      throughput: '--',
      latency: formatNetworkSampleTime(network.sampledAtMs),
      status: '离线',
      uploadMbps: 0,
      downloadMbps: 0,
      bandwidthMbps: 0,
      realtime: true,
    },
  ];
}

function createReceiverDetailsFromCapture(
  capture: CaptureSnapshot | undefined,
  network?: SystemNetworkRateSnapshot | null,
  expectedCameraCount = DEFAULT_CAMERA_COUNT,
): ReceiverDetail[] {
  const realtimeDetails = createReceiverDetailsFromNetwork(network);
  if (realtimeDetails.length) {
    return realtimeDetails;
  }
  if (network) {
    return createNetworkMonitorPlaceholder(network);
  }

  if (!capture || (!capture.health && !capture.statuses.length && !capture.error)) {
    return createNetworkMonitorPlaceholder({
      code: 1,
      source: 'ui-network-monitor',
      sampledAtMs: Date.now(),
      interfaces: [],
      totalUploadMbps: 0,
      totalDownloadMbps: 0,
      totalBandwidthMbps: 0,
      error: 'network monitor pending',
    });
  }

  const health = capture.health;
  const apiOk = Boolean(health) && !capture.error;
  const sdkOk = Boolean(health?.sdkReady);
  const cameraLimit = Math.max(1, Math.floor(expectedCameraCount));
  const cameraLinks = capture.statuses.slice(0, cameraLimit).map((camera, index): ReceiverDetail => ({
    index: index + 3,
    channel: `${camera.name || `camera${index + 1}`} 链路`,
    ip: camera.ip || '--',
    throughput: cameraFrameRate(camera),
    latency: formatTime(camera.lastContinuousFrameAt ?? camera.lastFrameTime),
    status: isCameraHealthy(camera) ? '已连接' : cameraStatusText(camera),
    uploadMbps: 0,
    downloadMbps: 0,
    bandwidthMbps: 0,
  }));

  return [
    {
      index: 1,
      channel: '采集 API',
      ip: '127.0.0.1',
      throughput: apiOk ? 'HTTP 在线' : '--',
      latency: formatTime(health?.time),
      status: apiOk ? '运行中' : '离线',
      uploadMbps: 0,
      downloadMbps: 0,
      bandwidthMbps: 0,
    },
    {
      index: 2,
      channel: 'LVM SDK',
      ip: health?.driverId || capture.driver.id,
      throughput: health?.sdkVersion || capture.driver.sdkVersion || '--',
      latency: health ? `code ${health.sdkCode}` : '--',
      status: sdkOk ? '正常' : '异常',
      uploadMbps: 0,
      downloadMbps: 0,
      bandwidthMbps: 0,
    },
    ...cameraLinks,
  ].slice(0, cameraLimit + 2);
}

function createCameraDetailsFromCapture(
  capture: CaptureSnapshot | undefined,
  fallbackPorts: Port[],
  expectedCameraCount: number,
): CameraDetail[] {
  const cameraLimit = Math.max(1, Math.floor(expectedCameraCount));
  if (!capture?.statuses.length) {
    return createCameraDetails(fallbackPorts.slice(0, cameraLimit));
  }

  return capture.statuses.slice(0, cameraLimit).map((camera, index) => ({
    index: index + 1,
    station: cameraStation(camera, index),
    ip: camera.ip || '--',
    model: camera.model || '--',
    sn: camera.sn || '--',
    status: cameraStatusText(camera),
    frameRate: cameraFrameRate(camera),
    temperature: formatCameraTemperature(camera),
    sdkStatus: camera.sdkStatus || camera.acquisitionState || '--',
    buffer: formatPercent(camera.bufferPercent),
    lastFrame: formatTime(camera.lastFrameTime),
  }));
}

function PortContent({ title, ports }: { title: string; ports: Port[] }) {
  const onlineCount = ports.filter((port) => port.ok).length;
  return (
    <>
      <span>{title}</span>
      <strong className={`port-count-summary ${onlineCount === ports.length ? 'ok' : 'warning'}`}>
        {onlineCount}/{ports.length}
      </strong>
    </>
  );
}

function PortSpeedSummary({ upload, download, realtime }: { upload: number; download: number; realtime: boolean }) {
  const uploadText = formatMbps(upload);
  const downloadText = formatMbps(download);
  return (
    <span
      className={`port-speed-summary ${realtime ? 'realtime' : ''}`}
      title={`${realtime ? '实时' : '估算'}上传 ${uploadText} Mbps / 下载 ${downloadText} Mbps`}
      aria-label={`${realtime ? '实时' : '估算'}上传 ${uploadText} Mbps，下载 ${downloadText} Mbps`}
    >
      <span className="port-speed-title">{realtime ? '实时网速' : '网速无数据'}</span>
      <span className="port-speed-value">
        <em>上</em>
        <b>{uploadText}</b>
      </span>
      <span className="port-speed-value">
        <em>下</em>
        <b>{downloadText}</b>
      </span>
    </span>
  );
}

function networkUsagePercent(value: number, bandwidth: number) {
  if (!Number.isFinite(value) || !Number.isFinite(bandwidth) || bandwidth <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (value / bandwidth) * 100));
}

function networkPeakUsagePercent(upload: number, download: number, bandwidth: number) {
  return networkUsagePercent(Math.max(upload, download), bandwidth);
}

function ReceiverNetworkMeter({
  value,
  bandwidth,
  label,
  full = false,
}: {
  value: number;
  bandwidth: number;
  label: string;
  full?: boolean;
}) {
  const ratio = full ? 100 : networkUsagePercent(value, bandwidth);
  const displayValue = formatMbps(value);
  return (
    <span
      className={`receiver-network-meter ${full ? 'capacity' : ''}`}
      style={{ '--receiver-network-ratio': `${ratio}%` } as CSSProperties}
      aria-label={`${label} ${displayValue} Mbps`}
    >
      <i aria-hidden="true" />
      <b>{displayValue}</b>
      <em>Mbps</em>
    </span>
  );
}

function ReceiverNetworkUsage({ upload, download, bandwidth, label }: { upload: number; download: number; bandwidth: number; label: string }) {
  const ratio = networkPeakUsagePercent(upload, download, bandwidth);
  return (
    <span
      className="receiver-network-meter receiver-network-usage"
      style={{ '--receiver-network-ratio': `${ratio}%` } as CSSProperties}
      aria-label={`${label} 利用率 ${ratio.toFixed(1)}%`}
    >
      <i aria-hidden="true" />
      <b>{ratio.toFixed(1)}</b>
      <em>%</em>
    </span>
  );
}

function ReceiverStatusPanel({ details, realtime, totals }: { details: ReceiverDetail[]; realtime: boolean; totals?: ReceiverNetworkTotals }) {
  const onlineCount = details.filter(isReceiverDetailOk).length;
  const offlineCount = details.length - onlineCount;
  const detailTotals = details.reduce(
    (totals, detail) => {
      totals.upload += detail.uploadMbps;
      totals.download += detail.downloadMbps;
      totals.bandwidth += detail.bandwidthMbps;
      return totals;
    },
    { upload: 0, download: 0, bandwidth: 0 },
  );
  const networkTotals = totals ?? detailTotals;
  const peakUsage = networkPeakUsagePercent(networkTotals.upload, networkTotals.download, networkTotals.bandwidth);

  return (
    <div className="camera-detail-popover receiver-detail-popover" id="receiver-detail-panel" role="dialog" aria-label="报级器网口详细信息" data-no-drag>
      <div className="camera-detail-head">
        <div>
          <strong>报级器网口详细信息</strong>
          <span>{realtime ? 'Windows 网卡实时收发速率，只读监控' : '未连接到实时网络监控，上传/下载速率不显示估算值'}</span>
        </div>
        <div className="camera-detail-metrics">
          <span aria-label={`在线网口 ${onlineCount}`}>
            <b>{onlineCount}</b>在线网口
          </span>
          <span className={offlineCount > 0 ? 'bad' : ''} aria-label={`异常网口 ${offlineCount}`}>
            <b>{offlineCount}</b>异常网口
          </span>
        </div>
      </div>
      <section className="receiver-network-summary" aria-label="网口带宽监控汇总">
        <div>
          <span>{realtime ? '实时上传' : '上传监控'}</span>
          <strong>{formatMbps(networkTotals.upload)}</strong>
          <em>Mbps</em>
        </div>
        <div>
          <span>{realtime ? '实时下载' : '下载监控'}</span>
          <strong>{formatMbps(networkTotals.download)}</strong>
          <em>Mbps</em>
        </div>
        <div>
          <span>带宽监控</span>
          <strong>{formatMbps(networkTotals.bandwidth)}</strong>
          <em>Mbps</em>
        </div>
        <div>
          <span>峰值利用率</span>
          <strong>{peakUsage.toFixed(1)}</strong>
          <em>%</em>
        </div>
      </section>
      <div className="receiver-network-table-wrap">
        <table className="camera-detail-table">
          <thead>
            <tr>
              <th>编号</th>
              <th>网口</th>
              <th>描述</th>
              <th>状态值</th>
              <th>时间/返回</th>
              <th>实时上传</th>
              <th>实时下载</th>
              <th>网口带宽</th>
              <th>利用率</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {details.map((port) => (
              <tr key={port.index} className={isReceiverDetailOk(port) ? 'ok' : 'bad'}>
                <td>{port.index}</td>
                <td>{port.channel}</td>
                <td>{port.ip}</td>
                <td>{port.throughput}</td>
                <td>{port.latency}</td>
                <td>
                  <ReceiverNetworkMeter value={port.uploadMbps} bandwidth={port.bandwidthMbps} label={`${port.index} 上传`} />
                </td>
                <td>
                  <ReceiverNetworkMeter value={port.downloadMbps} bandwidth={port.bandwidthMbps} label={`${port.index} 下载`} />
                </td>
                <td>
                  <ReceiverNetworkMeter value={port.bandwidthMbps} bandwidth={port.bandwidthMbps} label={`${port.index} 带宽`} full />
                </td>
                <td>
                  <ReceiverNetworkUsage upload={port.uploadMbps} download={port.downloadMbps} bandwidth={port.bandwidthMbps} label={`${port.index} 网口`} />
                </td>
                <td>{port.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CameraStatusPanel({ details }: { details: CameraDetail[] }) {
  const onlineCount = details.filter((item) => item.status === '在线').length;
  const offlineCount = details.length - onlineCount;

  return (
    <div className="camera-detail-popover camera-detail-popover-wide" id="camera-detail-panel" role="dialog" aria-label="相机状态详细信息" data-no-drag>
      <div className="camera-detail-head">
        <div>
          <strong>相机状态详细信息</strong>
          <span>{details.length} 路 3D 线扫相机实时状态</span>
        </div>
        <div className="camera-detail-metrics">
          <span aria-label={`在线相机 ${onlineCount}`}>
            <b>{onlineCount}</b>在线相机
          </span>
          <span className={offlineCount > 0 ? 'bad' : ''} aria-label={`异常相机 ${offlineCount}`}>
            <b>{offlineCount}</b>异常相机
          </span>
        </div>
      </div>
      <table className="camera-detail-table">
        <thead>
          <tr>
            <th>编号</th>
            <th>站位</th>
            <th>IP</th>
            <th>型号 / SN</th>
            <th>帧率</th>
            <th>温度</th>
            <th>SDK / 缓冲</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {details.map((camera) => (
            <tr key={camera.index} className={camera.status === '在线' ? 'ok' : 'bad'}>
              <td>{camera.index}</td>
              <td>{camera.station}</td>
              <td>{camera.ip}</td>
              <td>
                {camera.model}
                <small>{camera.sn}</small>
              </td>
              <td>{camera.frameRate}</td>
              <td>{camera.temperature}</td>
              <td>
                {camera.sdkStatus}
                <small>{camera.buffer} / {camera.lastFrame}</small>
              </td>
              <td>{camera.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBlock({
  label,
  value,
  tone = 'ok',
  title,
  className,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warning' | 'error' | 'alarm';
  title?: string;
  className?: string;
}) {
  return (
    <div className={`status-block ${className ?? ''}`}>
      <span>{label}</span>
      <strong className={tone} title={title}>
        {value}
      </strong>
    </div>
  );
}

function SystemStatusDetailPanel({ status }: { status: DeviceStatus }) {
  const entries = [
    { label: '编码器', value: status.encoder === 'sync' ? '同步正常' : '离线', ok: status.encoder === 'sync' },
    { label: 'PLC', value: status.plc === 'normal' ? '正常' : '异常', ok: status.plc === 'normal' },
    { label: 'L2', value: status.l2 === 'normal' ? '正常' : '异常', ok: status.l2 === 'normal' },
  ];

  return (
    <div className="service-status-popover system-status-popover" id="system-status-detail-panel" role="dialog" aria-label="控制系统状态详情" data-no-drag>
      <header>
        <div>
          <strong>控制系统状态</strong>
          <span>编码器、PLC 与 L2 连接详情</span>
        </div>
      </header>
      <div className="service-status-detail-list system-status-detail-list">
        {entries.map((entry) => (
          <section key={entry.label} className={entry.ok ? 'online' : 'offline'}>
            <i aria-hidden="true" />
            <div>
              <strong>{entry.label}</strong>
              <span>{entry.value}</span>
            </div>
            <em>{entry.ok ? '正常' : '异常'}</em>
          </section>
        ))}
      </div>
    </div>
  );
}

export function BrandHeader({
  systemName = DEFAULT_SYSTEM_NAME,
  status,
  theme,
  expectedCameraCount = DEFAULT_CAMERA_COUNT,
  capture,
  network,
  trigger,
  services,
  activeNav,
  dashboardMode = DEFAULT_DIRECT_DASHBOARD_MODE,
  bkvData,
  onBkvConversionStatusOpen,
  analysisCollapse,
  onNavChange,
  onDragMouseDown,
}: BrandHeaderProps) {
  const serviceStatus = services ?? {
    inspectionService: makeUnknownService('检测服务'),
    captureService: makeUnknownService('采集服务'),
    triggerGateway: makeUnknownService('触发网关'),
  };
  const logoSrc = theme === 'light' ? ustbLogo : ustbLogoDark;
  const bkvHealth = bkvData?.health ?? {
    state: 'loading',
    detail: '正在读取 BKV 标准离线仓库',
  };
  const bkvHealthValue = bkvHealth.state === 'ready'
    ? '数据就绪'
    : bkvHealth.state === 'store-error'
      ? 'BKV 数据异常'
      : '读取中';
  const bkvHealthTone = bkvHealth.state === 'ready'
    ? 'ok'
    : bkvHealth.state === 'store-error'
      ? 'error'
      : 'warning';
  const [activeDetail, setActiveDetail] = useState<'receiver' | 'camera' | 'system' | null>(null);
  const receiverWrapRef = useRef<HTMLDivElement>(null);
  const cameraWrapRef = useRef<HTMLDivElement>(null);
  const systemWrapRef = useRef<HTMLDivElement>(null);
  const receiverDetails = useMemo(
    () => createReceiverDetailsFromCapture(capture, network, expectedCameraCount),
    [capture, expectedCameraCount, network],
  );
  const receiverRealtime = receiverDetails.some((detail) => detail.realtime);
  const receiverPorts = useMemo(
    () =>
      receiverDetails.map((detail) => ({
        index: detail.index,
        ok: isReceiverDetailOk(detail),
        title: `${detail.channel} ${detail.ip} ${detail.status}`,
      })),
    [receiverDetails],
  );
  const cameraDetails = useMemo(
    () => createCameraDetailsFromCapture(capture, status.cameraPorts, expectedCameraCount),
    [capture, expectedCameraCount, status.cameraPorts],
  );
  const cameraPorts = useMemo(
    () =>
      cameraDetails.map((camera) => ({
        index: camera.index,
        ok: camera.status === '在线',
        title: `${camera.station} ${camera.ip} ${camera.status}`,
      })),
    [cameraDetails],
  );
  const onlineReceiverCount = receiverDetails.filter(isReceiverDetailOk).length;
  const offlineReceiverCount = receiverDetails.length - onlineReceiverCount;
  const receiverSpeedTotals = useMemo(
    () => {
      if (receiverRealtime && network) {
        return {
          upload: network.totalUploadMbps,
          download: network.totalDownloadMbps,
          bandwidth: network.totalBandwidthMbps,
        };
      }
      return receiverDetails.reduce(
        (totals, detail) => ({
          upload: totals.upload + detail.uploadMbps,
          download: totals.download + detail.downloadMbps,
          bandwidth: totals.bandwidth + detail.bandwidthMbps,
        }),
        { upload: 0, download: 0, bandwidth: 0 },
      );
    },
    [network, receiverDetails, receiverRealtime],
  );
  const onlineCameraCount = cameraDetails.filter((camera) => camera.status === '在线').length;
  const offlineCameraCount = cameraDetails.length - onlineCameraCount;
  const systemIssueCount = Number(status.encoder !== 'sync') + Number(status.plc !== 'normal') + Number(status.l2 !== 'normal');
  const serviceIssueCount = Object.values(serviceStatus).filter((service) => service.state !== 'online').length;
  const triggerHealthy = trigger?.inspectionServiceHealthy !== false;
  const triggerValue = !trigger
    ? '未知'
    : triggerHealthy
      ? '就绪'
      : '服务异常';
  const triggerTitle = trigger
    ? `模式 ${trigger.modeLabel || trigger.mode} · 检测服务${triggerHealthy ? '可达' : '不可达'}`
    : '触发网关状态不可用';

  useEffect(() => {
    if (!activeDetail) {
      return;
    }

    const isInsideStatusPopover = (target: EventTarget | null) => {
      if (!(target instanceof Node)) {
        return false;
      }
      return [receiverWrapRef.current, cameraWrapRef.current, systemWrapRef.current].some((element) => element?.contains(target));
    };

    const closeWhenOutside = (event: Event) => {
      if (!isInsideStatusPopover(event.target)) {
        setActiveDetail(null);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveDetail(null);
      }
    };

    document.addEventListener('mousedown', closeWhenOutside);
    document.addEventListener('focusin', closeWhenOutside);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('blur', closeWhenOutside);

    return () => {
      document.removeEventListener('mousedown', closeWhenOutside);
      document.removeEventListener('focusin', closeWhenOutside);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('blur', closeWhenOutside);
    };
  }, [activeDetail]);

  return (
    <header className="brand-header" onMouseDown={onDragMouseDown}>
      <div className="brand-left">
        <img src={logoSrc} alt="北科工研" className="ustb-logo" draggable={false} />
      </div>

      <div className="title-meta-group">
        <TopNav active={activeNav} onChange={onNavChange} embedded />
        <div className="system-title">{systemName}</div>
      </div>

      <div className={`brand-status ${dashboardMode.kind === 'bkv' || dashboardMode.kind === 'bkv-online' ? 'bkv-runtime-status' : 'online-runtime-status'}`}>
        {dashboardMode.kind === 'bkv' ? (
          <>
            <StatusBlock className="bkv-mode-status" label="BKV 模式" value="离线回放" title={bkvHealth.detail} />
            <StatusBlock className="bkv-data-status" label="离线数据" value={`${bkvData?.availableCameraCount ?? 0}/${bkvData?.cameraCount ?? dashboardMode.cameraCount}`} title={bkvHealth.detail} />
            <StatusBlock className="bkv-batch-status" label="批次" value={bkvData?.batchId ?? '读取中'} title={bkvData?.batchId} />
            <StatusBlock
              className="bkv-ready-status"
              label="检测数据"
              value={bkvHealthValue}
              tone={bkvHealthTone}
              title={bkvHealth.detail}
            />
          </>
        ) : dashboardMode.kind === 'bkv-online' ? (
          <>
            <StatusBlock className="bkv-mode-status" label="BKV 模式" value="在线转换" title={bkvHealth.detail} />
            <StatusBlock
              className="bkv-data-status"
              label="共享图像"
              value={`${bkvData?.availableCameraCount ?? 0}/${bkvData?.cameraCount ?? dashboardMode.cameraCount}`}
              title={bkvHealth.detail}
            />
            <StatusBlock
              className="bkv-batch-status"
              label="最新记录"
              value={bkvData?.batchId ?? '读取中'}
              title={bkvData?.batchId}
            />
            <button
              type="button"
              className="bkv-conversion-status-open"
              onClick={onBkvConversionStatusOpen}
              data-no-drag
            >
              <Activity size={15} />
              <span>数据转换</span>
              <strong className={bkvHealthTone}>{bkvHealthValue}</strong>
            </button>
          </>
        ) : (
          <>
        <StatusBlock
          className="trigger-header-status"
          label="触发状态"
          value={triggerValue}
          tone={trigger ? (triggerHealthy ? 'ok' : 'warning') : 'warning'}
          title={triggerTitle}
        />
        <div className="port-status-stack" data-testid="hardware-status-stack">
          <div ref={receiverWrapRef} className="camera-status-wrap receiver-status-wrap" data-no-drag onMouseDown={(event) => event.stopPropagation()}>
            <button
              className={`port-group port-group-button ${activeDetail === 'receiver' ? 'active' : ''}`}
              type="button"
              data-testid="receiver-status-button"
              aria-expanded={activeDetail === 'receiver'}
              aria-controls="receiver-detail-panel"
              aria-label={`报级器网口，在线 ${onlineReceiverCount} 路，异常 ${offlineReceiverCount} 路`}
              onClick={(event) => {
                event.stopPropagation();
                setActiveDetail((current) => (current === 'receiver' ? null : 'receiver'));
              }}
            >
              <PortContent title="报级器网口" ports={receiverPorts} />
              <PortSpeedSummary upload={receiverSpeedTotals.upload} download={receiverSpeedTotals.download} realtime={receiverRealtime} />
            </button>
            {activeDetail === 'receiver' ? <ReceiverStatusPanel details={receiverDetails} realtime={receiverRealtime} totals={receiverSpeedTotals} /> : null}
          </div>
          <div ref={cameraWrapRef} className="camera-status-wrap" data-no-drag onMouseDown={(event) => event.stopPropagation()}>
            <button
              className={`port-group port-group-button ${activeDetail === 'camera' ? 'active' : ''}`}
              type="button"
              data-testid="camera-status-button"
              aria-expanded={activeDetail === 'camera'}
              aria-controls="camera-detail-panel"
              aria-label={`相机状态，在线 ${onlineCameraCount} 路，异常 ${offlineCameraCount} 路`}
              onClick={(event) => {
                event.stopPropagation();
                setActiveDetail((current) => (current === 'camera' ? null : 'camera'));
              }}
            >
              <PortContent title="相机状态" ports={cameraPorts} />
            </button>
            {activeDetail === 'camera' ? <CameraStatusPanel details={cameraDetails} /> : null}
          </div>
        </div>
        <StatusBlock label="编码器" value={status.encoder === 'sync' ? '同步正常' : '离线'} />
        <StatusBlock label="PLC" value={status.plc === 'normal' ? '正常' : '异常'} />
        <StatusBlock label="L2" value={status.l2 === 'normal' ? '正常' : '异常'} />
        <StatusBlock
          label={serviceStatus.inspectionService.name}
          value={serviceStatusText(serviceStatus.inspectionService.state)}
          tone={serviceStatusTone(serviceStatus.inspectionService.state)}
          title={`${serviceStatus.inspectionService.endpoint} ${serviceStatus.inspectionService.detail}`}
        />
        <StatusBlock
          label={serviceStatus.captureService.name}
          value={serviceStatusText(serviceStatus.captureService.state)}
          tone={serviceStatusTone(serviceStatus.captureService.state)}
          title={`${serviceStatus.captureService.endpoint} ${serviceStatus.captureService.detail}`}
        />
        <StatusBlock
          label={serviceStatus.triggerGateway.name}
          value={serviceStatusText(serviceStatus.triggerGateway.state)}
          tone={serviceStatusTone(serviceStatus.triggerGateway.state)}
          title={`${serviceStatus.triggerGateway.endpoint} ${serviceStatus.triggerGateway.detail}`}
        />
        <div ref={systemWrapRef} className="system-status-wrap" data-no-drag onMouseDown={(event) => event.stopPropagation()}>
          <button
            className={`header-summary-button ${systemIssueCount > 0 ? 'warning' : ''} ${activeDetail === 'system' ? 'active' : ''}`}
            type="button"
            aria-label={`控制系统，正常 ${3 - systemIssueCount} 项，异常 ${systemIssueCount} 项`}
            aria-expanded={activeDetail === 'system'}
            aria-controls="system-status-detail-panel"
            onClick={() => setActiveDetail((current) => (current === 'system' ? null : 'system'))}
          >
            <span>控制</span>
            <strong>{3 - systemIssueCount}/3</strong>
          </button>
          {activeDetail === 'system' ? <SystemStatusDetailPanel status={status} /> : null}
        </div>
        <div
          className={`run-indicator ${serviceIssueCount > 0 ? 'warning' : ''}`}
          aria-label={serviceIssueCount > 0 ? `系统服务异常 ${serviceIssueCount} 项` : '系统运行状态正常'}
        >
          <i />
          <span>{serviceIssueCount > 0 ? '服务异常' : '运行中'}</span>
        </div>
          </>
        )}
      </div>

      <div className="brand-right">
        <div className="mini-health">
          <Server size={13} />
          <Camera size={13} />
          <Cpu size={13} />
          <Activity size={13} />
        </div>
        <NotificationCenter embedded />
        <WindowControls analysisCollapse={dashboardMode.kind === 'direct' ? analysisCollapse : undefined} />
      </div>
    </header>
  );
}
