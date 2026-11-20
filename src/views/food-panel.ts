/**
 * Панель «Еда для бактерий» рядом с чашкой Петри и полем микроскопа: разрез чашки (нижний питательный агар с
 * крупинками еды и тонкий верхний слой с бактериями) и полоски «сколько еды осталось».
 * Крупинки исчезают по мере того, как бактерии съедают питание, — так видно, почему
 * газон перестаёт расти.
 */
import { Container, Graphics, Text, type TextStyleOptions } from 'pixi.js';
import { type PlateModel, lawnOpacity } from '../core/plate/model';
import type { MicroscopeModel } from '../core/microscope/model';
import { COLORS, lerpColor } from './palette';
import { hash2 } from './hash';

const FONT = 'Inter, Segoe UI, Roboto, Helvetica, sans-serif';
const AGAR_RICH = 0xb98232;
const AGAR_EMPTY = 0x57544d;
const GRAIN = 0xffd166;
const BACTERIUM = 0xe8e2cf;
const GRAINS = 56;
const BACTERIA = 60;

function style(o: TextStyleOptions): TextStyleOptions {
  return { fontFamily: FONT, fill: COLORS.text, fontSize: 12, ...o };
}

/** Детерминированная «случайность» для расстановки крупинок и бактерий. */
function rnd(i: number, k: number): number {
  return hash2(i, k, 29);
}

/** Что показать на панели — не зависит от того, чашка это или поле микроскопа. */
export interface FoodData {
  /** Меняется, когда надо перерисовать. */
  key: string;
  /** Доля оставшегося питания 0..1 (то, что в разрезе). */
  food: number;
  /** Относительная скорость роста бактерий 0..1. */
  growth: number;
  /** Питание вообще расходуется (иначе — опыт «понарошку»). */
  depletes: boolean;
  /** Сколько бактерий рисовать в верхнем слое разреза, 0..1. */
  density: number;
  /** Полоски «еды осталось»: одна на каждый вариант условий. */
  entries: { label: string; food: number }[];
  /** Подпись варианта, показанного в разрезе (если вариантов несколько). */
  primaryLabel: string;
}

/** Данные для панели из модели чашки Петри. */
export function plateFoodData(m: PlateModel, primary: number): FoodData | null {
  const ps = m.plates[primary];
  if (!ps) return null;
  const group = m.groups[ps.group];
  return {
    key: `${m.version}:${primary}`,
    food: group.lawn.food,
    growth: group.lawn.g,
    depletes: group.mech.substrateDepletion,
    density: lawnOpacity(group.lawn.S),
    entries: m.groupRepresentatives().map((pi) => {
      const g = m.plates[pi].group;
      return { label: m.groupLabel(g), food: m.groups[g].lawn.food };
    }),
    primaryLabel: m.groupLabel(ps.group),
  };
}

/** Данные для панели из модели микроскопа (питание общее для всего поля). */
export function microFoodData(m: MicroscopeModel): FoodData {
  const food = m.food;
  // Насколько густо бактерии покрывают поле: 1 — сплошь.
  let area = 0;
  for (const c of m.cells) area += c.len * m.rates.cellWidth;
  const density = Math.min(1, (3 * area) / (m.cond.width * m.cond.height));
  return {
    key: `${m.t.toFixed(2)}:${m.cells.length}`,
    food,
    growth: m.relGrowth,
    depletes: m.mech.substrateDepletion,
    density: Math.max(m.cells.length ? 0.08 : 0, density),
    entries: [{ label: '', food }],
    primaryLabel: '',
  };
}

export class FoodPanel extends Container {
  private bg = new Graphics();
  private pic = new Graphics();
  private bars = new Graphics();
  private title: Text;
  private lblTop: Text;
  private lblBottom: Text;
  private barLabels: Text[] = [];
  private barValues: Text[] = [];
  private status: Text;
  private w = 270;
  /** Высота панели после последнего обновления. */
  panelH = 0;
  /** Что нарисовано сейчас — чтобы не перерисовывать, пока ничего не изменилось (например, на паузе). */
  private drawnModel: object | null = null;
  private drawnKey = '';

  constructor() {
    super();
    this.title = new Text({ text: 'ЕДА ДЛЯ БАКТЕРИЙ', style: style({ fontSize: 11, fill: COLORS.muted, letterSpacing: 1 }) });
    this.lblTop = new Text({ text: 'бактерии', style: style({ fontSize: 11.5, fill: COLORS.muted }) });
    this.lblBottom = new Text({ text: 'агар\nс едой', style: style({ fontSize: 11.5, fill: COLORS.muted, lineHeight: 14 }) });
    this.status = new Text({ text: '', style: style({ fontSize: 12.5, wordWrap: true, wordWrapWidth: this.w - 28, lineHeight: 17 }) });
    this.addChild(this.bg, this.pic, this.bars, this.title, this.lblTop, this.lblBottom, this.status);
  }

  /** Подписи для n полосок (по одной на вариант условий) — заводим по мере надобности. */
  private ensureBars(n: number): void {
    while (this.barLabels.length < n) {
      const l = new Text({ text: '', style: style({ fontSize: 12, fill: COLORS.muted }) });
      const v = new Text({ text: '', style: style({ fontSize: 12, fontWeight: '600' }) });
      v.anchor.set(1, 0);
      this.barLabels.push(l);
      this.barValues.push(v);
      this.addChild(l, v);
    }
  }

  setWidth(w: number): void {
    if (w === this.w) return;
    this.w = w;
    this.status.style.wordWrapWidth = w - 28;
    this.drawnKey = '';
  }

  /** Перерисовать, если что-то изменилось. primary — чашка, которую показываем в разрезе. */
  update(m: PlateModel, primary: number): void {
    const d = plateFoodData(m, primary);
    if (d) this.draw(m, d);
  }

  /** owner — модель, к которой относятся данные (смена модели — всегда перерисовка). */
  draw(owner: object, d: FoodData): void {
    const w = this.w;
    const pad = 14;
    if (owner === this.drawnModel && d.key === this.drawnKey) return;
    this.drawnModel = owner;
    this.drawnKey = d.key;
    const food = d.food;
    const depletes = d.depletes;

    this.title.position.set(pad, 12);

    // ---- разрез чашки
    const x0 = pad;
    const y0 = 36;
    const dw = w - 2 * pad - 78;
    const dh = 64;
    const bottomH = 36;
    const topH = 14;
    const yb = y0 + dh - 2 - bottomH;
    const yt = yb - topH;
    const g = this.pic.clear();
    g.rect(x0 + 2, yb, dw - 4, bottomH).fill({ color: lerpColor(AGAR_EMPTY, AGAR_RICH, food) });
    g.rect(x0 + 2, yt, dw - 4, topH).fill({ color: lerpColor(AGAR_EMPTY, AGAR_RICH, food), alpha: 0.55 });
    // Крупинки еды: исчезают по одной в случайном порядке.
    for (let i = 0; i < GRAINS; i++) {
      if (rnd(i, 1) >= food) continue;
      const inTop = rnd(i, 2) < 0.2;
      const x = x0 + 5 + rnd(i, 3) * (dw - 10);
      const y = inTop ? yt + 3 + rnd(i, 4) * (topH - 6) : yb + 3 + rnd(i, 4) * (bottomH - 6);
      g.circle(x, y, 1.7).fill({ color: GRAIN, alpha: 0.95 });
    }
    // Бактерии в верхнем слое: их становится больше, пока есть еда.
    const nb = Math.round(BACTERIA * d.density);
    for (let i = 0; i < nb; i++) {
      const x = x0 + 5 + rnd(i, 5) * (dw - 14);
      const y = yt + 3 + rnd(i, 6) * (topH - 6);
      const color = d.growth < 0.3 ? lerpColor(BACTERIUM, 0x8f8a7c, 0.6) : BACTERIUM;
      g.roundRect(x, y - 1, 5, 2.4, 1.2).fill({ color });
    }
    // Стеклянная чашка: дно и стенки.
    g.moveTo(x0, y0).lineTo(x0, y0 + dh).lineTo(x0 + dw, y0 + dh).lineTo(x0 + dw, y0)
      .stroke({ width: 2, color: 0xa9bcc7, alpha: 0.55 });
    // Выноски к подписям.
    const lx = x0 + dw + 6;
    g.moveTo(x0 + dw - 6, yt + topH / 2).lineTo(lx + 4, yt + topH / 2).stroke({ width: 1, color: COLORS.muted, alpha: 0.6 });
    g.moveTo(x0 + dw - 6, yb + bottomH / 2).lineTo(lx + 4, yb + bottomH / 2).stroke({ width: 1, color: COLORS.muted, alpha: 0.6 });
    this.lblTop.position.set(lx + 8, yt + topH / 2 - 8);
    this.lblBottom.position.set(lx + 8, yb + bottomH / 2 - 14);

    // ---- полоски «сколько еды осталось» (по одной на каждый вариант условий)
    const entries = d.entries;
    const many = entries.length > 1;
    this.ensureBars(entries.length);
    const b = this.bars.clear();
    let y = y0 + dh + 12;
    const bw = w - 2 * pad;
    this.barLabels.forEach((t, i) => {
      const e = entries[i];
      const v = this.barValues[i];
      t.visible = v.visible = !!e;
      if (!e) return;
      const pct = Math.round(e.food * 100);
      t.text = many ? `${e.label}: еды осталось` : 'еды осталось';
      v.text = `${pct} %`;
      t.position.set(pad, y);
      v.position.set(pad + bw, y);
      b.roundRect(pad, y + 18, bw, 8, 4).fill({ color: 0x1b2732 });
      // Полоска видна, только пока подпись не «0 %» — иначе она спорит со словами «еда кончилась».
      if (pct > 0) b.roundRect(pad, y + 18, Math.max(8, bw * e.food), 8, 4).fill({ color: lerpColor(AGAR_EMPTY, GRAIN, e.food) });
      y += 34;
    });

    // ---- что происходит
    let text: string;
    if (!depletes) text = 'Здесь еда не кончается — так бывает только «понарошку».';
    else if (food > 0.6) text = 'Бактерии едят питание из агара и делятся.';
    else if (d.growth > 0.7) text = 'Еды становится меньше, но бактерии пока растут.';
    else if (d.growth > 0.2) text = 'Еды мало — бактерии делятся медленнее.';
    else text = 'Еда кончилась — бактерии голодают и больше не делятся.';
    if (many) text = `${d.primaryLabel}: ${text[0].toLowerCase()}${text.slice(1)}`;
    this.status.text = text;
    this.status.position.set(pad, y + 2);
    this.panelH = Math.round(y + 2 + this.status.height + 12);

    this.bg.clear()
      .roundRect(0, 0, w, this.panelH, 10).fill({ color: 0x0a1016, alpha: 0.88 })
      .roundRect(0, 0, w, this.panelH, 10).stroke({ width: 1, color: 0x1f2d38 });
  }
}
