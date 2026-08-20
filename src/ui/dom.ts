/**
 * Tiny DOM glue. Not a framework — the game loop runs at 240fps and nothing
 * here should ever run inside it. This is only for building/updating menus,
 * forms and dashboards, which are comparatively rare, human-paced updates.
 */
import { clamp } from '@core/math';

// ------------------------------------------------------------------- el() --

export interface ElProps {
  /** className shorthand. */
  class?: string;
  style?: Partial<CSSStyleDeclaration>;
  /** Attributes that must go through setAttribute (e.g. aria-*, data-*). */
  attrs?: Record<string, string>;
  /** Any other key is set as a property when present on the node, else as an
   *  attribute. Keys starting with "on" and holding a function are wired as
   *  event listeners (e.g. `onclick`). */
  [key: string]: unknown;
}

type Child = Node | string | number | null | undefined | false;
type Children = Child | Child[];

/** Hyperscript-style element builder. No vdom — it mutates real DOM directly. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps | null,
  ...children: Children[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) applyProps(node, props);
  for (const c of children) appendChild(node, c);
  return node;
}

function applyProps(node: HTMLElement, props: ElProps): void {
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') node.className = v as string;
    else if (k === 'style') Object.assign(node.style, v as Partial<CSSStyleDeclaration>);
    else if (k === 'attrs') {
      for (const [ak, av] of Object.entries(v as Record<string, string>)) node.setAttribute(ak, av);
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k in node) {
      (node as unknown as Record<string, unknown>)[k] = v;
    } else {
      node.setAttribute(k, String(v));
    }
  }
}

function appendChild(node: Element, child: Children): void {
  if (child == null || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) appendChild(node, c);
    return;
  }
  node.appendChild(typeof child === 'string' || typeof child === 'number'
    ? document.createTextNode(String(child))
    : child);
}

export function mount(container: Element, node: Node): void {
  clear(container);
  container.appendChild(node);
}

export function clear(container: Element): void {
  while (container.firstChild) container.removeChild(container.firstChild);
}

// --------------------------------------------------------------- Signal<T> --

/** Minimal reactive box. Every screen uses these to bind live-updating text
 *  (readouts, graphs) without a render framework. */
export class Signal<T> {
  private value: T;
  private readonly subs = new Set<(v: T) => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(v: T): void {
    this.value = v;
    for (const fn of this.subs) fn(v);
  }

  /** Subscribes and immediately invokes `fn` with the current value. Returns
   *  an unsubscribe function — callers MUST call it in their destroy(). */
  subscribe(fn: (v: T) => void): () => void {
    this.subs.add(fn);
    fn(this.value);
    return () => this.subs.delete(fn);
  }
}

// -------------------------------------------------------------- controls --

/** Handle returned by every form control below, so screens can push external
 *  values in (e.g. loading a saved profile) and always clean up listeners. */
export interface FieldHandle<T> {
  el: HTMLElement;
  /** Push a value into the control without firing onChange. */
  setValue: (v: T) => void;
  destroy: () => void;
}

export interface SliderFieldOptions {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
}

/** Labelled slider + number input, kept in sync both ways: dragging the
 *  slider updates the number box and vice versa. */
export function sliderField(opts: SliderFieldOptions, onChange: (v: number) => void): FieldHandle<number> {
  const { min, max, step } = opts;
  const range = el('input', {
    type: 'range', min, max, step, value: opts.value, class: 'field-range', id: `${opts.id}-range`,
  }) as HTMLInputElement;
  const num = el('input', {
    type: 'number', min, max, step, value: opts.value, class: 'field-number', id: opts.id,
  }) as HTMLInputElement;

  const commit = (raw: number): void => {
    const v = clamp(raw, min, max);
    range.value = String(v);
    num.value = String(v);
    onChange(v);
  };
  const onRangeInput = (): void => commit(Number(range.value));
  const onNumInput = (): void => {
    if (num.value === '') return;
    const n = Number(num.value);
    if (Number.isNaN(n)) return;
    commit(n);
  };
  range.addEventListener('input', onRangeInput);
  num.addEventListener('input', onNumInput);

  const labelEl = el('label', { class: 'field-label', for: opts.id },
    opts.label, opts.unit ? el('span', { class: 'field-unit' }, opts.unit) : null);
  const wrap = el('div', { class: 'field field-slider' }, labelEl,
    el('div', { class: 'field-slider-row' }, range, num));

  return {
    el: wrap,
    setValue: (v) => { const c = clamp(v, min, max); range.value = String(c); num.value = String(c); },
    destroy: () => { range.removeEventListener('input', onRangeInput); num.removeEventListener('input', onNumInput); },
  };
}

export interface ToggleFieldOptions {
  id: string;
  label: string;
  value: boolean;
  description?: string;
}

export function toggleField(opts: ToggleFieldOptions, onChange: (v: boolean) => void): FieldHandle<boolean> {
  const input = el('input', {
    type: 'checkbox', class: 'field-toggle-input', id: opts.id, checked: opts.value,
  }) as HTMLInputElement;
  const onInputChange = (): void => onChange(input.checked);
  input.addEventListener('change', onInputChange);

  const track = el('label', { class: 'field-toggle', for: opts.id }, input, el('span', { class: 'field-toggle-track' }));
  const wrap = el('div', { class: 'field field-toggle-wrap' },
    el('div', { class: 'field-toggle-row' }, track, el('span', { class: 'field-toggle-label' }, opts.label)),
    opts.description ? el('p', { class: 'field-hint' }, opts.description) : null);

  return {
    el: wrap,
    setValue: (v) => { input.checked = v; },
    destroy: () => input.removeEventListener('change', onInputChange),
  };
}

export interface SelectOption<T extends string> { value: T; label: string; }

export function selectField<T extends string>(
  opts: { id: string; label: string; value: T; options: SelectOption<T>[] },
  onChange: (v: T) => void,
): FieldHandle<T> {
  const select = el('select', { class: 'field-select', id: opts.id },
    opts.options.map((o) => el('option', { value: o.value }, o.label))) as HTMLSelectElement;
  select.value = opts.value;
  const onSelectChange = (): void => onChange(select.value as T);
  select.addEventListener('change', onSelectChange);

  const labelEl = el('label', { class: 'field-label', for: opts.id }, opts.label);
  const wrap = el('div', { class: 'field field-select-wrap' }, labelEl, select);

  return {
    el: wrap,
    setValue: (v) => { select.value = v; },
    destroy: () => select.removeEventListener('change', onSelectChange),
  };
}

export interface NumberFieldOptions {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

/** Plain validated numeric field (no slider) — for values with no sane range
 *  to drag across, e.g. DPI. */
export function numberField(opts: NumberFieldOptions, onChange: (v: number) => void): FieldHandle<number> {
  const input = el('input', {
    type: 'number', class: 'field-number-solo', id: opts.id, value: opts.value,
    min: opts.min, max: opts.max, step: opts.step ?? 'any',
  }) as HTMLInputElement;

  const commit = (): void => {
    let v = Number(input.value);
    if (Number.isNaN(v)) return;
    if (opts.min != null) v = Math.max(opts.min, v);
    if (opts.max != null) v = Math.min(opts.max, v);
    input.value = String(v);
    onChange(v);
  };
  input.addEventListener('change', commit);

  const labelEl = el('label', { class: 'field-label', for: opts.id },
    opts.label, opts.unit ? el('span', { class: 'field-unit' }, opts.unit) : null);
  const wrap = el('div', { class: 'field field-number-wrap' }, labelEl, input);

  return {
    el: wrap,
    setValue: (v) => { input.value = String(v); },
    destroy: () => input.removeEventListener('change', commit),
  };
}
