/** Поле числового параметра: подпись, подсказка, текстовый ввод, единицы и ползунок. */
import { h } from './dom';
import { infoIcon, type TipContent } from './tooltip';
import { fmtParam, parseNumber } from './format';

export interface NumberFieldOptions {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  scale: 'linear' | 'log';
  defaultValue?: number;
  allowZero?: boolean;
  tip: TipContent | (() => TipContent);
  sub?: string;
  onChange: (v: number) => void;
}

const SLIDER_STEPS = 400;

export function numberField(o: NumberFieldOptions): HTMLElement {
  const toSlider = (v: number): number => {
    if (o.scale === 'log') {
      const lv = Math.log10(Math.max(o.min, v));
      return ((lv - Math.log10(o.min)) / (Math.log10(o.max) - Math.log10(o.min))) * SLIDER_STEPS;
    }
    return ((v - o.min) / (o.max - o.min)) * SLIDER_STEPS;
  };
  const fromSlider = (s: number): number => {
    const k = s / SLIDER_STEPS;
    // У логарифмической шкалы нет нуля: крайнее левое положение означает 0, если он разрешён (MOI = 0 — контроль).
    if (o.scale === 'log' && o.allowZero && s <= 0) return 0;
    if (o.scale === 'log') {
      const v = Math.pow(10, Math.log10(o.min) + k * (Math.log10(o.max) - Math.log10(o.min)));
      // Округляем до 2 значащих цифр — удобные «лабораторные» значения.
      return Number(v.toPrecision(2));
    }
    const v = o.min + k * (o.max - o.min);
    return o.step > 0 ? Math.round(v / o.step) * o.step : v;
  };
  const clamp = (v: number) => (o.allowZero && v === 0 ? 0 : Math.min(o.max, Math.max(o.min, v)));
  const fmt = (v: number) => (v === 0 ? '0' : fmtParam(v, o.scale, o.step));

  // data-fkey — по нему боковая панель возвращает фокус в то же поле после перерисовки.
  const input = h('input', { type: 'text', value: fmt(o.value), 'aria-label': o.label, spellcheck: false, 'data-fkey': `${o.label}:text` });
  const slider = h('input', {
    type: 'range', min: 0, max: SLIDER_STEPS, step: 1, value: String(toSlider(o.value)), 'aria-label': o.label, 'data-fkey': `${o.label}:range`,
  });
  let current = o.value;
  const apply = (c: number) => {
    if (c === current) return; // ничего не изменилось — не перезапускаем опыт
    current = c;
    o.onChange(c);
  };
  const changed = o.defaultValue !== undefined && Math.abs(o.value - o.defaultValue) > 1e-12 * Math.max(1, Math.abs(o.defaultValue));
  const field = h(
    'div',
    { class: `field${changed ? ' changed' : ''}` },
    h('label', {}, infoIcon(o.tip), o.label),
    h('div', { class: 'ctl' }, input, h('span', { class: 'unit' }, o.unit)),
    slider,
    o.sub ? h('div', { class: 'sub' }, o.sub) : null,
  );

  slider.addEventListener('input', () => {
    input.value = fmt(fromSlider(Number(slider.value)));
  });
  slider.addEventListener('change', () => {
    const c = clamp(fromSlider(Number(slider.value)));
    input.value = fmt(c);
    apply(c);
  });
  const commit = () => {
    const v = parseNumber(input.value);
    if (!Number.isFinite(v)) {
      input.value = fmt(current);
      return;
    }
    const c = clamp(v);
    input.value = fmt(c);
    slider.value = String(toSlider(c));
    apply(c);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
  return field;
}

export function switchField(label: string, checked: boolean, tip: TipContent, onChange: (v: boolean) => void): HTMLElement {
  const cb = h('input', { type: 'checkbox', checked, 'data-fkey': `${label}:switch` });
  cb.addEventListener('change', () => onChange(cb.checked));
  return h(
    'label',
    { class: 'toggle' },
    h('span', { class: 'switch' }, cb, h('span', {})),
    h('span', {}, label),
    infoIcon(tip),
  );
}
