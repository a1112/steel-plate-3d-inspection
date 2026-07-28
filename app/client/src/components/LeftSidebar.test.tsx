import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { InspectionRecord, InspectionSummary, SteelPlate } from '../data/inspection';
import { emptyRecordSearchFilters, type RecordSearchFilters } from '../state/record-search';
import { LeftSidebar } from './LeftSidebar';

const plate: SteelPlate = {
  plateNo: '202606131900',
  widthMm: 691.6292254800729,
  lengthMm: 12748.696640014648,
  thicknessMm: 12.4,
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

function SidebarHarness({ runtimeMode = 'online' }: { runtimeMode?: 'online' | 'bkv' }) {
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
      runtimeMode={runtimeMode}
      plate={plate}
      summary={summary}
      records={filteredRecords}
      selectedRecordId={plate.plateNo}
      searchFilters={filters}
      filteredCount={filteredRecords.length}
      totalCount={records.length}
      onRecordSelect={() => undefined}
      onSearchChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
      onSearchReset={() => setFilters(emptyRecordSearchFilters)}
    />
  );
}

describe('LeftSidebar', () => {
  it('shows steel information without a redundant panel heading', () => {
    render(<SidebarHarness />);

    expect(screen.queryByRole('heading', { name: '钢管信息' })).not.toBeInTheDocument();
    expect(screen.getByText('钢管号:')).toBeInTheDocument();
    expect(screen.getByText('Q355B')).toBeInTheDocument();
    expect(screen.getByText('692 mm')).toBeInTheDocument();
    expect(screen.getByText('12749 mm')).toBeInTheDocument();
    expect(screen.getByText('12 mm')).toBeInTheDocument();
    expect(screen.queryByText(/691\\.629|12748\\.696|12\\.4/)).not.toBeInTheDocument();
  });

  it('shows record details beside the table while a row is hovered', () => {
    render(<SidebarHarness />);

    const row = screen.getByText('202606131858').closest('tr');
    expect(row).not.toBeNull();
    fireEvent.mouseEnter(row!);

    expect(screen.getByRole('tooltip')).toHaveTextContent('202606131858');
    expect(screen.getByRole('tooltip')).toHaveTextContent('8');
    fireEvent.mouseLeave(row!);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('uses a right-side dropdown to switch record search condition', () => {
    render(<SidebarHarness />);

    fireEvent.change(screen.getByLabelText('查询条件'), { target: { value: 'plateNo' } });
    const input = screen.getByLabelText('钢管号查询');
    fireEvent.change(input, { target: { value: '1858' } });

    expect(screen.getByDisplayValue('1858')).toBeInTheDocument();
    expect(screen.getByText('202606131858')).toBeInTheDocument();
    expect(screen.queryByText('检测中')).not.toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    const matchCount = screen.getByText(
      (_, element) => element?.classList.contains('record-search-count') === true && element.textContent === '匹配 1 / 2',
    );
    expect(matchCount.closest('.records-panel .panel-header')).not.toBeNull();
    expect(matchCount.closest('.record-search-form')).toBeNull();
  });

  it('identifies BKV records as coming from the standard offline store', () => {
    render(<SidebarHarness runtimeMode="bkv" />);

    expect(screen.getByText('来源：BKV 标准离线仓库')).toBeInTheDocument();
    expect(screen.queryByText('来源：旧 BKV 文件')).not.toBeInTheDocument();
  });
});
