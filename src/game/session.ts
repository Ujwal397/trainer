/**
 * Per-run orchestration: input -> aim -> movement -> firing -> hit resolution
 * -> telemetry -> presentation.
 *
 * The ordering here is deliberate and load-bearing for measurement quality;
 * the comments at each step say why.
 */
import type {
  ScenarioDef, SensConfig, SessionRecord, TargetState, Vec3, WeaponSpec,
} from '../core/types';
import { EYE_HEIGHT_M, CROUCH_EYE_HEIGHT_M, RUN_SPEED_MS } from '../core/constants';
import { anglesToDir, angleBetween, angleDelta, dirToAngles, normalize, sub } from '../core/math';
import { AimController } from '../core/sensitivity';
import { MoveState, movementInaccuracyFactor, resolveCollision, type AABB, type MoveInput } from '../core/movement';
import { WeaponState, applyRecoilAndSpread } from '../core/ballistics';
import { resolveDamage } from '../core/damage';
import { headCentre, raycastTarget, transformHitbox } from '../core/hitbox';
import { ScenarioRuntime, type RuntimeEnv } from '../core/scenarios/runtime';
import { SessionRecorder } from '../core/telemetry';
import { Rng } from '../core/rng';
import type { Renderer } from '../render/renderer';
import type { TargetPool } from '../render/targets';
import type { Hud } from '../render/hud';
import type { Crosshair } from '../render/crosshair';
import type { RawInput } from '../input/pointerlock';

export interface SessionDeps {
  scenario: ScenarioDef;
  weapon: WeaponSpec;
  sens: SensConfig;
  env: RuntimeEnv & { colliders: readonly AABB[] };
  renderer: Renderer;
  targets: TargetPool;
  hud: Hud;
  crosshair: Crosshair;
  input: RawInput;
  seed?: number;
  /** Practice mode: magazine never empties, reloads unnecessary. */
  infiniteAmmo?: boolean;
}

/** Scratch objects reused every step — the hot path must not allocate. */
const scratchMove: MoveInput = { wishX: 0, wishZ: 0, jumpPressed: false, crouch: false };
const scratchEye: Vec3 = { x: 0, y: 0, z: 0 };

export class TrainingSession {
  readonly recorder = new SessionRecorder();
  readonly runtime: ScenarioRuntime;

  private readonly d: SessionDeps;
  private readonly aim = new AimController();
  private readonly move: MoveState;
  private readonly weapon: WeaponState;
  private readonly rng: Rng;
  private readonly unsubscribe: Array<() => void> = [];

  private elapsedMs = 0;
  private streak = 0;
  private finished = false;
  private jumpQueued = false;
  /**
   * Gain from the most recent mouse step. Stamped onto each shot so the
   * acceleration analysis knows how hard the driver was accelerating at the
   * moment of the shot — with RawAccel active this is the difference between
   * blaming the curve and blaming the base sensitivity.
   */
  private lastEffectiveGain = 1;
  private shotsFired = 0;
  private hitsLanded = 0;
  /** Targets we have already told the recorder became visible. */
  private readonly notedVisible = new Set<string>();
  /** Targets already shot at once, so time-to-target is only the first shot. */
  private readonly engaged = new Set<string>();

  constructor(deps: SessionDeps) {
    this.d = deps;
    this.rng = new Rng(deps.seed);
    this.runtime = new ScenarioRuntime(deps.scenario, deps.env, this.rng);
    this.move = new MoveState({ ...deps.env.playerSpawn });
    this.weapon = new WeaponState(deps.weapon);
    this.weapon.infiniteAmmo = deps.infiniteAmmo ?? true;

    this.unsubscribe.push(deps.input.onDelta((delta) => this.onMouse(delta)));
    this.unsubscribe.push(deps.input.onButtonDown((b) => { if (b === 0) this.tryFire(); }));
    this.unsubscribe.push(deps.input.onButtonUp((b) => { if (b === 0) this.weapon.releaseTrigger(); }));
    this.unsubscribe.push(deps.input.onButtonDown((b) => { if (b === 1 || b === 2) this.weapon.startScope(); }));
    this.unsubscribe.push(deps.input.onButtonUp((b) => { if (b === 1 || b === 2) this.weapon.stopScope(); }));
    this.unsubscribe.push(deps.input.onKeyDown((k) => {
      if (k === 'r') this.weapon.reload(this.elapsedMs);
      if (k === 'space') this.jumpQueued = true;
    }));
  }

  start(): void {
    this.recorder.beginSession(this.d.scenario.id, this.d.weapon.id, this.d.sens);
    this.weapon.equip(0);
    this.runtime.start(0);
    this.aim.reset(0, 0);
  }

  get isFinished(): boolean { return this.finished; }
  /** Live run state for the pause overlay. Cheap enough to call on demand. */
  get stats(): { score: number; remainingSec: number; accuracy: number; shots: number } {
    return {
      score: this.runtime.score,
      remainingSec: this.remainingSec,
      accuracy: this.shotsFired > 0 ? this.hitsLanded / this.shotsFired : 0,
      shots: this.shotsFired,
    };
  }

  /** Current view angles, degrees. */
  get orientation(): { yaw: number; pitch: number } { return { yaw: this.aim.yaw, pitch: this.aim.pitch }; }
  /** Points the view directly, bypassing the mouse pipeline. Used to recentre
   *  between runs and to drive the aim path deterministically under test. */
  setAim(yaw: number, pitch: number): void { this.aim.reset(yaw, pitch); }
  get remainingSec(): number { return Math.max(0, this.d.scenario.durationSec - this.elapsedMs / 1000); }

  /** Current eye position, written into a scratch vector. */
  private eye(): Vec3 {
    scratchEye.x = this.move.position.x;
    scratchEye.y = this.move.position.y + (this.move.crouching ? CROUCH_EYE_HEIGHT_M.value : EYE_HEIGHT_M.value);
    scratchEye.z = this.move.position.z;
    return scratchEye;
  }

  /**
   * Mouse handling runs on the input event, NOT on the fixed step: at 1000Hz
   * polling there are several counts per step, and collapsing them would throw
   * away exactly the sub-step path the analyser reconstructs approaches from.
   */
  private onMouse(delta: Parameters<Parameters<RawInput['onDelta']>[0]>[0]): void {
    if (this.finished) return;
    const step = this.aim.applyDelta(
      delta,
      this.d.sens,
      this.weapon.scoped,
      this.d.weapon.ads?.sensMultiplier ?? 1,
    );
    // effectiveGain already accounts for driver-level RawAccel; nothing here
    // re-applies a curve (see sensitivity.ts).
    this.lastEffectiveGain = step.effectiveGain;
    this.recorder.sampleAim(this.elapsedMs, this.aim.yaw, this.aim.pitch, delta.dx, delta.dy, step.effectiveGain);
  }

  fixedStep(dtSec: number): void {
    if (this.finished) return;
    this.elapsedMs += dtSec * 1000;

    const input = this.d.input;
    scratchMove.wishX = (input.isKeyDown('d') ? 1 : 0) - (input.isKeyDown('a') ? 1 : 0);
    scratchMove.wishZ = (input.isKeyDown('w') ? 1 : 0) - (input.isKeyDown('s') ? 1 : 0);
    scratchMove.crouch = input.isKeyDown('ctrl');
    scratchMove.jumpPressed = this.jumpQueued;
    this.jumpQueued = false;

    if (this.d.scenario.playerMovement) {
      // Movement is expressed relative to where the player is looking, so W is
      // always "forward" from the camera rather than a fixed world axis.
      const yawRad = (this.aim.yaw * Math.PI) / 180;
      const fx = -Math.sin(yawRad);
      const fz = -Math.cos(yawRad);
      const rx = -fz;
      const rz = fx;
      const wx = scratchMove.wishX * rx + scratchMove.wishZ * fx;
      const wz = scratchMove.wishX * rz + scratchMove.wishZ * fz;
      scratchMove.wishX = wx;
      scratchMove.wishZ = wz;

      const cap = input.isKeyDown('shift') ? RUN_SPEED_MS.value * 0.5 : this.d.weapon.moveSpeed;
      this.move.step(scratchMove, dtSec, cap);
      const resolved = resolveCollision(this.move.position, this.move.velocity, 0.4, this.d.env.colliders);
      this.move.position = resolved.position;
      this.move.velocity = resolved.velocity;
    }

    const eye = this.eye();
    this.runtime.update(this.elapsedMs, dtSec, eye);

    // Latch visibility into telemetry the first time each target is seen.
    for (const t of this.runtime.targets) {
      if (t.visibleAt !== null && !this.notedVisible.has(t.id)) {
        this.notedVisible.add(t.id);
        this.recorder.noteTargetVisible(t.id, t.visibleAt);
      }
    }

    const factor = movementInaccuracyFactor(this.move.speed(), this.move.grounded, this.move.crouching);
    this.weapon.update(this.elapsedMs, factor, this.move.crouching);

    // Auto fire is polled on the step; semi/burst gating lives in WeaponState.
    if (this.d.weapon.fireMode === 'auto' && input.isButtonDown(0)) this.tryFire();

    this.recorder.sampleOnTarget(this.elapsedMs, this.crosshairOnTarget(eye));

    if (this.elapsedMs >= this.d.scenario.durationSec * 1000) this.finish();
  }

  /** Target whose head centre is nearest in angle to the crosshair. */
  private intendedTarget(eye: Vec3, aimDir: Vec3): { target: TargetState; capsules: ReturnType<typeof transformHitbox>; angle: number } | null {
    let best: { target: TargetState; capsules: ReturnType<typeof transformHitbox>; angle: number } | null = null;
    for (const t of this.runtime.targets) {
      if (!t.alive) continue;
      const capsules = transformHitbox(t.hitbox, t.position, t.yaw, t.crouching);
      const angle = angleBetween(aimDir, sub(headCentre(capsules), eye));
      if (!best || angle < best.angle) best = { target: t, capsules, angle };
    }
    return best;
  }

  private crosshairOnTarget(eye: Vec3): boolean {
    const dir = anglesToDir(this.aim.yaw, this.aim.pitch);
    for (const t of this.runtime.targets) {
      if (!t.alive) continue;
      const capsules = transformHitbox(t.hitbox, t.position, t.yaw, t.crouching);
      const hit = raycastTarget(eye, dir, t.id, capsules);
      if (hit && hit.zone !== 'leg') return true;
    }
    return false;
  }

  private tryFire(): void {
    if (this.finished || !this.weapon.canFire(this.elapsedMs)) return;

    const eye = this.eye();
    // The CROSSHAIR direction — before spread and recoil. Aim error must be
    // measured against this, because the analyser is scoring the human's aim,
    // not the gun's dispersion. Measuring from the bullet would fold random
    // spread into the error signal and corrupt every recommendation.
    const aimDir = anglesToDir(this.aim.yaw, this.aim.pitch);
    const intended = this.intendedTarget(eye, aimDir);

    const result = this.weapon.fire(this.elapsedMs, this.rng);
    if (!result) return;

    const bulletDir = applyRecoilAndSpread(aimDir, result.recoil, result.spreadOffset);

    // Resolve the bullet against every target; nearest hit wins.
    let hit: ReturnType<typeof raycastTarget> = null;
    let hitTarget: TargetState | null = null;
    for (const t of this.runtime.targets) {
      if (!t.alive) continue;
      const capsules = transformHitbox(t.hitbox, t.position, t.yaw, t.crouching);
      const h = raycastTarget(eye, bulletDir, t.id, capsules);
      if (h && (!hit || h.distanceM < hit.distanceM)) { hit = h; hitTarget = t; }
    }

    this.shotsFired++;
    if (hit) this.hitsLanded++;

    let killed = false;
    let scoreDelta = 0;
    const scoring = this.d.scenario.scoring;

    if (hit && hitTarget) {
      const dmg = resolveDamage(this.d.weapon, hit.zone, hit.distanceM);
      const outcome = this.runtime.damage(hitTarget.id, dmg);
      killed = outcome.killed;

      const zoneMultiplier = hit.zone === 'head' ? scoring.headshotBonus : 1;
      scoreDelta += outcome.applied * scoring.damagePoints * zoneMultiplier;
      if (killed) {
        scoreDelta += scoring.killPoints;
        this.recorder.recordKill();
        this.streak++;
        // Time penalty: seconds the target survived past the moment it became
        // visible, so dawdling costs points even on a hit.
        const aliveSec = hitTarget.visibleAt !== null ? (this.elapsedMs - hitTarget.visibleAt) / 1000 : 0;
        scoreDelta -= aliveSec * scoring.timePenalty;
      }
      this.d.targets.flashHit(hitTarget.id, hit.zone);
      this.d.targets.spawnHitMarker(hit.point, hit.zone);
      this.d.hud.showHitFeedback(true, hit.zone);
    } else {
      scoreDelta -= scoring.missPenalty;
      this.streak = 0;
      this.d.hud.showHitFeedback(false);
    }

    // Error angle is always measured to the INTENDED target, hit or miss —
    // that is what makes a miss informative rather than just absent.
    let errorAngle = 0;
    let errorYaw = 0;
    let errorPitch = 0;
    let distanceM = 0;
    if (intended) {
      const toTarget = sub(headCentre(intended.capsules), eye);
      distanceM = Math.hypot(toTarget.x, toTarget.y, toTarget.z);
      errorAngle = intended.angle;
      const ta = dirToAngles(normalize(toTarget));
      errorYaw = angleDelta(this.aim.yaw, ta.x);
      errorPitch = angleDelta(this.aim.pitch, ta.y);
    }

    const targetId = intended?.target.id ?? null;
    const firstShotAtTarget = targetId !== null && !this.engaged.has(targetId);
    if (targetId !== null) this.engaged.add(targetId);

    this.recorder.recordShot({
      t: this.elapsedMs,
      weaponId: this.d.weapon.id,
      shotIndexInBurst: this.weapon.shotIndex,
      hit: hit !== null,
      zone: hit?.zone ?? null,
      // Report the target we aimed at when it is the first shot at it, so
      // time-to-target is attributed correctly; otherwise the one we struck.
      targetId: firstShotAtTarget ? targetId : (hitTarget?.id ?? targetId),
      distanceM,
      errorAngleDeg: errorAngle,
      errorYawDeg: errorYaw,
      errorPitchDeg: errorPitch,
      spreadDeg: result.spreadDeg,
      recoilYawDeg: result.recoil.x,
      recoilPitchDeg: result.recoil.y,
      playerSpeed: this.move.speed(),
      effectiveGain: this.lastEffectiveGain,
    });

    this.runtime.score += scoreDelta;
    this.recorder.addScore(scoreDelta);
  }

  render(alpha: number): void {
    const eye = this.eye();
    this.d.renderer.setCameraOrientation(this.aim.yaw, this.aim.pitch, eye);
    this.d.targets.sync(this.runtime.targets, alpha);

    this.d.hud.setAmmo(
      this.weapon.ammo,
      this.weapon.infiniteAmmo ? Infinity : this.weapon.reserve,
    );
    this.d.hud.setTimer(this.remainingSec);
    this.d.hud.setScore(Math.round(this.runtime.score));
    this.d.hud.setStreak(this.streak);
    const stats = this.d.renderer.frameStats;
    this.d.hud.setFrameStats(stats.fps, stats.frameTimeMs);
    // Crosshair error is expressed in pixels: convert the spread half-angle
    // using the vertical FOV so it matches what the shot can actually do.
    this.d.crosshair.setError(this.weapon.currentSpread * 12);

    this.d.renderer.render(alpha);
  }

  finish(): SessionRecord {
    if (this.finished) return this.recorder.endSession();
    this.finished = true;
    return this.recorder.endSession();
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.runtime.dispose();
  }
}
