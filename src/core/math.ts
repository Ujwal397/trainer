import type { Vec2, Vec3 } from './types';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const lengthSq = (a: Vec3): number => dot(a, a);
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : v3();
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/**
 * Yaw/pitch (degrees) -> unit direction, right-handed with +y up.
 * yaw 0 looks down -z; +yaw turns left (toward -x).
 */
export function anglesToDir(yawDeg: number, pitchDeg: number): Vec3 {
  const y = yawDeg * DEG;
  const p = pitchDeg * DEG;
  const cp = Math.cos(p);
  return { x: -Math.sin(y) * cp, y: Math.sin(p), z: -Math.cos(y) * cp };
}

/** Inverse of {@link anglesToDir}. */
export function dirToAngles(d: Vec3): Vec2 {
  const n = normalize(d);
  return { x: Math.atan2(-n.x, -n.z) * RAD, y: Math.asin(clamp(n.y, -1, 1)) * RAD };
}

/** Smallest signed difference a - b, wrapped to (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Angle between two directions, degrees. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const na = normalize(a);
  const nb = normalize(b);
  return Math.acos(clamp(dot(na, nb), -1, 1)) * RAD;
}

/** Rotate `dir` by a cone offset: `yawOff`/`pitchOff` degrees in the dir's local frame. */
export function offsetDir(dir: Vec3, yawOffDeg: number, pitchOffDeg: number): Vec3 {
  const a = dirToAngles(dir);
  return anglesToDir(a.x + yawOffDeg, clamp(a.y + pitchOffDeg, -89.9, 89.9));
}

/** Mean of a numeric array; 0 for an empty array. */
export const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;

/** Sample standard deviation; 0 for fewer than two samples. */
export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Linear-interpolated percentile of an unsorted array. `p` in 0..1. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = clamp(p, 0, 1) * (s.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : lerp(s[lo], s[hi], i - lo);
}

export const median = (xs: number[]): number => percentile(xs, 0.5);
