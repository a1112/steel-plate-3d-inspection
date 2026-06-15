import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

function getDefectTableRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.defect-table tbody tr')).map((row) => row.textContent?.trim() ?? '');
}

describe('App online severity filters', () => {
  it('filters the online defect list from the statistics severity cards', () => {
    const { container } = render(<App />);

    const severeCard = screen.getByRole('button', { name: '严重等级过滤，当前4项' });
    expect(severeCard).toHaveAttribute('aria-pressed', 'false');
    expect(getDefectTableRows(container)).toHaveLength(10);

    fireEvent.click(severeCard);

    expect(severeCard).toHaveAttribute('aria-pressed', 'true');
    const severeRows = getDefectTableRows(container);
    expect(severeRows).toHaveLength(4);
    expect(severeRows.every((row) => row.endsWith('严重'))).toBe(true);

    fireEvent.click(severeCard);

    expect(severeCard).toHaveAttribute('aria-pressed', 'false');
    const restoredRows = getDefectTableRows(container);
    expect(restoredRows).toHaveLength(10);
    expect(restoredRows.some((row) => row.endsWith('轻微'))).toBe(true);
    expect(restoredRows.some((row) => row.endsWith('待复核'))).toBe(true);
  });
});
