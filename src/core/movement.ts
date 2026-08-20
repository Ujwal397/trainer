/**
 * Player/target ground movement, modelled after Valorant's near-instant
 * accel/decel (as opposed to Source-engine-style momentum): releasing a
 * direction key kills your velocity within STOP_TIME_MS, which is the whole
 * mechanic behind counter-strafing for first-shot accuracy. See
 * `movementInaccuracyFactor` for how the weapon spread system consumes the
 * resulting speed.
 */
import type { Vec3 } from './types';
import { v3, add, sub, scale, clamp, lengthSq } from './math';
import { ACCEL_TIME_MS, STOP_TIME_MS, GRAVITY_MS2, JUMP_VELOCITY_MS, RUN_SPEED_MS } from './constants';

/**
 * Wish direction is world-space (already resolved from camera yaw + WASD by
 * the caller), not view-relative - this keeps movement.ts orientation-free
 * and avoids re-deriving yaw math that sensitivity.ts already owns. Need not
 * be normalized; {0,0} means no directional input.
 */
export interface MoveInput {
  wishX: number;
  wishZ: number;
  jumpPressed: boolean;
  crouch: boolean;
}

export interface AABB { min: Vec3; max: Vec3; }

/**
 * Per-axis rate the velocity should approach its target at. Treating x/z
 * independently (rather than the true 2D wish vector) is a deliberate
 * simplification - real Valorant strafing is axis-aligned via WASD often
 * enough that this reproduces counter-strafe timing correctly for the
 * dominant case, at the cost of diagonal moves decelerating slightly
 * differently than a full vector treatment would.
 */
function axisRate(current: number, target: number, accelRate: number, decelRate: number): number {
  if (current === 0) return accelRate; // starting from rest always ramps up
  if (target === 0) return decelRate; // releasing input always ramps down fast (counter-strafe stop)
  const sameDirection = Math.sign(current) === Math.sign(target);
  if (!sameDirection) return decelRate; // reversing direction cancels momentum fast
  return Math.abs(target) >= Math.abs(current) ? accelRate : decelRate;
}

function approachAxis(current: number, target: number, rate: number, dtSec: number): number {
  const diff = target - current;
  const maxStep = rate * dtSec;
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

export class MoveState {
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  crouching: boolean;

  constructor(position: Vec3 = v3()) {
    this.position = { ...position };
    this.velocity = v3();
    this.grounded = true;
    this.crouching = false;
  }

  /** Horizontal (XZ) speed, m/s - what spread/recoil systems care about. */
  speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  jump(): void {
    if (!this.grounded) return;
    this.velocity.y = JUMP_VELOCITY_MS.value;
    this.grounded = false;
  }

  /**
   * Advance one simulation step. `speedCap` is the max horizontal speed for
   * the current state (walking/running/weapon-encumbered) - callers pick it
   * before calling step(), since that logic depends on weapon data this
   * module doesn't own.
   */
  step(input: MoveInput, dtSec: number, speedCap: number): void {
    this.crouching = input.crouch;
    if (input.jumpPressed) this.jump();

    const wishLenSq = input.wishX * input.wishX + input.wishZ * input.wishZ;
    const invLen = wishLenSq > 1e-12 ? 1 / Math.sqrt(wishLenSq) : 0;
    const targetX = input.wishX * invLen * speedCap;
    const targetZ = input.wishZ * invLen * speedCap;

    const accelRate = speedCap / (ACCEL_TIME_MS.value / 1000);
    const decelRate = speedCap / (STOP_TIME_MS.value / 1000);

    const rateX = axisRate(this.velocity.x, targetX, accelRate, decelRate);
    const rateZ = axisRate(this.velocity.z, targetZ, accelRate, decelRate);
    this.velocity.x = approachAxis(this.velocity.x, targetX, rateX, dtSec);
    this.velocity.z = approachAxis(this.velocity.z, targetZ, rateZ, dtSec);

    if (!this.grounded) {
      this.velocity.y += GRAVITY_MS2.value * dtSec;
    }

    this.position = add(this.position, scale(this.velocity, dtSec));

    // Feet-at-origin ground plane (matches the hitbox capsules' convention).
    if (this.position.y <= 0) {
      this.position.y = 0;
      this.velocity.y = 0;
      this.grounded = true;
    }
  }
}

/**
 * 0..1 multiplier for the weapon spread system's movement-induced spread
 * (walking/running/jumping entries in SpreadSpec); 0 = fully stationary and
 * accurate. Valorant doesn't publish the exact curve, so this is modelled
 * as: airborne is always maximum inaccuracy, otherwise inaccuracy scales
 * linearly with speed relative to run speed, damped while crouched (crouch
 * is markedly more accurate than standing at the same speed in-game).
 */
export function movementInaccuracyFactor(speed: number, grounded: boolean, crouching: boolean): number {
  if (!grounded) return 1;
  const normalized = clamp(speed / RUN_SPEED_MS.value, 0, 1);
  const crouchDamping = crouching ? 0.5 : 1;
  return clamp(normalized * crouchDamping, 0, 1);
}

/**
 * Resolve a spherical player/target of `radius` against a set of AABBs,
 * sliding along any surface it penetrates rather than stopping dead. Cheap
 * closest-point-on-box test per box; fine for the handful of level-geometry
 * boxes a training map needs (not a general broadphase).
 */
export function resolveCollision(
  pos: Vec3,
  vel: Vec3,
  radius: number,
  boxes: readonly AABB[],
): { position: Vec3; velocity: Vec3 } {
  let p = { ...pos };
  let v = { ...vel };

  for (const box of boxes) {
    const closest: Vec3 = {
      x: clamp(p.x, box.min.x, box.max.x),
      y: clamp(p.y, box.min.y, box.max.y),
      z: clamp(p.z, box.min.z, box.max.z),
    };
    const delta = sub(p, closest);
    const distSq = lengthSq(delta);
    if (distSq >= radius * radius) continue; // not penetrating this box

    let normal: Vec3;
    let penetration: number;
    if (distSq > 1e-12) {
      const dist = Math.sqrt(distSq);
      normal = scale(delta, 1 / dist);
      penetration = radius - dist;
    } else {
      // Center is exactly on/inside the box surface (distSq ~ 0): push out
      // along whichever face is closest rather than dividing by ~0.
      const px = Math.min(p.x - box.min.x, box.max.x - p.x);
      const py = Math.min(p.y - box.min.y, box.max.y - p.y);
      const pz = Math.min(p.z - box.min.z, box.max.z - p.z);
      if (px <= py && px <= pz) {
        normal = { x: p.x - box.min.x <= box.max.x - p.x ? -1 : 1, y: 0, z: 0 };
      } else if (py <= pz) {
        normal = { x: 0, y: p.y - box.min.y <= box.max.y - p.y ? -1 : 1, z: 0 };
      } else {
        normal = { x: 0, y: 0, z: p.z - box.min.z <= box.max.z - p.z ? -1 : 1 };
      }
      penetration = radius;
    }

    p = add(p, scale(normal, penetration));

    // Slide: drop the velocity component driving further into the wall,
    // keep the tangential component so movement along the surface continues.
    const into = v.x * normal.x + v.y * normal.y + v.z * normal.z;
    if (into < 0) {
      v = sub(v, scale(normal, into));
    }
  }

  return { position: p, velocity: v };
}
