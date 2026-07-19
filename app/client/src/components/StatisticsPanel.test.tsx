import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DefectType, InspectionSummary, Severity } from '../data/inspection';
import { DefectFilterPanel, StatisticsPanel } from './StatisticsPanel';

const summary: InspectionSummary = {
  total: 12,
  bySeverity: { severe: 4, review: 3, minor: 5 },
  bySurface: { top: 5, bottom: 7 },
};

const defectTypes: DefectType[] = [
  { id: 'pit', label: '凹坑', color: '#2f6bff', shape: 'circle' },
  { id: 'scratch', label: '划伤', color: '#24a647', shape: 'rect' },
];

describe('defect filters and counts', () => {
  it('keeps category and severity filters interactive above the defect list', () => {
    const onDefectTypeToggle = vi.fn();
    const onSeverityFilterToggle = vi.fn();
    render(
      <DefectFilterPanel
        summary={summary}
        defectTypes={defectTypes}
        defectTypeCounts={{ pit: 5, scratch: 7 }}
        hiddenDefectTypeIds={new Set<string>()}
        selectedSeverityFilters={new Set<Severity>(['severe', 'review', 'minor'])}
        onDefectTypeToggle={onDefectTypeToggle}
        onSeverityFilterToggle={onSeverityFilterToggle}
      />,
    );

    const pitFilter = screen.getByRole('button', { name: '凹坑类别过滤，当前5项' });
    const severeFilter = screen.getByRole('button', { name: '严重等级过滤，当前4项' });
    expect(pitFilter).toHaveAttribute('aria-pressed', 'true');
    expect(severeFilter).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(pitFilter);
    fireEvent.click(severeFilter);
    expect(onDefectTypeToggle).toHaveBeenCalledWith('pit');
    expect(onSeverityFilterToggle).toHaveBeenCalledWith('severe');
  });

  it('shows defect quantities without a steel record summary row', () => {
    render(<StatisticsPanel summary={summary} defectTypes={defectTypes} defectTypeCounts={{ pit: 5, scratch: 7 }} />);

    expect(screen.getByRole('heading', { name: '缺陷数量' })).toBeInTheDocument();
    expect(screen.getByLabelText('当前共 12 项缺陷')).toHaveTextContent('凹坑5');
    expect(screen.queryByText('钢管号')).not.toBeInTheDocument();
    expect(screen.queryByText('缺陷类别')).not.toBeInTheDocument();
  });
});
