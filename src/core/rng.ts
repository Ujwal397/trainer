/**
 * Seeded PRNG. Every source of randomness in the sim (spread, recoil jitter,
 * target spawns, behaviour changes) draws from one of these so a session can be
 * replayed bit-for-bit from its seed — which the analyser relies on to compare
 * runs fairly.
 */
export class Rng {
  private s: number;

  constructor(seed = (Math.random() * 0xffffffff) >>> 0) {
    this.s = seed >>> 0 || 1;
  }

  /** mulberry32 — fast, well-distributed, 32-bit state. */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return Math.floor(this.range(lo, hi + 1));
  }

  /** Standard normal via Box-Muller. */
  gaussian(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)];
  }
}
