/**
 * In-run pause overlay.
 *
 * Shown whenever pointer lock is lost — Escape, alt-tab, or the window losing
 * focus. The run's clock is stopped by the game loop, not merely hidden, so a
 * paused session records no time and no missed targets.
 */
import { el } from './dom';
import type { ScenarioDef, WeaponSpec } from '../core/types';

export interface PauseOverlayDeps {
  scenario: ScenarioDef;
  weapon: WeaponSpec;
  /** Live run stats, read fresh each time the overlay is shown. */
  stats: () => { score: number; remainingSec: number; accuracy: number; shots: number };
  onResume: () => void;
  onRestart: () => void;
  onSettings: () => void;
  /** Abandons the run. The partial session is deliberately NOT saved. */
  onQuit: () => void;
}

export interface PauseOverlayHandle {
  el: HTMLElement;
  /** Refreshes the stat readout; call each time the overlay becomes visible. */
  refresh: () => void;
  destroy: () => void;
}

const fmtTime = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function createPauseOverlay(deps: PauseOverlayDeps): PauseOverlayHandle {
  const scoreEl = el('span', { className: 'pause-stat-value' }, '0');
  const timeEl = el('span', { className: 'pause-stat-value' }, '0:00');
  const accEl = el('span', { className: 'pause-stat-value' }, '—');

  const stat = (label: string, valueEl: HTMLElement): HTMLElement =>
    el('div', { className: 'pause-stat' }, valueEl, el('span', { className: 'pause-stat-label' }, label));

  const button = (label: string, onClick: () => void, variant = ''): HTMLElement =>
    el('button', {
      className: `pause-button ${variant}`.trim(),
      type: 'button',
      onclick: onClick,
    }, label);

  const root = el('div', { className: 'pause-overlay' },
    el('div', { className: 'pause-panel' },
      el('div', { className: 'pause-header' },
        el('h2', { className: 'pause-title' }, 'PAUSED'),
        el('p', { className: 'pause-subtitle' }, `${deps.scenario.name} · ${deps.weapon.name}`),
      ),
      el('div', { className: 'pause-stats' },
        stat('Score', scoreEl),
        stat('Time Left', timeEl),
        stat('Accuracy', accEl),
      ),
      el('div', { className: 'pause-actions' },
        button('Resume', deps.onResume, 'primary'),
        button('Restart', deps.onRestart),
        button('Settings', deps.onSettings),
        button('Quit to Menu', deps.onQuit, 'danger'),
      ),
      el('p', { className: 'pause-hint' },
        'Click Resume or press Escape to re-lock the mouse. Quitting discards this run — partial runs are not saved, so they cannot skew your analyzer data.'),
    ),
  );

  const refresh = (): void => {
    const s = deps.stats();
    scoreEl.textContent = String(Math.round(s.score));
    timeEl.textContent = fmtTime(s.remainingSec);
    accEl.textContent = s.shots > 0 ? `${Math.round(s.accuracy * 100)}%` : '—';
  };

  refresh();
  return {
    el: root,
    refresh,
    destroy: () => root.remove(),
  };
}
