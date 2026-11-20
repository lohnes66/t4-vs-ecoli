/** Всплывающие подсказки к параметрам: значение, единицы, литературный диапазон, источники. */
import { h, clear } from './dom';

let tip: HTMLDivElement | null = null;

function ensure(): HTMLDivElement {
  if (!tip) {
    tip = h('div', { class: 'tooltip', role: 'tooltip' });
    tip.style.display = 'none';
    document.body.append(tip);
  }
  return tip;
}

export interface TipContent {
  title: string;
  value?: string;
  range?: string;
  body?: string;
  sources?: string[];
  check?: string;
}

function show(anchor: HTMLElement, c: TipContent): void {
  const t = ensure();
  clear(t);
  t.append(h('h4', {}, c.title));
  if (c.value) t.append(h('div', { class: 'val' }, c.value));
  if (c.range) t.append(h('div', { class: 'rng' }, 'Литература: ', c.range));
  if (c.body) t.append(h('div', {}, c.body));
  if (c.sources?.length) {
    t.append(h('div', { class: 'src' }, h('b', {}, 'Источники:'), ...c.sources.map((s) => h('div', {}, s))));
  }
  if (c.check) t.append(h('div', { class: 'check' }, c.check));
  t.style.display = 'block';
  const r = anchor.getBoundingClientRect();
  const tw = t.offsetWidth;
  const th = t.offsetHeight;
  let x = r.left - tw - 10;
  if (x < 8) x = Math.min(window.innerWidth - tw - 8, r.right + 10);
  let y = r.top - 8;
  if (y + th > window.innerHeight - 8) y = window.innerHeight - th - 8;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}

function hide(): void {
  if (tip) tip.style.display = 'none';
}

/** Значок «i», показывающий подсказку при наведении и при фокусе с клавиатуры. */
export function infoIcon(content: TipContent | (() => TipContent)): HTMLElement {
  const el = h('i', { class: 'info', tabindex: 0, 'aria-label': 'Подсказка' }, 'i');
  const get = () => (typeof content === 'function' ? content() : content);
  el.addEventListener('mouseenter', () => show(el, get()));
  el.addEventListener('focus', () => show(el, get()));
  el.addEventListener('mouseleave', hide);
  el.addEventListener('blur', hide);
  return el;
}
