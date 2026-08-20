/**
 * In-game HUD overlay: plain DOM, not three.js — it needs crisp text and
 * layout, which is what the DOM is for; three.js text is a poor fit for a
 * readout that changes every frame (fps/frametime) plus every shot.
 *
 * This runs every frame (frame stats) and every shot (hit feedback), so it
 * follows one rule throughout: cache the element, cache the last value we
 * wrote, and only touch `textContent`/`style` when the displayed value
 * actually changed. Untouched DOM nodes cost nothing; needless writes cost
 * a style recalc.
 */
import type { HitZone } from '../core/types';

const ROOT_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '40',
  fontFamily: "'Din Next', 'Segoe UI', Arial, sans-serif",
  color: '#ece8e1',
  textShadow: '0 1px 2px rgba(0,0,0,0.85)',
  userSelect: 'none',
};

const ACCENT = '#ff4655';
const MUTED = '#9aa0a8';

function el(style: Partial<CSSStyleDeclaration>, text?: string): HTMLDivElement {
  const node = document.createElement('div');
  Object.assign(node.style, style);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Formats an in-flight hit-feedback message fade-out; small enough to inline rather than pull in a tween lib. */
const HIT_FEEDBACK_MS = 550;

export class Hud {
  private readonly root: HTMLDivElement;
  private container: HTMLElement | null = null;

  // --- ammo -----------------------------------------------------------
  private readonly ammoEl: HTMLDivElement;
  private lastAmmoCurrent = -1;
  private lastAmmoReserve = -1;

  // --- target health/armor --------------------------------------------
  private readonly healthBarFill: HTMLDivElement;
  private readonly armorBarFill: HTMLDivElement;
  private readonly healthText: HTMLDivElement;
  private lastHealth = -1;
  private lastMaxHealth = -1;
  private lastArmor = -1;
  private lastMaxArmor = -1;

  // --- timer ------------------------------------------------------------
  private readonly timerEl: HTMLDivElement;
  private lastTimerText = '';

  // --- score/streak -----------------------------------------------------
  private readonly scoreEl: HTMLDivElement;
  private readonly streakEl: HTMLDivElement;
  private lastScore = -1;
  private lastStreak = -1;

  // --- hit/miss feedback --------------------------------------------------
  private readonly feedbackEl: HTMLDivElement;
  private feedbackHideAt = 0;
  private feedbackVisible = false;

  // --- fps/frametime ------------------------------------------------------
  private readonly perfEl: HTMLDivElement;
  private lastFpsDisplay = -1;
  private lastFrameMsDisplay = -1;

  constructor() {
    this.root = el(ROOT_STYLE);

    this.ammoEl = el({
      position: 'absolute', right: '28px', bottom: '24px',
      fontSize: '28px', fontWeight: '700', letterSpacing: '1px', textAlign: 'right',
    });
    this.healthText = el({ position: 'absolute', left: '28px', bottom: '52px', fontSize: '13px', color: MUTED });
    const barsWrap = el({ position: 'absolute', left: '28px', bottom: '24px', width: '220px' });
    const healthBarBg = el({ width: '100%', height: '10px', background: 'rgba(255,255,255,0.12)', borderRadius: '2px', overflow: 'hidden', marginBottom: '4px' });
    this.healthBarFill = el({ width: '100%', height: '100%', background: '#e2503a', transition: 'none' });
    healthBarBg.appendChild(this.healthBarFill);
    const armorBarBg = el({ width: '100%', height: '6px', background: 'rgba(255,255,255,0.12)', borderRadius: '2px', overflow: 'hidden' });
    this.armorBarFill = el({ width: '0%', height: '100%', background: '#5fb8d6' });
    armorBarBg.appendChild(this.armorBarFill);
    barsWrap.appendChild(healthBarBg);
    barsWrap.appendChild(armorBarBg);

    this.timerEl = el({
      position: 'absolute', top: '20px', left: '50%', transform: 'translateX(-50%)',
      fontSize: '22px', fontWeight: '700', fontVariantNumeric: 'tabular-nums',
    }, '0:00');

    this.scoreEl = el({ position: 'absolute', top: '20px', right: '28px', fontSize: '20px', fontWeight: '700' }, '0');
    this.streakEl = el({
      position: 'absolute', top: '48px', right: '28px', fontSize: '13px', color: ACCENT, textAlign: 'right',
    }, '');

    this.feedbackEl = el({
      position: 'absolute', top: '58%', left: '50%', transform: 'translate(-50%, -50%)',
      fontSize: '18px', fontWeight: '700', opacity: '0', transition: 'opacity 120ms linear',
    });

    this.perfEl = el({
      position: 'absolute', top: '20px', left: '28px', fontSize: '12px', color: MUTED, fontVariantNumeric: 'tabular-nums',
    }, '-- fps');

    this.root.append(this.ammoEl, this.healthText, barsWrap, this.timerEl, this.scoreEl, this.streakEl, this.feedbackEl, this.perfEl);
  }

  mount(container: HTMLElement): void {
    this.container = container;
    container.appendChild(this.root);
  }

  setAmmo(current: number, reserve: number): void {
    if (current === this.lastAmmoCurrent && reserve === this.lastAmmoReserve) return;
    this.lastAmmoCurrent = current;
    this.lastAmmoReserve = reserve;
    this.ammoEl.textContent = `${current} / ${reserve}`;
  }

  setTargetHealth(health: number, maxHealth: number, armor: number, maxArmor: number): void {
    const healthChanged = health !== this.lastHealth || maxHealth !== this.lastMaxHealth;
    const armorChanged = armor !== this.lastArmor || maxArmor !== this.lastMaxArmor;
    if (!healthChanged && !armorChanged) return;

    if (healthChanged) {
      this.lastHealth = health;
      this.lastMaxHealth = maxHealth;
      const pct = maxHealth > 0 ? Math.max(0, Math.min(1, health / maxHealth)) * 100 : 0;
      this.healthBarFill.style.width = `${pct}%`;
      this.healthText.textContent = `${Math.max(0, Math.round(health))} HP`;
    }
    if (armorChanged) {
      this.lastArmor = armor;
      this.lastMaxArmor = maxArmor;
      const pct = maxArmor > 0 ? Math.max(0, Math.min(1, armor / maxArmor)) * 100 : 0;
      this.armorBarFill.style.width = `${pct}%`;
    }
  }

  /** `remainingSec` is clock time left in the scenario. */
  setTimer(remainingSec: number): void {
    const clamped = Math.max(0, remainingSec);
    const m = Math.floor(clamped / 60);
    const s = Math.floor(clamped % 60);
    const text = `${m}:${s.toString().padStart(2, '0')}`;
    if (text === this.lastTimerText) return;
    this.lastTimerText = text;
    this.timerEl.textContent = text;
  }

  setScore(score: number): void {
    if (score === this.lastScore) return;
    this.lastScore = score;
    this.scoreEl.textContent = Math.round(score).toString();
  }

  setStreak(streak: number): void {
    if (streak === this.lastStreak) return;
    this.lastStreak = streak;
    this.streakEl.textContent = streak > 1 ? `${streak}x streak` : '';
  }

  /** Flashes a brief hit/miss/headshot indicator. Call once per shot. */
  showHitFeedback(hit: boolean, zone?: HitZone): void {
    const label = !hit ? 'MISS' : zone === 'head' ? 'HEADSHOT' : 'HIT';
    this.feedbackEl.textContent = label;
    this.feedbackEl.style.color = !hit ? MUTED : zone === 'head' ? ACCENT : '#ece8e1';
    this.feedbackEl.style.opacity = '1';
    this.feedbackVisible = true;
    this.feedbackHideAt = performance.now() + HIT_FEEDBACK_MS;
  }

  /** Frame stats change every frame — this is the one HUD field genuinely called every frame; rounding keeps writes rare. */
  setFrameStats(fps: number, frameTimeMs: number): void {
    const fpsRounded = Math.round(fps);
    const frameMsRounded = Math.round(frameTimeMs * 10) / 10;
    if (fpsRounded === this.lastFpsDisplay && frameMsRounded === this.lastFrameMsDisplay) {
      this.tickFeedbackFade();
      return;
    }
    this.lastFpsDisplay = fpsRounded;
    this.lastFrameMsDisplay = frameMsRounded;
    this.perfEl.textContent = `${fpsRounded} fps · ${frameMsRounded.toFixed(1)} ms`;
    this.tickFeedbackFade();
  }

  private tickFeedbackFade(): void {
    if (!this.feedbackVisible) return;
    if (performance.now() >= this.feedbackHideAt) {
      this.feedbackEl.style.opacity = '0';
      this.feedbackVisible = false;
    }
  }

  dispose(): void {
    if (this.container && this.root.parentElement === this.container) {
      this.container.removeChild(this.root);
    }
  }
}
