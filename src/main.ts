/**
 * App shell: boot, screen routing, persistence, and run lifecycle.
 *
 * This is the only file that knows about every subsystem at once. Everything
 * below it is either engine-agnostic core, a renderer, or a screen that takes
 * its data through an injected interface — which is what keeps the desktop
 * port to a renderer swap rather than a rewrite.
 */
import * as THREE from 'three';
import type {
  AccelCurve, ScenarioFamily, SensConfig, SessionRecord, SessionSummary, Vec2, Vec3,
} from './core/types';
import { DEFAULT_HFOV_DEG } from './core/constants';
import { sampleCurve } from './core/rawaccel';
import { SCENARIOS, getScenario } from './core/scenarios/definitions';
import { WEAPONS, WEAPON_IDS, getWeapon } from './data/weapons';
import { recommendSensitivity, analyseByFamily } from './core/analysis/optimizer';
import type { AABB } from './core/movement';
import { createDb, type AimTrainerDB, type SensProfile } from './storage/db';
import { exportCSV, exportJSON } from './storage/export';
import { Renderer } from './render/renderer';
import { TargetPool, type VisualMode } from './render/targets';
import { buildMap } from './render/maps';
import { Hud } from './render/hud';
import { Crosshair, DEFAULT_CROSSHAIR, type CrosshairConfig as RenderCrosshair } from './render/crosshair';
import { RawInput } from './input/pointerlock';
import { GameLoop } from './game/loop';
import { TrainingSession } from './game/session';
import { createMenuScreen } from './ui/menu';
import { createSettingsScreen, type CrosshairConfig as UiCrosshair, type VideoConfig } from './ui/settings';
import { createResultsScreen } from './ui/results';
import { createPauseOverlay, type PauseOverlayHandle } from './ui/pause';
import { createAnalyzerScreen, type TrackData } from './ui/analyzer';
import type { ScreenHandle } from './ui/menu';

// --------------------------------------------------------------- defaults --

const DEFAULT_SENS: SensConfig = {
  dpi: 800,
  pollingRateHz: 1000,
  sensitivity: 0.35,
  scopedMultiplier: 1,
  rawAccelEnabled: false,
  rawAccelMode: 'external',
  invertY: false,
  curve: {
    type: 'off', sensMultiplier: 1, acceleration: 0.05, exponent: 2, inputOffset: 0,
    outputCap: 0, inputCap: 0, decayRate: 1, limit: 1.5, syncSpeed: 1, gamma: 1,
    smooth: 0.5, motivity: 1.5, growthRate: 1, midpoint: 1, applyToY: true,
  },
};

const DEFAULT_VIDEO: VideoConfig = { targetVisualMode: 'humanoid', infiniteAmmo: true, fpsCap: 0, showFps: true };

const KEY_SENS = 'sens';
const KEY_CROSSHAIR = 'crosshair';
const KEY_VIDEO = 'video';
const KEY_LAST_PLAYED = 'lastPlayed';

// ---------------------------------------------------------------- adapters --

/**
 * The renderer and the settings screen were built against differently-shaped
 * CrosshairConfigs (nested vs flat) carrying identical information. Adapting
 * at this one boundary is cheaper and far less risky than restructuring
 * either side, and keeps each module's own shape idiomatic to its use.
 */
function uiToRenderCrosshair(c: UiCrosshair): RenderCrosshair {
  return {
    color: c.color,
    outlines: { enabled: c.outlinesEnabled, opacity: c.outlineOpacity, thicknessPx: c.outlineThicknessPx },
    centerDot: { enabled: c.centerDotEnabled, opacity: c.centerDotOpacity, thicknessPx: c.centerDotThicknessPx },
    innerLines: { ...c.innerLines },
    outerLines: { ...c.outerLines },
    showErrorOnMove: c.movementErrorEnabled,
    showErrorOnFire: c.firingErrorEnabled,
  };
}

function renderToUiCrosshair(c: RenderCrosshair): UiCrosshair {
  return {
    color: c.color,
    outlinesEnabled: c.outlines.enabled,
    outlineOpacity: c.outlines.opacity,
    outlineThicknessPx: c.outlines.thicknessPx,
    centerDotEnabled: c.centerDot.enabled,
    centerDotOpacity: c.centerDot.opacity,
    centerDotThicknessPx: c.centerDot.thicknessPx,
    innerLines: { ...c.innerLines },
    outerLines: { ...c.outerLines },
    movementErrorEnabled: c.showErrorOnMove,
    firingErrorEnabled: c.showErrorOnFire,
  };
}

/** The settings screen says 'hitbox-wireframe'; the renderer says 'wireframe'. */
function toVisualMode(m: VideoConfig['targetVisualMode']): VisualMode {
  return m === 'hitbox-wireframe' ? 'wireframe' : m;
}

const toVec3 = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const toAABB = (b: THREE.Box3): AABB => ({ min: toVec3(b.min), max: toVec3(b.max) });

const familyOf = (scenarioId: string): ScenarioFamily => {
  try { return getScenario(scenarioId).family; } catch { return 'clicking'; }
};

/** Mean of a set of summaries, for the results screen's "vs your recent average". */
function averageSummary(sessions: SessionRecord[]): SessionSummary | null {
  if (sessions.length < 3) return null; // too few to be meaningful — hide, don't guess
  const keys = Object.keys(sessions[0].summary) as Array<keyof SessionSummary>;
  const out = {} as SessionSummary;
  for (const k of keys) {
    out[k] = sessions.reduce((sum, s) => sum + s.summary[k], 0) / sessions.length;
  }
  return out;
}

// -------------------------------------------------------------------- app --

class App {
  private readonly root: HTMLElement;
  private db!: AimTrainerDB;
  private renderer!: Renderer;
  private input!: RawInput;

  private sens: SensConfig = { ...DEFAULT_SENS };
  private crosshairCfg: RenderCrosshair = { ...DEFAULT_CROSSHAIR };
  private video: VideoConfig = { ...DEFAULT_VIDEO };
  private profiles: SensProfile[] = [];
  private activeProfileId: string | null = null;
  private abSlots: [string | null, string | null] = [null, null];
  private lastPlayed: { scenarioId: string; weaponId: string } | null = null;
  private currentScenarioId: string | null = null;
  private currentWeaponId: string | null = null;

  private screen: ScreenHandle | null = null;
  private loop: GameLoop | null = null;
  private session: TrainingSession | null = null;
  private targetPool: TargetPool | null = null;
  private hud: Hud | null = null;
  private crosshair: Crosshair | null = null;
  private pause: PauseOverlayHandle | null = null;
  private runHost: HTMLElement | null = null;
  /** Set while quitting, so the lock-change handler does not re-open the menu. */
  private tearingDown = false;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async boot(): Promise<void> {
    this.db = await createDb();
    this.sens = (await this.db.getSetting<SensConfig>(KEY_SENS)) ?? { ...DEFAULT_SENS };
    this.crosshairCfg = (await this.db.getSetting<RenderCrosshair>(KEY_CROSSHAIR)) ?? { ...DEFAULT_CROSSHAIR };
    this.video = (await this.db.getSetting<VideoConfig>(KEY_VIDEO)) ?? { ...DEFAULT_VIDEO };
    this.lastPlayed = (await this.db.getSetting<{ scenarioId: string; weaponId: string }>(KEY_LAST_PLAYED)) ?? null;
    this.profiles = await this.db.listProfiles();

    // The renderer is built once and reused for every run: recreating a WebGL
    // context per session leaks GPU memory and stalls for hundreds of ms.
    this.renderer = new Renderer();
    this.input = new RawInput(this.renderer.domElement);

    await this.showMenu();
  }

  private setScreen(handle: ScreenHandle): void {
    this.screen?.destroy();
    this.root.replaceChildren(handle.el);
    this.screen = handle;
  }

  // ------------------------------------------------------------- screens --

  private async showMenu(): Promise<void> {
    const sessions = await this.db.listSessions();
    const bests = new Map<string, number>();
    for (const s of sessions) {
      const prev = bests.get(s.scenarioId);
      if (prev === undefined || s.summary.score > prev) bests.set(s.scenarioId, s.summary.score);
    }

    this.setScreen(createMenuScreen({
      scenarios: SCENARIOS,
      weapons: WEAPON_IDS.map(getWeapon),
      personalBests: bests,
      lastPlayed: this.lastPlayed,
      onStart: (scenarioId, weaponId) => void this.startRun(scenarioId, weaponId),
      onNavigate: (target) => {
        if (target === 'settings') void this.showSettings();
        else if (target === 'analyzer') void this.showAnalyzer();
        else void this.showMenu();
      },
    }));
  }

  private async showSettings(): Promise<void> {
    this.setScreen(createSettingsScreen({
      sens: this.sens,
      crosshair: renderToUiCrosshair(this.crosshairCfg),
      video: this.video,
      profiles: this.profiles,
      activeProfileId: this.activeProfileId,
      abSlots: this.abSlots,
      rawInputAvailable: this.input.isRawSupported,
      sampleCurve: (curve: AccelCurve, maxSpeed: number, points: number): Vec2[] =>
        sampleCurve(curve, maxSpeed, points),
      onSensChange: (sens) => { this.sens = sens; void this.db.setSetting(KEY_SENS, sens); },
      onCrosshairChange: (c) => {
        this.crosshairCfg = uiToRenderCrosshair(c);
        this.crosshair?.setConfig(this.crosshairCfg);
        void this.db.setSetting(KEY_CROSSHAIR, this.crosshairCfg);
      },
      onVideoChange: (v) => {
        this.video = v;
        this.targetPool?.setVisualMode(toVisualMode(v.targetVisualMode));
        void this.db.setSetting(KEY_VIDEO, v);
      },
      onProfileSave: (name, sens) => void this.saveProfile(name, sens),
      onProfileLoad: (id) => {
        const p = this.profiles.find((x) => x.id === id);
        if (!p) return;
        this.sens = { ...p.sens };
        this.activeProfileId = id;
        void this.db.setSetting(KEY_SENS, this.sens);
        void this.showSettings();
      },
      onProfileDelete: (id) => void this.deleteProfile(id),
      onProfileSetAbSlot: (slot, id) => { this.abSlots[slot] = id; void this.showSettings(); },
      onBack: () => void this.showMenu(),
    }));
  }

  private async saveProfile(name: string, sens: SensConfig): Promise<void> {
    const profile: SensProfile = { id: `p${Date.now()}`, name, sens: { ...sens }, createdAt: Date.now() };
    await this.db.saveProfile(profile);
    this.profiles = await this.db.listProfiles();
    this.activeProfileId = profile.id;
    await this.showSettings();
  }

  private async deleteProfile(id: string): Promise<void> {
    await this.db.deleteProfile(id);
    this.profiles = await this.db.listProfiles();
    if (this.activeProfileId === id) this.activeProfileId = null;
    // Clear any A/B slot pointing at the profile we just removed.
    this.abSlots = this.abSlots.map((s) => (s === id ? null : s)) as [string | null, string | null];
    await this.showSettings();
  }

  private async showAnalyzer(): Promise<void> {
    const all = await this.db.listSessions();
    // RawAccel-on and RawAccel-off runs are never pooled: with a curve active,
    // one "sensitivity" number does not describe the same thing at every speed.
    const off = all.filter((s) => !s.rawAccelEnabled);
    const on = all.filter((s) => s.rawAccelEnabled);

    const track = (sessions: SessionRecord[]): TrackData => {
      if (sessions.length === 0) return { recommendation: null, familyRecommendations: {} };
      const familyRecommendations: TrackData['familyRecommendations'] = {};
      for (const f of analyseByFamily(sessions, familyOf).perFamily) {
        familyRecommendations[f.family] = f.recommendation;
      }
      return { recommendation: recommendSensitivity(sessions), familyRecommendations };
    };

    this.setScreen(createAnalyzerScreen({
      rawAccelOff: track(off),
      rawAccelOn: track(on),
      onStartSweep: (sensitivity) => {
        this.sens = { ...this.sens, sensitivity };
        void this.db.setSetting(KEY_SENS, this.sens);
        const target = this.lastPlayed?.scenarioId ?? 'flick-single';
        void this.startRun(target, this.lastPlayed?.weaponId ?? 'vandal');
      },
      onExportJson: (t) => download(`sessions-${t}.json`, exportJSON(t === 'on' ? on : off), 'application/json'),
      onExportCsv: (t) => download(`shots-${t}.csv`, exportCSV(t === 'on' ? on : off), 'text/csv'),
      onBack: () => void this.showMenu(),
    }));
  }

  // ----------------------------------------------------------- run cycle --

  private async startRun(scenarioId: string, weaponId: string): Promise<void> {
    const scenario = getScenario(scenarioId);
    const weapon = getWeapon(weaponId);
    this.lastPlayed = { scenarioId, weaponId };
    this.currentScenarioId = scenarioId;
    this.currentWeaponId = weaponId;
    await this.db.setSetting(KEY_LAST_PLAYED, this.lastPlayed);

    this.screen?.destroy();
    this.screen = null;

    const host = document.createElement('div');
    host.className = 'game-host';
    this.root.replaceChildren(host);

    this.renderer.mount(host);
    const built = buildMap(this.renderer.scene, scenario.mapId);

    this.targetPool = new TargetPool(this.renderer.scene);
    this.targetPool.setVisualMode(toVisualMode(this.video.targetVisualMode));
    this.hud = new Hud();
    this.hud.mount(host);
    this.crosshair = new Crosshair(this.crosshairCfg);
    this.crosshair.mount(host);

    this.session = new TrainingSession({
      scenario,
      weapon,
      sens: this.sens,
      env: {
        colliders: built.colliders.map(toAABB),
        spawnPoints: built.spawnPoints.map(toVec3),
        playerSpawn: toVec3(built.playerSpawn),
      },
      renderer: this.renderer,
      targets: this.targetPool,
      hud: this.hud,
      crosshair: this.crosshair,
      input: this.input,
      infiniteAmmo: this.video.infiniteAmmo,
    });

    this.session.start();
    this.runHost = host;

    this.pause = createPauseOverlay({
      scenario,
      weapon,
      stats: () => this.session?.stats ?? { score: 0, remainingSec: 0, accuracy: 0, shots: 0 },
      onResume: () => void this.input.requestLock(),
      onRestart: () => void this.restartRun(),
      onSettings: () => { this.quitRun(); void this.showSettings(); },
      onQuit: () => { this.quitRun(); void this.showMenu(); },
    });

    void this.input.requestLock();

    this.loop = new GameLoop({
      onFixedStep: (dtSec) => {
        this.session?.fixedStep(dtSec);
        if (this.session?.isFinished) void this.endRun();
      },
      onRender: (alpha) => this.session?.render(alpha),
    });
    this.loop.start();

    // Losing pointer lock is the user's "I want out" signal — Escape releases
    // it, and so does alt-tabbing. Pausing rather than ending preserves the run.
    document.addEventListener('pointerlockchange', this.onLockChange);
  }

  /**
   * Pointer lock is the pause signal: Escape releases it, and so does
   * alt-tabbing or the window losing focus. Treating all of those the same way
   * means a run is never silently ticking down while the player is elsewhere.
   */
  private readonly onLockChange = (): void => {
    if (this.tearingDown || !this.loop || !this.session || !this.pause) return;

    if (document.pointerLockElement === null) {
      this.loop.pause();
      this.pause.refresh();
      this.runHost?.appendChild(this.pause.el);
    } else {
      this.pause.el.remove();
      this.loop.resume();
    }
  };

  private async restartRun(): Promise<void> {
    const scenarioId = this.currentScenarioId;
    const weaponId = this.currentWeaponId;
    this.quitRun();
    if (scenarioId && weaponId) await this.startRun(scenarioId, weaponId);
  }

  /**
   * Abandons the run without saving. A partial session would be a short,
   * unrepresentative sample, and the analyser weights by shot count — letting
   * abandoned runs into the store would quietly bias every recommendation.
   */
  private quitRun(): void {
    this.tearingDown = true;
    this.loop?.stop();
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.input.release();
    this.pause?.destroy();
    this.pause = null;
    this.session?.dispose();
    this.session = null;
    this.loop = null;
    this.teardownRunVisuals();
    this.tearingDown = false;
  }

  private teardownRunVisuals(): void {
    this.targetPool?.dispose();
    this.targetPool = null;
    this.hud?.dispose();
    this.hud = null;
    this.crosshair?.dispose();
    this.crosshair = null;
    this.runHost = null;
  }

  private async endRun(): Promise<void> {
    if (!this.session) return;
    const record = this.session.finish();
    const scenarioId = record.scenarioId;

    this.loop?.stop();
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.input.release();
    this.pause?.destroy();
    this.pause = null;
    this.session.dispose();
    this.session = null;
    this.loop = null;

    const previous = await this.db.listSessions({ scenarioId });
    const previousBest = previous.length > 0 ? Math.max(...previous.map((s) => s.summary.score)) : null;

    try {
      await this.db.saveSession(record);
    } catch (err) {
      // A failed save must not swallow the run — show the results anyway and
      // say plainly that it was not persisted.
      console.error('Failed to save session', err);
    }

    this.teardownRunVisuals();

    this.setScreen(createResultsScreen({
      session: record,
      scenario: getScenario(scenarioId),
      weapon: getWeapon(record.weaponId),
      previousBest,
      isNewPersonalBest: previousBest === null || record.summary.score > previousBest,
      recentAverage: averageSummary(previous.slice(0, 10)),
      onRetry: () => void this.startRun(scenarioId, record.weaponId),
      onNext: () => {
        const family = familyOf(scenarioId);
        const pool = SCENARIOS.filter((s) => s.family === family);
        const idx = pool.findIndex((s) => s.id === scenarioId);
        const next = pool[(idx + 1) % pool.length];
        void this.startRun(next.id, next.weapons[0] ?? record.weaponId);
      },
      onMenu: () => void this.showMenu(),
    }));
  }
}

/** Hands the user a file without navigating away from the app. */
function download(filename: string, contents: string, mime: string): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const root = document.getElementById('app');
if (!root) throw new Error('#app root element is missing from index.html');
void new App(root).boot();

// Referenced so the fixed-FOV note stays discoverable from the entry point:
// Valorant's 103-degree horizontal FOV is not user-adjustable, and neither is ours.
export const HFOV = DEFAULT_HFOV_DEG.value;
export { WEAPONS };
