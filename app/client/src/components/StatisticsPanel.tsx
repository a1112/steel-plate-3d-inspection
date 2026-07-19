import type { CSSProperties } from 'react';
import type { DefectType, InspectionSummary, Severity, SteelPlate } from '../data/inspection';
import { severityLabels } from '../data/inspection';
import { Panel } from './Panel';

const severityOrder: Severity[] = ['severe', 'review', 'minor'];

export function StatisticsPanel({
  plate,
  summary,
  defectTypes,
  defectTypeCounts,
  hiddenDefectTypeIds,
  selectedSeverityFilters,
  onDefectTypeToggle,
  onSeverityFilterToggle,
  onOpenReport,
}: {
  plate: SteelPlate;
  summary: InspectionSummary;
  defectTypes: DefectType[];
  defectTypeCounts: Record<string, number>;
  hiddenDefectTypeIds: ReadonlySet<string>;
  selectedSeverityFilters: ReadonlySet<Severity>;
  onDefectTypeToggle: (typeId: string) => void;
  onSeverityFilterToggle: (severity: Severity) => void;
  onOpenReport: () => void;
}) {
  const severe = summary.bySeverity.severe;
  const review = summary.bySeverity.review;
  const minor = summary.bySeverity.minor;
  const severityCounts = {
    severe,
    review,
    minor,
  };

  return (
    <Panel title="缺陷类别、等级过滤" className="statistics-panel">
      <div className="stat-heading">
        <span>钢管号</span>
        <strong>{plate.plateNo}</strong>
        <button type="button" onClick={onOpenReport}>
          本钢管统计
        </button>
      </div>
      <section className="statistics-filter-group" aria-labelledby="defect-category-filter-title">
        <div className="statistics-filter-heading">
          <strong id="defect-category-filter-title">缺陷类别</strong>
          <span>当前共 {summary.total} 项</span>
        </div>
        <div className="defect-type-filter-grid">
          {defectTypes.map((type) => {
            const active = !hiddenDefectTypeIds.has(type.id);
            const count = defectTypeCounts[type.id] ?? 0;
            return (
              <button
                key={type.id}
                type="button"
                className={`defect-type-filter ${active ? 'active' : ''}`}
                style={{ '--defect-type-color': type.color } as CSSProperties}
                aria-pressed={active}
                aria-label={`${type.label}类别过滤，当前${count}项`}
                onClick={() => onDefectTypeToggle(type.id)}
              >
                <i aria-hidden="true" />
                <span>{type.label}</span>
                <strong>{count}</strong>
              </button>
            );
          })}
        </div>
      </section>
      <section className="statistics-filter-group severity-filter-group" aria-labelledby="defect-severity-filter-title">
        <div className="statistics-filter-heading">
          <strong id="defect-severity-filter-title">缺陷等级</strong>
          <span>可多选</span>
        </div>
        <div className="severity-cards">
          {severityOrder.map((severity) => {
            const active = selectedSeverityFilters.has(severity);
            return (
              <button
                key={severity}
                type="button"
                className={`severity-card ${severity} ${active ? 'active' : ''}`}
                aria-pressed={active}
                aria-label={`${severityLabels[severity]}等级过滤，当前${severityCounts[severity]}项`}
                onClick={() => onSeverityFilterToggle(severity)}
              >
                <span>{severityLabels[severity]}</span>
                <strong>{severityCounts[severity]}</strong>
              </button>
            );
          })}
        </div>
      </section>
    </Panel>
  );
}
