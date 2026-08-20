import { describe, expect, it } from 'vitest';
import type { AccelCurve, SensConfig, SessionRecord, ShotEvent } from '../src/core/types';
import {
  bucketBySensitivity,
  compositeScore,
  DEFAULT_COMPOSITE_WEIGHTS,
  overshootTrend,
  separateByFamily,
  type SensBucketWithReliability,
} from '../src/core/analysis/metrics';

// ------------------------------------------------------------ test fixtures --

const OFF_CURVE: AccelCurve = {
  type: 'off',
  sensMultiplier: 1,
  acceleration: 0,
  exponent: 2,
  inputOffset: 0,
  outputCap: 0,
  inputCap: 0,
  decayRate: 0,
  limit: 1,
  syncSpeed: 1,
  gamma: 1,
  smooth: 0,
  motivity: 1,
  growthRate: 1,
  midpoint: 1,
  applyToY: true,
};

function makeSens(sensitivity: number, rawAccelEnabled = false, dpi = 800): SensConfig {
  return { dpi, pollingRateHz: 1000, sensitivity, scopedMultiplier: 1, rawAccelEnabled, curve: OFF_CURVE, invertY: false };
}

function makeShot(overrides: Partial<ShotEvent> = {}): ShotEvent {
  return {
    t: 0,
    weaponId: 'vandal',
    shotIndexInBurst: 0,
    hit: true,
    zone: 'body',
    targetId: 't0',
    distanceM: 15,
    errorAngleDeg: 1,
    errorYawDeg: 0.5,
    errorPitchDeg: 0.5,
    timeToTargetMs: 300,
    overshootDeg: 0,
    microCorrections: 1,
    pathLengthDeg: 20,
    directAngleDeg: 20,
    peakAngularVelDeg: 500,
    spreadDeg: 0.5,
    recoilYawDeg: 0,
    recoilPitchDeg: 0,
    playerSpeed: 0,
    effectiveGain: 1,
    ...overrides,
  };
}

let idCounter = 0;
function makeSession(opts: {
  sensitivity: number;
  rawAccelEnabled?: boolean;
  accuracy: number;
  avgErrorDeg: number;
  overshootBias: number;
  shots?: number;
  scenarioId?: string;
}): SessionRecord {
  idCounter++;
  const shotCount = opts.shots ?? 40;
  const hits = Math.round(shotCount * opts.accuracy);
  const shots: ShotEvent[] = [];
  for (let i = 0; i < shotCount; i++) {
    shots.push(
      makeShot({
        hit: i < hits,
        zone: i < hits ? 'body' : null,
        errorAngleDeg: opts.avgErrorDeg,
        overshootDeg: opts.overshootBias,
      }),
    );
  }
  const sens = makeSens(opts.sensitivity, opts.rawAccelEnabled ?? false);
  return {
    id: `ses_${idCounter}`,
    startedAt: 1000 * idCounter,
    endedAt: 1000 * idCounter + 60000,
    scenarioId: opts.scenarioId ?? 'gridshot',
    weaponId: 'vandal',
    sens,
    eDPI: sens.dpi * sens.sensitivity,
    cm360: 100,
    rawAccelEnabled: sens.rawAccelEnabled,
    summary: {
      shots: shotCount,
      hits,
      accuracy: opts.accuracy,
      headshots: 0,
      headshotRate: 0,
      kills: 0,
      score: 0,
      avgTimeToTargetMs: 300,
      avgErrorDeg: opts.avgErrorDeg,
      overshootBias: opts.overshootBias,
      avgMicroCorrections: 1,
      pathEfficiency: 1.1,
      trackingAccuracy: 0.5,
      errorConsistency: 1,
    },
    shots,
    samples: [],
  };
}

// -------------------------------------------------------------- bucketing --

describe('bucketBySensitivity', () => {
  it('groups sessions by (sensitivity, rawAccelEnabled) and weights aggregates by shot count', () => {
    const sessions = [
      makeSession({ sensitivity: 0.3, accuracy: 0.9, avgErrorDeg: 1, overshootBias: 0.2, shots: 90 }),
      makeSession({ sensitivity: 0.3, accuracy: 0.1, avgErrorDeg: 5, overshootBias: -0.2, shots: 10 }),
    ];
    const buckets = bucketBySensitivity(sessions);
    expect(buckets).toHaveLength(1);
    // Weighted 90/10 toward the first session's accuracy (0.9), not a plain average (0.5).
    expect(buckets[0].accuracy).toBeCloseTo(0.9 * 0.9 + 0.1 * 0.1, 5);
    expect(buckets[0].shots).toBe(100);
    expect(buckets[0].sessions).toBe(2);
  });

  it('never pools RawAccel and non-RawAccel sessions at the same sensitivity value', () => {
    const sessions = [
      makeSession({ sensitivity: 0.3, rawAccelEnabled: false, accuracy: 0.9, avgErrorDeg: 1, overshootBias: 0 }),
      makeSession({ sensitivity: 0.3, rawAccelEnabled: true, accuracy: 0.4, avgErrorDeg: 4, overshootBias: 0 }),
    ];
    const buckets = bucketBySensitivity(sessions);
    expect(buckets).toHaveLength(2);
    const flat = buckets.find((b) => !b.rawAccelEnabled)!;
    const accel = buckets.find((b) => b.rawAccelEnabled)!;
    expect(flat.accuracy).toBeCloseTo(0.9, 5);
    expect(accel.accuracy).toBeCloseTo(0.4, 5);
  });

  it('marks thin buckets unreliable rather than trusting them silently', () => {
    const sessions = [makeSession({ sensitivity: 0.3, accuracy: 0.9, avgErrorDeg: 1, overshootBias: 0, shots: 3 })];
    const buckets = bucketBySensitivity(sessions, { minShotsPerBucket: 20 }) as SensBucketWithReliability[];
    expect(buckets[0].shots).toBe(3);
    expect(buckets[0].reliable).toBe(false);
  });

  it('excludeUnreliable drops thin buckets from the result', () => {
    const sessions = [
      makeSession({ sensitivity: 0.3, accuracy: 0.9, avgErrorDeg: 1, overshootBias: 0, shots: 3 }),
      makeSession({ sensitivity: 0.35, accuracy: 0.9, avgErrorDeg: 1, overshootBias: 0, shots: 100 }),
    ];
    const buckets = bucketBySensitivity(sessions, { minShotsPerBucket: 20, excludeUnreliable: true });
    expect(buckets).toHaveLength(1);
    expect(buckets[0].sensitivity).toBeCloseTo(0.35, 5);
  });

  it('groups sensitivities that differ only by float noise', () => {
    const sessions = [
      makeSession({ sensitivity: 0.3, accuracy: 0.9, avgErrorDeg: 1, overshootBias: 0, shots: 50 }),
      makeSession({ sensitivity: 0.30000001, accuracy: 0.8, avgErrorDeg: 1, overshootBias: 0, shots: 50 }),
    ];
    const buckets = bucketBySensitivity(sessions);
    expect(buckets).toHaveLength(1);
  });
});

// ---------------------------------------------------------- composite score --

describe('compositeScore / computeCompositeScoresInPlace (via bucketBySensitivity)', () => {
  it('scores the best all-round bucket higher than a clearly worse one', () => {
    const sessions = [
      makeSession({ sensitivity: 0.25, accuracy: 0.5, avgErrorDeg: 4, overshootBias: 2, shots: 100 }),
      makeSession({ sensitivity: 0.35, accuracy: 0.95, avgErrorDeg: 0.5, overshootBias: 0.05, shots: 100 }),
    ];
    const buckets = bucketBySensitivity(sessions);
    const good = buckets.find((b) => b.sensitivity === 0.35)!;
    const bad = buckets.find((b) => b.sensitivity === 0.25)!;
    expect(good.compositeScore).toBeGreaterThan(bad.compositeScore);
  });

  it('penalises overshoot symmetrically in both directions', () => {
    const sessions = [
      makeSession({ sensitivity: 0.2, accuracy: 0.8, avgErrorDeg: 1, overshootBias: -2, shots: 100 }),
      makeSession({ sensitivity: 0.3, accuracy: 0.8, avgErrorDeg: 1, overshootBias: 0, shots: 100 }),
      makeSession({ sensitivity: 0.4, accuracy: 0.8, avgErrorDeg: 1, overshootBias: 2, shots: 100 }),
    ];
    const buckets = bucketBySensitivity(sessions);
    const under = buckets.find((b) => b.sensitivity === 0.2)!;
    const over = buckets.find((b) => b.sensitivity === 0.4)!;
    const zero = buckets.find((b) => b.sensitivity === 0.3)!;
    // Equal-magnitude overshoot and undershoot should be penalised equally...
    expect(over.compositeScore).toBeCloseTo(under.compositeScore, 5);
    // ...and both worse than dead-on.
    expect(zero.compositeScore).toBeGreaterThan(over.compositeScore);
  });

  it('single-bucket compositeScore() wrapper runs without a full bucket array', () => {
    const sessions = [makeSession({ sensitivity: 0.3, accuracy: 0.8, avgErrorDeg: 1, overshootBias: 0, shots: 50 })];
    const buckets = bucketBySensitivity(sessions);
    const score = compositeScore(buckets[0], DEFAULT_COMPOSITE_WEIGHTS);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// -------------------------------------------------------------- overshoot --

describe('overshootTrend', () => {
  it('recovers a known linear relationship between sensitivity and overshoot', () => {
    // overshootBias = 10 * (sens - 0.31), zero crossing at 0.31.
    const sensitivities = [0.2, 0.25, 0.3, 0.35, 0.4];
    const sessions = sensitivities.map((s) =>
      makeSession({ sensitivity: s, accuracy: 0.8, avgErrorDeg: 1, overshootBias: 10 * (s - 0.31), shots: 80 }),
    );
    const buckets = bucketBySensitivity(sessions);
    const trend = overshootTrend(buckets);
    expect(trend.slope).toBeCloseTo(10, 0);
    expect(trend.r2).toBeGreaterThan(0.95);
    const crossing = -trend.intercept / trend.slope;
    expect(crossing).toBeCloseTo(0.31, 1);
  });

  it('returns zero slope / zero r2 for a single bucket (no trend can be fit)', () => {
    const buckets = bucketBySensitivity([makeSession({ sensitivity: 0.3, accuracy: 0.8, avgErrorDeg: 1, overshootBias: 0.4 })]);
    const trend = overshootTrend(buckets);
    expect(trend.slope).toBe(0);
    expect(trend.r2).toBe(0);
  });
});

// ------------------------------------------------------------- by family ---

describe('separateByFamily', () => {
  it('splits sessions by scenario family using the caller-supplied lookup', () => {
    const sessions = [
      makeSession({ sensitivity: 0.3, accuracy: 0.8, avgErrorDeg: 1, overshootBias: 0, scenarioId: 'gridshot' }),
      makeSession({ sensitivity: 0.3, accuracy: 0.8, avgErrorDeg: 1, overshootBias: 0, scenarioId: 'trackbot' }),
      makeSession({ sensitivity: 0.3, accuracy: 0.8, avgErrorDeg: 1, overshootBias: 0, scenarioId: 'peeker' }),
    ];
    const lookup = (id: string) => (id === 'gridshot' ? ('clicking' as const) : id === 'trackbot' ? ('tracking' as const) : ('peek' as const));
    const grouped = separateByFamily(sessions, lookup);
    expect(grouped.clicking).toHaveLength(1);
    expect(grouped.tracking).toHaveLength(1);
    expect(grouped.peek).toHaveLength(1);
  });
});
