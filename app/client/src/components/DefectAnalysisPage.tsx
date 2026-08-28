import { CheckCircle2, ChevronLeft, ChevronRight, Grid2X2, Image as ImageIcon, Maximize2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { DefectItem, DefectReviewStatus, DefectType, SteelPlate } from '../data/inspection';
import { severityLabels } from '../data/inspection';
import { fetchCaptureStitchHistory, type CaptureStitchCameraFrame } from '../services/capture-roi-api';

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
};

type DefectMedia = {
  grayThumbnailUrl: string;
  grayOriginalUrl: string;
  jetThumbnailUrl: string;
  jetOriginalUrl: string;
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

function mediaForDefect(defect: DefectItem, captureFrames: CaptureStitchCameraFrame[]): DefectMedia {
  const cameraFrame = matchFrame(defect, captureFrames);
  const preview = defect.previewImageUrl?.trim() ?? '';
  return {
    grayThumbnailUrl: cameraFrame?.grayThumbnailUrl || preview,
    grayOriginalUrl: cameraFrame?.grayOriginalUrl || preview,
    jetThumbnailUrl: cameraFrame?.jetThumbnailUrl || defect.artifacts?.depthRoiImage || '',
    jetOriginalUrl: cameraFrame?.jetOriginalUrl || defect.artifacts?.depthRoiImage || '',
  };
}

function AnalysisImage({ src, alt, emptyLabel, large = false }: {
  src: string;
  alt: string;
  emptyLabel: string;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [src]);

  return (
    <div className={`defect-analysis-image ${large ? 'large' : ''} ${!src || failed ? 'empty' : ''}`}>
      {src && !failed
        ? <img src={src} alt={alt} onError={() => setFailed(true)} />
        : <span>{failed ? `${emptyLabel}读取失败` : `${emptyLabel}未就绪`}</span>}
      {src && !failed ? <i className="defect-analysis-crosshair" aria-hidden="true" /> : null}
    </div>
  );
}

function DefectPairCard({ defect, media, selected, plateLengthMm, showGray, showJet, onSelect }: {
  defect: DefectItem;
  media: DefectMedia;
  selected: boolean;
  plateLengthMm: number;
  showGray: boolean;
  showJet: boolean;
  onSelect: () => void;
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
          <AnalysisImage src={media.grayThumbnailUrl} alt={`${defect.typeLabel}原始小图`} emptyLabel="原始小图" />
        </figure> : null}
        {showJet ? <figure>
          <figcaption>JET</figcaption>
          <AnalysisImage src={media.jetThumbnailUrl} alt={`${defect.typeLabel} JET 小图`} emptyLabel="JET" />
        </figure> : null}
      </div>
      <footer>
        <span>{(defectPositionMm(defect, plateLengthMm) / 1_000).toFixed(2)} m</span>
        <span>{defect.widthMm.toFixed(1)} × {defect.heightMm.toFixed(1)} mm</span>
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
          {defects.map((defect) => {
            const camera = Math.max(1, Math.min(cameraCount, cameraNumber(defect)));
            const position = defectPositionMm(defect, plateLengthMm);
            const tone = reviewTone(defect);
            return <button
              key={defect.id}
              type="button"
              className={`defect-analysis-dot ${tone} ${defect.id === selectedDefectId ? 'selected' : ''}`}
              style={{
                left: `${((camera - 0.5) / cameraCount) * 100}%`,
                top: `${plateLengthMm > 0 ? Math.max(1, Math.min(99, position / plateLengthMm * 100)) : 50}%`,
                '--defect-color': typeColors.get(defect.typeId) ?? '#64748b',
              } as CSSProperties}
              aria-label={`${defect.typeLabel}，C${camera}，位置${(position / 1_000).toFixed(2)}米`}
              title={`${defect.typeLabel} · C${camera} · ${(position / 1_000).toFixed(2)} m`}
              onClick={() => onSelect(defect.id)}
            />;
          })}
          {selected ? (
            <div className="defect-analysis-selected-callout">
              <strong>{reviewLabel(selected)} · {selected.typeLabel}</strong>
              <span>C{cameraNumber(selected)} · {(defectPositionMm(selected, plateLengthMm) / 1_000).toFixed(2)} m</span>
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
}: DefectAnalysisPageProps) {
  const [displayMode, setDisplayMode] = useState<DefectAnalysisDisplayMode>('large');
  const [showGray, setShowGray] = useState(true);
  const [showJet, setShowJet] = useState(true);
  const [page, setPage] = useState(1);
  const [captureFrames, setCaptureFrames] = useState<CaptureStitchCameraFrame[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const plateLengthMm = plate.lengthMm > 0 ? plate.lengthMm : 12_000;
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
  }, [plate.plateNo]);

  const selectedDefect = defects.find((defect) => defect.id === selectedDefectId) ?? defects[0] ?? null;
  const selectedIndex = selectedDefect ? defects.findIndex((defect) => defect.id === selectedDefect.id) : -1;
  const pageCount = Math.max(1, Math.ceil(defects.length / CARD_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageDefects = defects.slice((safePage - 1) * CARD_PAGE_SIZE, safePage * CARD_PAGE_SIZE);
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
    if (!defects.length) return;
    const nextIndex = selectedIndex < 0
      ? 0
      : (selectedIndex + direction + defects.length) % defects.length;
    onSelectDefect(defects[nextIndex].id);
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
      <div className="defect-analysis-layout">
        <section className="defect-analysis-workspace">
          {defects.length === 0 ? (
            <div className="defect-analysis-empty"><CheckCircle2 size={30} /><strong>当前记录未检出缺陷</strong><span>选择左侧其他检测记录继续查看。</span></div>
          ) : selectedDefect ? <>
            <div className="defect-analysis-toolbar">
              <div className="defect-large-meta">
                <span className={`defect-analysis-status ${reviewTone(selectedDefect)}`}>{reviewLabel(selectedDefect)}</span>
                <strong>{selectedDefect.typeLabel} · C{cameraNumber(selectedDefect)} · {sequenceNumber(selectedDefect) == null ? '--' : String(sequenceNumber(selectedDefect)).padStart(4, '0')}</strong>
                <span>位置 {(defectPositionMm(selectedDefect, plateLengthMm) / 1_000).toFixed(2)} m</span>
                <span>尺寸 {selectedDefect.widthMm.toFixed(1)} × {selectedDefect.heightMm.toFixed(1)} mm</span>
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
                {pageDefects.map((defect) => <DefectPairCard
                  key={defect.id}
                  defect={defect}
                  media={mediaForDefect(defect, captureFrames)}
                  selected={defect.id === selectedDefect?.id}
                  plateLengthMm={plateLengthMm}
                  showGray={showGray}
                  showJet={showJet}
                  onSelect={() => onSelectDefect(defect.id)}
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
                {showGray ? <figure><figcaption><ImageIcon size={14} />原始大图</figcaption><AnalysisImage large src={selectedMedia.grayOriginalUrl} alt={`${selectedDefect.typeLabel}原始大图`} emptyLabel="原始大图" /></figure> : null}
                {showJet ? <figure><figcaption><ImageIcon size={14} />JET 大图</figcaption><AnalysisImage large src={selectedMedia.jetOriginalUrl} alt={`${selectedDefect.typeLabel} JET 大图`} emptyLabel="JET 大图" /></figure> : null}
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
                {defects.slice(0, 12).map((defect, index) => {
                  const media = mediaForDefect(defect, captureFrames);
                  return <button key={defect.id} type="button" className={defect.id === selectedDefect.id ? 'selected' : ''} onClick={() => onSelectDefect(defect.id)}>
                    <b>{String(index + 1).padStart(2, '0')}</b>
                    <span className={showGray && showJet ? '' : 'single'}>{showGray ? <AnalysisImage src={media.grayThumbnailUrl} alt={`${defect.typeLabel}缩略原图`} emptyLabel="原图" /> : null}{showJet ? <AnalysisImage src={media.jetThumbnailUrl} alt={`${defect.typeLabel}缩略 JET`} emptyLabel="JET" /> : null}</span>
                    <small>C{cameraNumber(defect)} · {sequenceNumber(defect) ?? '--'}</small>
                  </button>;
                })}
              </div>
            </div>
          ) : null}
          </> : null}
        </section>

        <DefectDistribution
          defects={defects}
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
