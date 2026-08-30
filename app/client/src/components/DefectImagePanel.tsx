import { useEffect, useMemo, useState } from 'react';
import { PanelRightClose } from 'lucide-react';
import type { DefectItem, DefectReviewStatus } from '../data/inspection';
import { captureArtifactImageUrl } from '../lib/capture-api';
import { bkvOnlineCroppedImageUrl, isBkvOnlineImageUrl } from '../services/bkv-online-api';
import { inspectionWorldFrameUrl } from '../services/inspection-world-api';
import { Panel } from './Panel';
import { RequestedSizeImage } from './RequestedSizeImage';

type Props = {
  inspectionId?: string;
  defect: DefectItem | null;
  onSidebarCollapse?: () => void;
  onReviewDefect?: (defect: DefectItem, status: DefectReviewStatus, note: string) => Promise<void>;
};

const reviewLabels: Record<DefectReviewStatus, string> = {
  pending: '待复核',
  confirmed: '已确认',
  'false-positive': '已排除',
};

function explicitRoiArtifactUrl(value: string | undefined) {
  const source = value?.trim() ?? '';
  if (!source || isBkvOnlineImageUrl(source)) return '';
  return /^(?:https?:|data:|blob:)/i.test(source) || source.startsWith('/')
    ? source
    : captureArtifactImageUrl(source, 2048);
}

function defectRoiImageUrl(defect: DefectItem, inspectionId?: string) {
  const roi = defect.artifacts?.roi;
  const roiImage = defect.artifacts?.roiImage;
  const previewImage = defect.previewImageUrl?.trim() ?? '';

  const bkvRoiImage = bkvOnlineCroppedImageUrl(roiImage, roi);
  if (bkvRoiImage) return bkvRoiImage;

  // Snapshot URLs are normalized against the currently selected LAN service.
  // Prefer that verified route over a raw Windows artifact path, which used to
  // be sent to the unrelated bar-surface file endpoint.
  if (previewImage && !isBkvOnlineImageUrl(previewImage)) return previewImage;

  const explicitRoiImage = explicitRoiArtifactUrl(roiImage);
  if (explicitRoiImage) return explicitRoiImage;

  const bkvPreview = bkvOnlineCroppedImageUrl(previewImage, roi);
  if (bkvPreview) return bkvPreview;

  const bkvSourceFrame = bkvOnlineCroppedImageUrl(defect.artifacts?.sourceFrame?.intensity, roi);
  if (bkvSourceFrame) return bkvSourceFrame;

  return inspectionId && defect.cameraIndex && defect.artifacts?.sequenceNo != null
    ? inspectionWorldFrameUrl(inspectionId, defect.cameraIndex, defect.artifacts.sequenceNo, roi)
    : '';
}

function roiLabel(roi: { x: number; y: number; width: number; height: number } | null | undefined) {
  if (roi
    && [roi.x, roi.y, roi.width, roi.height].every(Number.isFinite)
    && roi.x >= 0
    && roi.y >= 0
    && roi.width > 0
    && roi.height > 0) {
    return `${roi.x},${roi.y},${roi.width},${roi.height}`;
  }
  return 'derived-defect-image';
}

export function DefectImagePanel({ inspectionId, defect, onSidebarCollapse, onReviewDefect }: Props) {
  const [actualSize, setActualSize] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const cameraId = defect?.cameraIndex;
  const sequenceNo = defect?.artifacts?.sequenceNo;
  const roi = defect?.artifacts?.roi;
  const imageUrl = useMemo(
    () => defect ? defectRoiImageUrl(defect, inspectionId) : '',
    [defect, inspectionId],
  );

  useEffect(() => {
    setActualSize(false);
    setFailed(false);
    setReviewError('');
  }, [defect?.id, imageUrl]);

  const submitReview = async (status: DefectReviewStatus) => {
    if (!defect || !onReviewDefect || reviewing) return;
    let note = '';
    if (status !== 'pending') {
      const response = window.prompt(
        status === 'confirmed' ? '确认说明（可选）' : '排除原因（必填）',
        defect.reviewNote ?? '',
      );
      if (response === null) return;
      note = response.trim();
      if (status === 'false-positive' && !note) {
        setReviewError('排除误报必须填写判定理由');
        return;
      }
    }
    setReviewError('');
    setReviewing(true);
    try {
      await onReviewDefect(defect, status, note);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : '缺陷复核写入失败');
    } finally {
      setReviewing(false);
    }
  };

  return (
    <Panel
      title="缺陷图像"
      className="defect-image-panel"
      leadingAction={onSidebarCollapse ? (
        <button
          type="button"
          className="right-sidebar-collapse-button"
          aria-label="折叠右侧栏"
          title="折叠右侧栏"
          onClick={onSidebarCollapse}
        >
          <PanelRightClose size={14} />
        </button>
      ) : undefined}
      action={defect ? <span className="defect-image-frame-tag">
        C{cameraId ?? '-'} · {sequenceNo == null ? '无定位帧' : String(sequenceNo).padStart(4, '0')}
      </span> : undefined}
    >
      {!defect ? (
        <div className="defect-image-empty">请选择缺陷记录</div>
      ) : !imageUrl || failed ? (
        <div className="defect-image-empty">
          <strong>{defect.typeLabel}</strong>
          <span>{failed ? '算法 ROI 小图读取失败' : '算法 ROI 小图未就绪'}</span>
        </div>
      ) : (
        <>
          <div className="defect-image-controls" role="group" aria-label="缺陷图像显示方式">
            <button
              type="button"
              className={!actualSize ? 'active' : ''}
              aria-pressed={!actualSize}
              onClick={() => setActualSize(false)}
            >
              适应
            </button>
            <button
              type="button"
              className={actualSize ? 'active' : ''}
              aria-pressed={actualSize}
              onClick={() => setActualSize(true)}
            >
              1:1
            </button>
            <span>{defect.typeLabel} · {Math.round((defect.confidence ?? 0) * 100)}%</span>
          </div>
          {onReviewDefect ? (
            <div className="defect-review-controls">
              <span className={`defect-review-status ${defect.reviewStatus ?? 'pending'}`}>
                {reviewLabels[defect.reviewStatus ?? 'pending']}
              </span>
              <button type="button" disabled={reviewing} onClick={() => void submitReview('confirmed')}>确认缺陷</button>
              <button type="button" disabled={reviewing} onClick={() => void submitReview('false-positive')}>排除误报</button>
              {(defect.reviewStatus ?? 'pending') !== 'pending'
                ? <button type="button" disabled={reviewing} onClick={() => void submitReview('pending')}>恢复待复核</button>
                : null}
            </div>
          ) : null}
          {reviewError ? <div className="defect-review-error" role="alert">{reviewError}</div> : null}
          <div className={`defect-image-viewport ${actualSize ? 'actual-size' : ''}`}>
            <RequestedSizeImage
              src={imageUrl}
              alt={`${defect.typeLabel} C${cameraId} 第 ${sequenceNo} 帧缺陷图像`}
              data-roi={roiLabel(roi)}
              requestWidth={960}
              requestHeight={640}
              disableRequestedSize={actualSize}
              onError={() => setFailed(true)}
            />
          </div>
        </>
      )}
    </Panel>
  );
}
