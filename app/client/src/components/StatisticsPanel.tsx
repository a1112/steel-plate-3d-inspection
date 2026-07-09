import type { CSSProperties } from 'react';
import type { InspectionSummary, Severity, SteelPlate } from '../data/inspection';
import { severityLabels } from '../data/inspection';
import { Panel } from './Panel';

const severityOrder: Severity[] = ['severe', 'review', 'minor'];

export function StatisticsPanel({
  plate,
  summary,
  selectedSeverityFilters,
  onSeverityFilterToggle,
  onOpenReport,
}: {
  plate: SteelPlate;
  summary: InspectionSummary;
  selectedSeverityFilters: ReadonlySet<Severity>;
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
    <Panel title="缺陷统计信息" className="statistics-panel">
      <div className="stat-heading">
        <span>钢管号</span>
        <strong>{plate.plateNo}</strong>
        <button type="button" onClick={onOpenReport}>
          本钢管统计
        </button>
      </div>
      <div className="summary-layout">
        <div className="donut" style={{ '--severe': severe, '--review': review, '--minor': minor } as CSSProperties}>
          <div>
            <span>缺陷总数</span>
            <strong>{summary.total}</strong>
          </div>
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
      </div>
      <div className="surface-counts">
        <div>
          <span>1-3号相机</span>
          <strong>{summary.bySurface.top}</strong>
          <i />
        </div>
        <div>
          <span>4-6号相机</span>
          <strong>{summary.bySurface.bottom}</strong>
          <i />
        </div>
      </div>
    </Panel>
  );
}
