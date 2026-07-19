import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DefectType, InspectionSummary, Severity, SteelPlate } from '../data/inspection';
import { StatisticsPanel } from './StatisticsPanel';

const plate: SteelPlate = {
  plateNo: '202606131900',
  widthMm: 3500,
  lengthMm: 12000,
  thicknessMm: 12,
  steelGrade: 'Q355B',
  detectedAt: '2026-06-13 19:00',
};

const summary: InspectionSummary = {
  total: 12,
  bySeverity: {
    severe: 4,
    review: 3,
    minor: 5,
  },
  bySurface: {
    top: 5,
    bottom: 7,
  },
};

const defectTypes: DefectType[] = [
  { id: 'pit', label: '凹坑', color: '#2f6bff', shape: 'circle' },
  { id: 'scratch', label: '划伤', color: '#24a647', shape: 'rect' },
];

describe('StatisticsPanel', () => {
  it('filters defects by category and severity', () => {
    const onDefectTypeToggle = vi.fn();
    const onSeverityFilterToggle = vi.fn();
    const { rerender } = render(
      <StatisticsPanel
        plate={plate}
        summary={summary}
        defectTypes={defectTypes}
        defectTypeCounts={{ pit: 5, scratch: 7 }}
        hiddenDefectTypeIds={new Set<string>()}
        selectedSeverityFilters={new Set<Severity>(['severe', 'review', 'minor'])}
        onDefectTypeToggle={onDefectTypeToggle}
        onSeverityFilterToggle={onSeverityFilterToggle}
        onOpenReport={vi.fn()}
      />,
    );

    const pitFilter = screen.getByRole('button', { name: '凹坑类别过滤，当前5项' });
    const scratchFilter = screen.getByRole('button', { name: '划伤类别过滤，当前7项' });
    const severeCard = screen.getByRole('button', { name: '严重等级过滤，当前4项' });
    const reviewCard = screen.getByRole('button', { name: '待复核等级过滤，当前3项' });
    const minorCard = screen.getByRole('button', { name: '轻微等级过滤，当前5项' });
    expect(pitFilter).toHaveAttribute('aria-pressed', 'true');
    expect(scratchFilter).toHaveAttribute('aria-pressed', 'true');
    expect(severeCard).toHaveAttribute('aria-pressed', 'true');
    expect(reviewCard).toHaveAttribute('aria-pressed', 'true');
    expect(minorCard).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(pitFilter);
    expect(onDefectTypeToggle).toHaveBeenCalledWith('pit');
    fireEvent.click(severeCard);
    expect(onSeverityFilterToggle).toHaveBeenCalledWith('severe');

    rerender(
      <StatisticsPanel
        plate={plate}
        summary={summary}
        defectTypes={defectTypes}
        defectTypeCounts={{ pit: 5, scratch: 7 }}
        hiddenDefectTypeIds={new Set<string>(['pit'])}
        selectedSeverityFilters={new Set<Severity>(['review', 'minor'])}
        onDefectTypeToggle={onDefectTypeToggle}
        onSeverityFilterToggle={onSeverityFilterToggle}
        onOpenReport={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '凹坑类别过滤，当前5项' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '划伤类别过滤，当前7项' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: '严重等级过滤，当前4项' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '待复核等级过滤，当前3项' })).toHaveClass('active');
  });
});
