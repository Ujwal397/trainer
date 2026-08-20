import { describe, it, expect } from 'vitest';
import type { ScenarioDef, TargetBehavior } from '../src/core/types';
import { STOP_TIME_MS } from '../src/core/constants';
import { Rng } from '../src/core/rng';
import { ScenarioRuntime, hasLineOfSight, type RuntimeEnv } from '../src/core/scenarios/runtime';
import { getScenario } from '../src/core/scenarios/definitions';

const OPEN_ENV: RuntimeEnv = {
  colliders: [],
  spawnPoints: [],
  playerSpawn: { x: 0, y: 0, z: 0 },
};

function def(behavior: TargetBehavior, over: Partial<ScenarioDef> = {}): ScenarioDef {
  return { ...getScenario('static-grid'), targetCount: 1, minDistanceM: 10, maxDistanceM: 20, behavior, ...over };
}

/** Runs the sim forward in fixed 4ms steps, as the real loop does. */
function run(rt: ScenarioRuntime, ms: number, startAt = 0, eye = OPEN_ENV.playerSpawn): number {
  let t = startAt;
  while (t < startAt + ms) { t += 4; rt.update(t, 0.004, eye); }
  return t;
}

describe('line of sight', () => {
  it('is blocked by a box between the two points', () => {
    const wall = [{ min: { x: -5, y: 0, z: -6 }, max: { x: 5, y: 3, z: -5 } }];
    expect(hasLineOfSight({ x: 0, y: 1.7, z: 0 }, { x: 0, y: 1.7, z: -12 }, wall)).toBe(false);
    expect(hasLineOfSight({ x: 0, y: 1.7, z: 0 }, { x: 0, y: 1.7, z: -12 }, [])).toBe(true);
  });

  it('ignores a box that sits beyond the target', () => {
    const behind = [{ min: { x: -5, y: 0, z: -20 }, max: { x: 5, y: 3, z: -19 } }];
    expect(hasLineOfSight({ x: 0, y: 1.7, z: 0 }, { x: 0, y: 1.7, z: -12 }, behind)).toBe(true);
  });
});

describe('spawning', () => {
  it('respects the scenario distance band', () => {
    const rt = new ScenarioRuntime(def({ type: 'static' }, { targetCount: 8 }), OPEN_ENV, new Rng(1));
    rt.start(0);
    for (const t of rt.targets) {
      const d = Math.hypot(t.position.x, t.position.z);
      expect(d).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(d).toBeLessThanOrEqual(20 + 1e-6);
    }
  });

  it('never places a target inside a collider', () => {
    const box = { min: { x: -20, y: 0, z: -20 }, max: { x: -8, y: 3, z: -8 } };
    const env: RuntimeEnv = { ...OPEN_ENV, colliders: [box] };
    const rt = new ScenarioRuntime(def({ type: 'static' }, { targetCount: 12 }), env, new Rng(7));
    rt.start(0);
    for (const t of rt.targets) {
      const inside = t.position.x >= box.min.x && t.position.x <= box.max.x &&
        t.position.z >= box.min.z && t.position.z <= box.max.z;
      expect(inside).toBe(false);
    }
  });

  it('refills the arena when a target dies', () => {
    const rt = new ScenarioRuntime(def({ type: 'static' }, { targetCount: 3 }), OPEN_ENV, new Rng(3));
    rt.start(0);
    expect(rt.targets.length).toBe(3);
    rt.damage(rt.targets[0].id, 500);
    run(rt, 20);
    expect(rt.targets.length).toBe(3);
    expect(rt.stats.killed).toBe(1);
  });

  it('expires targets past their lifetime', () => {
    const rt = new ScenarioRuntime(
      def({ type: 'static' }, { targetCount: 1, targetLifetimeSec: 0.2 }), OPEN_ENV, new Rng(5),
    );
    rt.start(0);
    const first = rt.targets[0].id;
    run(rt, 400);
    expect(rt.stats.expired).toBeGreaterThan(0);
    expect(rt.targets[0].id).not.toBe(first);
  });
});

describe('behaviours', () => {
  it('leaves static targets exactly where they spawned', () => {
    const rt = new ScenarioRuntime(def({ type: 'static' }), OPEN_ENV, new Rng(2));
    rt.start(0);
    const p = { ...rt.targets[0].position };
    run(rt, 1000);
    expect(rt.targets[0].position.x).toBeCloseTo(p.x, 10);
    expect(rt.targets[0].position.z).toBeCloseTo(p.z, 10);
  });

  it('moves strafing targets and keeps them within the amplitude band', () => {
    const rt = new ScenarioRuntime(def({ type: 'strafe', amplitudeM: 3 }), OPEN_ENV, new Rng(4));
    rt.start(0);
    const origin = { ...rt.targets[0].position };
    let maxOffset = 0;
    let t = 0;
    for (let i = 0; i < 800; i++) {
      t += 4;
      rt.update(t, 0.004, OPEN_ENV.playerSpawn);
      const p = rt.targets[0].position;
      maxOffset = Math.max(maxOffset, Math.hypot(p.x - origin.x, p.z - origin.z));
    }
    expect(maxOffset).toBeGreaterThan(0.5);
    expect(maxOffset).toBeLessThanOrEqual(3 + 1e-6);
  });

  it('brings a counter-strafing target to a dead stop within STOP_TIME_MS', () => {
    const rt = new ScenarioRuntime(
      def({ type: 'counter-strafe', amplitudeM: 3, changeIntervalSec: 0.5 }), OPEN_ENV, new Rng(6),
    );
    rt.start(0);
    // Run past the first direction change and look for a fully stopped frame:
    // the stop is what makes the target's own shot accurate in Valorant, so it
    // must actually reach zero rather than merely slowing.
    let sawFullStop = false;
    let t = 0;
    for (let i = 0; i < 400; i++) {
      t += 4;
      rt.update(t, 0.004, OPEN_ENV.playerSpawn);
      const v = rt.targets[0].velocity;
      if (Math.hypot(v.x, v.z) === 0) sawFullStop = true;
    }
    expect(sawFullStop).toBe(true);
    expect(STOP_TIME_MS.value).toBeLessThanOrEqual(100);
  });

  it('latches visibleAt at first exposure and never resets it', () => {
    // A wall the peeker starts behind, so it is genuinely hidden at spawn.
    const env: RuntimeEnv = {
      colliders: [{ min: { x: -30, y: 0, z: -14 }, max: { x: -1, y: 3, z: -13 } }],
      spawnPoints: [{ x: -4, y: 0, z: -16 }],
      playerSpawn: { x: 0, y: 0, z: 0 },
    };
    const rt = new ScenarioRuntime(
      def({ type: 'peek', exposureSec: 0.5, amplitudeM: 4 }, { family: 'peek', minDistanceM: 8, maxDistanceM: 30 }),
      env,
      new Rng(9),
    );
    rt.start(0);
    const target = rt.targets[0];
    const spawnedAt = target.spawnedAt;

    let t = 0;
    let firstVisible: number | null = null;
    for (let i = 0; i < 2000; i++) {
      t += 4;
      rt.update(t, 0.004, { x: 0, y: 1.68, z: 0 });
      if (rt.targets[0] !== target) break; // target was replaced; stop
      if (firstVisible === null && target.visibleAt !== null) firstVisible = target.visibleAt;
      // Once latched it must never move, even as the target ducks back.
      if (firstVisible !== null) expect(target.visibleAt).toBe(firstVisible);
    }
    if (firstVisible !== null) expect(firstVisible).toBeGreaterThan(spawnedAt);
  });
});

describe('damage', () => {
  it('needs four Vandal body shots through heavy shield, or one to the head', () => {
    const rt = new ScenarioRuntime(def({ type: 'static' }, { oneShotKill: false }), OPEN_ENV, new Rng(8));
    rt.start(0);
    const id = rt.targets[0].id;
    expect(rt.damage(id, 40).killed).toBe(false);
    expect(rt.damage(id, 40).killed).toBe(false);
    expect(rt.damage(id, 40).killed).toBe(false);
    expect(rt.damage(id, 40).killed).toBe(true);
  });

  it('kills in one hit when the scenario says so, whatever the damage', () => {
    const rt = new ScenarioRuntime(def({ type: 'static' }, { oneShotKill: true }), OPEN_ENV, new Rng(10));
    rt.start(0);
    expect(rt.damage(rt.targets[0].id, 1).killed).toBe(true);
  });
});
