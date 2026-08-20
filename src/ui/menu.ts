/**
 * Main menu: scenario browser, weapon picker, quick-start, and nav to the
 * other screens. Every dependency is injected — this file never touches
 * storage or the game loop directly.
 */
import type { ScenarioDef, ScenarioFamily, WeaponSpec } from '@core/types';
import { el, Signal } from './dom';

export interface LastPlayed { scenarioId: string; weaponId: string; }

export type MenuNavTarget = 'settings' | 'analyzer' | 'history';

/**
 * Integration seam for the menu screen. The supervisor wires the real
 * scenario/weapon catalogues, personal-best lookups, and navigation actions.
 */
export interface MenuScreenDeps {
  scenarios: ScenarioDef[];
  weapons: WeaponSpec[];
  /** Best score recorded per scenario id. A scenario absent from the map has never been played. */
  personalBests: Map<string, number>;
  /** Null when the player has never started a session. */
  lastPlayed: LastPlayed | null;
  onStart: (scenarioId: string, weaponId: string) => void;
  onNavigate: (target: MenuNavTarget) => void;
}

export interface ScreenHandle {
  el: HTMLElement;
  destroy: () => void;
}

const FAMILY_ORDER: ScenarioFamily[] = ['clicking', 'tracking', 'peek'];
const FAMILY_LABEL: Record<ScenarioFamily, string> = {
  clicking: 'Clicking',
  tracking: 'Tracking',
  peek: 'Peeking',
};

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function createMenuScreen(deps: MenuScreenDeps): ScreenHandle {
  const weaponsById = new Map(deps.weapons.map((w) => [w.id, w]));
  const scenariosById = new Map(deps.scenarios.map((s) => [s.id, s]));
  const unsubs: (() => void)[] = [];

  const defaultWeaponId = deps.lastPlayed?.weaponId ?? deps.weapons[0]?.id ?? '';
  const selectedWeapon = new Signal<string>(defaultWeaponId);

  /** A scenario may not permit the globally-selected weapon; fall back to its own default. */
  const resolveWeapon = (scenario: ScenarioDef): string => {
    const w = selectedWeapon.get();
    return scenario.weapons.includes(w) ? w : scenario.weapons[0];
  };

  // ---- weapon picker ---------------------------------------------------
  const weaponPicker = el('div', { class: 'weapon-picker' });
  function renderWeaponPicker(): void {
    weaponPicker.replaceChildren(...deps.weapons.map((w) => el('button', {
      type: 'button',
      class: `weapon-picker-option${w.id === selectedWeapon.get() ? ' active' : ''}`,
      onclick: () => selectedWeapon.set(w.id),
    }, w.name)));
  }

  // ---- scenario cards ----------------------------------------------------
  function scenarioCard(scenario: ScenarioDef): HTMLElement {
    const pb = deps.personalBests.get(scenario.id);
    const weapon = weaponsById.get(resolveWeapon(scenario));
    return el('button', {
      type: 'button',
      class: 'scenario-card',
      onclick: () => deps.onStart(scenario.id, resolveWeapon(scenario)),
    },
      el('div', { class: 'scenario-card-name' }, scenario.name),
      el('div', { class: 'scenario-card-desc' }, scenario.description),
      el('div', { class: 'scenario-card-meta' },
        el('span', {}, formatDuration(scenario.durationSec)),
        el('span', {}, weapon?.name ?? 'Unknown weapon'),
        el('span', {}, `${scenario.targetCount} target${scenario.targetCount === 1 ? '' : 's'}`)),
      el('div', { class: 'scenario-card-pb' },
        el('span', { class: 'text-faint' }, 'Personal Best'),
        el('span', { class: 'scenario-card-pb-value' }, pb != null ? pb.toLocaleString() : '—')));
  }

  const familySections = el('div', { class: 'stack' });
  function renderFamilies(): void {
    const sections = FAMILY_ORDER
      .map((family) => ({ family, list: deps.scenarios.filter((s) => s.family === family) }))
      .filter(({ list }) => list.length > 0)
      .map(({ family, list }) => el('div', { class: 'scenario-family' },
        el('div', { class: 'scenario-family-title' },
          el('span', { class: `badge badge-family-${family}` }, FAMILY_LABEL[family])),
        el('div', { class: 'scenario-grid' }, list.map((s) => scenarioCard(s)))));
    familySections.replaceChildren(...sections);
  }

  // Both views depend on the selected weapon (card meta + PB context), so a
  // single signal drives both re-renders and Signal.subscribe fires once
  // immediately, giving us the first paint for free.
  unsubs.push(selectedWeapon.subscribe(renderWeaponPicker));
  unsubs.push(selectedWeapon.subscribe(renderFamilies));

  // ---- quick-start hero --------------------------------------------------
  let hero: HTMLElement | null = null;
  if (deps.lastPlayed) {
    const lp = deps.lastPlayed;
    const scenario = scenariosById.get(lp.scenarioId);
    const weapon = weaponsById.get(lp.weaponId);
    if (scenario) {
      hero = el('div', { class: 'menu-hero' },
        el('div', {},
          el('div', { class: 'menu-hero-eyebrow' }, 'Continue Training'),
          el('div', { class: 'menu-hero-title' }, scenario.name),
          el('div', { class: 'menu-hero-meta' }, `${weapon?.name ?? 'Unknown weapon'} — ${formatDuration(scenario.durationSec)}`)),
        el('button', {
          type: 'button',
          class: 'btn btn-primary',
          onclick: () => deps.onStart(lp.scenarioId, lp.weaponId),
        }, 'Play Again'));
    }
  }

  const nav = el('div', { class: 'screen-nav' },
    el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => deps.onNavigate('history') }, 'History'),
    el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => deps.onNavigate('analyzer') }, 'Analyzer'),
    el('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => deps.onNavigate('settings') }, 'Settings'));

  const root = el('div', { class: 'screen menu-screen' },
    el('div', { class: 'screen-header' },
      el('div', { class: 'screen-title' }, 'Aim ', el('span', { class: 'screen-title-accent' }, 'Trainer')),
      nav),
    el('div', { class: 'screen-body' },
      hero,
      el('div', { class: 'panel' },
        el('div', { class: 'panel-header' },
          el('div', { class: 'panel-title' }, 'Weapon'),
          el('div', { class: 'panel-subtitle' }, 'Used when a scenario allows it')),
        weaponPicker),
      familySections));

  return {
    el: root,
    destroy: () => {
      for (const u of unsubs) u();
      root.remove();
    },
  };
}
