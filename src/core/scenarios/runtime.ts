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
import { clamp, cross, distance, normalize, scale, sub, v3 } from '../math';
import { applyDamage } from '../damage';
import type { Rng } from '../rng';
import type { AABB } from '../movement';

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
      phase: this.rng.range(0, Math.PI * 2),
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

  private stepBehavior(t: TargetState, nowMs: number, dtSec: number): void {
    const a = this.anchors.get(t.id);
    if (!a) return;

    const b = t.behavior;
    const speed = b.speed ?? RUN_SPEED_MS.value;
    const amp = b.amplitudeM ?? 3;

    switch (b.type) {
      case 'static':
        t.velocity.x = 0;
        t.velocity.z = 0;
        return;

      case 'strafe': {
        // Smooth sinusoid: continuous velocity, so tracking is a test of
        // steadiness rather than of reacting to instantaneous flips.
        t.phase += (speed / Math.max(amp, 0.1)) * dtSec;
        const offset = Math.sin(t.phase) * amp;
        const vel = Math.cos(t.phase) * amp * (speed / Math.max(amp, 0.1));
        t.position.x = a.origin.x + a.lateral.x * offset;
        t.position.z = a.origin.z + a.lateral.z * offset;
        t.velocity.x = a.lateral.x * vel;
        t.velocity.z = a.lateral.z * vel;
        return;
      }

      case 'counter-strafe': {
        // Full speed, then a dead stop held for STOP_TIME_MS — the real
        // Valorant mechanic, where the stop is what makes the shot accurate.
        if (nowMs >= a.nextChangeAt) {
          a.dir = -a.dir;
          a.nextChangeAt = nowMs + (b.changeIntervalSec ?? 0.9) * 1000;
          a.exposedUntil = nowMs + STOP_TIME_MS.value;
        }
        const stopped = nowMs < a.exposedUntil;
        const v = stopped ? 0 : speed * a.dir;
        t.velocity.x = a.lateral.x * v;
        t.velocity.z = a.lateral.z * v;
        t.position.x += t.velocity.x * dtSec;
        t.position.z += t.velocity.z * dtSec;
        // Turn around at the edge of the strafe band rather than wandering off.
        if (distance({ x: t.position.x, y: 0, z: t.position.z }, { x: a.origin.x, y: 0, z: a.origin.z }) > amp) {
          a.dir = -a.dir;
        }
        return;
      }

      case 'jiggle': {
        if (nowMs >= a.nextChangeAt) {
          a.dir = -a.dir;
          a.nextChangeAt = nowMs + (b.changeIntervalSec ?? 0.28) * 1000 * this.rng.range(0.7, 1.3);
        }
        const v = speed * a.dir;
        t.velocity.x = a.lateral.x * v;
        t.velocity.z = a.lateral.z * v;
        t.position.x += t.velocity.x * dtSec;
        t.position.z += t.velocity.z * dtSec;
        if (distance({ x: t.position.x, y: 0, z: t.position.z }, { x: a.origin.x, y: 0, z: a.origin.z }) > amp) {
          a.dir = -a.dir;
        }
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
        const cur = (t.position.x - a.origin.x) * a.lateral.x + (t.position.z - a.origin.z) * a.lateral.z;
        const step = clamp(goal - cur, -speed * dtSec, speed * dtSec);
        t.position.x += a.lateral.x * step;
        t.position.z += a.lateral.z * step;
        t.velocity.x = (a.lateral.x * step) / Math.max(dtSec, 1e-6);
        t.velocity.z = (a.lateral.z * step) / Math.max(dtSec, 1e-6);
        return;
      }

      case 'random-walk': {
        if (nowMs >= a.nextChangeAt) {
          const angle = this.rng.range(-Math.PI, Math.PI);
          a.lateral = { x: Math.sin(angle), y: 0, z: Math.cos(angle) };
          a.nextChangeAt = nowMs + (b.changeIntervalSec ?? 0.7) * 1000 * this.rng.range(0.6, 1.4);
        }
        const v = speed * this.rng.range(0.55, 1);
        const next = {
          x: t.position.x + a.lateral.x * v * dtSec,
          y: t.position.y,
          z: t.position.z + a.lateral.z * v * dtSec,
        };
        // Walk into a wall and pick a new heading instead of clipping through.
        if (pointInsideAny({ x: next.x, y: 1.0, z: next.z }, this.env.colliders, SPAWN_CLEARANCE_M)) {
          a.nextChangeAt = nowMs;
          t.velocity.x = 0;
          t.velocity.z = 0;
          return;
        }
        t.velocity.x = a.lateral.x * v;
        t.velocity.z = a.lateral.z * v;
        t.position = next;
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
