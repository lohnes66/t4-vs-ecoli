/**
 * Отрисовка модуля «Чашка Петри» (PixiJS). Только читает модель. Картинка газона и бляшек
 * считается растеризатором (plate-raster.ts) для видимой части чашки, поэтому её можно
 * увеличивать до отдельной бляшки — видно прозрачную середину и мутный ореол.
 */
import { Application, Container, Graphics, Sprite, Text, Texture, type TextStyleOptions } from 'pixi.js';
import type { Runner } from '../app/runner';
import { type PlateModel, DISH_RADIUS_MM, VISIBLE_MM, lawnOpacity } from '../core/plate/model';
import { PlateBackdrop, rasterTurbidity, colorize, plateRGB, type RasterRect } from './plate-raster';
import { COLORS } from './palette';
import { FoodPanel } from './food-panel';
import { h } from '../ui/dom';
import { fmtDuration, fmtFixed } from '../ui/format';

const FONT = 'Inter, Segoe UI, Roboto, Helvetica, sans-serif';
const MONO = 'JetBrains Mono, Cascadia Mono, Consolas, monospace';
/** Наружный радиус стеклянной чашки, мм. */
const GLASS_MM = 45;
const MARK_COLOR = 0xffd23f;
const MAX_ZOOM = 40;
/** Сколько пикселей растра допускаем на все чашки сразу. */
const PIXEL_BUDGET = 1_600_000;

function style(o: TextStyleOptions): TextStyleOptions {
  return { fontFamily: FONT, fill: COLORS.text, fontSize: 14, ...o };
}

interface PlateGfx {
  root: Container;
  raster: Sprite;
  canvas: HTMLCanvasElement;
  tex: Texture;
  rim: Graphics;
  marks: Graphics;
  hover: Graphics;
  fx: Graphics;
  label: Text;
  back: PlateBackdrop | null;
  turb: Float32Array;
  img: ImageData | null;
  /** Экранный центр чашки и масштаб, пикс/мм. */
  cx: number;
  cy: number;
  ppm: number;
  shown: boolean;
}

interface DropFx {
  plate: number;
  x: number;
  y: number;
  age: number;
}

export type PlateClick = { plate: number; x: number; y: number };

export class PlateView {
  readonly app: Application;
  private runner: Runner<PlateModel>;
  private bg = new Graphics();
  private platesLayer = new Container();
  private platesMask = new Graphics();
  private hud = new Container();
  private labels = new Container();
  private gfx: PlateGfx[] = [];
  private texts: Record<string, Text> = {};
  private scaleBar = new Graphics();
  private panel = new Graphics();
  private legend = new Container();
  /** Кружки легенды (газон, бляшка, ореол) — перекрашиваются под цвет агара на чашке. */
  private legendSwatches: Graphics[] = [];
  private legendFood = -1;
  private food = new FoodPanel();
  private sideX = 0;
  /** Верх свободного места под панелью «Что видно на чашке». */
  private sideY = 0;
  private caption = new Container();
  private captionBg = new Graphics();
  private captionText: Text;
  private captionAge = 99;
  private dropFx: DropFx[] = [];
  private visible = true;
  private area = { x: 0, y: 0, w: 1, h: 1 };
  private panelW = 0;

  /** Какая чашка открыта крупно; null — видны все. */
  focus: number | null = null;
  private zoom = 1;
  /** Точка чашки (мм от центра), которая сейчас в середине экрана. */
  private pan = { x: 0, y: 0 };
  private camChangedAt = 0;
  private rasterAt = 0;
  private rasterVersion = -1;
  private rasterCam = '';
  private drag: { x: number; y: number; px: number; py: number; moved: boolean } | null = null;
  private hoverPt: { plate: number; x: number; y: number } | null = null;

  /** Отмеченные бляшки (номера в model.plaques) — по чашкам. */
  readonly marks = new Map<number, Set<number>>();
  scenarioName = '';
  /** Что делает щелчок по чашке. */
  mode: 'none' | 'drop' | 'count' = 'none';
  onClick: ((c: PlateClick) => void) | null = null;
  /** Камера изменилась (чашка открыта/закрыта, увеличение). */
  onCamera: (() => void) | null = null;

  private backBtn: HTMLButtonElement;
  private zoomBox: HTMLElement;
  private zoomOut: HTMLElement;

  private constructor(app: Application, runner: Runner<PlateModel>, host: HTMLElement) {
    this.app = app;
    this.runner = runner;
    this.captionText = new Text({ text: '', style: style({ fontSize: 18, wordWrap: true, wordWrapWidth: 700, lineHeight: 25 }) });
    this.backBtn = h('button', { class: 'btn small plate-back', onclick: () => this.showAll() }, '← Все чашки');
    this.zoomOut = h('span', { class: 'zoomval' }, '×1');
    this.zoomBox = h('div', { class: 'plate-zoom' },
      h('button', { class: 'btn small', title: 'Уменьшить', onclick: () => this.zoomBy(1 / 2) }, '−'),
      this.zoomOut,
      h('button', { class: 'btn small', title: 'Увеличить (или крути колёсико мыши над чашкой)', onclick: () => this.zoomBy(2) }, '+'),
    );
    host.append(this.backBtn, this.zoomBox);
  }

  static async create(host: HTMLElement, runner: Runner<PlateModel>): Promise<PlateView> {
    const app = new Application();
    await app.init({
      resizeTo: host,
      background: 0x050607,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      preference: 'webgl',
    });
    host.append(app.canvas);
    const v = new PlateView(app, runner, host);
    v.build();
    return v;
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.app.canvas.style.display = on ? 'block' : 'none';
    if (on) {
      this.app.start();
      this.app.resize();
      this.layout();
    } else this.app.stop();
    this.updateDom();
  }

  private build(): void {
    const stage = this.app.stage;
    stage.addChild(this.bg, this.platesLayer, this.platesMask, this.labels, this.hud);
    this.platesLayer.mask = this.platesMask;
    const t = (key: string, o: TextStyleOptions) => {
      const x = new Text({ text: '', style: style(o) });
      this.texts[key] = x;
      this.hud.addChild(x);
      return x;
    };
    this.hud.addChild(this.panel, this.scaleBar, this.food, this.legend, this.caption);
    t('clock', { fontFamily: MONO, fontSize: 22 });
    t('scenario', { fontSize: 15, fill: COLORS.muted });
    t('info', { fontSize: 12, fill: COLORS.muted });
    t('scale', { fontSize: 13 });
    t('countTitle', { fontSize: 11, fill: COLORS.muted, letterSpacing: 1 });
    t('countBody', { fontSize: 14, fill: COLORS.text, lineHeight: 22 });
    t('mode', { fontSize: 15, fill: COLORS.phage, wordWrap: true, wordWrapWidth: 500, lineHeight: 19 });
    this.caption.addChild(this.captionBg, this.captionText);
    this.caption.visible = false;
    this.buildLegend();

    stage.eventMode = 'static';
    stage.hitArea = this.app.screen;
    stage.on('pointerdown', (e) => {
      this.drag = { x: e.global.x, y: e.global.y, px: this.pan.x, py: this.pan.y, moved: false };
    });
    stage.on('pointermove', (e) => {
      const d = this.drag;
      if (d && this.focus !== null) {
        const dx = e.global.x - d.x;
        const dy = e.global.y - d.y;
        if (!d.moved && Math.hypot(dx, dy) > 5) d.moved = true;
        if (d.moved) {
          const g = this.gfx[this.focus];
          this.pan.x = d.px - dx / g.ppm;
          this.pan.y = d.py - dy / g.ppm;
          this.clampPan();
          this.camChanged();
        }
      }
      this.hoverPt = this.mode === 'count' ? this.pick(e.global.x, e.global.y) : null;
    });
    const up = (e: { global: { x: number; y: number } }) => {
      const d = this.drag;
      this.drag = null;
      if (d?.moved) return;
      const hit = this.pick(e.global.x, e.global.y);
      if (!hit) return;
      // Много чашек: первый щелчок открывает чашку крупно.
      if (this.focus === null && this.gfx.length > 2) {
        this.focusPlate(hit.plate, 1);
        return;
      }
      this.onClick?.(hit);
    };
    stage.on('pointerup', up);
    stage.on('pointerupoutside', () => (this.drag = null));
    this.app.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.app.canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const f = Math.exp(-e.deltaY * 0.0015);
      this.zoomAt(sx, sy, f);
    }, { passive: false });
    this.app.renderer.on('resize', () => this.layout());
    this.app.ticker.add((tk) => this.frame(tk.deltaMS / 1000));
  }

  private buildLegend(): void {
    for (const ch of this.legend.removeChildren()) ch.destroy();
    this.legendSwatches = [];
    this.legendFood = -1;
    const labels = ['газон — миллиарды бактерий', 'бляшка — здесь бактерии лопнули', 'мутный ореол вокруг бляшки'];
    labels.forEach((label, i) => {
      const d = new Graphics();
      const tx = new Text({ text: label, style: style({ fontSize: 12.5, fill: COLORS.muted }) });
      tx.position.set(24, i * 22);
      this.legendSwatches.push(d);
      this.legend.addChild(d, tx);
    });
    this.paintLegend(1);
  }

  /** Кружки легенды того же цвета, что газон, бляшка и ореол на чашке при данном запасе еды. */
  private paintLegend(food: number): void {
    const f = Math.round(food * 50) / 50;
    if (f === this.legendFood) return;
    this.legendFood = f;
    // Мутность газона: густой газон, бляшка (газона нет), ореол (газон наполовину).
    const turbidity = [0.94, 0, 0.45];
    this.legendSwatches.forEach((d, i) => {
      const [r, g, b] = plateRGB(f, turbidity[i]);
      const color = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
      d.clear().circle(8, 9 + i * 22, 7).fill({ color }).circle(8, 9 + i * 22, 7).stroke({ width: 1, color: 0x56636c });
    });
  }

  // ------------------------------------------------------------------ сцена

  /** Опыт начат заново: пересоздаём чашки. */
  resetScene(): void {
    for (const g of this.gfx) {
      g.root.destroy({ children: true });
      g.label.destroy();
      g.tex.destroy(true);
    }
    this.gfx = [];
    this.marks.clear();
    this.dropFx = [];
    this.caption.visible = false;
    this.captionAge = 99;
    const m = this.runner.model;
    m.plates.forEach((ps) => {
      const root = new Container();
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const tex = Texture.from(canvas);
      const raster = new Sprite(tex);
      const shadow = new Graphics()
        .circle(0.8, 1.6, GLASS_MM + 1.2).fill({ color: 0x000000, alpha: 0.55 })
        .circle(0, 0, GLASS_MM).fill({ color: 0x0b0c0d });
      const rim = new Graphics();
      const marks = new Graphics();
      const hover = new Graphics();
      const fx = new Graphics();
      root.addChild(shadow, raster, rim, marks, hover, fx);
      this.platesLayer.addChild(root);
      const label = new Text({ text: ps.spec.label, style: style({ fontSize: 15, fill: COLORS.text }) });
      label.anchor.set(0.5, 0);
      this.labels.addChild(label);
      this.gfx.push({
        root, raster, canvas, tex, rim, marks, hover, fx, label, back: null,
        turb: new Float32Array(0), img: null, cx: 0, cy: 0, ppm: 1, shown: true,
      });
    });
    this.focus = this.gfx.length === 1 ? 0 : null;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.rasterVersion = -1;
    this.layout();
  }

  private layout(): void {
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    this.bg.clear().rect(0, 0, W, H).fill({ color: 0x050607 });
    const wide = W > 900;
    this.panelW = wide ? 270 : 0;
    const top = 92;
    const bottom = 50;
    this.area = { x: 16, y: top, w: W - this.panelW - (wide ? 48 : 32), h: H - top - bottom };
    // Увеличенная чашка не заходит под часы, счётчики и подписи.
    const a = this.area;
    this.platesMask.clear().roundRect(a.x - 8, a.y - 8, a.w + 16, a.h + 16, 10).fill({ color: 0xffffff });
    this.placePlates();

    const tx = this.texts;
    tx.clock.position.set(20, 14);
    tx.scenario.position.set(20, 44);
    tx.info.position.set(20, 66);
    tx.mode.style.wordWrapWidth = Math.max(200, this.area.w - 190);
    tx.mode.position.set(this.area.x + 4, this.area.y + this.area.h + 8);
    if (wide) {
      const px = W - this.panelW - 16;
      const py = 14;
      const ph = 200;
      this.panel.clear()
        .roundRect(px, py, this.panelW, ph, 10).fill({ color: 0x0a1016, alpha: 0.88 })
        .roundRect(px, py, this.panelW, ph, 10).stroke({ width: 1, color: 0x1f2d38 });
      tx.countTitle.text = 'ЧТО ВИДНО НА ЧАШКЕ';
      tx.countTitle.position.set(px + 14, py + 12);
      tx.countBody.position.set(px + 14, py + 34);
      tx.countBody.style.wordWrap = true;
      tx.countBody.style.wordWrapWidth = this.panelW - 28;
      this.sideX = px;
      this.sideY = py + ph + 12;
      this.food.setWidth(this.panelW);
      this.panel.visible = tx.countTitle.visible = tx.countBody.visible = true;
      this.food.update(this.runner.model, this.focus ?? 0);
      this.placeSide();
    } else {
      this.panel.visible = tx.countTitle.visible = tx.countBody.visible = false;
      this.food.visible = false;
      this.legend.visible = false;
    }
    this.hudVersion = -1;
    this.captionText.style.wordWrapWidth = Math.min(760, W - this.panelW - 80);
    this.updateDom();
  }

  /**
   * Под панелью «Что видно на чашке»: сначала условные обозначения (они нужнее всего),
   * ниже — панель еды, если она помещается целиком (её высота зависит от числа полосок и текста).
   */
  private placeSide(): void {
    if (!this.panel.visible) return;
    const H = this.app.screen.height;
    const legendY = this.sideY + 6;
    const legendH = 72;
    this.legend.position.set(this.sideX + 6, legendY);
    this.legend.visible = H > legendY + legendH;
    const foodY = legendY + legendH;
    this.food.position.set(this.sideX, foodY);
    this.food.visible = this.legend.visible && H > foodY + this.food.panelH + 8;
  }

  /** Расставить чашки на экране по текущей камере. */
  private placePlates(): void {
    const a = this.area;
    const n = this.gfx.length;
    if (!n) return;
    if (this.focus !== null) {
      const fit = Math.min(a.w, a.h) / (2 * GLASS_MM + 4);
      const ppm = fit * this.zoom;
      this.gfx.forEach((g, i) => {
        g.shown = i === this.focus;
        g.ppm = ppm;
        g.cx = a.x + a.w / 2 - this.pan.x * ppm;
        g.cy = a.y + a.h / 2 - this.pan.y * ppm;
      });
    } else {
      const cols = n <= 2 ? n : n <= 4 ? 2 : 3;
      const rows = Math.ceil(n / cols);
      const cw = a.w / cols;
      const ch = a.h / rows;
      const labelH = 30;
      const ppm = Math.min(cw * 0.94, ch - labelH - 6) / (2 * GLASS_MM);
      this.gfx.forEach((g, i) => {
        g.shown = true;
        g.ppm = ppm;
        g.cx = a.x + cw * ((i % cols) + 0.5);
        g.cy = a.y + ch * Math.floor(i / cols) + (ch - labelH) / 2;
      });
    }
    for (const g of this.gfx) {
      g.root.visible = g.shown;
      g.label.visible = g.shown && this.focus === null;
      g.root.position.set(g.cx, g.cy);
      g.root.scale.set(g.ppm);
      g.label.position.set(g.cx, g.cy + GLASS_MM * g.ppm + 6);
      this.drawRim(g);
    }
    this.drawScaleBar();
  }

  private drawRim(g: PlateGfx): void {
    const w = 1.4 / g.ppm;
    g.rim.clear()
      .circle(0, 0, GLASS_MM).stroke({ width: Math.max(w, 1.6), color: 0xa9bcc7, alpha: 0.22 })
      .circle(0, 0, DISH_RADIUS_MM + 0.4).stroke({ width: Math.max(w, 0.8), color: 0xc7d6de, alpha: 0.35 });
    const arc = (r: number, a0: number, a1: number, width: number, alpha: number) =>
      g.rim.moveTo(r * Math.cos(a0), r * Math.sin(a0)).arc(0, 0, r, a0, a1).stroke({ width, color: 0xffffff, alpha });
    arc(GLASS_MM - 0.9, Math.PI * 1.05, Math.PI * 1.45, Math.max(w * 2, 1.2), 0.28);
    arc(GLASS_MM - 0.9, Math.PI * 0.1, Math.PI * 0.22, Math.max(w * 1.5, 0.9), 0.12);
  }

  private drawScaleBar(): void {
    const g = this.focus !== null ? this.gfx[this.focus] : this.gfx[0];
    const tx = this.texts;
    if (!g) {
      this.scaleBar.clear();
      tx.scale.text = '';
      return;
    }
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20];
    let mm = steps[steps.length - 1];
    for (const s of steps) {
      if (s * g.ppm >= 70) {
        mm = s;
        break;
      }
    }
    const len = mm * g.ppm;
    const sx = this.area.x + this.area.w - len - 6;
    const sy = this.area.y + this.area.h + 30;
    this.scaleBar.clear()
      .moveTo(sx, sy).lineTo(sx + len, sy).stroke({ width: 3, color: COLORS.text })
      .moveTo(sx, sy - 5).lineTo(sx, sy + 5).stroke({ width: 2, color: COLORS.text })
      .moveTo(sx + len, sy - 5).lineTo(sx + len, sy + 5).stroke({ width: 2, color: COLORS.text });
    tx.scale.text = `${fmtFixed(mm, mm < 1 ? 1 : 0)} мм`;
    tx.scale.position.set(sx + len / 2 - tx.scale.width / 2, sy - 22);
  }

  private updateDom(): void {
    const many = this.gfx.length > 1;
    this.backBtn.style.display = this.visible && many && this.focus !== null ? '' : 'none';
    this.zoomBox.style.display = this.visible && this.focus !== null ? '' : 'none';
    this.zoomOut.textContent = `×${this.zoom < 10 ? fmtFixed(this.zoom, this.zoom < 2 ? 1 : 0) : Math.round(this.zoom)}`;
    this.backBtn.style.top = `${this.area.y}px`;
    this.backBtn.style.left = `${this.area.x}px`;
    this.zoomBox.style.top = `${this.area.y}px`;
    this.zoomBox.style.left = `${this.area.x + this.area.w - 120}px`;
  }

  // ------------------------------------------------------------------ камера

  private camChanged(): void {
    this.camChangedAt = performance.now();
    this.placePlates();
    this.updateDom();
    this.onCamera?.();
  }

  focusPlate(i: number, zoom = 1, at?: { x: number; y: number }): void {
    this.focus = i;
    this.zoom = Math.min(MAX_ZOOM, Math.max(1, zoom));
    this.pan = at ? { ...at } : { x: 0, y: 0 };
    this.clampPan();
    this.camChanged();
  }

  showAll(): void {
    if (this.gfx.length === 1) {
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
    } else this.focus = null;
    this.camChanged();
  }

  private zoomBy(f: number): void {
    const a = this.area;
    this.zoomAt(a.x + a.w / 2, a.y + a.h / 2, f);
  }

  private zoomAt(sx: number, sy: number, f: number): void {
    if (this.focus === null) {
      // Колёсико над чашкой в общем виде — открыть её крупно с увеличением в точке.
      const hit = this.pick(sx, sy, true);
      if (!hit || f <= 1) return;
      this.focus = hit.plate;
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      this.placePlates();
      // Та же точка чашки остаётся под курсором и после того, как чашка открылась крупно.
      const g = this.gfx[hit.plate];
      this.pan = { x: hit.x - (sx - (this.area.x + this.area.w / 2)) / g.ppm, y: hit.y - (sy - (this.area.y + this.area.h / 2)) / g.ppm };
      this.clampPan();
      this.placePlates();
    }
    const g = this.gfx[this.focus!];
    // Точка под курсором остаётся на месте.
    const mx = (sx - g.cx) / g.ppm;
    const my = (sy - g.cy) / g.ppm;
    const z = Math.min(MAX_ZOOM, Math.max(1, this.zoom * f));
    if (z === this.zoom && this.focus !== null) {
      this.camChanged();
      return;
    }
    const k = this.zoom / z;
    this.zoom = z;
    this.pan.x = mx + (this.pan.x - mx) * k;
    this.pan.y = my + (this.pan.y - my) * k;
    this.clampPan();
    this.camChanged();
  }

  private clampPan(): void {
    // Середина экрана не уходит за край чашки (при увеличении «в точке» центр смещается к ней).
    const lim = GLASS_MM;
    const r = Math.hypot(this.pan.x, this.pan.y);
    if (r > lim) {
      this.pan.x *= lim / r;
      this.pan.y *= lim / r;
    }
  }

  /** Экранная точка → чашка и координаты на ней (мм). */
  private pick(sx: number, sy: number, any = false): PlateClick | null {
    for (let i = 0; i < this.gfx.length; i++) {
      const g = this.gfx[i];
      if (!g.shown) continue;
      const x = (sx - g.cx) / g.ppm;
      const y = (sy - g.cy) / g.ppm;
      if (Math.hypot(x, y) <= (any ? GLASS_MM : DISH_RADIUS_MM)) return { plate: i, x, y };
    }
    return null;
  }

  // ------------------------------------------------------------------ подсчёт бляшек

  /** Ближайшая видимая бляшка к точке (мм) на чашке; −1 — нет рядом. */
  plaqueNear(plate: number, x: number, y: number): number {
    const m = this.runner.model;
    m.refreshClasses();
    const g = this.gfx[plate];
    const tol = 7 / g.ppm;
    let best = -1;
    let bestD = Infinity;
    m.plaques.forEach((p, i) => {
      if (p.plate !== plate) return;
      const d = m.plaqueDiameter(p);
      if (d < VISIBLE_MM) return;
      const dist = Math.hypot(p.x - x, p.y - y);
      if (dist <= d / 2 + tol && dist < bestD) {
        bestD = dist;
        best = i;
      }
    });
    return best;
  }

  /** Отметить бляшку или снять отметку. Возвращает, что произошло. */
  toggleMark(plate: number, x: number, y: number): 'added' | 'removed' | 'none' {
    const i = this.plaqueNear(plate, x, y);
    if (i < 0) return 'none';
    let set = this.marks.get(plate);
    if (!set) {
      set = new Set();
      this.marks.set(plate, set);
    }
    const r = set.has(i) ? 'removed' : 'added';
    if (r === 'removed') set.delete(i);
    else set.add(i);
    this.marksVersion++;
    return r;
  }

  markCount(plate: number): number {
    return this.marks.get(plate)?.size ?? 0;
  }

  clearMarks(plate: number): void {
    this.marks.delete(plate);
    this.marksVersion++;
  }

  dropAt(plate: number, x: number, y: number): void {
    this.dropFx.push({ plate, x, y, age: 0 });
  }

  // ------------------------------------------------------------------ подпись

  showCaption(text: string): void {
    this.captionText.text = text;
    const pad = 14;
    const w = this.captionText.width + pad * 2;
    const hh = this.captionText.height + pad * 2;
    const x = Math.max(16, this.area.x + (this.area.w - w) / 2);
    const y = this.area.y + this.area.h - hh - 8;
    this.captionBg.clear()
      .roundRect(0, 0, w, hh, 10).fill({ color: 0x08131b, alpha: 0.9 })
      .roundRect(0, 0, w, hh, 10).stroke({ width: 1.5, color: COLORS.phage, alpha: 0.6 });
    this.captionText.position.set(pad, pad);
    this.caption.position.set(x, y);
    this.caption.visible = true;
    this.caption.alpha = 1;
    this.captionAge = 0;
  }

  // ------------------------------------------------------------------ кадр

  private frame(dt: number): void {
    if (!this.visible) return;
    const m = this.runner.model;
    const now = performance.now();
    const cam = this.gfx.map((g) => `${g.shown}:${g.cx.toFixed(1)}:${g.cy.toFixed(1)}:${g.ppm.toFixed(4)}`).join('|');
    const camSettled = now - this.camChangedAt > 90;
    const modelChanged = m.version !== this.rasterVersion && now - this.rasterAt > 120;
    if ((cam !== this.rasterCam && camSettled) || modelChanged) {
      this.rasterAll(m);
      this.rasterCam = cam;
      this.rasterVersion = m.version;
      this.rasterAt = now;
    }
    this.drawMarks(m);
    this.drawFx(dt);
    if (now - this.hudAt > 200 || this.hudVersion !== m.version + this.marksVersion) {
      this.hudAt = now;
      this.hudVersion = m.version + this.marksVersion;
      this.updateHud(m);
    }
    if (this.caption.visible) {
      this.captionAge += dt;
      if (this.captionAge > 14) this.caption.alpha = Math.max(0, 1 - (this.captionAge - 14) / 1.5);
      if (this.caption.alpha <= 0) this.caption.visible = false;
    }
  }

  private rasterAll(m: PlateModel): void {
    m.refreshClasses();
    const res = Math.min(1.5, window.devicePixelRatio || 1);
    const a = this.area;
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    // Видимые прямоугольники чашек в экранных пикселях.
    const rects: { g: PlateGfx; i: number; sx0: number; sy0: number; sx1: number; sy1: number }[] = [];
    let total = 0;
    this.gfx.forEach((g, i) => {
      if (!g.shown) return;
      const R = DISH_RADIUS_MM * g.ppm;
      const sx0 = Math.max(0, Math.floor(g.cx - R));
      const sy0 = Math.max(0, Math.floor(g.cy - R));
      const sx1 = Math.min(W, Math.ceil(g.cx + R));
      const sy1 = Math.min(H, Math.ceil(g.cy + R));
      if (sx1 <= sx0 || sy1 <= sy0) return;
      rects.push({ g, i, sx0, sy0, sx1, sy1 });
      total += (sx1 - sx0) * (sy1 - sy0);
    });
    void a;
    const k = Math.min(res, Math.sqrt(PIXEL_BUDGET / Math.max(1, total)));
    for (const r of rects) {
      const g = r.g;
      const w = Math.max(1, Math.round((r.sx1 - r.sx0) * k));
      const hh = Math.max(1, Math.round((r.sy1 - r.sy0) * k));
      const mmPerPx = (r.sx1 - r.sx0) / g.ppm / w;
      const rect: RasterRect = {
        x0: (r.sx0 - g.cx) / g.ppm,
        y0: (r.sy0 - g.cy) / g.ppm,
        mmPerPx, w, h: hh,
      };
      const b = g.back;
      if (!b || b.rect.w !== w || b.rect.h !== hh || Math.abs(b.rect.x0 - rect.x0) > 1e-6 || Math.abs(b.rect.y0 - rect.y0) > 1e-6 || Math.abs(b.rect.mmPerPx - mmPerPx) > 1e-9) {
        g.back = new PlateBackdrop(rect, 1000 + r.i);
      }
      if (g.turb.length < w * hh) g.turb = new Float32Array(w * hh);
      rasterTurbidity(m, r.i, rect, g.turb);
      // Размер холста меняем до рисования: изменение размера стирает картинку.
      if (g.canvas.width !== w || g.canvas.height !== hh) {
        // Новый холст нужного размера и новая текстура (у старой рамка осталась бы прежней).
        const old = g.tex;
        g.canvas = document.createElement('canvas');
        g.canvas.width = w;
        g.canvas.height = hh;
        g.tex = Texture.from(g.canvas);
        g.raster.texture = g.tex;
        old.destroy(true);
        g.img = null;
      }
      const ctx = g.canvas.getContext('2d')!;
      if (!g.img || g.img.width !== w || g.img.height !== hh) g.img = ctx.createImageData(w, hh);
      const group = m.groups[m.plates[r.i].group];
      colorize(lawnOpacity(group.lawn.S), group.lawn.food, g.back!, g.turb, g.img);
      ctx.putImageData(g.img, 0, 0);
      g.tex.source.update();
      g.raster.position.set(rect.x0, rect.y0);
      g.raster.scale.set(mmPerPx);
    }
  }

  private drawMarks(m: PlateModel): void {
    this.gfx.forEach((g, i) => {
      g.marks.clear();
      g.hover.clear();
      if (!g.shown) return;
      const set = this.marks.get(i);
      const r = Math.max(0.35, 4.5 / g.ppm);
      if (set) {
        for (const pi of set) {
          const p = m.plaques[pi];
          g.marks.circle(p.x, p.y, r).fill({ color: MARK_COLOR, alpha: 0.95 })
            .circle(p.x, p.y, r).stroke({ width: 1.2 / g.ppm, color: 0x1a1400 });
        }
      }
      const hp = this.hoverPt;
      if (hp && hp.plate === i && this.mode === 'count') {
        const idx = this.plaqueNearCached(m, i, hp.x, hp.y);
        if (idx >= 0) {
          const p = m.plaques[idx];
          const rr = Math.max(m.plaqueDiameter(p) / 2 + 2 / g.ppm, 5 / g.ppm);
          g.hover.circle(p.x, p.y, rr).stroke({ width: 2 / g.ppm, color: set?.has(idx) ? 0xff8a8a : MARK_COLOR, alpha: 0.9 });
        }
      }
    });
  }

  private hoverCache = { key: '', idx: -1 };
  private hudAt = 0;
  private hudVersion = -1;
  private marksVersion = 0;
  private plaqueNearCached(m: PlateModel, plate: number, x: number, y: number): number {
    const key = `${plate}:${x.toFixed(2)}:${y.toFixed(2)}:${m.version}`;
    if (key !== this.hoverCache.key) this.hoverCache = { key, idx: this.plaqueNear(plate, x, y) };
    return this.hoverCache.idx;
  }

  private drawFx(dt: number): void {
    for (const g of this.gfx) g.fx.clear();
    this.dropFx = this.dropFx.filter((d) => (d.age += dt) < 1.6);
    for (const d of this.dropFx) {
      const g = this.gfx[d.plate];
      if (!g?.shown) continue;
      const k = d.age / 1.6;
      g.fx.circle(d.x, d.y, 0.6 + 3.5 * k).stroke({ width: 2.5 / g.ppm, color: COLORS.phage, alpha: 0.9 * (1 - k) })
        .circle(d.x, d.y, 2.5).fill({ color: COLORS.phage, alpha: 0.18 * (1 - k) });
    }
  }

  private updateHud(m: PlateModel): void {
    const tx = this.texts;
    const s = m.snapshot();
    tx.clock.text = `инкубация: ${fmtDuration(s.t)}`;
    tx.scenario.text = this.scenarioName;
    const primary = this.focus ?? 0;
    const pf = s.plates[primary]?.food ?? 0;
    if (this.panel.visible) {
      this.food.update(m, primary);
      this.placeSide();
    }
    this.paintLegend(pf);
    tx.info.text = `чашка Петри 90 мм · ${m.cond.temperature} °C · seed ${m.rng.seed}` +
      (this.food.visible ? '' : ` · еды в агаре ${Math.round(pf * 100)} %`);
    tx.mode.text = this.mode === 'drop'
      ? 'Щёлкни по чашке — туда упадёт капля с вирусами'
      : this.mode === 'count'
        ? (this.focus === null && this.gfx.length > 2 ? 'Щёлкни по чашке, чтобы рассмотреть её' : 'Щёлкай по бляшкам — каждая получит жёлтую метку. Повторный щелчок снимает метку.')
        : '';
    this.gfx.forEach((g, i) => {
      const p = s.plates[i];
      const n = this.markCount(i);
      g.label.text = `${m.plates[i].spec.label}${n ? ` · отмечено ${n}` : ''}`;
      void p;
    });
    if (tx.countBody.visible) {
      const lines: string[] = [];
      const op = s.lawnOpacity;
      lines.push(`Газон: ${op < 0.08 ? 'пока не виден' : op < 0.5 ? 'мутнеет' : s.growth < 0.3 ? 'густой, бактерии больше не растут' : 'густой'}`);
      const idx = this.focus !== null ? [this.focus] : s.plates.map((_, i) => i);
      for (const i of idx.slice(0, 3)) {
        const p = s.plates[i];
        const name = s.plates.length > 1 ? `${m.plates[i].spec.label}: ` : '';
        if (p.lawnLeft < 0.05 && op > 0.1) lines.push(`${name}сплошной лизис`);
        else lines.push(`${name}бляшек видно ${p.visible > 9999 ? '> 10 000' : p.visible}${p.visible ? `, ⌀ ${fmtFixed(p.meanDiameter, 1)} мм` : ''}`);
        if (p.spots) lines.push(`${name}сплошных пятен от капель: ${p.spots}`);
      }
      if (idx.length > 3) lines.push('…');
      tx.countBody.text = lines.join('\n');
    }
  }

  async snapshotPng(): Promise<Blob> {
    const canvas = this.app.renderer.extract.canvas({ target: this.app.stage }) as HTMLCanvasElement;
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG'))), 'image/png'));
  }
}
