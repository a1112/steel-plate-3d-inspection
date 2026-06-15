import { Activity, BellOff, Clock3, Download, Network, RefreshCw, ServerCog } from 'lucide-react';
import type { DeviceStatus } from '../data/inspection';
import type { OperationState, ServiceHealth, SystemAction } from '../state/operations';
import { Panel } from './Panel';

const healthLabels: Record<ServiceHealth, string> = {
  normal: '正常',
  warning: '注意',
  error: '异常',
};

function HealthCard({ label, value, detail }: { label: string; value: ServiceHealth; detail: string }) {
  return (
    <div className={`health-card ${value}`}>
      <span>{label}</span>
      <strong>{healthLabels[value]}</strong>
      <small>{detail}</small>
    </div>
  );
}

function PortRail({ title, ports }: { title: string; ports: DeviceStatus['receiverPorts'] }) {
  return (
    <div className="status-port-rail">
      <span>{title}</span>
      <div>
        {ports.map((port) => (
          <i key={port.index} className={port.ok ? 'ok' : 'bad'}>
            {port.index}
          </i>
        ))}
      </div>
    </div>
  );
}

export function SystemStatusPage({
  status,
  operation,
  onAction,
}: {
  status: DeviceStatus;
  operation: OperationState;
  onAction: (action: SystemAction) => void;
}) {
  return (
    <main className="workspace-page status-page">
      <section className="status-layout">
        <Panel title="核心服务状态" className="status-health-panel">
          <div className="health-grid">
            <HealthCard label="检测引擎" value={operation.serviceHealth.inspectionEngine} detail="3D 重建与缺陷判级" />
            <HealthCard label="相机采集" value={operation.serviceHealth.cameraAcquisition} detail="8 路线扫相机采集" />
            <HealthCard label="PLC 桥接" value={operation.serviceHealth.plcBridge} detail="辊道节拍与触发信号" />
            <HealthCard label="L2 上传" value={operation.serviceHealth.l2Uploader} detail="钢板结果归档队列" />
          </div>
        </Panel>

        <Panel title="设备链路" className="status-link-panel">
          <div className="status-link-grid">
            <PortRail title="报级器网口" ports={status.receiverPorts} />
            <PortRail title="相机状态" ports={status.cameraPorts} />
            <div className="status-chip">
              <Network size={18} />
              <span>编码器</span>
              <strong>{status.encoder === 'sync' ? '同步正常' : '离线'}</strong>
            </div>
            <div className="status-chip">
              <ServerCog size={18} />
              <span>PLC</span>
              <strong>{status.plc === 'normal' ? '正常' : '异常'}</strong>
            </div>
          </div>
        </Panel>

        <Panel title="运维操作" className="status-actions-panel">
          <div className="status-actions">
            <button type="button" onClick={() => onAction('self-check')}>
              <RefreshCw size={16} />
              一键自检
            </button>
            <button type="button" onClick={() => onAction('sync-time')}>
              <Clock3 size={16} />
              同步时间
            </button>
            <button type="button" onClick={() => onAction('clear-alarm')}>
              <BellOff size={16} />
              清除报警
            </button>
            <button type="button" onClick={() => onAction('export-log')}>
              <Download size={16} />
              导出日志
            </button>
          </div>
          <dl className="status-facts">
            <div>
              <dt>当前报警</dt>
              <dd>{operation.alarmCount}</dd>
            </div>
            <div>
              <dt>最近同步</dt>
              <dd>{operation.lastSyncTime}</dd>
            </div>
            <div>
              <dt>运行模式</dt>
              <dd>在线检测</dd>
            </div>
          </dl>
        </Panel>

        <Panel title="资源负载" className="status-load-panel">
          <div className="load-grid">
            {[
              { label: 'GPU 点云处理', value: 62 },
              { label: 'CPU 判级线程', value: 48 },
              { label: '采集缓存', value: 37 },
              { label: 'L2 队列', value: 12 },
            ].map((item) => (
              <div key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}%</strong>
                <i style={{ width: `${item.value}%` }} />
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="事件日志" className="status-events-panel">
          <div className="events-list">
            {operation.events.map((event) => (
              <div key={event.id} className={event.level}>
                <Activity size={15} />
                <span>{event.time}</span>
                <strong>{event.message}</strong>
              </div>
            ))}
          </div>
        </Panel>
      </section>
    </main>
  );
}
