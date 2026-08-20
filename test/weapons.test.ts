import { describe, it, expect } from 'vitest';
import { WEAPONS, WEAPON_IDS, getWeapon } from '../src/data/weapons';
import { resolveDamage, applyDamage, timeToKill } from '../src/core/damage';

describe('weapons table', () => {
  it('exposes exactly the seven required weapons', () => {
    const ids = Object.keys(WEAPONS).sort();
    expect(ids).toEqual(['classic', 'ghost', 'guardian', 'operator', 'phantom', 'sheriff', 'vandal'].sort());
    expect(WEAPON_IDS.sort()).toEqual(ids);
  });

  it('getWeapon returns the spec and throws on an unknown id', () => {
    expect(getWeapon('vandal').name).toBe('Vandal');
    expect(() => getWeapon('nonexistent')).toThrow();
  });

  it('every weapon tags a confidence and a non-empty sourceNote', () => {
    for (const id of WEAPON_IDS) {
      const w = getWeapon(id);
      expect(['verified', 'approx']).toContain(w.confidence);
      expect(w.sourceNote.length).toBeGreaterThan(20);
    }
  });

  it('every weapon has pinpoint first-shot accuracy while stationary', () => {
    for (const id of WEAPON_IDS) {
      expect(getWeapon(id).spread.firstShotDeg).toBe(0);
    }
  });

  it('damage tiers are ascending by maxDistanceM and non-overlapping', () => {
    for (const id of WEAPON_IDS) {
      const tiers = getWeapon(id).damage;
      expect(tiers.length).toBeGreaterThan(0);
      for (let i = 1; i < tiers.length; i++) {
        expect(tiers[i]!.maxDistanceM).toBeGreaterThan(tiers[i - 1]!.maxDistanceM);
      }
      // Last tier must be the infinite catch-all.
      expect(tiers[tiers.length - 1]!.maxDistanceM).toBe(Infinity);
    }
  });

  it('damage never increases with distance within a weapon', () => {
    for (const id of WEAPON_IDS) {
      const tiers = getWeapon(id).damage;
      for (let i = 1; i < tiers.length; i++) {
        expect(tiers[i]!.head).toBeLessThanOrEqual(tiers[i - 1]!.head);
        expect(tiers[i]!.body).toBeLessThanOrEqual(tiers[i - 1]!.body);
        expect(tiers[i]!.leg).toBeLessThanOrEqual(tiers[i - 1]!.leg);
      }
    }
  });

  it('recoil patterns start at zero offset (no recoil before the first bullet)', () => {
    for (const id of WEAPON_IDS) {
      const pattern = getWeapon(id).recoil.pattern;
      expect(pattern[0]).toEqual({ x: 0, y: 0 });
    }
  });
});

describe('Vandal time-to-kill anchors', () => {
  const vandal = getWeapon('vandal');

  it('kills a 100HP/50-armor target in exactly 4 body shots', () => {
    let health = 100;
    let armor = 50;
    let shots = 0;
    const dmg = resolveDamage(vandal, 'body', 10);
    while (health > 0 && shots < 10) {
      const result = applyDamage(health, armor, dmg);
      health = result.health;
      armor = result.armor;
      shots += 1;
      if (result.killed) break;
    }
    expect(shots).toBe(4);
  });

  it('kills the same target in exactly 1 headshot', () => {
    const dmg = resolveDamage(vandal, 'head', 10);
    const result = applyDamage(100, 50, dmg);
    expect(result.killed).toBe(true);
  });

  it('timeToKill for a body-shot kill matches (shots - 1) intervals', () => {
    const ttk = timeToKill(vandal, 'body', 10, 100, 50);
    const interval = 1000 / vandal.fireRate;
    expect(ttk).toBeCloseTo(3 * interval, 5);
  });
});

describe('Phantom damage falloff boundaries', () => {
  const phantom = getWeapon('phantom');

  it('uses the 0-15m tier just inside 15m and the 15-30m tier just past it', () => {
    expect(resolveDamage(phantom, 'body', 14.9)).toBe(39);
    expect(resolveDamage(phantom, 'body', 15.1)).toBe(35);
  });

  it('uses the 15-30m tier just inside 30m and the 30m+ tier just past it', () => {
    expect(resolveDamage(phantom, 'body', 29.9)).toBe(35);
    expect(resolveDamage(phantom, 'body', 30.1)).toBe(31);
  });

  it('is exact at the 15m and 30m boundaries themselves (inclusive of the nearer tier)', () => {
    expect(resolveDamage(phantom, 'head', 15)).toBe(156);
    expect(resolveDamage(phantom, 'head', 30)).toBe(140);
  });
});

describe('applyDamage shield spillover', () => {
  it('absorbs 1:1 into armor until depleted, then spills onto health in one shot', () => {
    // 50 armor, 30 damage: armor should fully absorb it, health untouched.
    const under = applyDamage(100, 50, 30);
    expect(under).toEqual({ health: 100, armor: 20, killed: false });

    // 20 armor left, 40 damage: 20 absorbed, 20 spills onto health.
    const spill = applyDamage(100, 20, 40);
    expect(spill).toEqual({ health: 80, armor: 0, killed: false });

    // No armor: full damage onto health, can kill.
    const noArmor = applyDamage(30, 0, 40);
    expect(noArmor).toEqual({ health: 0, armor: 0, killed: true });
  });
});
