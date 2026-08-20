import { describe, it, expect } from 'vitest';
import { WeaponState, sampleSpreadOffset, recoilForIndex, applyRecoilAndSpread } from '../src/core/ballistics';
import { getWeapon } from '../src/data/weapons';
import { Rng } from '../src/core/rng';
import type { Vec2 } from '../src/core/types';

describe('spread disc sampling is uniform by area', () => {
  it('puts ~25% of 10k samples within the inner half-radius', () => {
    const rng = new Rng(12345);
    const spreadDeg = 5;
    const N = 10_000;
    let insideHalfRadius = 0;
    for (let i = 0; i < N; i++) {
      const p = sampleSpreadOffset(spreadDeg, rng);
      const r = Math.hypot(p.x, p.y);
      expect(r).toBeLessThanOrEqual(spreadDeg + 1e-9);
      if (r <= spreadDeg / 2) insideHalfRadius += 1;
    }
    // Uniform-by-area on a disc: P(r <= R/2) = (R/2)^2 / R^2 = 0.25.
    const fraction = insideHalfRadius / N;
    expect(fraction).toBeGreaterThan(0.22);
    expect(fraction).toBeLessThan(0.28);
  });

  it('would fail the same check with a naive uniform-radius sampler (sanity check on the test itself)', () => {
    const rng = new Rng(999);
    const spreadDeg = 5;
    const N = 10_000;
    let insideHalfRadius = 0;
    for (let i = 0; i < N; i++) {
      // Naive: uniform radius, not sqrt(u) -- biases samples toward centre.
      const r = spreadDeg * rng.next();
      if (r <= spreadDeg / 2) insideHalfRadius += 1;
    }
    const fraction = insideHalfRadius / N;
    // A naive sampler puts ~50% inside the half-radius, well outside the
    // 0.22-0.28 band the correct sampler must land in.
    expect(fraction).toBeGreaterThan(0.45);
  });
});

describe('recoil pattern looping', () => {
  it('wraps back to loopFromIndex once the pattern is exhausted', () => {
    const pattern: Vec2[] = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
      { x: 4, y: 4 },
    ];
    const loopFromIndex = 2;
    // Index 5 is the first one past the table -> should equal pattern[2].
    expect(recoilForIndex(pattern, loopFromIndex, 5)).toEqual(pattern[2]);
    // Index 8 = loopFromIndex + ((8-5) % (5-2)) = 2 + 0 = 2 again (full loop cycle).
    expect(recoilForIndex(pattern, loopFromIndex, 8)).toEqual(pattern[2]);
    // Index 6 = loopFromIndex + 1 -> pattern[3].
    expect(recoilForIndex(pattern, loopFromIndex, 6)).toEqual(pattern[3]);
  });

  it('in-range indices return the raw pattern entry', () => {
    const pattern: Vec2[] = [{ x: 0, y: 0 }, { x: 1, y: 2 }];
    expect(recoilForIndex(pattern, 0, 1)).toEqual({ x: 1, y: 2 });
  });
});

describe('semi-auto fire-rate gating', () => {
  it('cannot fire faster than fireRate even with the trigger released early', () => {
    const sheriff = getWeapon('sheriff');
    const state = new WeaponState(sheriff);
    const rng = new Rng(1);
    const interval = 1000 / sheriff.fireRate;

    // No explicit equip() call: WeaponState starts equip-ready by default
    // (equippedAt = -Infinity) so this test isolates fire-rate gating alone.
    state.update(0, 0);
    expect(state.canFire(0)).toBe(true);
    const first = state.fire(0, rng);
    expect(first).not.toBeNull();

    // Release the trigger immediately and try again well before the
    // fire-rate interval has elapsed -- must still be refused.
    state.releaseTrigger();
    state.update(10, 0);
    expect(state.canFire(10)).toBe(false);
    expect(state.fire(10, rng)).toBeNull();
    expect(state.ammo).toBe(sheriff.magazine - 1); // unchanged by the rejected attempt

    // After a full interval (and a fresh trigger pull) it is legal again.
    state.update(interval + 1, 0);
    expect(state.canFire(interval + 1)).toBe(true);
  });

  it('without releasing the trigger, a second attempt is refused even after the interval elapses', () => {
    const ghost = getWeapon('ghost');
    const state = new WeaponState(ghost);
    const rng = new Rng(2);
    const interval = 1000 / ghost.fireRate;

    state.update(0, 0);
    expect(state.fire(0, rng)).not.toBeNull();
    state.update(interval + 100, 0);
    // Trigger was never released, so the semi-auto gate still refuses.
    expect(state.canFire(interval + 100)).toBe(false);
  });
});

describe('WeaponState basic lifecycle', () => {
  it('reload refills ammo from reserve after reloadTimeMs', () => {
    const vandal = getWeapon('vandal');
    const state = new WeaponState(vandal);
    state.update(0, 0);
    const rng = new Rng(3);
    for (let i = 0; i < 5; i++) state.fire(i * 200, rng);
    expect(state.ammo).toBe(vandal.magazine - 5);

    state.reload(1000);
    expect(state.reloading).toBe(true);
    state.update(1000 + vandal.reloadTimeMs - 1, 0);
    expect(state.reloading).toBe(true); // not finished yet
    state.update(1000 + vandal.reloadTimeMs, 0);
    expect(state.reloading).toBe(false);
    expect(state.ammo).toBe(vandal.magazine);
    expect(state.reserve).toBe(vandal.reserveAmmo - 5);
  });

  it('cannot fire while reloading or out of ammo', () => {
    const classic = getWeapon('classic');
    const state = new WeaponState(classic);
    state.equip(0);
    state.update(0, 0);
    state.ammo = 0;
    expect(state.canFire(0)).toBe(false);
    state.ammo = 1;
    state.reload(0);
    expect(state.canFire(0)).toBe(false);
  });

  it('respects equip time before allowing the first shot', () => {
    const guardian = getWeapon('guardian');
    const state = new WeaponState(guardian);
    state.equip(1000);
    state.update(1000, 0);
    expect(state.canFire(1000)).toBe(false);
    state.update(1000 + guardian.equipTimeMs, 0);
    expect(state.canFire(1000 + guardian.equipTimeMs)).toBe(true);
  });

  it('first shot while fully stationary is pinpoint (spreadDeg 0)', () => {
    const vandal = getWeapon('vandal');
    const state = new WeaponState(vandal);
    const rng = new Rng(4);
    state.update(0, 0); // movementFactor 0 == stationary
    const result = state.fire(0, rng);
    expect(result).not.toBeNull();
    expect(result!.spreadDeg).toBe(0);
  });
});

describe('applyRecoilAndSpread', () => {
  it('is the identity direction when recoil and spread are both zero', () => {
    const dir = { x: 0, y: 0, z: -1 };
    const out = applyRecoilAndSpread(dir, { x: 0, y: 0 }, { x: 0, y: 0 });
    expect(out.x).toBeCloseTo(dir.x, 9);
    expect(out.y).toBeCloseTo(dir.y, 9);
    expect(out.z).toBeCloseTo(dir.z, 9);
  });

  it('a positive recoil.y (up) tilts the bullet direction upward (+y)', () => {
    const dir = { x: 0, y: 0, z: -1 };
    const out = applyRecoilAndSpread(dir, { x: 0, y: 5 }, { x: 0, y: 0 });
    expect(out.y).toBeGreaterThan(0);
  });
});

describe('practice mode ammo', () => {
  it('never depletes the magazine and ignores reloads', () => {
    const spec = getWeapon('vandal');
    const w = new WeaponState(spec);
    w.infiniteAmmo = true;
    w.equip(0);
    const rng = new Rng(1);

    let now = spec.equipTimeMs;
    // Half a millisecond past the exact interval: accumulating a float and
    // subtracting it back can land a hair BELOW the threshold, and the real
    // loop polls on 4ms steps rather than on the exact boundary anyway.
    const interval = 1000 / spec.fireRate + 0.5;
    // Fire well past the 25-round magazine.
    for (let i = 0; i < 60; i++) {
      w.update(now, 0);
      expect(w.fire(now, rng)).not.toBeNull();
      now += interval;
    }
    expect(w.ammo).toBe(spec.magazine);

    // A reload request is a no-op rather than a lockout — otherwise a reflexive
    // R press mid-session would stall practice for the reload duration.
    w.reload(now);
    expect(w.reloading).toBe(false);
    expect(w.canFire(now)).toBe(true);
  });

  it('still runs the recoil pattern normally, so spray discipline transfers', () => {
    const spec = getWeapon('vandal');
    const w = new WeaponState(spec);
    w.infiniteAmmo = true;
    w.equip(0);
    const rng = new Rng(2);

    let now = spec.equipTimeMs;
    const interval = 1000 / spec.fireRate + 0.5;
    const first = w.fire(now, rng);
    now += interval;
    w.update(now, 0);
    const second = w.fire(now, rng);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // The pattern advanced: shot two is not the same offset as shot one.
    expect(second!.recoil.y).not.toBeCloseTo(first!.recoil.y, 6);
  });
});
