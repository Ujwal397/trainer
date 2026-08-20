/**
 * Dependency-free canvas charts. No chart library — this app ships a 240fps
 * game loop and every extra kilobyte in the bundle is a kilobyte that has to
 * justify itself. These are drawn once per data change, never per frame.
 */
import type { Vec2 } from '@core/types';
import { mean } from '@core/math';
import { el } from './dom';

export interface ChartHandle<TData> {
  canvas: HTMLCanvasElement;
  /** Re-render with new data, reusing the same canvas and listeners. */
  update: (data: TData) => void;
  /** Removes listeners and detaches the chart's DOM from its container. */
  destroy: () => void;
}

interface Plot { x: number; y: number; width: number; height: number; }
interface TooltipPoint { px: number; py: number; text: string; }

const MARGIN = { top: 16, right: 20, bottom: 34, left: 56 };

// ------------------------------------------------------------------ setup --

/** Reads a palette token from style.css so screens (tooltips, legends) can
 *  match chart colours exactly without duplicating the palette. */
export function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Creates a canvas sized in CSS pixels but backed by devicePixelRatio real
 *  pixels, so charts stay crisp on high-DPI displays. */
function createCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = el('canvas', { class: 'chart-canvas' }) as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.scale(dpr, dpr);
  return { canvas, ctx };
}

function plotFor(width: number, height: number): Plot {
  return { x: MARGIN.left, y: MARGIN.top, width: width - MARGIN.left - MARGIN.right, height: height - MARGIN.top - MARGIN.bottom };
}

function scaleLinear(domain: [number, number], range: [number, number]): (v: number) => number {
  const span = domain[1] - domain[0] || 1;
  return (v: number) => range[0] + ((v - domain[0]) / span) * (range[1] - range[0]);
}

/** Domain with padding; handles empty and degenerate (min === max) inputs. */
function domainOf(values: number[], padFrac = 0.08): [number, number] {
  if (values.length === 0) return [0, 1];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * padFrac;
  return [lo - pad, hi + pad];
}

function niceTicks(domain: [number, number], count: number): number[] {
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) ticks.push(domain[0] + ((domain[1] - domain[0]) * i) / count);
  return ticks;
}

const identityFormat = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));

// ------------------------------------------------------------------- axes --

interface AxesInput {
  ctx: CanvasRenderingContext2D;
  plot: Plot;
  xDomain: [number, number];
  yDomain: [number, number];
  xScale: (v: number) => number;
  yScale: (v: number) => number;
  xFormat: (v: number) => string;
  yFormat: (v: number) => string;
  xLabel?: string;
  yLabel?: string;
}

function drawAxes(a: AxesInput): void {
  const { ctx, plot } = a;
  const grid = cssVar('--chart-grid', '#242a31');
  const axis = cssVar('--chart-axis', '#565f6b');
  const text = cssVar('--chart-text', '#9aa4b2');

  ctx.save();
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.lineWidth = 1;

  for (const t of niceTicks(a.yDomain, 5)) {
    const py = a.yScale(t);
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(plot.x, py);
    ctx.lineTo(plot.x + plot.width, py);
    ctx.stroke();
    ctx.fillStyle = text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(a.yFormat(t), plot.x - 8, py);
  }
  for (const t of niceTicks(a.xDomain, 5)) {
    const px = a.xScale(t);
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(px, plot.y);
    ctx.lineTo(px, plot.y + plot.height);
    ctx.stroke();
    ctx.fillStyle = text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(a.xFormat(t), px, plot.y + plot.height + 6);
  }

  ctx.strokeStyle = axis;
  ctx.beginPath();
  ctx.moveTo(plot.x, plot.y);
  ctx.lineTo(plot.x, plot.y + plot.height);
  ctx.lineTo(plot.x + plot.width, plot.y + plot.height);
  ctx.stroke();

  ctx.fillStyle = text;
  if (a.xLabel) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(a.xLabel, plot.x + plot.width / 2, plot.y + plot.height + 22);
  }
  if (a.yLabel) {
    ctx.save();
    ctx.translate(14, plot.y + plot.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(a.yLabel, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- tooltip --

/** Wires hover behaviour shared by every chart. `getPoints` is called on every
 *  mousemove so charts can hit-test whatever their latest data is. */
function attachTooltip(canvas: HTMLCanvasElement, tooltip: HTMLDivElement, getPoints: () => TooltipPoint[]): () => void {
  const onMove = (e: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: TooltipPoint | null = null;
    let bestDist = 18;
    for (const p of getPoints()) {
      const dist = Math.hypot(p.px - mx, p.py - my);
      if (dist < bestDist) { bestDist = dist; best = p; }
    }
    if (best) {
      tooltip.textContent = best.text;
      tooltip.style.left = `${best.px + 12}px`;
      tooltip.style.top = `${best.py - 10}px`;
      tooltip.style.display = 'block';
    } else {
      tooltip.style.display = 'none';
    }
  };
  const onLeave = (): void => { tooltip.style.display = 'none'; };
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  return () => {
    canvas.removeEventListener('mousemove', onMove);
    canvas.removeEventListener('mouseleave', onLeave);
  };
}

function chartShell(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; wrap: HTMLDivElement; tooltip: HTMLDivElement } {
  const { canvas, ctx } = createCanvas(width, height);
  const tooltip = el('div', { class: 'chart-tooltip' }) as HTMLDivElement;
  const wrap = el('div', { class: 'chart-wrap', style: { width: `${width}px`, height: `${height}px` } }, canvas, tooltip) as HTMLDivElement;
  return { canvas, ctx, wrap, tooltip };
}

// -------------------------------------------------------------- line chart --

export interface LineChartData {
  points: Vec2[];
  /** Extra points drawn as dots on top of the line, e.g. sampled buckets on a fitted curve. */
  scatterOverlay?: { x: number; y: number; label?: string }[];
}

export interface LineChartOptions {
  width: number;
  height: number;
  xLabel?: string;
  yLabel?: string;
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  /** Horizontal reference lines, e.g. the flat 1.0 gain line on the accel curve graph. */
  referenceLines?: { y: number; label?: string }[];
  yMin?: number;
  yMax?: number;
  xMin?: number;
  xMax?: number;
}

export function lineChart(container: HTMLElement, data: LineChartData, opts: LineChartOptions): ChartHandle<LineChartData> {
  const { ctx, canvas, wrap, tooltip } = chartShell(opts.width, opts.height);
  const xFormat = opts.xFormat ?? identityFormat;
  const yFormat = opts.yFormat ?? identityFormat;
  let tipPoints: TooltipPoint[] = [];

  function render(d: LineChartData): void {
    ctx.clearRect(0, 0, opts.width, opts.height);
    const plot = plotFor(opts.width, opts.height);
    const overlay = d.scatterOverlay ?? [];
    const xs = d.points.map((p) => p.x).concat(overlay.map((p) => p.x));
    const ys = d.points.map((p) => p.y).concat(overlay.map((p) => p.y), (opts.referenceLines ?? []).map((r) => r.y));
    const xDomain: [number, number] = [opts.xMin ?? domainOf(xs)[0], opts.xMax ?? domainOf(xs)[1]];
    const yDomain: [number, number] = [opts.yMin ?? domainOf(ys)[0], opts.yMax ?? domainOf(ys)[1]];
    const xScale = scaleLinear(xDomain, [plot.x, plot.x + plot.width]);
    const yScale = scaleLinear(yDomain, [plot.y + plot.height, plot.y]);

    drawAxes({ ctx, plot, xDomain, yDomain, xScale, yScale, xFormat, yFormat, xLabel: opts.xLabel, yLabel: opts.yLabel });

    const refColor = cssVar('--chart-reference', '#565f6b');
    for (const ref of opts.referenceLines ?? []) {
      const py = yScale(ref.y);
      ctx.save();
      ctx.strokeStyle = refColor;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(plot.x, py);
      ctx.lineTo(plot.x + plot.width, py);
      ctx.stroke();
      if (ref.label) {
        ctx.setLineDash([]);
        ctx.fillStyle = refColor;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(ref.label, plot.x + 4, py - 2);
      }
      ctx.restore();
    }

    if (d.points.length > 0) {
      const lineColor = cssVar('--chart-accent', '#ff4655');
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      d.points.forEach((p, i) => {
        const px = xScale(p.x);
        const py = yScale(p.y);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    const overlayColor = cssVar('--chart-accent-2', '#5ce1e6');
    ctx.fillStyle = overlayColor;
    for (const p of overlay) {
      const px = xScale(p.x);
      const py = yScale(p.y);
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    tipPoints = [
      ...d.points.map((p) => ({ px: xScale(p.x), py: yScale(p.y), text: `${xFormat(p.x)}, ${yFormat(p.y)}` })),
      ...overlay.map((p) => ({ px: xScale(p.x), py: yScale(p.y), text: p.label ?? `${xFormat(p.x)}, ${yFormat(p.y)}` })),
    ];
  }

  render(data);
  container.appendChild(wrap);
  const detachTooltip = attachTooltip(canvas, tooltip, () => tipPoints);

  return {
    canvas,
    update: render,
    destroy: () => { detachTooltip(); wrap.remove(); },
  };
}

// ----------------------------------------------------------------- scatter --

export interface ScatterDatum {
  x: number;
  y: number;
  /** Category key used to colour the point, e.g. 'hit' | 'miss'. */
  key?: string;
  label?: string;
}

export interface ScatterChartOptions {
  width: number;
  height: number;
  xLabel?: string;
  yLabel?: string;
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  colors?: Record<string, string>;
  defaultColor?: string;
  /** Draws a least-squares trend line through the points. */
  trendLine?: boolean;
  /** Shades a +/-1 residual-stddev band around the trend line. Requires trendLine. */
  confidenceBand?: boolean;
  /** Marks where the trend line crosses y=0 on the x-axis. Requires trendLine. */
  markZeroCrossing?: boolean;
  /** Draws a reference line through x=0 / y=0 when the domain contains it. */
  xZeroLine?: boolean;
  yZeroLine?: boolean;
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
}

interface LinearFit { slope: number; intercept: number; residualStdDev: number; }

function linearRegression(points: { x: number; y: number }[]): LinearFit | null {
  if (points.length < 2) return null;
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  if (den === 0) return null;
  const slope = num / den;
  const intercept = my - slope * mx;
  const residualStdDev = Math.sqrt(mean(points.map((p) => (p.y - (slope * p.x + intercept)) ** 2)));
  return { slope, intercept, residualStdDev };
}

export function scatterChart(container: HTMLElement, data: ScatterDatum[], opts: ScatterChartOptions): ChartHandle<ScatterDatum[]> {
  const { ctx, canvas, wrap, tooltip } = chartShell(opts.width, opts.height);
  const xFormat = opts.xFormat ?? identityFormat;
  const yFormat = opts.yFormat ?? identityFormat;
  let tipPoints: TooltipPoint[] = [];

  function render(d: ScatterDatum[]): void {
    ctx.clearRect(0, 0, opts.width, opts.height);
    const plot = plotFor(opts.width, opts.height);
    const xDomain: [number, number] = [opts.xMin ?? domainOf(d.map((p) => p.x))[0], opts.xMax ?? domainOf(d.map((p) => p.x))[1]];
    const yDomain: [number, number] = [opts.yMin ?? domainOf(d.map((p) => p.y))[0], opts.yMax ?? domainOf(d.map((p) => p.y))[1]];
    const xScale = scaleLinear(xDomain, [plot.x, plot.x + plot.width]);
    const yScale = scaleLinear(yDomain, [plot.y + plot.height, plot.y]);

    drawAxes({ ctx, plot, xDomain, yDomain, xScale, yScale, xFormat, yFormat, xLabel: opts.xLabel, yLabel: opts.yLabel });

    const zeroColor = cssVar('--chart-zero-line', '#7a8494');
    ctx.save();
    ctx.strokeStyle = zeroColor;
    ctx.setLineDash([2, 3]);
    if (opts.yZeroLine && yDomain[0] <= 0 && yDomain[1] >= 0) {
      const py = yScale(0);
      ctx.beginPath(); ctx.moveTo(plot.x, py); ctx.lineTo(plot.x + plot.width, py); ctx.stroke();
    }
    if (opts.xZeroLine && xDomain[0] <= 0 && xDomain[1] >= 0) {
      const px = xScale(0);
      ctx.beginPath(); ctx.moveTo(px, plot.y); ctx.lineTo(px, plot.y + plot.height); ctx.stroke();
    }
    ctx.restore();

    const fit = opts.trendLine ? linearRegression(d) : null;
    if (fit) {
      const x0 = xDomain[0];
      const x1 = xDomain[1];
      const trendColor = cssVar('--chart-accent-2', '#5ce1e6');

      if (opts.confidenceBand) {
        ctx.save();
        ctx.fillStyle = cssVar('--chart-band', 'rgba(92, 225, 230, 0.12)');
        ctx.beginPath();
        ctx.moveTo(xScale(x0), yScale(fit.slope * x0 + fit.intercept + fit.residualStdDev));
        ctx.lineTo(xScale(x1), yScale(fit.slope * x1 + fit.intercept + fit.residualStdDev));
        ctx.lineTo(xScale(x1), yScale(fit.slope * x1 + fit.intercept - fit.residualStdDev));
        ctx.lineTo(xScale(x0), yScale(fit.slope * x0 + fit.intercept - fit.residualStdDev));
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.strokeStyle = trendColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xScale(x0), yScale(fit.slope * x0 + fit.intercept));
      ctx.lineTo(xScale(x1), yScale(fit.slope * x1 + fit.intercept));
      ctx.stroke();
      ctx.restore();

      if (opts.markZeroCrossing && fit.slope !== 0) {
        const zx = -fit.intercept / fit.slope;
        if (zx >= xDomain[0] && zx <= xDomain[1]) {
          const px = xScale(zx);
          ctx.save();
          ctx.strokeStyle = cssVar('--chart-accent', '#ff4655');
          ctx.setLineDash([5, 3]);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(px, plot.y);
          ctx.lineTo(px, plot.y + plot.height);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = cssVar('--chart-accent', '#ff4655');
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(`0 @ ${xFormat(zx)}`, px, plot.y - 4);
          ctx.restore();
        }
      }
    }

    const defaultColor = opts.defaultColor ?? cssVar('--chart-accent', '#ff4655');
    tipPoints = [];
    for (const p of d) {
      const px = xScale(p.x);
      const py = yScale(p.y);
      const color = (p.key && opts.colors?.[p.key]) || defaultColor;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
      tipPoints.push({ px, py, text: p.label ?? `${xFormat(p.x)}, ${yFormat(p.y)}` });
    }
  }

  render(data);
  container.appendChild(wrap);
  const detachTooltip = attachTooltip(canvas, tooltip, () => tipPoints);

  return {
    canvas,
    update: render,
    destroy: () => { detachTooltip(); wrap.remove(); },
  };
}

// -------------------------------------------------------------------- bar --

export interface BarDatum { label: string; value: number; color?: string; }

export interface BarChartOptions {
  width: number;
  height: number;
  yLabel?: string;
  yFormat?: (v: number) => string;
  color?: string;
  yMin?: number;
  yMax?: number;
}

export function barChart(container: HTMLElement, data: BarDatum[], opts: BarChartOptions): ChartHandle<BarDatum[]> {
  const { ctx, canvas, wrap, tooltip } = chartShell(opts.width, opts.height);
  const yFormat = opts.yFormat ?? identityFormat;
  let tipPoints: TooltipPoint[] = [];

  function render(d: BarDatum[]): void {
    ctx.clearRect(0, 0, opts.width, opts.height);
    const plot = plotFor(opts.width, opts.height);
    const values = d.map((b) => b.value).concat([0]);
    const yDomain: [number, number] = [opts.yMin ?? Math.min(...values, domainOf(values)[0]), opts.yMax ?? domainOf(values)[1]];
    const yScale = scaleLinear(yDomain, [plot.y + plot.height, plot.y]);
    const xScale = scaleLinear([0, Math.max(1, d.length)], [plot.x, plot.x + plot.width]);

    drawAxes({
      ctx, plot, xDomain: [0, Math.max(1, d.length)], yDomain, xScale, yScale,
      xFormat: () => '', yFormat, yLabel: opts.yLabel,
    });

    const barColor = opts.color ?? cssVar('--chart-accent', '#ff4655');
    const baseY = yScale(Math.max(0, Math.min(0, yDomain[1])));
    tipPoints = [];
    const gap = 0.18;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = cssVar('--chart-text', '#9aa4b2');
    ctx.font = '11px system-ui, -apple-system, sans-serif';

    d.forEach((bar, i) => {
      const x0 = xScale(i + gap);
      const x1 = xScale(i + 1 - gap);
      const py = yScale(bar.value);
      ctx.fillStyle = bar.color ?? barColor;
      ctx.fillRect(x0, Math.min(py, baseY), x1 - x0, Math.abs(py - baseY));
      ctx.fillStyle = cssVar('--chart-text', '#9aa4b2');
      ctx.fillText(bar.label, (x0 + x1) / 2, plot.y + plot.height + 6);
      tipPoints.push({ px: (x0 + x1) / 2, py, text: `${bar.label}: ${yFormat(bar.value)}` });
    });
  }

  render(data);
  container.appendChild(wrap);
  const detachTooltip = attachTooltip(canvas, tooltip, () => tipPoints);

  return {
    canvas,
    update: render,
    destroy: () => { detachTooltip(); wrap.remove(); },
  };
}

// ------------------------------------------------------- metric verdict bar --

export interface VerdictRow { metric: string; optimum: number; confidence: number; }

export interface VerdictChartOptions {
  width: number;
  height: number;
  /** Sensitivity axis range shared by every row. */
  domain: [number, number];
  xFormat?: (v: number) => string;
  /** Draws a vertical marker for the headline recommendation across all rows. */
  highlightValue?: number;
  highlightLabel?: string;
}

/** Horizontal per-metric bar: each row is a track spanning the sensitivity
 *  axis with a dot at that estimator's optimum, sized/opacity-coded by confidence. */
export function metricVerdictChart(container: HTMLElement, rows: VerdictRow[], opts: VerdictChartOptions): ChartHandle<VerdictRow[]> {
  const rowHeight = 30;
  const labelWidth = 140;
  const plotMargin = { top: 12, right: 20, bottom: 28 };
  const { ctx, canvas, wrap, tooltip } = chartShell(opts.width, opts.height);
  const xFormat = opts.xFormat ?? identityFormat;
  let tipPoints: TooltipPoint[] = [];

  function render(d: VerdictRow[]): void {
    ctx.clearRect(0, 0, opts.width, opts.height);
    const plotX = labelWidth;
    const plotWidth = opts.width - labelWidth - plotMargin.right;
    const xScale = scaleLinear(opts.domain, [plotX, plotX + plotWidth]);
    const axisColor = cssVar('--chart-axis', '#565f6b');
    const gridColor = cssVar('--chart-grid', '#242a31');
    const textColor = cssVar('--chart-text', '#9aa4b2');
    const accent = cssVar('--chart-accent', '#ff4655');

    ctx.font = '11px system-ui, -apple-system, sans-serif';
    tipPoints = [];

    d.forEach((row, i) => {
      const py = plotMargin.top + i * rowHeight + rowHeight / 2;
      ctx.fillStyle = textColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(row.metric, 0, py);

      ctx.strokeStyle = gridColor;
      ctx.beginPath();
      ctx.moveTo(plotX, py);
      ctx.lineTo(plotX + plotWidth, py);
      ctx.stroke();

      const px = xScale(row.optimum);
      const radius = 3 + row.confidence * 5;
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.35 + row.confidence * 0.65;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      tipPoints.push({ px, py, text: `${row.metric}: ${xFormat(row.optimum)} (confidence ${Math.round(row.confidence * 100)}%)` });
    });

    const axisY = plotMargin.top + d.length * rowHeight + 6;
    ctx.strokeStyle = axisColor;
    ctx.beginPath();
    ctx.moveTo(plotX, axisY);
    ctx.lineTo(plotX + plotWidth, axisY);
    ctx.stroke();
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of niceTicks(opts.domain, 4)) {
      const tx = xScale(t);
      ctx.beginPath();
      ctx.moveTo(tx, axisY);
      ctx.lineTo(tx, axisY + 4);
      ctx.stroke();
      ctx.fillText(xFormat(t), tx, axisY + 6);
    }

    if (opts.highlightValue != null) {
      const hx = xScale(opts.highlightValue);
      ctx.save();
      ctx.strokeStyle = cssVar('--chart-accent-2', '#5ce1e6');
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(hx, plotMargin.top - 4);
      ctx.lineTo(hx, axisY);
      ctx.stroke();
      if (opts.highlightLabel) {
        ctx.setLineDash([]);
        ctx.fillStyle = cssVar('--chart-accent-2', '#5ce1e6');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(opts.highlightLabel, hx, plotMargin.top - 6);
      }
      ctx.restore();
    }
  }

  render(rows);
  container.appendChild(wrap);
  const detachTooltip = attachTooltip(canvas, tooltip, () => tipPoints);

  return {
    canvas,
    update: render,
    destroy: () => { detachTooltip(); wrap.remove(); },
  };
}
