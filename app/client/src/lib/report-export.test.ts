import { exportInspectionArchiveAsPrintableHtml } from './report-export';

describe('immutable report printable export', () => {
  it('renders every archived defect, trace identity, evidence references, and escapes data', () => {
    const html = exportInspectionArchiveAsPrintableHtml({
      schema: 'steel.inspection.report-archive.v1',
      reportId: 'RPT-INS-1-abc123',
      inspectionId: 'INS-1',
      materialId: 'MAT-<1>',
      issuedAt: '2026-07-16 12:00:00',
      issuedBy: 'quality-user',
      documentSha256: 'abc123',
      document: {
        schema: 'steel.inspection.report.v1',
        inspectionId: 'INS-1',
        record: {
          id: 'INS-1',
          materialId: 'MAT-<1>',
          defectCount: 2,
          plate: { steelGrade: 'Q235', widthMm: 1000, lengthMm: 6000, thicknessMm: 12 },
          algorithmTrace: {
            algorithmName: 'bar-surface',
            algorithmVersion: '1.2.3',
            configRevision: 'CFG-1',
            configSha256: 'cfg-sha',
            qualityGate: { passed: true, reasons: [] },
          },
          defects: [
            { id: 'DEF-1', typeLabel: '凹陷候选', cameraId: 'camera1', classificationState: 'candidate-only', detectionConfidence: 0.91, artifacts: { frameId: 'F-1', sequenceNo: 1, roi: { x: 1, y: 2, width: 3, height: 4 }, roiImage: 'defects/DEF-1/roi.png' } },
            { id: 'DEF-2', typeLabel: '<script>alert(1)</script>', cameraId: 'camera2', artifacts: { frameId: 'F-2', localPointCloud: 'defects/DEF-2/points.json' } },
          ],
        },
      },
    });

    expect(html).toContain('RPT-INS-1-abc123');
    expect(html).toContain('文档 SHA-256：abc123');
    expect(html).toContain('DEF-1');
    expect(html).toContain('DEF-2');
    expect(html).toContain('defects/DEF-1/roi.png');
    expect(html).toContain('defects/DEF-2/points.json');
    expect(html).toContain('bar-surface / 1.2.3');
    expect(html).toContain('候选待复核');
    expect(html).toContain('候选检测置信度');
    expect(html).toContain('MAT-&lt;1&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('@page { size: A4 landscape;');
  });
});
