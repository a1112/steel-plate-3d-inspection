import type { CSSProperties } from 'react';
import type { DefectType, InspectionSummary, Severity } from '../data/inspection';
import { severityLabels } from '../data/inspection';
import { Panel } from './Panel';

const severityOrder: Severity[] = ['severe', 'review', 'minor'];

interface DefectFilterProps {
  summary: InspectionSummary;
  defectTypes: DefectType[];
  defectTypeCounts: Record<string, number>;
  hiddenDefectTypeIds: ReadonlySet<string>;
  selectedSeverityFilters: ReadonlySet<Severity>;
  onDefectTypeToggle: (typeId: string) => void;
  onSeverityFilterToggle: (severity: Severity) => void;
}

function SeverityFilters({ summary, selectedSeverityFilters, onSeverityFilterToggle }: Pick<DefectFilterProps, 'summary' | 'selectedSeverityFilters' | 'onSeverityFilterToggle'>) {
  const severityCounts = summary.bySeverity;

  return (
    <div className="severity-filters-inline">
      {severityOrder
        .filter((severity) => severityCounts[severity] > 0)
        .map((severity) => {
        const active = selectedSeverityFilters.has(severity);
        return (
          <button
            key={severity}
            type="button"
            className={`severity-filter-inline ${severity} ${active ? 'active' : ''}`}
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
  );
}

export function DefectFilterPanel({
  summary,
  defectTypes,
  defectTypeCounts,
  hiddenDefectTypeIds,
  selectedSeverityFilters,
  onDefectTypeToggle,
  onSeverityFilterToggle,
}: DefectFilterProps) {
  return (
    <Panel
      title="缺陷过滤"
      className="defect-filter-panel"
      action={<SeverityFilters summary={summary} selectedSeverityFilters={selectedSeverityFilters} onSeverityFilterToggle={onSeverityFilterToggle} />}
    >
      <div className="defect-type-filter-grid">
        {defectTypes
          .filter((type) => (defectTypeCounts[type.id] ?? 0) > 0)
          .map((type) => {
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
    </Panel>
  );
}

export function StatisticsPanel({
  summary,
  defectTypes,
  defectTypeCounts,
}: Pick<DefectFilterProps, 'summary' | 'defectTypes' | 'defectTypeCounts'>) {
  return (
    <Panel title="缺陷数量" className="statistics-panel">
      <div className="defect-count-grid" aria-label={`当前共 ${summary.total} 项缺陷`}>
        {defectTypes
          .filter((type) => (defectTypeCounts[type.id] ?? 0) > 0)
          .map((type) => (
          <div key={type.id} className="defect-count-item" style={{ '--defect-type-color': type.color } as CSSProperties}>
            <i aria-hidden="true" />
            <span>{type.label}</span>
            <strong>{defectTypeCounts[type.id] ?? 0}</strong>
          </div>
        ))}
      </div>
    </Panel>
  );
}
