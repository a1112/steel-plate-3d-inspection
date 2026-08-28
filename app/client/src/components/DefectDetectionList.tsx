import { Filter, List, Map as MapIcon } from 'lucide-react';
import { useState, type ChangeEvent, type CSSProperties, type KeyboardEvent, type WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import type { DefectItem, DefectType } from '../data/inspection';
import { getDefectPreviewImage, severityLabels, surfaceLabels } from '../data/inspection';
import { barSurfaceFileUrl } from '../services/bar-surface-api';
import { bkvOnlineCroppedImageUrl, isBkvOnlineImageUrl } from '../services/bkv-online-api';
import { inspectionWorldFrameUrl } from '../services/inspection-world-api';
import type { ReportFilters } from '../state/operations';
import { Panel } from './Panel';
import { RequestedSizeImage } from './RequestedSizeImage';

const DEFECT_POPOVER_WIDTH = 330;
const DEFECT_POPOVER_HEIGHT = 318;
const DEFECT_POPOVER_GAP = 10;

interface DefectDetectionListProps {
  defects: DefectItem[];
  defectTypes?: DefectType[];
  pipeLengthMm?: number;
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

function explicitRoiArtifactUrl(value: string | undefined) {
  const source = value?.trim() ?? '';
  if (!source || isBkvOnlineImageUrl(source)) return '';
  return /^(?:https?:|data:|blob:)/i.test(source) || source.startsWith('/')
    ? source
    : barSurfaceFileUrl(source);
}

function getDefectPreview(defect: DefectItem, inspectionId?: string) {
  const cameraId = defect.cameraIndex;
  const sequenceNo = defect.artifacts?.sequenceNo;
  const roi = defect.artifacts?.roi;
  const roiImage = defect.artifacts?.roiImage;
  const previewImage = defect.previewImageUrl?.trim() ?? '';

  const explicitRoiImage = explicitRoiArtifactUrl(roiImage);
  if (explicitRoiImage) {
    return { url: explicitRoiImage, source: '生产 ROI 产物' };
  }

  const bkvRoiImage = bkvOnlineCroppedImageUrl(roiImage, roi);
  if (bkvRoiImage) {
    return { url: bkvRoiImage, source: 'BKV 缺陷 ROI 裁剪' };
  }

  if (previewImage && !isBkvOnlineImageUrl(previewImage)) {
    return { url: previewImage, source: defect.synthetic ? '模拟算法产物' : '检测记录缺陷小图' };
  }

  const bkvPreview = bkvOnlineCroppedImageUrl(previewImage, roi);
  if (bkvPreview) {
    return { url: bkvPreview, source: 'BKV 缺陷 ROI 裁剪' };
  }

  const bkvSourceFrame = bkvOnlineCroppedImageUrl(defect.artifacts?.sourceFrame?.intensity, roi);
  if (bkvSourceFrame) {
    return { url: bkvSourceFrame, source: 'BKV 缺陷 ROI 裁剪' };
  }

  if (inspectionId && cameraId && sequenceNo != null) {
    const worldRoiImage = inspectionWorldFrameUrl(inspectionId, cameraId, sequenceNo, roi);
    if (worldRoiImage) return { url: worldRoiImage, source: '检测记录 ROI 裁剪' };
  }

  if (defect.synthetic && import.meta.env.DEV) {
    return { url: getDefectPreviewImage(defect.typeId), source: '开发模拟图 · 非生产产物' };
  }
  return { url: '', source: '算法 ROI 小图未就绪' };
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
        {preview.url ? <RequestedSizeImage
          src={preview.url}
          alt={`${defect.typeLabel}缺陷图像`}
          requestWidth={330}
          requestHeight={176}
        /> : <span>{preview.source}</span>}
        <figcaption>
          <b>{getDefectCameraLabel(defect)}</b>
          {preview.url ? <span>{preview.source}</span> : null}
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
  defectTypes = [],
  pipeLengthMm = 0,
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
  const [displayMode, setDisplayMode] = useState<'list' | 'distribution'>('distribution');
  const distributionLengthMm = pipeLengthMm > 0
    ? pipeLengthMm
    : Math.max(0, ...defects.map((defect) => defect.distanceHeadMm));
  const lengthTicks = distributionLengthMm > 0
    ? Array.from({ length: 5 }, (_, index) => ({
        ratio: index / 4,
        value: Math.round(distributionLengthMm * index / 4),
      }))
    : [{ ratio: 0, value: 0 }];
  const defectColorByType = new Map(defectTypes.map((type) => [type.id, type.color]));

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

  const handleDistributionWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!defects.length || event.deltaY === 0) return;
    event.preventDefault();
    const selectedIndex = defects.findIndex((defect) => defect.id === selectedDefectId);
    const direction = event.deltaY > 0 ? 1 : -1;
    const nextIndex = selectedIndex < 0
      ? direction > 0 ? 0 : defects.length - 1
      : (selectedIndex + direction + defects.length) % defects.length;
    setHoveredDefect(null);
    onSelectDefect(defects[nextIndex].id);
  };

  return (
    <Panel
      title="缺陷检测列表"
      className={`defect-list-panel display-mode-${displayMode}`}
      bodyStyle={displayMode === 'distribution' ? { padding: 0 } : undefined}
      action={
        <div className="defect-list-actions">
          <div className="defect-list-view-switch" role="group" aria-label="缺陷列表显示方式">
            <button type="button" className={displayMode === 'list' ? 'active' : ''} aria-pressed={displayMode === 'list'} title="列表" onClick={() => setDisplayMode('list')}><List size={15} /></button>
            <button type="button" className={displayMode === 'distribution' ? 'active' : ''} aria-pressed={displayMode === 'distribution'} title="分布图" onClick={() => setDisplayMode('distribution')}><MapIcon size={15} /></button>
          </div>
          <button type="button" className={`icon-filter ${filterOpen ? 'active' : ''}`} title="筛选" onClick={onToggleFilter}>
            <Filter size={17} />
          </button>
        </div>
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
      {displayMode === 'distribution' ? (
        <div className="defect-distribution" role="img" aria-label={`缺陷分布图，共 ${defects.length} 个缺陷`}>
          <div className="defect-distribution-camera-axis" aria-label="相机区域 C1 至 C6">
            {Array.from({ length: 6 }, (_, index) => <span key={index}>C{index + 1}</span>)}
          </div>
          <div className="defect-distribution-length-ruler" aria-label={`钢管长度刻度，0.0 至 ${(distributionLengthMm / 1_000).toFixed(1)} 米`}>
            {lengthTicks.map((tick) => (
              <span
                key={tick.ratio}
                className={tick.ratio === 0 ? 'first' : tick.ratio === 1 ? 'last' : ''}
                style={{ '--tick-position': `${tick.ratio * 100}%` } as CSSProperties}
              >
                <i aria-hidden="true" />
                <b>{(tick.value / 1_000).toFixed(1)} m</b>
              </span>
            ))}
          </div>
          <div className="defect-distribution-pipe" onWheel={handleDistributionWheel}>
            <div className="defect-distribution-camera-regions" aria-hidden="true">
              {Array.from({ length: 6 }, (_, index) => <span key={index} />)}
            </div>
            <div className="defect-distribution-length-guides" aria-hidden="true">
              {lengthTicks.slice(1, -1).map((tick) => (
                <i key={tick.ratio} style={{ top: `${tick.ratio * 100}%` }} />
              ))}
            </div>
            {defects.map((defect, index) => {
              const lengthRatio = Number.isFinite(defect.xRatio)
                ? defect.xRatio
                : defects.length > 1 ? index / (defects.length - 1) : 0.5;
              const cameraLabel = getDefectCameraLabel(defect);
              const cameraIndex = Number(cameraLabel.replace('camera', '')) || 1;
              const cameraRegionRatio = (Math.max(1, Math.min(6, cameraIndex)) - 0.5) / 6;
              return <button
                key={defect.id}
                type="button"
                className={`defect-distribution-marker ${defect.severity}${defect.id === selectedDefectId ? ' selected' : ''}`}
                style={{
                  left: `${cameraRegionRatio * 100}%`,
                  top: `${Math.max(1.5, Math.min(98.5, lengthRatio * 100))}%`,
                  '--defect-type-color': defectColorByType.get(defect.typeId) ?? '#64748b',
                } as CSSProperties}
                aria-label={`${defect.typeLabel}，${getDefectCameraLabel(defect)}，距头${defect.distanceHeadMm}mm`}
                title={`${defect.typeLabel} · ${getDefectCameraLabel(defect)} · ${defect.distanceHeadMm}mm`}
                onClick={() => onSelectDefect(defect.id)}
                onMouseEnter={(event) => showDefectDetails(defect, event.currentTarget)}
                onMouseLeave={() => setHoveredDefect(null)}
                onFocus={(event) => showDefectDetails(defect, event.currentTarget)}
                onBlur={() => setHoveredDefect(null)}
              />;
            })}
          </div>
        </div>
      ) : <div className="defect-table-wrap">
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
                    <small className={`defect-review-badge ${defect.reviewStatus ?? 'pending'}`}>
                      {defect.reviewStatus === 'confirmed' ? '已确认' : defect.reviewStatus === 'false-positive' ? '已排除' : '待复核'}
                    </small>
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
      </div>}
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
