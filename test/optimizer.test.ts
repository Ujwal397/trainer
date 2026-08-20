import { describe, expect, it } from 'vitest';
import type { AccelCurve, SensConfig, SessionRecord, ShotEvent } from '../src/core/types';
import { bucketBySensitivity } from '../src/core/analysis/metrics';
import { analyseByFamily, recommendSensitivity } from '../src/core/analysis/optimizer';

// -------------------------------------------------------- synthetic player --
//
// A simulated player with a known true-optimum sensitivity. Every metric is
// modelled as a function of `d = sensitivity - TRUE_OPTIMUM` plus noise:
//   - overshoot grows *linearly* with d (proportional, signed) — the model
//     the task spec calls out explicitly.
//   - accuracy, error, consistency, micro-corrections, path efficiency and
//     time-to-target are all U/inverted-U shaped in d (quadratic), peaking
//     or bottoming out at d = 0.
// This lets the recovery test assert the optimizer's several independent
// estimators all converge back on TRUE_OPTIMUM within tolerance.

const TRUE_OPTIMUM = 0.31;

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

function makeSens(sensitivity: number, rawAccelEnabled = false): SensConfig {
  return { dpi: 800, pollingRateHz: 1000, sensitivity, scopedMultiplier: 1, rawAccelEnabled, curve: OFF_CURVE, invertY: false };
}

/** mulberry32 — small, seeded, deterministic. Kept local to the test so it doesn't depend on `src/core/rng.ts`. */
function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return {
    next(): number {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    gaussian(): number {
      const u = 1 - this.next();
      const v = this.next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

interface PlayerModel {
  peakAccuracy: number;
  kAcc: number;
  baseError: number;
  kErr: number;
  kOvershoot: number;
  baseStd: number;
  kStd: number;
  baseMicro: number;
  kMicro: number;
  basePathRatio: number;
  kPath: number;
  baseTimeMs: number;
  kTime: number;
  peakTracking: number;
  kTracking: number;
  peakHeadshot: number;
}

const DEFAULT_MODEL: PlayerModel = {
  peakAccuracy: 0.85,
  kAcc: 3.0,
  baseError: 1.0,
  kErr: 40,
  kOvershoot: 8,
  baseStd: 2.0,
  kStd: 15,
  baseMicro: 1.0,
  kMicro: 30,
  basePathRatio: 1.05,
  kPath: 2.0,
  baseTimeMs: 250,
  kTime: 2000,
  peakTracking: 0.7,
  kTracking: 1.0,
  peakHeadshot: 0.35,
};

let sessionCounter = 0;

/** Builds one synthetic session at `sensitivity`, drawing `shotCount` shots from the ground-truth model plus noise. */
function makeSyntheticSession(
  rng: ReturnType<typeof makeRng>,
  sensitivity: number,
  shotCount: number,
  model: PlayerModel = DEFAULT_MODEL,
  rawAccelEnabled = false,
): SessionRecord {
  const d = sensitivity - TRUE_OPTIMUM;
  sessionCounter++;

  const meanError = Math.max(0.1, model.baseError + model.kErr * d * d);
  const meanOvershoot = model.kOvershoot * d;
  const meanStd = Math.max(0.2, model.baseStd + model.kStd * Math.abs(d));
  const meanMicro = Math.max(0, model.baseMicro + model.kMicro * d * d);
  const meanPathRatio = Math.max(1.0, model.basePathRatio + model.kPath * d * d);
  const meanTime = Math.max(80, model.baseTimeMs + model.kTime * d * d);
  const pHit = Math.min(0.98, Math.max(0.02, model.peakAccuracy - model.kAcc * d * d));
  const pHeadshotGivenHit = Math.min(0.9, Math.max(0.02, model.peakHeadshot - 0.5 * d * d));
  const trackingAccuracy = Math.min(0.95, Math.max(0.05, model.peakTracking - model.kTracking * d * d));

  const shots: ShotEvent[] = [];
  let hits = 0;
  let headshots = 0;
  for (let i = 0; i < shotCount; i++) {
    const hit = rng.next() < pHit;
    const zone = hit ? (rng.next() < pHeadshotGivenHit ? 'head' : 'body') : null;
    if (hit) hits++;
    if (zone === 'head') headshots++;

    // Noise scale itself grows away from the true optimum, so errorConsistency
    // (the std-dev of errorAngleDeg) is genuinely worst away from TRUE_OPTIMUM —
    // otherwise the consistency-minimum estimator would have nothing real to fit.
    const errorAngleDeg = Math.max(0, meanError + rng.gaussian() * meanStd * 0.3);
    const overshootDeg = meanOvershoot + rng.gaussian() * 0.5;
    const microCorrections = Math.max(0, Math.round(meanMicro + rng.gaussian() * 0.4));
    const directAngleDeg = 25 + rng.next() * 10;
    const pathLengthDeg = directAngleDeg * Math.max(1, meanPathRatio + rng.gaussian() * 0.03);
    const timeToTargetMs = i % 4 === 0 ? Math.max(50, meanTime + rng.gaussian() * 15) : null;

    shots.push({
      t: i * 600,
      weaponId: 'vandal',
      shotIndexInBurst: 0,
      hit,
      zone,
      targetId: `target_${i}`,
      distanceM: 15,
      errorAngleDeg,
      errorYawDeg: errorAngleDeg * 0.7,
      errorPitchDeg: errorAngleDeg * 0.3,
      timeToTargetMs,
      overshootDeg,
      microCorrections,
      pathLengthDeg,
      directAngleDeg,
      peakAngularVelDeg: 600,
      spreadDeg: 0.3,
      recoilYawDeg: 0,
      recoilPitchDeg: 0,
      playerSpeed: 0,
      effectiveGain: rawAccelEnabled ? 1.2 : 1,
    });
  }

  const errorAngles = shots.map((s) => s.errorAngleDeg);
  const ttts = shots.map((s) => s.timeToTargetMs).filter((x): x is number => x !== null);
  const avgErrorDeg = errorAngles.reduce((a, b) => a + b, 0) / errorAngles.length;
  const errorConsistency = Math.sqrt(
    errorAngles.reduce((s, x) => s + (x - avgErrorDeg) ** 2, 0) / Math.max(1, errorAngles.length - 1),
  );

  const sens = makeSens(sensitivity, rawAccelEnabled);
  return {
    id: `syn_${sessionCounter}`,
    startedAt: sessionCounter * 100000,
    endedAt: sessionCounter * 100000 + 60000,
    scenarioId: 'gridshot',
    weaponId: 'vandal',
    sens,
    eDPI: sens.dpi * sens.sensitivity,
    cm360: 100,
    rawAccelEnabled,
    summary: {
      shots: shotCount,
      hits,
      accuracy: hits / shotCount,
      headshots,
      headshotRate: hits > 0 ? headshots / hits : 0,
      kills: hits,
      score: hits * 100,
      avgTimeToTargetMs: ttts.length > 0 ? ttts.reduce((a, b) => a + b, 0) / ttts.length : 0,
      avgErrorDeg,
      overshootBias: shots.reduce((a, s) => a + s.overshootDeg, 0) / shotCount,
      avgMicroCorrections: shots.reduce((a, s) => a + s.microCorrections, 0) / shotCount,
      pathEfficiency: shots.reduce((a, s) => a + s.pathLengthDeg / s.directAngleDeg, 0) / shotCount,
      trackingAccuracy,
      errorConsistency,
    },
    shots,
    samples: [],
  };
}

function buildSyntheticDataset(
  sensitivities: number[],
  sessionsPerSens: number,
  shotsPerSession: number,
  seed = 1,
  model: PlayerModel = DEFAULT_MODEL,
  rawAccelEnabled = false,
): SessionRecord[] {
  const rng = makeRng(seed);
  const sessions: SessionRecord[] = [];
  for (const s of sensitivities) {
    for (let i = 0; i < sessionsPerSens; i++) {
      sessions.push(makeSyntheticSession(rng, s, shotsPerSession, model, rawAccelEnabled));
    }
  }
  return sessions;
}

// ------------------------------------------------------------------ tests --

describe('recommendSensitivity — synthetic ground-truth recovery', () => {
  it('recovers the true optimum (0.31) within tolerance from a well-sampled synthetic dataset', () => {
    const sensitivities = [0.2, 0.24, 0.28, 0.32, 0.36, 0.4];
    const sessions = buildSyntheticDataset(sensitivities, 3, 60, 42);

    const rec = recommendSensitivity(sessions);

    expect(rec.recommendedSens).toBeGreaterThan(0);
    // Within 0.03 of the true optimum (sensitivities were sampled every 0.04, so this is a tight bar).
    expect(Math.abs(rec.recommendedSens - TRUE_OPTIMUM)).toBeLessThan(0.03);

    // The overshoot zero-crossing estimator specifically should land very close to
    // truth — overshoot was modelled as a *linear* function of sensitivity, which
    // is exactly what that estimator fits.
    const overshootVerdict = rec.perMetric.find((m) => m.metric === 'overshootZeroCrossing');
    expect(overshootVerdict).toBeDefined();
    expect(Math.abs(overshootVerdict!.optimum - TRUE_OPTIMUM)).toBeLessThan(0.03);

    // With six sensitivities, ~180 shots each, spread across a 0.2 range, confidence should be non-trivial.
    expect(rec.confidence).toBeGreaterThan(0.4);
    expect(rec.sessionsAnalysed).toBe(sensitivities.length * 3);
  });

  it('every per-metric optimum and the recommended sens stay within the sampled sensitivity range (no extrapolation past the data)', () => {
    // Deliberately sample only sensitivities *below* the true optimum, so a
    // naive quadratic extrapolation would want to place the vertex outside range.
    const sensitivities = [0.1, 0.14, 0.18, 0.22];
    const sessions = buildSyntheticDataset(sensitivities, 2, 50, 7);
    const rec = recommendSensitivity(sessions);

    const lo = Math.min(...sensitivities);
    const hi = Math.max(...sensitivities);
    for (const verdict of rec.perMetric) {
      expect(verdict.optimum).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(verdict.optimum).toBeLessThanOrEqual(hi + 1e-9);
    }
    expect(rec.recommendedSens).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(rec.recommendedSens).toBeLessThanOrEqual(hi + 1e-9);
  });
});

describe('recommendSensitivity — confidence correctness', () => {
  it('thin data (two sessions, one sensitivity) yields low confidence, never a confident-sounding number', () => {
    const rng = makeRng(99);
    const sessions = [makeSyntheticSession(rng, 0.3, 25), makeSyntheticSession(rng, 0.3, 25)];
    const rec = recommendSensitivity(sessions);
    expect(rec.confidence).toBeLessThan(0.35);
  });

  it('a single-sensitivity dataset never returns high confidence, even with lots of shots', () => {
    const rng = makeRng(123);
    const sessions: SessionRecord[] = [];
    for (let i = 0; i < 20; i++) sessions.push(makeSyntheticSession(rng, 0.3, 200));
    const rec = recommendSensitivity(sessions);
    // 4000 shots at one sensitivity is a lot of data, but there is zero
    // spread on the x-axis, so the optimum cannot actually be localised.
    expect(rec.sessionsAnalysed).toBe(20);
    expect(rec.confidence).toBeLessThan(0.4);
  });

  it('confidence increases with wider, better-sampled sensitivity sweeps', () => {
    const thin = recommendSensitivity(buildSyntheticDataset([0.3], 2, 30, 11));
    const rich = recommendSensitivity(buildSyntheticDataset([0.2, 0.25, 0.3, 0.35, 0.4], 3, 60, 11));
    expect(rich.confidence).toBeGreaterThan(thin.confidence);
  });
});

describe('recommendSensitivity — RawAccel isolation', () => {
  it('never pools RawAccel and non-RawAccel sessions, and reports both tracks', () => {
    const flatSessions = buildSyntheticDataset([0.2, 0.25, 0.3, 0.35, 0.4], 2, 50, 5, DEFAULT_MODEL, false);
    const accelSessions = buildSyntheticDataset([0.2, 0.25, 0.3, 0.35, 0.4], 2, 50, 6, DEFAULT_MODEL, true);
    const rec = recommendSensitivity([...flatSessions, ...accelSessions]);

    const flatBuckets = rec.buckets.filter((b) => !b.rawAccelEnabled);
    const accelBuckets = rec.buckets.filter((b) => b.rawAccelEnabled);
    expect(flatBuckets.length).toBeGreaterThan(0);
    expect(accelBuckets.length).toBeGreaterThan(0);
    // Distinct tracks, not merged: same five sensitivities appear in both tracks separately.
    expect(rec.buckets.length).toBe(flatBuckets.length + accelBuckets.length);

    // bucketBySensitivity itself must not silently merge them either.
    const rawBuckets = bucketBySensitivity([...flatSessions, ...accelSessions]);
    const key = (b: { sensitivity: number; rawAccelEnabled: boolean }) => `${b.sensitivity}|${b.rawAccelEnabled}`;
    const keys = new Set(rawBuckets.map(key));
    expect(keys.size).toBe(rawBuckets.length); // no duplicate (sensitivity, track) pairs collapsed together
  });

  it('reasoning mentions both tracks when both are present', () => {
    const flatSessions = buildSyntheticDataset([0.25, 0.3, 0.35], 2, 50, 21, DEFAULT_MODEL, false);
    const accelSessions = buildSyntheticDataset([0.25, 0.3, 0.35], 2, 50, 22, DEFAULT_MODEL, true);
    const rec = recommendSensitivity([...flatSessions, ...accelSessions]);
    const mentionsBoth = rec.reasoning.some((line) => /RawAccel/.test(line) && /flat/.test(line));
    expect(mentionsBoth).toBe(true);
  });
});

describe('analyseByFamily', () => {
  it('produces a per-family recommendation and a reconciliation note', () => {
    const clickingModel: PlayerModel = { ...DEFAULT_MODEL };
    const trackingModel: PlayerModel = { ...DEFAULT_MODEL, kOvershoot: 8 };
    // Tracking's "true" optimum is lower — build it around 0.24 instead of 0.31
    // by shifting which sensitivities are actually the good ones: reuse the
    // same generator but bias the sampled points toward a different centre.
    const clickingSessions = buildSyntheticDataset([0.2, 0.26, 0.31, 0.36, 0.42], 2, 50, 31, clickingModel).map((s) => ({
      ...s,
      scenarioId: 'gridshot',
    }));
    const trackingSessions = buildSyntheticDataset([0.14, 0.19, 0.24, 0.29, 0.34], 2, 50, 32, trackingModel).map((s) => ({
      ...s,
      scenarioId: 'trackbot',
    }));

    const familyOf = (id: string) => (id === 'gridshot' ? ('clicking' as const) : ('tracking' as const));
    const analysis = analyseByFamily([...clickingSessions, ...trackingSessions], familyOf);

    expect(analysis.perFamily.map((f) => f.family).sort()).toEqual(['clicking', 'tracking']);
    expect(analysis.note.length).toBeGreaterThan(0);
    for (const f of analysis.perFamily) {
      expect(f.recommendation.sessionsAnalysed).toBeGreaterThan(0);
    }
  });

  it('flags when only one family has data', () => {
    const sessions = buildSyntheticDataset([0.2, 0.3, 0.4], 2, 40, 41).map((s) => ({ ...s, scenarioId: 'gridshot' }));
    const analysis = analyseByFamily(sessions, () => 'clicking');
    expect(analysis.perFamily).toHaveLength(1);
    expect(analysis.note).toMatch(/clicking/);
  });
});
