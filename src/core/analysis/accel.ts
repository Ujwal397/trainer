/**
 * Acceleration-aware analysis.
 *
 * With a RawAccel curve active upstream, "sensitivity" is not one number: the
 * degrees-per-count the player experienced depended on how fast they moved
 * their hand. Averaging across that hides the single most useful distinction
 * available to someone tuning an accelerated setup:
 *
 *   - a base sensitivity that is too high overshoots at EVERY speed;
 *   - a curve that is too aggressive overshoots only at HIGH speed.
 *
 * Both look identical in a pooled average, and the fixes are opposite. This
 * module separates them by comparing error against flick speed.
 */
import type { SessionRecord, ShotEvent } from '../types';
import { mean, percentile, stdDev } from '../math';

export interface SpeedBand {
  label: string;
  /** Peak angular velocity range of the flicks in this band, deg/s. */
  minVelDeg: number;
  maxVelDeg: number;
  shots: number;
  /** Mean signed overshoot. >0 = flicked past, <0 = stopped short. */
  overshootBias: number;
  avgErrorDeg: number;
  accuracy: number;
  /** Mean count-to-degree gain the driver applied to these flicks. */
  avgEffectiveGain: number;
}

export type AccelVerdict =
  | 'insufficient-data'
  | 'curve-too-aggressive'
  | 'curve-too-weak'
  | 'curve-suits-you'
  | 'base-sens-is-the-problem';

export interface AccelAnalysis {
  /** Whether the analysed sessions declared an active curve. */
  active: boolean;
  bands: SpeedBand[];
  /**
   * Least-squares slope of per-shot overshoot against effective gain, in
   * degrees of overshoot per unit of gain. The core signal: a positive slope
   * means the harder the driver accelerated, the further past the target the
   * player landed.
   */
  gainOvershootSlope: number;
  r2: number;
  /** Difference in overshoot bias between the fastest and slowest bands. */
  fastVsSlowOvershoot: number;
  verdict: AccelVerdict;
  /** 0..1, driven by shot count, speed spread and fit quality. */
  confidence: number;
  reasoning: string[];
}

export interface AccelOptions {
  /** Minimum shots before any verdict beyond `insufficient-data` is offered. */
  minShots?: number;
  /**
   * Overshoot difference (degrees) between fast and slow flicks below which
   * the curve is treated as neutral. Set from typical aim noise rather than
   * zero, so ordinary variance is not read as a trend.
   */
  neutralBandDeg?: number;
}

const DEFAULTS: Required<AccelOptions> = { minShots: 120, neutralBandDeg: 0.25 };

/** Shots that represent a real flick, not a micro-adjust or a tracking frame. */
function flickShots(sessions: SessionRecord[]): ShotEvent[] {
  const out: ShotEvent[] = [];
  for (const s of sessions) {
    for (const shot of s.shots) {
      // A shot with no meaningful approach carries no overshoot information.
      if (shot.directAngleDeg >= 1 && Number.isFinite(shot.overshootDeg)) out.push(shot);
    }
  }
  return out;
}

/**
 * Splits by terciles of observed flick speed rather than fixed thresholds,
 * because what counts as "fast" depends entirely on the player's sensitivity
 * and the scenario mix. Fixed cutoffs would put every shot in one band for
 * some players and spread them evenly for others.
 */
function bandShots(shots: ShotEvent[]): SpeedBand[] {
  if (shots.length === 0) return [];
  const vels = shots.map((s) => s.peakAngularVelDeg);
  const lo = percentile(vels, 1 / 3);
  const hi = percentile(vels, 2 / 3);

  const groups: Array<{ label: string; items: ShotEvent[] }> = [
    { label: 'slow', items: [] },
    { label: 'medium', items: [] },
    { label: 'fast', items: [] },
  ];
  for (const s of shots) {
    const idx = s.peakAngularVelDeg <= lo ? 0 : s.peakAngularVelDeg <= hi ? 1 : 2;
    groups[idx].items.push(s);
  }

  return groups
    .filter((g) => g.items.length > 0)
    .map((g) => {
      const v = g.items.map((s) => s.peakAngularVelDeg);
      return {
        label: g.label,
        minVelDeg: Math.min(...v),
        maxVelDeg: Math.max(...v),
        shots: g.items.length,
        overshootBias: mean(g.items.map((s) => s.overshootDeg)),
        avgErrorDeg: mean(g.items.map((s) => s.errorAngleDeg)),
        accuracy: g.items.filter((s) => s.hit).length / g.items.length,
        avgEffectiveGain: mean(g.items.map((s) => s.effectiveGain)),
      };
    });
}

/** Least-squares fit of y on x, returning slope and r-squared. */
function fit(xs: number[], ys: number[]): { slope: number; r2: number } {
  const n = xs.length;
  if (n < 3) return { slope: 0, r2: 0 };
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (sxx <= 1e-12) return { slope: 0, r2: 0 };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (slope * xs[i] + intercept)) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  return { slope, r2: ssTot <= 1e-12 ? 0 : Math.max(0, 1 - ssRes / ssTot) };
}

export function analyseAcceleration(
  sessions: SessionRecord[],
  opts: AccelOptions = {},
): AccelAnalysis {
  const o = { ...DEFAULTS, ...opts };
  const accelSessions = sessions.filter((s) => s.rawAccelEnabled);
  const active = accelSessions.length > 0;
  const shots = flickShots(active ? accelSessions : sessions);
  const bands = bandShots(shots);

  const empty = (reason: string): AccelAnalysis => ({
    active,
    bands,
    gainOvershootSlope: 0,
    r2: 0,
    fastVsSlowOvershoot: 0,
    verdict: 'insufficient-data',
    confidence: 0,
    reasoning: [reason],
  });

  if (!active) return empty('No sessions recorded with a RawAccel curve declared, so there is nothing to attribute to acceleration.');
  if (shots.length < o.minShots) {
    return empty(
      `Only ${shots.length} flicks with a measurable approach; ${o.minShots} are needed before separating curve error from base-sensitivity error.`,
    );
  }

  const { slope, r2 } = fit(shots.map((s) => s.effectiveGain), shots.map((s) => s.overshootDeg));

  const slowBand = bands.find((b) => b.label === 'slow');
  const fastBand = bands.find((b) => b.label === 'fast');
  const fastVsSlow = fastBand && slowBand ? fastBand.overshootBias - slowBand.overshootBias : 0;
  const slowBias = slowBand ? slowBand.overshootBias : 0;

  // Gain spread is what makes the regression meaningful: if every flick was
  // accelerated identically, the slope is fitted through a single x value and
  // says nothing, however many shots there are.
  const gainSpread = stdDev(shots.map((s) => s.effectiveGain));
  const spreadFactor = Math.min(1, gainSpread / 0.15);
  const shotFactor = Math.min(1, shots.length / 400);
  const confidence = Math.max(0, Math.min(1, 0.35 * shotFactor + 0.35 * spreadFactor + 0.3 * r2));

  const reasoning: string[] = [];
  let verdict: AccelVerdict;

  const slowIsOff = Math.abs(slowBias) > o.neutralBandDeg;

  if (Math.abs(fastVsSlow) <= o.neutralBandDeg && !slowIsOff) {
    verdict = 'curve-suits-you';
    reasoning.push(
      `Overshoot is consistent across flick speeds (${fastVsSlow >= 0 ? '+' : ''}${fastVsSlow.toFixed(2)}° from slow to fast), so your curve is not distorting fast flicks.`,
    );
  } else if (fastVsSlow > o.neutralBandDeg) {
    verdict = 'curve-too-aggressive';
    reasoning.push(
      `Fast flicks overshoot ${fastVsSlow.toFixed(2)}° more than slow ones. That gap tracks flick speed, not distance, which points at the acceleration curve rather than your base sensitivity.`,
    );
    reasoning.push('Reducing the curve\'s strength (lower acceleration, or a lower output cap) should tighten fast flicks without touching your slow-aim feel.');
  } else if (fastVsSlow < -o.neutralBandDeg) {
    verdict = 'curve-too-weak';
    reasoning.push(
      `Fast flicks fall ${Math.abs(fastVsSlow).toFixed(2)}° shorter than slow ones, so the curve is not carrying you far enough when you move quickly.`,
    );
  } else {
    verdict = 'base-sens-is-the-problem';
    reasoning.push(
      `Overshoot is roughly equal at every flick speed (${slowBias >= 0 ? '+' : ''}${slowBias.toFixed(2)}° even on slow flicks), so this is your base sensitivity rather than the curve.`,
    );
  }

  if (slowIsOff && verdict !== 'base-sens-is-the-problem') {
    reasoning.push(
      `Your slow flicks are also ${slowBias > 0 ? 'long' : 'short'} by ${Math.abs(slowBias).toFixed(2)}°, so there is a base-sensitivity component on top of the curve effect.`,
    );
  }

  reasoning.push(
    `Overshoot rises ${slope.toFixed(2)}° per unit of applied gain (r² ${r2.toFixed(2)}) across ${shots.length} flicks.`,
  );
  if (confidence < 0.5) {
    reasoning.push('Confidence is low — train across a wider range of flick distances so the curve is exercised at more speeds.');
  }

  return { active, bands, gainOvershootSlope: slope, r2, fastVsSlowOvershoot: fastVsSlow, verdict, confidence, reasoning };
}
