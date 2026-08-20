import { describe, it, expect } from 'vitest';
import type { AccelCurve, RawMouseDelta, SensConfig } from '../src/core/types';
import { VALORANT_DEG_PER_COUNT, CM_PER_INCH, PITCH_LIMIT_DEG } from '../src/core/constants';
import { degreesPerCount, cm360, inches360, eDPI, sensFromCm360, AimController } from '../src/core/sensitivity';

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

function baseConfig(overrides: Partial<SensConfig> = {}): SensConfig {
  return {
    dpi: 800,
    pollingRateHz: 1000,
    sensitivity: 0.4,
    scopedMultiplier: 1,
    rawAccelEnabled: false,
    curve: OFF_CURVE,
    invertY: false,
    ...overrides,
  };
}

describe('degreesPerCount', () => {
  it('matches VALORANT_DEG_PER_COUNT * sens directly', () => {
    expect(degreesPerCount(1)).toBeCloseTo(VALORANT_DEG_PER_COUNT.value, 12);
    expect(degreesPerCount(0.4)).toBeCloseTo(VALORANT_DEG_PER_COUNT.value * 0.4, 12);
  });
});

describe('cm360 / inches360 / eDPI', () => {
  it('derives cm/360 from first principles, matching the documented formula', () => {
    // Derived independently from constants.ts's own comment, not copied from
    // this module: cm/360 = 360 / (degPerCount * dpi) * cm-per-inch.
    const dpi = 800;
    const sens = 0.35;
    const degPerCount = VALORANT_DEG_PER_COUNT.value * sens;
    const expectedInches = 360 / (degPerCount * dpi);
    const expectedCm = expectedInches * CM_PER_INCH;

    expect(inches360(dpi, sens)).toBeCloseTo(expectedInches, 8);
    expect(cm360(dpi, sens)).toBeCloseTo(expectedCm, 8);
  });

  it('eDPI is the plain product', () => {
    expect(eDPI(800, 0.35)).toBeCloseTo(280, 10);
  });

  it('higher sensitivity means fewer counts, hence smaller cm/360', () => {
    expect(cm360(800, 0.8)).toBeLessThan(cm360(800, 0.4));
  });

  it('higher DPI at fixed sens also means smaller cm/360 (more counts per inch)', () => {
    expect(cm360(1600, 0.4)).toBeLessThan(cm360(800, 0.4));
  });
});

describe('sensFromCm360', () => {
  it('round-trips with cm360 across a range of dpi/sens combinations', () => {
    for (const dpi of [400, 800, 1600, 3200]) {
      for (const sens of [0.1, 0.35, 0.5, 1.2, 3]) {
        const target = cm360(dpi, sens);
        const recovered = sensFromCm360(dpi, target);
        expect(recovered).toBeCloseTo(sens, 8);
      }
    }
  });
});

describe('AimController.applyDelta', () => {
  it('with rawAccelEnabled=false, gain is always 1 regardless of curve', () => {
    const ctrl = new AimController();
    const cfg = baseConfig({ rawAccelEnabled: false });
    const d: RawMouseDelta = { dx: 100, dy: 0, dtMs: 1, unadjusted: true };
    const { gain } = ctrl.applyDelta(d, cfg, false);
    expect(gain).toBe(1);
  });

  it('a pure rightward mouse move decreases yaw (mouse right turns view right = -yaw)', () => {
    const ctrl = new AimController(0, 0);
    const cfg = baseConfig();
    ctrl.applyDelta({ dx: 100, dy: 0, dtMs: 1, unadjusted: true }, cfg, false);
    expect(ctrl.yaw).toBeLessThan(0);
    expect(ctrl.pitch).toBeCloseTo(0, 10);
  });

  it('matches the hand-computed degree conversion for a simple off-curve move', () => {
    const ctrl = new AimController(0, 0);
    const sens = 0.5;
    const cfg = baseConfig({ sensitivity: sens, rawAccelEnabled: false });
    const dx = 37;
    ctrl.applyDelta({ dx, dy: 0, dtMs: 8, unadjusted: true }, cfg, false);
    const expectedDeg = dx * degreesPerCount(sens) * 1; // gain forced to 1 when rawAccel is off
    expect(ctrl.yaw).toBeCloseTo(-expectedDeg, 10);
  });

  it('a downward mouse move (positive dy) decreases pitch when not inverted', () => {
    const ctrl = new AimController(0, 0);
    const cfg = baseConfig({ invertY: false });
    ctrl.applyDelta({ dx: 0, dy: 50, dtMs: 1, unadjusted: true }, cfg, false);
    expect(ctrl.pitch).toBeLessThan(0);
  });

  it('invertY flips the sign of the pitch response', () => {
    const normal = new AimController(0, 0);
    const inverted = new AimController(0, 0);
    normal.applyDelta({ dx: 0, dy: 50, dtMs: 1, unadjusted: true }, baseConfig({ invertY: false }), false);
    inverted.applyDelta({ dx: 0, dy: 50, dtMs: 1, unadjusted: true }, baseConfig({ invertY: true }), false);
    expect(inverted.pitch).toBeCloseTo(-normal.pitch, 10);
  });

  it('clamps pitch to +/-PITCH_LIMIT_DEG', () => {
    const ctrl = new AimController(0, 0);
    const cfg = baseConfig({ sensitivity: 100 }); // absurd sens to force clamping in one move
    ctrl.applyDelta({ dx: 0, dy: 10000, dtMs: 1, unadjusted: true }, cfg, false);
    expect(ctrl.pitch).toBeCloseTo(-PITCH_LIMIT_DEG.value, 10);
  });

  it('wraps yaw into [-180, 180) without quantising across many small updates', () => {
    const ctrl = new AimController(0, 0);
    const cfg = baseConfig({ sensitivity: 5 });
    // Many moderate moves that individually stay in range but accumulate past +/-180.
    for (let i = 0; i < 50; i++) {
      ctrl.applyDelta({ dx: -50, dy: 0, dtMs: 1, unadjusted: true }, cfg, false);
    }
    expect(ctrl.yaw).toBeGreaterThanOrEqual(-180);
    expect(ctrl.yaw).toBeLessThan(180);
  });

  it('scoped multiplies by both scopedMultiplier and the weapon ads multiplier', () => {
    const scoped = new AimController(0, 0);
    const unscoped = new AimController(0, 0);
    const cfg = baseConfig({ scopedMultiplier: 0.5 });
    const d: RawMouseDelta = { dx: 100, dy: 0, dtMs: 1, unadjusted: true };
    unscoped.applyDelta(d, cfg, false);
    scoped.applyDelta(d, cfg, true, 0.4); // weapon ads.sensMultiplier = 0.4
    // Total scope factor = 0.5 * 0.4 = 0.2
    expect(scoped.yaw).toBeCloseTo(unscoped.yaw * 0.2, 8);
  });

  it('applyToY=false shapes only X through the curve; Y stays at flat sensMultiplier gain', () => {
    const linearCurve: AccelCurve = {
      ...OFF_CURVE,
      type: 'linear',
      sensMultiplier: 1,
      acceleration: 1, // strong acceleration so gain != 1 at speed > 0
      inputOffset: 0,
      applyToY: false,
    };
    const ctrl = new AimController(0, 0);
    const cfg = baseConfig({ rawAccelEnabled: true, curve: linearCurve, sensitivity: 1 });
    // Large dx drives a big X-only input speed (which would inflate gain if it leaked into Y);
    // dy is nonzero too, so we can check Y ignored dx's speed.
    ctrl.applyDelta({ dx: 500, dy: 10, dtMs: 1, unadjusted: true }, cfg, false);
    const expectedDyDeg = 10 * degreesPerCount(1) * linearCurve.sensMultiplier;
    expect(ctrl.pitch).toBeCloseTo(-expectedDyDeg, 6);
  });

  it('falls back to the nominal poll interval when dtMs is garbage (<=0 or >100ms)', () => {
    const withBadDt = new AimController(0, 0);
    const withGoodDt = new AimController(0, 0);
    const cfg = baseConfig({ pollingRateHz: 1000, rawAccelEnabled: false });
    withBadDt.applyDelta({ dx: 20, dy: 0, dtMs: -5, unadjusted: true }, cfg, false);
    withGoodDt.applyDelta({ dx: 20, dy: 0, dtMs: 1, unadjusted: true }, cfg, false);
    // With rawAccel off, gain is always 1 regardless of dt, so the yaw outcome
    // (which depends only on counts * degPerCount * gain) is identical either way -
    // this proves the bad dt didn't propagate as NaN/Infinity into the result.
    expect(withBadDt.yaw).toBeCloseTo(withGoodDt.yaw, 10);
  });
});

describe('RawAccel disabled is pure Valorant sensitivity', () => {
  /**
   * Regression: "By Component" mode used to apply curve.sensMultiplier to Y
   * unconditionally, so switching RawAccel off left vertical sensitivity
   * scaled while horizontal was 1:1.
   */
  it('scales both axes identically when rawAccelEnabled is false', () => {
    const cfg: SensConfig = {
      dpi: 800,
      pollingRateHz: 1000,
      sensitivity: 0.35,
      scopedMultiplier: 1,
      rawAccelEnabled: false,
      invertY: false,
      curve: { ...OFF_CURVE, type: 'linear', sensMultiplier: 0.5, applyToY: false },
    };
    const aim = new AimController();
    aim.reset(0, 0);
    aim.applyDelta({ dx: 100, dy: 100, dtMs: 1, unadjusted: true }, cfg, false);

    const expected = 100 * degreesPerCount(cfg.sensitivity);
    expect(Math.abs(aim.yaw)).toBeCloseTo(expected, 10);
    expect(Math.abs(aim.pitch)).toBeCloseTo(expected, 10);
  });
});
