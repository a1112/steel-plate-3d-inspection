import { AlertTriangle, RotateCcw, Search } from 'lucide-react';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { InspectionRecord, InspectionSummary, PlateInspection, SteelPlate } from '../data/inspection';
import { emptyRecordSearchFilters, type RecordSearchFilters } from '../state/record-search';
import { Panel } from './Panel';

type RecordSearchField = keyof RecordSearchFilters;

const recordSearchOptions: Array<{ field: RecordSearchField; label: string; placeholder: string; inputLabel: string }> = [
  { field: 'serialNo', label: '流水号', placeholder: 'R-001', inputLabel: '流水号查询' },
  { field: 'plateNo', label: '钢管号', placeholder: '202606131900', inputLabel: '钢管号查询' },
  { field: 'time', label: '时间', placeholder: '2026-06-13 / 19:00', inputLabel: '时间查询' },
];

function createSingleRecordSearchPatch(field: RecordSearchField, value: string): RecordSearchFilters {
  return {
    ...emptyRecordSearchFilters,
    [field]: value,
  };
}

interface LeftSidebarProps {
  runtimeMode?: 'online' | 'bkv';
  plate: SteelPlate;
  summary: InspectionSummary;
  records: InspectionRecord[];
  inspections?: PlateInspection[];
  selectedRecordId: string;
  searchFilters: RecordSearchFilters;
  filteredCount: number;
  totalCount: number;
  onRecordSelect: (plateNo: string) => void;
  onSearchChange: (patch: Partial<RecordSearchFilters>) => void;
  onSearchReset: () => void;
}

function SidebarAlertCard({ summary }: { summary: InspectionSummary }) {
  const hasSevereDefect = summary.bySeverity.severe > 0;
  const hasDefect = summary.total > 0;
  const message = hasSevereDefect
    ? `检测到 ${summary.bySeverity.severe} 个严重缺陷`
    : hasDefect
      ? `当前钢管 ${summary.total} 个缺陷均未达严重等级`
      : '当前钢管未检出缺陷';

  return (
    <section
      className={`sidebar-alert-card ${hasSevereDefect ? '' : 'stable'}`}
      aria-label={`${hasSevereDefect ? '严重缺陷报警' : '缺陷状态正常'}，${message}`}
    >
      <AlertTriangle size={18} strokeWidth={1.9} />
      <div>
        <strong>{hasSevereDefect ? '严重缺陷报警' : '缺陷状态正常'}</strong>
        <span>{message}</span>
      </div>
      <b>{hasSevereDefect ? '立即复核' : '跟踪'}</b>
    </section>
  );
}

export function LeftSidebar({
  runtimeMode = 'online',
  plate,
  summary,
  records,
  inspections = [],
  selectedRecordId,
  searchFilters,
  filteredCount,
  totalCount,
  onRecordSelect,
  onSearchChange,
  onSearchReset,
}: LeftSidebarProps) {
  const [activeSearchField, setActiveSearchField] = useState<RecordSearchField>('serialNo');
  const [hoveredRecord, setHoveredRecord] = useState<{ record: InspectionRecord; left: number; top: number } | null>(null);
  const activeSearchOption = recordSearchOptions.find((option) => option.field === activeSearchField) ?? recordSearchOptions[0];
  const activeSearchValue = searchFilters[activeSearchField];
  const hoveredInspection = hoveredRecord
    ? inspections.find((inspection) => inspection.inspectionId === hoveredRecord.record.id)
      ?? inspections.find((inspection) => inspection.plate.plateNo === hoveredRecord.record.plateNo)
      ?? null
    : null;

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

  const showRecordDetail = (record: InspectionRecord, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setHoveredRecord({
      record,
      left: Math.min(rect.right + 10, window.innerWidth - 354),
      top: Math.max(56, Math.min(rect.top - 18, window.innerHeight - 390)),
    });
  };

  return (
    <aside className={`left-column runtime-${runtimeMode}`}>
      {runtimeMode === 'bkv' ? (
        <div className="sidebar-data-source" role="note">
          <div>
            <strong>来源：旧 BKV 文件</strong>
            <span>BKV 离线数据 · 只读观察</span>
          </div>
          <b>硬件控制已禁用</b>
        </div>
      ) : null}
      <SidebarAlertCard summary={summary} />

      <Panel title="钢管信息" className="plate-info-panel" headerless>
        <dl className="plate-info-list">
          <div>
            <dt>钢管号:</dt>
            <dd>{plate.plateNo}</dd>
          </div>
          <div>
            <dt>外径/宽度:</dt>
            <dd>{plate.widthMm} mm</dd>
          </div>
          <div>
            <dt>钢管长度:</dt>
            <dd>{plate.lengthMm} mm</dd>
          </div>
          <div>
            <dt>壁厚:</dt>
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

      <Panel
        title="记录查询"
        className="record-search-panel"
        action={
          <select
            className="record-search-field-select"
            value={activeSearchField}
            aria-label="查询条件"
            onChange={handleSearchFieldChange}
          >
            {recordSearchOptions.map((option) => (
              <option key={option.field} value={option.field}>
                {option.label}
              </option>
            ))}
          </select>
        }
      >
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
                <th>钢管号</th>
                <th>状态</th>
                <th>缺陷数</th>
              </tr>
            </thead>
            <tbody>
              {records.length > 0 ? (
                records.map((record) => (
                  <tr
                    key={record.id}
                    tabIndex={0}
                    className={record.plateNo === selectedRecordId ? 'selected' : ''}
                    onClick={() => onRecordSelect(record.plateNo)}
                    onMouseEnter={(event) => showRecordDetail(record, event.currentTarget)}
                    onPointerEnter={(event) => showRecordDetail(record, event.currentTarget)}
                    onMouseLeave={() => setHoveredRecord(null)}
                    onPointerLeave={() => setHoveredRecord(null)}
                    onFocus={(event) => showRecordDetail(record, event.currentTarget)}
                    onBlur={() => setHoveredRecord(null)}
                  >
                    <td>{record.time}</td>
                    <td>{record.plateNo}</td>
                    <td className={record.status === 'detecting' ? 'detecting' : 'completed'}>
                      {record.status === 'detecting' ? '检测中' : runtimeMode === 'bkv' ? '旧记录' : '已完成'}
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
      </Panel>
      {hoveredRecord && typeof document !== 'undefined' ? createPortal(
        <aside
          className="record-hover-detail"
          style={{ left: hoveredRecord.left, top: hoveredRecord.top }}
          role="tooltip"
          aria-label={`${hoveredRecord.record.plateNo} 检测记录详情`}
        >
          <header>
            <span>检测记录详情</span>
            <strong>{hoveredRecord.record.plateNo}</strong>
          </header>
          <dl>
            <div><dt>检测时间</dt><dd>{hoveredRecord.record.time}</dd></div>
            <div><dt>记录状态</dt><dd className={hoveredRecord.record.status}>{hoveredRecord.record.status === 'detecting' ? '检测中' : runtimeMode === 'bkv' ? 'BKV 旧记录' : '已完成'}</dd></div>
            <div><dt>缺陷总数</dt><dd>{hoveredRecord.record.defectCount}</dd></div>
            <div><dt>采集产物</dt><dd>{hoveredInspection?.captureImages?.length ?? 0} 件</dd></div>
            <div><dt>规格/钢种</dt><dd>{hoveredInspection?.plate.steelGrade || '—'}</dd></div>
            <div><dt>外径/宽度</dt><dd>{hoveredInspection?.plate.widthMm ?? 0} mm</dd></div>
            <div><dt>长度</dt><dd>{hoveredInspection?.plate.lengthMm ?? 0} mm</dd></div>
            <div><dt>壁厚</dt><dd>{hoveredInspection?.plate.thicknessMm ?? 0} mm</dd></div>
          </dl>
          <section>
            <strong>缺陷分布</strong>
            <div className="record-hover-severity">
              <span>严重 <b>{hoveredInspection?.defects.filter((defect) => defect.severity === 'severe').length ?? 0}</b></span>
              <span>待复核 <b>{hoveredInspection?.defects.filter((defect) => defect.severity === 'review').length ?? 0}</b></span>
              <span>轻微 <b>{hoveredInspection?.defects.filter((defect) => defect.severity === 'minor').length ?? 0}</b></span>
            </div>
          </section>
          <footer>{hoveredInspection?.inspectionId || hoveredRecord.record.id}</footer>
        </aside>,
        document.body,
      ) : null}
    </aside>
  );
}
