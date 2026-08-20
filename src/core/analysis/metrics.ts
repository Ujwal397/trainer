/**
 * Pure aggregation functions over `SessionRecord[]`. Nothing here mutates its
 * input or touches storage/DOM — the optimizer and any UI layer build on top
 * of these.
 */
import type { ScenarioFamily, SensBucket, SessionRecord } from '../types';
import { clamp, mean, stdDev } from '../math';

// ---------------------------------------------------------------- bucketing --

export interface BucketOptions {
  /** Buckets with fewer shots than this are marked `reliable: false` rather than silently trusted. Default 20. */
  minShotsPerBucket?: number;
  /** Drop unreliable buckets from the result entirely instead of just flagging them. Default false. */
  excludeUnreliable?: boolean;
  /** Decimal places used to group near-identical sensitivity values together (float noise guard). Default 4. */
  sensitivityPrecision?: number;
  /** Composite-score weights to use when filling in `compositeScore`. Defaults to `DEFAULT_COMPOSITE_WEIGHTS`. */
  weights?: CompositeWeights;
}

/** `SensBucket` plus an explicit reliability flag — structurally still a `SensBucket`. */
export interface SensBucketWithReliability extends SensBucket {
  /** False when `shots < minShotsPerBucket`. Callers should discount, grey out, or hide these. */
  reliable: boolean;
}

const DEFAULT_MIN_SHOTS_PER_BUCKET = 20;

function round(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

/**
 * Groups sessions by (sensitivity, rawAccelEnabled) — RawAccel sessions are
 * never merged with non-RawAccel ones (see optimizer.ts for why: with
 * acceleration on, "sensitivity" alone doesn't describe the effective gain).
 * Every field on `SensBucket` is computed weighted by each session's shot
 * count, so a 200-shot session doesn't get diluted by a 5-shot one.
 */
export function bucketBySensitivity(sessions: SessionRecord[], opts: BucketOptions = {}): SensBucket[] {
  const minShots = opts.minShotsPerBucket ?? DEFAULT_MIN_SHOTS_PER_BUCKET;
  const precision = opts.sensitivityPrecision ?? 4;
  const weights = opts.weights ?? DEFAULT_COMPOSITE_WEIGHTS;

  const groups = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    const sens = round(s.sens.sensitivity, precision);
    const key = `${sens}|${s.rawAccelEnabled}`;
    const arr = groups.get(key);
    if (arr) arr.push(s);
    else groups.set(key, [s]);
  }

  const raw: SensBucketWithReliability[] = [];
  for (const group of groups.values()) {
    const totalShots = group.reduce((sum, s) => sum + s.summary.shots, 0);
    const w = (f: (s: SessionRecord) => number): number => {
      if (totalShots === 0) return mean(group.map(f));
      return group.reduce((sum, s) => sum + f(s) * s.summary.shots, 0) / totalShots;
    };

    // errorConsistency is a std-dev; averaging std-devs weighted by shot
    // count is an approximation (the mathematically correct pooled std-dev
    // would need per-shot error samples, which live only inside individual
    // ShotEvents). We do have those here via `sessions`, so compute it
    // properly from the raw per-shot error angles across the whole group.
    const allErrorAngles = group.flatMap((s) => s.shots.map((sh) => sh.errorAngleDeg));

    const bucket: SensBucketWithReliability = {
      sensitivity: round(mean(group.map((s) => s.sens.sensitivity)), precision),
      eDPI: w((s) => s.eDPI),
      cm360: w((s) => s.cm360),
      rawAccelEnabled: group[0].rawAccelEnabled,
      sessions: group.length,
      shots: totalShots,
      accuracy: w((s) => s.summary.accuracy),
      headshotRate: w((s) => s.summary.headshotRate),
      avgTimeToTargetMs: w((s) => s.summary.avgTimeToTargetMs),
      avgErrorDeg: w((s) => s.summary.avgErrorDeg),
      errorConsistency: allErrorAngles.length >= 2 ? stdDev(allErrorAngles) : w((s) => s.summary.errorConsistency),
      overshootBias: w((s) => s.summary.overshootBias),
      avgMicroCorrections: w((s) => s.summary.avgMicroCorrections),
      pathEfficiency: w((s) => s.summary.pathEfficiency),
      trackingAccuracy: w((s) => s.summary.trackingAccuracy),
      compositeScore: 0, // filled in below, after normalisation across the whole group
      reliable: totalShots >= minShots,
    };
    raw.push(bucket);
  }

  computeCompositeScoresInPlace(raw, weights);

  const filtered = opts.excludeUnreliable ? raw.filter((b) => b.reliable) : raw;
  return filtered.sort((a, b) => a.sensitivity - b.sensitivity);
}

// ----------------------------------------------------------- composite score --

export interface CompositeWeights {
  accuracy: number;
  headshotRate: number;
  timeToTarget: number;
  errorMagnitude: number;
  errorConsistency: number;
  overshootBias: number;
  microCorrections: number;
  pathEfficiency: number;
  trackingAccuracy: number;
}

/**
 * Default weights for `compositeScore`. Rationale (weights sum to 1.0):
 *  - `accuracy` (0.22) is the largest single weight — it's the most direct,
 *    least-derived outcome measure.
 *  - `errorMagnitude` and `errorConsistency` are weighted *equally* (0.12
 *    each) by design: a player who is sometimes dead-on and sometimes wild is
 *    worse off in a real gunfight than a merely-mediocre-but-steady one, so
 *    consistency must not be a rounding error next to the mean.
 *  - `overshootBias` (0.10) and `microCorrections` (0.08) are the
 *    sensitivity-specific "control quality" signals this whole layer exists
 *    to surface — moderate weight, since they're symptoms whose downstream
 *    effect (worse accuracy/time) is already counted elsewhere.
 *  - `headshotRate` (0.10), `pathEfficiency` (0.08) and `trackingAccuracy`
 *    (0.06) get smaller weights because they're scenario-family-specific
 *    (headshots barely mean anything in a pure tracking scenario;
 *    trackingAccuracy is 0 for click scenarios) — keeping them modest stops
 *    a mixed clicking+tracking dataset from being skewed by whichever family
 *    happens to have more sessions. `separateByFamily` / `analyseByFamily`
 *    are the real answer to that conflict; this default weighting is a
 *    reasonable compromise for an unsegmented view.
 *  - `timeToTarget` (0.12) rounds it out as the other primary speed signal.
 */
export const DEFAULT_COMPOSITE_WEIGHTS: CompositeWeights = {
  accuracy: 0.22,
  headshotRate: 0.1,
  timeToTarget: 0.12,
  errorMagnitude: 0.12,
  errorConsistency: 0.12,
  overshootBias: 0.1,
  microCorrections: 0.08,
  pathEfficiency: 0.08,
  trackingAccuracy: 0.06,
};

/**
 * Min-max normalises `values` to 0..1. Returns 0.5 for every entry when all
 * values are equal (no signal to weight). Exported so the optimizer's Pareto
 * frontier estimator can reuse the exact same normalisation as the composite
 * score instead of re-deriving it slightly differently.
 */
export function minMaxNormalize(values: number[]): number[] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi - lo < 1e-9) return values.map(() => 0.5);
  return values.map((v) => (v - lo) / (hi - lo));
}
const normalize = minMaxNormalize;

/**
 * Fills in `compositeScore` (0..100) on every bucket in `buckets`, normalising
 * each underlying metric across that array first so no single metric's units
 * (ms vs degrees vs a 0..1 fraction) dominate the weighted sum. This is the
 * function that actually implements the composite score; `compositeScore`
 * below is a single-bucket convenience wrapper around it.
 */
function computeCompositeScoresInPlace(buckets: SensBucket[], weights: CompositeWeights): void {
  if (buckets.length === 0) return;

  const nAccuracy = normalize(buckets.map((b) => b.accuracy));
  const nHeadshot = normalize(buckets.map((b) => b.headshotRate));
  // Lower-is-better metrics: normalise then invert (1 - x) so "1" always means "good".
  const nTime = normalize(buckets.map((b) => b.avgTimeToTargetMs)).map((x) => 1 - x);
  const nErrorMag = normalize(buckets.map((b) => b.avgErrorDeg)).map((x) => 1 - x);
  const nErrorCons = normalize(buckets.map((b) => b.errorConsistency)).map((x) => 1 - x);
  // overshootBias is symmetric around 0 — both directions are penalised, so
  // normalise its *magnitude*, not the signed value.
  const nOvershoot = normalize(buckets.map((b) => Math.abs(b.overshootBias))).map((x) => 1 - x);
  const nMicro = normalize(buckets.map((b) => b.avgMicroCorrections)).map((x) => 1 - x);
  // pathEfficiency is pathLength/directAngle (>=1, 1.0 = perfectly straight —
  // see SessionSummary doc), so despite the name, *lower* is better here too.
  const nPath = normalize(buckets.map((b) => b.pathEfficiency)).map((x) => 1 - x);
  const nTracking = normalize(buckets.map((b) => b.trackingAccuracy));

  const totalWeight =
    weights.accuracy +
    weights.headshotRate +
    weights.timeToTarget +
    weights.errorMagnitude +
    weights.errorConsistency +
    weights.overshootBias +
    weights.microCorrections +
    weights.pathEfficiency +
    weights.trackingAccuracy;

  buckets.forEach((b, i) => {
    const weighted =
      nAccuracy[i] * weights.accuracy +
      nHeadshot[i] * weights.headshotRate +
      nTime[i] * weights.timeToTarget +
      nErrorMag[i] * weights.errorMagnitude +
      nErrorCons[i] * weights.errorConsistency +
      nOvershoot[i] * weights.overshootBias +
      nMicro[i] * weights.microCorrections +
      nPath[i] * weights.pathEfficiency +
      nTracking[i] * weights.trackingAccuracy;
    b.compositeScore = totalWeight > 0 ? clamp((weighted / totalWeight) * 100, 0, 100) : 0;
  });
}

/**
 * Single-bucket composite score, 0..100. Because the score is only
 * meaningful relative to a spread of other buckets (see `computeCompositeScoresInPlace`),
 * pass `allBuckets` (the full set this bucket was drawn from) whenever you
 * have it — `bucketBySensitivity` already does this internally. Without it,
 * the bucket is normalised only against itself and the result degenerates to
 * the weighted count of "lower/higher than average" (i.e. ~50), which is not
 * useful for anything beyond a smoke test.
 */
export function compositeScore(
  bucket: SensBucket,
  weights: CompositeWeights = DEFAULT_COMPOSITE_WEIGHTS,
  allBuckets: SensBucket[] = [bucket],
): number {
  const copies = allBuckets.map((b) => ({ ...b }));
  const idx = allBuckets.indexOf(bucket);
  computeCompositeScoresInPlace(copies, weights);
  return idx >= 0 ? copies[idx].compositeScore : copies[0]?.compositeScore ?? 0;
}

// -------------------------------------------------------------- trend fit --

export interface OvershootTrend {
  /** deg of overshoot per unit of sensitivity. */
  slope: number;
  /** overshootBias at sensitivity 0 (extrapolated — not meaningful on its own). */
  intercept: number;
  /** Weighted R^2 of the fit, 0..1. */
  r2: number;
}

/**
 * Weighted least-squares fit of `overshootBias` against `sensitivity`,
 * weighted by each bucket's shot count. This is the highest-signal
 * relationship in the whole analysis: a player who overshoots at high
 * sensitivity and undershoots at low sensitivity crosses zero at their
 * natural sensitivity, and that crossing is a direct estimate independent of
 * how "good" they otherwise are.
 *
 * Callers should pass buckets from a *single* `rawAccelEnabled` track —
 * mixing RawAccel and non-RawAccel buckets conflates two different notions
 * of "sensitivity" on the x-axis (see `bucketBySensitivity`).
 */
export function overshootTrend(buckets: SensBucket[]): OvershootTrend {
  const usable = buckets.filter((b) => b.shots > 0);
  if (usable.length === 0) return { slope: 0, intercept: 0, r2: 0 };
  if (usable.length === 1) return { slope: 0, intercept: usable[0].overshootBias, r2: 0 };

  const xs = usable.map((b) => b.sensitivity);
  const ys = usable.map((b) => b.overshootBias);
  const ws = usable.map((b) => b.shots);
  const totalW = ws.reduce((a, b) => a + b, 0);
  const xBar = xs.reduce((s, x, i) => s + x * ws[i], 0) / totalW;
  const yBar = ys.reduce((s, y, i) => s + y * ws[i], 0) / totalW;

  let num = 0;
  let den = 0;
  for (let i = 0; i < usable.length; i++) {
    num += ws[i] * (xs[i] - xBar) * (ys[i] - yBar);
    den += ws[i] * (xs[i] - xBar) ** 2;
  }
  const slope = den > 1e-9 ? num / den : 0;
  const intercept = yBar - slope * xBar;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < usable.length; i++) {
    const pred = slope * xs[i] + intercept;
    ssRes += ws[i] * (ys[i] - pred) ** 2;
    ssTot += ws[i] * (ys[i] - yBar) ** 2;
  }
  const r2 = ssTot > 1e-9 ? clamp(1 - ssRes / ssTot, 0, 1) : 0;

  return { slope, intercept, r2 };
}

// ---------------------------------------------------------------- families --

/**
 * Splits sessions by scenario family (clicking / tracking / peek). This
 * layer does not import scenario data (`src/data` is out of this module's
 * allowed import set), so the caller supplies the `scenarioId -> family`
 * lookup — typically `(id) => SCENARIOS[id].family` from wherever scenario
 * defs actually live.
 *
 * This split matters because the optimal sensitivity for tracking is
 * usually lower than for flicking/clicking; averaging the two together
 * produces a number that's suboptimal for both.
 */
export function separateByFamily(
  sessions: SessionRecord[],
  scenarioFamilyOf: (scenarioId: string) => ScenarioFamily,
): Record<ScenarioFamily, SessionRecord[]> {
  const out: Record<ScenarioFamily, SessionRecord[]> = { clicking: [], tracking: [], peek: [] };
  for (const s of sessions) {
    const family = scenarioFamilyOf(s.scenarioId);
    out[family].push(s);
  }
  return out;
}
