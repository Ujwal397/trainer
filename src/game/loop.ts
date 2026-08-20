/**
 * Fixed-step simulation with interpolated rendering.
 *
 * Aim training is a measurement instrument: if the simulation stepped at the
 * display's frame rate, every recorded angle would depend on the frame rate,
 * and sessions taken at 144fps could not be compared with sessions at 60fps.
 * A fixed step makes the physics identical on every machine; `alpha` lets the
 * renderer interpolate so it still looks smooth.
 */
import { SIM_STEP_MS } from '../core/constants';

export interface LoopCallbacks {
  onFixedStep(dtSec: number, nowMs: number): void;
  onRender(alpha: number, nowMs: number): void;
}

/**
 * Cap on catch-up steps per frame. Without it, a tab that was backgrounded for
 * a minute returns with 15000 steps of debt, blocks the main thread trying to
 * pay it, falls further behind, and never recovers — the spiral of death. We
 * drop the excess instead: a stutter is recoverable, a hang is not.
 */
const MAX_STEPS_PER_FRAME = 5;

export class GameLoop {
  private readonly cb: LoopCallbacks;
  private readonly stepMs: number;

  private rafId = 0;
  private running = false;
  private paused = false;
  private lastTime = 0;
  /** Unconsumed real time, milliseconds. Single float; steps are subtracted exactly. */
  private accumulator = 0;
  /** Simulation clock. Advances only in whole steps, so it never drifts from the step count. */
  private simTime = 0;

  constructor(cb: LoopCallbacks, stepMs: number = SIM_STEP_MS) {
    this.cb = cb;
    this.stepMs = stepMs;
  }

  get isRunning(): boolean { return this.running && !this.paused; }
  get simulationTimeMs(): number { return this.simTime; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  /** Pausing does not accumulate time, so resuming never triggers catch-up. */
  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.lastTime = performance.now();
    this.accumulator = 0;
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    if (this.paused) {
      // Keep painting while paused so the pause overlay composites over a live
      // frame, but advance nothing.
      this.cb.onRender(0, this.simTime);
      this.lastTime = now;
      return;
    }

    const elapsed = now - this.lastTime;
    this.lastTime = now;

    // Guard against a negative or absurd delta from a clock adjustment or a
    // tab restore; treat it as a single frame rather than trusting it.
    this.accumulator += elapsed > 0 && elapsed < 1000 ? elapsed : this.stepMs;

    let steps = 0;
    const dtSec = this.stepMs / 1000;
    while (this.accumulator >= this.stepMs && steps < MAX_STEPS_PER_FRAME) {
      this.simTime += this.stepMs;
      this.cb.onFixedStep(dtSec, this.simTime);
      this.accumulator -= this.stepMs;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0; // drop the debt

    this.cb.onRender(this.accumulator / this.stepMs, this.simTime);
  };
}
