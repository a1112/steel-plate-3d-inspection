import { ChevronLeft, ChevronRight, Maximize2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CaptureImageItem, ChartPoint, DefectItem } from '../data/inspection';
import type { CaptureFlowMeasurement } from '../lib/capture-api';
import { barSurfaceFileUrl, type BarSurfaceMesh } from '../services/bar-surface-api';
import { bkvOnlineCroppedImageUrl, isBkvOnlineImageUrl } from '../services/bkv-online-api';
import { inspectionWorldFrameUrl } from '../services/inspection-world-api';
import { DiameterTrendPanel } from './DiameterTrendPanel';
import { Panel } from './Panel';

export type AnalysisViewMode = 'overview' | 'image' | 'point-cloud' | 'profile' | 'diameter' | 'defects';

function explicitRoiArtifactUrl(value: string | undefined) {
  const source = value?.trim() ?? '';
  if (!source || isBkvOnlineImageUrl(source)) return '';
  return /^(?:https?:|data:|blob:)/i.test(source) || source.startsWith('/')
    ? source
    : barSurfaceFileUrl(source);
}

function defectRoiImageUrl(defect: DefectItem, inspectionId?: string) {
  const roi = defect.artifacts?.roi;
  const roiImage = defect.artifacts?.roiImage;
  const previewImage = defect.previewImageUrl?.trim() ?? '';

  const explicitRoiImage = explicitRoiArtifactUrl(roiImage);
  if (explicitRoiImage) return explicitRoiImage;

  const bkvRoiImage = bkvOnlineCroppedImageUrl(roiImage, roi);
  if (bkvRoiImage) return bkvRoiImage;

  if (previewImage && !isBkvOnlineImageUrl(previewImage)) return previewImage;

  const bkvPreview = bkvOnlineCroppedImageUrl(previewImage, roi);
  if (bkvPreview) return bkvPreview;

  const bkvSourceFrame = bkvOnlineCroppedImageUrl(defect.artifacts?.sourceFrame?.intensity, roi);
  if (bkvSourceFrame) return bkvSourceFrame;

  const cameraIndex = defect.cameraIndex;
  const sequenceNo = defect.artifacts?.sequenceNo;
  return inspectionId && cameraIndex && sequenceNo != null
    ? inspectionWorldFrameUrl(inspectionId, cameraIndex, sequenceNo, roi)
    : '';
}

function AlgorithmRoiImageEmpty() {
  return (
    <div className="production-artifact-empty compact" role="status">
      <strong>算法 ROI 小图未就绪</strong>
      <span>当前缺陷尚未生成可显示的 ROI 裁剪或缺陷小图产物。</span>
    </div>
  );
}

function CaptureImagePreview({
  captureImages,
  artifactSource,
}: {
  captureImages: CaptureImageItem[];
  artifactSource: 'production-roi' | 'demo';
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const visibleImages = captureImages
    .filter((image) => image.url && (image.dataName === 'depth' || image.dataName === 'intensity'))
    .slice(0, 12);
  const selectedImage = selectedIndex === null ? null : visibleImages[selectedIndex] ?? null;
  const activeSelectedIndex = selectedIndex ?? 0;

  useEffect(() => {
    if (!selectedImage) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedIndex(null);
      if (event.key === 'ArrowLeft') setSelectedIndex((current) => current === null ? null : (current - 1 + visibleImages.length) % visibleImages.length);
      if (event.key === 'ArrowRight') setSelectedIndex((current) => current === null ? null : (current + 1) % visibleImages.length);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedImage, visibleImages.length]);

  if (visibleImages.length === 0) return <AlgorithmRoiImageEmpty />;

  return (
    <div className="capture-image-preview-grid" data-artifact-source={artifactSource}>
      {visibleImages.map((image, index) => (
        <figure key={`${image.id}-${image.dataName}`} className="capture-image-preview-card">
          <button type="button" className="capture-image-preview-open" onClick={() => setSelectedIndex(index)} aria-label={`打开 ${image.cameraId || image.cameraIp} ${image.dataName} #${image.sequenceNo}`}>
            <img src={image.url} alt={`${image.cameraId} ${image.dataName}`} loading="lazy" />
            <figcaption>
              <strong>{image.cameraId || image.cameraIp}</strong>
              <span>{image.dataName === 'depth' ? '深度' : '亮度'} #{image.sequenceNo}</span>
              <Maximize2 size={13} aria-hidden="true" />
            </figcaption>
          </button>
        </figure>
      ))}
      {selectedImage && typeof document !== 'undefined' ? createPortal(
        <div className="capture-image-viewer-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelectedIndex(null);
        }}>
          <section className="capture-image-viewer" role="dialog" aria-modal="true" aria-label="单相机采集图像查看">
            <header>
              <div>
                <span>单相机缺陷图像</span>
                <strong>{selectedImage.cameraId || selectedImage.cameraIp}</strong>
              </div>
              <button type="button" onClick={() => setSelectedIndex(null)} aria-label="关闭图像弹窗"><X size={18} /></button>
            </header>
            <div className="capture-image-viewer-stage">
              <img src={selectedImage.url} alt={`${selectedImage.cameraId} ${selectedImage.dataName} #${selectedImage.sequenceNo}`} />
              {visibleImages.length > 1 ? (
                <>
                  <button type="button" className="previous" onClick={() => setSelectedIndex((activeSelectedIndex - 1 + visibleImages.length) % visibleImages.length)} aria-label="上一张"><ChevronLeft size={24} /></button>
                  <button type="button" className="next" onClick={() => setSelectedIndex((activeSelectedIndex + 1) % visibleImages.length)} aria-label="下一张"><ChevronRight size={24} /></button>
                </>
              ) : null}
            </div>
            <footer>
              <span>{selectedImage.dataName === 'depth' ? '深度图' : '亮度图'}</span>
              <span>序号 #{selectedImage.sequenceNo}</span>
              <span>{activeSelectedIndex + 1} / {visibleImages.length}</span>
              <code title={selectedImage.path}>{selectedImage.path}</code>
            </footer>
          </section>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export function AlarmAnalysis({
  selectedDefect,
  captureImages = [],
  defects = [],
  artifactMode = 'production',
  surfaceMesh,
  inspectionId,
  headerless = false,
  collapsed,
  viewMode = 'diameter',
  diameterMeasurement,
  diameterArtifact,
  diameterVisibleRange,
  diameterSelectedPositionRatio,
}: {
  selectedDefect: DefectItem | null;
  heightProfile: ChartPoint[];
  captureImages?: CaptureImageItem[];
  defects?: DefectItem[];
  artifactMode?: 'production' | 'demo';
  surfaceMesh?: BarSurfaceMesh | null;
  artifactStatus?: string;
  inspectionId?: string;
  headerless?: boolean;
  collapsed?: boolean;
  viewMode?: AnalysisViewMode;
  diameterMeasurement?: { nominalDiameterMm: number; lengthMm: number };
  diameterArtifact?: CaptureFlowMeasurement | null;
  diameterVisibleRange?: [number, number] | null;
  diameterSelectedPositionRatio?: number | null;
}) {
  const panelClassName = `alarm-analysis-panel analysis-view-${viewMode}`;
  const defectRoiImages: CaptureImageItem[] = (defects.length ? defects : selectedDefect ? [selectedDefect] : [])
    .flatMap((defect) => {
      const imageUrl = defectRoiImageUrl(defect, inspectionId);
      if (!imageUrl) return [];
      const cameraIndex = defect.cameraIndex;
      const sequenceNo = defect.artifacts?.sequenceNo ?? 0;
      return [{
        id: `defect-frame-${defect.id}`,
        cameraId: `${cameraIndex ? `C${cameraIndex}` : defect.cameraId || '未定位相机'} · ${defect.typeLabel}`,
        cameraIp: '',
        dataName: 'intensity',
        sequenceNo,
        fileType: 'image',
        path: defect.artifacts?.roiImage || `defect-roi/${defect.id}`,
        url: imageUrl,
        createdAt: '',
      }];
    });
  const lowerDefectImages = defectRoiImages.length
    ? defectRoiImages
    : artifactMode === 'demo' ? captureImages : [];
  const canMeasureDiameter = Boolean(
    diameterMeasurement
    && (diameterArtifact || (
      surfaceMesh
      && diameterMeasurement.nominalDiameterMm > 0
      && diameterMeasurement.lengthMm > 0
    )),
  );

  if (collapsed) return null;

  if (viewMode === 'defects') {
    return (
      <Panel title="缺陷图片列表" className={`${panelClassName} defect-strip-analysis-panel`} headerless={headerless}>
        {artifactMode === 'production' && lowerDefectImages.length === 0
          ? <AlgorithmRoiImageEmpty />
          : <CaptureImagePreview captureImages={lowerDefectImages} artifactSource={artifactMode === 'production' ? 'production-roi' : 'demo'} />}
      </Panel>
    );
  }

  return (
    <Panel
      title="测径（外径）曲线"
      className={`${panelClassName} diameter-analysis-panel`}
      bodyStyle={{ padding: 0 }}
      headerless={headerless}
    >
      <div className="diameter-only-analysis">
        {canMeasureDiameter ? (
          <DiameterTrendPanel
            mesh={surfaceMesh}
            artifact={diameterArtifact}
            nominalDiameterMm={diameterMeasurement!.nominalDiameterMm}
            lengthMm={diameterMeasurement!.lengthMm}
            visibleRange={diameterVisibleRange}
            selectedPositionRatio={diameterSelectedPositionRatio}
          />
        ) : (
          <div className="production-artifact-empty compact" role="status">
            <strong>暂无测径（外径）曲线</strong>
            <span>检测记录 {inspectionId || '未绑定'} 尚未提供可用于整管外径拟合的点云网格。</span>
          </div>
        )}
      </div>
    </Panel>
  );
}
