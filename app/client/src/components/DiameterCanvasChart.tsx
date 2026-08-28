import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { DiameterCurveLine, DiameterMeasurement } from './DiameterTrendPanel';

type AxisMode = 'length-mm' | 'head-relative';

type HoverEntry = {
  line: DiameterCurveLine;
  sample: DiameterMeasurement;
};

type HoverState = {
  axisValue: number;
  ratio: number;
  entries: HoverEntry[];
};

type ChartMetrics = {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  plotWidth: number;
  plotHeight: number;
  minimum: number;
  maximum: number;
};

const FALLBACK_COLORS = {
  background: '#ffffff',
  text: '#5f7188',
  line: '#d8e0e9',
  axis: '#9aa9ba',
  nominal: '#f59e0b',
  envelope: 'rgba(47, 125, 255, 0.10)',
};

function cssColor(element: Element, name: string, fallback: string) {
  const value = window.getComputedStyle(element).getPropertyValue(name).trim();
  return value || fallback;
}

function axisValue(sample: DiameterMeasurement, mode: AxisMode) {
  return mode === 'length-mm' ? sample.positionMm : sample.positionRatio * 100;
}

function nearestSample(line: DiameterCurveLine, target: number, mode: AxisMode) {
  let nearest = line.samples[0];
  let distance = Number.POSITIVE_INFINITY;
  for (const sample of line.samples) {
    const nextDistance = Math.abs(axisValue(sample, mode) - target);
    if (nextDistance < distance) {
      nearest = sample;
      distance = nextDistance;
    }
  }
  return nearest;
}

function buildTicks(start: number, end: number, count: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || count < 2) return [];
  return Array.from({ length: count }, (_, index) => start + ((end - start) * index) / (count - 1));
}

function prepareCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext('2d');
  } catch {
    return null;
  }
  context?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return context;
}

function lineDash(kind: DiameterCurveLine['kind']) {
  if (kind === 'minimum' || kind === 'maximum') return [5, 4];
  return [];
}

export function DiameterCanvasChart({
  lines,
  nominalDiameterMm,
  axisMode,
  axisStart,
  axisEnd,
  selectedAxisValue = null,
}: {
  lines: DiameterCurveLine[];
  nominalDiameterMm: number;
  axisMode: AxisMode;
  axisStart: number;
  axisEnd: number;
  selectedAxisValue?: number | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const backgroundRef = useRef<HTMLCanvasElement>(null);
  const foregroundRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set());
  const [hover, setHover] = useState<HoverState | null>(null);
  const [themeRevision, setThemeRevision] = useState(0);
  const visibleLines = useMemo(
    () => lines.filter((line) => !hiddenSeries.has(line.id)),
    [hiddenSeries, lines],
  );
  const valueRange = useMemo(() => {
    const values = visibleLines.flatMap((line) => line.samples.map((sample) => sample.diameterMm)).filter(Number.isFinite);
    if (!values.length) return { minimum: 0, maximum: 1, showNominal: false };
    const dataMinimum = Math.min(...values);
    const dataMaximum = Math.max(...values);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const span = Math.max(0.01, dataMaximum - dataMinimum);
    const showNominal = nominalDiameterMm > 0 && Math.abs(nominalDiameterMm - mean) <= Math.max(10, mean * 0.3);
    const minimum = Math.min(dataMinimum, showNominal ? nominalDiameterMm : dataMinimum) - span * 0.16;
    const maximum = Math.max(dataMaximum, showNominal ? nominalDiameterMm : dataMaximum) + span * 0.16;
    return { minimum, maximum, showNominal };
  }, [nominalDiameterMm, visibleLines]);

  const metrics = useCallback((): ChartMetrics | null => {
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (width <= 0 || height <= 0) return null;
    const left = width < 520 ? 48 : 58;
    const right = 14;
    const top = lines.length > 4 ? 42 : 34;
    const bottom = 32;
    return {
      width,
      height,
      left,
      right,
      top,
      bottom,
      plotWidth: Math.max(1, width - left - right),
      plotHeight: Math.max(1, height - top - bottom),
      minimum: valueRange.minimum,
      maximum: valueRange.maximum,
    };
  }, [lines.length, valueRange.maximum, valueRange.minimum]);

  const drawBackground = useCallback(() => {
    const canvas = backgroundRef.current;
    const container = containerRef.current;
    const layout = metrics();
    if (!canvas || !container || !layout) return;
    const context = prepareCanvas(canvas, layout.width, layout.height);
    if (!context) return;
    const background = cssColor(container, '--panel', FALLBACK_COLORS.background);
    const text = cssColor(container, '--muted', FALLBACK_COLORS.text);
    const grid = cssColor(container, '--line', FALLBACK_COLORS.line);
    const axis = cssColor(container, '--faint', FALLBACK_COLORS.axis);
    const nominal = cssColor(container, '--amber', FALLBACK_COLORS.nominal);
    const range = Math.max(0.0001, layout.maximum - layout.minimum);
    const x = (value: number) => layout.left + ((value - axisStart) / Math.max(0.0001, axisEnd - axisStart)) * layout.plotWidth;
    const y = (value: number) => layout.top + ((layout.maximum - value) / range) * layout.plotHeight;

    context.clearRect(0, 0, layout.width, layout.height);
    context.fillStyle = background;
    context.fillRect(0, 0, layout.width, layout.height);
    context.font = '10px sans-serif';
    context.lineWidth = 1;

    for (const tick of buildTicks(layout.minimum, layout.maximum, 5)) {
      const tickY = y(tick);
      context.strokeStyle = grid;
      context.beginPath();
      context.moveTo(layout.left, tickY);
      context.lineTo(layout.left + layout.plotWidth, tickY);
      context.stroke();
      context.fillStyle = text;
      context.textAlign = 'right';
      context.fillText(tick.toFixed(3), layout.left - 6, tickY + 3);
    }
    for (const tick of buildTicks(axisStart, axisEnd, layout.width < 600 ? 4 : 6)) {
      const tickX = x(tick);
      context.strokeStyle = grid;
      context.beginPath();
      context.moveTo(tickX, layout.top);
      context.lineTo(tickX, layout.top + layout.plotHeight);
      context.stroke();
      context.fillStyle = text;
      context.textAlign = tick === axisStart ? 'left' : tick === axisEnd ? 'right' : 'center';
      context.fillText(axisMode === 'length-mm' ? `${(tick / 1000).toFixed(1)}m` : `${tick.toFixed(0)}%`, tickX, layout.top + layout.plotHeight + 15);
    }

    context.strokeStyle = axis;
    context.beginPath();
    context.moveTo(layout.left, layout.top);
    context.lineTo(layout.left, layout.top + layout.plotHeight);
    context.lineTo(layout.left + layout.plotWidth, layout.top + layout.plotHeight);
    context.stroke();

    if (valueRange.showNominal) {
      context.strokeStyle = nominal;
      context.setLineDash([7, 4]);
      context.beginPath();
      context.moveTo(layout.left, y(nominalDiameterMm));
      context.lineTo(layout.left + layout.plotWidth, y(nominalDiameterMm));
      context.stroke();
      context.setLineDash([]);
    }

    const minimumLine = visibleLines.find((line) => line.kind === 'minimum');
    const maximumLine = visibleLines.find((line) => line.kind === 'maximum');
    if (minimumLine && maximumLine) {
      context.beginPath();
      maximumLine.samples.forEach((sample, index) => {
        const pointX = x(axisValue(sample, axisMode));
        const pointY = y(sample.diameterMm);
        if (index === 0) context.moveTo(pointX, pointY);
        else context.lineTo(pointX, pointY);
      });
      [...minimumLine.samples].reverse().forEach((sample) => context.lineTo(x(axisValue(sample, axisMode)), y(sample.diameterMm)));
      context.closePath();
      context.fillStyle = FALLBACK_COLORS.envelope;
      context.fill();
    }

    for (const line of visibleLines) {
      context.beginPath();
      let drawing = false;
      for (const sample of line.samples) {
        if (!Number.isFinite(sample.diameterMm)) {
          drawing = false;
          continue;
        }
        const pointX = x(axisValue(sample, axisMode));
        const pointY = y(sample.diameterMm);
        if (!drawing) context.moveTo(pointX, pointY);
        else context.lineTo(pointX, pointY);
        drawing = true;
      }
      context.strokeStyle = line.color;
      context.lineWidth = line.kind === 'average' ? 2.4 : line.kind === 'legacy' ? 2 : 1.35;
      context.setLineDash(lineDash(line.kind));
      context.stroke();
      context.setLineDash([]);
    }

    context.fillStyle = text;
    context.textAlign = 'center';
    context.fillText(axisMode === 'length-mm' ? '距头部长度' : '头部相对位置（无测速仪）', layout.left + layout.plotWidth / 2, layout.height - 5);
  }, [axisEnd, axisMode, axisStart, metrics, nominalDiameterMm, themeRevision, valueRange.showNominal, visibleLines]);

  const drawForeground = useCallback(() => {
    const canvas = foregroundRef.current;
    const container = containerRef.current;
    const layout = metrics();
    if (!canvas || !container || !layout) return;
    const context = prepareCanvas(canvas, layout.width, layout.height);
    if (!context) return;
    context.clearRect(0, 0, layout.width, layout.height);
    const text = cssColor(container, '--text', '#10233d');
    const range = Math.max(0.0001, layout.maximum - layout.minimum);
    if (selectedAxisValue !== null
      && Number.isFinite(selectedAxisValue)
      && selectedAxisValue >= axisStart
      && selectedAxisValue <= axisEnd) {
      const selectedRatio = (selectedAxisValue - axisStart) / Math.max(0.0001, axisEnd - axisStart);
      const selectedX = layout.left + selectedRatio * layout.plotWidth;
      const marker = cssColor(container, '--cyan', '#0ea5e9');
      context.strokeStyle = marker;
      context.globalAlpha = 0.86;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(selectedX, layout.top);
      context.lineTo(selectedX, layout.top + layout.plotHeight);
      context.stroke();
      context.fillStyle = marker;
      context.beginPath();
      context.moveTo(selectedX - 4, layout.top);
      context.lineTo(selectedX + 4, layout.top);
      context.lineTo(selectedX, layout.top + 6);
      context.closePath();
      context.fill();
      context.globalAlpha = 1;
    }
    if (!hover?.entries.length) return;
    const markerX = layout.left + hover.ratio * layout.plotWidth;
    context.strokeStyle = text;
    context.globalAlpha = 0.42;
    context.lineWidth = 1;
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(markerX, layout.top);
    context.lineTo(markerX, layout.top + layout.plotHeight);
    context.stroke();
    context.setLineDash([]);
    context.globalAlpha = 1;
    for (const entry of hover.entries) {
      const markerY = layout.top + ((layout.maximum - entry.sample.diameterMm) / range) * layout.plotHeight;
      context.fillStyle = entry.line.color;
      context.beginPath();
      context.arc(markerX, markerY, entry.line.kind === 'average' ? 4 : 3, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = '#ffffff';
      context.stroke();
    }
  }, [axisEnd, axisStart, hover, metrics, selectedAxisValue, themeRevision]);

  useEffect(() => {
    const requestDraw = () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        drawBackground();
        drawForeground();
        frameRef.current = null;
      });
    };
    requestDraw();
    const observer = typeof ResizeObserver === 'undefined' || !containerRef.current
      ? null
      : new ResizeObserver(requestDraw);
    if (containerRef.current) observer?.observe(containerRef.current);
    window.addEventListener('resize', requestDraw);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', requestDraw);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [drawBackground, drawForeground]);

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeRevision((revision) => revision + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-theme-style'] });
    return () => observer.disconnect();
  }, []);

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const layout = metrics();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!layout || !rect || !visibleLines.length) return;
    const pointerX = event.clientX - rect.left;
    if (pointerX < layout.left || pointerX > layout.left + layout.plotWidth) {
      setHover(null);
      return;
    }
    const ratio = Math.max(0, Math.min(1, (pointerX - layout.left) / layout.plotWidth));
    const target = axisStart + ratio * (axisEnd - axisStart);
    const entries = visibleLines.flatMap((line): HoverEntry[] => {
      const sample = nearestSample(line, target, axisMode);
      return sample ? [{ line, sample }] : [];
    });
    setHover({ ratio, axisValue: target, entries });
  };

  return (
    <div
      ref={containerRef}
      className="diameter-canvas-chart"
      role="img"
      aria-label={`测径（外径）曲线，按${axisMode === 'length-mm' ? '钢管长度位置' : '头部相对位置'}变化`}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHover(null)}
      data-selected-axis-value={selectedAxisValue === null ? undefined : selectedAxisValue.toFixed(3)}
    >
      <canvas ref={backgroundRef} className="diameter-canvas-background" aria-hidden="true" />
      <canvas ref={foregroundRef} className="diameter-canvas-foreground" aria-hidden="true" />
      <div className="diameter-canvas-legend" role="group" aria-label="测径曲线多选">
        {lines.map((line) => {
          const visible = !hiddenSeries.has(line.id);
          return <label
            key={line.id}
            className={visible ? 'active' : ''}
          >
            <input
              type="checkbox"
              checked={visible}
              onChange={() => setHiddenSeries((current) => {
                const next = new Set(current);
                if (next.has(line.id)) next.delete(line.id);
                else next.add(line.id);
                return next;
              })}
            />
            <span className="diameter-series-check" aria-hidden="true" />
            <i style={{ '--diameter-series-color': line.color } as CSSProperties} />
            <span>{line.label}</span>
          </label>;
        })}
      </div>
      {hover?.entries.length ? (
        <div className="diameter-canvas-tooltip" style={{ left: `${Math.min(78, Math.max(8, hover.ratio * 100))}%` }}>
          <strong>{axisMode === 'length-mm' ? `${(hover.axisValue / 1000).toFixed(3)} m` : `${hover.axisValue.toFixed(1)}%`}</strong>
          {hover.entries.map(({ line, sample }) => <span key={line.id}>
            <i style={{ '--diameter-series-color': line.color } as CSSProperties} />
            {line.label}<b>{sample.diameterMm.toFixed(3)} mm</b>
          </span>)}
        </div>
      ) : null}
      <span className="diameter-canvas-accessible-summary">
        {visibleLines.map((line) => `${line.label} ${line.samples.length} 个截面`).join('；')}
      </span>
    </div>
  );
}
