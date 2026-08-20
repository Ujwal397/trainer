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
import { applyCurve } from './rawaccel';

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
  ): { gain: number } {
    const dtMs = Math.max(sanitizeDtMs(d.dtMs, cfg.pollingRateHz), 0.125);
    const curve = cfg.curve;
    const degPerCount = degreesPerCount(cfg.sensitivity);

    let gain: number;
    let dxDeg: number;
    let dyDeg: number;

    if (curve.applyToY) {
      // "Whole" mode: the curve reacts to the combined 2D speed and reshapes
      // both axes by the same gain, so a diagonal flick isn't sheared.
      const inputSpeed = Math.hypot(d.dx, d.dy) / dtMs;
      gain = cfg.rawAccelEnabled ? applyCurve(curve, inputSpeed) : 1;
      dxDeg = d.dx * degPerCount * gain;
      dyDeg = d.dy * degPerCount * gain;
    } else {
      // "By Component" mode: only X drives the curve; Y is passed through
      // at the flat sensMultiplier so vertical tracking never accelerates.
      //
      // Y must fall back to 1 (not sensMultiplier) when RawAccel is off,
      // or toggling the feature would leave vertical scaled while horizontal
      // is 1:1 -- desynced axes, and a silent break of the guarantee that
      // RawAccel off means pure, unmodified Valorant sensitivity.
      const inputSpeedX = Math.abs(d.dx) / dtMs;
      gain = cfg.rawAccelEnabled ? applyCurve(curve, inputSpeedX) : 1;
      dxDeg = d.dx * degPerCount * gain;
      dyDeg = d.dy * degPerCount * (cfg.rawAccelEnabled ? curve.sensMultiplier : 1);
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

    return { gain };
  }
}

/** Wrap yaw into [-180, 180) without quantising - float in, float out. */
function wrapYaw(yaw: number): number {
  let y = yaw % 360;
  if (y >= 180) y -= 360;
  if (y < -180) y += 360;
  return y;
}
