import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, FileText, RefreshCw } from 'lucide-react';
import {
  fetchAdminRuntimeLogStatus,
  type AdminRuntimeLogFile,
  type AdminRuntimeLogStatus,
  type AdminRuntimeService,
} from '../services/inspection-api';
import { Panel } from './Panel';
import bkvAdapterIcon from '../assets/service-icons/bkv-adapter.png';
import captureServiceIcon from '../assets/service-icons/capture-service.png';
import defectWorkerIcon from '../assets/service-icons/defect-worker.png';
import imageServiceIcon from '../assets/service-icons/image-service.png';
import imageWorkerIcon from '../assets/service-icons/image-worker.png';
import inspectionServiceIcon from '../assets/service-icons/inspection-service.png';
import runtimeSupervisorIcon from '../assets/service-icons/runtime-supervisor.png';
import triggerGatewayIcon from '../assets/service-icons/trigger-gateway.png';

const SERVICE_ICON_BY_ID: Record<string, string> = {
  inspection: inspectionServiceIcon,
  image: imageServiceIcon,
  'image-worker': imageWorkerIcon,
  'defect-worker': defectWorkerIcon,
  'bkv-adapter': bkvAdapterIcon,
  capture: captureServiceIcon,
  trigger: triggerGatewayIcon,
  supervisor: runtimeSupervisorIcon,
};

function serviceIconFor(id: string) {
  return SERVICE_ICON_BY_ID[id] ?? runtimeSupervisorIcon;
}

function formatRuntimeTimestamp(value?: string) {
  if (!value) {
    return '-';
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000_000) {
    return new Date(numeric).toLocaleString('zh-CN', { hour12: false });
  }
  return value;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return '-';
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}

function serviceStatusLabel(service: AdminRuntimeService) {
  if (service.ok) {
    return '运行中';
  }
  return service.required ? '不可用' : '未启动';
}

function serviceLifecycleLabel(service: AdminRuntimeService) {
  const phase = service.lifecycle?.phase ?? service.status;
  switch (phase) {
    case 'starting': return '启动中';
    case 'ready':
    case 'running':
    case 'healthy': return '运行中';
    case 'collecting': return '采集中';
    case 'stopping': return '停止中';
    case 'stopped': return '已停止';
    case 'degraded': return '降级';
    case 'unavailable': return '不可用';
    default: return phase || '未知';
  }
}

function serviceStatusClass(service: AdminRuntimeService) {
  return service.ok ? 'normal' : service.required ? 'error' : 'warning';
}

function logTitle(log: AdminRuntimeLogFile) {
  if (log.serviceName) {
    return log.serviceName;
  }
  if (log.name === 'supervisor.log') {
    return '运行宿主';
  }
  if (log.name.includes('algorithm')) {
    return 'BKV 兼容适配器';
  }
  if (log.name.includes('defect-worker')) {
    return '缺陷识别 Worker';
  }
  if (log.name.includes('image-worker')) {
    return '图像处理 Worker';
  }
  if (log.name.includes('image')) {
    return '图像服务';
  }
  if (log.name.includes('inspection') || log.name.includes('service')) {
    return '业务服务';
  }
  return log.name;
}

export function RuntimeLogStatusPanel() {
  const [payload, setPayload] = useState<AdminRuntimeLogStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setRefreshing(true);
    try {
      const next = await fetchAdminRuntimeLogStatus(controller.signal);
      setPayload(next);
      setError('');
    } catch (nextError) {
      if (controller.signal.aborted) {
        return;
      }
      setError(nextError instanceof Error ? nextError.message : '运行日志读取失败');
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
    return () => requestRef.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) {
      return undefined;
    }
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  if (loading && !payload) {
    return (
      <section className="parameter-grid parameter-runtime-logs-grid">
        <Panel title="运行日志与状态" className="parameter-card parameter-runtime-summary-card">
          <div className="runtime-log-empty" role="status">正在读取运行时状态…</div>
        </Panel>
      </section>
    );
  }

  const runtimeStatus = payload?.status === 'running' ? '运行正常' : '存在异常或未启动服务';
  const supervisorStatus = payload?.runtime.supervisor?.status;

  return (
    <section className="parameter-grid parameter-runtime-logs-grid">
      <Panel title="运行日志与状态" className="parameter-card parameter-runtime-summary-card">
        <div className="runtime-log-toolbar">
          <div className={`runtime-log-overall ${payload?.status === 'running' ? 'normal' : 'warning'}`}>
            <span className={`status-dot ${payload?.status === 'running' ? 'online' : 'warning'}`} />
            <strong>{runtimeStatus}</strong>
            <span>更新时间 {formatRuntimeTimestamp(payload?.updatedAt)}</span>
          </div>
          <label className="runtime-log-auto-refresh">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            自动刷新（5 秒）
          </label>
          <button type="button" onClick={() => void load()} disabled={refreshing}>
            <RefreshCw size={16} className={refreshing ? 'spin' : undefined} />
            刷新
          </button>
        </div>
        {error ? <div className="runtime-log-error" role="alert"><AlertTriangle size={16} />{error}</div> : null}
        <div className="runtime-log-facts">
          <div>
            <span className="runtime-log-fact-label">
              <img src={runtimeSupervisorIcon} alt="" aria-hidden="true" />
              <span>运行宿主</span>
            </span>
            <strong>{supervisorStatus ?? '未接入 Supervisor 状态文件'}</strong>
          </div>
          <div><span>统一结果库</span><strong className={payload?.resultStore.ready ? 'normal' : 'warning'}>{payload?.resultStore.ready ? '已就绪' : '未就绪'}</strong></div>
          <div><span>目录大小</span><strong>{formatBytes(payload?.resultStore.bytes ?? 0)}</strong></div>
          <div><span>日志目录</span><strong title={payload?.runtime.logRoot}>{payload?.runtime.logRoot ?? '-'}</strong></div>
          <div><span>服务注册</span><strong title={payload?.registry?.path}>{payload?.registry?.path ?? '-'}</strong></div>
          <div><span>Task Worker</span><strong className={payload?.runtime.taskWorker?.running ? 'normal' : 'warning'}>{payload?.runtime.taskWorker?.status ?? '未接入'}</strong></div>
        </div>
      </Panel>

      <Panel title="进程状态" className="parameter-card parameter-runtime-process-card">
        <div className="runtime-process-list">
          {(payload?.services ?? []).map((service) => (
            <div key={service.id} className={serviceStatusClass(service)}>
              <img className="runtime-service-icon" src={serviceIconFor(service.id)} alt="" aria-hidden="true" />
              <div>
                <strong>{service.name}</strong>
                <span>{service.origin}</span>
                <small>生命周期：{serviceLifecycleLabel(service)} · {service.role ?? service.kind ?? 'service'}</small>
              </div>
              <em>{serviceStatusLabel(service)}</em>
              {!service.ok && service.reason ? <small>{service.reason}</small> : null}
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="运行日志" className="parameter-card parameter-runtime-log-files-card">
        <div className="runtime-log-file-list">
          {(payload?.logs ?? []).length > 0 ? (
            (payload?.logs ?? []).map((log) => (
              <details key={log.name} open={log.name.includes('err') || log.name === 'supervisor.log'}>
                <summary>
                  <FileText size={16} />
                  <strong>{logTitle(log)}</strong>
                  <span>{log.name}</span>
                  <em>{formatBytes(log.bytes)} · {formatRuntimeTimestamp(log.modifiedAt)}</em>
                </summary>
                <pre>{log.tail || '暂无日志内容'}{log.truncated ? '\n… 已截断，仅显示最近内容' : ''}</pre>
              </details>
            ))
          ) : (
            <div className="runtime-log-empty"><Activity size={16} />尚未发现运行日志文件</div>
          )}
        </div>
      </Panel>
    </section>
  );
}
