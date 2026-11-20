/** Процедурные текстуры (мягкая точка, световое пятно) — без внешних файлов, работает офлайн. */
import { Texture } from 'pixi.js';
import { hash2 } from './hash';

const cache = new Map<string, Texture>();

function fromCanvas(key: string, size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const t = Texture.from(c);
  cache.set(key, t);
  return t;
}

/** Мягкая светящаяся точка: яркое ядро и плавный ореол. */
export function softDot(): Texture {
  return fromCanvas('softDot', 64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Широкое световое пятно для подсветки и свечения. */
export function glowSpot(): Texture {
  return fromCanvas('glowSpot', 256, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Тонкое кольцо — для вспышек лизиса. */
export function ring(): Texture {
  return fromCanvas('ring', 64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.22, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}


// ---------------------------------------------------------------- реалистичные клетки
//
// Клетка — сфероцилиндр (палочка с полусферами на концах). Текстура девятисрезная по
// горизонтали: концы не растягиваются, средняя часть однородна по длине.
// Диаметр клетки CELL_D px, поля CELL_PAD px под размытие и ореол.

export const CELL_D = 96;
export const CELL_PAD = 24;
/** Ширина неизменяемого края девятисрезной текстуры (полусфера + поле). */
export const CELL_CAP = CELL_D / 2 + CELL_PAD;
export const CELL_TEX_H = CELL_D + 2 * CELL_PAD;
/**
 * Средняя (растягиваемая) часть текстуры ≈ 2 мкм: клетка длиной 2–4 мкм растягивает её
 * всего в 0,5–1,5 раза, поэтому шероховатость поверхности не превращается в продольные полосы.
 */
const CELL_MID = 2 * CELL_D;
const CELL_TEX_W = 2 * CELL_CAP + CELL_MID;
/** Сколько вариантов шероховатости (у соседних клеток разный рисунок). */
export const ROUGH_VARIANTS = 4;

/** Гладкий шум −1…1 с периодом решётки cell пикселей. */
function noise(x: number, y: number, cell: number, seed: number): number {
  const fx = x / cell;
  const fy = y / cell;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = hash2(ix, iy, seed + 1);
  const b = hash2(ix + 1, iy, seed + 1);
  const c = hash2(ix, iy + 1, seed + 1);
  const d = hash2(ix + 1, iy + 1, seed + 1);
  return 2 * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) - 1;
}

/**
 * Шероховатость поверхности клетки в точке текстуры: мелкие бугорки (≈ 0,05 мкм)
 * и пятна покрупнее (≈ 0,15 мкм). variant < 0 — гладкая клетка.
 */
function roughness(x: number, y: number, variant: number): { fine: number; coarse: number } {
  if (variant < 0) return { fine: 0, coarse: 0 };
  const seed = 101 + variant * 31;
  const fine = 0.6 * noise(x, y, 5, seed) + 0.4 * noise(x + 17, y - 9, 2.6, seed + 1);
  const coarse = noise(x, y, 15, seed + 2);
  return { fine, coarse };
}

/**
 * Рисует сфероцилиндр по пикселям: shade(расстояние до оси в долях радиуса) → [r,g,b,a],
 * затем слегка размывает (blur px), как размывает изображение оптика микроскопа.
 */
function spherocylinder(
  key: string, blur: number,
  shade: (q: number, septum: number, rough: number) => [number, number, number, number] | null,
  pinch = -1, variant = -1,
): Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const w = CELL_TEX_W;
  const hh = CELL_TEX_H;
  const raw = document.createElement('canvas');
  raw.width = w;
  raw.height = hh;
  const rctx = raw.getContext('2d')!;
  const img = rctx.createImageData(w, hh);
  const R = CELL_D / 2;
  const x0 = CELL_CAP;
  const x1 = w - CELL_CAP;
  const yc = hh / 2;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let q: number;
      let septum = 0;
      if (pinch < 0 || px <= x1) {
        const cx = Math.min(x1, Math.max(x0, px));
        q = Math.hypot(px - cx, py - yc) / R;
      } else {
        // Половинка делящейся клетки: правый конец — место будущего разделения.
        // Чем больше pinch, тем сильнее сужен конец (перетяжка); на самом конце — перегородка.
        const xe = x1 + R;
        if (px > xe) q = 9;
        else {
          const e = (xe - px) / R;
          const r = R * (1 - pinch * (1 - Math.sqrt(Math.max(0, 1 - (1 - e) ** 2))));
          q = Math.abs(py - yc) / Math.max(0.5, r);
          septum = pinch * Math.exp(-(((e - 0.03) / 0.045) ** 2));
        }
      }
      // Неровный край и бугристая поверхность: оболочка бактерии не идеально гладкая.
      const rg = roughness(px, py, variant);
      if (variant >= 0 && q > 0.7 && q < 1.3) q += 0.018 * rg.coarse + 0.008 * rg.fine;
      const c = shade(q, septum, 0.65 * rg.fine + 0.35 * rg.coarse);
      if (!c) continue;
      const o = (y * w + x) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = Math.round(Math.min(1, Math.max(0, c[3])) * 255);
    }
  }
  rctx.putImageData(img, 0, 0);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = hh;
  const ctx = out.getContext('2d')!;
  ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(raw, 0, 0);
  // Если браузер не поддерживает ctx.filter, остаётся резкая (но правильная) картинка.
  const t = Texture.from(out);
  cache.set(key, t);
  return t;
}

/**
 * Флуоресцентная клетка (бактерия со светящимся белком): чёткий край, мембрана чуть ярче
 * (как при окраске мембраны), середина ярче краёв — там клетка толще. Слабое свечение снаружи.
 */
export function fluoCell(pinch = -1, variant = -1): Texture {
  return spherocylinder(`fluoCell${pinch}:${variant}`, 0.9, (q, septum, rough) => {
    if (q >= 1) {
      const glow = 0.14 * Math.exp(-(((q - 1) / 0.1) ** 2));
      return glow > 0.004 ? [255, 255, 255, glow] : null;
    }
    const thick = Math.sqrt(1 - q * q);
    const membrane = Math.exp(-(((q - 0.9) / 0.065) ** 2));
    // Шероховатость заметнее на мембране и слабее в толще клетки.
    const lum = Math.min(1, 0.66 + 0.2 * thick + 0.3 * Math.max(membrane, septum) + rough * (0.07 + 0.06 * membrane));
    const v = Math.round(255 * Math.max(0, lum));
    const edge = q > 0.96 ? (1 - q) / 0.04 : 1;
    return [v, v, v, 0.35 + 0.65 * edge];
  }, pinch, variant);
}

/** Фазовый контраст: тёмная палочка с ещё более тёмной оболочкой по краю. */
export function phaseCell(pinch = -1, variant = -1): Texture {
  return spherocylinder(`phaseCell${pinch}:${variant}`, 0.8, (q, septum, rough) => {
    if (q >= 1) return null;
    const thick = Math.sqrt(1 - q * q);
    const rim = Math.exp(-(((q - 0.93) / 0.06) ** 2));
    const v = Math.round(34 + 20 * thick - 16 * Math.max(rim, septum) + rough * (6 + 4 * rim));
    return [v, v + 2, v, 1];
  }, pinch, variant);
}

/** Фазовый контраст: светлый ореол вокруг клетки (рисуется слоем под клетками). */
export function phaseHalo(pinch = -1): Texture {
  return spherocylinder(`phaseHalo${pinch}`, 1.2, (q) => {
    if (q < 0.9 || q > 8) return null;
    const z = (q - 1.06) / 0.1;
    return [250, 252, 245, 0.85 * Math.exp(-z * z)];
  }, pinch);
}

/**
 * Нуклеоид — область, где лежит ДНК бактерии: неровное пятно из нескольких сливающихся
 * капель. Несколько вариантов формы, чтобы клетки не были одинаковыми.
 */
export function nucleoid(variant: number): Texture {
  return fromCanvas(`nucleoid${variant}`, 128, (ctx, s) => {
    let seed = 977 + variant * 7919;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    ctx.clearRect(0, 0, s, s);
    const n = 5 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const x = s * (0.22 + 0.56 * (i / (n - 1))) + (rnd() - 0.5) * s * 0.08;
      const y = s / 2 + (rnd() - 0.5) * s * 0.22;
      const r = s * (0.13 + rnd() * 0.08);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(0.6, 'rgba(255,255,255,0.3)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }
  });
}

/** Фазовый контраст: «призрак» лопнувшей клетки — пустая светлая оболочка с тонким краем. */
export function phaseGhost(): Texture {
  return spherocylinder('phaseGhost', 1, (q) => {
    if (q >= 1.02) return null;
    const rim = Math.exp(-(((q - 0.93) / 0.06) ** 2));
    const v = Math.round(215 - 120 * rim);
    return [v, v + 3, v - 4, 0.28 + 0.4 * rim];
  });
}

/** Ступени перетяжки при делении (текстуры половинок клетки готовятся заранее). */
export const PINCH_LEVELS = [0, 0.15, 0.3, 0.45, 0.6, 0.72, 0.82];

/** Затемнение к краям поля зрения (виньетирование объектива). */
export function vignette(): Texture {
  return fromCanvas('vignette', 256, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.3, s / 2, s / 2, s * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Шум матрицы камеры: случайные светлые и тёмные пиксели. */
export function cameraNoise(): Texture {
  return fromCanvas('cameraNoise', 128, (ctx, s) => {
    const img = ctx.createImageData(s, s);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < s * s; i++) {
      const v = rnd() < 0.5 ? 0 : 255;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = Math.round(rnd() * 255);
    }
    ctx.putImageData(img, 0, 0);
  });
}
