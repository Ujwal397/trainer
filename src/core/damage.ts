/**
 * Damage resolution. Pure functions only -- no weapon state here, that lives
 * in ballistics.ts. Kept separate so scenario scoring can call these without
 * pulling in the firing-simulation machinery.
 */
import type { WeaponSpec, HitZone } from './types';

/**
 * Picks the damage for `zone` at `distanceM`. `weapon.damage` is ascending by
 * `maxDistanceM`; the first tier whose `maxDistanceM` is >= distance applies,
 * and the last tier (typically `Infinity`) is the catch-all for anything
 * beyond the previous tier's boundary.
 */
export function resolveDamage(weapon: WeaponSpec, zone: HitZone, distanceM: number): number {
  const tiers = weapon.damage;
  for (const tier of tiers) {
    if (distanceM <= tier.maxDistanceM) {
      return tier[zone];
    }
  }
  // Defensive fallback: table is malformed (no infinite catch-all tier).
  // Use the last tier rather than throwing, so a bad data table degrades
  // gracefully instead of crashing the sim mid-scenario.
  const last = tiers[tiers.length - 1];
  return last ? last[zone] : 0;
}

export interface DamageResult {
  health: number;
  armor: number;
  killed: boolean;
}

/**
 * Applies `dmg` to a health/armor pair using Valorant's shield rule: armor
 * absorbs damage 1:1 until depleted, then the remainder spills over onto
 * health -- there is no percentage damage reduction. A single shot that
 * exceeds remaining armor correctly splits across both pools.
 */
export function applyDamage(health: number, armor: number, dmg: number): DamageResult {
  const armorAbsorbed = Math.min(armor, dmg);
  const remaining = dmg - armorAbsorbed;
  const newArmor = armor - armorAbsorbed;
  const newHealth = Math.max(0, health - remaining);
  return {
    health: newHealth,
    armor: newArmor,
    killed: newHealth <= 0,
  };
}

/**
 * Shots-to-kill at a fixed zone/distance, converted to milliseconds via the
 * weapon's fire rate. Used for scenario scoring (ideal TTK baselines), so it
 * assumes every shot lands on `zone` -- it is not a simulation of spread or
 * recoil drift, just the theoretical best case.
 */
export function timeToKill(
  weapon: WeaponSpec,
  zone: HitZone,
  distanceM: number,
  health: number,
  armor: number,
): number {
  const dmgPerShot = resolveDamage(weapon, zone, distanceM);
  if (dmgPerShot <= 0) return Infinity;

  let remainingHealth = health;
  let remainingArmor = armor;
  let shots = 0;
  while (remainingHealth > 0) {
    const result = applyDamage(remainingHealth, remainingArmor, dmgPerShot);
    remainingHealth = result.health;
    remainingArmor = result.armor;
    shots += 1;
    if (shots > 1000) break; // safety valve against a zero/near-zero damage table
  }

  // First shot fires "now" (0ms in); each subsequent shot waits one
  // fire-interval. So (shots - 1) intervals elapse, not `shots`.
  const intervalMs = 1000 / weapon.fireRate;
  return (shots - 1) * intervalMs;
}
