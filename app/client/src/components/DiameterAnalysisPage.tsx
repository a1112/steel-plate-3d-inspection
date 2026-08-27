import { AlertTriangle, CheckCircle2, Download, RotateCcw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { InspectionRecord, SteelPlate } from '../data/inspection';
import type { CaptureFlowMeasurement } from '../lib/capture-api';
import type { BarSurfaceMesh } from '../services/bar-surface-api';
import {
  buildArtifactDiameterMeasurements,
  buildDiameterMeasurements,
  buildDiameterMetricSummary,
  DiameterTrendPanel,
  type DiameterMeasurement,
} from './DiameterTrendPanel';
import { Panel } from './Panel';

type DiameterAnalysisPageProps = {
  plate: SteelPlate;
  records: InspectionRecord[];
  selectedRecordId: string;
  inspectionId?: string;
  measurement?: CaptureFlowMeasurement | null;
  mesh?: BarSurfaceMesh | null;
  loading?: boolean;
  artifactStatus?: string;
  embedded?: boolean;
  onRecordSelect: (recordId: string) => void;
  onExport: (payload: unknown) => void;
};

function formatMetric(value: number | null | undefined, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--';
}

function measurementLabel(sample: DiameterMeasurement, absoluteScale: boolean) {
  return absoluteScale
    ? `${formatMetric(sample.positionMm, 0)} mm`
    : `${formatMetric(sample.positionRatio * 100, 1)}%`;
}

function uniqueExtrema(samples: DiameterMeasurement[]) {
  if (!samples.length) return [];
  const candidates = [
    { kind: '最小外径', sample: samples.reduce((best, sample) => sample.diameterMm < best.diameterMm ? sample : best) },
    { kind: '最大外径', sample: samples.reduce((best, sample) => sample.diameterMm > best.diameterMm ? sample : best) },
    { kind: '最大圆度', sample: samples.reduce((best, sample) => sample.roundnessMm > best.roundnessMm ? sample : best) },
    { kind: '拟合 P95', sample: samples.reduce((best, sample) => sample.fitResidualP95Mm > best.fitResidualP95Mm ? sample : best) },
    { kind: '起始截面', sample: samples[0] },
    { kind: '终止截面', sample: samples[samples.length - 1] },
  ];
  const seen = new Set<string>();
  return candidates.filter(({ kind, sample }) => {
    const key = `${kind}:${sample.row}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function CrossSectionGauge({ sample, nominalDiameterMm }: {
  sample: DiameterMeasurement | null;
  nominalDiameterMm: number;
}) {
  const diameter = sample?.diameterMm ?? nominalDiameterMm;
  const roundness = sample?.roundnessMm ?? 0;
  const normalizedRoundness = Math.min(9, Math.max(0.6, roundness / Math.max(diameter, 1) * 900));
  const rx = 76 + normalizedRoundness / 2;
  const ry = 76 - normalizedRoundness / 2;
  return (
    <div className="diameter-cross-section-gauge">
      <svg viewBox="0 0 220 220" role="img" aria-label="当前截面圆度示意">
        <line x1="22" y1="110" x2="198" y2="110" />
        <line x1="110" y1="22" x2="110" y2="198" />
        <circle cx="110" cy="110" r="76" className="nominal" />
        <ellipse cx="110" cy="110" rx={rx} ry={ry} className="measured" />
        <circle cx="110" cy="110" r="2.5" className="center" />
        <text x="110" y="214" textAnchor="middle">截面拟合轮廓（mm）</text>
      </svg>
      <dl>
        <div><dt>截面位置</dt><dd>{sample ? `${formatMetric(sample.positionRatio * 100, 1)}%` : '--'}</dd></div>
        <div><dt>拟合外径</dt><dd>{formatMetric(sample?.diameterMm)} mm</dd></div>
        <div><dt>圆度</dt><dd>{formatMetric(sample?.roundnessMm)} mm</dd></div>
        <div><dt>有效点</dt><dd>{sample?.validPointCount || '--'}</dd></div>
      </dl>
    </div>
  );
}

export function DiameterAnalysisPage({
  plate,
  records,
  selectedRecordId,
  inspectionId,
  measurement,
  mesh,
  loading = false,
  artifactStatus = '',
  embedded = false,
  onRecordSelect,
  onExport,
}: DiameterAnalysisPageProps) {
  const [query, setQuery] = useState('');
  const [toleranceMm, setToleranceMm] = useState(0.2);
  const [selectedSectionRow, setSelectedSectionRow] = useState<number | null>(null);
  const lengthMm = plate.lengthMm > 0 ? plate.lengthMm : 12_000;
  const summary = useMemo(() => buildDiameterMetricSummary(measurement), [measurement]);
  const nominalDiameterMm = plate.widthMm > 0
    ? plate.widthMm
    : summary?.averageDiameterMm ?? 0;
  const samples = useMemo(
    () => measurement
      ? buildArtifactDiameterMeasurements(measurement, nominalDiameterMm, lengthMm)
      : mesh
        ? buildDiameterMeasurements(mesh, nominalDiameterMm, lengthMm)
        : [],
    [lengthMm, measurement, mesh, nominalDiameterMm],
  );
  const extrema = useMemo(() => uniqueExtrema(samples), [samples]);
  const selectedSample = samples.find((sample) => sample.row === selectedSectionRow) ?? extrema[0]?.sample ?? samples[0] ?? null;
  const absoluteScale = Boolean(measurement?.surfaceFit?.absoluteLongitudinalScaleVerified || !measurement);
  const lowerLimit = nominalDiameterMm > 0 ? nominalDiameterMm - toleranceMm : null;
  const upperLimit = nominalDiameterMm > 0 ? nominalDiameterMm + toleranceMm : null;
  const withinTolerance = Boolean(
    summary?.qualified
    && lowerLimit !== null
    && upperLimit !== null
    && summary.minimumDiameterMm !== null
    && summary.maximumDiameterMm !== null
    && summary.minimumDiameterMm >= lowerLimit
    && summary.maximumDiameterMm <= upperLimit,
  );
  const filteredRecords = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return records;
    return records.filter((record) => `${record.id} ${record.plateNo} ${record.time}`.toLowerCase().includes(normalized));
  }, [query, records]);

  useEffect(() => {
    setSelectedSectionRow(null);
  }, [inspectionId]);

  const metricCards = [
    ['有效截面', summary ? `${summary.validSectionCount}/${summary.requestedSectionCount}` : '--'],
    ['固定角度', summary ? `${summary.fixedAngleCount} 条` : '--'],
    ['最小外径', `${formatMetric(summary?.minimumDiameterMm)} mm`],
    ['平均外径', `${formatMetric(summary?.averageDiameterMm)} mm`],
    ['最大外径', `${formatMetric(summary?.maximumDiameterMm)} mm`],
    ['最大圆度', `${formatMetric(summary?.maximumRoundnessMm)} mm`],
    ['拟合 P95', `${formatMetric(summary?.fitResidualP95MaximumMm)} mm`],
    ['名义外径', `${formatMetric(nominalDiameterMm)} mm`],
  ];

  return (
    <main className={`diameter-page ${embedded ? 'embedded' : ''}`} aria-label="独立测径分析页面">
      {embedded ? null : <aside className="diameter-page-left">
        <Panel title="钢管信息" className="diameter-material-panel">
          <dl>
            <div><dt>钢管号</dt><dd>{plate.plateNo}</dd></div>
            <div><dt>规格</dt><dd>Φ{formatMetric(nominalDiameterMm, 2)} × {plate.thicknessMm > 0 ? formatMetric(plate.thicknessMm, 2) : '--'} mm</dd></div>
            <div><dt>钢级</dt><dd>{plate.steelGrade || '--'}</dd></div>
            <div><dt>检测长度</dt><dd>{formatMetric(lengthMm / 1000, 2)} m</dd></div>
            <div><dt>检测时间</dt><dd>{plate.detectedAt || '--'}</dd></div>
          </dl>
        </Panel>
        <Panel title="记录查询" className="diameter-record-search">
          <label>
            <Search size={14} />
            <input value={query} aria-label="测径记录查询" placeholder="流水号 / 钢管号 / 时间" onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button type="button" title="重置查询" onClick={() => setQuery('')}><RotateCcw size={14} />重置</button>
        </Panel>
        <Panel title="检测记录" className="diameter-records-panel" action={<span>共 {filteredRecords.length} 条</span>}>
          <div className="diameter-records-list" role="listbox" aria-label="测径检测记录">
            {filteredRecords.map((record) => (
              <button
                key={record.id}
                type="button"
                role="option"
                aria-selected={record.id === selectedRecordId}
                className={record.id === selectedRecordId ? 'active' : ''}
                onClick={() => onRecordSelect(record.id)}
              >
                <span>{record.time}</span>
                <strong>{record.plateNo}</strong>
                <small>{record.id}</small>
                <b className={record.status}>{record.status === 'completed' ? '已完成' : '检测中'}</b>
              </button>
            ))}
          </div>
        </Panel>
      </aside>}

      <section className="diameter-page-center">
        <header className="diameter-page-heading">
          <div>
            <span>独立计量工作台</span>
            <h1>测径分析</h1>
            <p>记录 {inspectionId || '--'} · 钢管 {plate.plateNo} · {absoluteScale ? '长度坐标已验证' : '头部相对位置'}</p>
          </div>
          <div className={`diameter-page-quality-chip ${summary?.qualified ? 'valid' : 'preview'}`}>
            {summary?.qualified ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            <span>{summary?.qualified ? '计量有效' : loading ? '读取中' : '趋势预览'}</span>
          </div>
        </header>

        <Panel title="外径趋势" className="diameter-page-trend" action={<span>悬停曲线查看截面数值</span>}>
          {loading ? (
            <div className="diameter-page-empty" role="status">正在读取当前记录的测径产物…</div>
          ) : measurement || mesh ? (
            <DiameterTrendPanel mesh={mesh} artifact={measurement} nominalDiameterMm={nominalDiameterMm} lengthMm={lengthMm} />
          ) : (
            <div className="diameter-page-empty" role="status"><strong>当前记录暂无测径产物</strong><span>{artifactStatus || '请等待采集和截面拟合完成。'}</span></div>
          )}
        </Panel>

        <div className="diameter-page-lower">
          <Panel title="截面圆度" className="diameter-cross-section-panel">
            <CrossSectionGauge sample={selectedSample} nominalDiameterMm={nominalDiameterMm} />
          </Panel>
          <Panel title="极值截面" className="diameter-extrema-panel" action={<span>点击行查看截面</span>}>
            <div className="diameter-extrema-table-wrap">
              <table>
                <thead><tr><th>类型</th><th>位置</th><th>外径</th><th>圆度</th><th>P95</th></tr></thead>
                <tbody>
                  {extrema.map(({ kind, sample }) => (
                    <tr
                      key={`${kind}:${sample.row}`}
                      className={selectedSample?.row === sample.row ? 'active' : ''}
                      tabIndex={0}
                      onClick={() => setSelectedSectionRow(sample.row)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedSectionRow(sample.row);
                        }
                      }}
                    >
                      <td>{kind}</td>
                      <td>{measurementLabel(sample, absoluteScale)}</td>
                      <td>{formatMetric(sample.diameterMm)}</td>
                      <td>{formatMetric(sample.roundnessMm)}</td>
                      <td>{formatMetric(sample.fitResidualP95Mm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!extrema.length ? <div className="diameter-page-empty compact">暂无有效截面</div> : null}
            </div>
          </Panel>
        </div>
      </section>

      <aside className="diameter-page-right">
        <Panel title="计量判定" className={`diameter-verdict-panel ${withinTolerance ? 'qualified' : 'review'}`}>
          <div className="diameter-verdict">
            {withinTolerance ? <CheckCircle2 size={42} /> : <AlertTriangle size={42} />}
            <span>{withinTolerance ? '合格' : summary?.qualified ? '超出规格' : '待复核'}</span>
            <small>{summary?.qualityNote || artifactStatus || '尚无可用测径结果'}</small>
          </div>
        </Panel>
        <Panel title="测径摘要" className="diameter-summary-panel">
          <div className="diameter-page-metrics">
            {metricCards.map(([label, value]) => <dl key={label}><dt>{label}</dt><dd>{value}</dd></dl>)}
          </div>
        </Panel>
        <Panel title="规格公差" className="diameter-tolerance-panel">
          <label><span>名义外径</span><input aria-label="名义外径" value={formatMetric(nominalDiameterMm)} readOnly /><b>mm</b></label>
          <label><span>公差（±）</span><input aria-label="公差（±）" type="number" min="0" step="0.01" value={toleranceMm} onChange={(event) => setToleranceMm(Math.max(0, Number(event.target.value) || 0))} /><b>mm</b></label>
          <dl><div><dt>下公差限</dt><dd>{formatMetric(lowerLimit)} mm</dd></div><div><dt>上公差限</dt><dd>{formatMetric(upperLimit)} mm</dd></div></dl>
        </Panel>
        <Panel title="数据质量" className="diameter-quality-panel">
          <dl>
            <div><dt>数据完整度</dt><dd>{summary ? `${Math.round(summary.validSectionCount / Math.max(1, summary.requestedSectionCount) * 100)}%` : '--'}</dd></div>
            <div><dt>纵向坐标</dt><dd>{absoluteScale ? '长度坐标' : '软同步归一化'}</dd></div>
            <div><dt>产物状态</dt><dd>{loading ? '读取中' : measurement ? 'measurement 已绑定' : mesh ? 'mesh 拟合' : '不可用'}</dd></div>
          </dl>
        </Panel>
        <button
          type="button"
          className="diameter-export-button"
          disabled={!summary}
          onClick={() => onExport({
            schema: 'steel.diameter-analysis-export.v1',
            generatedAt: new Date().toISOString(),
            inspectionId,
            plate,
            nominalDiameterMm,
            toleranceMm,
            qualified: withinTolerance,
            summary,
            sections: samples,
          })}
        >
          <Download size={18} />
          导出测径报告
        </button>
      </aside>
    </main>
  );
}
