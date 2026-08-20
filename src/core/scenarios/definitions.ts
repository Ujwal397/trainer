import type { ScenarioDef, ScoringSpec } from '../types';

/**
 * Scoring presets. Clicking scenarios reward speed heavily because the skill
 * being trained is target acquisition; tracking scenarios reward sustained
 * damage instead, since a fast first shot means little if the follow-up misses.
 */
const CLICK_SCORING: ScoringSpec = {
  damagePoints: 0.5,
  killPoints: 100,
  headshotBonus: 2,
  missPenalty: 25,
  timePenalty: 5,
};

const TRACK_SCORING: ScoringSpec = {
  damagePoints: 2,
  killPoints: 40,
  headshotBonus: 1.5,
  missPenalty: 2,
  timePenalty: 0,
};

/**
 * Peek scenarios penalise misses hardest: shooting at a corner you have not
 * confirmed is exactly the habit this family exists to break.
 */
const PEEK_SCORING: ScoringSpec = {
  damagePoints: 0.6,
  killPoints: 120,
  headshotBonus: 2.5,
  missPenalty: 40,
  timePenalty: 10,
};

export const SCENARIOS: ScenarioDef[] = [
  // ------------------------------------------------------------- clicking --
  {
    id: 'static-grid',
    name: 'Static Grid',
    family: 'clicking',
    description:
      'Six stationary targets at a fixed distance. Pure flick precision with no movement variables — the baseline every sensitivity comparison is measured against.',
    durationSec: 60,
    mapId: 'range',
    weapons: ['sheriff', 'vandal', 'ghost'],
    targetCount: 6,
    minDistanceM: 12,
    maxDistanceM: 12,
    behavior: { type: 'static' },
    targetLifetimeSec: 0,
    oneShotKill: true,
    playerMovement: false,
    scoring: CLICK_SCORING,
  },
  {
    id: 'static-spread',
    name: 'Spread Grid',
    family: 'clicking',
    description:
      'Stationary targets scattered from 8m to 30m. Forces the large and small flicks that reveal whether a sensitivity suits your whole range, not just one distance.',
    durationSec: 60,
    mapId: 'range',
    weapons: ['sheriff', 'vandal', 'guardian'],
    targetCount: 5,
    minDistanceM: 8,
    maxDistanceM: 30,
    behavior: { type: 'static' },
    targetLifetimeSec: 0,
    oneShotKill: true,
    playerMovement: false,
    scoring: CLICK_SCORING,
  },
  {
    id: 'flick-single',
    name: 'One Target Flick',
    family: 'clicking',
    description:
      'One target at a time; the next spawns the instant the last dies. The cleanest possible measurement of time-to-target and overshoot — the analyzer weights this scenario most heavily.',
    durationSec: 60,
    mapId: 'range',
    weapons: ['sheriff', 'vandal', 'classic'],
    targetCount: 1,
    minDistanceM: 10,
    maxDistanceM: 25,
    behavior: { type: 'static' },
    targetLifetimeSec: 0,
    oneShotKill: true,
    playerMovement: false,
    scoring: CLICK_SCORING,
  },
  {
    id: 'flick-timed',
    name: 'Timed Flicks',
    family: 'clicking',
    description:
      'Targets expire after 1.2 seconds. Speed pressure exposes the sensitivity where you start rushing past targets instead of landing on them.',
    durationSec: 60,
    mapId: 'range',
    weapons: ['sheriff', 'vandal'],
    targetCount: 3,
    minDistanceM: 10,
    maxDistanceM: 28,
    behavior: { type: 'static' },
    targetLifetimeSec: 1.2,
    oneShotKill: true,
    playerMovement: false,
    scoring: CLICK_SCORING,
  },
  {
    id: 'headshot-only',
    name: 'Headshot Only',
    family: 'clicking',
    description:
      'Only head hits count. Body shots score nothing and cost you a miss — trains the crosshair discipline that decides real duels.',
    durationSec: 60,
    mapId: 'range',
    weapons: ['vandal', 'guardian', 'sheriff'],
    targetCount: 4,
    minDistanceM: 12,
    maxDistanceM: 22,
    behavior: { type: 'static' },
    targetLifetimeSec: 0,
    oneShotKill: false,
    playerMovement: false,
    scoring: { ...CLICK_SCORING, headshotBonus: 4, missPenalty: 40 },
  },
  {
    id: 'operator-taps',
    name: 'Operator One-Taps',
    family: 'clicking',
    description:
      'Scoped Operator, long range, one shot per target. Scoped sensitivity is a different pipeline from hipfire, and this is where you tune it.',
    durationSec: 90,
    mapId: 'range',
    weapons: ['operator'],
    targetCount: 1,
    minDistanceM: 25,
    maxDistanceM: 45,
    behavior: { type: 'static' },
    targetLifetimeSec: 0,
    oneShotKill: false,
    playerMovement: false,
    scoring: { ...CLICK_SCORING, killPoints: 200, missPenalty: 60 },
  },

  // ------------------------------------------------------------- tracking --
  {
    id: 'strafe-single',
    name: 'Strafe Tracking',
    family: 'tracking',
    description:
      'One target strafing side to side at full Valorant run speed. Smooth-tracking baseline — the metric here is how long your crosshair stays inside the body capsule.',
    durationSec: 60,
    mapId: 'range',
    weapons: ['vandal', 'phantom'],
    targetCount: 1,
    minDistanceM: 12,
    maxDistanceM: 18,
    behavior: { type: 'strafe', amplitudeM: 4, sharpness: 0.6 },
    targetLifetimeSec: 0,
    oneShotKill: false,
    playerMovement: false,
    scoring: TRACK_SCORING,
  },
  {
    id: 'counter-strafe',
    name: 'Counter-Strafe Duel',
    family: 'tracking',
    description:
      'The target counter-strafes: full-speed movement stopped dead, then a shot. Reproduces the single most common real-duel pattern in Valorant.',
    durationSec: 60,
    mapId: 'boxes',
    weapons: ['vandal', 'phantom'],
    targetCount: 1,
    minDistanceM: 10,
    maxDistanceM: 20,
    behavior: { type: 'counter-strafe', amplitudeM: 2.2, sharpness: 1, changeIntervalSec: 0.95 },
    targetLifetimeSec: 0,
    oneShotKill: false,
    playerMovement: true,
    scoring: TRACK_SCORING,
  },
  {
    id: 'jiggle-track',
    name: 'Jiggle Tracking',
    family: 'tracking',
    description:
      'Short, sharp, unpredictable direction changes. Punishes a sensitivity that is too high far more than smooth strafing does.',
    durationSec: 60,
    mapId: 'range',
    weapons: ['phantom', 'vandal'],
    targetCount: 1,
    minDistanceM: 8,
    maxDistanceM: 15,
    behavior: { type: 'jiggle', amplitudeM: 1.6, changeIntervalSec: 0.6, sharpness: 1 },
    targetLifetimeSec: 0,
    oneShotKill: false,
    playerMovement: false,
    scoring: TRACK_SCORING,
  },
  {
    id: 'multi-strafe',
    name: 'Target Switching',
    family: 'tracking',
    description:
      'Three moving targets at once. Trains the transfer between targets — the flick that follows a kill, where most sprays are thrown away.',
    durationSec: 60,
    mapId: 'boxes',
    weapons: ['vandal', 'phantom'],
    targetCount: 3,
    minDistanceM: 10,
    maxDistanceM: 25,
    behavior: { type: 'strafe', amplitudeM: 3, sharpness: 0.8 },
    targetLifetimeSec: 0,
    oneShotKill: false,
    playerMovement: false,
    scoring: TRACK_SCORING,
  },
  {
    id: 'reactive-walk',
    name: 'Reactive Movement',
    family: 'tracking',
    description:
      'Targets wander unpredictably through cover at mixed speeds while you move too. The closest thing here to an actual round.',
    durationSec: 90,
    mapId: 'site',
    weapons: ['vandal', 'phantom', 'guardian'],
    targetCount: 2,
    minDistanceM: 8,
    maxDistanceM: 30,
    behavior: { type: 'random-walk', changeIntervalSec: 0.7 },
    targetLifetimeSec: 0,
    oneShotKill: false,
    playerMovement: true,
    scoring: TRACK_SCORING,
  },

  // ----------------------------------------------------------------- peek --
  {
    id: 'corner-peek',
    name: 'Corner Pre-Aim',
    family: 'peek',
    description:
      'Targets step out from a fixed corner at head height. Scores your crosshair placement before the target appears, not just your reaction after.',
    durationSec: 60,
    mapId: 'angles',
    weapons: ['vandal', 'phantom', 'sheriff'],
    targetCount: 1,
    minDistanceM: 8,
    maxDistanceM: 20,
    behavior: { type: 'peek', exposureSec: 1.0 },
    targetLifetimeSec: 0,
    oneShotKill: false,
    playerMovement: false,
    scoring: PEEK_SCORING,
  },
  {
    id: 'multi-angle',
    name: 'Multi-Angle Hold',
    family: 'peek',
    description:
      'Peeks come from several angles in random order. Forces you to choose a crosshair position that covers more than one threat — the real skill in holding a site.',
    durationSec: 90,
    mapId: 'angles',
    weapons: ['vandal', 'phantom'],
    targetCount: 1,
    minDistanceM: 8,
    maxDistanceM: 25,
    behavior: { type: 'peek', exposureSec: 0.8 },
    targetLifetimeSec: 0,
    oneShotKill: false,
    playerMovement: false,
    scoring: PEEK_SCORING,
  },
  {
    id: 'wide-swing',
    name: 'Wide Swing',
    family: 'peek',
    description:
      'You take the peek. Move out from cover and kill what is holding the angle before it kills you — trains the peeker-advantage timing window.',
    durationSec: 90,
    mapId: 'site',
    weapons: ['vandal', 'phantom', 'guardian'],
    targetCount: 1,
    minDistanceM: 10,
    maxDistanceM: 28,
    behavior: { type: 'static' },
    targetLifetimeSec: 0,
    oneShotKill: false,
    playerMovement: true,
    scoring: PEEK_SCORING,
  },
  {
    id: 'jiggle-peek',
    name: 'Jiggle Peek Punish',
    family: 'peek',
    description:
      'Targets flash in and out of cover for a fraction of a second. The shortest exposure windows in the app — this is where a mistuned sensitivity is most obvious.',
    durationSec: 60,
    mapId: 'angles',
    weapons: ['vandal', 'sheriff', 'operator'],
    targetCount: 1,
    minDistanceM: 12,
    maxDistanceM: 30,
    behavior: { type: 'peek', exposureSec: 0.4 },
    targetLifetimeSec: 0,
    oneShotKill: false,
    playerMovement: false,
    scoring: { ...PEEK_SCORING, killPoints: 180 },
  },
];

export const SCENARIOS_BY_ID: Record<string, ScenarioDef> = Object.fromEntries(
  SCENARIOS.map((s) => [s.id, s]),
);

export function getScenario(id: string): ScenarioDef {
  const s = SCENARIOS_BY_ID[id];
  if (!s) throw new Error(`Unknown scenario: ${id}`);
  return s;
}

export const SCENARIOS_BY_FAMILY = {
  clicking: SCENARIOS.filter((s) => s.family === 'clicking'),
  tracking: SCENARIOS.filter((s) => s.family === 'tracking'),
  peek: SCENARIOS.filter((s) => s.family === 'peek'),
};
