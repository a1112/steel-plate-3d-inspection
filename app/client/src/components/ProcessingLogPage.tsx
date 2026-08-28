import {
  Activity,
  BrainCircuit,
  Camera,
  ChevronRight,
  Clock3,
  DatabaseZap,
  Image as ImageIcon,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  fetchCaptureProcessingLog,
  type CaptureProcessingLogRecord,
  type ProcessingDataStatus,
  type ProcessingStage,
} from '../services/processing-log-api';

const stageTone: Record<string, string> = {
  completed: 'ok',
  processing: 'processing',
  degraded: 'warning',
  failed: 'error',
  waiting: 'waiting',
};

const artifactLabels: Record<string, string> = {
  alignment: '相机对齐',
  measurement: '测量结果',
  'region-map': '区域映射',
  surface: '三维表面',
  'playback-index': '回放索引',
  'surface-preview': '表面预览',
};

const timingLabels: Record<string, string> = {
  captureWaitMs: '等待采集空闲',
  sourceDecodeMs: '源数据解码',
  preprocessMs: '预处理',
  detectorInferenceMs: '缺陷推理',
  classificationMs: '缺陷分类',
  postprocessMs: '后处理',
};

export function formatProcessingDuration(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '--';
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes} 分 ${seconds} 秒`;
}

function formatProcessingTime(value?: number | string | null) {
  if (value === null || value === undefined || value === '') return '--';
  const numeric = typeof value === 'number' ? value : Number(value);
  const date = new Date(Number.isFinite(numeric) ? numeric : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function statusClass(status: ProcessingDataStatus) {
  return stageTone[status] ?? 'waiting';
}

function StageCell({ stage }: { stage: ProcessingStage }) {
  return (
    <div className="processing-stage-cell">
      <span className={`processing-status ${statusClass(stage.status)}`}>{stage.statusLabel}</span>
      <strong>{formatProcessingDuration(stage.durationMs)}</strong>
    </div>
  );
}

function StageDetail({
  icon: Icon,
  title,
  stage,
}: {
  icon: typeof Camera;
  title: string;
  stage: ProcessingStage;
}) {
  return (
    <article className={`processing-detail-stage ${statusClass(stage.status)}`}>
      <div className="processing-detail-stage-title">
        <Icon size={17} />
        <strong>{title}</strong>
        <span className={`processing-status ${statusClass(stage.status)}`}>{stage.statusLabel}</span>
      </div>
      <b>{formatProcessingDuration(stage.durationMs)}</b>
      <small>{formatProcessingTime(stage.startedAt)} → {formatProcessingTime(stage.finishedAt)}</small>
    </article>
  );
}

function RecordDetail({ record }: { record: CaptureProcessingLogRecord }) {
  const timings = Object.entries(record.algorithm.timingsMs ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]));
  return (
    <aside className="processing-detail-panel" aria-label={`流水号 ${record.materialId} 详细数据`}>
      <header>
        <div>
          <span>流水号</span>
          <h2>{record.materialId}</h2>
          <small>{record.sessionId || '未关联生产会话'}</small>
        </div>
        <span className={`processing-overall-status ${statusClass(record.dataStatus)}`}>{record.dataStatusLabel}</span>
      </header>

      <section className="processing-detail-timeline" aria-label="分阶段处理耗时">
        <StageDetail icon={Camera} title="采集" stage={record.capture} />
        <StageDetail icon={ImageIcon} title="图像处理" stage={record.image} />
        <StageDetail icon={BrainCircuit} title="算法处理" stage={record.algorithm} />
      </section>

      <section className="processing-detail-section">
        <h3><DatabaseZap size={16} />数据状态</h3>
        <dl className="processing-detail-grid">
          <div><dt>采集轮次</dt><dd>{record.capture.latestCommittedRound ?? '--'}</dd></div>
          <div><dt>相机完成</dt><dd>{record.capture.actualCameraCount}/{record.capture.expectedCameraCount ?? record.capture.actualCameraCount}</dd></div>
          <div><dt>处理帧数</dt><dd>{record.algorithm.processedFrames || record.algorithm.frameCount || 0}</dd></div>
          <div><dt>跳过帧数</dt><dd>{record.algorithm.skippedFrames || 0}</dd></div>
          <div><dt>缺陷数量</dt><dd>{record.algorithm.defectCount || 0}</dd></div>
          <div><dt>处理吞吐</dt><dd>{record.algorithm.throughputFramesPerSecond ? `${record.algorithm.throughputFramesPerSecond.toFixed(2)} 帧/秒` : '--'}</dd></div>
          <div><dt>测量有效</dt><dd>{record.algorithm.metricValid ? '有效' : '无效/待生成'}</dd></div>
          <div><dt>同步状态</dt><dd>{record.algorithm.synchronized ? '已同步' : '未同步'}</dd></div>
        </dl>
      </section>

      <section className="processing-detail-section">
        <h3><Camera size={16} />采集相机</h3>
        {record.capture.cameras.length ? (
          <div className="processing-camera-list">
            {record.capture.cameras.map((camera) => (
              <div key={camera.cameraId}>
                <strong>{camera.cameraId}</strong>
                <span>序号 {camera.sequenceNo ?? '--'}</span>
                <span>{camera.artifactCount} 个文件 · {formatBytes(camera.artifactBytes)}</span>
                <small>{formatProcessingTime(camera.capturedAt)}</small>
              </div>
            ))}
          </div>
        ) : <p className="processing-empty-inline">采集清单尚未生成，当前状态来自流水清单。</p>}
      </section>

      <section className="processing-detail-section">
        <h3><ImageIcon size={16} />图像处理产物</h3>
        {record.image.artifacts.length ? (
          <div className="processing-artifact-list">
            {record.image.artifacts.map((artifact, index) => (
              <div key={`${artifact.kind}-${index}`}>
                <span className={artifact.available ? 'available' : ''} />
                <strong>{artifactLabels[artifact.kind] ?? artifact.kind}</strong>
                <small>{formatBytes(artifact.size)}</small>
              </div>
            ))}
          </div>
        ) : <p className="processing-empty-inline">等待图像处理产物。</p>}
      </section>

      <section className="processing-detail-section">
        <h3><Clock3 size={16} />算法阶段耗时</h3>
        {timings.length ? (
          <div className="processing-timing-list">
            {timings.map(([key, value]) => (
              <div key={key}>
                <span>{timingLabels[key] ?? key}</span>
                <strong>{formatProcessingDuration(value)}</strong>
              </div>
            ))}
          </div>
        ) : <p className="processing-empty-inline">算法尚未上报分阶段耗时。</p>}
        <dl className="processing-detail-grid processing-algorithm-meta">
          <div><dt>算法状态</dt><dd>{record.algorithm.state || '--'} / {record.algorithm.defectState || '--'}</dd></div>
          <div><dt>运行模式</dt><dd>{record.algorithm.mode || '--'}</dd></div>
          <div><dt>算法版本</dt><dd>{record.algorithm.algorithmRevision ?? '--'}</dd></div>
          <div><dt>模型集</dt><dd title={record.algorithm.modelSetId ?? ''}>{record.algorithm.modelSetId || '--'}</dd></div>
        </dl>
        {record.algorithm.qualityReason ? <p className="processing-quality-note">{record.algorithm.qualityReason}</p> : null}
        {record.algorithm.riskTags?.length ? (
          <div className="processing-risk-tags">
            {record.algorithm.riskTags.map((tag) => <span key={tag}>{tag}</span>)}
          </div>
        ) : null}
      </section>
    </aside>
  );
}

export function ProcessingLogPage() {
  const [records, setRecords] = useState<CaptureProcessingLogRecord[]>([]);
  const [selectedMaterialId, setSelectedMaterialId] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState('');
  const [refreshRevision, setRefreshRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const load = (manual = false) => {
      if (manual) setRefreshing(true);
      void fetchCaptureProcessingLog(50, controller.signal)
        .then((page) => {
          if (disposed) return;
          setRecords(page.records);
          setUpdatedAt(page.updatedAt);
          setError('');
          setSelectedMaterialId((current) => page.records.some((record) => record.materialId === current)
            ? current
            : page.records[0]?.materialId ?? '');
        })
        .catch((cause: unknown) => {
          if (!disposed && !controller.signal.aborted) {
            setError(cause instanceof Error ? cause.message : '采集算法处理日志读取失败');
          }
        })
        .finally(() => {
          if (!disposed) {
            setLoading(false);
            setRefreshing(false);
          }
        });
    };
    load(refreshRevision > 0);
    const timer = window.setInterval(() => load(false), 2_000);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refreshRevision]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleRecords = useMemo(
    () => normalizedQuery
      ? records.filter((record) => record.materialId.toLowerCase().includes(normalizedQuery)
        || record.sessionId.toLowerCase().includes(normalizedQuery))
      : records,
    [normalizedQuery, records],
  );
  const selectedRecord = records.find((record) => record.materialId === selectedMaterialId)
    ?? visibleRecords[0]
    ?? null;
  const processingCount = records.filter((record) => record.dataStatus === 'processing').length;
  const issueCount = records.filter((record) => ['degraded', 'failed'].includes(record.dataStatus)).length;

  return (
    <main className="processing-log-page">
      <header className="processing-log-header">
        <div>
          <span>CAPTURE · IMAGE · ALGORITHM</span>
          <h1>采集算法处理日志</h1>
          <p>按流水号关联采集、图像处理与算法处理产物，最新流水置顶。</p>
        </div>
        <div className="processing-log-actions">
          <small>{error || (updatedAt ? `更新于 ${formatProcessingTime(updatedAt)}` : '等待首次同步')}</small>
          <button type="button" disabled={refreshing} onClick={() => setRefreshRevision((value) => value + 1)}>
            <RefreshCw size={16} className={refreshing ? 'spin' : ''} />刷新
          </button>
        </div>
      </header>

      <section className="processing-summary" aria-label="处理数据汇总">
        <div><DatabaseZap size={19} /><span>最近流水</span><strong>{records.length}</strong></div>
        <div><Activity size={19} /><span>正在处理</span><strong>{processingCount}</strong></div>
        <div><BrainCircuit size={19} /><span>已完成</span><strong>{records.filter((record) => record.dataStatus === 'completed').length}</strong></div>
        <div className={issueCount ? 'warning' : ''}><Clock3 size={19} /><span>降级/失败</span><strong>{issueCount}</strong></div>
      </section>

      <div className="processing-log-workspace">
        <section className="processing-list-panel" aria-label="采集处理流水列表">
          <div className="processing-list-toolbar">
            <div><strong>采集与处理列表</strong><span>{visibleRecords.length} 条</span></div>
            <label><Search size={15} /><input aria-label="搜索流水号" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="流水号 / 会话" /></label>
          </div>
          <div className="processing-table-wrap">
            <table className="processing-table">
              <thead>
                <tr>
                  <th>流水号</th>
                  <th>采集</th>
                  <th>图像处理</th>
                  <th>算法处理</th>
                  <th>数据状态</th>
                  <th>更新时间</th>
                  <th aria-label="查看详情" />
                </tr>
              </thead>
              <tbody>
                {visibleRecords.map((record, index) => (
                  <tr
                    key={record.materialId}
                    className={record.materialId === selectedRecord?.materialId ? 'selected' : ''}
                    onClick={() => setSelectedMaterialId(record.materialId)}
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') setSelectedMaterialId(record.materialId);
                    }}
                    aria-label={`查看流水号 ${record.materialId} 详细数据`}
                  >
                    <td><strong>{record.materialId}</strong>{index === 0 && !normalizedQuery ? <span className="processing-latest">最新</span> : null}<small>{record.sessionId || '--'}</small></td>
                    <td><StageCell stage={record.capture} /></td>
                    <td><StageCell stage={record.image} /></td>
                    <td><StageCell stage={record.algorithm} /></td>
                    <td><span className={`processing-overall-status ${statusClass(record.dataStatus)}`}>{record.dataStatusLabel}</span></td>
                    <td>{formatProcessingTime(record.updatedAt)}</td>
                    <td><ChevronRight size={16} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visibleRecords.length ? (
              <div className="processing-empty" role="status">
                <DatabaseZap size={28} />
                <strong>{loading ? '正在读取采集处理数据' : error ? '处理日志暂时不可用' : '没有匹配的流水数据'}</strong>
                <span>{error || '新的流水生成后会自动出现在列表顶部。'}</span>
              </div>
            ) : null}
          </div>
        </section>
        {selectedRecord ? <RecordDetail record={selectedRecord} /> : <aside className="processing-detail-panel processing-detail-empty">请选择一条流水查看详细数据。</aside>}
      </div>
    </main>
  );
}
