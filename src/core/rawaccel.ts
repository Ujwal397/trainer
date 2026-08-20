/**
 * RawAccel-compatible acceleration curves.
 *
 * Every curve maps an input speed (mouse counts/ms) to a GAIN multiplier —
 * never an output speed — so callers multiply raw counts by the returned
 * gain to get shaped counts. This mirrors how RawAccel itself separates
 * "acceleration" (the gain curve) from the linear count->angle conversion,
 * which lives in sensitivity.ts.
 *
 * All curves must be total functions: finite, non-negative output for any
 * finite input, including the pathological corners (zero speed, zero-width
 * parameters, negative rates a user typed into the dev panel). Nothing here
 * should ever hand a NaN or Infinity to the aim pipeline.
 */
import type { AccelCurve, Vec2 } from './types';
import { clamp } from './math';

const EPS = 1e-9;

/** Numerically stable logistic sigmoid; well-behaved even as z -> +/-Infinity. */
function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function offGain(curve: AccelCurve): number {
  return curve.sensMultiplier;
}

function linearGain(curve: AccelCurve, speed: number): number {
  const over = Math.max(0, speed - curve.inputOffset);
  return curve.sensMultiplier * (1 + curve.acceleration * over);
}

function classicGain(curve: AccelCurve, speed: number): number {
  // Spec requires exponent > 1; a caller-supplied exponent <= 1 would make
  // (exponent - 1) <= 0, and 0^(non-positive) is Infinity/NaN at the offset
  // boundary. Clamp the *effective* exponent rather than trusting the input.
  const effExponent = Math.max(curve.exponent, 1 + EPS);
  const base = curve.acceleration * Math.max(0, speed - curve.inputOffset);
  const term = base > 0 ? Math.pow(base, effExponent - 1) : 0;
  return curve.sensMultiplier * (1 + term);
}

function powerGain(curve: AccelCurve, speed: number): number {
  // RawAccel's Power mode exposes a "Scale" field; this schema only carries
  // `acceleration`, so scale is estimated as acceleration itself (falling
  // back to 1 so a zero/negative value never collapses the curve to 0).
  const scale = curve.acceleration > 0 ? curve.acceleration : 1;
  const offset = Math.max(curve.inputOffset, 0);
  // Freezing the *effective* speed at max(speed, offset, eps) - rather than
  // branching on speed <= offset - makes the offset plateau and the eps
  // floor (which keeps speed^exponent finite for negative exponents at 0)
  // the same mechanism, so the curve is continuous by construction.
  const effSpeed = Math.max(speed, offset, EPS);
  return curve.sensMultiplier * scale * Math.pow(effSpeed, curve.exponent);
}

function naturalGain(curve: AccelCurve, speed: number): number {
  const limit = curve.limit;
  // A negative decay rate would make the exponential grow instead of decay,
  // blowing past `limit` as speed increases - the opposite of "asymptote".
  const decayRate = Math.max(curve.decayRate, 0);
  const over = Math.max(0, speed - curve.inputOffset);
  return curve.sensMultiplier * (limit - (limit - 1) * Math.exp(-decayRate * over));
}

function synchronousGain(curve: AccelCurve, speed: number): number {
  const limit = Math.max(curve.limit, EPS);
  const syncSpeed = Math.max(curve.syncSpeed, EPS);
  const smooth = clamp(curve.smooth, 0, 1);
  // `smooth` widens the sigmoid's transition region in log-speed space;
  // smooth=0 reproduces RawAccel's default (sharpest) synchronous curve.
  const gamma = curve.gamma / (1 + smooth);
  // Floor speed above zero before the log so gamma=0 * log(0) never lands
  // on the 0 * -Infinity = NaN corner; the floor is far below any real
  // mouse-count speed so it has no effect on the curve's actual shape.
  const safeSpeed = Math.max(speed, EPS);
  const z = gamma * Math.log(safeSpeed / syncSpeed);
  // limit^sigmoid(z): sigmoid(0) = 0.5 exactly at speed == syncSpeed
  // regardless of gamma, giving gain = sensMultiplier * sqrt(limit) there,
  // and sigmoid -> {0, 1} as z -> {-Infinity, +Infinity} give the {1, limit}
  // asymptotes required at speed -> {0, Infinity}.
  return curve.sensMultiplier * Math.pow(limit, sigmoid(z));
}

function motivityGain(curve: AccelCurve, speed: number): number {
  const t = sigmoid(curve.growthRate * (speed - curve.midpoint));
  return curve.sensMultiplier * (1 + (curve.motivity - 1) * t);
}

function jumpGain(curve: AccelCurve, speed: number): number {
  const smooth = Math.max(curve.smooth, 0);
  if (smooth <= 0) {
    // Hard step, per spec: smooth == 0 must be a genuine discontinuity, not
    // just "very steep sigmoid" (which would still be finite-slope).
    const t = speed >= curve.midpoint ? 1 : 0;
    return curve.sensMultiplier * (1 + (curve.motivity - 1) * t);
  }
  const steepness = (curve.growthRate > 0 ? curve.growthRate : 1) / smooth;
  const t = sigmoid(steepness * (speed - curve.midpoint));
  return curve.sensMultiplier * (1 + (curve.motivity - 1) * t);
}

function lookupGain(curve: AccelCurve, speed: number): number {
  const pts = curve.lookup;
  // A lookup curve with no table is a data-entry error, not a math one;
  // sensMultiplier is the least-surprising finite fallback.
  if (!pts || pts.length === 0) return curve.sensMultiplier;
  if (pts.length === 1) return pts[0].y;
  if (speed <= pts[0].x) return pts[0].y;
  const last = pts[pts.length - 1];
  if (speed >= last.x) return last.y;
  // Table is contractually ascending by x (see types.ts), so a single
  // linear scan finds the bracketing segment.
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    if (speed <= p1.x) {
      const span = p1.x - p0.x;
      const t = span > EPS ? (speed - p0.x) / span : 0;
      return p0.y + (p1.y - p0.y) * t;
    }
  }
  return last.y;
}

/**
 * Evaluate `curve` at `inputSpeed` (mouse counts/ms), returning the GAIN
 * multiplier. `inputCap`/`outputCap` are applied uniformly across every
 * curve type here rather than inside each formula, so a curve author can't
 * accidentally forget to honour them for one type.
 */
export function applyCurve(curve: AccelCurve, inputSpeed: number): number {
  const speed = curve.inputCap > 0 ? Math.min(inputSpeed, curve.inputCap) : Math.max(inputSpeed, 0);

  let gain: number;
  switch (curve.type) {
    case 'off': gain = offGain(curve); break;
    case 'linear': gain = linearGain(curve, speed); break;
    case 'classic': gain = classicGain(curve, speed); break;
    case 'power': gain = powerGain(curve, speed); break;
    case 'natural': gain = naturalGain(curve, speed); break;
    case 'synchronous': gain = synchronousGain(curve, speed); break;
    case 'motivity': gain = motivityGain(curve, speed); break;
    case 'jump': gain = jumpGain(curve, speed); break;
    case 'lookup': gain = lookupGain(curve, speed); break;
    default: gain = curve.sensMultiplier; break; // exhaustive by AccelCurveType; guards a bad runtime value
  }

  if (curve.outputCap > 0) gain = Math.min(gain, curve.outputCap);

  // Last line of defence: whatever went wrong upstream, never hand the aim
  // pipeline a non-finite or negative multiplier.
  if (!Number.isFinite(gain) || gain < 0) gain = Math.max(0, curve.sensMultiplier) || 1;
  return gain;
}

/** Evenly-spaced samples of `curve` from 0 to `maxSpeed`, for the live curve graph. */
export function sampleCurve(curve: AccelCurve, maxSpeed: number, points: number): Vec2[] {
  const n = Math.max(2, Math.floor(points));
  const out: Vec2[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = (maxSpeed * i) / (n - 1);
    out[i] = { x, y: applyCurve(curve, x) };
  }
  return out;
}
