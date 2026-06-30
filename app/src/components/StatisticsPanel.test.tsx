import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InspectionSummary, Severity, SteelPlate } from '../data/inspection';
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

describe('StatisticsPanel', () => {
  it('shows all severity cards selected by default and toggles each card', () => {
    const onSeverityFilterToggle = vi.fn();
    const { rerender } = render(
      <StatisticsPanel
        plate={plate}
        summary={summary}
        selectedSeverityFilters={new Set<Severity>(['severe', 'review', 'minor'])}
        onSeverityFilterToggle={onSeverityFilterToggle}
        onOpenReport={vi.fn()}
      />,
    );

    const severeCard = screen.getByRole('button', { name: '严重等级过滤，当前4项' });
    const reviewCard = screen.getByRole('button', { name: '待复核等级过滤，当前3项' });
    const minorCard = screen.getByRole('button', { name: '轻微等级过滤，当前5项' });
    expect(severeCard).toHaveAttribute('aria-pressed', 'true');
    expect(reviewCard).toHaveAttribute('aria-pressed', 'true');
    expect(minorCard).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(severeCard);
    expect(onSeverityFilterToggle).toHaveBeenCalledWith('severe');

    rerender(
      <StatisticsPanel
        plate={plate}
        summary={summary}
        selectedSeverityFilters={new Set<Severity>(['review', 'minor'])}
        onSeverityFilterToggle={onSeverityFilterToggle}
        onOpenReport={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '严重等级过滤，当前4项' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '待复核等级过滤，当前3项' })).toHaveClass('active');
  });
});
