/**
 * Post-run results screen. Pure presentation over a finished SessionRecord —
 * scoring, storage and "what's next" logic all live outside this file and
 * arrive through the injected deps below.
 */
import type { ScenarioDef, SessionRecord, SessionSummary, WeaponSpec } from '@core/types';
import { el } from './dom';
import { scatterChart, cssVar, type ChartHandle, type ScatterDatum } from './charts';

/** Integration seam for the results screen. */
export interface ResultsScreenDeps {
  session: SessionRecord;
  scenario: ScenarioDef;
  weapon: WeaponSpec;
  /** Best score for this scenario BEFORE this run. Null if never played before. */
  previousBest: number | null;
  /** True when `session.summary.score` beat `previousBest`. */
  isNewPersonalBest: boolean;
  /** Mean summary across the player's recent sessions on this scenario. Null
   *  when there isn't enough history yet — deltas are hidden, not guessed. */
  recentAverage: SessionSummary | null;
  onRetry: () => void;
  /** Advance to whatever scenario the caller decides is "next" (rotation, same family, etc). */
  onNext: () => void;
  onMenu: () => void;
}

export interface ScreenHandle {
  el: HTMLElement;
  destroy: () => void;
}

type Prefer = 'high' | 'low' | 'near-zero' | 'near-one';

interface StatDef {
  key: keyof SessionSummary;
  label: string;
  prefer: Prefer;
  format: (v: number) => string;
  deltaFormat: (absDelta: number) => string;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const deg = (v: number): string => `${v.toFixed(2)}°`;
const signedDeg = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}°`;

// SessionSummary documents accuracy/headshotRate/trackingAccuracy as fractions
// (trackingAccuracy explicitly; the other two follow the same hits/total convention).
const STATS: StatDef[] = [
  { key: 'score', label: 'Score', prefer: 'high', format: (v) => Math.round(v).toLocaleString(), deltaFormat: (d) => Math.round(d).toLocaleString() },
  { key: 'accuracy', label: 'Accuracy', prefer: 'high', format: pct, deltaFormat: (d) => `${(d * 100).toFixed(1)} pts` },
  { key: 'headshotRate', label: 'Headshot %', prefer: 'high', format: pct, deltaFormat: (d) => `${(d * 100).toFixed(1)} pts` },
  { key: 'avgTimeToTargetMs', label: 'Avg Time to Target', prefer: 'low', format: (v) => `${Math.round(v)} ms`, deltaFormat: (d) => `${Math.round(d)} ms` },
  { key: 'avgErrorDeg', label: 'Avg Error Angle', prefer: 'low', format: deg, deltaFormat: deg },
  { key: 'overshootBias', label: 'Overshoot Bias', prefer: 'near-zero', format: signedDeg, deltaFormat: deg },
  { key: 'pathEfficiency', label: 'Path Efficiency', prefer: 'near-one', format: (v) => v.toFixed(2), deltaFormat: (d) => d.toFixed(2) },
  { key: 'trackingAccuracy', label: 'Tracking Accuracy', prefer: 'high', format: pct, deltaFormat: (d) => `${(d * 100).toFixed(1)} pts` },
];

function deltaClass(current: number, previous: number, prefer: Prefer): 'positive' | 'negative' | 'neutral' {
  if (current === previous) return 'neutral';
  switch (prefer) {
    case 'high': return current > previous ? 'positive' : 'negative';
    case 'low': return current < previous ? 'positive' : 'negative';
    case 'near-zero': return Math.abs(current) < Math.abs(previous) ? 'positive' : 'negative';
    case 'near-one': return Math.abs(current - 1) < Math.abs(previous - 1) ? 'positive' : 'negative';
  }
}

function statTile(def: StatDef, summary: SessionSummary, recent: SessionSummary | null): HTMLElement {
  const value = summary[def.key];
  let deltaEl: HTMLElement | null = null;
  if (recent) {
    const prev = recent[def.key];
    const delta = value - prev;
    const cls = deltaClass(value, prev, def.prefer);
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
    deltaEl = el('div', { class: `stat-tile-delta ${cls}` }, `${sign}${def.deltaFormat(Math.abs(delta))} vs recent avg`);
  }
  return el('div', { class: 'stat-tile' },
    el('div', { class: 'stat-tile-label' }, def.label),
    el('div', { class: 'stat-tile-value' }, def.format(value)),
    deltaEl);
}

export function createResultsScreen(deps: ResultsScreenDeps): ScreenHandle {
  const session = deps.session;
  const summary = session.summary;

  const heroRight = deps.isNewPersonalBest
    ? el('div', { class: 'results-pb-flag' }, 'New Personal Best')
    : deps.previousBest != null
      ? el('div', { class: 'text-dim' }, `Best: ${Math.round(deps.previousBest).toLocaleString()}`)
      : null;

  const hero = el('div', { class: 'results-hero' },
    el('div', {},
      el('div', { class: 'results-score-label' }, `${deps.scenario.name} — ${deps.weapon.name}`),
      el('div', { class: 'results-score-value' }, Math.round(summary.score).toLocaleString())),
    heroRight);

  const statGrid = el('div', { class: 'stat-grid' }, STATS.map((def) => statTile(def, summary, deps.recentAverage)));

  // ---- shot-by-shot scatter: error yaw vs error pitch, hit/miss coloured --
  const scatterContainer = el('div', {});
  const scatterData: ScatterDatum[] = session.shots.map((s) => ({
    x: s.errorYawDeg,
    y: s.errorPitchDeg,
    key: s.hit ? 'hit' : 'miss',
    label: `${s.hit ? 'HIT' : 'MISS'} · ${s.errorAngleDeg.toFixed(2)}° off`,
  }));
  // Symmetric domain around zero so a left/right or up/down bias in the
  // cluster is visible at a glance, not hidden by an off-centre auto-domain.
  const maxAbsYaw = Math.max(0.5, ...session.shots.map((s) => Math.abs(s.errorYawDeg)));
  const maxAbsPitch = Math.max(0.5, ...session.shots.map((s) => Math.abs(s.errorPitchDeg)));
  let scatter: ChartHandle<ScatterDatum[]> | null = null;
  if (scatterData.length > 0) {
    scatter = scatterChart(scatterContainer, scatterData, {
      width: 640,
      height: 360,
      xLabel: 'Error Yaw (deg, + = right of target)',
      yLabel: 'Error Pitch (deg, + = above target)',
      colors: { hit: cssVar('--chart-accent-2', '#5ce1e6'), miss: cssVar('--chart-accent', '#ff4655') },
      xZeroLine: true,
      yZeroLine: true,
      xMin: -maxAbsYaw * 1.15,
      xMax: maxAbsYaw * 1.15,
      yMin: -maxAbsPitch * 1.15,
      yMax: maxAbsPitch * 1.15,
    });
  }

  const scatterPanel = el('div', { class: 'panel' },
    el('div', { class: 'panel-header' },
      el('div', { class: 'panel-title' }, 'Shot Placement'),
      el('div', { class: 'panel-subtitle' },
        el('span', { class: 'text-accent-2' }, '● Hit'), ' ',
        el('span', { class: 'text-accent' }, '● Miss'))),
    scatterData.length > 0
      ? scatterContainer
      : el('div', { class: 'text-dim' }, 'No shots recorded this run.'));

  const actions = el('div', { class: 'results-actions' },
    el('button', { type: 'button', class: 'btn btn-secondary', onclick: () => deps.onMenu() }, 'Menu'),
    el('button', { type: 'button', class: 'btn btn-secondary', onclick: () => deps.onRetry() }, 'Retry'),
    el('button', { type: 'button', class: 'btn btn-primary', onclick: () => deps.onNext() }, 'Next Scenario'));

  const root = el('div', { class: 'screen results-screen' },
    el('div', { class: 'screen-header' },
      el('div', { class: 'screen-title' }, 'Results'),
      el('div', { class: 'screen-nav' },
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => deps.onMenu() }, 'Menu'))),
    el('div', { class: 'screen-body' },
      hero,
      statGrid,
      scatterPanel,
      actions));

  return {
    el: root,
    destroy: () => {
      scatter?.destroy();
      root.remove();
    },
  };
}
