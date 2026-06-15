import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InspectionSummary, SteelPlate } from '../data/inspection';
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
  it('filters by severity from the summary cards and clears the active severity on repeat click', () => {
    const onSeverityFilterChange = vi.fn();
    const { rerender } = render(
      <StatisticsPanel
        plate={plate}
        summary={summary}
        activeSeverityFilter="all"
        onSeverityFilterChange={onSeverityFilterChange}
        onOpenReport={vi.fn()}
      />,
    );

    const severeCard = screen.getByRole('button', { name: '严重等级过滤，当前4项' });
    expect(severeCard).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(severeCard);
    expect(onSeverityFilterChange).toHaveBeenCalledWith('severe');

    rerender(
      <StatisticsPanel
        plate={plate}
        summary={summary}
        activeSeverityFilter="severe"
        onSeverityFilterChange={onSeverityFilterChange}
        onOpenReport={vi.fn()}
      />,
    );

    const activeSevereCard = screen.getByRole('button', { name: '严重等级过滤，当前4项' });
    expect(activeSevereCard).toHaveAttribute('aria-pressed', 'true');
    expect(activeSevereCard).toHaveClass('active');

    fireEvent.click(activeSevereCard);
    expect(onSeverityFilterChange).toHaveBeenCalledWith('all');
  });
});
