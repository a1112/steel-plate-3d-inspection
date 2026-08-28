import { CheckCircle2, ChevronLeft, ChevronRight, Grid2X2, Image as ImageIcon, Maximize2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type {
  DefectAnalysisTab,
  DefectComparison,
  DefectGroups,
  DefectItem,
  DefectReviewStatus,
  DefectType,
  SteelPlate,
} from '../data/inspection';
import { resolveDefectGroups, severityLabels } from '../data/inspection';
import { fetchCaptureStitchHistory, type CaptureStitchCameraFrame } from '../services/capture-roi-api';
import { bkvOnlineCroppedImageUrl, isBkvOnlineImageUrl } from '../services/bkv-online-api';
import { RequestedSizeImage } from './RequestedSizeImage';

type DefectAnalysisDisplayMode = 'cards' | 'large';

type DefectAnalysisPageProps = {
  plate: SteelPlate;
  defects: DefectItem[];
  defectTypes: DefectType[];
  inspectionId?: string;
  selectedDefectId: string | null;
  expectedCameraCount: number;
  onSelectDefect: (defectId: string) => void;
  onReviewDefect?: (defect: DefectItem, status: DefectReviewStatus, note: string) => Promise<void>;
  defectGroups?: DefectGroups | null;
  comparison?: DefectComparison | null;
};

type DefectMedia = {
  grayThumbnailUrl: string;
  grayOriginalUrl: string;
  jetThumbnailUrl: string;
  jetOriginalUrl: string;
  grayContext: DefectImageContext | null;
  jetContext: DefectImageContext | null;
};

type DefectImageContext = {
  imageWidth: number;
  imageHeight: number;
  viewX: number;
  viewY: number;
  viewWidth: number;
  viewHeight: number;
  roiX: number;
  roiY: number;
  roiWidth: number;
  roiHeight: number;
};

const CARD_PAGE_SIZE = 9;

function cameraNumber(defect: DefectItem) {
  if (Number.isFinite(defect.cameraIndex) && Number(defect.cameraIndex) > 0) {
    return Math.round(Number(defect.cameraIndex));
  }
  const match = (defect.cameraId || defect.artifacts?.cameraId || '').match(/(\d+)$/);
  return match ? Number(match[1]) : 1;
}

function sequenceNumber(defect: DefectItem) {
  const value = defect.artifacts?.sequenceNo;
  return Number.isFinite(value) ? Math.round(Number(value)) : null;
}

function defectPositionMm(defect: DefectItem, plateLengthMm: number) {
  if (defect.distanceHeadMm > 0) return defect.distanceHeadMm;
  if (Number.isFinite(defect.xRatio) && plateLengthMm > 0) {
    return Math.max(0, Math.min(plateLengthMm, defect.xRatio * plateLengthMm));
  }
  return 0;
}

function lacksEncoderLongitudinalMetric(defect: DefectItem) {
  return defect.source?.toLowerCase() === 'sick-depth-geometry'
    && defect.metricAvailability?.longitudinalMm !== true;
}

function defectPositionLabel(defect: DefectItem, plateLengthMm: number) {
  if (lacksEncoderLongitudinalMetric(defect)) {
    return Number.isFinite(defect.xRatio)
      ? `Head-relative ${(Math.max(0, Math.min(1, defect.xRatio)) * 100).toFixed(1)}%`
      : 'Head-relative --';
  }
  const metric = typeof defect.longitudinalMm === 'number' && Number.isFinite(defect.longitudinalMm)
    ? defect.longitudinalMm
    : defectPositionMm(defect, plateLengthMm);
  return `${(metric / 1_000).toFixed(2)} m`;
}

function defectSizeLabel(defect: DefectItem) {
  if (defect.source?.toLowerCase() === 'sick-depth-geometry') {
    const horizontal = typeof defect.horizontalSpanMm === 'number' && Number.isFinite(defect.horizontalSpanMm)
      ? `${defect.horizontalSpanMm.toFixed(1)} mm`
      : '--';
    const longitudinal = typeof defect.longitudinalSpanMm === 'number'
      && Number.isFinite(defect.longitudinalSpanMm)
      ? `${defect.longitudinalSpanMm.toFixed(1)} mm`
      : '--';
    return `Horizontal ${horizontal} · Longitudinal ${longitudinal}`;
  }
  return `${defect.widthMm.toFixed(1)} × ${defect.heightMm.toFixed(1)} mm`;
}

function confidenceValue(defect: DefectItem) {
  const value = defect.classificationConfidence ?? defect.detectionConfidence ?? defect.confidence;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function confidenceLabel(defect: DefectItem) {
  const value = confidenceValue(defect);
  return value == null ? '--' : `${Math.round(value * 100)}%`;
}

function reviewTone(defect: DefectItem) {
  if (defect.reviewStatus === 'confirmed') return 'confirmed';
  if (defect.reviewStatus === 'false-positive') return 'excluded';
  return defect.severity === 'severe' ? 'severe' : 'pending';
}

function reviewLabel(defect: DefectItem) {
  if (defect.reviewStatus === 'confirmed') return '已确认';
  if (defect.reviewStatus === 'false-positive') return '已排除';
  return severityLabels[defect.severity];
}

function matchFrame(defect: DefectItem, frames: CaptureStitchCameraFrame[]) {
  const expectedCamera = cameraNumber(defect);
  const expectedSequence = sequenceNumber(defect);
  if (expectedSequence == null) return null;
  return frames.find((frame) => {
    const frameCamera = Number(frame.cameraId.match(/(\d+)$/)?.[1] ?? 0);
    return frameCamera === expectedCamera
      && (frame.storageIndex === expectedSequence || frame.frameSequence === expectedSequence);
  }) ?? null;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function bkvDefectImageContext(defect: DefectItem): DefectImageContext | null {
  const roi = defect.artifacts?.roi;
  if (!roi
    || ![roi.x, roi.y, roi.width, roi.height].every(Number.isFinite)
    || roi.x < 0
    || roi.y < 0
    || roi.width <= 0
    || roi.height <= 0) return null;

  // BKV images use a 1024 x 1024 source coordinate space. The image endpoint
  // expands a requested ROI to at least 256 x 128 pixels and keeps it inside
  // the source image. Mirror that geometry so the SVG overlay stays exact.
  const sourceWidth = 1024;
  const sourceHeight = 1024;
  const roiX = Math.round(roi.x);
  const roiY = Math.round(roi.y);
  const roiWidth = Math.max(1, Math.round(roi.width));
  const roiHeight = Math.max(1, Math.round(roi.height));
  const contextWidth = Math.min(sourceWidth, Math.max(256, roiWidth));
  const contextHeight = Math.min(sourceHeight, Math.max(128, roiHeight));
  const centerX = Math.min(sourceWidth, roiX + Math.floor(roiWidth / 2));
  const centerY = Math.min(sourceHeight, roiY + Math.floor(roiHeight / 2));
  const cropX = Math.min(
    Math.max(0, centerX - Math.floor(contextWidth / 2)),
    sourceWidth - contextWidth,
  );
  const cropY = Math.min(
    Math.max(0, centerY - Math.floor(contextHeight / 2)),
    sourceHeight - contextHeight,
  );
  const scale = Math.min(1, 512 / contextWidth, 512 / contextHeight);
  const imageWidth = contextWidth * scale;
  const imageHeight = contextHeight * scale;
  const mappedRoiX = clamp((roiX - cropX) * scale, 0, imageWidth - 1);
  const mappedRoiY = clamp((roiY - cropY) * scale, 0, imageHeight - 1);

  return {
    imageWidth,
    imageHeight,
    viewX: 0,
    viewY: 0,
    viewWidth: imageWidth,
    viewHeight: imageHeight,
    roiX: mappedRoiX,
    roiY: mappedRoiY,
    roiWidth: Math.max(1, Math.min(roiWidth * scale, imageWidth - mappedRoiX)),
    roiHeight: Math.max(1, Math.min(roiHeight * scale, imageHeight - mappedRoiY)),
  };
}

export function defectImageContext(
  defect: DefectItem,
  cameraFrame: CaptureStitchCameraFrame | null,
): DefectImageContext | null {
  const roi = defect.artifacts?.roi;
  if (!cameraFrame || !roi || ![roi.x, roi.y, roi.width, roi.height].every(Number.isFinite)) return null;
  const fallbackOffsetX = cameraFrame.validRoi?.[0] ?? 0;
  const fallbackOffsetY = cameraFrame.validRoi?.[1] ?? 0;
  const offsetX = Number(cameraFrame.sourceOffset?.x ?? fallbackOffsetX);
  const offsetY = Number(cameraFrame.sourceOffset?.y ?? fallbackOffsetY);
  const fallbackWidth = cameraFrame.validRoi
    ? cameraFrame.validRoi[2] - cameraFrame.validRoi[0]
    : cameraFrame.sourceWidth;
  const fallbackHeight = cameraFrame.validRoi
    ? cameraFrame.validRoi[3] - cameraFrame.validRoi[1]
    : cameraFrame.sourceHeight;
  const imageWidth = Number(cameraFrame.displaySize?.[0] ?? fallbackWidth);
  const imageHeight = Number(cameraFrame.displaySize?.[1] ?? fallbackHeight);
  if (![offsetX, offsetY, imageWidth, imageHeight].every(Number.isFinite)
    || imageWidth <= 1 || imageHeight <= 1) return null;

  const candidates = [
    { left: roi.x - offsetX, top: roi.y - offsetY },
    // Some historical records already store ROI coordinates relative to the
    // rendered crop. Use those coordinates when source-space mapping lands
    // outside the displayed image.
    { left: roi.x, top: roi.y },
  ];
  const mapped = candidates.find(({ left, top }) => (
    left + Math.max(1, roi.width) > 0
    && top + Math.max(1, roi.height) > 0
    && left < imageWidth
    && top < imageHeight
  ));
  if (!mapped) return null;
  const sourceLeft = mapped.left;
  const sourceTop = mapped.top;
  const sourceRight = sourceLeft + Math.max(1, roi.width);
  const sourceBottom = sourceTop + Math.max(1, roi.height);
  const roiX = clamp(sourceLeft, 0, imageWidth - 1);
  const roiY = clamp(sourceTop, 0, imageHeight - 1);
  const roiWidth = Math.max(1, clamp(sourceRight, roiX + 1, imageWidth) - roiX);
  const roiHeight = Math.max(1, clamp(sourceBottom, roiY + 1, imageHeight) - roiY);
  const viewWidth = Math.min(imageWidth, Math.max(160, roiWidth * 7));
  const viewHeight = Math.min(imageHeight, Math.max(128, roiHeight * 7));
  const viewX = clamp(roiX + roiWidth / 2 - viewWidth / 2, 0, imageWidth - viewWidth);
  const viewY = clamp(roiY + roiHeight / 2 - viewHeight / 2, 0, imageHeight - viewHeight);
  return {
    imageWidth,
    imageHeight,
    viewX,
    viewY,
    viewWidth,
    viewHeight,
    roiX,
    roiY,
    roiWidth,
    roiHeight,
  };
}

function mediaForDefect(defect: DefectItem, captureFrames: CaptureStitchCameraFrame[]): DefectMedia {
  const cameraFrame = matchFrame(defect, captureFrames);
  const preview = defect.previewImageUrl?.trim() ?? '';
  const roi = defect.artifacts?.roi;
  const grayBkvSource = [
    defect.artifacts?.roiImage,
    preview,
    defect.artifacts?.sourceFrame?.intensity,
  ].find((source) => isBkvOnlineImageUrl(source));
  const jetBkvSource = [
    defect.artifacts?.depthRoiImage,
    defect.artifacts?.sourceFrame?.depth,
  ].find((source) => isBkvOnlineImageUrl(source));
  const grayBkvUrl = bkvOnlineCroppedImageUrl(grayBkvSource, roi);
  const jetBkvUrl = bkvOnlineCroppedImageUrl(jetBkvSource, roi);
  const bkvContext = grayBkvUrl ? bkvDefectImageContext(defect) : null;
  const captureContext = defectImageContext(defect, cameraFrame);
  return {
    grayThumbnailUrl: grayBkvUrl || cameraFrame?.grayThumbnailUrl || preview,
    grayOriginalUrl: grayBkvUrl || cameraFrame?.grayOriginalUrl || preview,
    jetThumbnailUrl: jetBkvUrl || cameraFrame?.jetThumbnailUrl || defect.artifacts?.depthRoiImage || '',
    jetOriginalUrl: jetBkvUrl || cameraFrame?.jetOriginalUrl || defect.artifacts?.depthRoiImage || '',
    grayContext: bkvContext || captureContext,
    jetContext: jetBkvUrl && bkvContext ? bkvContext : captureContext,
  };
}

function AnalysisImage({ src, alt, emptyLabel, context, large = false, onDoubleClick, onWheel }: {
  src: string;
  alt: string;
  emptyLabel: string;
  context?: DefectImageContext | null;
  large?: boolean;
  onDoubleClick?: () => void;
  onWheel?: (direction: -1 | 1) => void;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [src]);

  return (
    <div
      className={`defect-analysis-image ${large ? 'large' : ''} ${!src || failed ? 'empty' : ''}`}
      onDoubleClick={onDoubleClick ? (event) => {
        event.preventDefault();
        event.stopPropagation();
        onDoubleClick();
      } : undefined}
      onWheel={onWheel ? (event) => {
        if (event.deltaY === 0) return;
        event.preventDefault();
        event.stopPropagation();
        onWheel(event.deltaY > 0 ? 1 : -1);
      } : undefined}
    >
      {src && !failed
        ? context ? (
          <svg
            className="defect-analysis-context-image"
            role="img"
            aria-label={alt}
            viewBox={`${context.viewX} ${context.viewY} ${context.viewWidth} ${context.viewHeight}`}
            preserveAspectRatio="xMidYMid meet"
            data-context-window={`${context.viewX},${context.viewY},${context.viewWidth},${context.viewHeight}`}
            data-defect-roi={`${context.roiX},${context.roiY},${context.roiWidth},${context.roiHeight}`}
          >
            <title>{alt}</title>
            <image
              href={src}
              x="0"
              y="0"
              width={context.imageWidth}
              height={context.imageHeight}
              preserveAspectRatio="none"
              onError={() => setFailed(true)}
            />
            <rect
              className="defect-analysis-roi-box"
              x={context.roiX}
              y={context.roiY}
              width={context.roiWidth}
              height={context.roiHeight}
              vectorEffect="non-scaling-stroke"
              aria-hidden="true"
            />
          </svg>
        ) : (
          <RequestedSizeImage
            src={src}
            alt={alt}
            requestWidth={large ? 960 : 384}
            requestHeight={large ? 640 : 256}
            onError={() => setFailed(true)}
          />
        )
        : <span>{failed ? `${emptyLabel}读取失败` : `${emptyLabel}未就绪`}</span>}
    </div>
  );
}

function DefectPairCard({ defect, media, selected, plateLengthMm, showGray, showJet, onSelect, onOpenLarge }: {
  defect: DefectItem;
  media: DefectMedia;
  selected: boolean;
  plateLengthMm: number;
  showGray: boolean;
  showJet: boolean;
  onSelect: () => void;
  onOpenLarge: () => void;
}) {
  const sequence = sequenceNumber(defect);
  return (
    <button
      type="button"
      className={`defect-pair-card ${selected ? 'selected' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <header>
        <span className={`defect-analysis-status ${reviewTone(defect)}`}>{reviewLabel(defect)}</span>
        <strong>{defect.typeLabel}</strong>
        <em>C{cameraNumber(defect)} · {sequence == null ? '--' : String(sequence).padStart(4, '0')}</em>
      </header>
      <div className={`defect-pair-images ${showGray && showJet ? '' : 'single'}`}>
        {showGray ? <figure>
          <figcaption>原始小图</figcaption>
          <AnalysisImage src={media.grayThumbnailUrl} alt={`${defect.typeLabel}原始小图`} emptyLabel="原始小图" context={media.grayContext} onDoubleClick={onOpenLarge} />
        </figure> : null}
        {showJet ? <figure>
          <figcaption>JET</figcaption>
          <AnalysisImage src={media.jetThumbnailUrl} alt={`${defect.typeLabel} JET 小图`} emptyLabel="JET" context={media.jetContext} onDoubleClick={onOpenLarge} />
        </figure> : null}
      </div>
      <footer>
        <span>{defectPositionLabel(defect, plateLengthMm)}</span>
        <span>{defectSizeLabel(defect)}</span>
        <b>{confidenceLabel(defect)}</b>
      </footer>
    </button>
  );
}

function DefectDistribution({ defects, selectedDefectId, defectTypes, cameraCount, plateLengthMm, onSelect }: {
  defects: DefectItem[];
  selectedDefectId: string | null;
  defectTypes: DefectType[];
  cameraCount: number;
  plateLengthMm: number;
  onSelect: (defectId: string) => void;
}) {
  const selected = defects.find((defect) => defect.id === selectedDefectId) ?? null;
  const typeColors = new Map(defectTypes.map((type) => [type.id, type.color]));
  const tickValues = [0, 0.25, 0.5, 0.75, 1];
  const confirmed = defects.filter((defect) => defect.reviewStatus === 'confirmed').length;
  const severe = defects.filter((defect) => defect.reviewStatus !== 'confirmed' && defect.severity === 'severe').length;
  const pending = defects.filter((defect) => defect.reviewStatus !== 'confirmed'
    && defect.reviewStatus !== 'false-positive'
    && defect.severity !== 'severe').length;

  return (
    <aside className="defect-analysis-distribution" aria-label="缺陷分布图">
      <div className="defect-distribution-summary">
        <span className="severe">严重 {severe}</span>
        <span className="pending">待复核 {pending}</span>
        <span className="confirmed">已确认 {confirmed}</span>
      </div>
      <div className="defect-analysis-distribution-axis" aria-hidden="true">
        {Array.from({ length: cameraCount }, (_, index) => <span key={index}>C{index + 1}</span>)}
      </div>
      <div className="defect-analysis-distribution-body">
        <div className="defect-analysis-length-axis" aria-hidden="true">
          {tickValues.map((ratio) => <span key={ratio} style={{ top: `${ratio * 100}%` }}>{((plateLengthMm * ratio) / 1_000).toFixed(0)}m</span>)}
        </div>
        <div className="defect-analysis-plot">
          <div className="defect-analysis-camera-guides" aria-hidden="true">
            {Array.from({ length: cameraCount }, (_, index) => <i key={index} />)}
          </div>
          <div className="defect-analysis-length-guides" aria-hidden="true">
            {tickValues.map((ratio) => <i key={ratio} style={{ top: `${ratio * 100}%` }} />)}
          </div>
          {defects.map((defect, index) => {
            const camera = Math.max(1, Math.min(cameraCount, cameraNumber(defect)));
            const position = defectPositionMm(defect, plateLengthMm);
            const positionAccessibleLabel = lacksEncoderLongitudinalMetric(defect)
              ? defectPositionLabel(defect, plateLengthMm)
              : `${(position / 1_000).toFixed(2)}米`;
            const tone = reviewTone(defect);
            return <button
              key={`${defect.source ?? 'candidate'}-${defect.id}-${index}`}
              type="button"
              className={`defect-analysis-dot ${tone} ${defect.id === selectedDefectId ? 'selected' : ''}`}
              style={{
                left: `${((camera - 0.5) / cameraCount) * 100}%`,
                top: `${plateLengthMm > 0 ? Math.max(1, Math.min(99, position / plateLengthMm * 100)) : 50}%`,
                '--defect-color': typeColors.get(defect.typeId) ?? '#64748b',
              } as CSSProperties}
              aria-label={`${defect.typeLabel}，C${camera}，位置${positionAccessibleLabel}`}
              title={`${defect.typeLabel} · C${camera} · ${positionAccessibleLabel}`}
              onClick={() => onSelect(defect.id)}
            />;
          })}
          {selected ? (
            <div className="defect-analysis-selected-callout">
              <strong>{reviewLabel(selected)} · {selected.typeLabel}</strong>
              <span>C{cameraNumber(selected)} · {defectPositionLabel(selected, plateLengthMm)}</span>
              <b>置信度 {confidenceLabel(selected)}</b>
            </div>
          ) : null}
        </div>
      </div>
      <footer>
        <span><i className="severe" />严重</span>
        <span><i className="pending" />待复核</span>
        <span><i className="confirmed" />已确认</span>
      </footer>
    </aside>
  );
}

export function DefectAnalysisPage({
  plate,
  defects,
  defectTypes,
  inspectionId,
  selectedDefectId,
  expectedCameraCount,
  onSelectDefect,
  onReviewDefect,
  defectGroups,
  comparison,
}: DefectAnalysisPageProps) {
  const [displayMode, setDisplayMode] = useState<DefectAnalysisDisplayMode>('large');
  const [analysisTab, setAnalysisTab] = useState<DefectAnalysisTab>('all');
  const [showGray, setShowGray] = useState(true);
  const [showJet, setShowJet] = useState(true);
  const [page, setPage] = useState(1);
  const [captureFrames, setCaptureFrames] = useState<CaptureStitchCameraFrame[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const plateLengthMm = plate.lengthMm > 0 ? plate.lengthMm : 12_000;
  const groups = useMemo(
    () => resolveDefectGroups(defects, defectGroups, comparison),
    [comparison, defectGroups, defects],
  );
  const explicitGroups = Boolean(defectGroups?.geometry || defectGroups?.legacy);
  const totalCandidateCount = explicitGroups
    ? groups.geometry.length + groups.legacy.length
    : groups.all.length;
  const groupRiskTags = useMemo(() => {
    const values = [defectGroups?.geometry, defectGroups?.legacy];
    const tags = values.flatMap((value) => (
      value && !Array.isArray(value) && Array.isArray(value.riskTags) ? value.riskTags : []
    ));
    const comparisonTags = Array.isArray(groups.comparison.riskTags)
      ? groups.comparison.riskTags
      : [];
    return Array.from(new Set(
      [...tags, ...comparisonTags]
        .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        .map((tag) => tag.trim()),
    ));
  }, [defectGroups, groups.comparison.riskTags]);
  const groupErrors = useMemo(() => {
    const values = [defectGroups?.geometry, defectGroups?.legacy];
    return values.flatMap((value) => (
      value && !Array.isArray(value) && typeof value.error === 'string' && value.error.trim()
        ? [value.error.trim()]
        : []
    ));
  }, [defectGroups]);
  const geometryGroupGlobalPositionAvailable = defectGroups?.geometry && !Array.isArray(defectGroups.geometry)
    ? defectGroups.geometry.globalPositionAvailable
    : undefined;
  const cameraLocalEstimate = groups.comparison.cameraLocal === true
    || (groups.comparison.cameraLocal === undefined && geometryGroupGlobalPositionAvailable === false);
  const displayDefects = analysisTab === 'geometry'
    ? groups.geometry
    : analysisTab === 'legacy'
      ? groups.legacy
      : groups.all;
  const cameraIds = useMemo(
    () => Array.from({ length: Math.max(1, expectedCameraCount) }, (_, index) => `C${index + 1}`),
    [expectedCameraCount],
  );

  useEffect(() => {
    let cancelled = false;
    const materialId = plate.plateNo.trim();
    setCaptureFrames([]);
    if (!/^\d+$/.test(materialId)) {
      return undefined;
    }
    void fetchCaptureStitchHistory(materialId, cameraIds)
      .then((result) => {
        if (cancelled) return;
        const frames = result.frames.flatMap((frame) => frame.cameras);
        setCaptureFrames(frames);
      })
      .catch(() => {
        if (!cancelled) setCaptureFrames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [cameraIds, inspectionId, plate.plateNo]);

  useEffect(() => {
    setPage(1);
  }, [analysisTab, plate.plateNo]);

  const selectedDefect = displayDefects.find((defect) => defect.id === selectedDefectId) ?? displayDefects[0] ?? null;
  const selectedIndex = selectedDefect ? displayDefects.findIndex((defect) => defect.id === selectedDefect.id) : -1;
  const pageCount = Math.max(1, Math.ceil(displayDefects.length / CARD_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageDefects = displayDefects.slice((safePage - 1) * CARD_PAGE_SIZE, safePage * CARD_PAGE_SIZE);
  const selectedMedia = selectedDefect ? mediaForDefect(selectedDefect, captureFrames) : null;

  const toggleGray = () => {
    if (showGray && !showJet) return;
    setShowGray((current) => !current);
  };

  const toggleJet = () => {
    if (showJet && !showGray) return;
    setShowJet((current) => !current);
  };

  const navigateDefect = (direction: -1 | 1) => {
    if (!displayDefects.length) return;
    const nextIndex = selectedIndex < 0
      ? 0
      : (selectedIndex + direction + displayDefects.length) % displayDefects.length;
    onSelectDefect(displayDefects[nextIndex].id);
  };

  const submitReview = async (status: DefectReviewStatus) => {
    if (!selectedDefect || !onReviewDefect || reviewing) return;
    const promptLabel = status === 'confirmed' ? '确认说明（可选）' : '排除原因（可选）';
    const note = window.prompt(promptLabel, selectedDefect.reviewNote ?? '');
    if (note === null) return;
    setReviewing(true);
    try {
      await onReviewDefect(selectedDefect, status, note);
    } catch {
      // The parent owns the user-facing error toast; keep this interaction settled.
    } finally {
      setReviewing(false);
    }
  };

  return (
    <main className="defect-analysis-page" aria-label="缺陷分析模式">
      <header className="defect-analysis-groups" aria-label="Defect detector groups">
        <div className="defect-analysis-group-tabs" role="tablist" aria-label="Defect detector groups">
          {([
            ['all', 'All'],
            ['geometry', 'Geometry'],
            ['legacy', 'Legacy'],
            ['comparison', 'Comparison'],
          ] as const).map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={analysisTab === tab}
              className={analysisTab === tab ? 'active' : ''}
              onClick={() => setAnalysisTab(tab)}
            >
              {label}
              {tab === 'all'
                ? ` (${totalCandidateCount})`
                : tab === 'geometry'
                  ? ` (${groups.geometry.length})`
                  : tab === 'legacy'
                    ? ` (${groups.legacy.length})`
                    : ''}
            </button>
          ))}
        </div>
        <div className="defect-analysis-group-counts" aria-live="polite">
          <strong>Total candidates: {totalCandidateCount}</strong>
          <span>Geometry: {groups.geometry.length}</span>
          <span>Legacy: {groups.legacy.length}</span>
          {explicitGroups ? (
            <span className="defect-analysis-unique-warning">
              Estimated unique: {groups.comparison.estimatedUniqueCount}
              {groups.comparison.estimatedUniqueCount !== totalCandidateCount ? ' (overlap retained)' : ''}
            </span>
          ) : null}
        </div>
      </header>
      {analysisTab === 'comparison' ? (
        <section className="defect-analysis-comparison" aria-label="Detector comparison">
          <strong>Detector comparison</strong>
          <span>Matched: {groups.comparison.matched}</span>
          <span>Geometry only: {groups.comparison.geometryOnly}</span>
          <span>Legacy only: {groups.comparison.legacyOnly}</span>
          <b>Estimated unique: {groups.comparison.estimatedUniqueCount}</b>
          {cameraLocalEstimate ? <em>Camera-local estimate: cross-camera matching unavailable.</em> : null}
          {groups.comparison.warning ? <em>{groups.comparison.warning}</em> : null}
          {groupRiskTags.length ? (
            <span className="defect-analysis-comparison-details">Risk tags: {groupRiskTags.join(', ')}</span>
          ) : null}
          {groupErrors.length ? (
            <em>Detector group error: {groupErrors.join('; ')}</em>
          ) : null}
          {groups.comparison.matches?.length ? (
            <span className="defect-analysis-comparison-details">
              Pairs: {groups.comparison.matches.map((match) => `${match.geometryId ?? '-'} ↔ ${match.legacyId ?? '-'}`).join(', ')}
            </span>
          ) : null}
          {groups.comparison.geometryOnlyIds?.length ? (
            <span className="defect-analysis-comparison-details">Geometry IDs: {groups.comparison.geometryOnlyIds.filter(Boolean).join(', ')}</span>
          ) : null}
          {groups.comparison.legacyOnlyIds?.length ? (
            <span className="defect-analysis-comparison-details">Legacy IDs: {groups.comparison.legacyOnlyIds.filter(Boolean).join(', ')}</span>
          ) : null}
        </section>
      ) : null}
      <div className="defect-analysis-layout">
        <section className="defect-analysis-workspace">
          {displayDefects.length === 0 ? (
            <div className="defect-analysis-empty"><CheckCircle2 size={30} /><strong>当前记录未检出缺陷</strong><span>选择左侧其他检测记录继续查看。</span></div>
          ) : selectedDefect ? <>
            <div className="defect-analysis-toolbar">
              <div className="defect-large-meta">
                <span className={`defect-analysis-status ${reviewTone(selectedDefect)}`}>{reviewLabel(selectedDefect)}</span>
                <strong>{selectedDefect.typeLabel} · C{cameraNumber(selectedDefect)} · {sequenceNumber(selectedDefect) == null ? '--' : String(sequenceNumber(selectedDefect)).padStart(4, '0')}</strong>
                <span>位置 {defectPositionLabel(selectedDefect, plateLengthMm)}</span>
                <span>尺寸 {defectSizeLabel(selectedDefect)}</span>
                <b>置信度 {confidenceLabel(selectedDefect)}</b>
              </div>
              <div className="defect-analysis-toolbar-controls">
                <div className="defect-analysis-media-switch" role="group" aria-label="缺陷图像显示选择">
                  <button type="button" className={showGray ? 'active' : ''} aria-pressed={showGray} disabled={showGray && !showJet} onClick={toggleGray}>灰度</button>
                  <button type="button" className={showJet ? 'active' : ''} aria-pressed={showJet} disabled={showJet && !showGray} onClick={toggleJet}>JET</button>
                </div>
                <div className="defect-analysis-mode-switch" role="group" aria-label="缺陷分析显示模式">
                  <button type="button" className={displayMode === 'cards' ? 'active' : ''} aria-pressed={displayMode === 'cards'} onClick={() => setDisplayMode('cards')}><Grid2X2 size={15} />卡片</button>
                  <button type="button" className={displayMode === 'large' ? 'active' : ''} aria-pressed={displayMode === 'large'} onClick={() => setDisplayMode('large')}><Maximize2 size={15} />大图</button>
                </div>
              </div>
            </div>
            {displayMode === 'cards' ? (
            <div className="defect-card-mode">
              <div className="defect-card-grid">
                {pageDefects.map((defect, index) => <DefectPairCard
                  key={`${defect.source ?? 'candidate'}-${defect.id}-${index}`}
                  defect={defect}
                  media={mediaForDefect(defect, captureFrames)}
                  selected={defect.id === selectedDefect?.id}
                  plateLengthMm={plateLengthMm}
                  showGray={showGray}
                  showJet={showJet}
                  onSelect={() => onSelectDefect(defect.id)}
                  onOpenLarge={() => {
                    onSelectDefect(defect.id);
                    setDisplayMode('large');
                  }}
                />)}
              </div>
              <div className="defect-analysis-pagination">
                <button type="button" disabled={safePage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={14} />上一页</button>
                <span>{safePage} / {pageCount}</span>
                <button type="button" disabled={safePage >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>下一页<ChevronRight size={14} /></button>
              </div>
            </div>
          ) : selectedDefect && selectedMedia ? (
            <div className="defect-large-mode">
              <div className={`defect-large-pair ${showGray && showJet ? '' : 'single'}`}>
                {showGray ? <figure><figcaption><ImageIcon size={14} />原始大图</figcaption><AnalysisImage large src={selectedMedia.grayOriginalUrl} alt={`${selectedDefect.typeLabel}原始大图`} emptyLabel="原始大图" context={selectedMedia.grayContext} onDoubleClick={() => setDisplayMode('cards')} onWheel={navigateDefect} /></figure> : null}
                {showJet ? <figure><figcaption><ImageIcon size={14} />JET 大图</figcaption><AnalysisImage large src={selectedMedia.jetOriginalUrl} alt={`${selectedDefect.typeLabel} JET 大图`} emptyLabel="JET 大图" context={selectedMedia.jetContext} onDoubleClick={() => setDisplayMode('cards')} onWheel={navigateDefect} /></figure> : null}
              </div>
              <div className="defect-large-actions">
                <button type="button" onClick={() => navigateDefect(-1)}><ChevronLeft size={15} />上一处</button>
                <button type="button" onClick={() => navigateDefect(1)}>下一处<ChevronRight size={15} /></button>
                {onReviewDefect ? <>
                  <button type="button" className="confirm" disabled={reviewing} onClick={() => void submitReview('confirmed')}><CheckCircle2 size={15} />确认缺陷</button>
                  <button type="button" className="exclude" disabled={reviewing} onClick={() => void submitReview('false-positive')}><XCircle size={15} />排除误报</button>
                </> : null}
              </div>
              <div className="defect-filmstrip" aria-label="缺陷候选缩略图">
                {displayDefects.slice(0, 12).map((defect, index) => {
                  const media = mediaForDefect(defect, captureFrames);
                  return <button key={`${defect.source ?? 'candidate'}-${defect.id}-${index}`} type="button" className={defect.id === selectedDefect.id ? 'selected' : ''} onClick={() => onSelectDefect(defect.id)}>
                    <b>{String(index + 1).padStart(2, '0')}</b>
                    <span className={showGray && showJet ? '' : 'single'}>{showGray ? <AnalysisImage src={media.grayThumbnailUrl} alt={`${defect.typeLabel}缩略原图`} emptyLabel="原图" context={media.grayContext} /> : null}{showJet ? <AnalysisImage src={media.jetThumbnailUrl} alt={`${defect.typeLabel}缩略 JET`} emptyLabel="JET" context={media.jetContext} /> : null}</span>
                    <small>C{cameraNumber(defect)} · {sequenceNumber(defect) ?? '--'}</small>
                  </button>;
                })}
              </div>
            </div>
          ) : null}
          </> : null}
        </section>

        <DefectDistribution
          defects={displayDefects}
          selectedDefectId={selectedDefect?.id ?? null}
          defectTypes={defectTypes}
          cameraCount={Math.max(1, expectedCameraCount)}
          plateLengthMm={plateLengthMm}
          onSelect={onSelectDefect}
        />
      </div>
    </main>
  );
}
