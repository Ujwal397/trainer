/**
 * Capsule hit registration. A Valorant hitbox is a swept sphere (capsule):
 * a cylindrical shaft between two points plus a hemisphere cap at each end.
 * The standard analytic test (Ericson, "Real-Time Collision Detection")
 * solves the infinite-cylinder quadratic restricted to the segment span and
 * separately tests both end spheres, taking the closest valid root - that
 * union is exact because the capsule surface *is* that union.
 */
import type { AgentHitbox, Capsule, RayHit, Vec3 } from './types';
import { add, sub, scale, dot, lengthSq, distance, clamp, RAD, DEG } from './math';
import { CROUCH_SCALE } from './constants';

const EPS = 1e-9;

/** Closest positive root of |origin + t*dir - center| = radius, or null. Handles non-unit dir. */
function raySphere(origin: Vec3, dir: Vec3, center: Vec3, radius: number): number | null {
  const oc = sub(origin, center);
  const a = dot(dir, dir);
  if (a < EPS) return null;
  const b = dot(oc, dir);
  const c = dot(oc, oc) - radius * radius;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t0 = (-b - sqrtDisc) / a;
  if (t0 >= 0) return t0;
  const t1 = (-b + sqrtDisc) / a;
  if (t1 >= 0) return t1;
  return null;
}

/**
 * First positive intersection of ray (origin, dir) with `cap`, or null on
 * a miss. `dir` should be a unit vector - `t` is then a distance in metres.
 */
export function rayCapsule(origin: Vec3, dir: Vec3, cap: Capsule): number | null {
  const axis = sub(cap.b, cap.a);
  const dd = lengthSq(axis);

  if (dd < EPS) {
    // Zero-length capsule degenerates to a sphere.
    return raySphere(origin, dir, cap.a, cap.radius);
  }

  const m = sub(origin, cap.a);
  const md = dot(m, axis);
  const nd = dot(dir, axis);
  const nn = dot(dir, dir);
  const mn = dot(m, dir);
  const k = dot(m, m) - cap.radius * cap.radius;

  const a2 = dd * nn - nd * nd;
  const c2 = dd * k - md * md;

  let best: number | null = null;

  // a2 -> 0 means dir is (nearly) parallel to the capsule axis: the
  // infinite-cylinder quadratic degenerates (the ray either grazes along
  // the shaft or misses the cylinder body entirely) and only the two end
  // spheres can produce a meaningful hit, so skip straight to those.
  if (Math.abs(a2) >= EPS) {
    const b2 = dd * mn - nd * md;
    const disc = b2 * b2 - a2 * c2;
    if (disc >= 0) {
      const sqrtDisc = Math.sqrt(disc);
      const t0 = (-b2 - sqrtDisc) / a2;
      const t1 = (-b2 + sqrtDisc) / a2;
      for (const t of [t0, t1]) {
        if (t < 0) continue;
        const s = md + t * nd; // axial param, in [0, dd] (unnormalized)
        if (s >= 0 && s <= dd && (best === null || t < best)) best = t;
      }
    }
  }

  const tA = raySphere(origin, dir, cap.a, cap.radius);
  if (tA !== null && (best === null || tA < best)) best = tA;
  const tB = raySphere(origin, dir, cap.b, cap.radius);
  if (tB !== null && (best === null || tB < best)) best = tB;

  return best;
}

/**
 * Rotate `hb`'s local capsules about +y by `yawDeg` and translate to `pos`.
 * The rotation matches math.ts's `anglesToDir` convention (+yaw turns left,
 * yaw 0 faces -z): x' = x*cos + z*sin, z' = -x*sin + z*cos. Crouching
 * compresses the y-extent toward the feet (origin) by CROUCH_SCALE; radius
 * is untouched per the crouch model in constants.ts.
 */
export function transformHitbox(hb: AgentHitbox, pos: Vec3, yawDeg: number, crouching: boolean): Capsule[] {
  const rad = yawDeg * DEG;
  const cy = Math.cos(rad);
  const sy = Math.sin(rad);
  const yScale = crouching ? CROUCH_SCALE.value : 1;

  const xform = (p: Vec3): Vec3 => ({
    x: p.x * cy + p.z * sy + pos.x,
    y: p.y * yScale + pos.y,
    z: -p.x * sy + p.z * cy + pos.z,
  });

  return hb.capsules.map((c) => ({ a: xform(c.a), b: xform(c.b), radius: c.radius, zone: c.zone }));
}

/**
 * Nearest capsule hit on `capsules` (world-space, from {@link transformHitbox}).
 * On an exact tie in `t`, the first capsule wins - since AgentHitbox is
 * contractually head-first, a plain strict-less-than comparison is enough
 * to prefer a headshot over a body/leg shot that resolves to the same t.
 */
/**
 * Nearest hit across a target's capsules, with head priority.
 *
 * Head priority is not a nicety — it is required for correctness. Capsules are
 * swept spheres, so the body capsule's upper cap bulges to roughly y=1.80,
 * above the base of the head capsule at y=1.545. A ray aimed exactly at the
 * head centre therefore enters the body's sphere *first* and a pure
 * nearest-hit rule scores it as a body shot, which is both wrong against how
 * Valorant registers the same shot and quietly destructive here: the analyser
 * would see the player's most precise shots recorded as their least precise.
 *
 * So: if the ray intersects the head at all, it is a headshot. Otherwise the
 * nearest of the remaining zones wins.
 */
export function raycastTarget(
  origin: Vec3,
  dir: Vec3,
  targetId: string,
  capsules: readonly Capsule[],
): RayHit | null {
  let best: RayHit | null = null;
  let bestT = Infinity;
  let head: RayHit | null = null;
  let headT = Infinity;

  for (const cap of capsules) {
    const t = rayCapsule(origin, dir, cap);
    if (t === null) continue;
    if (cap.zone === 'head') {
      if (t < headT) {
        headT = t;
        head = { targetId, zone: 'head', point: add(origin, scale(dir, t)), distanceM: t };
      }
    } else if (t < bestT) {
      bestT = t;
      best = { targetId, zone: cap.zone, point: add(origin, scale(dir, t)), distanceM: t };
    }
  }
  return head ?? best;
}

/** Midpoint of the head capsule - the analyser's aim-error reference point. */
export function headCentre(capsules: readonly Capsule[]): Vec3 {
  if (capsules.length === 0) return { x: 0, y: 0, z: 0 };
  const head = capsules.find((c) => c.zone === 'head') ?? capsules[0];
  return scale(add(head.a, head.b), 0.5);
}

/**
 * Half-angle, in degrees, that `capsule` subtends from `eye`. Approximated
 * as the angular radius of a sphere of the same radius centred at the
 * closest point on the capsule's spine to the eye - exact when the eye
 * lies on the capsule's perpendicular bisector plane, which is where the
 * analyser's normalisation matters most (roughly head-on aim).
 */
export function angularRadius(capsule: Capsule, eye: Vec3): number {
  const axis = sub(capsule.b, capsule.a);
  const axisLenSq = lengthSq(axis);
  let closest: Vec3;
  if (axisLenSq < EPS) {
    closest = capsule.a;
  } else {
    const t = clamp(dot(sub(eye, capsule.a), axis) / axisLenSq, 0, 1);
    closest = add(capsule.a, scale(axis, t));
  }
  const dist = distance(eye, closest);
  if (dist <= capsule.radius) return 90; // eye inside the capsule: subtends a full hemisphere
  return Math.asin(capsule.radius / dist) * RAD;
}
