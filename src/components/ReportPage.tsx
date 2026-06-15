import { Download, RotateCcw, Search } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ChangeEvent, CSSProperties } from 'react';
import type { DefectItem, DefectType, Severity, Surface } from '../data/inspection';
import { severityLabels, surfaceLabels } from '../data/inspection';
import type { ReportFilters, ReportMetrics } from '../state/operations';
import { Panel } from './Panel';

const severityOptions: Array<{ value: ReportFilters['severity']; label: string }> = [
  { value: 'all', label: '全部等级' },
  { value: 'severe', label: '严重' },
  { value: 'review', label: '待复核' },
  { value: 'minor', label: '轻微' },
];

const surfaceOptions: Array<{ value: ReportFilters['surface']; label: string }> = [
  { value: 'all', label: '全部表面' },
  { value: 'top', label: '上表面' },
  { value: 'bottom', label: '下表面' },
];

const severityColors: Record<Severity, string> = {
  severe: '#ef2029',
  review: '#ffb21c',
  minor: '#2f7dff',
};

function DefectRows({
  rows,
  page,
  selectedDefectId,
  onSelectDefect,
}: {
  rows: DefectItem[];
  page: number;
  selectedDefectId: string | null;
  onSelectDefect: (defectId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <tbody>
        <tr>
          <td colSpan={8} className="empty-cell">
            当前筛选条件下无缺陷记录
          </td>
        </tr>
      </tbody>
    );
  }
  return (
    <tbody>
      {rows.map((defect, index) => (
        <tr key={defect.id} className={defect.id === selectedDefectId ? 'selected' : ''} onClick={() => onSelectDefect(defect.id)}>
          <td>{String((page - 1) * 8 + index + 1).padStart(2, '0')}</td>
          <td>{defect.plateNo}</td>
          <td>{defect.typeLabel}</td>
          <td>{surfaceLabels[defect.surface]}</td>
          <td className={defect.severity}>{severityLabels[defect.severity]}</td>
          <td>{defect.distanceHeadMm}mm</td>
          <td>{`${defect.widthMm.toFixed(2)} x ${defect.heightMm.toFixed(2)}`}</td>
          <td>{defect.depthMm.toFixed(2)}mm</td>
        </tr>
      ))}
    </tbody>
  );
}

export function ReportPage({
  defectTypes,
  rows,
  pageRows,
  metrics,
  filters,
  page,
  pageCount,
  selectedDefect,
  selectedDefectId,
  onFilterChange,
  onReset,
  onApply,
  onPageChange,
  onSelectDefect,
  onExportCsv,
  onExportJson,
}: {
  defectTypes: DefectType[];
  rows: DefectItem[];
  pageRows: DefectItem[];
  metrics: ReportMetrics;
  filters: ReportFilters;
  page: number;
  pageCount: number;
  selectedDefect: DefectItem | null;
  selectedDefectId: string | null;
  onFilterChange: (patch: Partial<ReportFilters>) => void;
  onReset: () => void;
  onApply: () => void;
  onPageChange: (page: number) => void;
  onSelectDefect: (defectId: string) => void;
  onExportCsv: () => void;
  onExportJson: () => void;
}) {
  const surfaceData = [
    { name: '上表面', count: metrics.top },
    { name: '下表面', count: metrics.bottom },
  ];
  const donutStyle = {
    '--severe': metrics.severe,
    '--review': metrics.review,
    '--minor': metrics.minor,
    '--total': Math.max(metrics.total, 1),
  } as CSSProperties;
  const reportPreviewStyle = selectedDefect
    ? ({
        '--defect-preview-image': `url(${selectedDefect.previewImageUrl})`,
      } as CSSProperties)
    : undefined;

  const handleSelect = (event: ChangeEvent<HTMLSelectElement>, key: 'severity' | 'surface' | 'typeId') => {
    onFilterChange({ [key]: event.target.value } as Partial<ReportFilters>);
  };

  return (
    <main className="workspace-page report-page">
      <section className="report-metrics">
        <div>
          <span>筛选结果</span>
          <strong>{metrics.total}</strong>
        </div>
        <div className="severe">
          <span>严重缺陷</span>
          <strong>{metrics.severe}</strong>
        </div>
        <div className="review">
          <span>待复核</span>
          <strong>{metrics.review}</strong>
        </div>
        <div>
          <span>最大深度</span>
          <strong>{metrics.maxDepthMm.toFixed(2)}mm</strong>
        </div>
      </section>

      <section className="report-layout">
        <Panel title="报表查询条件" className="report-filter-panel">
          <label>
            <span>关键字</span>
            <input value={filters.keyword} onChange={(event) => onFilterChange({ keyword: event.target.value })} placeholder="钢板号 / 缺陷 / 距离" />
          </label>
          <label>
            <span>缺陷等级</span>
            <select value={filters.severity} onChange={(event) => handleSelect(event, 'severity')}>
              {severityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>检测表面</span>
            <select value={filters.surface} onChange={(event) => handleSelect(event, 'surface')}>
              {surfaceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>缺陷类别</span>
            <select value={filters.typeId} onChange={(event) => handleSelect(event, 'typeId')}>
              <option value="all">全部类别</option>
              {defectTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="button" onClick={onApply}>
              <Search size={15} />
              查询
            </button>
            <button type="button" onClick={onReset}>
              <RotateCcw size={15} />
              重置
            </button>
          </div>
          <div className="form-actions">
            <button type="button" onClick={onExportCsv}>
              <Download size={15} />
              导出CSV
            </button>
            <button type="button" onClick={onExportJson}>
              <Download size={15} />
              导出JSON
            </button>
          </div>
        </Panel>

        <Panel title="缺陷趋势与等级分布" className="report-chart-panel">
          <div className="report-charts">
            <div>
              <h3>表面分布</h3>
              <ResponsiveContainer width="100%" height="88%">
                <BarChart data={surfaceData}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: 'var(--muted)', fontSize: 12 }} tickLine={false} axisLine={false} />
                  <YAxis allowDecimals={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} fill="var(--blue)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div>
              <h3>等级占比</h3>
              <div className="report-donut-wrap">
                <div className="report-donut" style={donutStyle}>
                  <span>{metrics.total}</span>
                </div>
                <div className="report-pie-legend">
                  <span>
                    <i style={{ background: severityColors.severe }} />
                    严重 {metrics.severe}
                  </span>
                  <span>
                    <i style={{ background: severityColors.review }} />
                    待复核 {metrics.review}
                  </span>
                  <span>
                    <i style={{ background: severityColors.minor }} />
                    轻微 {metrics.minor}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="报表明细" className="report-table-panel">
          <table className="report-table">
            <thead>
              <tr>
                <th>序号</th>
                <th>钢板号</th>
                <th>缺陷类别</th>
                <th>表面</th>
                <th>等级</th>
                <th>距头距离</th>
                <th>尺寸</th>
                <th>深度</th>
              </tr>
            </thead>
            <DefectRows rows={pageRows} page={page} selectedDefectId={selectedDefectId} onSelectDefect={onSelectDefect} />
          </table>
          <div className="report-footer">
            <span>
              共 {rows.length} 条，当前 {page} / {pageCount} 页
            </span>
            <div className="pager compact">
              <button type="button" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
                上页
              </button>
              <button type="button" onClick={() => onPageChange(page + 1)} disabled={page >= pageCount}>
                下页
              </button>
            </div>
          </div>
        </Panel>

        <Panel title="选中缺陷复核摘要" className="report-detail-panel">
          {selectedDefect ? (
            <>
              <dl className="report-detail-list">
                <div>
                  <dt>缺陷编号</dt>
                  <dd>{selectedDefect.id}</dd>
                </div>
                <div>
                  <dt>缺陷类别</dt>
                  <dd>{selectedDefect.typeLabel}</dd>
                </div>
                <div>
                  <dt>等级</dt>
                  <dd className={selectedDefect.severity}>{severityLabels[selectedDefect.severity]}</dd>
                </div>
                <div>
                  <dt>定位</dt>
                  <dd>{`${surfaceLabels[selectedDefect.surface]} / ${selectedDefect.distanceHeadMm}mm`}</dd>
                </div>
                <div>
                  <dt>尺寸</dt>
                  <dd>{`${selectedDefect.widthMm.toFixed(2)} x ${selectedDefect.heightMm.toFixed(2)} x ${Math.abs(selectedDefect.depthMm).toFixed(2)}mm`}</dd>
                </div>
              </dl>
              <div className="report-preview-strip" style={reportPreviewStyle}>
                <span style={{ left: `${selectedDefect.previewX}%`, top: `${selectedDefect.previewY}%` }} />
              </div>
            </>
          ) : (
            <div className="report-empty-detail">
              <h3>无匹配缺陷</h3>
              <p>请调整筛选条件或从报表明细中选择缺陷记录。</p>
            </div>
          )}
        </Panel>
      </section>
    </main>
  );
}
