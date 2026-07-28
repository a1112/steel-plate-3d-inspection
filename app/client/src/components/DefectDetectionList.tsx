import { Filter } from 'lucide-react';
import { useState, type ChangeEvent, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { DefectItem } from '../data/inspection';
import { getDefectPreviewImage, severityLabels, surfaceLabels } from '../data/inspection';
import { barSurfaceFileUrl } from '../services/bar-surface-api';
import { inspectionWorldFrameUrl } from '../services/inspection-world-api';
import type { ReportFilters } from '../state/operations';
import { Panel } from './Panel';

const DEFECT_POPOVER_WIDTH = 330;
const DEFECT_POPOVER_HEIGHT = 318;
const DEFECT_POPOVER_GAP = 10;

interface DefectDetectionListProps {
  defects: DefectItem[];
  inspectionId?: string;
  selectedDefectId: string | null;
  filters: ReportFilters;
  filterOpen: boolean;
  onSelectDefect: (defectId: string) => void;
  onToggleFilter: () => void;
  onFilterChange: (patch: Partial<ReportFilters>) => void;
  onClearFilters: () => void;
}

function getDefectCameraLabel(defect: DefectItem) {
  if (typeof defect.cameraIndex === 'number' && defect.cameraIndex >= 1 && defect.cameraIndex <= 8) {
    return `camera${Math.round(defect.cameraIndex)}`;
  }
  const cameraMatch = defect.cameraId?.match(/(?:camera|cam)\s*([1-8])/i);
  if (cameraMatch) {
    return `camera${cameraMatch[1]}`;
  }
  const span = defect.operatorSideMm + defect.driveSideMm;
  const ratio = typeof defect.circumferenceRatio === 'number'
    ? defect.circumferenceRatio
    : span > 0 ? defect.operatorSideMm / span : (defect.yOffsetMm + 1.5) / 3;
  const cameraIndex = Math.max(0, Math.min(7, Math.floor(Math.max(0, Math.min(0.999, ratio)) * 8)));
  return `camera${cameraIndex + 1}`;
}

function getDefectPreview(defect: DefectItem, inspectionId?: string) {
  const cameraId = defect.cameraIndex;
  const sequenceNo = defect.artifacts?.sequenceNo;
  if (inspectionId && cameraId && sequenceNo != null) {
    return {
      url: inspectionWorldFrameUrl(inspectionId, cameraId, sequenceNo, defect.artifacts?.roi),
      source: defect.artifacts?.roi.width && defect.artifacts.roi.height
        ? '检测记录 ROI 裁剪'
        : '检测记录原始帧',
    };
  }
  if (defect.previewImageUrl) {
    return { url: defect.previewImageUrl, source: defect.synthetic ? '模拟算法产物' : '检测记录预览' };
  }
  if (defect.artifacts?.roiImage) {
    return { url: barSurfaceFileUrl(defect.artifacts.roiImage), source: '生产 ROI 产物' };
  }
  if (import.meta.env.DEV) {
    return { url: getDefectPreviewImage(defect.typeId), source: '开发模拟图 · 非生产产物' };
  }
  return { url: '', source: '暂无图像产物' };
}

function getDefectConfidence(defect: DefectItem) {
  const confidence = defect.classificationConfidence ?? defect.detectionConfidence ?? defect.confidence;
  return typeof confidence === 'number' ? `${(confidence * 100).toFixed(1)}%` : '--';
}

function DefectListHoverCard({
  defect,
  top,
  left,
  inspectionId,
}: {
  defect: DefectItem;
  top: number;
  left: number;
  inspectionId?: string;
}) {
  const preview = getDefectPreview(defect, inspectionId);
  const style = {
    top,
    left,
  } as CSSProperties;

  return (
    <aside
      id={`defect-list-hover-${defect.id}`}
      className="defect-list-hover-card"
      role="tooltip"
      style={style}
      data-testid="defect-list-hover-card"
    >
      <header>
        <div>
          <span>缺陷详情</span>
          <strong>{defect.typeLabel}</strong>
        </div>
        <em className={defect.severity}>{severityLabels[defect.severity]}</em>
      </header>
      <figure className={preview.url ? '' : 'is-empty'}>
        {preview.url ? <img src={preview.url} alt={`${defect.typeLabel}缺陷图像`} /> : <span>暂无缺陷 ROI 图像</span>}
        <figcaption>
          <b>{getDefectCameraLabel(defect)}</b>
          <span>{preview.source}</span>
        </figcaption>
      </figure>
      <dl>
        <div><dt>缺陷编号</dt><dd title={defect.id}>{defect.id}</dd></div>
        <div><dt>钢管号</dt><dd>{defect.plateNo}</dd></div>
        <div><dt>表面</dt><dd>{surfaceLabels[defect.surface]}</dd></div>
        <div><dt>置信度</dt><dd>{getDefectConfidence(defect)}</dd></div>
        <div className="wide"><dt>尺寸</dt><dd>{defect.widthMm.toFixed(2)} × {defect.heightMm.toFixed(2)} × {Math.abs(defect.depthMm).toFixed(2)}mm</dd></div>
        <div><dt>距头</dt><dd>{defect.distanceHeadMm}mm</dd></div>
        <div><dt>深度</dt><dd>{defect.depthMm.toFixed(2)}mm</dd></div>
        <div><dt>距操作侧</dt><dd>{defect.operatorSideMm}mm</dd></div>
        <div><dt>距传动侧</dt><dd>{defect.driveSideMm}mm</dd></div>
        <div className="wide"><dt>识别状态</dt><dd>{defect.classificationState === 'candidate-only' ? '候选待分类' : '已分类'}{defect.classificationVersion ? ` · ${defect.classificationVersion}` : ''}</dd></div>
      </dl>
    </aside>
  );
}

export function DefectDetectionList({
  defects,
  inspectionId,
  selectedDefectId,
  filters,
  filterOpen,
  onSelectDefect,
  onToggleFilter,
  onFilterChange,
  onClearFilters,
}: DefectDetectionListProps) {
  const [hoveredDefect, setHoveredDefect] = useState<{
    defect: DefectItem;
    top: number;
    left: number;
  } | null>(null);

  const handleSelect = (event: ChangeEvent<HTMLSelectElement>, key: 'severity') => {
    onFilterChange({ [key]: event.target.value } as Partial<ReportFilters>);
  };

  const showDefectDetails = (defect: DefectItem, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const opensLeft = rect.left >= DEFECT_POPOVER_WIDTH + DEFECT_POPOVER_GAP + 12;
    const left = opensLeft
      ? rect.left - DEFECT_POPOVER_WIDTH - DEFECT_POPOVER_GAP
      : Math.min(window.innerWidth - DEFECT_POPOVER_WIDTH - 12, rect.right + DEFECT_POPOVER_GAP);
    const top = Math.max(
      54,
      Math.min(rect.top - 16, window.innerHeight - DEFECT_POPOVER_HEIGHT - 44),
    );
    setHoveredDefect({ defect, top, left: Math.max(12, left) });
  };

  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, defect: DefectItem) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectDefect(defect.id);
    } else if (event.key === 'Escape') {
      setHoveredDefect(null);
      event.currentTarget.blur();
    }
  };

  return (
    <Panel
      title="缺陷检测列表"
      className="defect-list-panel"
      action={
        <button type="button" className={`icon-filter ${filterOpen ? 'active' : ''}`} title="筛选" onClick={onToggleFilter}>
          <Filter size={17} />
        </button>
      }
    >
      {filterOpen ? (
        <div className="inline-filter">
          <input value={filters.keyword} onChange={(event) => onFilterChange({ keyword: event.target.value })} placeholder="钢管号 / 缺陷 / 距离" />
          <select value={filters.severity} onChange={(event) => handleSelect(event, 'severity')}>
            <option value="all">全部等级</option>
            <option value="severe">严重</option>
            <option value="review">待复核</option>
            <option value="minor">轻微</option>
          </select>
          <button type="button" onClick={onClearFilters}>
            清空
          </button>
        </div>
      ) : null}
      <div className="defect-table-wrap">
        <table className="defect-table">
          <thead>
            <tr>
              <th>序号</th>
              <th>缺陷类别</th>
              <th>相机</th>
              <th>距头距离</th>
              <th>等级</th>
            </tr>
          </thead>
          <tbody>
            {defects.length > 0 ? (
              defects.map((defect, index) => (
                <tr
                  key={defect.id}
                  className={defect.id === selectedDefectId ? 'selected' : ''}
                  tabIndex={0}
                  aria-label={`${defect.typeLabel}，${getDefectCameraLabel(defect)}，距头${defect.distanceHeadMm}mm，${severityLabels[defect.severity]}`}
                  aria-describedby={hoveredDefect?.defect.id === defect.id ? `defect-list-hover-${defect.id}` : undefined}
                  onClick={() => onSelectDefect(defect.id)}
                  onMouseEnter={(event) => showDefectDetails(defect, event.currentTarget)}
                  onMouseLeave={() => setHoveredDefect(null)}
                  onFocus={(event) => showDefectDetails(defect, event.currentTarget)}
                  onBlur={() => setHoveredDefect(null)}
                  onKeyDown={(event) => handleRowKeyDown(event, defect)}
                >
                  <td>{String(index + 1).padStart(2, '0')}</td>
                  <td>
                    {defect.typeLabel}
                    {defect.classificationState === 'candidate-only' ? <small className="candidate-defect-badge">候选</small> : null}
                    {defect.synthetic ? <small className="synthetic-defect-badge">模拟</small> : null}
                  </td>
                  <td>{getDefectCameraLabel(defect)}</td>
                  <td>{defect.distanceHeadMm}mm</td>
                  <td className={defect.severity}>{severityLabels[defect.severity]}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="empty-cell">
                  当前筛选条件下无记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {hoveredDefect && typeof document !== 'undefined'
        ? createPortal(
          <DefectListHoverCard
            defect={hoveredDefect.defect}
            top={hoveredDefect.top}
            left={hoveredDefect.left}
            inspectionId={inspectionId}
          />,
          document.body,
        )
        : null}
    </Panel>
  );
}
