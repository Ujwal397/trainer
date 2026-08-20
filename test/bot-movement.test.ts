import { describe, it, expect } from 'vitest';
import { ScenarioRuntime, type RuntimeEnv } from '../src/core/scenarios/runtime';
import { getScenario } from '../src/core/scenarios/definitions';
import { Rng } from '../src/core/rng';
import { RUN_SPEED_MS } from '../src/core/constants';

const ENV: RuntimeEnv = { colliders: [], spawnPoints: [], playerSpawn: { x: 0, y: 0, z: 0 } };

interface Profile {
  peak: number;
  avg: number;
  changesPerSec: number;
  maxAccelPerStep: number;
}

/** Runs one scenario's bot for `durMs` and measures how it actually moves. */
function profile(scenarioId: string, durMs = 12000, seed = 1): Profile {
  const rt = new ScenarioRuntime(getScenario(scenarioId), ENV, new Rng(seed));
  rt.start(0);
  const first = rt.targets[0];

  let t = 0, changes = 0, lastSign = 0, peak = 0, sum = 0, n = 0, maxDelta = 0;
  let prevX = 0, prevZ = 0;

  while (t < durMs) {
    t += 4;
    rt.update(t, 0.004, ENV.playerSpawn);
    const tg = rt.targets[0];
    if (!tg || tg !== first) break;

    const sp = Math.hypot(tg.velocity.x, tg.velocity.z);
    peak = Math.max(peak, sp);
    sum += sp;
    n++;
    maxDelta = Math.max(maxDelta, Math.hypot(tg.velocity.x - prevX, tg.velocity.z - prevZ));
    prevX = tg.velocity.x;
    prevZ = tg.velocity.z;

    const sign = Math.sign(tg.velocity.x !== 0 ? tg.velocity.x : tg.velocity.z);
    if (sign !== 0 && lastSign !== 0 && sign !== lastSign) changes++;
    if (sign !== 0) lastSign = sign;
  }

  return { peak, avg: sum / n, changesPerSec: changes / (durMs / 1000), maxAccelPerStep: maxDelta };
}

const MOVING = ['counter-strafe', 'jiggle-track', 'strafe-single', 'multi-strafe'];

describe('bots move like humans, not like scripts', () => {
  it.each(MOVING)('%s never exceeds Valorant run speed', (id) => {
    expect(profile(id).peak).toBeLessThanOrEqual(RUN_SPEED_MS.value + 1e-6);
  });

  it.each(MOVING)('%s changes direction at a humanly achievable rate', (id) => {
    // A player counter-strafing hard manages roughly two direction changes a
    // second. An earlier build hit 6.5/s, which is not a movement the game can
    // even express — so tracking it trained nothing that transfers.
    expect(profile(id).changesPerSec).toBeLessThanOrEqual(2.6);
  });

  it.each(MOVING)('%s actually accelerates and decelerates', (id) => {
    const p = profile(id);
    // Snapping between +full and -full speed shows up as avg == peak. Real
    // ramping always leaves the average meaningfully below the peak.
    expect(p.avg).toBeLessThan(p.peak * 0.92);
  });

  it.each(MOVING)('%s never teleports its velocity within one step', (id) => {
    // One 4ms step may change speed by at most accelRate * dt. With a ~60ms
    // accel time that is roughly a fifteenth of the cap; allow generous slack
    // but reject an instant full-speed reversal.
    expect(profile(id).maxAccelPerStep).toBeLessThan(RUN_SPEED_MS.value * 0.5);
  });

  it('gives the jiggle bot real stops to punish', () => {
    const rt = new ScenarioRuntime(getScenario('jiggle-track'), ENV, new Rng(4));
    rt.start(0);
    let t = 0, stoppedFrames = 0, total = 0;
    while (t < 12000) {
      t += 4;
      rt.update(t, 0.004, ENV.playerSpawn);
      const tg = rt.targets[0];
      if (!tg) break;
      if (Math.hypot(tg.velocity.x, tg.velocity.z) < 0.35) stoppedFrames++;
      total++;
    }
    // The dwell at the end of each dash is the window the scenario exists to
    // train; a pure oscillation would never be stationary at all.
    expect(stoppedFrames / total).toBeGreaterThan(0.08);
  });

  it('keeps bots inside their strafe band', () => {
    const rt = new ScenarioRuntime(getScenario('counter-strafe'), ENV, new Rng(9));
    rt.start(0);
    const origin = { ...rt.targets[0].position };
    const amp = getScenario('counter-strafe').behavior.amplitudeM ?? 3;
    let t = 0, maxOff = 0;
    while (t < 12000) {
      t += 4;
      rt.update(t, 0.004, ENV.playerSpawn);
      const p = rt.targets[0].position;
      maxOff = Math.max(maxOff, Math.hypot(p.x - origin.x, p.z - origin.z));
    }
    // Turning only while travelling outward must still bound the excursion —
    // the old distance-only flip juddered on the boundary instead.
    expect(maxOff).toBeLessThan(amp + 1.0);
  });
});
