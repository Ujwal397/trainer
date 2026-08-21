/**
 * Scenario simulation: spawning, target behaviour and visibility.
 *
 * Engine-agnostic by rule — no three.js, no DOM. The renderer reads
 * `targets` and draws them; it never drives them. That separation is what
 * lets the desktop port reuse this file untouched.
 */
import type {
  AgentHitbox, ScenarioDef, TargetBehavior, TargetState, Vec3,
} from '../types';
import {
  BASE_HEALTH, HEAVY_SHIELD, RUN_SPEED_MS, STANDING_HITBOX, STOP_TIME_MS,
} from '../constants';
import { clamp, cross, normalize, scale, sub, v3 } from '../math';
import { applyDamage } from '../damage';
import type { Rng } from '../rng';
import { approachSpeed, type AABB } from '../movement';

export interface RuntimeEnv {
  colliders: readonly AABB[];
  spawnPoints: readonly Vec3[];
  playerSpawn: Vec3;
}

export interface DamageOutcome {
  killed: boolean;
  /** Damage actually absorbed, after clamping to what the target had left. */
  applied: number;
}

/**
 * Movement speed factor for a bot carrying a rifle, relative to base run
 * speed. 0.8 of the 6.75 m/s base puts a rifle bot at ~5.4 m/s, the
 * community-cited Valorant rifle movement speed. Approximate — Riot does not
 * publish per-weapon movement speeds — but duelling a bot moving at
 * unencumbered sprint speed trains the wrong timing.
 */
const RIFLE_SPEED_FACTOR = 0.8;

/**
 * How long a counter-strafing bot holds still after stopping.
 *
 * STOP_TIME_MS alone is only the deceleration — the handful of milliseconds it
 * takes to shed velocity. A player who counter-strafes does not instantly
 * sprint back the other way; they stop to actually fire, which takes a few
 * hundred milliseconds. Without this dwell the bot reverses at full speed
 * roughly once per second forever, which no human can do and which trains the
 * player to expect a target that is never actually shootable.
 */
const SETTLE_MIN_MS = 240;
const SETTLE_MAX_MS = 520;

/** Radius used to keep spawns clear of geometry, roughly a body capsule. */
const SPAWN_CLEARANCE_M = 0.45;

/**
 * Slab test for a ray against an AABB. Returns the entry distance, or null if
 * the ray misses. Used for line-of-sight, so only the near intersection
 * matters — we just need to know whether something is in the way first.
 */
function rayAABB(origin: Vec3, dir: Vec3, box: AABB): number | null {
  let tmin = 0;
  let tmax = Infinity;

  // Unrolled per axis rather than looped over a Vec3: this runs for every
  // collider for every target every step, and property access beats indexing.
  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z;
    const d = axis === 0 ? dir.x : axis === 1 ? dir.y : dir.z;
    const lo = axis === 0 ? box.min.x : axis === 1 ? box.min.y : box.min.z;
    const hi = axis === 0 ? box.max.x : axis === 1 ? box.max.y : box.max.z;

    if (Math.abs(d) < 1e-9) {
      // Ray is parallel to this slab: it can only hit if it starts inside it.
      if (o < lo || o > hi) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** True when nothing in `colliders` sits between `from` and `to`. */
export function hasLineOfSight(from: Vec3, to: Vec3, colliders: readonly AABB[]): boolean {
  const delta = sub(to, from);
  const dist = Math.hypot(delta.x, delta.y, delta.z);
  if (dist < 1e-6) return true;
  const dir = scale(delta, 1 / dist);

  for (const box of colliders) {
    const t = rayAABB(from, dir, box);
    // A hit beyond the target is not an obstruction.
    if (t !== null && t < dist - 1e-4) return false;
  }
  return true;
}

function pointInsideAny(p: Vec3, colliders: readonly AABB[], pad: number): boolean {
  for (const b of colliders) {
    if (
      p.x >= b.min.x - pad && p.x <= b.max.x + pad &&
      p.z >= b.min.z - pad && p.z <= b.max.z + pad &&
      p.y >= b.min.y - pad && p.y <= b.max.y + pad
    ) return true;
  }
  return false;
}

let nextTargetId = 0;

export class ScenarioRuntime {
  readonly targets: TargetState[] = [];
  score = 0;

  readonly stats = { spawned: 0, killed: 0, expired: 0, damageDealt: 0 };

  private readonly def: ScenarioDef;
  private readonly env: RuntimeEnv;
  private readonly rng: Rng;
  private readonly hitbox: AgentHitbox = STANDING_HITBOX;

  /**
   * Per-target movement anchors, keyed by target id. Kept beside TargetState
   * rather than inside it because they are behaviour bookkeeping, not
   * simulation state the renderer or telemetry has any business reading.
   */
  private readonly anchors = new Map<string, { origin: Vec3; lateral: Vec3; dir: number; nextChangeAt: number; exposedUntil: number; hidden: boolean }>();

  constructor(def: ScenarioDef, env: RuntimeEnv, rng: Rng) {
    this.def = def;
    this.env = env;
    this.rng = rng;
  }

  /** Fills the arena to `targetCount`. Call once before the first update. */
  start(nowMs: number): void {
    while (this.targets.length < this.def.targetCount) this.spawnOne(nowMs);
  }

  /**
   * Picks a spawn position satisfying the scenario's distance band, clear of
   * geometry, and (except for peek scenarios, where being hidden is the whole
   * point) visible to the player.
   *
   * Rejection sampling with a bounded retry count: on a cluttered map a
   * perfect placement may not exist, and stalling the sim to find one would
   * be worse than accepting a slightly-off distance on the final attempt.
   */
  private pickSpawn(playerEye: Vec3): Vec3 {
    const { minDistanceM, maxDistanceM, family } = this.def;
    let fallback: Vec3 | null = null;

    for (let attempt = 0; attempt < 48; attempt++) {
      let p: Vec3;
      if (this.env.spawnPoints.length > 0 && attempt < 24) {
        // Prefer the map's authored spawn points, jittered so repeated
        // spawns at the same node do not become a memorised flick.
        const base = this.rng.pick(this.env.spawnPoints);
        p = { x: base.x + this.rng.range(-1.2, 1.2), y: base.y, z: base.z + this.rng.range(-1.2, 1.2) };
      } else {
        const angle = this.rng.range(-Math.PI, Math.PI);
        const dist = this.rng.range(minDistanceM, maxDistanceM);
        p = { x: playerEye.x + Math.sin(angle) * dist, y: 0, z: playerEye.z + Math.cos(angle) * dist };
      }

      const flat = { x: p.x, y: playerEye.y, z: p.z };
      const d = Math.hypot(flat.x - playerEye.x, flat.z - playerEye.z);
      if (d < minDistanceM || d > maxDistanceM) continue;
      if (pointInsideAny({ x: p.x, y: 1.0, z: p.z }, this.env.colliders, SPAWN_CLEARANCE_M)) continue;

      fallback = p;
      if (family === 'peek') return p;
      // Aim the LOS check at the head, which is what the player must actually see.
      if (hasLineOfSight(playerEye, { x: p.x, y: 1.7, z: p.z }, this.env.colliders)) return p;
    }

    return fallback ?? { x: playerEye.x, y: 0, z: playerEye.z - minDistanceM };
  }

  private spawnOne(nowMs: number): TargetState {
    const eye = this.env.playerSpawn;
    const pos = this.pickSpawn(eye);
    const id = `t${nextTargetId++}`;
    const behavior: TargetBehavior = this.def.behavior;

    // Lateral axis = perpendicular to the player's line of sight, so strafing
    // reads as left-right on screen rather than toward or away from the player.
    const toPlayer = normalize({ x: eye.x - pos.x, y: 0, z: eye.z - pos.z });
    const lateral = normalize(cross({ x: 0, y: 1, z: 0 }, toPlayer));

    const target: TargetState = {
      id,
      position: { ...pos },
      velocity: v3(),
      yaw: Math.atan2(toPlayer.x, toPlayer.z) * (180 / Math.PI),
      health: BASE_HEALTH.value,
      armor: this.def.oneShotKill ? 0 : HEAVY_SHIELD.value,
      maxHealth: BASE_HEALTH.value,
      maxArmor: this.def.oneShotKill ? 0 : HEAVY_SHIELD.value,
      crouching: false,
      alive: true,
      spawnedAt: nowMs,
      visibleAt: null,
      expiresAt: this.def.targetLifetimeSec > 0 ? nowMs + this.def.targetLifetimeSec * 1000 : null,
      behavior,
      // Sinusoidal strafers start at +/-pi/2, where cos (and therefore
      // velocity) is zero: a target must ease out from rest like a player
      // would, not blink into existence already at full sprint. Other
      // behaviours ramp through approachSpeed, so their phase can be free.
      phase: behavior.type === 'strafe'
        ? (this.rng.next() < 0.5 ? Math.PI / 2 : -Math.PI / 2)
        : this.rng.range(0, Math.PI * 2),
      hitbox: this.hitbox,
    };

    this.anchors.set(id, {
      origin: { ...pos },
      lateral,
      dir: this.rng.next() < 0.5 ? -1 : 1,
      nextChangeAt: nowMs + (behavior.changeIntervalSec ?? 1) * 1000,
      // Peek targets start hidden so the player has to hold the angle rather
      // than being handed a free target the instant the run begins.
      exposedUntil: behavior.type === 'peek' ? nowMs + this.rng.range(300, 1400) : Infinity,
      hidden: behavior.type === 'peek',
    });

    this.targets.push(target);
    this.stats.spawned++;
    return target;
  }

  /** Advances behaviour, visibility and lifetimes. */
  update(nowMs: number, dtSec: number, playerEye: Vec3): void {
    for (let i = this.targets.length - 1; i >= 0; i--) {
      const t = this.targets[i];

      if (!t.alive) {
        this.targets.splice(i, 1);
        this.anchors.delete(t.id);
        continue;
      }
      if (t.expiresAt !== null && nowMs >= t.expiresAt) {
        this.targets.splice(i, 1);
        this.anchors.delete(t.id);
        this.stats.expired++;
        continue;
      }

      this.stepBehavior(t, nowMs, dtSec);

      // Visibility is recomputed every step because cover, the target and the
      // player all move. `visibleAt` latches the FIRST moment the player could
      // see it — telemetry's time-to-target is measured from there, so a
      // target that ducks back and reappears must not reset the clock.
      if (t.visibleAt === null) {
        const head = { x: t.position.x, y: t.position.y + 1.7, z: t.position.z };
        if (hasLineOfSight(playerEye, head, this.env.colliders)) t.visibleAt = nowMs;
      }
    }

    while (this.targets.length < this.def.targetCount) this.spawnOne(nowMs);
  }

  /**
   * Drives one target's behaviour.
   *
   * Every moving behaviour sets a WISH velocity and then ramps the real
   * velocity toward it with `approachSpeed` — the same accel/decel curve the
   * player is subject to. Writing velocity directly (as this used to) let bots
   * flip from full-speed-left to full-speed-right within a single 4 ms step,
   * which is not a movement Valorant can produce: measured, the old jiggle bot
   * changed direction 6.5 times a second while never once dropping below full
   * run speed. Tracking that is not a skill that transfers to the game.
   */
  private stepBehavior(t: TargetState, nowMs: number, dtSec: number): void {
    const a = this.anchors.get(t.id);
    if (!a) return;

    const b = t.behavior;
    // Default to rifle-carrying speed rather than base run speed: a bot you
    // duel is holding a weapon, and that is the speed it would actually move.
    const speed = b.speed ?? RUN_SPEED_MS.value * RIFLE_SPEED_FACTOR;
    const amp = b.amplitudeM ?? 3;

    /** Signed offset from the anchor along the strafe axis, metres. */
    const offsetAlongAxis = (): number =>
      (t.position.x - a.origin.x) * a.lateral.x + (t.position.z - a.origin.z) * a.lateral.z;

    /** Ramps toward a wish velocity along the lateral axis and integrates. */
    const driveAlongAxis = (wishSpeed: number): void => {
      const wishX = a.lateral.x * wishSpeed;
      const wishZ = a.lateral.z * wishSpeed;
      t.velocity.x = approachSpeed(t.velocity.x, wishX, speed, dtSec);
      t.velocity.z = approachSpeed(t.velocity.z, wishZ, speed, dtSec);
      t.position.x += t.velocity.x * dtSec;
      t.position.z += t.velocity.z * dtSec;
    };

    /**
     * Turns the bot around at the edge of its band, but only while it is
     * still travelling outward. Flipping on distance alone re-triggered every
     * step for as long as the target sat beyond the boundary, so it juddered
     * on the spot instead of turning cleanly.
     */
    const turnAtEdge = (): void => {
      const offset = offsetAlongAxis();
      if (Math.abs(offset) <= amp) return;
      const movingOutward = Math.sign(offset) === Math.sign(a.dir);
      if (movingOutward) a.dir = -a.dir;
    };

    switch (b.type) {
      case 'static':
        t.velocity.x = 0;
        t.velocity.z = 0;
        return;

      case 'strafe': {
        // Smooth sinusoid: continuous velocity by construction, so this one
        // needs no ramping — it never contains a discontinuity to begin with.
        t.phase += (speed / Math.max(amp, 0.1)) * dtSec;
        const offset = Math.sin(t.phase) * amp;
        const vel = Math.cos(t.phase) * speed;
        t.position.x = a.origin.x + a.lateral.x * offset;
        t.position.z = a.origin.z + a.lateral.z * offset;
        t.velocity.x = a.lateral.x * vel;
        t.velocity.z = a.lateral.z * vel;
        return;
      }

      case 'counter-strafe': {
        // Strafe, stop dead, HOLD, then break the other way. The hold is the
        // shootable window and the whole point of the duel: it is what the
        // player is meant to punish, and it is what makes the bot's own shot
        // accurate in Valorant's first-shot model.
        if (nowMs >= a.nextChangeAt) {
          a.dir = -a.dir;
          // Decelerate, then dwell — the run phase only begins after both.
          a.exposedUntil = nowMs + STOP_TIME_MS.value + this.rng.range(SETTLE_MIN_MS, SETTLE_MAX_MS);
          a.nextChangeAt = a.exposedUntil + (b.changeIntervalSec ?? 0.9) * 1000 * this.rng.range(0.85, 1.15);
        }
        const stopped = nowMs < a.exposedUntil;
        driveAlongAxis(stopped ? 0 : speed * a.dir);
        // Only turn while actually running, for the same reason as jiggle:
        // re-triggering the flip while parked at the edge causes a judder.
        if (!stopped) turnAtEdge();
        return;
      }

      case 'jiggle': {
        // A jiggle peek is a short dash followed by a STOP, not a continuous
        // bounce: the player breaks the angle, holds a beat, then breaks back.
        // The stop is the whole point — it is the window you are meant to
        // punish — so modelling this as an uninterrupted oscillation removed
        // the very thing the scenario exists to train.
        if (nowMs >= a.nextChangeAt) {
          a.dir = -a.dir;
          a.exposedUntil = nowMs + this.rng.range(110, 260); // dwell at the end of the dash
          a.nextChangeAt = nowMs + (b.changeIntervalSec ?? 0.55) * 1000 * this.rng.range(0.85, 1.2);
        }
        const dwelling = nowMs < a.exposedUntil;
        driveAlongAxis(dwelling ? 0 : speed * a.dir);
        if (!dwelling) turnAtEdge();
        return;
      }

      case 'peek': {
        // Alternates between a hidden anchor and an exposed one. On maps with
        // real cover the hidden position breaks line of sight; where it does
        // not, the movement still reproduces the timing window.
        const exposure = (b.exposureSec ?? 0.8) * 1000;
        if (nowMs >= a.exposedUntil) {
          a.hidden = !a.hidden;
          a.exposedUntil = nowMs + (a.hidden ? this.rng.range(500, 2000) : exposure);
        }
        const goal = a.hidden ? -amp : 0;
        const remaining = goal - offsetAlongAxis();
        // Ease into the stop so a peeker settles onto its angle instead of
        // arriving at full speed and halting dead.
        const wish = clamp(remaining / Math.max(dtSec, 1e-6), -speed, speed);
        driveAlongAxis(wish);
        return;
      }

      case 'random-walk': {
        if (nowMs >= a.nextChangeAt) {
          const angle = this.rng.range(-Math.PI, Math.PI);
          a.lateral = { x: Math.sin(angle), y: 0, z: Math.cos(angle) };
          a.nextChangeAt = nowMs + (b.changeIntervalSec ?? 0.7) * 1000 * this.rng.range(0.6, 1.4);
        }
        const wish = speed * this.rng.range(0.55, 1);
        const nextX = t.position.x + approachSpeed(t.velocity.x, a.lateral.x * wish, speed, dtSec) * dtSec;
        const nextZ = t.position.z + approachSpeed(t.velocity.z, a.lateral.z * wish, speed, dtSec) * dtSec;
        // Walk into a wall and pick a new heading instead of clipping through.
        if (pointInsideAny({ x: nextX, y: 1.0, z: nextZ }, this.env.colliders, SPAWN_CLEARANCE_M)) {
          a.nextChangeAt = nowMs;
          t.velocity.x = 0;
          t.velocity.z = 0;
          return;
        }
        t.velocity.x = approachSpeed(t.velocity.x, a.lateral.x * wish, speed, dtSec);
        t.velocity.z = approachSpeed(t.velocity.z, a.lateral.z * wish, speed, dtSec);
        t.position.x = nextX;
        t.position.z = nextZ;
        return;
      }
    }
  }

  /** Applies damage to one target. Returns what actually landed. */
  damage(targetId: string, amount: number): DamageOutcome {
    const t = this.targets.find((x) => x.id === targetId);
    if (!t || !t.alive) return { killed: false, applied: 0 };

    if (this.def.oneShotKill) {
      t.alive = false;
      t.health = 0;
      this.stats.killed++;
      this.stats.damageDealt += t.maxHealth;
      return { killed: true, applied: t.maxHealth };
    }

    const before = t.health + t.armor;
    const res = applyDamage(t.health, t.armor, amount);
    t.health = res.health;
    t.armor = res.armor;
    const applied = before - (t.health + t.armor);
    this.stats.damageDealt += applied;

    if (res.killed) {
      t.alive = false;
      this.stats.killed++;
    }
    return { killed: res.killed, applied };
  }

  /** Live target nearest in angle to a view direction; the "intended" target. */
  findTarget(id: string): TargetState | undefined {
    return this.targets.find((t) => t.id === id);
  }

  dispose(): void {
    this.targets.length = 0;
    this.anchors.clear();
  }
}
