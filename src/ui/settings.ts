/**
 * Settings screen — sensitivity, RawAccel curve, profiles, crosshair and
 * video/game options. This is the most important screen in the app: it is
 * the entire reason the trainer's sensitivity math has to be exactly right.
 *
 * Nothing here writes to storage. Every field mutates a local working copy
 * and reports the result upward through `onSensChange` / `onCrosshairChange`
 * / `onVideoChange`; the supervisor's storage layer decides what persists.
 */
import type { AccelCurve, AccelCurveType, SensConfig, Vec2 } from '@core/types';
import { VALORANT_DEG_PER_COUNT, CM_PER_INCH, DEFAULT_HFOV_DEG } from '@core/constants';
import { el, Signal, sliderField, toggleField, selectField, numberField, type SelectOption } from './dom';
import { lineChart, type ChartHandle, type LineChartData } from './charts';

export interface ScreenHandle {
  el: HTMLElement;
  destroy: () => void;
}

// ------------------------------------------------------------- crosshair --

export interface CrosshairLineConfig {
  enabled: boolean;
  /** 0..1 */
  opacity: number;
  lengthPx: number;
  thicknessPx: number;
  offsetPx: number;
}

export interface CrosshairConfig {
  /** CSS hex colour, e.g. "#00ff00". */
  color: string;
  outlinesEnabled: boolean;
  outlineOpacity: number;
  outlineThicknessPx: number;
  centerDotEnabled: boolean;
  centerDotOpacity: number;
  centerDotThicknessPx: number;
  innerLines: CrosshairLineConfig;
  outerLines: CrosshairLineConfig;
  /** Crosshair expands while moving, mirroring Valorant's spread feedback. */
  movementErrorEnabled: boolean;
  /** Crosshair expands while firing. */
  firingErrorEnabled: boolean;
}

// ----------------------------------------------------------------- video --

export type TargetVisualMode = 'humanoid' | 'capsule' | 'hitbox-wireframe';

export interface VideoConfig {
  targetVisualMode: TargetVisualMode;
  /** 0 = uncapped. */
  fpsCap: number;
  showFps: boolean;
}

// --------------------------------------------------------------- profile --

export interface SensProfile {
  id: string;
  name: string;
  sens: SensConfig;
}

/**
 * Integration seam for the settings screen. The supervisor supplies current
 * state and callbacks; this file never reads/writes storage directly.
 */
export interface SettingsScreenDeps {
  sens: SensConfig;
  crosshair: CrosshairConfig;
  video: VideoConfig;
  profiles: SensProfile[];
  /** Id of the profile currently loaded as `sens`, if any — drives highlighting. */
  activeProfileId: string | null;
  /** Profile ids assigned to the two A/B comparison slots. */
  abSlots: [string | null, string | null];
  /** False when the platform could not deliver OS-unaccelerated mouse counts
   *  (Chrome `unadjustedMovement` unsupported or denied). When false, sensitivity
   *  readings will not match Valorant — this must be shown impossible to miss. */
  rawInputAvailable: boolean;
  /** Samples an AccelCurve for the live graph. Implemented by the sens engine. */
  sampleCurve: (curve: AccelCurve, maxSpeed: number, points: number) => Vec2[];
  onSensChange: (sens: SensConfig) => void;
  onCrosshairChange: (crosshair: CrosshairConfig) => void;
  onVideoChange: (video: VideoConfig) => void;
  onProfileSave: (name: string, sens: SensConfig) => void;
  onProfileLoad: (id: string) => void;
  onProfileDelete: (id: string) => void;
  onProfileSetAbSlot: (slot: 0 | 1, id: string | null) => void;
  onBack: () => void;
}

// ------------------------------------------------------------------ math --

function computeEdpi(sensitivity: number, dpi: number): number {
  return dpi * sensitivity;
}

function computeCm360(sensitivity: number, dpi: number): number {
  return (360 / (VALORANT_DEG_PER_COUNT.value * sensitivity * dpi)) * CM_PER_INCH;
}

function sensFromCm360(cm360: number, dpi: number): number {
  return (360 * CM_PER_INCH) / (VALORANT_DEG_PER_COUNT.value * dpi * cm360);
}

// ------------------------------------------------------------ curve data --

type NumericCurveField =
  | 'sensMultiplier' | 'acceleration' | 'exponent' | 'inputOffset' | 'outputCap' | 'inputCap'
  | 'decayRate' | 'limit' | 'syncSpeed' | 'gamma' | 'smooth' | 'motivity' | 'growthRate' | 'midpoint';

const CURVE_TYPES: AccelCurveType[] = ['off', 'linear', 'classic', 'natural', 'synchronous', 'power', 'motivity', 'jump', 'lookup'];

const CURVE_LABEL: Record<AccelCurveType, string> = {
  off: 'Off', linear: 'Linear', classic: 'Classic', natural: 'Natural', synchronous: 'Synchronous',
  power: 'Power', motivity: 'Motivity', jump: 'Jump', lookup: 'Lookup Table',
};

// Each description names the exact RawAccel mode it matches — the user is
// very unlikely to know which curve type their own RawAccel config maps to.
const CURVE_DESCRIPTIONS: Record<AccelCurveType, string> = {
  off: 'No acceleration applied — pure 1:1 Valorant sensitivity. Matches RawAccel set to "Off".',
  linear: 'Gain rises proportionally with mouse speed, unbounded unless you set an Output Cap. Matches RawAccel’s "Linear" mode.',
  classic: 'Gain grows with speed raised to an exponent — the original curve most legacy accel users ran. Matches RawAccel’s "Classic" mode.',
  natural: 'Gain eases toward an asymptotic limit as speed increases instead of climbing forever. Matches RawAccel’s "Natural" mode.',
  synchronous: 'Gain reaches a target sensitivity at a chosen sync speed, then flattens off. Matches RawAccel’s "Synchronous" mode.',
  power: 'Gain follows speed^exponent with no built-in ceiling — simple and steep. Matches RawAccel’s "Power" mode.',
  motivity: 'An S-curve that smoothly transitions between a low-speed and a high-speed sensitivity around a midpoint. Matches RawAccel’s "Motivity" mode.',
  jump: 'Gain steps from one level to another around a midpoint speed, optionally softened. Matches RawAccel’s "Jump" mode.',
  lookup: 'Gain follows a custom table of (speed, gain) points you define by hand. Matches RawAccel’s "Lookup Table" mode.',
};

const CURVE_FIELDS: Record<AccelCurveType, NumericCurveField[]> = {
  off: [],
  linear: ['sensMultiplier', 'acceleration', 'inputOffset', 'outputCap', 'inputCap'],
  classic: ['sensMultiplier', 'acceleration', 'exponent', 'inputOffset', 'outputCap', 'inputCap'],
  natural: ['sensMultiplier', 'decayRate', 'limit', 'inputOffset', 'outputCap', 'inputCap'],
  synchronous: ['sensMultiplier', 'limit', 'syncSpeed', 'gamma', 'smooth', 'inputOffset', 'outputCap', 'inputCap'],
  power: ['sensMultiplier', 'exponent', 'inputOffset', 'outputCap', 'inputCap'],
  motivity: ['sensMultiplier', 'motivity', 'growthRate', 'midpoint', 'decayRate', 'inputCap'],
  jump: ['sensMultiplier', 'growthRate', 'midpoint', 'smooth', 'inputCap'],
  lookup: ['sensMultiplier'],
};

const FIELD_META: Record<NumericCurveField, { label: string; min: number; max: number; step: number; unit?: string }> = {
  sensMultiplier: { label: 'Sens Multiplier', min: 0.01, max: 10, step: 0.01 },
  acceleration: { label: 'Acceleration', min: 0, max: 5, step: 0.001 },
  exponent: { label: 'Exponent', min: 0.1, max: 6, step: 0.01 },
  inputOffset: { label: 'Input Offset', min: 0, max: 50, step: 0.1, unit: 'ct/ms' },
  outputCap: { label: 'Output Cap (0 = uncapped)', min: 0, max: 20, step: 0.1 },
  inputCap: { label: 'Input Cap (0 = uncapped)', min: 0, max: 200, step: 1, unit: 'ct/ms' },
  decayRate: { label: 'Decay Rate', min: 0, max: 2, step: 0.001 },
  limit: { label: 'Limit', min: 0.1, max: 20, step: 0.01 },
  syncSpeed: { label: 'Sync Speed', min: 0, max: 100, step: 0.1, unit: 'ct/ms' },
  gamma: { label: 'Gamma', min: 0.1, max: 5, step: 0.01 },
  smooth: { label: 'Smooth', min: 0, max: 1, step: 0.01 },
  motivity: { label: 'Motivity', min: 0.1, max: 20, step: 0.01 },
  growthRate: { label: 'Growth Rate', min: 0, max: 5, step: 0.001 },
  midpoint: { label: 'Midpoint', min: 0, max: 100, step: 0.1, unit: 'ct/ms' },
};

const CURVE_SAMPLE_MAX_SPEED = 60;
const CURVE_SAMPLE_POINTS = 120;

// -------------------------------------------------------- crosshair codec --

function isLineConfig(v: unknown): v is CrosshairLineConfig {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.enabled === 'boolean' && typeof r.opacity === 'number'
    && typeof r.lengthPx === 'number' && typeof r.thicknessPx === 'number' && typeof r.offsetPx === 'number';
}

function isCrosshairConfig(v: unknown): v is CrosshairConfig {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.color === 'string'
    && typeof r.outlinesEnabled === 'boolean' && typeof r.outlineOpacity === 'number' && typeof r.outlineThicknessPx === 'number'
    && typeof r.centerDotEnabled === 'boolean' && typeof r.centerDotOpacity === 'number' && typeof r.centerDotThicknessPx === 'number'
    && isLineConfig(r.innerLines) && isLineConfig(r.outerLines)
    && typeof r.movementErrorEnabled === 'boolean' && typeof r.firingErrorEnabled === 'boolean';
}

function encodeCrosshairCode(cfg: CrosshairConfig): string {
  return `VFC1-${btoa(JSON.stringify(cfg))}`;
}

function decodeCrosshairCode(code: string): CrosshairConfig | null {
  const m = /^VFC1-(.+)$/.exec(code.trim());
  if (!m) return null;
  try {
    const parsed: unknown = JSON.parse(atob(m[1]));
    return isCrosshairConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hexWithAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawCrosshairPreview(canvas: HTMLCanvasElement, cfg: CrosshairConfig): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth || 200;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];

  const drawLine = (dx: number, dy: number, line: CrosshairLineConfig, outline: boolean): void => {
    if (!line.enabled) return;
    const x0 = cx + dx * line.offsetPx;
    const y0 = cy + dy * line.offsetPx;
    const x1 = cx + dx * (line.offsetPx + line.lengthPx);
    const y1 = cy + dy * (line.offsetPx + line.lengthPx);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    if (outline) {
      ctx.strokeStyle = `rgba(0,0,0,${cfg.outlineOpacity})`;
      ctx.lineWidth = line.thicknessPx + cfg.outlineThicknessPx * 2;
    } else {
      ctx.strokeStyle = hexWithAlpha(cfg.color, line.opacity);
      ctx.lineWidth = line.thicknessPx;
    }
    ctx.stroke();
  };

  if (cfg.outlinesEnabled) {
    for (const [dx, dy] of dirs) drawLine(dx, dy, cfg.outerLines, true);
    for (const [dx, dy] of dirs) drawLine(dx, dy, cfg.innerLines, true);
  }
  for (const [dx, dy] of dirs) drawLine(dx, dy, cfg.outerLines, false);
  for (const [dx, dy] of dirs) drawLine(dx, dy, cfg.innerLines, false);

  if (cfg.centerDotEnabled) {
    if (cfg.outlinesEnabled) {
      ctx.beginPath();
      ctx.arc(cx, cy, cfg.centerDotThicknessPx / 2 + cfg.outlineThicknessPx, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,0,0,${cfg.outlineOpacity})`;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, cfg.centerDotThicknessPx / 2, 0, Math.PI * 2);
    ctx.fillStyle = hexWithAlpha(cfg.color, cfg.centerDotOpacity);
    ctx.fill();
  }
}

// ---------------------------------------------------------------- screen --

type TabId = 'sensitivity' | 'rawaccel' | 'profiles' | 'crosshair' | 'video';
const TABS: { id: TabId; label: string }[] = [
  { id: 'sensitivity', label: 'Sensitivity' },
  { id: 'rawaccel', label: 'Raw Accel' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'crosshair', label: 'Crosshair' },
  { id: 'video', label: 'Video / Game' },
];

interface Section { el: HTMLElement; destroy: () => void; }

export function createSettingsScreen(deps: SettingsScreenDeps): ScreenHandle {
  const unsubs: (() => void)[] = [];
  const working: SensConfig = structuredClone(deps.sens);
  const workingCrosshair: CrosshairConfig = structuredClone(deps.crosshair);
  const workingVideo: VideoConfig = structuredClone(deps.video);

  const commit = (): void => deps.onSensChange(structuredClone(working));
  const commitCrosshair = (): void => deps.onCrosshairChange(structuredClone(workingCrosshair));
  const commitVideo = (): void => deps.onVideoChange(structuredClone(workingVideo));

  // ---- Sensitivity tab ---------------------------------------------------
  function renderSensitivitySection(): Section {
    const cleanup: (() => void)[] = [];
    const readoutEdpi = el('div', { class: 'readout-value' }, '—');
    const readoutCm360 = el('div', { class: 'readout-value' }, '—');
    const refreshReadouts = (): void => {
      readoutEdpi.textContent = computeEdpi(working.sensitivity, working.dpi).toFixed(1);
      readoutCm360.textContent = `${computeCm360(working.sensitivity, working.dpi).toFixed(2)} cm`;
    };

    const dpiField = numberField({ id: 'set-dpi', label: 'Mouse DPI', value: working.dpi, min: 50, max: 32000, step: 50 }, (v) => {
      working.dpi = v; commit(); refreshReadouts();
    });
    const sensField = numberField({ id: 'set-sens', label: 'Valorant Sensitivity', value: working.sensitivity, min: 0.001, max: 10, step: 0.001 }, (v) => {
      working.sensitivity = v; commit(); refreshReadouts();
    });
    const scopedField = numberField({ id: 'set-scoped', label: 'Scoped Sensitivity Multiplier', value: working.scopedMultiplier, min: 0, max: 2.5, step: 0.01 }, (v) => {
      working.scopedMultiplier = v; commit();
    });
    const invertField = toggleField({ id: 'set-inverty', label: 'Invert Y', value: working.invertY }, (v) => {
      working.invertY = v; commit();
    });
    const targetCmField = numberField({
      id: 'set-target-cm', label: 'Target cm/360 (reverse solve)',
      value: Number(computeCm360(working.sensitivity, working.dpi).toFixed(2)), min: 1, max: 200, step: 0.1, unit: 'cm',
    }, (v) => {
      const newSens = sensFromCm360(v, working.dpi);
      working.sensitivity = newSens;
      sensField.setValue(newSens);
      commit();
      refreshReadouts();
    });
    cleanup.push(dpiField.destroy, sensField.destroy, scopedField.destroy, invertField.destroy, targetCmField.destroy);
    refreshReadouts();

    const section = el('div', { class: 'settings-section' },
      el('div', { class: 'panel' },
        el('div', { class: 'panel-header' }, el('div', { class: 'panel-title' }, 'Sensitivity')),
        el('div', { class: 'readout-row' },
          el('div', { class: 'readout' }, el('div', { class: 'readout-label' }, 'eDPI'), readoutEdpi),
          el('div', { class: 'readout' }, el('div', { class: 'readout-label' }, 'cm / 360°'), readoutCm360)),
        dpiField.el, sensField.el, scopedField.el, invertField.el),
      el('div', { class: 'panel' },
        el('div', { class: 'panel-header' },
          el('div', { class: 'panel-title' }, 'Reverse Solve'),
          el('div', { class: 'panel-subtitle' }, 'Know your cm/360 from another game or a sens calculator? Get the matching Valorant sensitivity.')),
        targetCmField.el));

    return { el: section, destroy: () => { for (const fn of cleanup) fn(); } };
  }

  // ---- Raw Accel tab ------------------------------------------------------
  function renderRawAccelSection(): Section {
    const cleanup: (() => void)[] = [];
    const enabledField = toggleField({
      id: 'set-rawaccel-enabled', label: 'Enable Raw Accel', value: working.rawAccelEnabled,
      description: 'Applies a RawAccel-equivalent acceleration curve on top of your Valorant sensitivity.',
    }, (v) => { working.rawAccelEnabled = v; commit(); rebuildBody(); });
    cleanup.push(enabledField.destroy);

    const body = el('div', { class: 'stack' });
    let curveChart: ChartHandle<LineChartData> | null = null;

    function sampleAndRedraw(): void {
      if (!curveChart) return;
      curveChart.update({ points: deps.sampleCurve(working.curve, CURVE_SAMPLE_MAX_SPEED, CURVE_SAMPLE_POINTS) });
    }

    function renderLookupEditor(): HTMLElement {
      const rows = el('div', { class: 'stack' });
      const renderRows = (): void => {
        rows.replaceChildren(...(working.curve.lookup ?? []).map((pt, i) => {
          const xInput = el('input', {
            type: 'number', class: 'field-number-solo', value: pt.x, step: 0.1,
            oninput: (e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (!Number.isNaN(v)) { pt.x = v; commit(); sampleAndRedraw(); }
            },
          }) as HTMLInputElement;
          const yInput = el('input', {
            type: 'number', class: 'field-number-solo', value: pt.y, step: 0.01,
            oninput: (e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (!Number.isNaN(v)) { pt.y = v; commit(); sampleAndRedraw(); }
            },
          }) as HTMLInputElement;
          const removeBtn = el('button', {
            type: 'button', class: 'btn btn-ghost btn-sm',
            onclick: () => {
              (working.curve.lookup ?? []).splice(i, 1);
              commit(); sampleAndRedraw(); renderRows();
            },
          }, 'Remove');
          return el('div', { class: 'flex-row' }, xInput, yInput, removeBtn);
        }));
      };
      const addBtn = el('button', {
        type: 'button', class: 'btn btn-secondary btn-sm',
        onclick: () => {
          const lookup = working.curve.lookup ?? [];
          lookup.push({ x: 0, y: 1 });
          lookup.sort((a, b) => a.x - b.x);
          working.curve.lookup = lookup;
          commit(); sampleAndRedraw(); renderRows();
        },
      }, 'Add Point');
      renderRows();
      return el('div', { class: 'stack' }, el('div', { class: 'section-title' }, 'Lookup Points (speed → gain)'), rows, addBtn);
    }

    function rebuildBody(): void {
      curveChart?.destroy();
      curveChart = null;
      body.replaceChildren();
      if (!working.rawAccelEnabled) {
        body.appendChild(el('p', { class: 'text-dim' }, 'Raw Accel is off — Valorant sensitivity applies 1:1.'));
        return;
      }

      const typeOptions: SelectOption<AccelCurveType>[] = CURVE_TYPES.map((t) => ({ value: t, label: CURVE_LABEL[t] }));
      const typeField = selectField({ id: 'set-curve-type', label: 'Curve Type', value: working.curve.type, options: typeOptions }, (v) => {
        working.curve.type = v;
        if (v === 'lookup' && !working.curve.lookup) working.curve.lookup = [{ x: 0, y: 1 }, { x: 20, y: 1.5 }, { x: 60, y: 2 }];
        commit();
        rebuildBody();
      });
      cleanup.push(typeField.destroy);

      const desc = el('p', { class: 'curve-type-desc' }, CURVE_DESCRIPTIONS[working.curve.type]);
      const fieldsGrid = el('div', { class: 'curve-field-grid' });
      for (const key of CURVE_FIELDS[working.curve.type]) {
        const meta = FIELD_META[key];
        const f = sliderField({ id: `set-curve-${key}`, label: meta.label, min: meta.min, max: meta.max, step: meta.step, value: working.curve[key], unit: meta.unit }, (v) => {
          working.curve[key] = v; commit(); sampleAndRedraw();
        });
        cleanup.push(f.destroy);
        fieldsGrid.appendChild(f.el);
      }

      const extras: HTMLElement[] = [];
      if (working.curve.type !== 'off') {
        const applyToYField = toggleField({
          id: 'set-curve-applytoy', label: 'Apply to Vertical (Y)', value: working.curve.applyToY,
          description: 'RawAccel "Whole/By Component" — off applies the curve to horizontal speed only.',
        }, (v) => { working.curve.applyToY = v; commit(); sampleAndRedraw(); });
        cleanup.push(applyToYField.destroy);
        extras.push(applyToYField.el);
      }
      if (working.curve.type === 'lookup') extras.push(renderLookupEditor());

      const graphContainer = el('div', {});
      body.append(typeField.el, desc, fieldsGrid, ...extras, graphContainer);
      curveChart = lineChart(graphContainer, { points: [] }, {
        width: 620, height: 280,
        xLabel: 'Input Speed (counts/ms)', yLabel: 'Gain',
        xMin: 0, xMax: CURVE_SAMPLE_MAX_SPEED,
        referenceLines: [{ y: 1, label: '1.0× (no accel)' }],
      });
      sampleAndRedraw();
    }
    cleanup.push(() => curveChart?.destroy());
    rebuildBody();

    const section = el('div', { class: 'settings-section' },
      el('div', { class: 'panel' }, enabledField.el),
      el('div', { class: 'panel' }, body));

    return { el: section, destroy: () => { for (const fn of cleanup) fn(); } };
  }

  // ---- Profiles tab ---------------------------------------------------
  function renderProfilesSection(): Section {
    const nameInput = el('input', {
      type: 'text', class: 'field-number-solo', placeholder: 'Profile name', style: { width: '220px' },
    }) as HTMLInputElement;
    const saveBtn = el('button', {
      type: 'button', class: 'btn btn-primary btn-sm',
      onclick: () => {
        const name = nameInput.value.trim();
        if (!name) return;
        deps.onProfileSave(name, structuredClone(working));
        nameInput.value = '';
      },
    }, 'Save Current As');

    const list = el('div', { class: 'profile-list' },
      deps.profiles.length === 0
        ? el('div', { class: 'text-dim' }, 'No saved profiles yet.')
        : deps.profiles.map((p) => el('div', { class: `profile-item${p.id === deps.activeProfileId ? ' active' : ''}` },
          el('div', {},
            el('div', { class: 'profile-item-name' }, p.name),
            el('div', { class: 'profile-item-meta' },
              `eDPI ${computeEdpi(p.sens.sensitivity, p.sens.dpi).toFixed(1)} · ${computeCm360(p.sens.sensitivity, p.sens.dpi).toFixed(1)} cm/360`)),
          el('div', { class: 'profile-item-actions' },
            el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => deps.onProfileLoad(p.id) }, 'Load'),
            el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => deps.onProfileSetAbSlot(0, p.id) }, 'Set A'),
            el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => deps.onProfileSetAbSlot(1, p.id) }, 'Set B'),
            el('button', { type: 'button', class: 'btn btn-danger btn-sm', onclick: () => deps.onProfileDelete(p.id) }, 'Delete')))));

    const slotA = deps.profiles.find((p) => p.id === deps.abSlots[0]) ?? null;
    const slotB = deps.profiles.find((p) => p.id === deps.abSlots[1]) ?? null;
    const abSwitch = el('div', { class: 'ab-switch' },
      el('button', {
        type: 'button', class: `ab-slot${deps.activeProfileId != null && deps.activeProfileId === deps.abSlots[0] ? ' active' : ''}`,
        disabled: !slotA, onclick: () => { if (slotA) deps.onProfileLoad(slotA.id); },
      }, `A: ${slotA?.name ?? 'empty'}`),
      el('button', {
        type: 'button', class: `ab-slot${deps.activeProfileId != null && deps.activeProfileId === deps.abSlots[1] ? ' active' : ''}`,
        disabled: !slotB, onclick: () => { if (slotB) deps.onProfileLoad(slotB.id); },
      }, `B: ${slotB?.name ?? 'empty'}`));

    const section = el('div', { class: 'settings-section' },
      el('div', { class: 'panel' },
        el('div', { class: 'panel-header' }, el('div', { class: 'panel-title' }, 'Save Profile')),
        el('div', { class: 'flex-row' }, nameInput, saveBtn)),
      el('div', { class: 'panel' },
        el('div', { class: 'panel-header' }, el('div', { class: 'panel-title' }, 'Saved Profiles')),
        list),
      el('div', { class: 'panel' },
        el('div', { class: 'panel-header' },
          el('div', { class: 'panel-title' }, 'A/B Comparison'),
          el('div', { class: 'panel-subtitle' }, 'Assign two saved profiles, then switch to feel the difference back-to-back')),
        abSwitch));

    return { el: section, destroy: () => {} };
  }

  // ---- Crosshair tab ----------------------------------------------------
  function renderCrosshairSection(): Section {
    const cleanup: (() => void)[] = [];
    const previewCanvas = el('canvas', { class: 'crosshair-preview-canvas' }) as HTMLCanvasElement;
    const preview = el('div', { class: 'crosshair-preview' }, previewCanvas);
    const codeInput = el('input', { type: 'text', class: 'crosshair-code-input', value: encodeCrosshairCode(workingCrosshair) }) as HTMLInputElement;

    const redraw = (): void => {
      drawCrosshairPreview(previewCanvas, workingCrosshair);
      codeInput.value = encodeCrosshairCode(workingCrosshair);
    };
    const commitAndRedraw = (): void => { commitCrosshair(); redraw(); };

    const applyBtn = el('button', {
      type: 'button', class: 'btn btn-secondary btn-sm',
      onclick: () => {
        const decoded = decodeCrosshairCode(codeInput.value);
        if (decoded) { Object.assign(workingCrosshair, decoded); commitAndRedraw(); rebuildFields(); }
      },
    }, 'Apply Code');

    function lineEditor(title: string, slug: string, line: CrosshairLineConfig): HTMLElement {
      const enabledToggle = toggleField({ id: `xh-${slug}-enabled`, label: `${title} Enabled`, value: line.enabled }, (v) => {
        line.enabled = v; commitAndRedraw(); rebuildLine();
      });
      cleanup.push(enabledToggle.destroy);
      const rest = el('div', { class: 'curve-field-grid' });
      function rebuildLine(): void {
        rest.replaceChildren();
        if (!line.enabled) return;
        const opacityF = sliderField({ id: `xh-${slug}-opacity`, label: 'Opacity', min: 0, max: 1, step: 0.05, value: line.opacity }, (v) => { line.opacity = v; commitAndRedraw(); });
        const lengthF = sliderField({ id: `xh-${slug}-length`, label: 'Length', min: 0, max: 40, step: 0.5, value: line.lengthPx, unit: 'px' }, (v) => { line.lengthPx = v; commitAndRedraw(); });
        const thickF = sliderField({ id: `xh-${slug}-thickness`, label: 'Thickness', min: 0.5, max: 8, step: 0.5, value: line.thicknessPx, unit: 'px' }, (v) => { line.thicknessPx = v; commitAndRedraw(); });
        const offsetF = sliderField({ id: `xh-${slug}-offset`, label: 'Offset', min: 0, max: 30, step: 0.5, value: line.offsetPx, unit: 'px' }, (v) => { line.offsetPx = v; commitAndRedraw(); });
        cleanup.push(opacityF.destroy, lengthF.destroy, thickF.destroy, offsetF.destroy);
        rest.append(opacityF.el, lengthF.el, thickF.el, offsetF.el);
      }
      rebuildLine();
      return el('div', { class: 'stack' }, el('div', { class: 'section-title' }, title), enabledToggle.el, rest);
    }

    const fieldsHost = el('div', { class: 'stack' });
    function rebuildFields(): void {
      fieldsHost.replaceChildren();

      const colorInput = el('input', {
        type: 'color', id: 'xh-color', value: workingCrosshair.color,
        oninput: (e: Event) => { workingCrosshair.color = (e.target as HTMLInputElement).value; commitAndRedraw(); },
      });
      const colorRow = el('div', { class: 'field' }, el('label', { class: 'field-label', for: 'xh-color' }, 'Colour'), colorInput);

      const outlinesToggle = toggleField({ id: 'xh-outlines', label: 'Outlines', value: workingCrosshair.outlinesEnabled }, (v) => {
        workingCrosshair.outlinesEnabled = v; commitAndRedraw(); rebuildFields();
      });
      cleanup.push(outlinesToggle.destroy);
      const outlineExtras: HTMLElement[] = [];
      if (workingCrosshair.outlinesEnabled) {
        const opacityF = sliderField({ id: 'xh-outline-opacity', label: 'Outline Opacity', min: 0, max: 1, step: 0.05, value: workingCrosshair.outlineOpacity }, (v) => { workingCrosshair.outlineOpacity = v; commitAndRedraw(); });
        const thickF = sliderField({ id: 'xh-outline-thickness', label: 'Outline Thickness', min: 0, max: 4, step: 0.5, value: workingCrosshair.outlineThicknessPx, unit: 'px' }, (v) => { workingCrosshair.outlineThicknessPx = v; commitAndRedraw(); });
        cleanup.push(opacityF.destroy, thickF.destroy);
        outlineExtras.push(opacityF.el, thickF.el);
      }

      const dotToggle = toggleField({ id: 'xh-dot', label: 'Centre Dot', value: workingCrosshair.centerDotEnabled }, (v) => {
        workingCrosshair.centerDotEnabled = v; commitAndRedraw(); rebuildFields();
      });
      cleanup.push(dotToggle.destroy);
      const dotExtras: HTMLElement[] = [];
      if (workingCrosshair.centerDotEnabled) {
        const dotOpacity = sliderField({ id: 'xh-dot-opacity', label: 'Dot Opacity', min: 0, max: 1, step: 0.05, value: workingCrosshair.centerDotOpacity }, (v) => { workingCrosshair.centerDotOpacity = v; commitAndRedraw(); });
        const dotThickness = sliderField({ id: 'xh-dot-thickness', label: 'Dot Size', min: 1, max: 12, step: 0.5, value: workingCrosshair.centerDotThicknessPx, unit: 'px' }, (v) => { workingCrosshair.centerDotThicknessPx = v; commitAndRedraw(); });
        cleanup.push(dotOpacity.destroy, dotThickness.destroy);
        dotExtras.push(dotOpacity.el, dotThickness.el);
      }

      const movementToggle = toggleField({
        id: 'xh-move-error', label: 'Show Movement Error', value: workingCrosshair.movementErrorEnabled,
        description: 'Crosshair expands while moving, matching Valorant’s spread feedback.',
      }, (v) => { workingCrosshair.movementErrorEnabled = v; commitAndRedraw(); });
      const firingToggle = toggleField({
        id: 'xh-fire-error', label: 'Show Firing Error', value: workingCrosshair.firingErrorEnabled,
        description: 'Crosshair expands while firing.',
      }, (v) => { workingCrosshair.firingErrorEnabled = v; commitAndRedraw(); });
      cleanup.push(movementToggle.destroy, firingToggle.destroy);

      fieldsHost.append(
        colorRow, outlinesToggle.el, ...outlineExtras, dotToggle.el, ...dotExtras,
        lineEditor('Inner Lines', 'inner', workingCrosshair.innerLines),
        lineEditor('Outer Lines', 'outer', workingCrosshair.outerLines),
        movementToggle.el, firingToggle.el);
    }
    rebuildFields();
    redraw();

    const section = el('div', { class: 'settings-section' },
      el('div', { class: 'crosshair-editor-layout' },
        el('div', { class: 'panel' },
          el('div', { class: 'panel-header' }, el('div', { class: 'panel-title' }, 'Crosshair')),
          fieldsHost,
          el('div', { class: 'panel-header' }, el('div', { class: 'panel-title' }, 'Import / Export')),
          el('div', { class: 'crosshair-export-row' }, codeInput, applyBtn),
          el('p', { class: 'field-hint' }, 'Copy this code to share your crosshair, or paste one and click Apply.')),
        preview));

    return { el: section, destroy: () => { for (const fn of cleanup) fn(); } };
  }

  // ---- Video / Game tab ---------------------------------------------------
  function renderVideoSection(): Section {
    const cleanup: (() => void)[] = [];
    const modeOptions: SelectOption<TargetVisualMode>[] = [
      { value: 'humanoid', label: 'Humanoid' },
      { value: 'capsule', label: 'Capsule' },
      { value: 'hitbox-wireframe', label: 'Hitbox Wireframe' },
    ];
    const modeField = selectField({ id: 'vid-mode', label: 'Target Visual Mode', value: workingVideo.targetVisualMode, options: modeOptions }, (v) => {
      workingVideo.targetVisualMode = v; commitVideo();
    });
    const fpsField = numberField({ id: 'vid-fpscap', label: 'FPS Cap (0 = uncapped)', value: workingVideo.fpsCap, min: 0, max: 360, step: 1 }, (v) => {
      workingVideo.fpsCap = v; commitVideo();
    });
    const showFpsField = toggleField({ id: 'vid-showfps', label: 'Show FPS Counter', value: workingVideo.showFps }, (v) => {
      workingVideo.showFps = v; commitVideo();
    });
    cleanup.push(modeField.destroy, fpsField.destroy, showFpsField.destroy);

    const section = el('div', { class: 'settings-section' },
      el('div', { class: 'panel' },
        el('div', { class: 'panel-header' }, el('div', { class: 'panel-title' }, 'Video / Game')),
        modeField.el,
        el('div', { class: 'fov-readout-row' },
          el('span', {}, 'Horizontal FOV'),
          el('span', { class: 'fov-readout-value' }, `${DEFAULT_HFOV_DEG.value}°`),
          el('span', { class: 'text-faint' }, '— fixed. Valorant does not allow FOV changes, so neither does this trainer.')),
        fpsField.el, showFpsField.el));

    return { el: section, destroy: () => { for (const fn of cleanup) fn(); } };
  }

  // ---- tab shell ---------------------------------------------------------
  const activeTab = new Signal<TabId>('sensitivity');
  const content = el('div', {});
  const tabsHost = el('div', { class: 'settings-tabs' });
  let currentSection: Section | null = null;

  function buildSection(tab: TabId): Section {
    switch (tab) {
      case 'sensitivity': return renderSensitivitySection();
      case 'rawaccel': return renderRawAccelSection();
      case 'profiles': return renderProfilesSection();
      case 'crosshair': return renderCrosshairSection();
      case 'video': return renderVideoSection();
    }
  }

  function renderActive(): void {
    currentSection?.destroy();
    currentSection = buildSection(activeTab.get());
    content.replaceChildren(currentSection.el);
    tabsHost.replaceChildren(...TABS.map((t) => el('button', {
      type: 'button',
      class: `settings-tab${t.id === activeTab.get() ? ' active' : ''}`,
      onclick: () => activeTab.set(t.id),
    }, t.label)));
  }
  unsubs.push(activeTab.subscribe(renderActive));

  const warningBanner = deps.rawInputAvailable ? null : el('div', { class: 'warning-banner' },
    el('div', { class: 'warning-banner-icon' }, '⚠'),
    el('div', {},
      el('div', { class: 'warning-banner-title' }, 'Raw Mouse Input Unavailable'),
      el('div', { class: 'warning-banner-text' },
        'Your browser did not grant unaccelerated mouse input (Chrome/Edge’s "unadjustedMovement" is unsupported or was denied). '
        + 'The OS is applying its own mouse acceleration underneath everything below, so eDPI, cm/360 and the Raw Accel curve here will NOT match Valorant. '
        + 'Use a Chromium browser and grant raw input access when prompted to fix this.')));

  const root = el('div', { class: 'screen settings-screen' },
    el('div', { class: 'screen-header' },
      el('div', { class: 'screen-title' }, 'Settings'),
      el('div', { class: 'screen-nav' }, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => deps.onBack() }, 'Back'))),
    el('div', { class: 'screen-body' },
      warningBanner,
      el('div', { class: 'settings-layout' }, tabsHost, content)));

  return {
    el: root,
    destroy: () => {
      currentSection?.destroy();
      for (const u of unsubs) u();
      root.remove();
    },
  };
}
