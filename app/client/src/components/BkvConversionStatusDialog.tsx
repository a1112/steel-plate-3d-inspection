import { Database, Image as ImageIcon, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { InspectionSnapshot } from '../data/inspection';
import {
  fetchBkvOnlineStatus,
  type BkvOnlineStatus,
} from '../services/bkv-online-api';
import { getInspectionServiceOrigin } from '../services/inspection-api';

type BkvConversionStatusDialogProps = {
  snapshot: InspectionSnapshot;
  onClose: () => void;
};

type PreviewImage = {
  id: string;
  label: string;
  detail: string;
  url: string;
  kind: '2D' | '3D';
};

function resolvePreviewImageUrl(url: string) {
  if (/^(?:https?:|blob:|data:)/i.test(url)) return url;
  const normalized = url.startsWith('/') ? url : `/${url}`;
  return `${getInspectionServiceOrigin()}${normalized}`;
}

function formatStatusTime(value: number) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function buildPreviewImages(snapshot: InspectionSnapshot): PreviewImage[] {
  const images: PreviewImage[] = (snapshot.captureImages ?? []).slice(0, 6).map((image) => ({
    id: image.id,
    label: image.cameraId || image.cameraIp,
    detail: `图像 ${image.sequenceNo} · ${image.fileType.toUpperCase()}`,
    url: resolvePreviewImageUrl(image.url),
    kind: '2D',
  }));
  const depth = snapshot.defects
    .map((defect) => ({
      defect,
      url: defect.artifacts?.sourceFrame?.depth || defect.artifacts?.depthRoiImage || '',
    }))
    .find((item) => item.url);
  if (depth) {
    images.push({
      id: `depth-${depth.defect.id}`,
      label: `${depth.defect.cameraId ?? `相机 ${depth.defect.cameraIndex ?? '--'}`} · 深度`,
      detail: `${depth.defect.typeLabel} · ${depth.defect.id}`,
      url: resolvePreviewImageUrl(depth.url),
      kind: '3D',
    });
  }
  return images;
}

export function BkvConversionStatusDialog({
  snapshot,
  onClose,
}: BkvConversionStatusDialogProps) {
  const [status, setStatus] = useState<BkvOnlineStatus | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const previewImages = useMemo(() => buildPreviewImages(snapshot), [snapshot]);

  const refresh = async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      setStatus(await fetchBkvOnlineStatus(signal));
      setError('');
    } catch (nextError) {
      if (!signal?.aborted) {
        setError(nextError instanceof Error ? nextError.message : '在线转换状态读取失败');
      }
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(controller.signal), 5_000);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);

  const healthy = Boolean(status?.running && status.databaseConnected && !status.lastError);

  return (
    <div className="bkv-conversion-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="bkv-conversion-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bkv-conversion-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>BKV 在线数据管道</span>
            <h2 id="bkv-conversion-dialog-title">数据转换状态</h2>
            <p>MySQL 最新记录与六个共享图像目录的持续转换结果</p>
          </div>
          <div className="bkv-conversion-dialog-actions">
            <button
              type="button"
              className={refreshing ? 'refreshing' : ''}
              onClick={() => void refresh()}
              aria-label="刷新转换状态"
            >
              <RefreshCw size={16} />
              刷新
            </button>
            <button type="button" onClick={onClose} aria-label="关闭转换状态弹窗">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className={`bkv-conversion-health ${healthy ? 'healthy' : 'warning'}`}>
          <i aria-hidden="true" />
          <div>
            <strong>{healthy ? '转换循环运行正常' : '正在检查转换循环'}</strong>
            <span>{error || status?.lastError || '数据库已连接，图像按需读取并转换'}</span>
          </div>
          <em>{healthy ? '运行中' : '检查中'}</em>
        </div>

        <div className="bkv-conversion-metrics">
          <article>
            <Database size={18} />
            <span>数据库连接</span>
            <strong>{status?.databaseConnected ? '已连接' : '--'}</strong>
          </article>
          <article>
            <RefreshCw size={18} />
            <span>成功刷新</span>
            <strong>{status?.refreshSuccesses ?? '--'}</strong>
          </article>
          <article>
            <span>转换记录</span>
            <strong>{status ? `${status.recordCount}/${status.recordLimit}` : '--'}</strong>
          </article>
          <article>
            <ImageIcon size={18} />
            <span>实际预览</span>
            <strong>{previewImages.length} 张</strong>
          </article>
        </div>

        <dl className="bkv-conversion-details">
          <div><dt>最新记录</dt><dd>{status?.latestRecord?.plateNo || status?.latestRecord?.id || '--'}</dd></div>
          <div><dt>记录时间</dt><dd>{status?.latestRecord?.time || '--'}</dd></div>
          <div><dt>刷新周期</dt><dd>{status ? `${status.refreshIntervalMs / 1_000} 秒` : '--'}</dd></div>
          <div><dt>最近成功</dt><dd>{formatStatusTime(status?.lastSuccessAtMs ?? 0)}</dd></div>
        </dl>

        <div className="bkv-conversion-preview-heading">
          <div>
            <strong>共享目录实际图像</strong>
            <span>图像直接来自 CamImageSource1–6；3D 项由原始 D3IMG 即时转换</span>
          </div>
          <em>{snapshot.currentPlate.plateNo}</em>
        </div>

        {previewImages.length ? (
          <div className="bkv-conversion-preview-grid">
            {previewImages.map((image) => (
              <figure key={image.id}>
                <div>
                  <img src={image.url} alt={`${image.label} 实际${image.kind}图像`} />
                  <span>{image.kind}</span>
                </div>
                <figcaption>
                  <strong>{image.label}</strong>
                  <span>{image.detail}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <div className="bkv-conversion-preview-empty">
            当前最新记录尚未找到可展示的共享目录图像。
          </div>
        )}
      </section>
    </div>
  );
}
