import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

function getDefectTableRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.defect-table tbody tr')).map((row) => row.textContent?.trim() ?? '');
}

describe('App online severity filters', () => {
  it('defaults all statistics severities selected and toggles them from the online defect list', () => {
    const { container } = render(<App />);

    const severeCard = screen.getByRole('button', { name: '严重等级过滤，当前4项' });
    const reviewCard = screen.getByRole('button', { name: '待复核等级过滤，当前3项' });
    const minorCard = screen.getByRole('button', { name: '轻微等级过滤，当前5项' });
    expect(severeCard).toHaveAttribute('aria-pressed', 'true');
    expect(reviewCard).toHaveAttribute('aria-pressed', 'true');
    expect(minorCard).toHaveAttribute('aria-pressed', 'true');
    expect(getDefectTableRows(container)).toHaveLength(10);

    fireEvent.click(severeCard);

    expect(severeCard).toHaveAttribute('aria-pressed', 'false');
    const rowsWithoutSevere = getDefectTableRows(container);
    expect(rowsWithoutSevere).toHaveLength(8);
    expect(rowsWithoutSevere.every((row) => !row.endsWith('严重'))).toBe(true);

    fireEvent.click(severeCard);

    expect(severeCard).toHaveAttribute('aria-pressed', 'true');
    const restoredRows = getDefectTableRows(container);
    expect(restoredRows).toHaveLength(10);
    expect(restoredRows.some((row) => row.endsWith('严重'))).toBe(true);
    expect(restoredRows.some((row) => row.endsWith('轻微'))).toBe(true);
    expect(restoredRows.some((row) => row.endsWith('待复核'))).toBe(true);
  });
});
