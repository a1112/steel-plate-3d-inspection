import { ChevronLeft, ChevronRight, Filter } from 'lucide-react';
import type { ChangeEvent } from 'react';
import type { DefectItem } from '../data/inspection';
import { severityLabels, surfaceLabels } from '../data/inspection';
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
  const handleSelect = (event: ChangeEvent<HTMLSelectElement>, key: 'severity' | 'surface') => {
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
          <input value={filters.keyword} onChange={(event) => onFilterChange({ keyword: event.target.value })} placeholder="钢板号 / 缺陷 / 距离" />
          <select value={filters.severity} onChange={(event) => handleSelect(event, 'severity')}>
            <option value="all">全部等级</option>
            <option value="severe">严重</option>
            <option value="review">待复核</option>
            <option value="minor">轻微</option>
          </select>
          <select value={filters.surface} onChange={(event) => handleSelect(event, 'surface')}>
            <option value="all">全部表面</option>
            <option value="top">上表面</option>
            <option value="bottom">下表面</option>
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
              <th>表面</th>
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
                  <td>{defect.typeLabel}</td>
                  <td>{surfaceLabels[defect.surface]}</td>
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
