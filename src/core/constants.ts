import type { AgentHitbox, DataConfidence } from './types';

/**
 * Every constant carries a confidence tag. `verified` means the value is a
 * published/derivable Valorant figure; `approx` means it is a community
 * measurement or a model estimate and is exposed for override in the dev panel.
 *
 * If you change a value here, change its tag honestly.
 */
export interface Constant {
  value: number;
  confidence: DataConfidence;
  note: string;
}

const c = (value: number, confidence: DataConfidence, note: string): Constant =>
  ({ value, confidence, note });

// ------------------------------------------------------------- sensitivity --

/**
 * Degrees of yaw per mouse count at sensitivity 1.0. This is the single most
 * important number in the app.
 *
 * Derivation: Valorant and Source-engine games share a linear count->angle
 * model. Source uses m_yaw = 0.022 deg/count at sens 1.0. The community-standard
 * conversion Valorant = Source / 3.18 gives 0.022 * 3.1818... = 0.07 exactly.
 * Pitch uses the same factor (Valorant has no separate vertical multiplier).
 *
 *   degrees = counts * 0.07 * sensitivity
 *   cm/360  = 360 / (0.07 * sensitivity * dpi) * 2.54
 *   eDPI    = dpi * sensitivity
 */
export const VALORANT_DEG_PER_COUNT = c(0.07, 'verified',
  'Derived from the exact 3.18x Source->Valorant conversion (0.022 * 3.18 = 0.07).');

export const CM_PER_INCH = 2.54;

/** Valorant clamps vertical look just short of straight up/down. */
export const PITCH_LIMIT_DEG = c(89, 'verified', 'Standard FPS pitch clamp.');

// --------------------------------------------------------------------- view --

/** Valorant's fixed horizontal FOV at 16:9. Not user-adjustable in-game. */
export const DEFAULT_HFOV_DEG = c(103, 'verified', 'Valorant fixed horizontal FOV at 16:9.');

// ----------------------------------------------------------------- movement --

export const RUN_SPEED_MS = c(6.75, 'approx', 'Community-measured base run speed, m/s. Weapon-specific values override this.');
export const WALK_SPEED_MS = c(3.4, 'approx', 'Shift-walk, ~50% of run speed.');
export const CROUCH_SPEED_MS = c(2.3, 'approx', 'Crouch-walk, ~34% of run speed.');
export const GRAVITY_MS2 = c(-19.6, 'approx', 'Tuned so jump apex matches the ~0.65 m in-game jump.');
export const JUMP_VELOCITY_MS = c(5.05, 'approx', 'Gives a ~0.65 m apex under the gravity above.');

/**
 * Valorant deceleration is near-instant, which is what makes counter-strafing
 * work: releasing a direction key stops you within a couple of frames.
 */
export const STOP_TIME_MS = c(50, 'approx', 'Time from full speed to stationary after key release.');
export const ACCEL_TIME_MS = c(60, 'approx', 'Time from stationary to full speed.');

// ----------------------------------------------------------------- combat ---

export const BASE_HEALTH = c(100, 'verified', 'Agent base HP.');
export const LIGHT_SHIELD = c(25, 'verified', 'Light shield absorbs 25 damage 1:1.');
export const HEAVY_SHIELD = c(50, 'verified', 'Heavy shield absorbs 50 damage 1:1.');

/**
 * Valorant shields absorb incoming damage 1:1 until depleted, so effective HP
 * is simply health + shield. There is no percentage reduction.
 */
export const SHIELD_ABSORBS_ONE_TO_ONE = true;

// ---------------------------------------------------------------- hitboxes --

/**
 * Valorant hitboxes are capsules, uniform across agents (agent models differ
 * visually but the hitbox is standardised). Dimensions below are community
 * measurements in metres, +y up, origin at the feet.
 */
export const STANDING_HEIGHT_M = c(1.86, 'approx', 'Community-measured agent standing height.');
export const CROUCHING_HEIGHT_M = c(1.40, 'approx', 'Standing height * ~0.75.');
export const EYE_HEIGHT_M = c(1.68, 'approx', 'Camera height while standing.');
export const CROUCH_EYE_HEIGHT_M = c(1.25, 'approx', 'Camera height while crouched.');

export const STANDING_HITBOX: AgentHitbox = {
  eyeHeightM: EYE_HEIGHT_M.value,
  standingHeightM: STANDING_HEIGHT_M.value,
  crouchingHeightM: CROUCHING_HEIGHT_M.value,
  /**
   * Six capsules describing an actual humanoid, head first (the first hit wins
   * on a tie, and `raycastTarget` additionally gives the head outright
   * priority — see the note there about overlapping caps).
   *
   * These are deliberately sized so the DRAWN bot fills them. A capsule is a
   * swept sphere, so its true extent is the segment plus `radius` in every
   * direction — easy to under-estimate, and getting it wrong is not a cosmetic
   * problem. An earlier version used a head segment of 1.66->1.75 with radius
   * 0.115, which is a 32 cm tall hittable head on a 1.86 m body: you could
   * shoot a clear 8 cm above the visible skull and still be awarded a
   * headshot. Every number below is quoted with its resulting span so that
   * mistake is visible at a glance rather than hidden in the arithmetic.
   *
   * Arms are included and count as BODY damage, matching Valorant. Leaving
   * them out meant a visible arm was a hole in the hitbox and a clean shot
   * read as a miss — the single most jarring thing a trainer can do.
   */
  capsules: [
    // Head: spans y 1.595..1.845, 0.20 m wide -> a 0.25 m head. Eye height
    // (1.68) sits inside it, as it must.
    { a: { x: 0, y: 1.695, z: 0 }, b: { x: 0, y: 1.745, z: 0 }, radius: 0.10, zone: 'head' },

    // Torso: spans y 0.87..1.59, 0.38 m wide. The top cap now stops at the
    // shoulder line instead of bulging up past the jaw.
    { a: { x: 0, y: 1.06, z: 0 }, b: { x: 0, y: 1.40, z: 0 }, radius: 0.19, zone: 'body' },

    // Arms: outer extent 0.31 m from centre, hanging beside the torso.
    { a: { x: -0.25, y: 1.13, z: 0 }, b: { x: -0.25, y: 1.50, z: 0 }, radius: 0.06, zone: 'body' },
    { a: { x: 0.25, y: 1.13, z: 0 }, b: { x: 0.25, y: 1.50, z: 0 }, radius: 0.06, zone: 'body' },

    // Legs: span y 0.045..0.965, just meeting at the centreline so there is no
    // free gap to shoot through between them.
    { a: { x: -0.10, y: 0.15, z: 0 }, b: { x: -0.10, y: 0.86, z: 0 }, radius: 0.105, zone: 'leg' },
    { a: { x: 0.10, y: 0.15, z: 0 }, b: { x: 0.10, y: 0.86, z: 0 }, radius: 0.105, zone: 'leg' },
  ],
};

/** Crouching compresses the capsule stack toward the feet by this factor. */
export const CROUCH_SCALE = c(CROUCHING_HEIGHT_M.value / STANDING_HEIGHT_M.value, 'approx',
  'Uniform vertical compression applied to the standing capsules when crouched.');

// ------------------------------------------------------------------ engine --

/** Fixed simulation step. Rendering interpolates between steps. */
export const SIM_STEP_MS = 4;
/** Aim trace sampling rate for telemetry, Hz. Downsampled again before storage. */
export const AIM_SAMPLE_HZ = 250;

/** Every tagged constant, for the dev override panel. */
export const TUNABLES: Record<string, Constant> = {
  VALORANT_DEG_PER_COUNT, PITCH_LIMIT_DEG, DEFAULT_HFOV_DEG,
  RUN_SPEED_MS, WALK_SPEED_MS, CROUCH_SPEED_MS, GRAVITY_MS2, JUMP_VELOCITY_MS,
  STOP_TIME_MS, ACCEL_TIME_MS, BASE_HEALTH, LIGHT_SHIELD, HEAVY_SHIELD,
  STANDING_HEIGHT_M, CROUCHING_HEIGHT_M, EYE_HEIGHT_M, CROUCH_EYE_HEIGHT_M, CROUCH_SCALE,
};
