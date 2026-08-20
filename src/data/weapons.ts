/**
 * Weapon data tables. This is the trainer's single most important accuracy
 * surface: everything the player "feels" is downstream of these numbers.
 *
 * Confidence policy (see `DataConfidence` in core/types.ts):
 *   - Damage tiers, fire rate, magazine size, reserve ammo and reload time are
 *     published/derivable Valorant figures and are called out as verified in
 *     each weapon's `sourceNote`.
 *   - Every weapon's overall `confidence` is nonetheless `'approx'`, because
 *     `WeaponSpec` only carries one confidence flag per weapon and every
 *     weapon here also includes hand-modelled spread-growth curves and recoil
 *     patterns that Riot has never published as numbers. Marking the whole
 *     spec `verified` would overstate confidence in those fields, so the spec
 *     is honestly `approx` with the note explaining exactly which parts are
 *     solid and which are estimates the dev panel should let the user correct.
 */
import type { WeaponSpec, DamageTier, SpreadSpec, RecoilSpec, AdsSpec, Vec2 } from '../core/types';
import { RUN_SPEED_MS } from '../core/constants';

// ------------------------------------------------------------ pattern shape --

/**
 * Builds an automatic weapon's spray shape: a near-vertical climb for the
 * first `climbRounds`, then a repeating side-to-side sweep. This is a
 * deterministic *shape* generator, not extracted game data -- real Valorant
 * spray patterns are deterministic per weapon but Riot has never published
 * them as a number table. Every weapon that calls this tags the result
 * `approx` in its `sourceNote`.
 *
 * `pattern[0]` is always `{x:0,y:0}`: recoil accumulates starting from the
 * first bullet fired, so the first bullet itself carries none yet (it is the
 * `spread.firstShotDeg` mechanic, a separate axis, that governs first-shot
 * precision).
 */
function buildAutoSpray(opts: {
  climbRounds: number;
  climbTotalDeg: number;
  climbJitterDeg: number;
  sweepRounds: number;
  sweepAmplitudeDeg: number;
  sweepDriftPerRoundDeg: number;
}): { pattern: Vec2[]; loopFromIndex: number } {
  const pattern: Vec2[] = [];
  for (let i = 0; i < opts.climbRounds; i++) {
    const t = opts.climbRounds > 1 ? i / (opts.climbRounds - 1) : 1;
    const y = opts.climbTotalDeg * t;
    // Small alternating horizontal wobble during the climb; zero on shot 0.
    const x = i === 0 ? 0 : opts.climbJitterDeg * Math.sin(i * 2.1);
    pattern.push({ x, y });
  }
  const loopFromIndex = opts.climbRounds;
  const climbEndY = pattern[pattern.length - 1]?.y ?? 0;
  for (let i = 0; i < opts.sweepRounds; i++) {
    const x = opts.sweepAmplitudeDeg * Math.sin((i / opts.sweepRounds) * Math.PI * 2);
    const y = climbEndY + opts.sweepDriftPerRoundDeg * i;
    pattern.push({ x, y });
  }
  return { pattern, loopFromIndex };
}

/**
 * A semi-auto's short entry kick (2-4 rounds of shape). Real semi-auto
 * recoil in Valorant fully resets between trigger pulls, so only the shape
 * of one pull needs modelling; `WeaponState` (ballistics.ts) restarts the
 * pattern index whenever a fresh trigger pull is detected. `loopFromIndex`
 * only matters as a fallback if the pattern is ever exhausted without a
 * reset (e.g. a scripted/held test).
 */
function buildKick(points: Vec2[], loopFromIndex = 0): { pattern: Vec2[]; loopFromIndex: number } {
  return { pattern: points, loopFromIndex };
}

// -------------------------------------------------------------- spread util --

/**
 * `maxSpreadDeg` is the absolute worst-case clamp across every movement
 * state *and* spray growth stacked on top of it, so it is derived from
 * `jumpingDeg` (the worst discrete state) with headroom for growth, rather
 * than picked independently -- an independent smaller value would silently
 * make jumping-while-spraying impossible to represent.
 */
const worstCaseCap = (jumpingDeg: number, headroom = 1.15): number => jumpingDeg * headroom;

// ------------------------------------------------------------------ weapons --

const VANDAL_DAMAGE: DamageTier[] = [
  { maxDistanceM: Infinity, head: 160, body: 40, leg: 34 },
];

const PHANTOM_DAMAGE: DamageTier[] = [
  { maxDistanceM: 15, head: 156, body: 39, leg: 33 },
  { maxDistanceM: 30, head: 140, body: 35, leg: 29 },
  { maxDistanceM: Infinity, head: 124, body: 31, leg: 26 },
];

const SHERIFF_DAMAGE: DamageTier[] = [
  { maxDistanceM: 30, head: 159, body: 55, leg: 46 },
  { maxDistanceM: Infinity, head: 145, body: 50, leg: 42 },
];

const GUARDIAN_DAMAGE: DamageTier[] = [
  { maxDistanceM: Infinity, head: 195, body: 65, leg: 49 },
];

const CLASSIC_DAMAGE: DamageTier[] = [
  { maxDistanceM: 30, head: 78, body: 26, leg: 22 },
  { maxDistanceM: Infinity, head: 66, body: 22, leg: 18 },
];

const GHOST_DAMAGE: DamageTier[] = [
  { maxDistanceM: 30, head: 105, body: 30, leg: 25 },
  { maxDistanceM: Infinity, head: 88, body: 25, leg: 21 },
];

const OPERATOR_DAMAGE: DamageTier[] = [
  { maxDistanceM: Infinity, head: 255, body: 150, leg: 120 },
];

// --- Vandal -------------------------------------------------------------
const vandalSpread: SpreadSpec = {
  firstShotDeg: 0,
  standingDeg: 0,
  crouchingDeg: 0,
  walkingDeg: 0.8,
  runningDeg: 2.6,
  jumpingDeg: 7.5,
  perShotGrowthDeg: 0.3,
  maxSpreadDeg: worstCaseCap(7.5),
  recoveryDegPerSec: 6,
  recoveryDelayMs: 150,
};
const vandalSprayShape = buildAutoSpray({
  climbRounds: 8,
  climbTotalDeg: 6.5,
  climbJitterDeg: 0.15,
  sweepRounds: 10,
  sweepAmplitudeDeg: 3.0,
  sweepDriftPerRoundDeg: 0.05,
});
const vandalRecoil: RecoilSpec = {
  pattern: vandalSprayShape.pattern,
  loopFromIndex: vandalSprayShape.loopFromIndex,
  randomYawDeg: 0.08,
  randomPitchDeg: 0.08,
  recoveryDelayMs: 150,
  recoveryDegPerSec: 6,
};

const VANDAL: WeaponSpec = {
  id: 'vandal',
  name: 'Vandal',
  category: 'rifle',
  fireMode: 'auto',
  fireRate: 9.75,
  magazine: 25,
  reserveAmmo: 75,
  reloadTimeMs: 2500,
  equipTimeMs: 750,
  damage: VANDAL_DAMAGE,
  moveSpeed: RUN_SPEED_MS.value * 0.9,
  spread: vandalSpread,
  recoil: vandalRecoil,
  confidence: 'approx',
  sourceNote:
    'VERIFIED: damage 160/40/34 with no falloff, 9.75 rounds/sec fully automatic, ' +
    '25-round magazine, 75 reserve, 2.5s reload -- all well-documented published figures. ' +
    'APPROX: spread degrees per movement state, per-shot growth, and the 18-entry recoil ' +
    'pattern (near-vertical climb for 8 rounds then a wide left/right sweep, looping from ' +
    'index 8) are hand-modelled to match the known spray *shape*; Riot has never published ' +
    'the pattern as numbers. moveSpeed (90% of run speed) and equipTimeMs are community-cited ' +
    'estimates, also approx.',
};

// --- Phantom -------------------------------------------------------------
const phantomSpread: SpreadSpec = {
  firstShotDeg: 0,
  standingDeg: 0,
  crouchingDeg: 0,
  walkingDeg: 0.75,
  runningDeg: 2.4,
  jumpingDeg: 7.0,
  perShotGrowthDeg: 0.22,
  maxSpreadDeg: worstCaseCap(7.0),
  recoveryDegPerSec: 7,
  recoveryDelayMs: 140,
};
const phantomSprayShape = buildAutoSpray({
  climbRounds: 8,
  climbTotalDeg: 5.2,
  climbJitterDeg: 0.12,
  sweepRounds: 14,
  sweepAmplitudeDeg: 1.8,
  sweepDriftPerRoundDeg: 0.04,
});
const phantomRecoil: RecoilSpec = {
  pattern: phantomSprayShape.pattern,
  loopFromIndex: phantomSprayShape.loopFromIndex,
  randomYawDeg: 0.07,
  randomPitchDeg: 0.07,
  recoveryDelayMs: 140,
  recoveryDegPerSec: 7,
};

const PHANTOM: WeaponSpec = {
  id: 'phantom',
  name: 'Phantom',
  category: 'rifle',
  fireMode: 'auto',
  fireRate: 11.0,
  magazine: 30,
  reserveAmmo: 90,
  reloadTimeMs: 2500,
  equipTimeMs: 750,
  damage: PHANTOM_DAMAGE,
  moveSpeed: RUN_SPEED_MS.value * 0.9,
  spread: phantomSpread,
  recoil: phantomRecoil,
  confidence: 'approx',
  sourceNote:
    'VERIFIED: damage 156/39/33 (0-15m), 140/35/29 (15-30m), 124/31/26 (30m+), ' +
    '11 rounds/sec fully automatic, 30-round magazine, 90 reserve, 2.5s reload. ' +
    'APPROX: spread and the 22-entry recoil pattern -- climbs slightly less than the Vandal ' +
    '(5.2deg over 8 rounds) into a tighter, more controllable 1.8deg horizontal sweep, looping ' +
    'from index 8. Hand-modelled shape, not extracted data. moveSpeed and equipTimeMs are also approx.',
};

// --- Sheriff -------------------------------------------------------------
const sheriffSpread: SpreadSpec = {
  firstShotDeg: 0,
  standingDeg: 0,
  crouchingDeg: 0,
  walkingDeg: 0.9,
  runningDeg: 2.8,
  jumpingDeg: 8.0,
  perShotGrowthDeg: 0.2,
  maxSpreadDeg: worstCaseCap(8.0),
  recoveryDegPerSec: 12,
  recoveryDelayMs: 90,
};
const sheriffKick = buildKick([
  { x: 0, y: 0 },
  { x: 0.4, y: 2.2 },
  { x: -0.3, y: 1.4 },
]);
const sheriffRecoil: RecoilSpec = {
  pattern: sheriffKick.pattern,
  loopFromIndex: sheriffKick.loopFromIndex,
  randomYawDeg: 0.1,
  randomPitchDeg: 0.1,
  recoveryDelayMs: 90,
  recoveryDegPerSec: 40,
};

const SHERIFF: WeaponSpec = {
  id: 'sheriff',
  name: 'Sheriff',
  category: 'sidearm',
  fireMode: 'semi',
  fireRate: 4.0,
  magazine: 6,
  reserveAmmo: 24,
  reloadTimeMs: 2250,
  equipTimeMs: 500,
  damage: SHERIFF_DAMAGE,
  moveSpeed: RUN_SPEED_MS.value * 0.94,
  spread: sheriffSpread,
  recoil: sheriffRecoil,
  confidence: 'approx',
  sourceNote:
    'VERIFIED: damage 159/55/46 (0-30m), 145/50/42 (30m+), 4.0 rounds/sec semi-auto, ' +
    '6-round magazine, 24 reserve, 2.25s reload -- well-documented figures. ' +
    'APPROX: the 3-entry kick pattern (a hard vertical+lateral snap that fully resets between ' +
    'trigger pulls, recoveryDegPerSec set high because the 250ms natural fire interval is ' +
    'ample) is a hand-modelled shape, as is the movement spread curve. moveSpeed and ' +
    'equipTimeMs are community-cited estimates.',
};

// --- Guardian -------------------------------------------------------------
const guardianSpread: SpreadSpec = {
  firstShotDeg: 0,
  standingDeg: 0,
  crouchingDeg: 0,
  walkingDeg: 0.6,
  runningDeg: 2.0,
  jumpingDeg: 6.5,
  perShotGrowthDeg: 0.15,
  maxSpreadDeg: worstCaseCap(6.5),
  recoveryDegPerSec: 10,
  recoveryDelayMs: 100,
};
const guardianKick = buildKick(
  [
    { x: 0, y: 0 },
    { x: 0.1, y: 1.0 },
    { x: -0.15, y: 1.6 },
    { x: 0.05, y: 1.9 },
  ],
  1,
);
const guardianRecoil: RecoilSpec = {
  pattern: guardianKick.pattern,
  loopFromIndex: guardianKick.loopFromIndex,
  randomYawDeg: 0.06,
  randomPitchDeg: 0.06,
  recoveryDelayMs: 100,
  recoveryDegPerSec: 35,
};
const guardianAds: AdsSpec = {
  zoomFovDeg: [103 / 2.5],
  sensMultiplier: 1.0,
  moveSpeedMultiplier: 0.5,
  enterTimeMs: 150,
  scopedSpreadDeg: 0,
};

const GUARDIAN: WeaponSpec = {
  id: 'guardian',
  name: 'Guardian',
  category: 'rifle',
  fireMode: 'semi',
  fireRate: 6.75,
  magazine: 12,
  reserveAmmo: 36,
  reloadTimeMs: 2750,
  equipTimeMs: 750,
  damage: GUARDIAN_DAMAGE,
  moveSpeed: RUN_SPEED_MS.value * 0.92,
  spread: guardianSpread,
  recoil: guardianRecoil,
  ads: guardianAds,
  confidence: 'approx',
  sourceNote:
    'VERIFIED: damage 195/65/49 with no falloff, 6.75 rounds/sec semi-auto, 12-round ' +
    'magazine, 36 reserve, 2.75s reload, single 2.5x ADS scope -- published figures. ' +
    'APPROX: the 4-entry kick pattern and movement spread are hand-modelled shapes. The ' +
    'scoped FOV (103/2.5) is computed from base HFOV rather than measured, and ' +
    'moveSpeed/equipTimeMs/ADS move-speed multiplier are community-cited estimates.',
};

// --- Classic -------------------------------------------------------------
const classicSpread: SpreadSpec = {
  firstShotDeg: 0,
  standingDeg: 0,
  crouchingDeg: 0,
  walkingDeg: 0.7,
  runningDeg: 2.2,
  jumpingDeg: 6.0,
  perShotGrowthDeg: 0.15,
  maxSpreadDeg: worstCaseCap(6.0),
  recoveryDegPerSec: 12,
  recoveryDelayMs: 90,
};
const classicKick = buildKick([
  { x: 0, y: 0 },
  { x: 0.2, y: 1.1 },
  { x: -0.15, y: 0.7 },
]);
const classicRecoil: RecoilSpec = {
  pattern: classicKick.pattern,
  loopFromIndex: classicKick.loopFromIndex,
  randomYawDeg: 0.08,
  randomPitchDeg: 0.08,
  recoveryDelayMs: 90,
  recoveryDegPerSec: 40,
};

const CLASSIC: WeaponSpec = {
  id: 'classic',
  name: 'Classic',
  category: 'sidearm',
  fireMode: 'semi',
  fireRate: 6.75,
  magazine: 12,
  reserveAmmo: 36,
  reloadTimeMs: 1750,
  equipTimeMs: 500,
  damage: CLASSIC_DAMAGE,
  moveSpeed: RUN_SPEED_MS.value * 1.0,
  spread: classicSpread,
  recoil: classicRecoil,
  confidence: 'approx',
  sourceNote:
    'VERIFIED: primary-fire damage 78/26/22 (0-30m), 66/22/18 (30m+), 6.75 rounds/sec, ' +
    '12-round magazine, 36 reserve, 1.75s reload -- published figures for the single-fire mode. ' +
    'NOT MODELLED: the Classic also has a right-click 3-round burst alt-fire with its own ' +
    'spread/damage that this trainer intentionally ignores, per the brief -- only primary fire ' +
    'is represented. APPROX: kick pattern, movement spread, moveSpeed (100%, fastest sidearm) ' +
    'and equipTimeMs are estimates.',
};

// --- Ghost -------------------------------------------------------------
const ghostSpread: SpreadSpec = {
  firstShotDeg: 0,
  standingDeg: 0,
  crouchingDeg: 0,
  walkingDeg: 0.6,
  runningDeg: 2.0,
  jumpingDeg: 5.5,
  perShotGrowthDeg: 0.15,
  maxSpreadDeg: worstCaseCap(5.5),
  recoveryDegPerSec: 12,
  recoveryDelayMs: 90,
};
const ghostKick = buildKick([
  { x: 0, y: 0 },
  { x: 0.15, y: 1.3 },
  { x: -0.1, y: 0.8 },
  { x: 0.05, y: 0.5 },
]);
const ghostRecoil: RecoilSpec = {
  pattern: ghostKick.pattern,
  loopFromIndex: ghostKick.loopFromIndex,
  randomYawDeg: 0.06,
  randomPitchDeg: 0.06,
  recoveryDelayMs: 90,
  recoveryDegPerSec: 40,
};

const GHOST: WeaponSpec = {
  id: 'ghost',
  name: 'Ghost',
  category: 'sidearm',
  fireMode: 'semi',
  fireRate: 6.75,
  magazine: 15,
  reserveAmmo: 45,
  reloadTimeMs: 1500,
  equipTimeMs: 500,
  damage: GHOST_DAMAGE,
  moveSpeed: RUN_SPEED_MS.value * 0.98,
  spread: ghostSpread,
  recoil: ghostRecoil,
  confidence: 'approx',
  sourceNote:
    'VERIFIED: damage 105/30/25 (0-30m), 88/25/21 (30m+), 6.75 rounds/sec semi-auto, ' +
    '15-round magazine, 45 reserve, 1.5s reload -- published figures. ' +
    'APPROX: kick pattern, movement spread, moveSpeed and equipTimeMs are hand-modelled/estimated.',
};

// --- Operator -------------------------------------------------------------
const operatorSpread: SpreadSpec = {
  firstShotDeg: 0,
  standingDeg: 0,
  crouchingDeg: 0,
  walkingDeg: 3.0,
  runningDeg: 8.0,
  jumpingDeg: 18.0,
  perShotGrowthDeg: 0,
  maxSpreadDeg: worstCaseCap(18.0),
  recoveryDegPerSec: 15,
  recoveryDelayMs: 100,
};
const operatorKick = buildKick([
  { x: 0, y: 0 },
  { x: 0.3, y: 3.5 },
]);
const operatorRecoil: RecoilSpec = {
  pattern: operatorKick.pattern,
  loopFromIndex: operatorKick.loopFromIndex,
  randomYawDeg: 0.15,
  randomPitchDeg: 0.15,
  recoveryDelayMs: 100,
  recoveryDegPerSec: 20,
};
const operatorAds: AdsSpec = {
  zoomFovDeg: [103 / 2.5, 103 / 5],
  sensMultiplier: 1.0,
  moveSpeedMultiplier: 0.3,
  enterTimeMs: 300,
  scopedSpreadDeg: 0,
};

const OPERATOR: WeaponSpec = {
  id: 'operator',
  name: 'Operator',
  category: 'sniper',
  fireMode: 'semi',
  fireRate: 0.6,
  magazine: 5,
  reserveAmmo: 20,
  reloadTimeMs: 3700,
  equipTimeMs: 750,
  damage: OPERATOR_DAMAGE,
  moveSpeed: RUN_SPEED_MS.value * 0.78,
  spread: operatorSpread,
  recoil: operatorRecoil,
  ads: operatorAds,
  confidence: 'approx',
  sourceNote:
    'VERIFIED: damage 255/150/120 with no falloff, 0.6 rounds/sec bolt-action, 5-round ' +
    'magazine, 20 reserve, 3.7s reload, two-stage 2.5x/5x scope -- published figures. ' +
    'APPROX: hip-fire (unscoped) spread is severe and only hand-estimated in shape (walking ' +
    'mild-ish, running heavy, jumping extreme per the brief) since Riot never publishes an ' +
    'exact cone; scoped-and-stationary is pinpoint (0deg) which IS the documented mechanic. ' +
    'perShotGrowthDeg is 0 because the bolt-action cycle makes rapid re-fire irrelevant. ' +
    'Zoom FOV values are computed from base HFOV/zoom-factor rather than measured, and ' +
    'moveSpeed/equipTimeMs/ADS timings are community-cited estimates.',
};

// -------------------------------------------------------------------- export --

export const WEAPONS: Record<string, WeaponSpec> = {
  vandal: VANDAL,
  phantom: PHANTOM,
  sheriff: SHERIFF,
  guardian: GUARDIAN,
  classic: CLASSIC,
  ghost: GHOST,
  operator: OPERATOR,
};

/** Display order: sidearms, then rifles, then sniper -- mirrors the buy menu. */
export const WEAPON_IDS: string[] = ['classic', 'sheriff', 'ghost', 'guardian', 'phantom', 'vandal', 'operator'];

export function getWeapon(id: string): WeaponSpec {
  const spec = WEAPONS[id];
  if (!spec) {
    throw new Error(`Unknown weapon id: "${id}"`);
  }
  return spec;
}
