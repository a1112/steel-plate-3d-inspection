import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { InspectionRecord, InspectionSummary, SteelPlate } from '../data/inspection';
import { fetchInspectionWorldMeta } from '../services/inspection-world-api';
import { emptyRecordSearchFilters, type RecordSearchFilters } from '../state/record-search';
import { LeftSidebar } from './LeftSidebar';

vi.mock('../services/inspection-world-api', () => ({
  fetchInspectionWorldMeta: vi.fn(),
}));

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

const manyRecords: InspectionRecord[] = Array.from({ length: 401 }, (_, index) => ({
  id: `R-${String(index + 1).padStart(4, '0')}`,
  time: `18:${String(index % 60).padStart(2, '0')}`,
  plateNo: `20260613${String(index).padStart(4, '0')}`,
  status: 'completed',
  defectCount: index % 9,
}));

const summary: InspectionSummary = {
  total: 12,
  bySeverity: { severe: 4, review: 3, minor: 5 },
  bySurface: { top: 5, bottom: 7 },
};

function SidebarHarness({
  runtimeMode = 'online',
  onRecordSelect = () => undefined,
  large = false,
  selectedPlate = plate,
  activeRecordStatus = 'completed',
  showDiameterSummary = false,
}: {
  runtimeMode?: 'online' | 'bkv';
  onRecordSelect?: (recordId: string) => void;
  large?: boolean;
  selectedPlate?: SteelPlate;
  activeRecordStatus?: InspectionRecord['status'];
  showDiameterSummary?: boolean;
}) {
  const [filters, setFilters] = useState<RecordSearchFilters>(emptyRecordSearchFilters);
  const sourceRecords = large ? manyRecords : records;
  const filteredRecords = sourceRecords.filter((record) => {
    if (filters.serialNo && !record.plateNo.includes(filters.serialNo)) {
      return false;
    }
    if (filters.plateNo && !record.id.includes(filters.plateNo)) {
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
      plate={selectedPlate}
      summary={summary}
      activeRecordStatus={activeRecordStatus}
      records={filteredRecords}
      selectedRecordId={plate.plateNo}
      searchFilters={filters}
      filteredCount={filteredRecords.length}
      totalCount={sourceRecords.length}
      diameterSummary={showDiameterSummary ? {
        qualified: true,
        validSectionCount: 28,
        requestedSectionCount: 30,
        fixedAngleCount: 6,
        minimumDiameterMm: 76.669,
        averageDiameterMm: 77.175,
        maximumDiameterMm: 78.116,
        maximumRoundnessMm: 1.709,
        fitResidualP95MaximumMm: 0.618,
        qualityNote: '无测速仪：横轴按软同步时间归一化，不输出伪长度',
      } : null}
      onRecordSelect={onRecordSelect}
      onSearchChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
      onSearchReset={() => setFilters(emptyRecordSearchFilters)}
    />
  );
}

describe('LeftSidebar', () => {
  it('does not report zero defects while the model result is still pending', () => {
    render(<SidebarHarness activeRecordStatus="detecting" />);

    expect(screen.getByText('缺陷检测中')).toBeInTheDocument();
    expect(screen.getByText('缺陷模型正在跟随流水号处理，结果尚未生成')).toBeInTheDocument();
    expect(screen.queryByText('当前钢管未检出缺陷')).not.toBeInTheDocument();
    const activeRow = screen.getAllByText('202606131900')
      .map((element) => element.closest('tr'))
      .find((row) => row !== null);
    expect(activeRow).toHaveTextContent('检测中');
  });

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

  it('shows the inspection serial number as its own record column', () => {
    render(<SidebarHarness />);

    expect(screen.getByRole('columnheader', { name: '流水号' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '板号' })).toBeInTheDocument();
    const row = screen.getByText('R-001').closest('tr');
    expect(row).toHaveTextContent('202606131900R-00119:00检测中检测中');
  });

  it('places the current diameter summary above the record query title', () => {
    render(<SidebarHarness showDiameterSummary />);

    const diameterSummary = screen.getByRole('status', { name: '当前记录测径摘要' });
    expect(diameterSummary.closest('.record-tools-stack')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: '查询' })).not.toBeInTheDocument();
    expect(diameterSummary).toHaveTextContent('计量有效');
    expect(diameterSummary).toHaveTextContent('28/30');
    expect(diameterSummary).toHaveTextContent('76.669');
    expect(diameterSummary).toHaveTextContent('77.175');
    expect(diameterSummary).toHaveTextContent('78.116');
    expect(diameterSummary).toHaveAttribute('title', expect.stringContaining('无测速仪'));
  });

  it('does not present missing dimensions as valid zero measurements', () => {
    render(<SidebarHarness selectedPlate={{ ...plate, widthMm: 0, lengthMm: 0, thicknessMm: 0 }} />);

    expect(screen.getAllByText('待录入')).toHaveLength(3);
    expect(screen.queryByText('0 mm')).not.toBeInTheDocument();
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

  it('selects a row by inspection id instead of the potentially duplicated plate number', () => {
    const onRecordSelect = vi.fn();
    render(<SidebarHarness onRecordSelect={onRecordSelect} />);

    fireEvent.click(screen.getByText('202606131858').closest('tr')!);

    expect(onRecordSelect).toHaveBeenCalledWith('R-002');
  });

  it('shows first-screen cache readiness in the BKV record hover card', async () => {
    vi.mocked(fetchInspectionWorldMeta).mockResolvedValue({
      cache: {
        state: 'on-demand',
        tileSize: 512,
        maxLevel: 3,
        firstScreenTiles: 6,
        cachedFirstScreenTiles: 6,
        firstScreenReady: true,
      },
    } as Awaited<ReturnType<typeof fetchInspectionWorldMeta>>);
    render(<SidebarHarness runtimeMode="bkv" />);

    fireEvent.mouseEnter(screen.getByText('202606131858').closest('tr')!);

    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('首屏已缓存 6/6'));
    expect(fetchInspectionWorldMeta).toHaveBeenCalledWith('R-002', expect.any(AbortSignal));
  });

  it('uses a right-side dropdown to switch record search condition', () => {
    render(<SidebarHarness />);

    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    fireEvent.change(screen.getByLabelText('查询条件'), { target: { value: 'plateNo' } });
    const input = screen.getByLabelText('板号查询');
    fireEvent.change(input, { target: { value: 'R-002' } });

    expect(screen.getByDisplayValue('R-002')).toBeInTheDocument();
    expect(screen.getByText('202606131858')).toBeInTheDocument();
    expect(screen.queryByText('检测中')).not.toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    const matchCount = screen.getByLabelText('记录数量 1');
    expect(matchCount).toHaveTextContent(/^1$/);
    expect(matchCount.closest('.records-panel .panel-header')).not.toBeNull();
    expect(matchCount.closest('.record-search-form')).toBeNull();
  });

  it('keeps query collapsed by default and exits it after selecting a result', () => {
    const onRecordSelect = vi.fn();
    render(<SidebarHarness onRecordSelect={onRecordSelect} />);

    expect(screen.getByRole('heading', { name: '记录' })).toBeInTheDocument();
    expect(screen.queryByLabelText('查询条件')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    expect(screen.getByLabelText('查询条件')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('流水号查询'), { target: { value: '1858' } });
    fireEvent.click(screen.getByText('R-002').closest('tr')!);

    expect(onRecordSelect).toHaveBeenCalledWith('R-002');
    expect(screen.queryByLabelText('查询条件')).not.toBeInTheDocument();
    expect(screen.getByText('R-001')).toBeInTheDocument();
  });

  it('identifies BKV records as coming from the standard offline store', () => {
    render(<SidebarHarness runtimeMode="bkv" />);

    expect(screen.getByText('来源：BKV 标准离线仓库')).toBeInTheDocument();
    expect(screen.queryByText('来源：旧 BKV 文件')).not.toBeInTheDocument();
  });

  it('loads the next record batch automatically when scrolling near the bottom', async () => {
    const { container } = render(<SidebarHarness large />);
    const tableWrap = container.querySelector('.records-table-wrap');
    expect(tableWrap).not.toBeNull();
    Object.defineProperties(tableWrap, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 8_000 },
      scrollTop: { configurable: true, value: 7_700 },
    });

    fireEvent.scroll(tableWrap!);

    await waitFor(() => expect(screen.getByRole('button', { name: /加载更多/ })).toHaveTextContent('已显示 100 / 401'));
  });
});
