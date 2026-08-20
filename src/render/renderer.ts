/**
 * Owns the three.js WebGLRenderer/Scene/Camera and the render-time clock.
 *
 * This is the only place in `src/render` that talks to `WebGLRenderer`
 * directly. Everything else (targets, maps) just adds objects to `.scene`.
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import { DEFAULT_HFOV_DEG, EYE_HEIGHT_M } from '../core/constants';
import { DEG, RAD, clamp } from '../core/math';

export interface FrameStats {
  fps: number;
  frameTimeMs: number;
}

/**
 * Rolling-average window (ms) for the frame-time EMA below. Short enough to
 * react to real stutter, long enough that a single dropped frame doesn't
 * make the HUD readout jump around.
 */
const FRAME_STAT_SMOOTHING = 0.08;

export class Renderer {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private readonly gl: THREE.WebGLRenderer;
  private container: HTMLElement | null = null;

  // Scratch objects reused every call so setCameraOrientation/render never
  // allocate on the hot path (see class-level pooling rule in targets.ts too).
  private readonly scratchEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  private _frameStats: FrameStats = { fps: 0, frameTimeMs: 0 };
  private lastFrameAt = 0;
  private lastAlpha = 0;
  private _contextLost = false;

  private readonly handleResize = (): void => this.resize();
  private readonly handleContextLost = (e: Event): void => {
    // Without preventDefault() the browser never fires 'webglcontextrestored'.
    e.preventDefault();
    this._contextLost = true;
  };
  private readonly handleContextRestored = (): void => {
    this._contextLost = false;
  };

  constructor() {
    this.scene = new THREE.Scene();

    // aspect/fov are placeholders — resize() computes the real vertical FOV
    // from the fixed horizontal FOV as soon as this is mounted.
    this.camera = new THREE.PerspectiveCamera(90, 16 / 9, 0.05, 300);
    this.camera.position.set(0, EYE_HEIGHT_M.value, 0);

    this.gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // Beyond 2x DPR the extra fill-rate cost buys imperceptible sharpness but
    // very real frame-time cost — cap it.
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // Flat, undistorted colour: this is an aim trainer, not a mood piece.
    // Tone mapping would bend the deliberately flat/high-contrast materials
    // in maps.ts and targets.ts away from their authored colours.
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;

    const canvas = this.gl.domElement;
    canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);
  }

  /** Attaches the canvas to the DOM and sizes it to fill `container`. */
  mount(container: HTMLElement): void {
    this.container = container;
    container.appendChild(this.gl.domElement);
    window.addEventListener('resize', this.handleResize);
    this.resize();
  }

  get domElement(): HTMLCanvasElement {
    return this.gl.domElement;
  }

  get isContextLost(): boolean {
    return this._contextLost;
  }

  private resize(): void {
    if (!this.container) return;
    const width = Math.max(1, this.container.clientWidth || window.innerWidth);
    const height = Math.max(1, this.container.clientHeight || window.innerHeight);
    this.gl.setSize(width, height, true);
    this.updateProjection(width / height);
  }

  /**
   * CRITICAL: Valorant's FOV setting is a fixed 103-degree HORIZONTAL field
   * of view (at 16:9, and it stays that horizontal value at other aspect
   * ratios too — Valorant does not use Hor+/Vert- like some engines, it
   * keeps horizontal FOV constant and lets vertical FOV vary with aspect).
   * three.js's PerspectiveCamera.fov is the VERTICAL field of view. Passing
   * 103 straight into `camera.fov` would make the game roughly 103 degrees
   * tall instead of wide — every on-screen angle, every flick distance,
   * every crosshair-to-target relationship would be wrong, and the whole
   * trainer's angular measurements (which the analyser depends on) would be
   * silently invalid. We must convert:
   *
   *   vfov = 2 * atan( tan(hfov / 2) / aspect )
   *
   * and recompute it on every resize, because aspect changes as the window
   * changes shape but the horizontal FOV must not.
   */
  private updateProjection(aspect: number): void {
    const hfovRad = DEFAULT_HFOV_DEG.value * DEG;
    const vfovRad = 2 * Math.atan(Math.tan(hfovRad / 2) / aspect);
    this.camera.fov = vfovRad * RAD;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Orients the camera from yaw/pitch using the exact convention in
   * `core/math.ts#anglesToDir` (yaw 0 looks down -z, +yaw turns left, +y up).
   *
   * We build the rotation directly from a fixed-order Euler (YXZ, roll
   * always 0) instead of `camera.lookAt(movingTarget)`. lookAt re-derives
   * orientation from two points every call and, with a `target` that moves
   * frame to frame (e.g. eyePos + anglesToDir), floating point error and any
   * incidental up-vector skew can accumulate into roll drift over a long
   * session. A YXZ Euler with z pinned to 0 makes roll drift structurally
   * impossible: there is no basis in which this camera can ever tilt.
   */
  setCameraOrientation(yaw: number, pitch: number, eyePos: Vec3): void {
    this.scratchEuler.set(pitch * DEG, yaw * DEG, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(this.scratchEuler);
    this.camera.position.set(eyePos.x, eyePos.y, eyePos.z);
  }

  /**
   * Renders one frame. `alpha` is the fixed-step interpolation factor
   * (0..1) between the last simulated tick and the next one; callers pass it
   * through so render-layer consumers that need it (currently `TargetPool`)
   * can stay in lockstep with this frame without us re-deriving it.
   */
  render(alpha: number): void {
    this.lastAlpha = clamp(alpha, 0, 1);
    if (this._contextLost) return;

    const now = performance.now();
    if (this.lastFrameAt > 0) {
      const dt = now - this.lastFrameAt;
      // Exponential moving average: O(1) and allocation-free, unlike a ring
      // buffer, while still smoothing out single-frame spikes for the HUD.
      const prevMs = this._frameStats.frameTimeMs;
      const smoothedMs = prevMs === 0 ? dt : prevMs + (dt - prevMs) * FRAME_STAT_SMOOTHING;
      this._frameStats = { frameTimeMs: smoothedMs, fps: smoothedMs > 0 ? 1000 / smoothedMs : 0 };
    }
    this.lastFrameAt = now;

    this.gl.render(this.scene, this.camera);
  }

  get frameStats(): FrameStats {
    return this._frameStats;
  }

  /** Last alpha passed to {@link render}, exposed for render-layer consumers. */
  get lastRenderAlpha(): number {
    return this.lastAlpha;
  }

  dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    const canvas = this.gl.domElement;
    canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    if (this.container && canvas.parentElement === this.container) {
      this.container.removeChild(canvas);
    }
    this.gl.dispose();
  }
}
