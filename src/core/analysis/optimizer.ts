/**
 * Reconciles several independent estimators of "optimal sensitivity" into
 * one recommendation. Each estimator looks at a different symptom of
 * mis-tuned sensitivity (raw performance, overshoot direction, consistency,
 * correction count, path straightness, speed/accuracy trade-off) — they
 * mostly agree when there's enough data and disagree in informative ways
 * when there isn't, which is exactly what feeds the confidence score.
 */
import type { MetricVerdict, ScenarioFamily, SensBucket, SensRecommendation, SessionRecord, Vec2 } from '../types';
import { clamp, stdDev } from '../math';
import { CM_PER_INCH, VALORANT_DEG_PER_COUNT } from '../constants';
import {
  bucketBySensitivity,
  type BucketOptions,
  type CompositeWeights,
  minMaxNormalize,
  overshootTrend,
  separateByFamily,
} from './metrics';

export interface RecommendOptions {
  weights?: CompositeWeights;
  bucketOptions?: BucketOptions;
}

// ------------------------------------------------------------ quadratic fit --

interface QuadraticFit {
  a: number;
  b: number;
  c: number;
  r2: number;
}

/** Solves a 3x3 linear system via Gaussian elimination with partial pivoting. Null if singular. */
function solve3x3(a: number[][], rhs: number[]): [number, number, number] | null {
  const m = a.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-10) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const factor = m[r][col] / m[col][col];
      for (let c = col; c < 4; c++) m[r][c] -= factor * m[col][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** Weighted least-squares fit of y = a*x^2 + b*x + c, via the normal equations. Null if under-determined/singular. */
function fitQuadratic(pts: { x: number; y: number; w: number }[]): QuadraticFit | null {
  let m0 = 0;
  let m1 = 0;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  let t0 = 0;
  let t1 = 0;
  let t2 = 0;
  for (const p of pts) {
    const w = p.w > 0 ? p.w : 1;
    const x2 = p.x * p.x;
    m0 += w;
    m1 += w * p.x;
    m2 += w * x2;
    m3 += w * x2 * p.x;
    m4 += w * x2 * x2;
    t0 += w * p.y;
    t1 += w * p.x * p.y;
    t2 += w * x2 * p.y;
  }
  const sol = solve3x3(
    [
      [m4, m3, m2],
      [m3, m2, m1],
      [m2, m1, m0],
    ],
    [t2, t1, t0],
  );
  if (!sol) return null;
  const [a, b, c] = sol;

  const yBar = t0 / (m0 > 1e-9 ? m0 : 1);
  let ssRes = 0;
  let ssTot = 0;
  for (const p of pts) {
    const w = p.w > 0 ? p.w : 1;
    const pred = a * p.x * p.x + b * p.x + c;
    ssRes += w * (p.y - pred) ** 2;
    ssTot += w * (p.y - yBar) ** 2;
  }
  const r2 = ssTot > 1e-9 ? clamp(1 - ssRes / ssTot, 0, 1) : 0;
  return { a, b, c, r2 };
}

// ------------------------------------------------------------- estimators --

interface RawEstimate {
  metric: string;
  optimum: number;
  r2: number;
  /** Total shots feeding this estimator — part of how its consensus weight/confidence is derived. */
  support: number;
  extrapolated: boolean;
  explanation: string;
}

type ExtremumMode = 'max' | 'min';

/**
 * Fits a quadratic to `yOf(bucket)` vs sensitivity and returns the fitted
 * extremum (max or min per `mode`), or falls back to the best *sampled*
 * bucket when there isn't enough data or the fit curves the wrong way (e.g.
 * a "max" search that fit a concave-up parabola has no interior maximum).
 *
 * Critically: a vertex outside the sampled sensitivity range is clamped into
 * that range and flagged `extrapolated` — extrapolating a parabola past your
 * data is exactly how you end up recommending a nonsense sensitivity.
 */
function estimateExtremum(
  buckets: SensBucket[],
  yOf: (b: SensBucket) => number,
  mode: ExtremumMode,
  metricName: string,
  explain: (optimum: number, extrapolated: boolean, buckets: SensBucket[]) => string,
): RawEstimate {
  const usable = buckets.filter((b) => b.shots > 0);
  const support = usable.reduce((s, b) => s + b.shots, 0);
  if (usable.length === 0) {
    return { metric: metricName, optimum: 0, r2: 0, support: 0, extrapolated: false, explanation: 'No data yet.' };
  }

  const sampledBest = usable.reduce((best, b) => {
    const better = mode === 'max' ? yOf(b) > yOf(best) : yOf(b) < yOf(best);
    return better ? b : best;
  }, usable[0]);

  const thinCaveat = usable.length < 3 ? ' Only a few sensitivities tested so far — treat this as a rough estimate.' : '';

  if (usable.length < 3) {
    const optimum = sampledBest.sensitivity;
    return {
      metric: metricName,
      optimum,
      r2: 0,
      support,
      extrapolated: false,
      explanation: explain(optimum, false, usable) + thinCaveat,
    };
  }

  const xs = usable.map((b) => b.sensitivity);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const pts = usable.map((b) => ({ x: b.sensitivity, y: yOf(b), w: b.shots }));
  const fit = fitQuadratic(pts);

  const curvatureOk = fit ? (mode === 'max' ? fit.a < 0 : fit.a > 0) : false;
  if (!fit || !curvatureOk) {
    const optimum = sampledBest.sensitivity;
    return {
      metric: metricName,
      optimum,
      r2: fit?.r2 ?? 0,
      support,
      extrapolated: false,
      explanation: explain(optimum, false, usable),
    };
  }

  const vertex = -fit.b / (2 * fit.a);
  const extrapolated = vertex < lo || vertex > hi;
  const optimum = clamp(vertex, lo, hi);
  return { metric: metricName, optimum, r2: fit.r2, support, extrapolated, explanation: explain(optimum, extrapolated, usable) };
}

function extrapolationNote(extrapolated: boolean): string {
  return extrapolated
    ? ' The fitted optimum actually falls outside your tested range, so this is clamped to the edge of what you tested — sample wider sensitivities to pin it down.'
    : '';
}

function explainCompositePeak(optimum: number, extrapolated: boolean, buckets: SensBucket[]): string {
  return (
    `Overall performance (composite score) peaks near ${optimum.toFixed(3)} sensitivity across ` +
    `${buckets.length} tested value${buckets.length === 1 ? '' : 's'}.` +
    extrapolationNote(extrapolated)
  );
}

function explainConsistency(optimum: number, extrapolated: boolean): string {
  return (
    `Your aim error is most consistent (lowest std-dev) around ${optimum.toFixed(3)} sensitivity.` +
    extrapolationNote(extrapolated)
  );
}

function explainMicroCorrections(optimum: number, extrapolated: boolean): string {
  return (
    `Micro-corrections are fewest around ${optimum.toFixed(3)} sensitivity — too high forces constant ` +
    `small corrections, too low forces slow multi-stage adjustments.` +
    extrapolationNote(extrapolated)
  );
}

function explainPathEfficiency(optimum: number, extrapolated: boolean): string {
  return (
    `Flicks are straightest (path length closest to the direct angle) around ${optimum.toFixed(3)} sensitivity.` +
    extrapolationNote(extrapolated)
  );
}

/**
 * Least-squares fit of overshoot vs sensitivity, solved for where it crosses
 * zero. This is the highest-signal estimator: a player overshooting at high
 * sens and undershooting at low sens crosses zero at their natural
 * sensitivity, independent of how "good" their aim otherwise is.
 */
function overshootZeroCrossingEstimate(buckets: SensBucket[]): RawEstimate {
  const usable = buckets.filter((b) => b.shots > 0);
  const support = usable.reduce((s, b) => s + b.shots, 0);
  if (usable.length === 0) {
    return { metric: 'overshootZeroCrossing', optimum: 0, r2: 0, support: 0, extrapolated: false, explanation: 'No data yet.' };
  }
  if (usable.length === 1) {
    return {
      metric: 'overshootZeroCrossing',
      optimum: usable[0].sensitivity,
      r2: 0,
      support,
      extrapolated: false,
      explanation: `Only one sensitivity (${usable[0].sensitivity}) tested so far — can't fit an overshoot trend yet.`,
    };
  }

  const trend = overshootTrend(usable);
  const xs = usable.map((b) => b.sensitivity);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);

  let optimum: number;
  let extrapolated = false;
  if (Math.abs(trend.slope) > 1e-6) {
    const crossing = -trend.intercept / trend.slope;
    extrapolated = crossing < lo || crossing > hi;
    optimum = clamp(crossing, lo, hi);
  } else {
    const flattest = usable.reduce((b, c) => (Math.abs(c.overshootBias) < Math.abs(b.overshootBias) ? c : b), usable[0]);
    optimum = flattest.sensitivity;
  }

  const sorted = [...usable].sort((a, b) => a.sensitivity - b.sensitivity);
  const low = sorted[0];
  const high = sorted[sorted.length - 1];
  const sign = (x: number): string => (x >= 0 ? `+${x.toFixed(2)}` : x.toFixed(2));
  const explanation =
    `Overshoot goes from ${sign(low.overshootBias)} deg at ${low.sensitivity} sens to ${sign(high.overshootBias)} deg ` +
    `at ${high.sensitivity} sens; your estimated zero-crossing (natural sensitivity) is ${optimum.toFixed(3)}.` +
    extrapolationNote(extrapolated);

  return { metric: 'overshootZeroCrossing', optimum, r2: trend.r2, support, extrapolated, explanation };
}

/**
 * Picks the bucket closest (in normalised speed/accuracy space) to the ideal
 * "fast and accurate" corner. Not a curve fit — a discrete Pareto-style pick
 * over the sampled buckets — so its confidence is driven by sample support
 * rather than an r2.
 */
function timeAccuracyFrontierEstimate(buckets: SensBucket[]): RawEstimate {
  const usable = buckets.filter((b) => b.shots > 0);
  const support = usable.reduce((s, b) => s + b.shots, 0);
  if (usable.length === 0) {
    return { metric: 'timeAccuracyFrontier', optimum: 0, r2: 0, support: 0, extrapolated: false, explanation: 'No data yet.' };
  }
  const nTime = minMaxNormalize(usable.map((b) => b.avgTimeToTargetMs)); // 0 = fastest
  const nAcc = minMaxNormalize(usable.map((b) => b.accuracy)); // 1 = most accurate

  let bestIdx = 0;
  let bestDist = Infinity;
  usable.forEach((_, i) => {
    const dist = Math.hypot(nTime[i], 1 - nAcc[i]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  });
  const best = usable[bestIdx];
  // A pseudo-r2 standing in for fit quality: more sampled points make the
  // frontier pick more trustworthy, since it's a discrete choice, not a fit.
  const r2 = clamp((usable.length - 1) / 4, 0, 1);
  const explanation =
    `${best.sensitivity.toFixed(3)} sensitivity sits closest to the ideal fast+accurate corner among tested values ` +
    `(avg ${best.avgTimeToTargetMs.toFixed(0)}ms to target at ${(best.accuracy * 100).toFixed(0)}% accuracy).`;
  return { metric: 'timeAccuracyFrontier', optimum: best.sensitivity, r2, support, extrapolated: false, explanation };
}

function buildEstimates(buckets: SensBucket[]): RawEstimate[] {
  return [
    estimateExtremum(buckets, (b) => b.compositeScore, 'max', 'compositePeak', explainCompositePeak),
    overshootZeroCrossingEstimate(buckets),
    estimateExtremum(buckets, (b) => b.errorConsistency, 'min', 'consistencyMinimum', explainConsistency),
    estimateExtremum(buckets, (b) => b.avgMicroCorrections, 'min', 'microCorrectionMinimum', explainMicroCorrections),
    // pathEfficiency is pathLength/directAngle (>=1, 1.0 = perfectly
    // straight), so "straightest" means the minimum, despite the metric's name.
    estimateExtremum(buckets, (b) => b.pathEfficiency, 'min', 'pathEfficiencyOptimum', explainPathEfficiency),
    timeAccuracyFrontierEstimate(buckets),
  ];
}

/** Confidence contribution of a single estimator: fit quality *and* how much data actually backs it. */
function estimatorConfidence(r2: number, support: number, minShotsForFullSupport = 150): number {
  const supportFactor = clamp(support / minShotsForFullSupport, 0, 1);
  return clamp(0.35 * supportFactor + 0.65 * clamp(r2, 0, 1), 0, 1);
}

function weightedConsensus(estimates: RawEstimate[], buckets: SensBucket[]): number {
  const weights = estimates.map((e) => estimatorConfidence(e.r2, e.support));
  const totalW = weights.reduce((a, b) => a + b, 0);
  if (totalW < 1e-6) {
    // Nobody's confident — fall back to whichever tested bucket scored best overall.
    const best = buckets.reduce((b, c) => (c.compositeScore > b.compositeScore ? c : b), buckets[0]);
    return best.sensitivity;
  }
  return estimates.reduce((s, e, i) => s + e.optimum * weights[i], 0) / totalW;
}

/**
 * Overall confidence combines four independent things, any one of which
 * being weak should keep the number honest:
 *   - total shots analysed (statistical power)
 *   - how many *distinct* sensitivities were actually sampled (a single
 *     sensitivity, however many shots, can never localise an optimum — the
 *     x-axis has no spread)
 *   - how wide that sampled range is (five values crammed into 0.30-0.31
 *     barely constrains anything either)
 *   - how well the independent estimators agree with each other, relative
 *     to the sampled range
 */
function computeOverallConfidence(buckets: SensBucket[], estimates: RawEstimate[]): number {
  const totalShots = buckets.reduce((s, b) => s + b.shots, 0);
  const distinctSens = new Set(buckets.map((b) => b.sensitivity)).size;
  const xs = buckets.map((b) => b.sensitivity);
  const range = xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0;

  const shotsFactor = clamp(totalShots / 500, 0, 1);
  const spreadFactor = clamp((distinctSens - 1) / 4, 0, 1); // 5+ distinct values = full credit
  const rangeFactor = clamp(range / 0.3, 0, 1); // 0.3 sens units of spread = full credit

  let agreementFactor = 0;
  if (range > 1e-6) {
    const optimums = estimates.filter((e) => e.support > 0).map((e) => e.optimum);
    if (optimums.length >= 2) {
      agreementFactor = clamp(1 - stdDev(optimums) / range, 0, 1);
    }
  }

  return clamp(0.3 * shotsFactor + 0.25 * spreadFactor + 0.2 * rangeFactor + 0.25 * agreementFactor, 0, 1);
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * The guided sweep: which sensitivities to test next to most reduce
 * uncertainty. Widens the range when the recommendation sits at (or near) an
 * already-tested edge — that's a sign the true optimum might be further out
 * — otherwise fills the largest untested gap between sampled sensitivities.
 */
function suggestNextSens(buckets: SensBucket[], recommendedSens: number): number[] {
  const xs = [...new Set(buckets.map((b) => b.sensitivity))].sort((a, b) => a - b);
  if (xs.length === 0) return [];
  if (xs.length === 1) {
    const s = xs[0];
    return [round4(Math.max(0.05, s * 0.6)), round4(s * 1.6)];
  }

  const lo = xs[0];
  const hi = xs[xs.length - 1];
  const range = hi - lo;
  const edgeMargin = Math.max(range * 0.1, 0.01);
  const suggestions: number[] = [];

  if (recommendedSens <= lo + edgeMargin) {
    suggestions.push(round4(Math.max(0.02, lo - Math.max(range * 0.5, lo * 0.3))));
  }
  if (recommendedSens >= hi - edgeMargin) {
    suggestions.push(round4(hi + Math.max(range * 0.5, hi * 0.3)));
  }

  let bestGap = -1;
  let bestMid = 0;
  for (let i = 1; i < xs.length; i++) {
    const gap = xs[i] - xs[i - 1];
    if (gap > bestGap) {
      bestGap = gap;
      bestMid = (xs[i] + xs[i - 1]) / 2;
    }
  }
  if (bestGap > edgeMargin) suggestions.push(round4(bestMid));

  if (suggestions.length === 0) {
    // Already dense around the recommendation — suggest a tight bracket to refine it further.
    suggestions.push(round4(Math.max(0.02, recommendedSens - range * 0.15)), round4(recommendedSens + range * 0.15));
  }

  return [...new Set(suggestions)].filter((s) => s > 0).sort((a, b) => a - b);
}

function buildCurve(buckets: SensBucket[]): Vec2[] {
  const usable = buckets.filter((b) => b.shots > 0);
  if (usable.length === 0) return [];
  const xs = usable.map((b) => b.sensitivity);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);

  if (usable.length < 3 || hi - lo < 1e-6) {
    return usable.map((b) => ({ x: b.sensitivity, y: b.compositeScore }));
  }
  const fit = fitQuadratic(usable.map((b) => ({ x: b.sensitivity, y: b.compositeScore, w: b.shots })));
  if (!fit) return usable.map((b) => ({ x: b.sensitivity, y: b.compositeScore }));

  const N = 40;
  const curve: Vec2[] = [];
  for (let i = 0; i < N; i++) {
    const x = lo + ((hi - lo) * i) / (N - 1);
    curve.push({ x, y: clamp(fit.a * x * x + fit.b * x + fit.c, 0, 100) });
  }
  return curve;
}

function emptyRecommendation(reasoning: string[]): SensRecommendation {
  return {
    recommendedSens: 0,
    recommendedEDPI: 0,
    recommendedCm360: 0,
    confidence: 0,
    sessionsAnalysed: 0,
    shotsAnalysed: 0,
    suggestedNextSens: [],
    perMetric: [],
    buckets: [],
    curve: [],
    reasoning,
  };
}

function trackReasoning(nonAccelBuckets: SensBucket[], accelBuckets: SensBucket[]): string[] {
  const nonAccelShots = nonAccelBuckets.reduce((s, b) => s + b.shots, 0);
  const accelShots = accelBuckets.reduce((s, b) => s + b.shots, 0);
  const lines: string[] = [];
  if (nonAccelShots > 0 && accelShots > 0) {
    const nonAccelBest = nonAccelBuckets.reduce((b, c) => (c.compositeScore > b.compositeScore ? c : b), nonAccelBuckets[0]);
    const accelBest = accelBuckets.reduce((b, c) => (c.compositeScore > b.compositeScore ? c : b), accelBuckets[0]);
    const better = accelBest.compositeScore > nonAccelBest.compositeScore ? 'RawAccel' : 'flat (non-RawAccel)';
    lines.push(
      `Both RawAccel and flat-sensitivity sessions are present and are analysed as separate tracks (accel changes the ` +
        `effective sensitivity with speed, so the two aren't comparable on the same axis). Best composite score so far: ` +
        `flat ${nonAccelBest.compositeScore.toFixed(1)} at ${nonAccelBest.sensitivity} sens vs RawAccel ${accelBest.compositeScore.toFixed(1)} ` +
        `at base ${accelBest.sensitivity} sens — ${better} is currently performing better.`,
    );
  } else if (accelShots > 0 && nonAccelShots === 0) {
    lines.push('All sessions so far use RawAccel; no flat-sensitivity baseline to compare against yet.');
  } else if (nonAccelShots > 0 && accelShots === 0) {
    lines.push('All sessions so far use a flat (non-RawAccel) sensitivity; no RawAccel data to compare against yet.');
  }
  return lines;
}

/**
 * Combines the estimators above into one recommendation. RawAccel and
 * non-RawAccel sessions are bucketed as two separate tracks and never
 * pooled; the recommendation number itself is generated from whichever
 * track has more analysed shots (see `trackReasoning` for the comparison
 * note when both are present), while `buckets` in the result always includes
 * both tracks so a caller can inspect either directly.
 */
export function recommendSensitivity(sessions: SessionRecord[], opts: RecommendOptions = {}): SensRecommendation {
  if (sessions.length === 0) return emptyRecommendation(['No session data available yet.']);

  const nonAccelSessions = sessions.filter((s) => !s.rawAccelEnabled);
  const accelSessions = sessions.filter((s) => s.rawAccelEnabled);

  const bucketOpts: BucketOptions = { ...opts.bucketOptions, weights: opts.weights };
  const nonAccelBuckets = bucketBySensitivity(nonAccelSessions, bucketOpts);
  const accelBuckets = bucketBySensitivity(accelSessions, bucketOpts);

  const nonAccelShots = nonAccelBuckets.reduce((s, b) => s + b.shots, 0);
  const accelShots = accelBuckets.reduce((s, b) => s + b.shots, 0);
  const primaryIsAccel = accelShots > nonAccelShots;
  const primaryBuckets = primaryIsAccel ? accelBuckets : nonAccelBuckets;
  const primarySessions = primaryIsAccel ? accelSessions : nonAccelSessions;

  if (primaryBuckets.length === 0) {
    return emptyRecommendation(['No session data available yet.']);
  }

  const estimates = buildEstimates(primaryBuckets);
  const consensus = weightedConsensus(estimates, primaryBuckets);
  const overallConfidence = computeOverallConfidence(primaryBuckets, estimates);

  const perMetric: MetricVerdict[] = estimates.map((e) => ({
    metric: e.metric,
    optimum: e.optimum,
    confidence: estimatorConfidence(e.r2, e.support),
    explanation: e.explanation,
  }));

  const nearest = primaryBuckets.reduce(
    (best, b) => (Math.abs(b.sensitivity - consensus) < Math.abs(best.sensitivity - consensus) ? b : best),
    primaryBuckets[0],
  );
  const dpi = nearest.sensitivity > 1e-9 ? nearest.eDPI / nearest.sensitivity : 800;
  const recommendedEDPI = dpi * consensus;
  const recommendedCm360 = (360 / (VALORANT_DEG_PER_COUNT.value * consensus * dpi)) * CM_PER_INCH;

  const reasoning: string[] = [
    ...trackReasoning(nonAccelBuckets, accelBuckets),
    `Consensus across ${estimates.length} independent estimators (each weighted by its own fit quality and shot ` +
      `support) points to ${consensus.toFixed(3)} sensitivity, computed from the ${primaryIsAccel ? 'RawAccel' : 'flat'} track.`,
  ];
  if (overallConfidence < 0.4) {
    reasoning.push(
      'Confidence is low — treat this as a starting hypothesis, not a final answer. Train the suggested sensitivities below to sharpen it.',
    );
  }

  return {
    recommendedSens: consensus,
    recommendedEDPI,
    recommendedCm360,
    confidence: overallConfidence,
    sessionsAnalysed: primarySessions.length,
    shotsAnalysed: primaryBuckets.reduce((s, b) => s + b.shots, 0),
    suggestedNextSens: suggestNextSens(primaryBuckets, consensus),
    perMetric,
    buckets: [...nonAccelBuckets, ...accelBuckets],
    curve: buildCurve(primaryBuckets),
    reasoning,
  };
}

// ------------------------------------------------------------- by family --

export interface FamilyRecommendation {
  family: ScenarioFamily;
  recommendation: SensRecommendation;
}

export interface FamilyAnalysis {
  perFamily: FamilyRecommendation[];
  /** Plain-English reconciliation across families — e.g. tracking wanting a lower sens than clicking. */
  note: string;
}

function buildReconciliationNote(perFamily: FamilyRecommendation[]): string {
  if (perFamily.length === 0) return 'No scenario data yet.';
  if (perFamily.length === 1) {
    return (
      `Only ${perFamily[0].family} scenarios trained so far. The optimal sensitivity for tracking is usually lower ` +
      `than for clicking/flicking, so don't apply this number to other scenario types until they have data too.`
    );
  }

  const parts = perFamily.map(
    (f) => `${f.family}: ${f.recommendation.recommendedSens.toFixed(3)} (confidence ${Math.round(f.recommendation.confidence * 100)}%)`,
  );

  let conflictNote = '';
  const tracking = perFamily.find((f) => f.family === 'tracking');
  const clicking = perFamily.find((f) => f.family === 'clicking');
  if (tracking && clicking && tracking.recommendation.shotsAnalysed > 0 && clicking.recommendation.shotsAnalysed > 0) {
    const diff = clicking.recommendation.recommendedSens - tracking.recommendation.recommendedSens;
    if (diff > 0.02) {
      conflictNote =
        ` Tracking favours a lower sensitivity than clicking by ${diff.toFixed(3)}, which is the expected pattern ` +
        `(fine tracking control wants less gain than a flick) — use the lower number if tracking matters more to your ` +
        `playstyle, the higher one if flicking does, rather than averaging them into a compromise that's worse at both.`;
    } else if (diff < -0.02) {
      conflictNote =
        ` Clicking currently favours a lower sensitivity than tracking, which is atypical — likely still noisy with ` +
        `this little data; expect it to reverse as more sessions come in.`;
    }
  }

  return `Per-family optimums — ${parts.join('; ')}.${conflictNote}`;
}

/**
 * Runs `recommendSensitivity` independently per scenario family, since
 * tracking and flicking scenarios pull the optimum in different directions
 * and averaging them away would hide that. Family membership isn't known to
 * this layer (`src/data` is outside its import allowlist), so the caller
 * supplies the `scenarioId -> family` lookup.
 */
export function analyseByFamily(
  sessions: SessionRecord[],
  scenarioFamilyOf: (scenarioId: string) => ScenarioFamily,
  opts: RecommendOptions = {},
): FamilyAnalysis {
  const grouped = separateByFamily(sessions, scenarioFamilyOf);
  const families: ScenarioFamily[] = ['clicking', 'tracking', 'peek'];
  const perFamily: FamilyRecommendation[] = families
    .filter((f) => grouped[f].length > 0)
    .map((f) => ({ family: f, recommendation: recommendSensitivity(grouped[f], opts) }));

  return { perFamily, note: buildReconciliationNote(perFamily) };
}
