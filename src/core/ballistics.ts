/**
 * Firing simulation: ammo/reload/trigger state machine, spread growth, recoil
 * pattern playback, and the final bullet-direction math.
 *
 * IMPORTANT SEMANTICS (Valorant, not a camera-recoil shooter): recoil moves
 * where the *bullets* land relative to a crosshair that does not itself
 * move. The player compensates by pulling the mouse down; we never rotate
 * the camera here. `currentRecoil` is exposed only so the HUD can optionally
 * draw a recoil-compensation guide.
 */
import type { Vec2, Vec3, WeaponSpec, FireMode } from './types';
import { clamp, offsetDir } from './math';
import type { Rng } from './rng';

export interface FireResult {
  /** Cumulative pattern + jitter offset applied to this shot, degrees. */
  recoil: Vec2;
  /** Spread cone half-angle this shot was drawn from, degrees. */
  spreadDeg: number;
  /** This shot's sampled offset within the spread cone, degrees. */
  spreadOffset: Vec2;
}

/**
 * Combines a deterministic recoil-pattern offset with a randomly-sampled
 * spread offset to get the final bullet direction. Both offsets are treated
 * as (yaw, pitch)-style deviations in the pattern's screen-space convention
 * (+x = right, +y = up); `offsetDir`'s yaw is +left (see math.ts), so the
 * screen-right component is negated before being handed to it.
 */
export function applyRecoilAndSpread(aimDir: Vec3, recoil: Vec2, spreadOffset: Vec2): Vec3 {
  const totalRight = recoil.x + spreadOffset.x;
  const totalUp = recoil.y + spreadOffset.y;
  return offsetDir(aimDir, -totalRight, totalUp);
}

/** Piecewise-linear map from a single 0..1 movement-inaccuracy factor (owned
 *  by movement.ts) onto the weapon's discrete movement spread values.
 *  SpreadSpec keeps separate standing/walking/running/jumping numbers; the
 *  movement system collapses them into one scalar, so we interpolate through
 *  them in that order.
 *
 *  Crouch is passed separately rather than folded into the factor because it
 *  is not a point on the movement continuum -- a crouching player is *more*
 *  accurate than a standing one at the same speed, so blending it into a
 *  monotonic 0..1 ramp would model it backwards. */
function movementSpreadDeg(spec: WeaponSpec, movementFactor: number, crouching: boolean): number {
  const f = clamp(movementFactor, 0, 1);
  const s = spec.spread;
  const stationary = crouching ? s.crouchingDeg : s.standingDeg;
  if (f <= 1 / 3) return stationary + (s.walkingDeg - stationary) * (f / (1 / 3));
  if (f <= 2 / 3) return s.walkingDeg + (s.runningDeg - s.walkingDeg) * ((f - 1 / 3) / (1 / 3));
  return s.runningDeg + (s.jumpingDeg - s.runningDeg) * ((f - 2 / 3) / (1 / 3));
}

/**
 * Samples a point uniformly *by area* within a disc of radius `spreadDeg`.
 * Exported separately from `fire` so the uniformity property (area, not
 * radius, must be uniform) is directly testable: a naive `r = spreadDeg *
 * rng.next()` would bias samples toward the centre, since a ring's area
 * grows with r^2 -- taking the square root of the uniform draw for the
 * radius is what corrects that.
 */
export function sampleSpreadOffset(spreadDeg: number, rng: Rng): Vec2 {
  const angle = rng.range(0, 2 * Math.PI);
  const r = spreadDeg * Math.sqrt(rng.next());
  return { x: r * Math.cos(angle), y: r * Math.sin(angle) };
}

/** Looks up the cumulative recoil offset for shot index `i`, looping the
 *  tail segment (from `loopFromIndex` onward) once the table is exhausted. */
export function recoilForIndex(pattern: Vec2[], loopFromIndex: number, i: number): Vec2 {
  if (pattern.length === 0) return { x: 0, y: 0 };
  if (i < pattern.length) return pattern[i]!;
  const loopStart = clamp(loopFromIndex, 0, pattern.length - 1);
  const loopLen = pattern.length - loopStart;
  const idx = loopStart + ((i - pattern.length) % loopLen);
  return pattern[idx]!;
}

export class WeaponState {
  readonly spec: WeaponSpec;

  ammo: number;
  reserve: number;
  /** Index into the recoil pattern / spray-growth counter for the current
   *  "hot" streak; resets to 0 once recoil has fully recovered. */
  shotIndex = 0;
  lastShotTime = -Infinity;
  /** Spread half-angle accumulated from consecutive shots (movement spread
   *  is added on top at fire time, not stored here). */
  currentSpread = 0;
  /** Cumulative recoil offset applied by the most recent shot, for HUD use. */
  currentRecoil: Vec2 = { x: 0, y: 0 };
  reloading = false;
  scoped = false;
  /**
   * Practice mode: the magazine never empties and reloads are unnecessary.
   * Recoil and spread still behave exactly as normal — only the ammo counter
   * is bypassed, so spray discipline is unaffected and what you learn here
   * still transfers.
   */
  infiniteAmmo = false;
  scopeLevel = 0;

  private reloadEndsAt = -Infinity;
  private equippedAt = -Infinity;
  private lastUpdateTime = -Infinity;
  private lastMovementFactor = 0;
  private lastCrouching = false;
  /** Semi/burst weapons require the trigger to be released and re-pressed
   *  between shots; starts `true` (ready) so the first shot is always legal. */
  private triggerReady = true;
  private burstRemaining = 0;
  private burstNextTime = -Infinity;

  constructor(spec: WeaponSpec) {
    this.spec = spec;
    this.ammo = spec.magazine;
    this.reserve = spec.reserveAmmo;
  }

  /** Marks the weapon as just equipped; `canFire` gates on `equipTimeMs` from here. */
  equip(now: number): void {
    this.equippedAt = now;
  }

  /** Input layer calls this on mouse-up so the next `semi`/`burst` shot is legal. */
  releaseTrigger(): void {
    this.triggerReady = true;
  }

  canFire(now: number): boolean {
    if (this.reloading) return false;
    if (this.ammo <= 0 && !this.infiniteAmmo) return false;
    if (now - this.equippedAt < this.spec.equipTimeMs) return false;

    const interval = 1000 / this.spec.fireRate;
    const mode: FireMode = this.spec.fireMode;

    if (mode === 'auto') {
      return now - this.lastShotTime >= interval;
    }
    if (mode === 'semi') {
      return this.triggerReady && now - this.lastShotTime >= interval;
    }
    // burst: either continuing a burst-in-progress, or starting a fresh one.
    if (this.burstRemaining > 0) {
      return now >= this.burstNextTime;
    }
    return this.triggerReady && now - this.lastShotTime >= interval;
  }

  /**
   * Fires one round. Returns `null` (and changes nothing) if `canFire(now)`
   * is false -- callers must check, or accept a no-op.
   */
  fire(now: number, rng: Rng): FireResult | null {
    if (!this.canFire(now)) return null;

    const spec = this.spec;
    if (!this.infiniteAmmo) this.ammo -= 1;
    this.lastShotTime = now;

    if (spec.fireMode === 'semi') {
      this.triggerReady = false;
    } else if (spec.fireMode === 'burst') {
      if (this.burstRemaining <= 0) {
        this.burstRemaining = (spec.burstCount ?? 3) - 1;
        this.triggerReady = false;
      } else {
        this.burstRemaining -= 1;
      }
      this.burstNextTime = now + (spec.burstDelayMs ?? 0);
    }

    // --- recoil: deterministic pattern + uniform random jitter -----------
    const patternOffset = recoilForIndex(spec.recoil.pattern, spec.recoil.loopFromIndex, this.shotIndex);
    const jitterX = rng.range(-spec.recoil.randomYawDeg, spec.recoil.randomYawDeg);
    const jitterY = rng.range(-spec.recoil.randomPitchDeg, spec.recoil.randomPitchDeg);
    const recoil: Vec2 = { x: patternOffset.x + jitterX, y: patternOffset.y + jitterY };
    this.currentRecoil = recoil;

    // --- spread: pinpoint first shot while stationary, else movement + growth
    const isFirstShotOfSpray = this.shotIndex === 0;
    const isStationary = this.lastMovementFactor <= 0;
    const spreadDeg =
      isFirstShotOfSpray && isStationary
        ? spec.spread.firstShotDeg
        : clamp(
            movementSpreadDeg(spec, this.lastMovementFactor, this.lastCrouching) + this.currentSpread,
            0,
            spec.spread.maxSpreadDeg,
          );

    const spreadOffset = sampleSpreadOffset(spreadDeg, rng);

    // Grow persistent spray spread for the *next* shot, clamped to max.
    this.currentSpread = clamp(this.currentSpread + spec.spread.perShotGrowthDeg, 0, spec.spread.maxSpreadDeg);
    this.shotIndex += 1;

    return { recoil, spreadDeg, spreadOffset };
  }

  /**
   * Per-frame upkeep: recovers spread/recoil after their delays elapse, and
   * remembers `movementFactor` (0..1, from movement.ts) and crouch state for
   * the next `fire` call to use. Also finalises a completed reload.
   */
  update(now: number, movementFactor: number, crouching = false): void {
    const dtMs = this.lastUpdateTime === -Infinity ? 0 : Math.max(0, now - this.lastUpdateTime);
    this.lastUpdateTime = now;
    this.lastMovementFactor = clamp(movementFactor, 0, 1);
    this.lastCrouching = crouching;

    if (this.reloading && now >= this.reloadEndsAt) {
      const needed = this.spec.magazine - this.ammo;
      const taken = Math.min(needed, this.reserve);
      this.ammo += taken;
      this.reserve -= taken;
      this.reloading = false;
    }

    const timeSinceShot = now - this.lastShotTime;

    if (timeSinceShot >= this.spec.spread.recoveryDelayMs && this.currentSpread > 0) {
      const decay = (this.spec.spread.recoveryDegPerSec * dtMs) / 1000;
      this.currentSpread = Math.max(0, this.currentSpread - decay);
    }

    if (timeSinceShot >= this.spec.recoil.recoveryDelayMs) {
      const decay = (this.spec.recoil.recoveryDegPerSec * dtMs) / 1000;
      const mag = Math.hypot(this.currentRecoil.x, this.currentRecoil.y);
      if (mag > 0) {
        const shrink = Math.max(0, mag - decay) / mag;
        this.currentRecoil = { x: this.currentRecoil.x * shrink, y: this.currentRecoil.y * shrink };
      }
      // Once both recoil and spray growth have fully bled off, the next
      // trigger pull is a fresh spray from the top of the pattern.
      if (this.currentRecoil.x === 0 && this.currentRecoil.y === 0 && this.currentSpread === 0) {
        this.shotIndex = 0;
      }
    }
  }

  reload(now: number): void {
    if (this.infiniteAmmo) return;
    if (this.reloading || this.ammo >= this.spec.magazine || this.reserve <= 0) return;
    this.reloading = true;
    this.reloadEndsAt = now + this.spec.reloadTimeMs;
  }

  startScope(level = 0): void {
    if (!this.spec.ads) return;
    this.scoped = true;
    this.scopeLevel = clamp(level, 0, this.spec.ads.zoomFovDeg.length - 1);
  }

  stopScope(): void {
    this.scoped = false;
    this.scopeLevel = 0;
  }
}
