import { Box, ChevronDown, ChevronUp, CircleStop, ExternalLink, GripVertical, Play, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { InspectionSnapshot } from '../data/inspection';
import {
  fetchInspectionSnapshot,
  startProductionSteelIn,
  stopProductionSteelOut,
  waitForProductionCommandTask,
  writeProductionSteelInfo,
  type ProductionCommandResult,
} from '../services/inspection-api';
import { runBarSurfaceProductionAlgorithm } from '../services/bar-surface-api';

type FlowPhase = 'idle' | 'record' | 'steel-in' | 'holding' | 'steel-out' | 'algorithm' | 'complete' | 'failed';

const POSITION_KEY = 'steel-inspection-flow-tool-position';

function createMaterialId() {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `BAR-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function phaseLabel(phase: FlowPhase) {
  return {
    idle: '待启动',
    record: '创建检测记录',
    'steel-in': '进钢并开启保存',
    holding: '持续采集与保存',
    'steel-out': '出钢并生成汇总',
    algorithm: 'Python 识别与 3D 重建',
    complete: '完整流程已完成',
    failed: '流程失败',
  }[phase];
}

export function InspectionFlowTool({
  onSnapshot,
  visible: controlledVisible,
  onVisibleChange,
}: {
  onSnapshot?: (snapshot: InspectionSnapshot) => void;
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const [internalVisible, setInternalVisible] = useState(true);
  const [materialId, setMaterialId] = useState(createMaterialId);
  const [holdSeconds, setHoldSeconds] = useState(15);
  const [phase, setPhase] = useState<FlowPhase>('idle');
  const [detail, setDetail] = useState('建档 → 进钢 → 保持采集 → 出钢 → 识别 → 3D');
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [sessionId, setSessionId] = useState('');
  const [inspectionId, setInspectionId] = useState('');
  const [position, setPosition] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null') as { x?: number; y?: number } | null;
      return { x: Math.max(8, stored?.x ?? 18), y: Math.max(56, stored?.y ?? 82) };
    } catch {
      return { x: 18, y: 82 };
    }
  });
  const drag = useRef<{ pointerId: number; x: number; y: number; startX: number; startY: number } | null>(null);
  const stopRequested = useRef(false);
  const busy = !['idle', 'complete', 'failed'].includes(phase);
  const visible = controlledVisible ?? internalVisible;
  const setVisible = (next: boolean) => {
    if (controlledVisible === undefined) {
      setInternalVisible(next);
    }
    onVisibleChange?.(next);
  };

  useEffect(() => {
    localStorage.setItem(POSITION_KEY, JSON.stringify(position));
  }, [position]);

  const trackTask = (prefix: string) => (task: { status: string; phase?: string; progress?: number }) => {
    setDetail(`${prefix} · ${task.phase || task.status} · ${Math.round(task.progress ?? 0)}%`);
  };

  const waitTask = (command: ProductionCommandResult, prefix: string) =>
    waitForProductionCommandTask(command, trackTask(prefix));

  const refreshRecord = async () => {
    const snapshot = await fetchInspectionSnapshot();
    onSnapshot?.(snapshot);
  };

  const open3d = () => {
    window.location.assign(`/?app=bar-surface&materialId=${encodeURIComponent(materialId)}&view=jet`);
  };

  const run = async () => {
    const currentMaterial = materialId.trim();
    if (!currentMaterial || busy) return;
    const duration = Math.min(3600, Math.max(1, Math.trunc(holdSeconds || 15)));
    let currentSession = '';
    let currentInspection = '';
    let entered = false;
    stopRequested.current = false;
    setRemainingSeconds(duration);
    try {
      setPhase('record');
      setDetail('正在写入正式检测记录');
      const info = await waitTask(await writeProductionSteelInfo({
        materialId: currentMaterial,
        source: 'floating-full-inspection',
        mode: 'manual',
        triggerMode: 'manual',
        captureMode: 'continuous',
        autoCapture: true,
        discardBlackFrames: true,
      }), '创建检测记录');
      currentSession = info.sessionId || currentSession;
      currentInspection = info.inspectionId || currentInspection;
      setSessionId(currentSession);
      setInspectionId(currentInspection);

      setPhase('steel-in');
      const steelIn = await waitTask(await startProductionSteelIn({
        materialId: currentMaterial,
        sessionId: currentSession,
        source: 'floating-full-inspection',
        mode: 'manual',
        triggerMode: 'manual',
        captureMode: 'continuous',
        autoCapture: true,
        discardBlackFrames: true,
      }), '进钢');
      entered = true;
      currentSession = steelIn.sessionId || currentSession;
      currentInspection = steelIn.inspectionId || currentInspection;
      setSessionId(currentSession);
      setInspectionId(currentInspection);

      setPhase('holding');
      for (let remaining = duration; remaining > 0 && !stopRequested.current; remaining -= 1) {
        setRemainingSeconds(remaining);
        setDetail(`连续采集保持中 · 剩余 ${remaining} 秒 · 仅本会话保存`);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
      }

      setPhase('steel-out');
      setRemainingSeconds(0);
      const steelOut = await waitTask(await stopProductionSteelOut({
        materialId: currentMaterial,
        sessionId: currentSession,
        source: 'floating-full-inspection',
        mode: 'manual',
        triggerMode: 'manual',
      }), '出钢与存储汇总');
      entered = false;
      currentSession = steelOut.sessionId || currentSession;
      currentInspection = steelOut.inspectionId || currentInspection;

      setPhase('algorithm');
      const algorithm = await runBarSurfaceProductionAlgorithm({
        materialId: currentMaterial,
        sessionId: currentSession,
        inspectionId: currentInspection || undefined,
        runCore: true,
        onTaskStatus: trackTask('Python 识别与 3D 重建'),
      });
      currentInspection = algorithm.inspectionId || currentInspection;
      setInspectionId(currentInspection);
      setPhase('complete');
      setDetail(`完成 · 缺陷 ${algorithm.record.defectCount} · ${algorithm.record.status}`);
      await refreshRecord();
    } catch (error) {
      if (entered) {
        await stopProductionSteelOut({
          materialId: currentMaterial,
          sessionId: currentSession,
          source: 'floating-full-inspection-recovery',
        }).then((command) => waitForProductionCommandTask(command)).catch(() => undefined);
      }
      setPhase('failed');
      setRemainingSeconds(0);
      setDetail(error instanceof Error ? error.message : '完整检测流程失败');
      await refreshRecord().catch(() => undefined);
    }
  };

  if (!visible) {
    if (controlledVisible !== undefined) {
      return null;
    }
    return (
      <button className="inspection-flow-launcher" type="button" onClick={() => setVisible(true)} title="打开完整检测流程工具">
        <Play size={17} />
        全流程
      </button>
    );
  }

  return (
    <aside
      className={`inspection-flow-tool phase-${phase} ${open ? '' : 'collapsed'}`}
      style={{ left: position.x, top: position.y }}
      aria-label="完整检测流程悬浮工具"
    >
      <header
        onPointerDown={(event: PointerEvent<HTMLElement>) => {
          if ((event.target as HTMLElement).closest('button')) return;
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: position.x, startY: position.y };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.pointerId !== event.pointerId) return;
          const maxX = Math.max(8, window.innerWidth - 340);
          const maxY = Math.max(56, window.innerHeight - 90);
          setPosition({
            x: Math.max(8, Math.min(maxX, current.startX + event.clientX - current.x)),
            y: Math.max(56, Math.min(maxY, current.startY + event.clientY - current.y)),
          });
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId === event.pointerId) drag.current = null;
        }}
      >
        <GripVertical size={16} />
        <div><span>自动化检测</span><strong>完整记录流程</strong></div>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-label={open ? '收起完整检测工具' : '展开完整检测工具'}>
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        <button type="button" onClick={() => setVisible(false)} aria-label="关闭完整检测工具"><X size={15} /></button>
      </header>
      {open ? (
        <div className="inspection-flow-body">
          <div className="inspection-flow-phase"><i /><strong>{phaseLabel(phase)}</strong><span>{remainingSeconds > 0 ? `${remainingSeconds}s` : ''}</span></div>
          <p>{detail}</p>
          <label><span>检测流水</span><input value={materialId} disabled={busy} onChange={(event) => setMaterialId(event.target.value)} /></label>
          <label><span>采集保持</span><div><input type="number" min={1} max={3600} value={holdSeconds} disabled={busy} onChange={(event) => setHoldSeconds(Number(event.target.value))} /><em>秒</em></div></label>
          {(sessionId || inspectionId) ? <dl><div><dt>会话</dt><dd>{sessionId || '-'}</dd></div><div><dt>记录</dt><dd>{inspectionId || '-'}</dd></div></dl> : null}
          <div className="inspection-flow-actions">
            <button type="button" className="primary" disabled={busy || !materialId.trim()} onClick={() => void run()}><Play size={15} />启动全流程</button>
            {phase === 'holding' ? <button type="button" onClick={() => { stopRequested.current = true; setDetail('正在提前出钢并完成存储'); }}><CircleStop size={15} />提前出钢</button> : null}
            {phase === 'complete' ? <button type="button" onClick={open3d}><Box size={15} />打开 3D / Jet<ExternalLink size={13} /></button> : null}
            {phase === 'complete' || phase === 'failed' ? <button type="button" onClick={() => { setMaterialId(createMaterialId()); setPhase('idle'); setDetail('已准备新的检测流程'); setSessionId(''); setInspectionId(''); }}><RefreshCw size={15} />新流程</button> : null}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
