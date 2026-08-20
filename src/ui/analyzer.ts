/**
 * Sensitivity analyzer dashboard. Pure presentation over `SensRecommendation`
 * objects computed elsewhere — this file never touches session storage or
 * runs the estimator math, it only renders what it's given honestly.
 */
import type { MetricVerdict, ScenarioFamily, SensBucket, SensRecommendation } from '@core/types';
import { el, Signal } from './dom';
import {
  lineChart, scatterChart, metricVerdictChart, cssVar,
  type ChartHandle, type ScatterDatum, type VerdictRow,
} from './charts';

export interface ScreenHandle {
  el: HTMLElement;
  destroy: () => void;
}

export type AccelTrack = 'off' | 'on';

export interface TrackData {
  /** Null when this track has zero sessions recorded yet. */
  recommendation: SensRecommendation | null;
  /** Per-family recommendation, present only where a family has enough of its own data. */
  familyRecommendations: Partial<Record<ScenarioFamily, SensRecommendation>>;
}

/** Integration seam for the analyzer screen. */
export interface AnalyzerScreenDeps {
  rawAccelOff: TrackData;
  rawAccelOn: TrackData;
  /** One-click start of a guided-sweep sensitivity test. */
  onStartSweep: (sensitivity: number) => void;
  onExportJson: (track: AccelTrack) => void;
  onExportCsv: (track: AccelTrack) => void;
  onBack: () => void;
}

// Below this, the dashboard must lead with "not enough data" rather than a number.
const LOW_CONFIDENCE = 0.35;
const MED_CONFIDENCE = 0.7;

const fmtSens = (v: number): string => v.toFixed(3);
const fmtEdpi = (v: number): string => v.toFixed(1);
const fmtCm = (v: number): string => `${v.toFixed(1)} cm`;
const fmtPct = (v: number): string => `${Math.round(v * 100)}%`;

function confidenceTier(c: number): 'low' | 'med' | 'high' {
  if (c < LOW_CONFIDENCE) return 'low';
  if (c < MED_CONFIDENCE) return 'med';
  return 'high';
}

function confidenceBadge(c: number): HTMLElement {
  const tier = confidenceTier(c);
  return el('span', { class: `badge badge-confidence-${tier}` }, `${Math.round(c * 100)}% confidence`);
}

function confidenceMeter(c: number): HTMLElement {
  const tier = confidenceTier(c);
  return el('div', { class: 'confidence-meter' },
    el('div', { class: 'confidence-meter-track' },
      el('div', { class: `confidence-meter-fill ${tier}`, style: { width: `${Math.round(c * 100)}%` } })),
    el('span', { class: 'text-dim' }, `${Math.round(c * 100)}%`));
}

const FAMILY_ORDER: ScenarioFamily[] = ['clicking', 'tracking', 'peek'];
const FAMILY_LABEL: Record<ScenarioFamily, string> = { clicking: 'Clicking', tracking: 'Tracking', peek: 'Peeking' };

// Restricted to SensBucket's numeric fields only — `rawAccelEnabled` is a
// boolean and would break arithmetic sort comparisons if included here.
type BucketNumericKey =
  | 'sensitivity' | 'eDPI' | 'cm360' | 'sessions' | 'shots' | 'accuracy'
  | 'avgErrorDeg' | 'overshootBias' | 'trackingAccuracy' | 'compositeScore';

interface ColumnDef { key: BucketNumericKey; label: string; format: (v: number) => string; }
const COLUMNS: ColumnDef[] = [
  { key: 'sensitivity', label: 'Sens', format: fmtSens },
  { key: 'eDPI', label: 'eDPI', format: fmtEdpi },
  { key: 'cm360', label: 'cm/360', format: (v) => v.toFixed(1) },
  { key: 'sessions', label: 'Sessions', format: (v) => String(Math.round(v)) },
  { key: 'shots', label: 'Shots', format: (v) => String(Math.round(v)) },
  { key: 'accuracy', label: 'Accuracy', format: fmtPct },
  { key: 'avgErrorDeg', label: 'Avg Error°', format: (v) => v.toFixed(2) },
  { key: 'overshootBias', label: 'Overshoot°', format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}` },
  { key: 'trackingAccuracy', label: 'Tracking', format: fmtPct },
  { key: 'compositeScore', label: 'Composite', format: (v) => v.toFixed(1) },
];

function bucketTable(buckets: SensBucket[]): { el: HTMLElement; destroy: () => void } {
  let sortKey: BucketNumericKey = 'sensitivity';
  let sortAsc = true;
  const wrap = el('div', { class: 'table-scroll' });

  function render(): void {
    const sorted = [...buckets].sort((a, b) => (a[sortKey] - b[sortKey]) * (sortAsc ? 1 : -1));
    const head = el('tr', {}, COLUMNS.map((col) => el('th', {
      class: col.key === sortKey ? (sortAsc ? 'sorted-asc' : 'sorted') : '',
      onclick: () => { sortAsc = col.key === sortKey ? !sortAsc : true; sortKey = col.key; render(); },
    }, col.label)));
    const rows = sorted.map((b) => el('tr', {}, COLUMNS.map((col) => el('td', {}, col.format(b[col.key])))));
    wrap.replaceChildren(el('table', { class: 'table' }, el('thead', {}, head), el('tbody', {}, rows)));
  }
  render();
  return { el: wrap, destroy: () => {} };
}

export function createAnalyzerScreen(deps: AnalyzerScreenDeps): ScreenHandle {
  const unsubs: (() => void)[] = [];
  const initialTrack: AccelTrack = deps.rawAccelOff.recommendation != null || deps.rawAccelOn.recommendation == null ? 'off' : 'on';
  const activeTrack = new Signal<AccelTrack>(initialTrack);

  const content = el('div', {});
  const tabsHost = el('div', { class: 'track-tabs' });
  let activeCharts: (() => void)[] = [];

  function trackDataFor(track: AccelTrack): TrackData {
    return track === 'off' ? deps.rawAccelOff : deps.rawAccelOn;
  }

  function renderEmptyState(): HTMLElement {
    return el('div', { class: 'info-banner' },
      el('div', { class: 'info-banner-icon' }, 'ℹ'),
      el('div', {},
        el('div', { class: 'info-banner-title' }, 'Not Enough Data Yet'),
        el('div', { class: 'info-banner-text' }, 'Play a few sessions on this Raw Accel track and the analyzer will start recommending a sensitivity here.')));
  }

  function renderDashboard(track: AccelTrack): { el: HTMLElement; destroy: () => void } {
    const cleanup: (() => void)[] = [];
    const data = trackDataFor(track);
    const rec = data.recommendation;

    if (!rec) return { el: renderEmptyState(), destroy: () => {} };

    // ---- headline: honest about low confidence, never a guess dressed as an answer --
    const lowData = rec.confidence < LOW_CONFIDENCE;
    const headline = lowData
      ? el('div', { class: 'info-banner' },
        el('div', { class: 'info-banner-icon' }, 'ℹ'),
        el('div', {},
          el('div', { class: 'info-banner-title' }, 'Not Enough Data Yet — Keep Training'),
          el('div', { class: 'info-banner-text' },
            `Only ${rec.sessionsAnalysed} session${rec.sessionsAnalysed === 1 ? '' : 's'} (${rec.shotsAnalysed} shots) analysed on this track. `
            + 'That is too little spread across sensitivities to trust a recommendation yet — play the sweep below to fix that.')))
      : el('div', { class: 'analyzer-headline' },
        el('div', { class: 'analyzer-headline-values' },
          el('div', {},
            el('div', { class: 'analyzer-headline-value-label' }, 'Sensitivity'),
            el('div', { class: 'analyzer-headline-value' }, fmtSens(rec.recommendedSens))),
          el('div', {},
            el('div', { class: 'analyzer-headline-value-label' }, 'eDPI'),
            el('div', { class: 'analyzer-headline-value' }, fmtEdpi(rec.recommendedEDPI))),
          el('div', {},
            el('div', { class: 'analyzer-headline-value-label' }, 'cm / 360°'),
            el('div', { class: 'analyzer-headline-value' }, fmtCm(rec.recommendedCm360)))),
        confidenceMeter(rec.confidence));

    const reasoning = rec.reasoning.length > 0
      ? el('ul', { class: 'stack', style: { paddingLeft: '18px', listStyle: 'disc' } }, rec.reasoning.map((r) => el('li', { class: 'text-dim' }, r)))
      : null;

    // ---- fitted composite-score curve with sampled buckets ------------------
    const curveContainer = el('div', {});
    const curveChart = lineChart(curveContainer, {
      points: rec.curve,
      scatterOverlay: rec.buckets.map((b) => ({ x: b.sensitivity, y: b.compositeScore, label: `${fmtSens(b.sensitivity)} → ${b.compositeScore.toFixed(1)}` })),
    }, {
      width: 640, height: 300,
      xLabel: 'Sensitivity', yLabel: 'Composite Score',
      xFormat: fmtSens, yFormat: (v) => v.toFixed(0),
    });
    cleanup.push(() => curveChart.destroy());

    // ---- per-metric estimator rows -------------------------------------------
    const metricRows = el('div', { class: 'metric-row-list' }, rec.perMetric.map((m: MetricVerdict) => el('div', { class: 'metric-row' },
      el('div', { class: 'metric-row-name' }, m.metric),
      el('div', { class: 'metric-row-optimum' }, fmtSens(m.optimum)),
      confidenceBadge(m.confidence),
      el('div', { class: 'metric-row-explanation' }, m.explanation))));

    // ---- overshoot vs sensitivity: the most intuitive plot, most space ------
    const overshootContainer = el('div', {});
    const overshootData: ScatterDatum[] = rec.buckets.map((b) => ({
      x: b.sensitivity, y: b.overshootBias,
      label: `${fmtSens(b.sensitivity)}: ${b.overshootBias >= 0 ? '+' : ''}${b.overshootBias.toFixed(2)}°`,
    }));
    const overshootChart = scatterChart(overshootContainer, overshootData, {
      width: 760, height: 380,
      xLabel: 'Sensitivity', yLabel: 'Overshoot Bias (deg, + = flicks past target)',
      xFormat: fmtSens, yFormat: (v) => v.toFixed(2),
      trendLine: true, confidenceBand: true, markZeroCrossing: true, yZeroLine: true,
      defaultColor: cssVar('--chart-accent-2', '#5ce1e6'),
    });
    cleanup.push(() => overshootChart.destroy());

    // ---- metric verdict bar ---------------------------------------------------
    const verdictContainer = el('div', {});
    const verdictRows: VerdictRow[] = rec.perMetric.map((m) => ({ metric: m.metric, optimum: m.optimum, confidence: m.confidence }));
    const sensValues = [...rec.perMetric.map((m) => m.optimum), ...rec.buckets.map((b) => b.sensitivity), rec.recommendedSens];
    const domain: [number, number] = sensValues.length > 0
      ? [Math.min(...sensValues) * 0.9, Math.max(...sensValues) * 1.1]
      : [0, 1];
    let verdictChart: ChartHandle<VerdictRow[]> | null = null;
    if (verdictRows.length > 0) {
      verdictChart = metricVerdictChart(verdictContainer, verdictRows, {
        width: 760, height: 40 + verdictRows.length * 30 + 30, domain, xFormat: fmtSens,
        highlightValue: rec.recommendedSens, highlightLabel: 'Recommended',
      });
      cleanup.push(() => verdictChart?.destroy());
    }

    // ---- per-family breakdown ---------------------------------------------
    const familyCards = FAMILY_ORDER
      .map((f) => ({ family: f, fr: data.familyRecommendations[f] }))
      .filter((x): x is { family: ScenarioFamily; fr: SensRecommendation } => x.fr != null)
      .map(({ family, fr }) => el('div', { class: 'family-card' },
        el('div', { class: 'family-card-title' }, FAMILY_LABEL[family]),
        fr.confidence < LOW_CONFIDENCE
          ? el('div', { class: 'text-dim' }, 'Not enough family-specific data yet.')
          : el('div', {},
            el('div', { class: 'metric-row-optimum' }, `${fmtSens(fr.recommendedSens)} · ${fmtEdpi(fr.recommendedEDPI)} eDPI · ${fmtCm(fr.recommendedCm360)}`),
            confidenceBadge(fr.confidence))));
    const familySection = familyCards.length > 0
      ? el('div', { class: 'panel' },
        el('div', { class: 'panel-header' },
          el('div', { class: 'panel-title' }, 'Per-Family Breakdown'),
          el('div', { class: 'panel-subtitle' }, 'Optimal sensitivity can differ between clicking, tracking and peeking')),
        el('div', { class: 'family-breakdown-grid' }, familyCards))
      : null;

    // ---- guided sweep --------------------------------------------------------
    const sweepSection = rec.suggestedNextSens.length > 0
      ? el('div', { class: 'panel' },
        el('div', { class: 'panel-header' },
          el('div', { class: 'panel-title' }, 'Guided Sweep'),
          el('div', { class: 'panel-subtitle' }, 'Test these sensitivities next to sharpen the recommendation')),
        el('div', { class: 'sweep-list' }, rec.suggestedNextSens.map((s) => el('div', { class: 'sweep-item' },
          el('div', { class: 'sweep-item-value' }, fmtSens(s)),
          el('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => deps.onStartSweep(s) }, 'Start')))))
      : null;

    // ---- bucket table + export ------------------------------------------------
    const table = bucketTable(rec.buckets);
    cleanup.push(table.destroy);
    const exportRow = el('div', { class: 'export-actions' },
      el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => deps.onExportJson(track) }, 'Export JSON'),
      el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => deps.onExportCsv(track) }, 'Export CSV'));

    const dashboard = el('div', { class: 'stack' },
      headline,
      reasoning,
      el('div', { class: 'panel' },
        el('div', { class: 'panel-header' }, el('div', { class: 'panel-title' }, 'Composite Score vs. Sensitivity')),
        curveContainer),
      el('div', { class: 'panel' },
        el('div', { class: 'panel-header' }, el('div', { class: 'panel-title' }, 'Per-Metric Estimators')),
        metricRows),
      el('div', { class: 'panel' },
        el('div', { class: 'panel-header' }, el('div', { class: 'panel-title' }, 'Overshoot Bias vs. Sensitivity')),
        overshootContainer),
      verdictRows.length > 0 ? el('div', { class: 'panel' },
        el('div', { class: 'panel-header' }, el('div', { class: 'panel-title' }, 'Metric Verdicts')),
        verdictContainer) : null,
      familySection,
      sweepSection,
      el('div', { class: 'panel' },
        el('div', { class: 'panel-header' },
          el('div', { class: 'panel-title' }, 'Sensitivity Buckets'),
          exportRow),
        table.el));

    return { el: dashboard, destroy: () => { for (const fn of cleanup) fn(); } };
  }

  function renderActive(): void {
    for (const fn of activeCharts) fn();
    activeCharts = [];
    const section = renderDashboard(activeTrack.get());
    activeCharts.push(section.destroy);
    content.replaceChildren(section.el);

    tabsHost.replaceChildren(
      el('button', {
        type: 'button', class: `track-tab${activeTrack.get() === 'off' ? ' active' : ''}`,
        onclick: () => activeTrack.set('off'),
      }, 'Raw Accel Off'),
      el('button', {
        type: 'button', class: `track-tab${activeTrack.get() === 'on' ? ' active' : ''}`,
        onclick: () => activeTrack.set('on'),
      }, 'Raw Accel On'));
  }
  unsubs.push(activeTrack.subscribe(renderActive));

  const root = el('div', { class: 'screen analyzer-screen' },
    el('div', { class: 'screen-header' },
      el('div', { class: 'screen-title' }, 'Sensitivity Analyzer'),
      el('div', { class: 'screen-nav' }, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => deps.onBack() }, 'Back'))),
    el('div', { class: 'screen-body' }, tabsHost, content));

  return {
    el: root,
    destroy: () => {
      for (const fn of activeCharts) fn();
      for (const u of unsubs) u();
      root.remove();
    },
  };
}
