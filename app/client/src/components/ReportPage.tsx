import { Download, FileText, Printer, RotateCcw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import type { DefectItem, DefectType, PlateInspection, Severity } from '../data/inspection';
import { severityLabels } from '../data/inspection';
import type { ReportFilters, ReportMetadata, ReportMetrics } from '../state/operations';
import type { InspectionReportArchiveSummary } from '../services/inspection-api';
import { DEFAULT_SYSTEM_NAME } from '../lib/system-brand';
import { Panel } from './Panel';

const severityOptions: Array<{ value: ReportFilters['severity']; label: string }> = [
  { value: 'all', label: '全部等级' },
  { value: 'severe', label: '严重' },
  { value: 'review', label: '待复核' },
  { value: 'minor', label: '轻微' },
];

const surfaceOptions: Array<{ value: ReportFilters['surface']; label: string }> = [
  { value: 'all', label: '全部相机区' },
  { value: 'top', label: '1-3号相机' },
  { value: 'bottom', label: '4-6号相机' },
];

const severityColors: Record<Severity, string> = {
  severe: '#ef2029',
  review: '#ffb21c',
  minor: '#2f7dff',
};

interface PlateReportRow {
  plateNo: string;
  steelGrade: string;
  thicknessMm: number;
  widthMm: number;
  lengthMm: number;
  detectedAt: string;
  total: number;
  severe: number;
  review: number;
  minor: number;
  top: number;
  bottom: number;
  maxDepthMm: number;
  distanceRange: string;
}

function createPlateReportRows(rows: DefectItem[], inspections: PlateInspection[]): PlateReportRow[] {
  const plateByNo = new Map(inspections.map((inspection) => [inspection.plate.plateNo, inspection.plate]));
  const grouped = new Map<string, DefectItem[]>();
  rows.forEach((defect) => {
    grouped.set(defect.plateNo, [...(grouped.get(defect.plateNo) ?? []), defect]);
  });

  return Array.from(grouped.entries())
    .map(([plateNo, defects]) => {
      const plate = plateByNo.get(plateNo);
      const distances = defects.map((defect) => defect.distanceHeadMm);
      return {
        plateNo,
        steelGrade: plate?.steelGrade ?? '--',
        thicknessMm: plate?.thicknessMm ?? 0,
        widthMm: plate?.widthMm ?? 0,
        lengthMm: plate?.lengthMm ?? 0,
        detectedAt: plate?.detectedAt ?? '--',
        total: defects.length,
        severe: defects.filter((defect) => defect.severity === 'severe').length,
        review: defects.filter((defect) => defect.severity === 'review').length,
        minor: defects.filter((defect) => defect.severity === 'minor').length,
        top: defects.filter((defect) => defect.surface === 'top').length,
        bottom: defects.filter((defect) => defect.surface === 'bottom').length,
        maxDepthMm: Math.max(...defects.map((defect) => Math.abs(defect.depthMm))),
        distanceRange: `${Math.min(...distances)}-${Math.max(...distances)}mm`,
      };
    })
    .sort((a, b) => b.total - a.total || a.plateNo.localeCompare(b.plateNo));
}

function getDefectCameraLabel(defect: DefectItem) {
  const span = defect.operatorSideMm + defect.driveSideMm;
  if (Number.isFinite(span) && span > 0) {
    const cameraIndex = Math.min(5, Math.max(0, Math.floor((defect.operatorSideMm / span) * 6)));
    return `camera${cameraIndex + 1}`;
  }
  return defect.surface === 'top' ? 'camera1-3' : 'camera4-6';
}

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
          <td colSpan={10} className="empty-cell">
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
          <td>{getDefectCameraLabel(defect)}</td>
          <td className={defect.severity}>{severityLabels[defect.severity]}</td>
          <td>{defect.distanceHeadMm}mm</td>
          <td>{defect.operatorSideMm}mm</td>
          <td>{defect.driveSideMm}mm</td>
          <td>{`${defect.widthMm.toFixed(2)} x ${defect.heightMm.toFixed(2)}`}</td>
          <td>{defect.depthMm.toFixed(2)}mm</td>
        </tr>
      ))}
    </tbody>
  );
}

export function ReportPage({
  systemName = DEFAULT_SYSTEM_NAME,
  defectTypes,
  inspections,
  rows,
  pageRows,
  metrics,
  metadata,
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
  onIssueArchive,
  onPrintArchive,
  issueArchiveDisabled,
  printArchiveDisabled,
  archiveReports,
  archiveStatus,
}: {
  systemName?: string;
  defectTypes: DefectType[];
  inspections: PlateInspection[];
  rows: DefectItem[];
  pageRows: DefectItem[];
  metrics: ReportMetrics;
  metadata: ReportMetadata;
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
  onIssueArchive: () => void;
  onPrintArchive: (archive: InspectionReportArchiveSummary) => void;
  issueArchiveDisabled: boolean;
  printArchiveDisabled: boolean;
  archiveReports: InspectionReportArchiveSummary[];
  archiveStatus: string;
}) {
  const plateRows = createPlateReportRows(rows, inspections);
  const [selectedArchiveId, setSelectedArchiveId] = useState(archiveReports[0]?.reportId ?? '');
  useEffect(() => {
    if (!archiveReports.some((archive) => archive.reportId === selectedArchiveId)) {
      setSelectedArchiveId(archiveReports[0]?.reportId ?? '');
    }
  }, [archiveReports, selectedArchiveId]);
  const selectedArchive = archiveReports.find((archive) => archive.reportId === selectedArchiveId) ?? archiveReports[0];
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
      <section className="report-document">
        <header className="report-document-header">
          <div>
            <span>{systemName}</span>
            <h1>钢管表面缺陷检测报表</h1>
          </div>
          <div className="report-document-meta">
            <span>报表编号 {metadata.reportId}</span>
            <span>数据来源 {metadata.dataSource}</span>
            {metadata.dataThrough ? <span>数据截止 {metadata.dataThrough}</span> : null}
            <span>记录数 {rows.length}</span>
            <span title={archiveReports[0]?.reportId ?? archiveStatus}>
              归档 {archiveReports.length} 份{archiveReports[0]?.issuedAt ? ` · 最近 ${archiveReports[0].issuedAt}` : ''}
            </span>
          </div>
        </header>

        <Panel
          title="查询条件"
          className="report-filter-panel"
          action={
            <div className="report-export-actions">
              <select
                aria-label="归档版本"
                value={selectedArchive?.reportId ?? ''}
                onChange={(event) => setSelectedArchiveId(event.target.value)}
                disabled={archiveReports.length === 0}
                title="选择需要打印的不可变归档版本"
              >
                {archiveReports.length === 0 ? <option value="">无归档版本</option> : null}
                {archiveReports.map((archive) => (
                  <option key={archive.reportId} value={archive.reportId}>
                    {archive.issuedAt} · {archive.reportId}
                  </option>
                ))}
              </select>
              <button type="button" onClick={onIssueArchive} disabled={issueArchiveDisabled} title={issueArchiveDisabled ? '只支持对单个生产检测记录签发归档报告' : '签发不可变检测报告'}>
                <FileText size={15} />
                签发归档
              </button>
              <button type="button" onClick={() => selectedArchive && onPrintArchive(selectedArchive)} disabled={printArchiveDisabled || !selectedArchive} title={printArchiveDisabled ? '请先选择单个检测记录并签发归档报告' : '下载与所选不可变归档一致的打印版 HTML'}>
                <Printer size={15} />
                打印版
              </button>
              <button type="button" onClick={onExportCsv}>
                <Download size={15} />
                CSV
              </button>
              <button type="button" onClick={onExportJson}>
                <Download size={15} />
                JSON
              </button>
            </div>
          }
        >
          <div className="report-filter-grid">
            <label>
              <span>关键字</span>
              <input value={filters.keyword} onChange={(event) => onFilterChange({ keyword: event.target.value })} placeholder="钢管号 / 缺陷 / 距离" />
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
              <span>相机区</span>
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
            <div className="form-actions report-query-actions">
              <button type="button" onClick={onApply}>
                <Search size={15} />
                查询
              </button>
              <button type="button" onClick={onReset}>
                <RotateCcw size={15} />
                重置
              </button>
            </div>
          </div>
        </Panel>

        <section className="report-metrics">
          <div>
            <span>钢管数</span>
            <strong>{plateRows.length}</strong>
          </div>
          <div>
            <span>缺陷记录</span>
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
            <span>相机区</span>
            <strong>{metrics.top}/{metrics.bottom}</strong>
          </div>
          <div>
            <span>最大深度</span>
            <strong>{metrics.maxDepthMm.toFixed(2)}mm</strong>
          </div>
        </section>

        <section className="report-layout">
          <Panel title="钢管汇总" className="report-plate-panel">
            <table className="report-table plate-summary-table">
              <thead>
                <tr>
                  <th>钢管号</th>
                  <th>钢种</th>
                  <th>规格 mm</th>
                  <th>检测时间</th>
                  <th>缺陷数</th>
                  <th>严重</th>
                  <th>待复核</th>
                  <th>轻微</th>
                  <th>相机区</th>
                  <th>最大深度</th>
                  <th>距头范围</th>
                </tr>
              </thead>
              <tbody>
                {plateRows.length > 0 ? (
                  plateRows.map((plateRow) => (
                    <tr key={plateRow.plateNo}>
                      <td>{plateRow.plateNo}</td>
                      <td>{plateRow.steelGrade}</td>
                      <td>{`${plateRow.widthMm} x ${plateRow.lengthMm} x ${plateRow.thicknessMm}`}</td>
                      <td>{plateRow.detectedAt}</td>
                      <td>{plateRow.total}</td>
                      <td className="severe">{plateRow.severe}</td>
                      <td className="review">{plateRow.review}</td>
                      <td className="minor">{plateRow.minor}</td>
                      <td>{plateRow.top}/{plateRow.bottom}</td>
                      <td>{plateRow.maxDepthMm.toFixed(2)}mm</td>
                      <td>{plateRow.distanceRange}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={11} className="empty-cell">
                      当前筛选条件下无钢管记录
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>

          <Panel
            title="缺陷明细"
            className="report-table-panel"
            action={
              <span className="report-table-action">
                <FileText size={15} />
                共 {rows.length} 条，{page} / {pageCount} 页
              </span>
            }
          >
          <table className="report-table">
            <thead>
              <tr>
                <th>序号</th>
                <th>钢管号</th>
                <th>缺陷类别</th>
                <th>相机</th>
                <th>等级</th>
                <th>距头距离</th>
                <th>操作侧</th>
                <th>传动侧</th>
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

          <Panel title="等级与选中缺陷" className="report-detail-panel">
            <div className="report-detail-grid">
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
              {selectedDefect ? (
                <>
                  <dl className="report-detail-list">
                    <div>
                      <dt>缺陷编号</dt>
                      <dd>{selectedDefect.id}</dd>
                    </div>
                    <div>
                      <dt>钢管号</dt>
                      <dd>{selectedDefect.plateNo}</dd>
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
                      <dd>{`${getDefectCameraLabel(selectedDefect)} / 距头 ${selectedDefect.distanceHeadMm}mm`}</dd>
                    </div>
                    <div>
                      <dt>边部距离</dt>
                      <dd>{`操作侧 ${selectedDefect.operatorSideMm}mm / 传动侧 ${selectedDefect.driveSideMm}mm`}</dd>
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
            </div>
          </Panel>
        </section>
      </section>
    </main>
  );
}
