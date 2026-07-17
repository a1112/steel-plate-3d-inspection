import { ChevronLeft, ChevronRight, Filter } from 'lucide-react';
import type { ChangeEvent } from 'react';
import type { DefectItem } from '../data/inspection';
import { severityLabels } from '../data/inspection';
import type { ReportFilters } from '../state/operations';
import { Panel } from './Panel';

interface DefectDetectionListProps {
  defects: DefectItem[];
  selectedDefectId: string | null;
  page: number;
  pageCount: number;
  filters: ReportFilters;
  filterOpen: boolean;
  onPageChange: (page: number) => void;
  onSelectDefect: (defectId: string) => void;
  onToggleFilter: () => void;
  onFilterChange: (patch: Partial<ReportFilters>) => void;
  onClearFilters: () => void;
}

function getDefectCameraLabel(defect: DefectItem) {
  if (typeof defect.cameraIndex === 'number' && defect.cameraIndex >= 1 && defect.cameraIndex <= 8) {
    return `camera${Math.round(defect.cameraIndex)}`;
  }
  const cameraMatch = defect.cameraId?.match(/(?:camera|cam)\s*([1-8])/i);
  if (cameraMatch) {
    return `camera${cameraMatch[1]}`;
  }
  const span = defect.operatorSideMm + defect.driveSideMm;
  const ratio = typeof defect.circumferenceRatio === 'number'
    ? defect.circumferenceRatio
    : span > 0 ? defect.operatorSideMm / span : (defect.yOffsetMm + 1.5) / 3;
  const cameraIndex = Math.max(0, Math.min(7, Math.floor(Math.max(0, Math.min(0.999, ratio)) * 8)));
  return `camera${cameraIndex + 1}`;
}

export function DefectDetectionList({
  defects,
  selectedDefectId,
  page,
  pageCount,
  filters,
  filterOpen,
  onPageChange,
  onSelectDefect,
  onToggleFilter,
  onFilterChange,
  onClearFilters,
}: DefectDetectionListProps) {
  const handleSelect = (event: ChangeEvent<HTMLSelectElement>, key: 'severity') => {
    onFilterChange({ [key]: event.target.value } as Partial<ReportFilters>);
  };

  return (
    <Panel
      title="缺陷检测列表"
      className="defect-list-panel"
      action={
        <button type="button" className={`icon-filter ${filterOpen ? 'active' : ''}`} title="筛选" onClick={onToggleFilter}>
          <Filter size={17} />
        </button>
      }
    >
      {filterOpen ? (
        <div className="inline-filter">
          <input value={filters.keyword} onChange={(event) => onFilterChange({ keyword: event.target.value })} placeholder="钢管号 / 缺陷 / 距离" />
          <select value={filters.severity} onChange={(event) => handleSelect(event, 'severity')}>
            <option value="all">全部等级</option>
            <option value="severe">严重</option>
            <option value="review">待复核</option>
            <option value="minor">轻微</option>
          </select>
          <button type="button" onClick={onClearFilters}>
            清空
          </button>
        </div>
      ) : null}
      <div className="defect-table-wrap">
        <table className="defect-table">
          <thead>
            <tr>
              <th>序号</th>
              <th>缺陷类别</th>
              <th>相机</th>
              <th>距头距离</th>
              <th>等级</th>
            </tr>
          </thead>
          <tbody>
            {defects.length > 0 ? (
              defects.map((defect, index) => (
                <tr
                  key={defect.id}
                  className={defect.id === selectedDefectId ? 'selected' : ''}
                  onClick={() => onSelectDefect(defect.id)}
                >
                  <td>{String((page - 1) * 10 + index + 1).padStart(2, '0')}</td>
                  <td>
                    {defect.typeLabel}
                    {defect.classificationState === 'candidate-only' ? <small className="candidate-defect-badge">候选</small> : null}
                    {defect.synthetic ? <small className="synthetic-defect-badge">模拟</small> : null}
                  </td>
                  <td>{getDefectCameraLabel(defect)}</td>
                  <td>{defect.distanceHeadMm}mm</td>
                  <td className={defect.severity}>{severityLabels[defect.severity]}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="empty-cell">
                  当前筛选条件下无记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <button type="button" onClick={() => onPageChange(page - 1)} disabled={page <= 1}>
          <ChevronLeft size={16} />
        </button>
        <span>
          {page} / {pageCount}
        </span>
        <button type="button" onClick={() => onPageChange(page + 1)} disabled={page >= pageCount}>
          <ChevronRight size={16} />
        </button>
      </div>
    </Panel>
  );
}
