/**
 * Shared contract for the whole trainer.
 *
 * RULE: this file and `constants.ts` are engine-agnostic. Nothing in `src/core`
 * may import from `three`, touch the DOM, or reference `window`. The desktop
 * port replaces `src/render` + `src/input` only.
 */

// ---------------------------------------------------------------- geometry --

export interface Vec2 { x: number; y: number; }
export interface Vec3 { x: number; y: number; z: number; }

/** Yaw/pitch in degrees. Yaw increases turning left (Valorant convention: +yaw = CCW seen from above). Pitch is clamped to +/-89. */
export interface Orientation { yaw: number; pitch: number; }

// ------------------------------------------------------------- sensitivity --

/** RawAccel curve families. `off` = pure 1:1 Valorant sensitivity. */
export type AccelCurveType =
  | 'off' | 'linear' | 'classic' | 'natural' | 'synchronous'
  | 'power' | 'motivity' | 'jump' | 'lookup';

/**
 * A RawAccel-compatible acceleration profile. Fields not used by the selected
 * `type` are ignored, so the UI can keep one editable object for every curve.
 * `inputSpeed` everywhere is in mouse counts per millisecond.
 */
export interface AccelCurve {
  type: AccelCurveType;
  /** RawAccel "Sens Multiplier" — flat gain applied before the curve. */
  sensMultiplier: number;
  /** Linear/classic: acceleration rate. */
  acceleration: number;
  /** Classic/power: exponent. Classic uses (exponent - 1) internally, power uses it directly. */
  exponent: number;
  /** Input speed below which no acceleration is applied. */
  inputOffset: number;
  /** Output gain ceiling. 0 = uncapped. */
  outputCap: number;
  /** Input speed ceiling for the curve. 0 = uncapped. */
  inputCap: number;
  /** Natural / motivity: rate of approach to the limit. */
  decayRate: number;
  /** Natural / synchronous: asymptotic gain limit. */
  limit: number;
  /** Synchronous: speed at which gain equals sensMultiplier. */
  syncSpeed: number;
  /** Synchronous: curve steepness. */
  gamma: number;
  /** Synchronous / jump: smoothing factor 0..1. */
  smooth: number;
  /** Motivity: peak gain. */
  motivity: number;
  /** Motivity / jump: growth rate. */
  growthRate: number;
  /** Motivity / jump: input speed of the inflection point. */
  midpoint: number;
  /** Apply the same curve to vertical movement (RawAccel "Whole/By Component"). */
  applyToY: boolean;
  /** `lookup` type only: [inputSpeed, gain] pairs, ascending by inputSpeed. */
  lookup?: Vec2[];
}

export interface SensConfig {
  /** Mouse counts per inch. */
  dpi: number;
  /** Reported polling rate, used only to sanity-check dt when a device lies. */
  pollingRateHz: number;
  /** Valorant in-game sensitivity value. */
  sensitivity: number;
  /** Valorant "Scoped Sensitivity Multiplier". */
  scopedMultiplier: number;
  /** True when a RawAccel curve is in play at all (either mode below). */
  rawAccelEnabled: boolean;
  /**
   * How the curve relates to the mouse input we receive.
   *
   * - `external` (the real-world case): RawAccel is running as a driver filter
   *   on the user's machine, so the counts that reach us are ALREADY
   *   accelerated. The app must NOT apply the curve again — it declares the
   *   curve so the analyser can reason about the speed-dependent gain that
   *   was applied upstream, and recover true hand speed by inverting it.
   * - `simulated`: no driver-level RawAccel; the app applies the curve itself
   *   so a curve can be trialled without installing anything.
   *
   * Defaults to `external`. Getting this backwards double-applies
   * acceleration and invalidates every angular measurement, so it is explicit
   * rather than inferred.
   */
  rawAccelMode?: 'external' | 'simulated';
  curve: AccelCurve;
  invertY: boolean;
}

/** One raw mouse movement, already deduplicated per animation frame if coalesced. */
export interface RawMouseDelta {
  /** Mouse counts, +x = right. */
  dx: number;
  /** Mouse counts, +y = down (browser convention). */
  dy: number;
  /** Milliseconds since the previous movement event. */
  dtMs: number;
  /** True when the platform gave us unaccelerated counts (Chrome `unadjustedMovement`). */
  unadjusted: boolean;
}

// ------------------------------------------------------------------ weapons --

export type FireMode = 'auto' | 'semi' | 'burst';
export type HitZone = 'head' | 'body' | 'leg';

/** Damage tier active from the previous tier's `maxDistanceM` up to this one's. */
export interface DamageTier {
  maxDistanceM: number;
  head: number;
  body: number;
  leg: number;
}

/**
 * Spread (bullet deviation from the crosshair). All values are the half-angle
 * of the deviation cone in degrees.
 */
export interface SpreadSpec {
  /** Deviation of the first shot while stationary. 0 for pinpoint weapons. */
  firstShotDeg: number;
  standingDeg: number;
  crouchingDeg: number;
  walkingDeg: number;
  runningDeg: number;
  jumpingDeg: number;
  /** Added per consecutive shot while the weapon is "hot". */
  perShotGrowthDeg: number;
  maxSpreadDeg: number;
  /** Spread bled off per second once firing stops. */
  recoveryDegPerSec: number;
  /** Delay before recovery begins. */
  recoveryDelayMs: number;
}

/**
 * Recoil (deterministic camera/aim-point climb). `pattern[i]` is the *cumulative*
 * offset in degrees applied at shot index i; +y = up, +x = right.
 */
export interface RecoilSpec {
  pattern: Vec2[];
  /** After the pattern is exhausted, resume looping from this index. */
  loopFromIndex: number;
  /** Uniform random jitter added on top of the pattern, in degrees. */
  randomYawDeg: number;
  randomPitchDeg: number;
  recoveryDelayMs: number;
  recoveryDegPerSec: number;
}

export interface AdsSpec {
  /** Horizontal FOV while scoped, per zoom level. */
  zoomFovDeg: number[];
  /** Extra sensitivity factor applied on top of `SensConfig.scopedMultiplier`. */
  sensMultiplier: number;
  moveSpeedMultiplier: number;
  enterTimeMs: number;
  /** Spread while scoped and stationary. */
  scopedSpreadDeg: number;
}

/**
 * Provenance for every numeric table. `verified` = matches published Valorant
 * data; `approx` = modelled/estimated and safe for the user to override in the
 * dev panel. Never mark a value `verified` unless it is.
 */
export type DataConfidence = 'verified' | 'approx';

export interface WeaponSpec {
  id: string;
  name: string;
  category: 'sidearm' | 'rifle' | 'sniper';
  fireMode: FireMode;
  /** Rounds per second. */
  fireRate: number;
  /** For `burst` weapons: rounds per burst and the delay between bursts. */
  burstCount?: number;
  burstDelayMs?: number;
  magazine: number;
  reserveAmmo: number;
  reloadTimeMs: number;
  equipTimeMs: number;
  /** Ascending by `maxDistanceM`; the last tier applies to infinity. */
  damage: DamageTier[];
  /** Movement speed while holding this weapon, in m/s. */
  moveSpeed: number;
  spread: SpreadSpec;
  recoil: RecoilSpec;
  ads?: AdsSpec;
  confidence: DataConfidence;
  /** Free-text note on where the numbers came from / what is estimated. */
  sourceNote: string;
}

// ----------------------------------------------------------------- hitboxes --

/** A capsule = swept sphere from `a` to `b`. Positions are model-local, metres, +y up. */
export interface Capsule {
  a: Vec3;
  b: Vec3;
  radius: number;
  zone: HitZone;
}

export interface AgentHitbox {
  /** Standing eye height, metres. */
  eyeHeightM: number;
  standingHeightM: number;
  crouchingHeightM: number;
  /** Ordered head-first so the first intersection test wins ties. */
  capsules: Capsule[];
}

export interface RayHit {
  targetId: string;
  zone: HitZone;
  point: Vec3;
  distanceM: number;
}

// ------------------------------------------------------------------ targets --

export type TargetBehaviorType =
  | 'static' | 'strafe' | 'counter-strafe' | 'jiggle' | 'peek' | 'random-walk';

export interface TargetBehavior {
  type: TargetBehaviorType;
  /** m/s. Defaults to the Valorant run speed when omitted. */
  speed?: number;
  /** Half-width of the strafe/jiggle path, metres. */
  amplitudeM?: number;
  /** Seconds a peeker stays exposed. */
  exposureSec?: number;
  /** Seconds between direction changes for jiggle/random-walk. */
  changeIntervalSec?: number;
  /** 0..1, how abruptly direction flips (1 = instant, Valorant counter-strafe). */
  sharpness?: number;
}

export interface TargetState {
  id: string;
  position: Vec3;
  velocity: Vec3;
  /** Facing, degrees. */
  yaw: number;
  health: number;
  armor: number;
  maxHealth: number;
  maxArmor: number;
  crouching: boolean;
  alive: boolean;
  /** Performance-clock ms. */
  spawnedAt: number;
  /** First moment the target became visible to the player (peek scenarios). */
  visibleAt: number | null;
  expiresAt: number | null;
  behavior: TargetBehavior;
  /** Behaviour-local scratch state; owned by the behaviour implementation. */
  phase: number;
  hitbox: AgentHitbox;
}

// ---------------------------------------------------------------- scenarios --

export type ScenarioFamily = 'clicking' | 'tracking' | 'peek';

export interface ScoringSpec {
  /** Points per point of damage dealt. */
  damagePoints: number;
  /** Bonus for a kill. */
  killPoints: number;
  /** Bonus multiplier applied to headshot damage points. */
  headshotBonus: number;
  /** Penalty per missed shot. */
  missPenalty: number;
  /** Penalty per second a target survives past its ideal TTK. */
  timePenalty: number;
}

export interface ScenarioDef {
  id: string;
  name: string;
  family: ScenarioFamily;
  description: string;
  durationSec: number;
  mapId: string;
  /** Weapon ids the scenario permits; the first is the default. */
  weapons: string[];
  /** Simultaneous live targets. */
  targetCount: number;
  /** Metres. Targets spawn within this band from the player. */
  minDistanceM: number;
  maxDistanceM: number;
  behavior: TargetBehavior;
  /** Target lifetime before it despawns, seconds. 0 = never. */
  targetLifetimeSec: number;
  /** Targets die in one hit regardless of damage (pure clicking scenarios). */
  oneShotKill: boolean;
  /** Player may move. */
  playerMovement: boolean;
  scoring: ScoringSpec;
}

// ---------------------------------------------------------------- telemetry --

/**
 * One fired round. This is the analyser's primary substrate — every field here
 * exists because some sensitivity metric needs it.
 */
export interface ShotEvent {
  /** ms since session start. */
  t: number;
  weaponId: string;
  shotIndexInBurst: number;
  hit: boolean;
  zone: HitZone | null;
  targetId: string | null;
  /** Distance to the target the player was aiming at, metres. */
  distanceM: number;
  /** Angle between the crosshair ray and the target head centre at fire time, degrees. */
  errorAngleDeg: number;
  /** Signed horizontal component of that error (+ = crosshair right of target). */
  errorYawDeg: number;
  errorPitchDeg: number;
  /** ms from target becoming visible to this shot. Null if not the first shot at it. */
  timeToTargetMs: number | null;
  /**
   * Signed peak angular distance travelled past the target centre during the
   * approach, degrees. Positive = overshoot, negative = stopped short.
   */
  overshootDeg: number;
  /** Direction reversals of the aim vector during the approach. */
  microCorrections: number;
  /** Total angular path length of the approach, degrees. A perfect flick equals the direct angle. */
  pathLengthDeg: number;
  /** Straight-line angle from approach start to target, degrees. */
  directAngleDeg: number;
  /** Peak angular velocity during the approach, deg/s. */
  peakAngularVelDeg: number;
  /** Applied spread half-angle and recoil offset for this round. */
  spreadDeg: number;
  recoilYawDeg: number;
  recoilPitchDeg: number;
  playerSpeed: number;
  /** Effective sensitivity gain applied at fire time (1.0 when RawAccel is off). */
  effectiveGain: number;
}

/** Aim trace sample, recorded every frame while a session is live. */
export interface AimSample {
  t: number;
  yaw: number;
  pitch: number;
  /** Raw counts this frame. */
  dx: number;
  dy: number;
  /** Post-curve gain applied this frame. */
  gain: number;
}

export interface SessionSummary {
  shots: number;
  hits: number;
  accuracy: number;
  headshots: number;
  headshotRate: number;
  kills: number;
  score: number;
  avgTimeToTargetMs: number;
  avgErrorDeg: number;
  /** Mean signed overshoot. >0 means the player consistently flicks past targets. */
  overshootBias: number;
  avgMicroCorrections: number;
  /** pathLength / directAngle, averaged. 1.0 is a perfect straight flick. */
  pathEfficiency: number;
  /** Tracking scenarios: fraction of live frames the crosshair was inside the body capsule. */
  trackingAccuracy: number;
  /** Std-dev of error angle, degrees. Lower = more consistent. */
  errorConsistency: number;
}

export interface SessionRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  scenarioId: string;
  weaponId: string;
  sens: SensConfig;
  /** Denormalised for fast analyser queries. */
  eDPI: number;
  cm360: number;
  rawAccelEnabled: boolean;
  summary: SessionSummary;
  shots: ShotEvent[];
  /** Downsampled to keep IndexedDB rows small; see storage layer. */
  samples: AimSample[];
}

// ----------------------------------------------------------------- analysis --

/** Aggregated performance at one sensitivity value. */
export interface SensBucket {
  sensitivity: number;
  eDPI: number;
  cm360: number;
  rawAccelEnabled: boolean;
  sessions: number;
  shots: number;
  accuracy: number;
  headshotRate: number;
  avgTimeToTargetMs: number;
  avgErrorDeg: number;
  errorConsistency: number;
  overshootBias: number;
  avgMicroCorrections: number;
  pathEfficiency: number;
  trackingAccuracy: number;
  /** 0..100 composite. */
  compositeScore: number;
}

export interface MetricVerdict {
  metric: string;
  /** Sensitivity that optimises this metric alone. */
  optimum: number;
  /** How strongly the data supports it, 0..1. */
  confidence: number;
  explanation: string;
}

export interface SensRecommendation {
  recommendedSens: number;
  recommendedEDPI: number;
  recommendedCm360: number;
  /** 0..1. Low means "keep training, not enough spread of data yet". */
  confidence: number;
  sessionsAnalysed: number;
  shotsAnalysed: number;
  /** Sens values still needing data, for the guided sweep. */
  suggestedNextSens: number[];
  perMetric: MetricVerdict[];
  buckets: SensBucket[];
  /** Fitted composite score curve for plotting. */
  curve: Vec2[];
  reasoning: string[];
}
