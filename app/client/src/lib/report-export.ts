import type { InspectionReportArchive } from '../services/inspection-api';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = '--'): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return fallback;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fixed(value: unknown, digits = 2): string {
  const parsed = number(value);
  return parsed === null ? '--' : parsed.toFixed(digits);
}

export function escapeReportHtml(value: unknown): string {
  return text(value, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function field(label: string, value: unknown): string {
  return `<div><dt>${escapeReportHtml(label)}</dt><dd>${escapeReportHtml(value)}</dd></div>`;
}

function artifactSummary(defect: JsonObject): string {
  const artifacts = object(defect.artifacts);
  if (!Object.keys(artifacts).length) return '--';
  const roi = object(artifacts.roi);
  const source = object(artifacts.sourceFrame);
  return [
    `frame=${text(artifacts.frameId)}`,
    `seq=${text(artifacts.sequenceNo)}`,
    `roi=${text(roi.x)},${text(roi.y)},${text(roi.width)}x${text(roi.height)}`,
    `intensity=${text(source.intensity)}`,
    `depth=${text(source.depth)}`,
    `roiImage=${text(artifacts.roiImage)}`,
    `points=${text(artifacts.localPointCloud)}`,
    `profiles=${text(artifacts.lengthProfile)} | ${text(artifacts.widthProfile)}`,
  ].join('\n');
}

function defectRows(defects: unknown[]): string {
  if (!defects.length) {
    return '<tr><td colspan="13" class="empty">本次归档没有缺陷记录</td></tr>';
  }
  return defects.map((value, index) => {
    const defect = object(value);
    return `<tr>
      <td>${index + 1}</td>
      <td>${escapeReportHtml(defect.id)}</td>
      <td>${escapeReportHtml(defect.typeLabel ?? defect.typeId)}</td>
      <td>${escapeReportHtml(defect.severity)}</td>
      <td>${escapeReportHtml(defect.cameraId)}</td>
      <td>${escapeReportHtml(defect.distanceHeadMm)}</td>
      <td>${escapeReportHtml(defect.operatorSideMm)}</td>
      <td>${escapeReportHtml(defect.driveSideMm)}</td>
      <td>${fixed(defect.widthMm)} × ${fixed(defect.heightMm)}</td>
      <td>${fixed(defect.depthMm)}</td>
      <td>${escapeReportHtml(defect.classificationState === 'candidate-only' ? '候选待复核' : defect.classificationState)}</td>
      <td>${fixed(defect.detectionConfidence ?? defect.confidence, 4)}</td>
      <td class="evidence">${escapeReportHtml(artifactSummary(defect))}</td>
    </tr>`;
  }).join('');
}

export function exportInspectionArchiveAsPrintableHtml(archive: InspectionReportArchive): string {
  const document = object(archive.document);
  const record = object(document.record);
  const plate = object(record.plate);
  const severity = object(record.severity);
  const trace = object(record.algorithmTrace);
  const qualityGate = object(trace.qualityGate);
  const defects = array(record.defects);
  const specification = [plate.widthMm, plate.lengthMm, plate.thicknessMm]
    .map((value) => fixed(value))
    .join(' × ');
  const title = `钢材表面缺陷检测报告 ${archive.reportId}`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeReportHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; color: #17243a; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #eef2f7; }
    .toolbar { position: sticky; top: 0; display: flex; justify-content: flex-end; padding: 12px 24px; background: #17243a; }
    button { border: 0; border-radius: 4px; padding: 9px 18px; color: white; background: #1769e0; font-weight: 700; cursor: pointer; }
    main { width: min(1500px, calc(100% - 32px)); margin: 20px auto; padding: 28px; background: white; box-shadow: 0 4px 24px #17243a1f; }
    header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 3px solid #1769e0; padding-bottom: 16px; }
    h1 { margin: 4px 0 0; font-size: 27px; }
    h2 { margin: 24px 0 10px; font-size: 17px; }
    .eyebrow, .muted { color: #607089; font-size: 12px; }
    .identity { min-width: 440px; font-size: 12px; line-height: 1.7; word-break: break-all; }
    dl { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; margin: 12px 0; background: #ccd5e2; border: 1px solid #ccd5e2; }
    dl div { min-width: 0; padding: 9px 11px; background: white; }
    dt { color: #607089; font-size: 11px; }
    dd { margin: 4px 0 0; font-size: 13px; font-weight: 700; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 10px; }
    th, td { border: 1px solid #bac5d4; padding: 6px; vertical-align: top; overflow-wrap: anywhere; }
    th { background: #eaf1fb; text-align: left; }
    th:nth-child(1) { width: 34px; } th:nth-child(2) { width: 110px; } th:nth-child(3) { width: 75px; }
    th:nth-child(4), th:nth-child(5) { width: 65px; } th:nth-child(n+6):nth-child(-n+12) { width: 68px; }
    .evidence { white-space: pre-line; font-family: Consolas, monospace; font-size: 8px; }
    .empty { padding: 24px; text-align: center; color: #607089; }
    .signatures { display: grid; grid-template-columns: repeat(3, 1fr); gap: 36px; margin-top: 34px; }
    .signatures div { border-top: 1px solid #17243a; padding-top: 8px; color: #607089; font-size: 12px; }
    footer { margin-top: 22px; padding-top: 10px; border-top: 1px solid #ccd5e2; color: #607089; font-size: 10px; word-break: break-all; }
    @page { size: A4 landscape; margin: 10mm; }
    @media print {
      body { background: white; }
      .toolbar { display: none; }
      main { width: auto; margin: 0; padding: 0; box-shadow: none; }
      header, dl, tr { break-inside: avoid; }
      thead { display: table-header-group; }
      h2 { break-after: avoid; }
    }
  </style>
</head>
<body>
  <div class="toolbar"><button type="button" onclick="window.print()">打印 / 保存为 PDF</button></div>
  <main>
    <header>
      <div><div class="eyebrow">钢材 3D 表面检测系统 · 不可变归档打印件</div><h1>钢材表面缺陷检测报告</h1></div>
      <div class="identity">
        <strong>${escapeReportHtml(archive.reportId)}</strong><br>
        签发：${escapeReportHtml(archive.issuedAt)} / ${escapeReportHtml(archive.issuedBy)}<br>
        文档 SHA-256：${escapeReportHtml(archive.documentSha256)}
      </div>
    </header>

    <h2>检测对象与结果摘要</h2>
    <dl>
      ${field('检测记录', record.id ?? archive.inspectionId)}
      ${field('材料编号', record.materialId ?? archive.materialId)}
      ${field('生产状态', record.productionStatus ?? record.status)}
      ${field('检测完成时间', record.finishedAt)}
      ${field('钢种', plate.steelGrade)}
      ${field('规格（宽 × 长 × 厚，mm）', specification)}
      ${field('缺陷总数', record.defectCount ?? defects.length)}
      ${field('严重 / 复核 / 轻微', `${text(severity.severe, '0')} / ${text(severity.review, '0')} / ${text(severity.minor, '0')}`)}
    </dl>

    <h2>算法与质量追溯</h2>
    <dl>
      ${field('算法', `${text(trace.algorithmName)} / ${text(trace.algorithmVersion)}`)}
      ${field('配置版本', `${text(trace.configRevision)} / ${text(trace.configSha256)}`)}
      ${field('标定版本', `${text(trace.calibrationRevision)} / ${text(trace.calibrationSha256)}`)}
      ${field('发布提交', trace.releaseCommit)}
      ${field('数据集', `${text(trace.datasetRevision)} / ${text(trace.datasetSha256)}`)}
      ${field('评测器', `${text(trace.evaluatorRevision)} / ${text(trace.evaluatorSha256)}`)}
      ${field('输入摘要', trace.inputSummarySha256)}
      ${field('质量门禁', `${text(qualityGate.passed)}；${array(qualityGate.reasons).map((value) => text(value)).join('；') || '无附加原因'}`)}
    </dl>

    <h2>缺陷明细与证据索引（${defects.length} 项）</h2>
    <table>
      <thead><tr><th>#</th><th>缺陷编号</th><th>类型</th><th>等级</th><th>相机</th><th>距头 mm</th><th>操作侧 mm</th><th>传动侧 mm</th><th>宽 × 高 mm</th><th>深度 mm</th><th>分类状态</th><th>候选检测置信度</th><th>源帧 / ROI / 点云 / 剖面</th></tr></thead>
      <tbody>${defectRows(defects)}</tbody>
    </table>

    <div class="signatures"><div>检测人员签字 / 日期</div><div>质量复核签字 / 日期</div><div>批准人员签字 / 日期</div></div>
    <footer>
      本打印件由不可变归档 ${escapeReportHtml(archive.reportId)} 生成；归档文档哈希为 ${escapeReportHtml(archive.documentSha256)}。证据索引用于回查原始帧、ROI、局部点云和高度剖面，不替代原始归档文件。
    </footer>
  </main>
</body>
</html>`;
}
