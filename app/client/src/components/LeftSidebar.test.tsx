import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { InspectionRecord, InspectionSummary, SteelPlate } from '../data/inspection';
import { emptyRecordSearchFilters, type RecordSearchFilters } from '../state/record-search';
import { LeftSidebar } from './LeftSidebar';

const plate: SteelPlate = {
  plateNo: '202606131900',
  widthMm: 3500,
  lengthMm: 12000,
  thicknessMm: 12,
  steelGrade: 'Q355B',
  detectedAt: '2026-06-13 19:00',
};

const records: InspectionRecord[] = [
  { id: 'R-001', time: '19:00', plateNo: '202606131900', status: 'detecting', defectCount: 12 },
  { id: 'R-002', time: '18:42', plateNo: '202606131858', status: 'completed', defectCount: 8 },
];

const summary: InspectionSummary = {
  total: 12,
  bySeverity: { severe: 4, review: 3, minor: 5 },
  bySurface: { top: 5, bottom: 7 },
};

function SidebarHarness() {
  const [filters, setFilters] = useState<RecordSearchFilters>(emptyRecordSearchFilters);
  const filteredRecords = records.filter((record) => {
    if (filters.serialNo && !record.id.includes(filters.serialNo)) {
      return false;
    }
    if (filters.plateNo && !record.plateNo.includes(filters.plateNo)) {
      return false;
    }
    if (filters.time && !record.time.includes(filters.time)) {
      return false;
    }
    return true;
  });

  return (
    <LeftSidebar
      plate={plate}
      summary={summary}
      records={filteredRecords}
      selectedRecordId={plate.plateNo}
      page={1}
      pageCount={1}
      searchFilters={filters}
      filteredCount={filteredRecords.length}
      totalCount={records.length}
      onPageChange={() => undefined}
      onRecordSelect={() => undefined}
      onSearchChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
      onSearchReset={() => setFilters(emptyRecordSearchFilters)}
    />
  );
}

describe('LeftSidebar', () => {
  it('uses a right-side dropdown to switch record search condition', () => {
    render(<SidebarHarness />);

    fireEvent.change(screen.getByLabelText('查询条件'), { target: { value: 'plateNo' } });
    const input = screen.getByLabelText('钢管号查询');
    fireEvent.change(input, { target: { value: '1858' } });

    expect(screen.getByDisplayValue('1858')).toBeInTheDocument();
    expect(screen.getByText('202606131858')).toBeInTheDocument();
    expect(screen.queryByText('检测中')).not.toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.classList.contains('record-search-count') === true && element.textContent === '匹配 1 / 2'),
    ).toBeInTheDocument();
  });
});
