/**
 * Raw mouse/keyboard capture for the trainer. This is the one place in the
 * app allowed to touch the DOM/window on the input side (see the "no three,
 * no DOM" rule in core/types.ts) - everything it emits is the plain
 * `RawMouseDelta` shape core/sensitivity.ts already expects.
 */
import type { RawMouseDelta } from '../core/types';

export type KeyName = 'w' | 'a' | 's' | 'd' | 'shift' | 'ctrl' | 'space' | 'r' | '1' | '2' | '3';
export type MouseButton = 0 | 1 | 2;

type DeltaListener = (d: RawMouseDelta) => void;
type KeyListener = (key: KeyName) => void;
type ButtonListener = (button: MouseButton) => void;

const KEY_MAP: Record<string, KeyName> = {
  KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
  ShiftLeft: 'shift', ShiftRight: 'shift',
  ControlLeft: 'ctrl', ControlRight: 'ctrl',
  Space: 'space', KeyR: 'r',
  Digit1: '1', Digit2: '2', Digit3: '3',
};

/** First movement sample after a (re)lock has no prior timestamp to diff against. */
const FIRST_SAMPLE_DT_MS = 1;

export class RawInput {
  private readonly el: HTMLElement;
  private _isRawSupported = false;
  private locked = false;
  private lastEventTime: number | null = null;

  private readonly keys = new Set<KeyName>();
  private readonly buttons = new Set<MouseButton>();

  private readonly deltaListeners = new Set<DeltaListener>();
  private readonly keyDownListeners = new Set<KeyListener>();
  private readonly keyUpListeners = new Set<KeyListener>();
  private readonly buttonDownListeners = new Set<ButtonListener>();
  private readonly buttonUpListeners = new Set<ButtonListener>();

  constructor(el: HTMLElement) {
    this.el = el;
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('pointerlockerror', this.onLockError);
    // getCoalescedEvents is only defined on PointerEvent, not MouseEvent -
    // pointermove (with pointer lock active) is the actual API surface that
    // exposes the sub-frame samples a mousemove listener would silently drop.
    el.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    el.addEventListener('mousedown', this.handleMouseDown);
    el.addEventListener('mouseup', this.handleMouseUp);
  }

  /** True once pointer lock is known to have been granted with unadjusted (OS-acceleration-free) movement. */
  get isRawSupported(): boolean {
    return this._isRawSupported;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  async requestLock(): Promise<void> {
    try {
      // Chrome/Edge honour `unadjustedMovement`; Firefox/Safari reject the
      // options-overload outright (NotSupportedError), which is the only
      // reliable way to feature-detect this - there is no capability flag.
      await this.el.requestPointerLock({ unadjustedMovement: true });
      this._isRawSupported = true;
    } catch {
      this._isRawSupported = false;
      try {
        await this.el.requestPointerLock();
      } catch {
        // Pointer lock unsupported/denied entirely; pointerlockerror handles cleanup.
      }
    }
  }

  release(): void {
    if (document.pointerLockElement === this.el) document.exitPointerLock();
  }

  dispose(): void {
    this.release();
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('pointerlockerror', this.onLockError);
    this.el.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    this.el.removeEventListener('mousedown', this.handleMouseDown);
    this.el.removeEventListener('mouseup', this.handleMouseUp);
  }

  onDelta(fn: DeltaListener): () => void {
    this.deltaListeners.add(fn);
    return () => this.deltaListeners.delete(fn);
  }

  onKeyDown(fn: KeyListener): () => void {
    this.keyDownListeners.add(fn);
    return () => this.keyDownListeners.delete(fn);
  }

  onKeyUp(fn: KeyListener): () => void {
    this.keyUpListeners.add(fn);
    return () => this.keyUpListeners.delete(fn);
  }

  onButtonDown(fn: ButtonListener): () => void {
    this.buttonDownListeners.add(fn);
    return () => this.buttonDownListeners.delete(fn);
  }

  onButtonUp(fn: ButtonListener): () => void {
    this.buttonUpListeners.add(fn);
    return () => this.buttonUpListeners.delete(fn);
  }

  isKeyDown(key: KeyName): boolean {
    return this.keys.has(key);
  }

  isButtonDown(button: MouseButton): boolean {
    return this.buttons.has(button);
  }

  private readonly onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.el;
    if (!this.locked) {
      this._isRawSupported = false;
      this.lastEventTime = null; // next lock starts a fresh dt baseline
    }
  };

  private readonly onLockError = (): void => {
    this.locked = false;
    this._isRawSupported = false;
  };

  private readonly handlePointerMove = (e: PointerEvent): void => {
    if (!this.locked) return;
    const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const events = coalesced.length > 0 ? coalesced : [e];
    for (const ev of events) {
      const t = ev.timeStamp;
      const dtMs = this.lastEventTime === null ? FIRST_SAMPLE_DT_MS : t - this.lastEventTime;
      this.lastEventTime = t;
      const delta: RawMouseDelta = {
        dx: ev.movementX,
        dy: ev.movementY,
        dtMs,
        unadjusted: this._isRawSupported,
      };
      for (const listener of this.deltaListeners) listener(delta);
    }
  };

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    const key = KEY_MAP[e.code];
    if (!key || this.keys.has(key)) return; // ignore OS key-repeat
    this.keys.add(key);
    for (const l of this.keyDownListeners) l(key);
  };

  private readonly handleKeyUp = (e: KeyboardEvent): void => {
    const key = KEY_MAP[e.code];
    if (!key) return;
    this.keys.delete(key);
    for (const l of this.keyUpListeners) l(key);
  };

  private readonly handleMouseDown = (e: MouseEvent): void => {
    const button = e.button as MouseButton;
    if (this.buttons.has(button)) return;
    this.buttons.add(button);
    for (const l of this.buttonDownListeners) l(button);
  };

  private readonly handleMouseUp = (e: MouseEvent): void => {
    const button = e.button as MouseButton;
    this.buttons.delete(button);
    for (const l of this.buttonUpListeners) l(button);
  };
}
