/**
 * A Valorant-style crosshair drawn to a 2D canvas overlay.
 *
 * Deliberately NOT three.js: the crosshair is screen-space UI, always
 * exactly centred regardless of camera FOV/aspect, and cheaper to draw on a
 * canvas than to fight an orthographic overlay scene for. It only redraws
 * on config/error changes, not every render frame — a static crosshair
 * costs nothing once painted.
 */

export interface LineSpec {
  enabled: boolean;
  /** 0..1 */
  opacity: number;
  lengthPx: number;
  thicknessPx: number;
  /** Gap from the exact centre to the start of the line, pixels. */
  offsetPx: number;
}

export interface DotSpec {
  enabled: boolean;
  opacity: number;
  /** Diameter, pixels. */
  thicknessPx: number;
}

export interface OutlineSpec {
  enabled: boolean;
  opacity: number;
  /** Outline thickness added on each side of a line/dot, pixels. */
  thicknessPx: number;
}

export interface CrosshairConfig {
  /** CSS colour string, e.g. '#ffffff' or 'rgba(0,255,0,1)'. */
  color: string;
  outlines: OutlineSpec;
  centerDot: DotSpec;
  innerLines: LineSpec;
  outerLines: LineSpec;
  /** Whether the caller intends to widen the crosshair via setError() while the player is moving. Informational — the actual widening happens through setError. */
  showErrorOnMove: boolean;
  /** Same, for firing / spread bloom. */
  showErrorOnFire: boolean;
}

/** Approximates Valorant's classic default profile: white, thin inner lines, no dot, no outer lines. */
export const DEFAULT_CROSSHAIR: CrosshairConfig = {
  color: '#ffffff',
  outlines: { enabled: true, opacity: 0.5, thicknessPx: 1 },
  centerDot: { enabled: false, opacity: 1, thicknessPx: 2 },
  innerLines: { enabled: true, opacity: 0.85, lengthPx: 6, thicknessPx: 2, offsetPx: 3 },
  outerLines: { enabled: false, opacity: 0.35, lengthPx: 2, thicknessPx: 2, offsetPx: 10 },
  showErrorOnMove: true,
  showErrorOnFire: true,
};

const DIRS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: -1, dy: 0 }, { dx: 1, dy: 0 }, { dx: 0, dy: -1 }, { dx: 0, dy: 1 },
];

export class Crosshair {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private container: HTMLElement | null = null;
  private config: CrosshairConfig;
  /** Current dynamic spread/error, in pixels, added to inner/outer offsets. */
  private errorPx = 0;
  private dpr = 1;

  private readonly handleResize = (): void => this.resize();

  constructor(config: CrosshairConfig = DEFAULT_CROSSHAIR) {
    this.config = config;
    this.canvas = document.createElement('canvas');
    // Screen-space overlay: fixed, full-viewport, click-through, above everything else.
    Object.assign(this.canvas.style, {
      position: 'fixed', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '50',
    } satisfies Partial<CSSStyleDeclaration>);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Crosshair: 2D canvas context unavailable');
    this.ctx = ctx;
  }

  mount(container: HTMLElement): void {
    this.container = container;
    container.appendChild(this.canvas);
    window.addEventListener('resize', this.handleResize);
    this.resize();
  }

  private resize(): void {
    if (!this.container) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.canvas.width = Math.max(1, Math.round(width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(height * this.dpr));
    this.redraw();
  }

  setConfig(config: CrosshairConfig): void {
    this.config = config;
    this.redraw();
  }

  updateConfig(patch: Partial<CrosshairConfig>): void {
    this.config = { ...this.config, ...patch };
    this.redraw();
  }

  getConfig(): CrosshairConfig {
    return this.config;
  }

  /** Wire this to weapon spread: expands inner/outer line offsets by `pixels`. */
  setError(pixels: number): void {
    if (pixels === this.errorPx) return;
    this.errorPx = pixels;
    this.redraw();
  }

  private redraw(): void {
    const { ctx } = this;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w / (2 * this.dpr);
    const cy = h / (2 * this.dpr);
    const cfg = this.config;

    this.drawLineGroup(cx, cy, cfg.innerLines, cfg.outlines);
    this.drawLineGroup(cx, cy, cfg.outerLines, cfg.outlines);
    this.drawDot(cx, cy, cfg.centerDot, cfg.outlines);

    ctx.globalAlpha = 1;
  }

  private drawLineGroup(cx: number, cy: number, spec: LineSpec, outline: OutlineSpec): void {
    if (!spec.enabled || spec.lengthPx <= 0) return;
    const { ctx } = this;
    const offset = spec.offsetPx + this.errorPx;

    for (const d of DIRS) {
      const x1 = cx + d.dx * offset;
      const y1 = cy + d.dy * offset;
      const x2 = cx + d.dx * (offset + spec.lengthPx);
      const y2 = cy + d.dy * (offset + spec.lengthPx);

      if (outline.enabled) {
        ctx.strokeStyle = '#000000';
        ctx.globalAlpha = outline.opacity;
        ctx.lineWidth = spec.thicknessPx + outline.thicknessPx * 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      ctx.strokeStyle = this.config.color;
      ctx.globalAlpha = spec.opacity;
      ctx.lineWidth = spec.thicknessPx;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  private drawDot(cx: number, cy: number, spec: DotSpec, outline: OutlineSpec): void {
    if (!spec.enabled || spec.thicknessPx <= 0) return;
    const { ctx } = this;
    const r = spec.thicknessPx / 2;

    if (outline.enabled) {
      ctx.fillStyle = '#000000';
      ctx.globalAlpha = outline.opacity;
      ctx.beginPath();
      ctx.arc(cx, cy, r + outline.thicknessPx, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = this.config.color;
    ctx.globalAlpha = spec.opacity;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    if (this.container && this.canvas.parentElement === this.container) {
      this.container.removeChild(this.canvas);
    }
  }
}
