/**
 * SessionRecorder — captures the raw data the analyser needs while a session
 * is live, and reduces it into the `ShotEvent` / `SessionSummary` shapes
 * defined in `types.ts`.
 *
 * Import discipline: this file only pulls from `./types` and `./math`. It
 * never touches the DOM, `three`, or scenario/weapon data files, so it can be
 * unit-tested (and reused by a future non-browser port) with zero setup.
 */
import type {
  AimSample,
  SensConfig,
  SessionRecord,
  SessionSummary,
  ShotEvent,
} from './types';
import { angleDelta, mean, stdDev } from './math';

// ------------------------------------------------------------- tunables ----
//
// These thresholds encode the "approach" heuristics. They are deliberately
// conservative (biased toward under-counting corrections / a shorter window)
// because false positives here directly corrupt the sensitivity analysis
// downstream — a jittery mouse must never look like a player who over-corrects.

/** How much trailing aim history we keep available for approach reconstruction. */
const RING_WINDOW_MS = 3000;

/**
 * Hard cap on how far back an "approach" can reach, even if the aim never
 * settles. ~800ms comfortably covers a slow, deliberate flick-and-track while
 * refusing to attribute a whole session's drift to one shot.
 */
const APPROACH_CAP_MS = 800;

/**
 * Angular speed below which the crosshair is considered "resting" rather than
 * actively moving toward a target. Ordinary hand tremor / sensor noise sits
 * well under this even at high sensitivity.
 */
const IDLE_VEL_THRESHOLD_DEG_S = 25;

/**
 * An idle period must persist this long, scanning backward from the shot,
 * before we treat it as "the crosshair was resting here before the flick
 * started" (as opposed to a brief stutter mid-flick).
 */
const IDLE_SUSTAIN_MS = 60;

/**
 * Deadband on the *signed progress velocity* (see `computeApproachMetrics`)
 * used when counting micro-corrections. Anything under this is treated as
 * noise, not a deliberate reversal.
 */
const MICRO_DEADBAND_DEG_S = 20;

/** A reversal must hold on the opposite side of the deadband for at least this long. */
const MICRO_SUSTAIN_MS = 16;

/** Samples within this many ms of any shot are kept at full rate when persisting. */
const SHOT_FULL_RATE_WINDOW_MS = 500;

/**
 * Target rate for everything outside the shot windows. IndexedDB rows must
 * stay small — a 60s session at the 250Hz capture rate (see
 * `constants.AIM_SAMPLE_HZ`) is ~15k samples; thinned to 30Hz between shots
 * it's closer to 2-3k, which keeps a session record well under a MB even for
 * long grinding sessions. See `src/storage/db.ts` for how this is packed on
 * top of the downsampling done here.
 */
const THIN_INTERVAL_MS = 1000 / 30;

// --------------------------------------------------------------- helpers ---

/** 2D angular distance between two aim samples (yaw wrap-safe, pitch is not wrapped). */
function angularDist(a: AimSample, b: AimSample): number {
  const dYaw = angleDelta(b.yaw, a.yaw);
  const dPitch = b.pitch - a.pitch;
  return Math.sqrt(dYaw * dYaw + dPitch * dPitch);
}

function makeId(prefix: string): string {
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/**
 * The caller-supplied facts about a shot. Everything the recorder can derive
 * from its own aim history (overshoot, micro-corrections, path length, direct
 * angle, peak velocity, time-to-target) is intentionally excluded — see
 * `recordShot`.
 */
export type ShotInput = Omit<
  ShotEvent,
  'overshootDeg' | 'microCorrections' | 'pathLengthDeg' | 'directAngleDeg' | 'peakAngularVelDeg' | 'timeToTargetMs'
>;

interface ApproachMetrics {
  overshootDeg: number;
  microCorrections: number;
  pathLengthDeg: number;
  directAngleDeg: number;
  peakAngularVelDeg: number;
}

/**
 * Reconstructs the approach that led to a shot and derives its movement
 * metrics.
 *
 * "The approach" is defined as: scan backward from the shot through `ring`
 * (already limited to the trailing `RING_WINDOW_MS`) until angular velocity
 * drops below `IDLE_VEL_THRESHOLD_DEG_S` and stays there for at least
 * `IDLE_SUSTAIN_MS` — that idle stretch is where the crosshair was resting
 * before the flick began, so the approach starts at its most recent sample.
 * If no such rest point exists within `APPROACH_CAP_MS`, the approach is
 * simply capped there (a player who never stops moving still gets a bounded
 * window, not the whole ring).
 *
 * `target` is the reconstructed *angular position of the target at fire
 * time* (see `recordShot`), which the recorder treats as a fixed reference
 * for the whole approach. We only ever get one ground-truth fix on the
 * target's angle (the error at the moment of the shot) — we do not track
 * target trajectories — so this is an approximation that assumes the target
 * did not move far in angle-space during the (sub-second) approach window.
 * That's accurate for flicks and mostly-stationary tracking, and only weakly
 * biases fast peekers/strafers, which is an acceptable trade for keeping the
 * recorder decoupled from target simulation state.
 *
 * Sign convention for `overshootDeg` (this is the one metric the whole
 * sensitivity analysis leans on, so get it right):
 *   1. Take `u`, the unit vector from the approach's starting angle toward
 *      the target's angle. `directAngleDeg` is its length.
 *   2. Project every sample's displacement from the start onto `u` to get a
 *      1D "progress" scalar (can go negative before the flick begins, and
 *      can exceed `directAngleDeg` if the crosshair flies past the target).
 *   3. `overshootDeg = max(progress) - directAngleDeg`.
 *   Positive => at some point during the approach the crosshair traveled
 *   past the target's position (a flick that overshot, even if it was
 *   corrected back before firing). Negative => the crosshair never reached
 *   the target at all (stopped short by that many degrees). Zero => the
 *   approach's peak progress landed exactly on the target.
 */
function computeApproachMetrics(ring: AimSample[], shotT: number, target: { yaw: number; pitch: number }): ApproachMetrics {
  const capT = shotT - APPROACH_CAP_MS;
  const windowed = ring.filter((s) => s.t <= shotT && s.t >= capT - IDLE_SUSTAIN_MS - 200);
  // Keep a small margin before capT so we can still see velocity *entering*
  // the capped window; the actual approach start is clamped to >= capT below.
  if (windowed.length < 2) {
    return { overshootDeg: 0, microCorrections: 0, pathLengthDeg: 0, directAngleDeg: 0, peakAngularVelDeg: 0 };
  }

  // Per-sample velocity, v[i] = speed arriving at windowed[i] from windowed[i-1].
  const vel: number[] = [0];
  for (let i = 1; i < windowed.length; i++) {
    const dt = Math.max(1, windowed[i].t - windowed[i - 1].t);
    vel.push((angularDist(windowed[i - 1], windowed[i]) / dt) * 1000);
  }

  // Scan backward from the shot looking for a sustained idle run.
  let approachStartIdx = 0;
  const lastIdx = windowed.length - 1;
  let idleRunEndIdx = -1; // index (closest-to-shot) where the idle candidate run began
  for (let i = lastIdx; i > 0; i--) {
    if (windowed[i].t < capT) {
      // Hit the hard cap before finding a rest point.
      approachStartIdx = i;
      break;
    }
    if (vel[i] < IDLE_VEL_THRESHOLD_DEG_S) {
      if (idleRunEndIdx === -1) idleRunEndIdx = i;
      const idleDurationMs = windowed[idleRunEndIdx].t - windowed[i].t;
      if (idleDurationMs >= IDLE_SUSTAIN_MS) {
        approachStartIdx = idleRunEndIdx;
        break;
      }
    } else {
      idleRunEndIdx = -1; // still moving fast — reset, this isn't rest
    }
    approachStartIdx = i; // fallback if we run out of window before confirming idle
  }
  approachStartIdx = Math.max(0, approachStartIdx);

  const approach = windowed.slice(approachStartIdx);
  if (approach.length < 2) {
    return { overshootDeg: 0, microCorrections: 0, pathLengthDeg: 0, directAngleDeg: 0, peakAngularVelDeg: 0 };
  }

  const start = approach[0];
  const dYawTotal = angleDelta(target.yaw, start.yaw);
  const dPitchTotal = target.pitch - start.pitch;
  const directAngleDeg = Math.sqrt(dYawTotal * dYawTotal + dPitchTotal * dPitchTotal);
  const hasDirection = directAngleDeg > 1e-3;
  const ux = hasDirection ? dYawTotal / directAngleDeg : 0;
  const uy = hasDirection ? dPitchTotal / directAngleDeg : 0;

  let pathLengthDeg = 0;
  let peakAngularVelDeg = 0;
  let peakProgress = 0;
  const progress: number[] = [];
  const times: number[] = [];
  for (let i = 0; i < approach.length; i++) {
    const s = approach[i];
    const dYaw = angleDelta(s.yaw, start.yaw);
    const dPitch = s.pitch - start.pitch;
    const p = dYaw * ux + dPitch * uy;
    progress.push(p);
    times.push(s.t);
    if (p > peakProgress) peakProgress = p;
    if (i > 0) {
      const step = angularDist(approach[i - 1], s);
      pathLengthDeg += step;
      const dt = Math.max(1, s.t - approach[i - 1].t);
      const v = (step / dt) * 1000;
      if (v > peakAngularVelDeg) peakAngularVelDeg = v;
    }
  }

  const overshootDeg = hasDirection ? peakProgress - directAngleDeg : 0;
  const microCorrections = countMicroCorrections(progress, times);

  return { overshootDeg, microCorrections, pathLengthDeg, directAngleDeg, peakAngularVelDeg };
}

/**
 * Counts direction reversals in the signed "progress velocity" (rate of
 * change of the along-target-axis progress computed in
 * `computeApproachMetrics`). A reversal only counts once the opposite-sign
 * velocity has held for `MICRO_SUSTAIN_MS`, and velocities inside
 * `MICRO_DEADBAND_DEG_S` are treated as "no direction" — together these keep
 * mouse-sensor jitter and sub-pixel noise from inflating the count while
 * still catching real overshoot-and-correct or hunt-and-peck adjustments.
 */
function countMicroCorrections(progress: number[], times: number[]): number {
  if (progress.length < 3) return 0;
  let reversals = 0;
  let dir: -1 | 0 | 1 = 0;
  let pendingDir: -1 | 0 | 1 = 0;
  let pendingStartT = -Infinity;

  for (let i = 1; i < progress.length; i++) {
    const dt = Math.max(1, times[i] - times[i - 1]);
    const v = ((progress[i] - progress[i - 1]) / dt) * 1000;
    const s: -1 | 0 | 1 = Math.abs(v) < MICRO_DEADBAND_DEG_S ? 0 : v > 0 ? 1 : -1;

    if (s === 0) {
      pendingDir = 0;
      continue;
    }
    if (dir === 0) {
      dir = s;
      pendingDir = 0;
      continue;
    }
    if (s === dir) {
      pendingDir = 0; // still going the established way
      continue;
    }
    // Candidate reversal: velocity now points the opposite way.
    if (pendingDir !== s) {
      pendingDir = s;
      pendingStartT = times[i - 1];
    }
    if (times[i] - pendingStartT >= MICRO_SUSTAIN_MS) {
      reversals++;
      dir = s;
      pendingDir = 0;
    }
  }
  return reversals;
}

// -------------------------------------------------------------- recorder ---

export class SessionRecorder {
  private startedAtWall = 0;
  private scenarioId = '';
  private weaponId = '';
  private sens: SensConfig | null = null;

  /** Trailing window of aim samples, time-trimmed to `RING_WINDOW_MS`. Used to reconstruct approaches. */
  private ring: AimSample[] = [];
  /** Full-session, append-only aim history. Only used at `endSession` to build the downsampled `samples` output. */
  private history: AimSample[] = [];

  private onTargetSamples: { t: number; onTarget: boolean }[] = [];

  private shots: ShotEvent[] = [];
  private firstShotSeenFor = new Set<string>();
  private visibleAt = new Map<string, number>();

  // Score/kill bookkeeping is intentionally caller-driven: `ScoringSpec`
  // (damage/kill/headshot/time weights) lives in scenario data under
  // `src/data`, which this file may not import. The sim loop owns that data
  // and should call `recordKill()` / `addScore()` as it awards points; the
  // recorder just accumulates the totals into the summary.
  private kills = 0;
  private score = 0;

  beginSession(scenarioId: string, weaponId: string, sens: SensConfig): void {
    this.startedAtWall = Date.now();
    this.scenarioId = scenarioId;
    this.weaponId = weaponId;
    this.sens = sens;
    this.ring = [];
    this.history = [];
    this.onTargetSamples = [];
    this.shots = [];
    this.firstShotSeenFor.clear();
    this.visibleAt.clear();
    this.kills = 0;
    this.score = 0;
  }

  /** Notify the recorder a target became visible, so the first shot fired at it can compute `timeToTargetMs`. */
  noteTargetVisible(targetId: string, t: number): void {
    if (!this.visibleAt.has(targetId)) this.visibleAt.set(targetId, t);
  }

  recordKill(): void {
    this.kills++;
  }

  addScore(points: number): void {
    this.score += points;
  }

  /** Call every frame with the current aim state. `t` is ms since session start. */
  sampleAim(t: number, yaw: number, pitch: number, dx: number, dy: number, gain: number): void {
    const sample: AimSample = { t, yaw, pitch, dx, dy, gain };
    this.history.push(sample);
    this.ring.push(sample);
    const cutoff = t - RING_WINDOW_MS;
    // Ring is append-only and time-ordered, so trimming from the front is
    // amortized O(1) per call in practice; only pays for itself when the
    // buffer is actually over-window.
    let i = 0;
    while (i < this.ring.length && this.ring[i].t < cutoff) i++;
    if (i > 0) this.ring.splice(0, i);
  }

  /** Call every frame with whether the crosshair is currently inside the aimed-at target's body capsule. */
  sampleOnTarget(t: number, onTarget: boolean): void {
    this.onTargetSamples.push({ t, onTarget });
  }

  /**
   * Records a fired round. `input` carries the facts only the sim/hit-scan
   * layer knows (hit/zone/distance/spread/recoil/...); this derives the
   * movement-quality fields from the aim ring buffer.
   */
  recordShot(input: ShotInput): ShotEvent {
    const shotSample = this.latestSampleAtOrBefore(input.t);
    let overshootDeg = 0;
    let microCorrections = 0;
    let pathLengthDeg = 0;
    let directAngleDeg = 0;
    let peakAngularVelDeg = 0;

    if (shotSample) {
      // Reconstruct the target's angular position from the crosshair-to-target
      // error at fire time. Sign convention matches `ShotEvent.errorYawDeg`
      // ("+ = crosshair right of target"): with +yaw = turning left (see
      // math.ts), "crosshair right of target" means crosshairYaw < targetYaw,
      // so errorYawDeg = targetYaw - crosshairYaw, i.e. targetYaw =
      // crosshairYaw + errorYawDeg. `errorPitchDeg` is not separately
      // documented in types.ts; we mirror the same target-minus-crosshair
      // convention for consistency (+ = target above crosshair).
      const target = {
        yaw: shotSample.yaw + input.errorYawDeg,
        pitch: shotSample.pitch + input.errorPitchDeg,
      };
      const m = computeApproachMetrics(this.ring, input.t, target);
      overshootDeg = m.overshootDeg;
      microCorrections = m.microCorrections;
      pathLengthDeg = m.pathLengthDeg;
      directAngleDeg = m.directAngleDeg;
      peakAngularVelDeg = m.peakAngularVelDeg;
    }

    let timeToTargetMs: number | null = null;
    if (input.targetId !== null && !this.firstShotSeenFor.has(input.targetId)) {
      const visAt = this.visibleAt.get(input.targetId);
      if (visAt !== undefined) timeToTargetMs = input.t - visAt;
    }
    if (input.targetId !== null) this.firstShotSeenFor.add(input.targetId);

    const shot: ShotEvent = {
      ...input,
      overshootDeg,
      microCorrections,
      pathLengthDeg,
      directAngleDeg,
      peakAngularVelDeg,
      timeToTargetMs,
    };
    this.shots.push(shot);
    return shot;
  }

  private latestSampleAtOrBefore(t: number): AimSample | null {
    let best: AimSample | null = null;
    for (let i = this.ring.length - 1; i >= 0; i--) {
      if (this.ring[i].t <= t) {
        best = this.ring[i];
        break;
      }
    }
    return best;
  }

  summarise(): SessionSummary {
    const shots = this.shots.length;
    const hits = this.shots.filter((s) => s.hit).length;
    const headshots = this.shots.filter((s) => s.hit && s.zone === 'head').length;
    const ttts = this.shots.map((s) => s.timeToTargetMs).filter((x): x is number => x !== null);
    const errorAngles = this.shots.map((s) => s.errorAngleDeg);
    const pathRatios = this.shots
      .filter((s) => s.directAngleDeg > 1e-3)
      .map((s) => s.pathLengthDeg / s.directAngleDeg);

    const onTargetCount = this.onTargetSamples.filter((s) => s.onTarget).length;

    return {
      shots,
      hits,
      accuracy: shots > 0 ? hits / shots : 0,
      headshots,
      // Fraction of *hits* that were headshots (standard "HS%" convention),
      // not fraction of shots fired.
      headshotRate: hits > 0 ? headshots / hits : 0,
      kills: this.kills,
      score: this.score,
      avgTimeToTargetMs: ttts.length > 0 ? mean(ttts) : 0,
      avgErrorDeg: mean(errorAngles),
      overshootBias: mean(this.shots.map((s) => s.overshootDeg)),
      avgMicroCorrections: mean(this.shots.map((s) => s.microCorrections)),
      pathEfficiency: pathRatios.length > 0 ? mean(pathRatios) : 1,
      trackingAccuracy: this.onTargetSamples.length > 0 ? onTargetCount / this.onTargetSamples.length : 0,
      errorConsistency: stdDev(errorAngles),
    };
  }

  endSession(): SessionRecord {
    if (!this.sens) throw new Error('SessionRecorder.endSession called before beginSession');
    const endedAtWall = Date.now();
    const summary = this.summarise();
    const samples = downsampleSamples(this.history, this.shots);
    const dpi = this.sens.dpi;
    const sensitivity = this.sens.sensitivity;
    // See constants.ts: degrees = counts * 0.07 * sensitivity, and the
    // standard cm/360 + eDPI derivations from that.
    const DEG_PER_COUNT = 0.07;
    const CM_PER_INCH = 2.54;
    const eDPI = dpi * sensitivity;
    const cm360 = 360 / (DEG_PER_COUNT * sensitivity * dpi) * CM_PER_INCH;

    return {
      id: makeId('ses'),
      startedAt: this.startedAtWall,
      endedAt: endedAtWall,
      scenarioId: this.scenarioId,
      weaponId: this.weaponId,
      sens: this.sens,
      eDPI,
      cm360,
      rawAccelEnabled: this.sens.rawAccelEnabled,
      summary,
      shots: [...this.shots],
      samples,
    };
  }
}

/**
 * Downsamples the full-rate aim history for storage: keep full rate within
 * `SHOT_FULL_RATE_WINDOW_MS` of any shot (that's the data the movement
 * metrics above actually needed and the data a UI replay wants to be
 * smooth), and thin everything else to ~30Hz. A 60s session captured at
 * 250Hz (see `constants.AIM_SAMPLE_HZ`) is ~15k raw samples — storing every
 * one as a full object would make IndexedDB rows an order of magnitude
 * larger than necessary for a signal that's mostly redundant between shots.
 */
function downsampleSamples(history: AimSample[], shots: ShotEvent[]): AimSample[] {
  if (history.length === 0) return [];
  const shotTimes = shots.map((s) => s.t).sort((a, b) => a - b);

  const out: AimSample[] = [];
  let lastKeptThinT = -Infinity;
  let shotPtr = 0;
  for (const s of history) {
    // Advance the shot pointer so it never points at a shot more than the
    // window behind the current sample (shots and history are both time-sorted).
    while (shotPtr < shotTimes.length - 1 && shotTimes[shotPtr] < s.t - SHOT_FULL_RATE_WINDOW_MS) shotPtr++;
    const near =
      (shotPtr < shotTimes.length && Math.abs(s.t - shotTimes[shotPtr]) <= SHOT_FULL_RATE_WINDOW_MS) ||
      (shotPtr + 1 < shotTimes.length && Math.abs(s.t - shotTimes[shotPtr + 1]) <= SHOT_FULL_RATE_WINDOW_MS);

    if (near) {
      out.push(s);
    } else if (s.t - lastKeptThinT >= THIN_INTERVAL_MS) {
      out.push(s);
      lastKeptThinT = s.t;
    }
  }
  return out;
}

/** Exported for tests / tooling that want to reason about the derivation without a full recorder session. */
export const _internal = { computeApproachMetrics, countMicroCorrections, downsampleSamples };
