import { useEffect, useMemo, useState } from 'react';
import { PanelRightClose } from 'lucide-react';
import type { DefectItem } from '../data/inspection';
import { inspectionWorldFrameUrl } from '../services/inspection-world-api';
import { Panel } from './Panel';

type Props = {
  inspectionId?: string;
  defect: DefectItem | null;
  onSidebarCollapse?: () => void;
};

export function DefectImagePanel({ inspectionId, defect, onSidebarCollapse }: Props) {
  const [actualSize, setActualSize] = useState(false);
  const [failed, setFailed] = useState(false);
  const cameraId = defect?.cameraIndex;
  const sequenceNo = defect?.artifacts?.sequenceNo;
  const imageUrl = useMemo(() => (
    inspectionId && cameraId && sequenceNo != null
      ? inspectionWorldFrameUrl(inspectionId, cameraId, sequenceNo)
      : ''
  ), [cameraId, inspectionId, sequenceNo]);

  useEffect(() => {
    setActualSize(false);
    setFailed(false);
  }, [defect?.id, imageUrl]);

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
          <span>{failed ? '缺陷原始图像读取失败' : '当前缺陷未绑定原始帧'}</span>
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
          <div className={`defect-image-viewport ${actualSize ? 'actual-size' : ''}`}>
            <img
              src={imageUrl}
              alt={`${defect.typeLabel} C${cameraId} 第 ${sequenceNo} 帧缺陷图像`}
              onError={() => setFailed(true)}
            />
          </div>
        </>
      )}
    </Panel>
  );
}
