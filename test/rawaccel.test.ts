import { describe, it, expect } from 'vitest';
import type { AccelCurve, AccelCurveType } from '../src/core/types';
import { applyCurve, sampleCurve } from '../src/core/rawaccel';

/** Fully-specified default curve; individual tests override only what they need. */
function baseCurve(overrides: Partial<AccelCurve> & { type: AccelCurveType }): AccelCurve {
  return {
    sensMultiplier: 1,
    acceleration: 0.05,
    exponent: 2,
    inputOffset: 0,
    outputCap: 0,
    inputCap: 0,
    decayRate: 0.05,
    limit: 2,
    syncSpeed: 5,
    gamma: 1,
    smooth: 0,
    motivity: 2,
    growthRate: 1,
    midpoint: 5,
    applyToY: true,
    ...overrides,
  };
}

const ALL_TYPES: AccelCurveType[] = [
  'off', 'linear', 'classic', 'natural', 'synchronous', 'power', 'motivity', 'jump', 'lookup',
];

const SPEED_SAMPLES = [0, 0.01, 0.1, 0.5, 1, 2, 5, 10, 50, 200];

describe('applyCurve: universal guarantees', () => {
  for (const type of ALL_TYPES) {
    it(`${type}: always finite and non-negative`, () => {
      const curve = baseCurve({ type, sensMultiplier: 1.5 });
      for (const s of SPEED_SAMPLES) {
        const g = applyCurve(curve, s);
        expect(Number.isFinite(g)).toBe(true);
        expect(g).toBeGreaterThanOrEqual(0);
      }
    });

    it(`${type}: survives hostile parameters without NaN/Infinity`, () => {
      // exponent <= 1, negative decay/growth rates, zero smooth/gamma/syncSpeed -
      // every one of these is a plausible dev-panel typo.
      const curve = baseCurve({
        type,
        exponent: 0,
        decayRate: -5,
        growthRate: -3,
        gamma: 0,
        smooth: 0,
        syncSpeed: 0,
        limit: 0,
        midpoint: 0,
      });
      for (const s of [0, 1e-6, 1000]) {
        const g = applyCurve(curve, s);
        expect(Number.isFinite(g)).toBe(true);
        expect(g).toBeGreaterThanOrEqual(0);
      }
    });
  }
});

describe('off', () => {
  it('is flat sensMultiplier everywhere', () => {
    const curve = baseCurve({ type: 'off', sensMultiplier: 1.75 });
    expect(applyCurve(curve, 0)).toBeCloseTo(1.75, 10);
    expect(applyCurve(curve, 50)).toBeCloseTo(1.75, 10);
  });
});

describe('linear', () => {
  it('equals sensMultiplier at zero speed and grows monotonically', () => {
    const curve = baseCurve({ type: 'linear', sensMultiplier: 1, acceleration: 0.1, inputOffset: 0 });
    expect(applyCurve(curve, 0)).toBeCloseTo(1, 10);
    let prev = applyCurve(curve, 0);
    for (const s of [1, 2, 5, 10, 20]) {
      const g = applyCurve(curve, s);
      expect(g).toBeGreaterThan(prev);
      prev = g;
    }
  });

  it('matches the closed form gain = sensMultiplier * (1 + accel * max(0, speed - offset))', () => {
    const curve = baseCurve({ type: 'linear', sensMultiplier: 1.2, acceleration: 0.3, inputOffset: 2 });
    expect(applyCurve(curve, 5)).toBeCloseTo(1.2 * (1 + 0.3 * (5 - 2)), 10);
    // Below the offset, no acceleration applies at all.
    expect(applyCurve(curve, 1)).toBeCloseTo(1.2, 10);
  });

  it('respects outputCap', () => {
    const curve = baseCurve({ type: 'linear', sensMultiplier: 1, acceleration: 1, outputCap: 3 });
    expect(applyCurve(curve, 1000)).toBeCloseTo(3, 10);
  });
});

describe('classic', () => {
  it('equals sensMultiplier at zero speed', () => {
    const curve = baseCurve({ type: 'classic', sensMultiplier: 1.3, exponent: 3 });
    expect(applyCurve(curve, 0)).toBeCloseTo(1.3, 10);
  });

  it('is monotonically increasing for exponent > 1', () => {
    const curve = baseCurve({ type: 'classic', exponent: 3, acceleration: 0.2 });
    let prev = applyCurve(curve, 0);
    for (const s of [0.5, 1, 2, 5, 10]) {
      const g = applyCurve(curve, s);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });
});

describe('power', () => {
  it('is continuous across the inputOffset boundary', () => {
    const curve = baseCurve({ type: 'power', sensMultiplier: 1, acceleration: 1, exponent: 1.5, inputOffset: 3 });
    const below = applyCurve(curve, 2.9999);
    const at = applyCurve(curve, 3);
    const above = applyCurve(curve, 3.0001);
    expect(below).toBeCloseTo(at, 3);
    expect(above).toBeCloseTo(at, 3);
  });

  it('is flat below the offset', () => {
    const curve = baseCurve({ type: 'power', acceleration: 1, exponent: 2, inputOffset: 5 });
    expect(applyCurve(curve, 0)).toBeCloseTo(applyCurve(curve, 5), 10);
    expect(applyCurve(curve, 2)).toBeCloseTo(applyCurve(curve, 5), 10);
  });
});

describe('natural', () => {
  it('equals sensMultiplier at/below the offset and asymptotes to limit * sensMultiplier', () => {
    const curve = baseCurve({ type: 'natural', sensMultiplier: 1, limit: 2.5, decayRate: 0.5, inputOffset: 0 });
    expect(applyCurve(curve, 0)).toBeCloseTo(1, 10);
    expect(applyCurve(curve, 1000)).toBeCloseTo(2.5, 6);
  });

  it('never exceeds the limit', () => {
    const curve = baseCurve({ type: 'natural', limit: 2, decayRate: 0.3 });
    for (const s of SPEED_SAMPLES) {
      expect(applyCurve(curve, s)).toBeLessThanOrEqual(2 + 1e-9);
    }
  });
});

describe('synchronous', () => {
  it('equals sqrt(limit) * sensMultiplier exactly at syncSpeed', () => {
    const curve = baseCurve({ type: 'synchronous', sensMultiplier: 1.4, limit: 4, syncSpeed: 3, gamma: 2, smooth: 0.3 });
    expect(applyCurve(curve, 3)).toBeCloseTo(1.4 * Math.sqrt(4), 8);
  });

  it('approaches sensMultiplier as speed -> 0 and limit*sensMultiplier as speed -> inf', () => {
    const curve = baseCurve({ type: 'synchronous', sensMultiplier: 1, limit: 3, syncSpeed: 2, gamma: 4 });
    expect(applyCurve(curve, 1e-6)).toBeCloseTo(1, 2);
    expect(applyCurve(curve, 1e6)).toBeCloseTo(3, 2);
  });
});

describe('motivity', () => {
  it('equals sensMultiplier at speed 0 (well below midpoint) and approaches motivity*sensMultiplier above it', () => {
    const curve = baseCurve({ type: 'motivity', sensMultiplier: 1, motivity: 3, midpoint: 10, growthRate: 2 });
    expect(applyCurve(curve, 0)).toBeCloseTo(1, 3);
    expect(applyCurve(curve, 1000)).toBeCloseTo(3, 3);
  });

  it('is monotonic for positive growthRate', () => {
    const curve = baseCurve({ type: 'motivity', motivity: 2.5, midpoint: 5, growthRate: 1 });
    let prev = applyCurve(curve, 0);
    for (const s of [1, 2, 5, 10, 20]) {
      const g = applyCurve(curve, s);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });
});

describe('jump', () => {
  it('is a hard step at the midpoint when smooth == 0', () => {
    const curve = baseCurve({ type: 'jump', sensMultiplier: 1, motivity: 2, midpoint: 5, smooth: 0 });
    expect(applyCurve(curve, 4.999)).toBeCloseTo(1, 10);
    expect(applyCurve(curve, 5)).toBeCloseTo(2, 10);
    expect(applyCurve(curve, 5.001)).toBeCloseTo(2, 10);
  });

  it('smooths the transition when smooth > 0', () => {
    const curve = baseCurve({ type: 'jump', sensMultiplier: 1, motivity: 2, midpoint: 5, smooth: 1, growthRate: 1 });
    const g = applyCurve(curve, 5);
    // At the midpoint a smoothed jump sits at the halfway gain, not a hard 1 or 2.
    expect(g).toBeGreaterThan(1.2);
    expect(g).toBeLessThan(1.8);
  });
});

describe('lookup', () => {
  it('interpolates linearly between table points', () => {
    const curve = baseCurve({
      type: 'lookup',
      lookup: [{ x: 0, y: 1 }, { x: 10, y: 2 }, { x: 20, y: 2.5 }],
    });
    expect(applyCurve(curve, 5)).toBeCloseTo(1.5, 10);
    expect(applyCurve(curve, 15)).toBeCloseTo(2.25, 10);
  });

  it('clamps at both ends', () => {
    const curve = baseCurve({
      type: 'lookup',
      lookup: [{ x: 2, y: 1 }, { x: 8, y: 3 }],
    });
    expect(applyCurve(curve, 0)).toBeCloseTo(1, 10);
    expect(applyCurve(curve, 100)).toBeCloseTo(3, 10);
  });

  it('falls back to sensMultiplier when the table is missing', () => {
    const curve = baseCurve({ type: 'lookup', sensMultiplier: 1.1, lookup: undefined });
    expect(applyCurve(curve, 5)).toBeCloseTo(1.1, 10);
  });
});

describe('inputCap / outputCap', () => {
  it('inputCap clamps the speed fed to the curve', () => {
    const uncapped = baseCurve({ type: 'linear', acceleration: 0.5, inputOffset: 0 });
    const capped = baseCurve({ type: 'linear', acceleration: 0.5, inputOffset: 0, inputCap: 10 });
    expect(applyCurve(capped, 1000)).toBeCloseTo(applyCurve(uncapped, 10), 10);
  });

  it('outputCap clamps the final gain for every type', () => {
    for (const type of ALL_TYPES) {
      const curve = baseCurve({ type, outputCap: 1.1, sensMultiplier: 5, motivity: 10, limit: 10, acceleration: 2 });
      for (const s of SPEED_SAMPLES) {
        expect(applyCurve(curve, s)).toBeLessThanOrEqual(1.1 + 1e-9);
      }
    }
  });
});

describe('sampleCurve', () => {
  it('returns `points` samples spanning [0, maxSpeed]', () => {
    const curve = baseCurve({ type: 'linear', acceleration: 0.1 });
    const samples = sampleCurve(curve, 20, 5);
    expect(samples).toHaveLength(5);
    expect(samples[0].x).toBeCloseTo(0, 10);
    expect(samples[samples.length - 1].x).toBeCloseTo(20, 10);
    for (const p of samples) expect(Number.isFinite(p.y)).toBe(true);
  });
});
