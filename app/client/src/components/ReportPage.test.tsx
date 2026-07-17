import { fireEvent, render, screen } from '@testing-library/react';
import { ReportPage } from './ReportPage';

const noop = () => undefined;

function renderReport(printDisabled: boolean, onPrintArchive = vi.fn()) {
  return render(
    <ReportPage
      defectTypes={[]}
      inspections={[]}
      rows={[]}
      pageRows={[]}
      metrics={{ total: 0, severe: 0, review: 0, minor: 0, top: 0, bottom: 0, maxDepthMm: 0 }}
      metadata={{ reportId: 'RPT-INS-1', dataSource: '生产检测数据库', dataThrough: '', inspectionIds: ['INS-1'], materialIds: ['MAT-1'], recordCount: 0 }}
      filters={{ severity: 'all', surface: 'all', typeId: 'all', keyword: '' }}
      page={1}
      pageCount={1}
      selectedDefect={null}
      selectedDefectId={null}
      onFilterChange={noop}
      onReset={noop}
      onApply={noop}
      onPageChange={noop}
      onSelectDefect={noop}
      onExportCsv={noop}
      onExportJson={noop}
      onIssueArchive={noop}
      onPrintArchive={onPrintArchive}
      issueArchiveDisabled={false}
      printArchiveDisabled={printDisabled}
      archiveReports={printDisabled ? [] : [
        { reportId: 'RPT-INS-1-newest', inspectionId: 'INS-1', materialId: 'MAT-1', issuedAt: '2026-07-16 12:00:00', issuedBy: 'quality-user', documentSha256: 'newest' },
        { reportId: 'RPT-INS-1-older', inspectionId: 'INS-1', materialId: 'MAT-1', issuedAt: '2026-07-15 12:00:00', issuedBy: 'quality-user', documentSha256: 'older' },
      ]}
      archiveStatus=""
    />,
  );
}

describe('ReportPage immutable print action', () => {
  it('requires an archive and delegates printing only when a verified archive can be loaded', () => {
    const disabled = renderReport(true);
    expect(screen.getByRole('button', { name: '打印版' })).toBeDisabled();
    disabled.unmount();

    const onPrintArchive = vi.fn();
    renderReport(false, onPrintArchive);
    fireEvent.change(screen.getByRole('combobox', { name: '归档版本' }), {
      target: { value: 'RPT-INS-1-older' },
    });
    fireEvent.click(screen.getByRole('button', { name: '打印版' }));
    expect(onPrintArchive).toHaveBeenCalledTimes(1);
    expect(onPrintArchive).toHaveBeenCalledWith(expect.objectContaining({ reportId: 'RPT-INS-1-older' }));
  });
});
