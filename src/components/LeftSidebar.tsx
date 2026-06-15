import { ChevronLeft, ChevronRight, RotateCcw, Search } from 'lucide-react';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import type { InspectionRecord, SteelPlate } from '../data/inspection';
import { emptyRecordSearchFilters, type RecordSearchFilters } from '../state/record-search';
import { Panel } from './Panel';

type RecordSearchField = keyof RecordSearchFilters;

const recordSearchOptions: Array<{ field: RecordSearchField; label: string; placeholder: string; inputLabel: string }> = [
  { field: 'serialNo', label: '流水号', placeholder: 'R-001', inputLabel: '流水号查询' },
  { field: 'plateNo', label: '钢板号', placeholder: '202606131900', inputLabel: '钢板号查询' },
  { field: 'time', label: '时间', placeholder: '2026-06-13 / 19:00', inputLabel: '时间查询' },
];

function createSingleRecordSearchPatch(field: RecordSearchField, value: string): RecordSearchFilters {
  return {
    ...emptyRecordSearchFilters,
    [field]: value,
  };
}

interface LeftSidebarProps {
  plate: SteelPlate;
  records: InspectionRecord[];
  selectedRecordId: string;
  page: number;
  pageCount: number;
  searchFilters: RecordSearchFilters;
  filteredCount: number;
  totalCount: number;
  onPageChange: (page: number) => void;
  onRecordSelect: (plateNo: string) => void;
  onSearchChange: (patch: Partial<RecordSearchFilters>) => void;
  onSearchReset: () => void;
}

export function LeftSidebar({
  plate,
  records,
  selectedRecordId,
  page,
  pageCount,
  searchFilters,
  filteredCount,
  totalCount,
  onPageChange,
  onRecordSelect,
  onSearchChange,
  onSearchReset,
}: LeftSidebarProps) {
  const [activeSearchField, setActiveSearchField] = useState<RecordSearchField>('serialNo');
  const activeSearchOption = recordSearchOptions.find((option) => option.field === activeSearchField) ?? recordSearchOptions[0];
  const activeSearchValue = searchFilters[activeSearchField];

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  };

  const handleSearchFieldChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextField = event.target.value as RecordSearchField;
    setActiveSearchField(nextField);
    onSearchChange(createSingleRecordSearchPatch(nextField, searchFilters[nextField]));
  };

  const handleSearchValueChange = (event: ChangeEvent<HTMLInputElement>) => {
    onSearchChange(createSingleRecordSearchPatch(activeSearchField, event.target.value));
  };

  const handleSearchReset = () => {
    setActiveSearchField('serialNo');
    onSearchReset();
  };

  return (
    <aside className="left-column">
      <Panel title="钢板信息" className="plate-info-panel">
        <dl className="plate-info-list">
          <div>
            <dt>钢板号:</dt>
            <dd>{plate.plateNo}</dd>
          </div>
          <div>
            <dt>钢板宽度:</dt>
            <dd>{plate.widthMm} mm</dd>
          </div>
          <div>
            <dt>钢板长度:</dt>
            <dd>{plate.lengthMm} mm</dd>
          </div>
          <div>
            <dt>钢板厚度:</dt>
            <dd>{plate.thicknessMm} mm</dd>
          </div>
          <div>
            <dt>钢种规格:</dt>
            <dd>{plate.steelGrade}</dd>
          </div>
          <div>
            <dt>检测时间:</dt>
            <dd>{plate.detectedAt}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="记录查询" className="record-search-panel">
        <form className="record-search-form" onSubmit={handleSubmit}>
          <div className="record-search-condition">
            <label className="record-search-input-wrap">
              <span>{activeSearchOption.label}</span>
              <input
                value={activeSearchValue}
                aria-label={activeSearchOption.inputLabel}
                placeholder={activeSearchOption.placeholder}
                onChange={handleSearchValueChange}
              />
            </label>
            <select value={activeSearchField} aria-label="查询条件" onChange={handleSearchFieldChange}>
              {recordSearchOptions.map((option) => (
                <option key={option.field} value={option.field}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="record-search-actions">
            <button type="submit">
              <Search size={14} />
              查询
            </button>
            <button type="button" onClick={handleSearchReset}>
              <RotateCcw size={14} />
              重置
            </button>
          </div>
          <div className="record-search-count">
            匹配 <strong>{filteredCount}</strong> / {totalCount}
          </div>
        </form>
      </Panel>

      <Panel title="检测记录" className="records-panel">
        <div className="records-table-wrap">
          <table className="records-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>钢板号</th>
                <th>状态</th>
                <th>缺陷数</th>
              </tr>
            </thead>
            <tbody>
              {records.length > 0 ? (
                records.map((record) => (
                  <tr
                    key={record.id}
                    className={record.plateNo === selectedRecordId ? 'selected' : ''}
                    onClick={() => onRecordSelect(record.plateNo)}
                  >
                    <td>{record.time}</td>
                    <td>{record.plateNo}</td>
                    <td className={record.status === 'detecting' ? 'detecting' : 'completed'}>
                      {record.status === 'detecting' ? '检测中' : '已完成'}
                    </td>
                    <td>{record.defectCount}</td>
                  </tr>
                ))
              ) : (
                <tr className="records-empty-row">
                  <td colSpan={4}>无匹配记录</td>
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
    </aside>
  );
}
