/**
 * The Valorant sensitivity pipeline: raw mouse counts -> shaped counts (via
 * rawaccel.ts) -> degrees -> yaw/pitch. This is the file the analyser's
 * accuracy claims ultimately rest on, so every step is kept explicit and in
 * the exact order Valorant applies them (see the field-by-field derivation
 * in constants.ts for where 0.07 deg/count comes from).
 */
import type { RawMouseDelta, SensConfig, Vec3 } from './types';
import { VALORANT_DEG_PER_COUNT, CM_PER_INCH, PITCH_LIMIT_DEG } from './constants';
import { anglesToDir, clamp } from './math';
import { applyCurve, observedGain } from './rawaccel';

export function degreesPerCount(sens: number): number {
  return VALORANT_DEG_PER_COUNT.value * sens;
}

/** Inches of physical mouse travel for a full 360 turn at (dpi, sens). */
export function inches360(dpi: number, sens: number): number {
  const degPerCount = degreesPerCount(sens);
  const countsPerInch = dpi;
  if (degPerCount <= 0 || countsPerInch <= 0) return Infinity;
  return 360 / (degPerCount * countsPerInch);
}

export function cm360(dpi: number, sens: number): number {
  return inches360(dpi, sens) * CM_PER_INCH;
}

export function eDPI(dpi: number, sens: number): number {
  return dpi * sens;
}

/** Inverse of {@link cm360}: the sensitivity that produces a given cm/360 at `dpi`. */
export function sensFromCm360(dpi: number, cm360Target: number): number {
  if (dpi <= 0 || cm360Target <= 0) return 0;
  return (360 * CM_PER_INCH) / (VALORANT_DEG_PER_COUNT.value * dpi * cm360Target);
}

/**
 * A browser mousemove's `movementY`-derived dt is occasionally garbage: 0 on
 * some drivers' first event after a stall, or huge after a tab was
 * backgrounded. Falling back to the nominal poll interval keeps a single bad
 * sample from producing a spurious speed spike (and thus a spurious
 * acceleration gain) that never happened on the physical mouse.
 */
function sanitizeDtMs(dtMs: number, pollingRateHz: number): number {
  if (!Number.isFinite(dtMs) || dtMs <= 0 || dtMs > 100) {
    return 1000 / Math.max(pollingRateHz, 1);
  }
  return dtMs;
}

/** Result of one mouse-delta step, carrying everything telemetry needs. */
export interface AimStep {
  /** Alias of `effectiveGain`, kept for call sites that only want one number. */
  gain: number;
  /** What this app multiplied by. 1 unless simulating a curve locally. */
  appliedGain: number;
  /** True count-to-degree gain, including driver-level acceleration. */
  effectiveGain: number;
  /** Hand speed in counts/ms with driver acceleration undone. */
  handSpeed: number;
  /** Speed of the counts as received, in counts/ms. */
  observedSpeed: number;
}

export class AimController {
  yaw: number;
  pitch: number;

  constructor(yaw = 0, pitch = 0) {
    this.yaw = yaw;
    this.pitch = clamp(pitch, -PITCH_LIMIT_DEG.value, PITCH_LIMIT_DEG.value);
  }

  reset(yaw: number, pitch: number): void {
    this.yaw = wrapYaw(yaw);
    this.pitch = clamp(pitch, -PITCH_LIMIT_DEG.value, PITCH_LIMIT_DEG.value);
  }

  direction(): Vec3 {
    return anglesToDir(this.yaw, this.pitch);
  }

  /**
   * Consume one raw mouse delta and rotate the camera. `adsSensMultiplier`
   * is the equipped weapon's `ads.sensMultiplier` (1 for an unscoped weapon
   * or when `scoped` is false); callers pull it from WeaponSpec since this
   * module has no notion of weapons.
   *
   * Order matters and is fixed here, matching Valorant's own pipeline:
   * speed -> curve gain -> degrees -> scope multiplier -> yaw/pitch update
   * -> clamp/wrap. Reordering any of these changes the numbers.
   */
  applyDelta(
    d: RawMouseDelta,
    cfg: SensConfig,
    scoped: boolean,
    adsSensMultiplier = 1,
  ): AimStep {
    const dtMs = Math.max(sanitizeDtMs(d.dtMs, cfg.pollingRateHz), 0.125);
    const curve = cfg.curve;
    const degPerCount = degreesPerCount(cfg.sensitivity);

    // `external` is the default because it is the real-world case: RawAccel is
    // a driver filter, so its curve is already baked into the counts we
    // receive. Applying it again here would accelerate twice.
    const simulating = cfg.rawAccelEnabled && cfg.rawAccelMode === 'simulated';
    const external = cfg.rawAccelEnabled && !simulating;

    // Speed of the counts as they arrived. Under `external` this is already
    // post-acceleration; under `simulated` it is the raw hand speed.
    const observedSpeed = (curve.applyToY ? Math.hypot(d.dx, d.dy) : Math.abs(d.dx)) / dtMs;

    // What the app itself multiplies by. Always 1 unless we are simulating —
    // this is the line that prevents double-acceleration.
    const appliedGain = simulating ? applyCurve(curve, observedSpeed) : 1;

    // What the count-to-degree relationship actually was, including anything
    // the driver did upstream. This is the number the analyser reasons about.
    const effectiveGain = external
      ? observedGain(curve, observedSpeed)
      : appliedGain;

    // Hand speed in counts/ms, with the driver's acceleration undone. Lets the
    // analyser report real physical hand distance even with accel active.
    const handSpeed = external ? observedSpeed / (effectiveGain || 1) : observedSpeed;

    let dxDeg = d.dx * degPerCount * appliedGain;
    let dyDeg: number;
    if (curve.applyToY || !simulating) {
      // "Whole" mode, or any non-simulating mode: both axes share one factor,
      // so a diagonal flick is never sheared.
      dyDeg = d.dy * degPerCount * appliedGain;
    } else {
      // Simulated "By Component": only X is accelerated; Y passes through at
      // the flat multiplier so vertical tracking never accelerates.
      dyDeg = d.dy * degPerCount * curve.sensMultiplier;
    }

    if (scoped) {
      const scopeMul = cfg.scopedMultiplier * adsSensMultiplier;
      dxDeg *= scopeMul;
      dyDeg *= scopeMul;
    }

    // Mouse-right (+dx) turns the view right, i.e. toward -yaw under
    // math.ts's +yaw-turns-left convention.
    this.yaw -= dxDeg;
    // Mouse-down (+dy) looks down, i.e. toward -pitch, unless inverted.
    this.pitch += cfg.invertY ? dyDeg : -dyDeg;

    this.pitch = clamp(this.pitch, -PITCH_LIMIT_DEG.value, PITCH_LIMIT_DEG.value);
    this.yaw = wrapYaw(this.yaw);

    return { gain: effectiveGain, appliedGain, effectiveGain, handSpeed, observedSpeed };
  }
}

/** Wrap yaw into [-180, 180) without quantising - float in, float out. */
function wrapYaw(yaw: number): number {
  let y = yaw % 360;
  if (y >= 180) y -= 360;
  if (y < -180) y += 360;
  return y;
}
