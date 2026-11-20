/**
 * Растеризация чашки Петри в картинку: газон с зернистостью микроколоний, бляшки по
 * рассчитанным профилям мутности. Считается на процессоре для видимой части чашки
 * в экранном разрешении — поэтому при увеличении видны ореол и неровности газона.
 */
import { type PlateModel, DISH_RADIUS_MM, DROP_RADIUS_MM } from '../core/plate/model';
import { hash2 } from './hash';

/** Какую часть чашки и с каким разрешением рисуем. */
export interface RasterRect {
  /** Координаты левого верхнего пикселя в мм от центра чашки. */
  x0: number;
  y0: number;
  /** мм на пиксель. */
  mmPerPx: number;
  w: number;
  h: number;
}

/** Гладкий «шум значений» с периодом решётки cell (мм). */
function valueNoise(x: number, y: number, cell: number, seed: number): number {
  const fx = x / cell;
  const fy = y / cell;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Шаг и радиус микроколоний газона, мм. */
const COLONY_STEP = 0.045;
const COLONY_R = 0.017;

/** Яркость газона из микроколоний: круглые зёрнышки со случайным положением и размером. */
function microcolonies(x: number, y: number, seed: number): number {
  const fx = x / COLONY_STEP;
  const fy = y / COLONY_STEP;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  let v = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const cx = ix + di;
      const cy = iy + dj;
      const px = (cx + hash2(cx, cy, seed + 11)) * COLONY_STEP;
      const py = (cy + hash2(cx, cy, seed + 12)) * COLONY_STEP;
      const rc = COLONY_R * (0.6 + 0.8 * hash2(cx, cy, seed + 13));
      const d2 = ((x - px) * (x - px) + (y - py) * (y - py)) / (rc * rc);
      if (d2 < 4) v = Math.max(v, Math.exp(-d2 * d2 * 0.5));
    }
  }
  // Между микроколониями — тонкий слой мутного агара.
  return 0.55 + 0.7 * v;
}

/**
 * Неизменная для данного кадрирования часть картинки: маска чашки и «фактура» газона.
 * Пересчитывается только при сдвиге или увеличении.
 */
export class PlateBackdrop {
  readonly mask: Float32Array;
  readonly texture: Float32Array;
  readonly light: Float32Array;

  constructor(readonly rect: RasterRect, seed: number) {
    const { w, h, x0, y0, mmPerPx } = rect;
    const n = w * h;
    this.mask = new Float32Array(n);
    this.texture = new Float32Array(n);
    this.light = new Float32Array(n);
    const R = DISH_RADIUS_MM;
    const edge = Math.max(mmPerPx, 0.08);
    // Газон в мягком агаре — это микроколонии (каждая выросла из одной клетки) на расстоянии
    // ≈ 45 мкм друг от друга. Их видно только при сильном увеличении, иначе они усредняются.
    const colonyW = Math.min(1, Math.max(0, (0.025 - mmPerPx) / 0.018));
    const fineAmp = 0.14 * Math.min(1, 0.05 / mmPerPx) * (1 - colonyW);
    const midAmp = 0.08 * Math.min(1, (0.4 / mmPerPx) * 0.5);
    for (let j = 0; j < h; j++) {
      const y = y0 + (j + 0.5) * mmPerPx;
      for (let i = 0; i < w; i++) {
        const x = x0 + (i + 0.5) * mmPerPx;
        const k = j * w + i;
        const r = Math.hypot(x, y);
        this.mask[k] = Math.min(1, Math.max(0, (R - r) / edge));
        if (this.mask[k] <= 0) continue;
        let t = 1;
        // Повёрнутые координаты для второй октавы — без «клеточек» по осям.
        const xr = 0.8 * x - 0.6 * y;
        const yr = 0.6 * x + 0.8 * y;
        if (fineAmp > 0.01) t += fineAmp * (valueNoise(x, y, 0.06, seed) + valueNoise(xr, yr, 0.035, seed + 1) - 1);
        if (midAmp > 0.01) t += midAmp * (valueNoise(xr, yr, 0.4, seed + 7) - 0.5) * 2;
        if (colonyW > 0) t = t * (1 - colonyW) + colonyW * t * microcolonies(x, y, seed);
        t += 0.06 * (valueNoise(x, y, 9, seed + 3) - 0.5) * 2;
        // У стенки газон чуть гуще (мениск), к центру — ровнее.
        t *= 1 + 0.12 * Math.max(0, (r - (R - 3)) / 3);
        this.texture[k] = t;
        // Свет падает сверху слева.
        this.light[k] = 1 + 0.06 * ((-x - y) / (R * 1.4));
      }
    }
  }
}

/** Мутность «газона» во всех пикселях с учётом бляшек (1 — газон, 0 — пусто). */
export function rasterTurbidity(m: PlateModel, plate: number, rect: RasterRect, out: Float32Array): void {
  const { w, h, x0, y0, mmPerPx } = rect;
  out.fill(1, 0, w * h);
  const base = m.excessFactor(plate);
  if (base < 1) for (let k = 0; k < w * h; k++) out[k] = base;

  for (const p of m.plaques) {
    if (p.plate !== plate) continue;
    const a = m.classOf(p, 'a');
    const b = m.classOf(p, 'b');
    if (!a || !b || !a.model || a.rOuter <= 0) continue;
    const R = a.rOuter + (b.rOuter - a.rOuter) * p.w;
    if (R <= 0) continue;
    // Профиль опорной бляшки, растянутый до нужного размера.
    const s = a.rOuter / R;
    const prof = a.turb;
    const drMm = a.model.dr / 1000;
    const nr = prof.length;
    const ext = Math.min(R * 1.1 + mmPerPx, (nr * drMm) / s);
    const i0 = Math.max(0, Math.floor((p.x - ext - x0) / mmPerPx));
    const i1 = Math.min(w - 1, Math.ceil((p.x + ext - x0) / mmPerPx));
    const j0 = Math.max(0, Math.floor((p.y - ext - y0) / mmPerPx));
    const j1 = Math.min(h - 1, Math.ceil((p.y + ext - y0) / mmPerPx));
    if (i0 > i1 || j0 > j1) continue;
    const ext2 = ext * ext;
    const k1 = s / drMm;
    for (let j = j0; j <= j1; j++) {
      const dy = y0 + (j + 0.5) * mmPerPx - p.y;
      const row = j * w;
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + (i + 0.5) * mmPerPx - p.x;
        const d2 = dx * dx + dy * dy;
        if (d2 >= ext2) continue;
        const u = Math.sqrt(d2) * k1 - 0.5;
        let t: number;
        if (u <= 0) t = prof[0];
        else {
          const iu = Math.floor(u);
          if (iu >= nr - 1) continue;
          const f = u - iu;
          t = prof[iu] + (prof[iu + 1] - prof[iu]) * f;
        }
        if (t < 1) out[row + i] *= t;
      }
    }
  }

  // Капли с очень большим числом вирусов: сплошное просветление пятна.
  for (const d of m.drops) {
    if (d.plate !== plate || d.excess <= 0) continue;
    const f = m.dropFactor(d);
    if (f >= 0.999) continue;
    const R = DROP_RADIUS_MM;
    const soft = 0.35;
    const i0 = Math.max(0, Math.floor((d.x - R - soft - x0) / mmPerPx));
    const i1 = Math.min(w - 1, Math.ceil((d.x + R + soft - x0) / mmPerPx));
    const j0 = Math.max(0, Math.floor((d.y - R - soft - y0) / mmPerPx));
    const j1 = Math.min(h - 1, Math.ceil((d.y + R + soft - y0) / mmPerPx));
    for (let j = j0; j <= j1; j++) {
      const dy = y0 + (j + 0.5) * mmPerPx - d.y;
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + (i + 0.5) * mmPerPx - d.x;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r >= R + soft) continue;
        const k = Math.min(1, Math.max(0, (R + soft - r) / (2 * soft)));
        out[j * w + i] *= 1 - (1 - f) * k;
      }
    }
  }
}

/**
 * Цвета: агар на тёмном столе и кремово-белый газон. Питательный агар янтарный; когда
 * бактерии съедают питание, он бледнеет и сереет (условность: так видно, что еда кончается).
 */
const AGAR_RICH = [64, 45, 16];
const AGAR_EMPTY = [24, 23, 21];
const LAWN = [222, 214, 190];

/** Цвет агара по доле оставшегося питания (0..1), RGB 0..255. */
export function agarRGB(food: number, out: number[] = [0, 0, 0]): number[] {
  const f = Math.min(1, Math.max(0, food));
  for (let c = 0; c < 3; c++) out[c] = AGAR_EMPTY[c] + (AGAR_RICH[c] - AGAR_EMPTY[c]) * f;
  return out;
}

/** Цвет агара, покрытого газоном с мутностью a (0 — бляшка, 1 — густой газон), RGB 0..255. */
export function plateRGB(food: number, a: number): number[] {
  const c = agarRGB(food);
  for (let k = 0; k < 3; k++) c[k] += (LAWN[k] - c[k]) * a;
  return c;
}

/** Раскрасить: op — видимая мутность газона этой чашки (0..1), food — доля питания в агаре. */
export function colorize(op: number, food: number, back: PlateBackdrop, turb: Float32Array, img: ImageData): void {
  const n = back.rect.w * back.rect.h;
  const data = img.data;
  const AGAR = agarRGB(food);
  for (let k = 0; k < n; k++) {
    const mk = back.mask[k];
    const o = k * 4;
    if (mk <= 0) {
      data[o + 3] = 0;
      continue;
    }
    const a = Math.min(1, op * turb[k] * back.texture[k]) * 0.94;
    const l = back.light[k];
    data[o] = Math.min(255, (AGAR[0] + (LAWN[0] - AGAR[0]) * a) * l);
    data[o + 1] = Math.min(255, (AGAR[1] + (LAWN[1] - AGAR[1]) * a) * l);
    data[o + 2] = Math.min(255, (AGAR[2] + (LAWN[2] - AGAR[2]) * a) * l);
    data[o + 3] = Math.round(255 * mk);
  }
}
