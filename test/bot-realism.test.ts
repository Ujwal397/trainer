import { describe, it, expect } from 'vitest';
import type { ScenarioDef, TargetBehavior } from '../src/core/types';
import { RUN_SPEED_MS } from '../src/core/constants';
import { Rng } from '../src/core/rng';
import { ScenarioRuntime, type RuntimeEnv } from '../src/core/scenarios/runtime';
import { getScenario } from '../src/core/scenarios/definitions';

const ENV: RuntimeEnv = { colliders: [], spawnPoints: [], playerSpawn: { x: 0, y: 0, z: 0 } };

function def(behavior: TargetBehavior): ScenarioDef {
  return { ...getScenario('static-grid'), targetCount: 1, minDistanceM: 12, maxDistanceM: 12, behavior };
}

/**
 * Runs a bot for `seconds` at the real 4ms sim step and reports the movement
 * statistics a human player would be judged on.
 */
function profile(behavior: TargetBehavior, seconds = 20, seed = 5) {
  const rt = new ScenarioRuntime(def(behavior), ENV, new Rng(seed));
  rt.start(0);
  const t0 = rt.targets[0];

  let peak = 0;
  let stationaryFrames = 0;
  let frames = 0;
  let reversals = 0;
  let lastSign = 0;
  let t = 0;

  while (t < seconds * 1000) {
    t += 4;
    rt.update(t, 0.004, ENV.playerSpawn);
    if (rt.targets[0] !== t0) break; // respawned; stop measuring
    const v = t0.velocity;
    const sp = Math.hypot(v.x, v.z);
    peak = Math.max(peak, sp);
    frames++;
    if (sp < 0.05) stationaryFrames++;
    // Track reversals along the dominant axis.
    const sign = Math.abs(v.x) > Math.abs(v.z) ? Math.sign(v.x) : Math.sign(v.z);
    if (sign !== 0 && lastSign !== 0 && sign !== lastSign) reversals++;
    if (sign !== 0) lastSign = sign;
  }

  return {
    peak,
    stationaryFraction: frames > 0 ? stationaryFrames / frames : 0,
    reversalsPerSec: reversals / seconds,
  };
}

const RIFLE_SPEED = RUN_SPEED_MS.value * 0.8; // ~5.4 m/s

describe('bot movement stays within human limits', () => {
  it('never exceeds rifle-carrying movement speed', () => {
    for (const b of [
      { type: 'counter-strafe', amplitudeM: 2.0, changeIntervalSec: 0.7 },
      { type: 'jiggle', amplitudeM: 1.5, changeIntervalSec: 0.35 },
      { type: 'strafe', amplitudeM: 4 },
    ] as TargetBehavior[]) {
      // A small tolerance for the integration step; anything beyond that is a
      // bot moving faster than a player physically can.
      expect(profile(b).peak).toBeLessThanOrEqual(RIFLE_SPEED * 1.02);
    }
  });

  it('gives a counter-strafing bot a real stop, not a 50ms deceleration blip', () => {
    const p = profile({ type: 'counter-strafe', amplitudeM: 2.0, changeIntervalSec: 0.7 });
    // The stop is the shootable window. If the bot is essentially always
    // moving, the duel is unwinnable in a way no real duel is.
    expect(p.stationaryFraction).toBeGreaterThan(0.2);
    // No human strafes back and forth more than roughly once a second while
    // also stopping to shoot in between.
    expect(p.reversalsPerSec).toBeLessThan(1.2);
  });

  it('keeps jiggle peeks fast but still punctuated by dwells', () => {
    const p = profile({ type: 'jiggle', amplitudeM: 1.5, changeIntervalSec: 0.35 });
    expect(p.stationaryFraction).toBeGreaterThan(0.12);
    expect(p.reversalsPerSec).toBeLessThan(2.6);
  });

  it('accelerates rather than teleporting to full speed', () => {
    const rt = new ScenarioRuntime(
      def({ type: 'counter-strafe', amplitudeM: 2.0, changeIntervalSec: 0.7 }), ENV, new Rng(3),
    );
    rt.start(0);
    const t0 = rt.targets[0];
    // One step in, the bot cannot already be at full speed.
    rt.update(4, 0.004, ENV.playerSpawn);
    expect(Math.hypot(t0.velocity.x, t0.velocity.z)).toBeLessThan(RIFLE_SPEED);
  });
});
