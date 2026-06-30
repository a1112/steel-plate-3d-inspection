import { Activity, Bell, Camera, Cpu, Server, Settings } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import ustbLogoDark from '../assets/USTB-dark.png';
import ustbLogo from '../assets/USTB.png';
import type { DeviceStatus, SteelPlate, ThemeMode } from '../data/inspection';
import { WindowControls } from './WindowControls';

interface BrandHeaderProps {
  status: DeviceStatus;
  plate: SteelPlate;
  theme: ThemeMode;
  onSettingsOpen: () => void;
  onDragMouseDown: (event: MouseEvent<HTMLElement>) => void;
}

type Port = { index: number; ok: boolean };

interface CameraDetail {
  index: number;
  station: string;
  ip: string;
  status: string;
  frameRate: string;
  temperature: string;
}

interface ReceiverDetail {
  index: number;
  channel: string;
  ip: string;
  throughput: string;
  latency: string;
  status: string;
}

const cameraStations = ['上表面-操作侧', '上表面-中部', '上表面-传动侧', '上表面-边部', '下表面-操作侧', '下表面-中部', '下表面-传动侧', '下表面-边部'];
const receiverChannels = ['一级判定', '二级判定', '严重报警', '待复核队列', '上表结果', '下表结果', 'L2 推送', '备用链路'];

function createReceiverDetails(ports: Port[]): ReceiverDetail[] {
  return ports.map((port, index) => ({
    index: port.index,
    channel: receiverChannels[index] ?? `报级通道 ${port.index}`,
    ip: `192.168.10.${80 + port.index}`,
    throughput: port.ok ? `${(118 + index * 6).toFixed(0)} Mbps` : '--',
    latency: port.ok ? `${(2.4 + (index % 4) * 0.3).toFixed(1)} ms` : '--',
    status: port.ok ? '已连接' : '连接异常',
  }));
}

function createCameraDetails(ports: Port[]): CameraDetail[] {
  return ports.map((port, index) => ({
    index: port.index,
    station: cameraStations[index] ?? `相机 ${port.index}`,
    ip: `192.168.20.${100 + port.index}`,
    status: port.ok ? '在线' : '链路异常',
    frameRate: port.ok ? `${(24.6 + (index % 3) * 0.2).toFixed(1)} kHz` : '--',
    temperature: port.ok ? `${38 + index} C` : '--',
  }));
}

function PortContent({ title, ports }: { title: string; ports: Port[] }) {
  return (
    <>
      <span>{title}</span>
      <div className="port-list">
        {ports.map((port) => (
          <i key={port.index} className={port.ok ? 'ok' : 'bad'}>
            {port.index}
          </i>
        ))}
      </div>
    </>
  );
}

function ReceiverStatusPanel({ details }: { details: ReceiverDetail[] }) {
  const onlineCount = details.filter((item) => item.status === '已连接').length;
  const offlineCount = details.length - onlineCount;

  return (
    <div className="camera-detail-popover receiver-detail-popover" id="receiver-detail-panel" role="dialog" aria-label="报级器网口详细信息" data-no-drag>
      <div className="camera-detail-head">
        <div>
          <strong>报级器网口详细信息</strong>
          <span>8 路缺陷判级与结果上传链路</span>
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
      <table className="camera-detail-table">
        <thead>
          <tr>
            <th>编号</th>
            <th>通道</th>
            <th>IP</th>
            <th>吞吐</th>
            <th>延迟</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {details.map((port) => (
            <tr key={port.index} className={port.status === '已连接' ? 'ok' : 'bad'}>
              <td>{port.index}</td>
              <td>{port.channel}</td>
              <td>{port.ip}</td>
              <td>{port.throughput}</td>
              <td>{port.latency}</td>
              <td>{port.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CameraStatusPanel({ details }: { details: CameraDetail[] }) {
  const onlineCount = details.filter((item) => item.status === '在线').length;
  const offlineCount = details.length - onlineCount;

  return (
    <div className="camera-detail-popover" id="camera-detail-panel" role="dialog" aria-label="相机状态详细信息" data-no-drag>
      <div className="camera-detail-head">
        <div>
          <strong>相机状态详细信息</strong>
          <span>8 路 3D 线扫相机</span>
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
            <th>帧率</th>
            <th>温度</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {details.map((camera) => (
            <tr key={camera.index} className={camera.status === '在线' ? 'ok' : 'bad'}>
              <td>{camera.index}</td>
              <td>{camera.station}</td>
              <td>{camera.ip}</td>
              <td>{camera.frameRate}</td>
              <td>{camera.temperature}</td>
              <td>{camera.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBlock({ label, value, tone = 'ok' }: { label: string; value: string; tone?: 'ok' | 'alarm' }) {
  return (
    <div className="status-block">
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function ProductionMeta({ plate }: { plate: SteelPlate }) {
  const items = [
    ['产线', '2250mm热轧'],
    ['钢板号', plate.plateNo],
    ['钢种', plate.steelGrade],
    ['规格', `${plate.thicknessMm.toFixed(1)} x ${plate.widthMm} mm`],
    ['板长', `${(plate.lengthMm / 1000).toFixed(3)} m`],
    ['板宽', `${(plate.widthMm / 1000).toFixed(3)} m`],
    ['检测时间', plate.detectedAt],
    ['线速', '2.35 m/s'],
    ['温度', '36.5 C'],
  ];

  return (
    <div className="production-meta" aria-label="当前钢板生产参数">
      {items.map(([label, value]) => (
        <span key={label}>
          <b>{label}:</b>
          {value}
        </span>
      ))}
    </div>
  );
}

export function BrandHeader({ status, plate, theme, onSettingsOpen, onDragMouseDown }: BrandHeaderProps) {
  const logoSrc = theme === 'light' ? ustbLogo : ustbLogoDark;
  const [activeDetail, setActiveDetail] = useState<'receiver' | 'camera' | null>(null);
  const receiverWrapRef = useRef<HTMLDivElement>(null);
  const cameraWrapRef = useRef<HTMLDivElement>(null);
  const receiverDetails = useMemo(() => createReceiverDetails(status.receiverPorts), [status.receiverPorts]);
  const cameraDetails = useMemo(() => createCameraDetails(status.cameraPorts), [status.cameraPorts]);
  const onlineReceiverCount = receiverDetails.filter((port) => port.status === '已连接').length;
  const offlineReceiverCount = receiverDetails.length - onlineReceiverCount;
  const onlineCameraCount = cameraDetails.filter((camera) => camera.status === '在线').length;
  const offlineCameraCount = cameraDetails.length - onlineCameraCount;

  useEffect(() => {
    if (!activeDetail) {
      return;
    }

    const isInsideStatusPopover = (target: EventTarget | null) => {
      if (!(target instanceof Node)) {
        return false;
      }
      return [receiverWrapRef.current, cameraWrapRef.current].some((element) => element?.contains(target));
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
        <div className="system-title">钢板3D表面检测系统</div>
        <ProductionMeta plate={plate} />
      </div>

      <div className="brand-status">
        <div className="port-status-stack">
          <div ref={receiverWrapRef} className="camera-status-wrap receiver-status-wrap" data-no-drag onMouseDown={(event) => event.stopPropagation()}>
            <button
              className={`port-group port-group-button ${activeDetail === 'receiver' ? 'active' : ''}`}
              type="button"
              aria-expanded={activeDetail === 'receiver'}
              aria-controls="receiver-detail-panel"
              aria-label={`报级器网口，在线 ${onlineReceiverCount} 路，异常 ${offlineReceiverCount} 路`}
              onClick={() => setActiveDetail((current) => (current === 'receiver' ? null : 'receiver'))}
            >
              <PortContent title="报级器网口" ports={status.receiverPorts} />
            </button>
            {activeDetail === 'receiver' ? <ReceiverStatusPanel details={receiverDetails} /> : null}
          </div>
          <div ref={cameraWrapRef} className="camera-status-wrap" data-no-drag onMouseDown={(event) => event.stopPropagation()}>
            <button
              className={`port-group port-group-button ${activeDetail === 'camera' ? 'active' : ''}`}
              type="button"
              aria-expanded={activeDetail === 'camera'}
              aria-controls="camera-detail-panel"
              aria-label={`相机状态，在线 ${onlineCameraCount} 路，异常 ${offlineCameraCount} 路`}
              onClick={() => setActiveDetail((current) => (current === 'camera' ? null : 'camera'))}
            >
              <PortContent title="相机状态" ports={status.cameraPorts} />
            </button>
            {activeDetail === 'camera' ? <CameraStatusPanel details={cameraDetails} /> : null}
          </div>
        </div>
        <StatusBlock label="编码器" value={status.encoder === 'sync' ? '同步正常' : '离线'} />
        <StatusBlock label="PLC" value={status.plc === 'normal' ? '正常' : '异常'} />
        <StatusBlock label="L2" value={status.l2 === 'normal' ? '正常' : '异常'} />
        <div className="run-indicator" aria-label="系统运行状态">
          <i />
          <span>运行中</span>
        </div>
        <div className="alarm-status">
          <Bell size={20} fill="currentColor" />
          <span>{status.alarmCount}</span>
        </div>
        <button
          className="header-settings-button"
          type="button"
          title="系统设置"
          aria-label="打开系统设置"
          data-no-drag
          onMouseDown={(event) => event.stopPropagation()}
          onClick={onSettingsOpen}
        >
          <Settings size={18} />
        </button>
      </div>

      <div className="brand-right">
        <div className="mini-health">
          <Server size={13} />
          <Camera size={13} />
          <Cpu size={13} />
          <Activity size={13} />
        </div>
        <WindowControls />
      </div>
    </header>
  );
}
