import { describe, it, expect } from 'vitest';
import type { AccelCurve, SensConfig, SessionRecord, ShotEvent, SessionSummary } from '../src/core/types';
import { Rng } from '../src/core/rng';
import { analyseAcceleration } from '../src/core/analysis/accel';

const CURVE: AccelCurve = {
  type: 'linear', sensMultiplier: 1, acceleration: 0.05, exponent: 2, inputOffset: 0,
  outputCap: 0, inputCap: 0, decayRate: 1, limit: 2, syncSpeed: 1, gamma: 1, smooth: 0,
  motivity: 1.5, growthRate: 1, midpoint: 1, applyToY: true,
};

const SENS: SensConfig = {
  dpi: 800, pollingRateHz: 1000, sensitivity: 0.35, scopedMultiplier: 1,
  rawAccelEnabled: true, rawAccelMode: 'external', invertY: false, curve: CURVE,
};

const SUMMARY: SessionSummary = {
  shots: 0, hits: 0, accuracy: 0.5, headshots: 0, headshotRate: 0.2, kills: 0, score: 0,
  avgTimeToTargetMs: 400, avgErrorDeg: 1, overshootBias: 0, avgMicroCorrections: 1,
  pathEfficiency: 1.1, trackingAccuracy: 0, errorConsistency: 0.5,
};

/**
 * Builds a session where overshoot is driven by a chosen model of flick speed,
 * so each test can state exactly which cause it is simulating.
 */
function session(
  id: string,
  rng: Rng,
  shotCount: number,
  overshootFor: (gain: number) => number,
  rawAccelEnabled = true,
): SessionRecord {
  const shots: ShotEvent[] = [];
  for (let i = 0; i < shotCount; i++) {
    // Flick speed spans a wide range; gain rises with speed as a driver curve would.
    const vel = 200 + rng.next() * 1800;
    const gain = 1 + (vel / 2000) * 0.6;
    shots.push({
      t: i * 500, weaponId: 'vandal', shotIndexInBurst: 0,
      hit: rng.next() < 0.6, zone: null, targetId: `t${i}`, distanceM: 15,
      errorAngleDeg: Math.abs(rng.gaussian() * 0.8) + 0.5,
      errorYawDeg: rng.gaussian() * 0.8, errorPitchDeg: rng.gaussian() * 0.5,
      timeToTargetMs: 400, overshootDeg: overshootFor(gain) + rng.gaussian() * 0.3,
      microCorrections: 1, pathLengthDeg: 30, directAngleDeg: 25,
      peakAngularVelDeg: vel, spreadDeg: 0, recoilYawDeg: 0, recoilPitchDeg: 0,
      playerSpeed: 0, effectiveGain: gain,
    });
  }
  return {
    id, startedAt: 0, endedAt: shotCount * 500, scenarioId: 'flick-single', weaponId: 'vandal',
    sens: { ...SENS, rawAccelEnabled }, eDPI: 280, cm360: 46.65, rawAccelEnabled,
    summary: { ...SUMMARY, shots: shotCount }, shots, samples: [],
  };
}

describe('acceleration analysis', () => {
  it('blames the curve when overshoot scales with applied gain', () => {
    const rng = new Rng(11);
    // Overshoot exists only where the driver accelerated hardest.
    const sessions = [1, 2, 3].map((n) => session(`s${n}`, rng, 150, (g) => (g - 1) * 6));

    const a = analyseAcceleration(sessions);
    expect(a.verdict).toBe('curve-too-aggressive');
    expect(a.gainOvershootSlope).toBeGreaterThan(1);
    expect(a.fastVsSlowOvershoot).toBeGreaterThan(0.25);
    expect(a.confidence).toBeGreaterThan(0.5);
  });

  it('blames base sensitivity when overshoot is flat across flick speeds', () => {
    const rng = new Rng(12);
    // A constant 1.5 degrees long at every speed: the curve is not the cause.
    const sessions = [1, 2, 3].map((n) => session(`s${n}`, rng, 150, () => 1.5));

    const a = analyseAcceleration(sessions);
    expect(a.verdict).toBe('base-sens-is-the-problem');
    expect(Math.abs(a.fastVsSlowOvershoot)).toBeLessThan(0.25);
  });

  it('clears the curve when overshoot is flat and near zero', () => {
    const rng = new Rng(13);
    const sessions = [1, 2, 3].map((n) => session(`s${n}`, rng, 150, () => 0));

    expect(analyseAcceleration(sessions).verdict).toBe('curve-suits-you');
  });

  it('reports insufficient data rather than guessing when no curve was declared', () => {
    const rng = new Rng(14);
    const sessions = [session('s1', rng, 300, () => 1, false)];

    const a = analyseAcceleration(sessions);
    expect(a.active).toBe(false);
    expect(a.verdict).toBe('insufficient-data');
    expect(a.confidence).toBe(0);
  });

  it('refuses a verdict on thin data', () => {
    const rng = new Rng(15);
    const a = analyseAcceleration([session('s1', rng, 20, (g) => (g - 1) * 6)]);
    expect(a.verdict).toBe('insufficient-data');
  });
});
