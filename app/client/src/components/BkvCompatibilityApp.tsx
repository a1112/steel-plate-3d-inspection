import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Box, Images, RotateCcw, ShieldOff, StepForward } from 'lucide-react';
import { normalizeCameraDisplayLanes } from '../lib/camera-display';
import {
  fetchBkvArtifactBlobUrl,
  fetchBkvCylinder,
  fetchBkvMaterials,
  nextBkvReplay,
  resetBkvReplay,
  type BkvCylinderPreview,
  type BkvMaterial,
  type BkvStatus,
} from '../services/bkv-api';

type ViewMode = '2d' | 'unwrapped' | 'cylinder';

function displayNumber(value: number | null, unit: string) {
  return value == null ? '无有效旧值' : `${value.toLocaleString('zh-CN')} ${unit}`;
}

function BkvCylinderCanvas({ sequence, data }: { sequence: number; data: BkvCylinderPreview }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = canvas.getContext('2d');
    } catch {
      return;
    }
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#081523';
    context.fillRect(0, 0, width, height);
    const rows = data.display_residual.length;
    const cols = data.display_residual[0]?.length ?? 0;
    const stride = Math.max(1, Math.floor(rows / 96));
    for (let row = 0; row < rows; row += stride) {
      const x = 28 + (row / Math.max(1, rows - 1)) * (width - 56);
      for (let col = 0; col < cols; col += 1) {
        if (!data.valid_mask[row]?.[col]) continue;
        const angle = (col / Math.max(1, cols)) * Math.PI * 2;
        const residual = data.display_residual[row]?.[col] ?? 0;
        const radius = 66 + Math.max(-16, Math.min(16, residual * 5));
        const y = height / 2 + Math.sin(angle) * radius * 0.52;
        const shade = Math.round(150 + Math.cos(angle) * 70);
        context.fillStyle = `rgb(${Math.max(40, shade - 70)}, ${Math.max(90, shade)}, ${Math.min(255, shade + 55)})`;
        context.fillRect(x, y, 1.8, 1.8);
      }
    }
    context.strokeStyle = 'rgba(115, 211, 255, .75)';
    context.strokeRect(24, height / 2 - 40, width - 48, 80);
  }, [data]);

  return <canvas ref={ref} width={920} height={420} aria-label={`${sequence} BKV 圆柱三维预览`} />;
}

export function BkvCompatibilityApp({ status: initialStatus }: { status: BkvStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [materials, setMaterials] = useState<BkvMaterial[]>([]);
  const [selectedSequence, setSelectedSequence] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('2d');
  const [blobUrls, setBlobUrls] = useState<Record<string, string>>({});
  const [failedPaths, setFailedPaths] = useState<Set<string>>(new Set());
  const [cylinder, setCylinder] = useState<BkvCylinderPreview | null>(null);
  const [message, setMessage] = useState('正在读取经过校验的旧系统数据…');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchBkvMaterials(controller.signal)
      .then((items) => {
        setMaterials(items);
        setSelectedSequence((current) => current ?? items[0]?.legacySeqNo ?? null);
        setMessage(`已载入 ${items.length} 支旧钢管记录`);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setMessage(error instanceof Error ? error.message : 'BKV 材料读取失败');
        }
      });
    return () => controller.abort();
  }, []);

  const selected = useMemo(
    () => materials.find((material) => material.legacySeqNo === selectedSequence) ?? materials[0] ?? null,
    [materials, selectedSequence],
  );
  const cameraLanes = useMemo(
    () => normalizeCameraDisplayLanes(selected?.cameras.map((camera) => `camera${camera.cameraId}`) ?? []),
    [selected],
  );
  const configuredCameraCount = selected?.cameras.length ?? status.cameraCount;

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const paths = viewMode === '2d'
      ? selected.cameras.map((camera) => camera.twoDFrames[0]?.path).filter((path): path is string => Boolean(path))
      : viewMode === 'unwrapped'
        ? [selected.artifacts.unwrapped.path]
        : [];
    Promise.all(paths.map(async (path) => {
      try {
        return { path, url: await fetchBkvArtifactBlobUrl(path, controller.signal) };
      } catch {
        return { path, url: null };
      }
    }))
      .then((entries) => {
        if (controller.signal.aborted) return;
        setBlobUrls((previous) => {
          Object.values(previous).forEach((url) => {
            if (url.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
          });
          return Object.fromEntries(entries.filter((entry) => entry.url).map((entry) => [entry.path, entry.url as string]));
        });
        const failures = new Set(entries.filter((entry) => !entry.url).map((entry) => entry.path));
        setFailedPaths(failures);
        if (failures.size > 0) setMessage(`${failures.size} 路 BKV 图像读取失败，其余相机继续显示`);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'BKV 图像读取失败');
      });
    if (viewMode === 'cylinder') {
      fetchBkvCylinder(selected.artifacts.cylinder.path, controller.signal)
        .then(setCylinder)
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'BKV 三维数据读取失败');
        });
    } else {
      setCylinder(null);
    }
    return () => controller.abort();
  }, [selected, viewMode]);

  const replayNext = async () => {
    setBusy(true);
    try {
      const result = await nextBkvReplay();
      if (result.status) setStatus(result.status);
      const sequence = result.capture?.legacySeqNo;
      if (sequence) setSelectedSequence(sequence);
      setMessage(result.completed ? '本批次回放已完成' : `已回放旧序号 ${sequence ?? '-'}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'BKV 回放失败');
    } finally {
      setBusy(false);
    }
  };

  const resetReplay = async () => {
    setBusy(true);
    try {
      const result = await resetBkvReplay();
      if (result.status) setStatus(result.status);
      setSelectedSequence(materials[0]?.legacySeqNo ?? null);
      setMessage('批次游标已重置到第 1 支');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'BKV 重置失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="bkv-app-shell">
      <header className="bkv-header">
        <div>
          <span className="bkv-eyebrow">兼容数据工作区 · 不连接相机</span>
          <h1>BKV 离线回放</h1>
        </div>
        <div className="bkv-header-status">
          <strong>{configuredCameraCount}/{status.cameraCount} 离线数据</strong>
          <span>真实相机在线 0</span>
          <span>批次 {status.batchId}</span>
        </div>
      </header>

      <section className="bkv-toolbar">
        <label>旧系统钢管
          <select value={selected?.legacySeqNo ?? ''} onChange={(event) => setSelectedSequence(Number(event.target.value))}>
            {materials.map((material) => <option key={material.legacySeqNo} value={material.legacySeqNo}>{material.legacySeqNo} · {material.steelId}</option>)}
          </select>
        </label>
        <div className="bkv-view-tabs" role="group" aria-label="BKV 显示模式">
          <button className={viewMode === '2d' ? 'active' : ''} onClick={() => setViewMode('2d')}><Images size={16} />二维原图</button>
          <button className={viewMode === 'unwrapped' ? 'active' : ''} onClick={() => setViewMode('unwrapped')}>JIT 平铺展开</button>
          <button className={viewMode === 'cylinder' ? 'active' : ''} onClick={() => setViewMode('cylinder')}><Box size={16} />圆柱 3D</button>
        </div>
        <div className="bkv-replay-actions">
          <button onClick={replayNext} disabled={busy || status.completed}><StepForward size={16} />回放下一支</button>
          <button onClick={resetReplay} disabled={busy}><RotateCcw size={16} />重置批次</button>
        </div>
      </section>

      {status.completed ? <div className="bkv-completed">本批次回放已完成</div> : null}
      {selected && configuredCameraCount !== status.cameraCount ? (
        <div className="bkv-parameter-warning" role="alert">
          相机参数异常：清单 {configuredCameraCount} 路，运行参数 {status.cameraCount} 路
        </div>
      ) : null}
      <div className="bkv-message" role="status">{message}</div>

      {selected ? <div className="bkv-workspace">
        <aside className="bkv-material-panel">
          <div className="bkv-source-tag">来源：旧 BKV 文件 · 观察用途</div>
          <h2>{selected.steelId}</h2>
          <dl>
            <div><dt>旧序号</dt><dd>{selected.legacySeqNo}</dd></div>
            <div><dt>钢种</dt><dd>{selected.steelType || '-'}</dd></div>
            <div><dt>长度</dt><dd>{displayNumber(selected.lengthMm, 'mm')}</dd></div>
            <div><dt>旧外径值</dt><dd>{displayNumber(selected.outerDiameterLegacyValue, '')}</dd></div>
            <div><dt>壁厚</dt><dd>{displayNumber(selected.wallThicknessMm, 'mm')}</dd></div>
            <div><dt>检测时间</dt><dd>{selected.inspectionTime || '-'}</dd></div>
          </dl>
          <div className="bkv-hardware-disabled"><ShieldOff size={17} />硬件控制已禁用</div>
          <h3>关联缺陷 {selected.defects.length}</h3>
          <div className="bkv-defect-list">
            {selected.defects.length ? selected.defects.map((defect) => (
              <article key={defect.legacyDefectId}>
                <strong>{defect.className}</strong>
                <span>相机 {defect.cameraId} · 置信度 {defect.confidence}%</span>
              </article>
            )) : <p>该材料无可验证关联缺陷</p>}
          </div>
        </aside>

        <section className="bkv-visual-panel">
          {viewMode === '2d' ? <div
            className="bkv-camera-strip"
            data-testid="bkv-camera-strip"
            data-camera-count={cameraLanes.length}
            style={{ '--camera-count': cameraLanes.length } as CSSProperties}
          >
            {cameraLanes.map((lane, index) => {
              const camera = selected.cameras[index];
              const path = camera.twoDFrames[0]?.path;
              return <figure key={lane.cameraId} data-testid="bkv-camera-lane" data-camera-id={lane.cameraId}>
                <div className="bkv-camera-lane-label"><strong>{lane.shortLabel}</strong><span>{lane.label}</span></div>
                {path && blobUrls[path]
                  ? <img src={blobUrls[path]} alt={`相机 ${camera.cameraId} 离线二维图`} />
                  : <div className="bkv-image-loading">{path ? failedPaths.has(path) ? '读取失败' : '读取中' : '无 2D 帧'}</div>}
                <figcaption>2D {camera.twoDFrameCount} / NPZ {camera.npzFrameCount}</figcaption>
              </figure>;
            })}
          </div> : null}
          {viewMode === 'unwrapped' ? (
            blobUrls[selected.artifacts.unwrapped.path]
              ? <img className="bkv-unwrapped" src={blobUrls[selected.artifacts.unwrapped.path]} alt={`${selected.legacySeqNo} JIT 平铺展开`} />
              : <div className="bkv-image-loading">正在生成平铺显示…</div>
          ) : null}
          {viewMode === 'cylinder' ? (
            cylinder ? <BkvCylinderCanvas sequence={selected.legacySeqNo} data={cylinder} /> : <div className="bkv-image-loading">正在读取圆柱数据…</div>
          ) : null}
          <p className="bkv-preview-warning">未标定预览：相机顺序、接缝、半径及物理单位仅用于旧数据观察，不作为检测结论。</p>
        </section>
      </div> : <section className="bkv-empty">等待经过验证的 BKV 材料清单</section>}
    </main>
  );
}
