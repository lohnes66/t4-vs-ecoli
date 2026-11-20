/** Цветовая схема состояний клетки — общая для всех модулей (раздел «Визуальное оформление»). */
export const COLORS = {
  background: 0x030507,
  sensitive: 0x5fd38d, // чувствительная, растущая — холодный зелёный
  starving: 0x7f9787, // чувствительная, голодающая — тусклый серо-зелёный
  infectedEarly: 0x9fd36a, // начало латентного периода — ещё зелёная
  infectedMid: 0xf0a43a, // середина — янтарный
  infectedLate: 0xef5d5d, // перед лизисом — красный
  lysisInhibited: 0xff4d5e, // торможение лизиса — пульсирующий красный
  resistant: 0xa77bf3, // устойчивая (OmpC⁻) — фиолетовый
  debris: 0x8a929a, // обломки после лизиса — серый
  phage: 0x4cc9f0, // поле фага — голубое свечение
  text: 0xd8e3ea,
  muted: 0x7f909c,
  line: 0x1b2732,
};

export const CSS_COLORS = {
  S: '#5fd38d',
  starving: '#7f9787',
  I: '#f0a43a',
  LI: '#ff4d5e',
  R: '#a77bf3',
  P: '#4cc9f0',
  Pr: '#9be7ff',
  debris: '#8a929a',
  titer: '#e8eef2',
  od: '#e8e2cf',
  N: '#c9b37a',
};

/** Цвета линий на графиках со сравнением чашек: первая линия — своим цветом, остальные — отсюда, все разные. */
const CHART_SERIES = ['#4cc9f0', '#ef5d5d', '#a77bf3', '#5fd38d', '#f0a43a', '#9be7ff'];

export function seriesColor(k: number, first: string): string {
  return k === 0 ? first : CHART_SERIES[(k - 1) % CHART_SERIES.length];
}

export function lerpColor(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (
    (Math.round(ar + (br - ar) * k) << 16) | (Math.round(ag + (bg - ag) * k) << 8) | Math.round(ab + (bb - ab) * k)
  );
}

/** Цвет заражённой клетки по доле пройденного латентного периода: зелёный → янтарный → красный. */
export function infectedColor(progress: number): number {
  if (progress < 0.5) return lerpColor(COLORS.infectedEarly, COLORS.infectedMid, progress * 2);
  return lerpColor(COLORS.infectedMid, COLORS.infectedLate, (progress - 0.5) * 2);
}
