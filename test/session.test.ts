import { describe, it, expect } from 'vitest';
import type { ScenarioDef, WeaponSpec } from '../src/core/types';
import { EYE_HEIGHT_M } from '../src/core/constants';
import { dirToAngles, normalize, sub } from '../src/core/math';
import { headCentre, transformHitbox } from '../src/core/hitbox';
import { getScenario } from '../src/core/scenarios/definitions';
import { getWeapon } from '../src/data/weapons';
import { TrainingSession, type SessionDeps } from '../src/game/session';
import type { RuntimeEnv } from '../src/core/scenarios/runtime';

const ENV: RuntimeEnv = { colliders: [], spawnPoints: [], playerSpawn: { x: 0, y: 0, z: 0 } };

/** Mutable input stub — the session only ever reads through these methods. */
function makeInput() {
  const state = { button0: false, keys: new Set<string>() };
  const stub = {
    onDelta: () => () => {},
    onButtonDown: () => () => {},
    onButtonUp: () => () => {},
    onKeyDown: () => () => {},
    onKeyUp: () => () => {},
    isKeyDown: (k: string) => state.keys.has(k),
    isButtonDown: (b: number) => b === 0 && state.button0,
    isRawSupported: true,
  };
  return { state, stub };
}

const noopRenderer = {
  setCameraOrientation: () => {},
  render: () => {},
  frameStats: { fps: 240, frameTimeMs: 4 },
};
const noopTargets = { sync: () => {}, flashHit: () => {}, spawnHitMarker: () => {}, setVisualMode: () => {}, dispose: () => {} };
const noopHud = {
  setAmmo: () => {}, setTimer: () => {}, setScore: () => {}, setStreak: () => {},
  showHitFeedback: () => {}, setFrameStats: () => {}, setTargetHealth: () => {}, dispose: () => {},
};
const noopCrosshair = { setError: () => {}, setConfig: () => {}, dispose: () => {} };

function makeSession(weapon: WeaponSpec, scenarioOver: Partial<ScenarioDef> = {}) {
  const { state, stub } = makeInput();
  const scenario: ScenarioDef = {
    ...getScenario('static-grid'),
    targetCount: 1,
    minDistanceM: 15,
    maxDistanceM: 15,
    oneShotKill: false,
    playerMovement: false,
    behavior: { type: 'static' },
    ...scenarioOver,
  };
  const deps = {
    scenario, weapon, sens: {
      dpi: 800, pollingRateHz: 1000, sensitivity: 0.35, scopedMultiplier: 1,
      rawAccelEnabled: false, invertY: false,
      curve: getWeapon('vandal') && {
        type: 'off', sensMultiplier: 1, acceleration: 0, exponent: 2, inputOffset: 0,
        outputCap: 0, inputCap: 0, decayRate: 1, limit: 1, syncSpeed: 1, gamma: 1,
        smooth: 0, motivity: 1, growthRate: 1, midpoint: 1, applyToY: true,
      },
    },
    env: ENV,
    renderer: noopRenderer,
    targets: noopTargets,
    hud: noopHud,
    crosshair: noopCrosshair,
    input: stub,
    seed: 42,
  } as unknown as SessionDeps;

  const session = new TrainingSession(deps);
  session.start();
  return { session, state };
}

/** Steps past the weapon's equip time so shots are legal. */
function settle(session: TrainingSession, ms = 900): void {
  for (let i = 0; i < ms / 4; i++) session.fixedStep(0.004);
}

/** Points the crosshair exactly at the live target's head centre. */
function aimAtHead(session: TrainingSession): void {
  const t = session.runtime.targets[0];
  const capsules = transformHitbox(t.hitbox, t.position, t.yaw, t.crouching);
  const eye = { x: 0, y: EYE_HEIGHT_M.value, z: 0 };
  const a = dirToAngles(normalize(sub(headCentre(capsules), eye)));
  session.setAim(a.x, a.y);
}

describe('firing', () => {
  it('registers a headshot when aimed at the head centre', () => {
    const { session, state } = makeSession(getWeapon('vandal'));
    settle(session);
    aimAtHead(session);
    state.button0 = true;
    session.fixedStep(0.004);

    const record = session.finish();
    expect(record.shots.length).toBe(1);
    expect(record.shots[0].hit).toBe(true);
    expect(record.shots[0].zone).toBe('head');
    session.dispose();
  });

  it('measures aim error from the crosshair, never from where the bullet went', () => {
    // A weapon with a 5-degree first-shot cone: the bullet will fly wide, but
    // the player's aim was perfect. If error were measured from the bullet,
    // this would report ~5 degrees of error the human never made — and every
    // sensitivity recommendation built on it would be wrong.
    const wild: WeaponSpec = {
      ...getWeapon('vandal'),
      spread: { ...getWeapon('vandal').spread, firstShotDeg: 5, standingDeg: 5 },
    };
    const { session, state } = makeSession(wild);
    settle(session);
    aimAtHead(session);
    state.button0 = true;
    session.fixedStep(0.004);

    const record = session.finish();
    expect(record.shots.length).toBe(1);
    const shot = record.shots[0];
    expect(shot.spreadDeg).toBeCloseTo(5, 6);
    // Aim was exact, so error stays near zero regardless of the dispersion.
    expect(shot.errorAngleDeg).toBeLessThan(0.05);
    session.dispose();
  });

  it('reports distance and an intended target even on a miss', () => {
    const { session, state } = makeSession(getWeapon('vandal'));
    settle(session);
    // Aim well off the target, then fire: the shot must still be attributed to
    // the nearest target by angle, or a miss would carry no information.
    aimAtHead(session);
    const o = session.orientation;
    session.setAim(o.yaw + 25, o.pitch);
    state.button0 = true;
    session.fixedStep(0.004);

    const record = session.finish();
    const shot = record.shots[0];
    expect(shot.hit).toBe(false);
    expect(shot.targetId).not.toBeNull();
    expect(shot.errorAngleDeg).toBeGreaterThan(20);
    expect(shot.distanceM).toBeGreaterThan(10);
    session.dispose();
  });

  it('respects the weapon equip time before the first shot is legal', () => {
    const { session, state } = makeSession(getWeapon('vandal'));
    aimAtHead(session);
    state.button0 = true;
    // Only 100ms in — well inside the Vandal's 750ms draw.
    for (let i = 0; i < 25; i++) session.fixedStep(0.004);

    expect(session.finish().shots.length).toBe(0);
    session.dispose();
  });

  it('cannot fire a semi-auto faster than its fire rate', () => {
    const { session, state } = makeSession(getWeapon('sheriff'));
    settle(session);
    aimAtHead(session);
    state.button0 = true;
    // Sheriff is semi-auto: holding the button must not auto-fire at all.
    for (let i = 0; i < 250; i++) session.fixedStep(0.004);

    expect(session.finish().shots.length).toBe(0);
    session.dispose();
  });
});
