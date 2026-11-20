/**
 * Отрисовка модуля «Колба» (PixiJS / WebGL).
 *
 * Только читает состояние модели — ничего в ней не меняет. Случайность анимации
 * (положения взвешенных частиц, вспышки) берётся из отдельного потока генератора,
 * поэтому не влияет на результаты опыта.
 */
import { Application, Container, Graphics, Sprite, Text, BlurFilter, type TextStyleOptions } from 'pixi.js';
import type { FlaskRunner } from '../app/flask-runner';
import type { FlaskSnapshot } from '../core/flask/model';
import { Rng } from '../core/rng';
import { COLORS, lerpColor, infectedColor } from './palette';
import { softDot, glowSpot, ring } from './textures';
import { fmtClock, fmtFixed, fmtSci } from '../ui/format';

const FONT = 'Inter, Segoe UI, Roboto, Helvetica, sans-serif';
const MONO = 'JetBrains Mono, Cascadia Mono, Consolas, monospace';
const MAX_CELLS = 900;
const MAX_PHAGE = 500;

interface FlaskGeom {
  nominal: number; // мл
  Rb: number; // полуширина дна, см
  ys: number; // высота плеча, см
  rn: number; // полуширина горла
  neckTop: number;
  lip: number;
  corner: number;
}

interface Speck {
  sprite: Sprite;
  key: number; // стабильное случайное число — определяет состояние частицы
  phase: number; // фаза вращения в качалке
  v: number; // высота в слое жидкости 0..1
  amp: number; // радиус орбиты 0..1
  speed: number;
  size: number;
  twinkle: number;
}

interface Flash {
  sprite: Sprite;
  age: number;
  life: number;
  grow: number;
}

function makeGeom(volumeMl: number): FlaskGeom {
  const sizes = [25, 50, 100, 250, 500, 1000, 2000, 5000];
  const nominal = sizes.find((c) => c >= 2.5 * volumeMl) ?? 5000;
  const s = Math.cbrt(nominal / 50);
  return { nominal, Rb: 2.1 * s, ys: 5.0 * s, rn: 0.85 * s, neckTop: 7.6 * s, lip: 1.0 * s, corner: 0.35 * s };
}

function radiusAt(g: FlaskGeom, y: number): number {
  if (y >= g.ys) return g.rn;
  return g.Rb - ((g.Rb - g.rn) * y) / g.ys;
}

/** Высота жидкости заданного объёма (численно, по объёму усечённого конуса). */
function liquidHeight(g: FlaskGeom, volumeMl: number): number {
  const vol = (h: number) => {
    const n = 200;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const y = ((i + 0.5) / n) * h;
      const r = radiusAt(g, y);
      v += Math.PI * r * r * (h / n);
    }
    return v;
  };
  let lo = 0;
  let hi = g.neckTop * 0.95;
  if (vol(hi) < volumeMl) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (vol(mid) < volumeMl) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function style(o: TextStyleOptions): TextStyleOptions {
  return { fontFamily: FONT, fill: COLORS.text, fontSize: 14, ...o };
}

export class FlaskView {
  readonly app: Application;
  private runner: FlaskRunner;
  private host: HTMLElement;
  private rng = new Rng(7).fork(1);

  private bg = new Graphics();
  private lightbox = new Sprite(glowSpot());
  private flask = new Container();
  private liquidGlow = new Graphics();
  private liquid = new Graphics();
  private haze = new Graphics();
  private liquidMask = new Graphics();
  private specksLayer = new Container();
  private flashLayer = new Container();
  private glass = new Graphics();
  private glassGlow = new Graphics();
  private hud = new Container();

  private specks: Speck[] = [];
  private phage: Speck[] = [];
  private flashes: Flash[] = [];

  private texts: Record<string, Text> = {};
  private panel = new Graphics();
  private spark = new Graphics();
  private scaleBar = new Graphics();
  private legend = new Container();

  private geom: FlaskGeom = makeGeom(20);
  private level = 2;
  private pxPerCm = 50;
  private time = 0;
  private sparkBox = { x: 0, y: 0, w: 0, h: 0 };
  private lastSparkUpdate = -1;
  private visible = true;

  private constructor(app: Application, host: HTMLElement, runner: FlaskRunner) {
    this.app = app;
    this.host = host;
    this.runner = runner;
  }

  static async create(host: HTMLElement, runner: FlaskRunner): Promise<FlaskView> {
    const app = new Application();
    await app.init({
      resizeTo: host,
      background: COLORS.background,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      preference: 'webgl',
    });
    host.append(app.canvas);
    const v = new FlaskView(app, host, runner);
    v.build();
    return v;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.app.canvas.style.display = on ? 'block' : 'none';
    if (on) {
      this.app.start();
      this.app.resize();
      this.layout();
    } else this.app.stop();
  }

  private build(): void {
    const stage = this.app.stage;
    stage.addChild(this.bg);
    this.lightbox.anchor.set(0.5);
    this.lightbox.tint = 0x9fc8dc;
    this.lightbox.alpha = 0.13;
    stage.addChild(this.lightbox);

    stage.addChild(this.flask);
    this.liquidGlow.filters = [new BlurFilter({ strength: 18, quality: 3 })];
    this.liquidGlow.blendMode = 'add';
    this.haze.filters = [new BlurFilter({ strength: 14, quality: 3 })];
    this.haze.blendMode = 'add';
    this.glassGlow.filters = [new BlurFilter({ strength: 6, quality: 2 })];
    this.glassGlow.blendMode = 'add';
    this.specksLayer.mask = this.liquidMask;
    this.flashLayer.mask = this.liquidMask;
    this.flask.addChild(
      this.liquidGlow, this.liquid, this.haze, this.liquidMask, this.specksLayer, this.flashLayer, this.glassGlow, this.glass,
    );

    const dot = softDot();
    for (let i = 0; i < MAX_CELLS; i++) {
      const sp = new Sprite(dot);
      sp.anchor.set(0.5);
      sp.visible = false;
      this.specksLayer.addChild(sp);
      this.specks.push({
        sprite: sp,
        key: this.rng.uniform(),
        phase: this.rng.uniform() * Math.PI * 2,
        v: Math.pow(this.rng.uniform(), 0.8),
        amp: Math.sqrt(this.rng.uniform()),
        speed: 0.6 + this.rng.uniform() * 0.6,
        size: 0.7 + this.rng.uniform() * 0.6,
        twinkle: this.rng.uniform() * 10,
      });
    }
    for (let i = 0; i < MAX_PHAGE; i++) {
      const sp = new Sprite(dot);
      sp.anchor.set(0.5);
      sp.visible = false;
      sp.tint = COLORS.phage;
      sp.blendMode = 'add';
      this.specksLayer.addChild(sp);
      this.phage.push({
        sprite: sp,
        key: this.rng.uniform(),
        phase: this.rng.uniform() * Math.PI * 2,
        v: this.rng.uniform(),
        amp: Math.sqrt(this.rng.uniform()),
        speed: 0.9 + this.rng.uniform() * 0.8,
        size: 0.5 + this.rng.uniform() * 0.5,
        twinkle: this.rng.uniform() * 10,
      });
    }

    // HUD
    const t = (key: string, o: TextStyleOptions) => {
      const x = new Text({ text: '', style: style(o) });
      this.texts[key] = x;
      this.hud.addChild(x);
      return x;
    };
    stage.addChild(this.hud);
    this.hud.addChild(this.panel, this.spark, this.scaleBar, this.legend);
    t('clock', { fontFamily: MONO, fontSize: 22, fill: COLORS.text });
    t('scenario', { fontSize: 14, fill: COLORS.muted });
    t('incubator', { fontSize: 12, fill: COLORS.muted });
    t('scale', { fontSize: 12, fill: COLORS.text });
    t('flaskLabel', { fontSize: 11, fill: COLORS.muted });
    t('odTitle', { fontSize: 11, fill: COLORS.muted, letterSpacing: 1 });
    t('od', { fontFamily: MONO, fontSize: 34, fill: 0xe8e2cf });
    t('counters', { fontFamily: MONO, fontSize: 12, fill: COLORS.text, lineHeight: 20 });
    t('counterLabels', { fontSize: 12, fill: COLORS.muted, lineHeight: 20 });
    this.buildLegend();

    this.app.renderer.on('resize', () => this.layout());
    this.app.ticker.add((tk) => this.frame(tk.deltaMS / 1000));
    this.layout();
  }

  private buildLegend(): void {
    const items: [number, string][] = [
      [COLORS.sensitive, 'чувствительные, растущие'],
      [COLORS.starving, 'чувствительные, голодающие'],
      [COLORS.infectedMid, 'заражённые (зелёный → янтарный → красный)'],
      [COLORS.lysisInhibited, 'торможение лизиса'],
      [COLORS.resistant, 'устойчивые (OmpC⁻)'],
      [COLORS.debris, 'обломки после лизиса'],
      [COLORS.phage, 'свободный фаг (свечение)'],
    ];
    this.legend.removeChildren();
    items.forEach(([c, label], i) => {
      const d = new Graphics().circle(5, 8 + i * 18, 4.5).fill({ color: c });
      const tx = new Text({ text: label, style: style({ fontSize: 11.5, fill: COLORS.muted }) });
      tx.position.set(16, i * 18);
      this.legend.addChild(d, tx);
    });
  }

  /** Вызывается при сбросе опыта: геометрия колбы зависит от объёма культуры. */
  resetScene(): void {
    const V = this.runner.model.cond.volumeMl;
    this.geom = makeGeom(V);
    this.level = liquidHeight(this.geom, V);
    this.lastSparkUpdate = -1;
    for (const f of this.flashes) f.sprite.destroy();
    this.flashes = [];
    this.layout();
  }

  private layout(): void {
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    this.bg.clear().rect(0, 0, W, H).fill({ color: COLORS.background });
    const wide = W > 760;
    const panelW = wide ? Math.min(300, W * 0.3) : 0;
    const areaW = W - panelW - (wide ? 40 : 0);
    const g = this.geom;
    // Колба занимает ~62 % высоты кадра.
    this.pxPerCm = Math.min((H * 0.62) / g.neckTop, (areaW * 0.6) / (2 * g.Rb));
    const cx = areaW / 2 + 10;
    const baseY = H * 0.5 + (g.neckTop * this.pxPerCm) / 2 + 10;
    this.flask.position.set(cx, baseY);
    this.flask.scale.set(this.pxPerCm, -this.pxPerCm);
    this.lightbox.position.set(cx, baseY - this.level * this.pxPerCm * 0.8);
    const lb = g.Rb * this.pxPerCm * 4.2;
    this.lightbox.width = lb;
    this.lightbox.height = lb * 0.8;

    this.drawGlass();

    const tx = this.texts;
    tx.clock.position.set(20, 16);
    tx.scenario.position.set(20, 48);
    tx.incubator.position.set(20, 68);

    // Масштабная линейка: 1 см (или 2 см для больших колб).
    const cm = g.Rb > 4 ? 5 : g.Rb > 2.6 ? 2 : 1;
    const len = cm * this.pxPerCm;
    const sx = 24;
    const sy = H - 30;
    this.scaleBar.clear()
      .moveTo(sx, sy).lineTo(sx + len, sy).stroke({ width: 2, color: COLORS.text })
      .moveTo(sx, sy - 5).lineTo(sx, sy + 5).stroke({ width: 2, color: COLORS.text })
      .moveTo(sx + len, sy - 5).lineTo(sx + len, sy + 5).stroke({ width: 2, color: COLORS.text });
    tx.scale.text = `${cm} см`;
    tx.scale.position.set(sx + len / 2 - tx.scale.width / 2, sy - 22);
    tx.flaskLabel.text = `колба Эрленмейера ${g.nominal} мл`;
    tx.flaskLabel.position.set(cx - tx.flaskLabel.width / 2, baseY + 12);

    // Правая панель приборов.
    if (wide) {
      const px = W - panelW - 20;
      const py = 16;
      const ph = 300;
      this.panel.clear()
        .roundRect(px, py, panelW, ph, 10).fill({ color: 0x0a1016, alpha: 0.85 })
        .roundRect(px, py, panelW, ph, 10).stroke({ width: 1, color: 0x1f2d38 });
      tx.odTitle.text = 'СПЕКТРОФОТОМЕТР · OD₆₀₀';
      tx.odTitle.position.set(px + 14, py + 12);
      tx.od.position.set(px + 14, py + 28);
      this.sparkBox = { x: px + 14, y: py + 78, w: panelW - 28, h: 56 };
      tx.counterLabels.position.set(px + 14, py + 146);
      tx.counters.position.set(px + panelW - 14, py + 146);
      tx.counters.anchor.set(1, 0);
      this.panel.visible = tx.odTitle.visible = tx.od.visible = tx.counters.visible = tx.counterLabels.visible = true;
      this.spark.visible = true;
      // Под легендой оставляем место для кнопок «Панель / Весь экран».
      this.legend.position.set(px + 4, Math.max(py + ph + 24, H - 7 * 18 - 58));
      this.legend.visible = H > ph + 7 * 18 + 100;
    } else {
      this.panel.visible = this.texts.odTitle.visible = this.texts.od.visible = false;
      this.texts.counters.visible = this.texts.counterLabels.visible = false;
      this.spark.visible = false;
      this.legend.visible = false;
    }
    this.lastSparkUpdate = -1;
  }

  private drawGlass(): void {
    const g = this.geom;
    const path = (gr: Graphics) => {
      const c = g.corner;
      gr.moveTo(-g.lip, g.neckTop)
        .lineTo(-g.rn, g.neckTop - 0.18 * (g.lip / 1.0))
        .lineTo(-g.rn, g.ys)
        .lineTo(-g.Rb, c)
        .quadraticCurveTo(-g.Rb, 0, -g.Rb + c, 0)
        .lineTo(g.Rb - c, 0)
        .quadraticCurveTo(g.Rb, 0, g.Rb, c)
        .lineTo(g.rn, g.ys)
        .lineTo(g.rn, g.neckTop - 0.18 * (g.lip / 1.0))
        .lineTo(g.lip, g.neckTop);
    };
    const w = 2.2 / this.pxPerCm;
    this.glass.clear();
    path(this.glass);
    this.glass.stroke({ width: w, color: 0xb8d4e3, alpha: 0.75, join: 'round', cap: 'round' });
    // Блики на стекле.
    const hl = 0.35;
    this.glass
      .moveTo(-g.Rb + hl * 1.6, hl * 1.2)
      .lineTo(-g.rn - (g.Rb - g.rn) * 0.08, g.ys * 0.92)
      .stroke({ width: w * 2.2, color: 0xffffff, alpha: 0.10, cap: 'round' });
    this.glass
      .moveTo(-g.rn + 0.18, g.ys + 0.2)
      .lineTo(-g.rn + 0.18, g.neckTop - 0.4)
      .stroke({ width: w * 1.5, color: 0xffffff, alpha: 0.08, cap: 'round' });
    // Риски объёма на стенке.
    for (const frac of [0.25, 0.5, 0.75]) {
      const y = g.ys * frac;
      const r = radiusAt(g, y);
      this.glass.moveTo(r - 0.35, y).lineTo(r - 0.08, y).stroke({ width: w * 0.6, color: 0xb8d4e3, alpha: 0.35 });
    }
    this.glassGlow.clear();
    path(this.glassGlow);
    this.glassGlow.stroke({ width: w * 3, color: 0x6fb7d6, alpha: 0.35 });
  }

  /** Многоугольник жидкости с волнистой поверхностью (качалка). */
  private liquidPath(gr: Graphics, inset: number): void {
    const g = this.geom;
    const h = this.level;
    const waveA = 0.05 * Math.cbrt(g.nominal / 50);
    const n = 24;
    const rTop = radiusAt(g, h) - inset;
    const pts: number[] = [];
    for (let i = 0; i <= n; i++) {
      const x = -rTop + (2 * rTop * i) / n;
      const y = h + waveA * Math.sin(x * 1.9 + this.time * 3.1) + waveA * 0.6 * Math.sin(x * 4.3 - this.time * 2.2);
      pts.push(x, y);
    }
    const c = g.corner;
    const rC = radiusAt(g, c) - inset;
    pts.push(rC, c, g.Rb - c, inset, -(g.Rb - c), inset, -rC, c);
    gr.poly(pts, true);
  }

  private frame(dtSec: number): void {
    if (!this.visible) return;
    this.time += dtSec;
    const m = this.runner.model;
    const s = m.snapshot();
    const g = this.geom;
    const h = this.level;

    // --- жидкость: мутность по OD (рассеяние света клетками)
    const turb = 1 - Math.pow(10, -1.1 * s.od);
    const broth = 0xb39a5c;
    const milky = 0xe9e3cf;
    const fill = lerpColor(broth, milky, Math.min(1, turb * 1.2));
    this.liquid.clear();
    this.liquidPath(this.liquid, 0.06);
    this.liquid.fill({ color: fill, alpha: 0.22 + 0.72 * turb });
    this.liquidGlow.clear();
    this.liquidPath(this.liquidGlow, 0.1);
    this.liquidGlow.fill({ color: milky, alpha: 0.05 + 0.4 * turb });
    this.liquidMask.clear();
    this.liquidPath(this.liquidMask, 0.06);
    this.liquidMask.fill({ color: 0xffffff });

    // --- свечение фага: интенсивность по логарифму концентрации
    const pLog = s.P > 0 ? Math.log10(s.P) : 0;
    const hazeK = Math.min(1, Math.max(0, (pLog - 5) / 6));
    this.haze.clear();
    if (hazeK > 0) {
      this.liquidPath(this.haze, 0.25);
      this.haze.fill({ color: COLORS.phage, alpha: 0.08 + 0.42 * hazeK });
    }

    // --- взвешенные клетки: их число — по логарифму плотности, цвет — по составу популяции
    const cells = s.S + s.I + s.R;
    const cellsVisible = cells > 0 ? Math.min(1, Math.max(0, (Math.log10(cells) - 4.5) / 5)) : 0;
    const debrisShare = s.ghosts > 0 ? Math.min(0.6, (0.3 * s.ghosts) / (cells + s.ghosts)) : 0;
    const nCells = Math.round(cellsVisible * MAX_CELLS * (1 - debrisShare * 0.3));
    const nDebris = Math.round(Math.min(1, Math.max(0, (Math.log10(s.ghosts + 1) - 5) / 5)) * MAX_CELLS * 0.25);
    const fS = cells > 0 ? s.S / cells : 0;
    const fI = cells > 0 ? (s.I - s.LI) / cells : 0;
    const fLI = cells > 0 ? s.LI / cells : 0;
    const sCol = lerpColor(COLORS.starving, COLORS.sensitive, Math.min(1, s.growth * 1.25));
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 6);
    const pxSize = 1 / this.pxPerCm;
    const baseSize = Math.max(2.4, Math.min(5, this.pxPerCm * 0.06));

    for (let i = 0; i < this.specks.length; i++) {
      const p = this.specks[i];
      const sp = p.sprite;
      const isDebris = i >= nCells && i < nCells + nDebris;
      if (i >= nCells + nDebris) {
        sp.visible = false;
        continue;
      }
      sp.visible = true;
      p.phase += dtSec * p.speed * 0.9;
      const depth = Math.cos(p.phase); // «глубина» в колбе: дальние частицы тусклее
      const y = 0.12 + p.v * (h - 0.28) + 0.03 * Math.sin(this.time * 1.7 + p.twinkle);
      const r = radiusAt(g, y) - 0.15;
      sp.position.set(Math.sin(p.phase) * r * p.amp, y);
      let color: number;
      let size = baseSize * p.size;
      let alpha = 0.55 + 0.35 * (0.5 + 0.5 * depth);
      if (isDebris) {
        color = COLORS.debris;
        size *= 0.7;
        alpha *= 0.45;
      } else if (p.key < fS) {
        color = sCol;
      } else if (p.key < fS + fI) {
        const jitter = ((p.key * 9301) % 1) * 0.3 - 0.15;
        color = infectedColor(Math.min(1, Math.max(0, s.infectionProgress + jitter)));
      } else if (p.key < fS + fI + fLI) {
        color = lerpColor(COLORS.lysisInhibited, 0xffb0b8, pulse * 0.4);
        size *= 1.35 + 0.15 * pulse;
      } else {
        color = COLORS.resistant;
      }
      sp.tint = color;
      sp.alpha = alpha;
      sp.width = sp.height = size * pxSize;
    }

    // --- свободный фаг: мерцающая голубая «пыль»
    const nPhage = pLog > 0 ? Math.round(Math.min(1, Math.max(0, (pLog - 4) / 6.5)) * MAX_PHAGE) : 0;
    for (let i = 0; i < this.phage.length; i++) {
      const p = this.phage[i];
      const sp = p.sprite;
      if (i >= nPhage) {
        sp.visible = false;
        continue;
      }
      sp.visible = true;
      p.phase += dtSec * p.speed;
      const y = 0.08 + p.v * (h - 0.2) + 0.05 * Math.sin(this.time * 2.3 + p.twinkle);
      const r = radiusAt(g, y) - 0.1;
      sp.position.set(Math.sin(p.phase) * r * p.amp, y);
      sp.alpha = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(this.time * 4 + p.twinkle));
      sp.width = sp.height = baseSize * 0.55 * p.size * pxSize;
    }

    // --- вспышки лизиса: облачка фага там, где лопаются клетки
    if (this.runner.running && s.lysisRate > 0) {
      const intensity = Math.min(1, Math.max(0, (Math.log10(s.lysisRate) - 3) / 5));
      let spawn = intensity * 40 * dtSec;
      while (spawn > 0 && this.flashes.length < 80) {
        if (spawn < 1 && this.rng.uniform() > spawn) break;
        spawn -= 1;
        this.spawnFlash();
      }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.age += dtSec;
      const k = f.age / f.life;
      if (k >= 1) {
        f.sprite.destroy();
        this.flashes.splice(i, 1);
        continue;
      }
      const size = (baseSize * (1.5 + f.grow * k)) / this.pxPerCm;
      f.sprite.width = f.sprite.height = size;
      f.sprite.alpha = (1 - k) * 0.9;
    }

    this.updateHud(s);
  }

  private spawnFlash(): void {
    const g = this.geom;
    const y = 0.15 + this.rng.uniform() * (this.level - 0.3);
    const r = radiusAt(g, y) - 0.2;
    const sp = new Sprite(this.rng.uniform() < 0.5 ? ring() : softDot());
    sp.anchor.set(0.5);
    sp.tint = this.rng.uniform() < 0.7 ? COLORS.phage : 0xffd2a0;
    sp.blendMode = 'add';
    sp.position.set((this.rng.uniform() * 2 - 1) * r, y);
    this.flashLayer.addChild(sp);
    this.flashes.push({ sprite: sp, age: 0, life: 0.45 + this.rng.uniform() * 0.4, grow: 3 + this.rng.uniform() * 4 });
  }

  private updateHud(s: FlaskSnapshot): void {
    const m = this.runner.model;
    const tx = this.texts;
    tx.clock.text = fmtClock(s.t);
    tx.scenario.text = this.scenarioName;
    tx.incubator.text = `термостат-качалка · ${fmtFixed(m.cond.temperature, 0)} °C · ${fmtFixed(m.cond.volumeMl, 0)} мл культуры · seed ${m.rng.seed}`;
    if (!tx.od.visible) return;
    tx.od.text = fmtFixed(s.od, 3);
    const labels = ['Чувствительные S', 'Заражённые I', '  из них торможение', 'Устойчивые R', 'Свободный фаг P', '  из них r-мутанты', 'Глюкоза'];
    const vals = [
      `${fmtSci(s.S)} /мл`,
      `${fmtSci(s.I)} /мл`,
      `${fmtSci(s.LI)} /мл`,
      `${fmtSci(s.R)} /мл`,
      `${fmtSci(s.P)} /мл`,
      `${fmtSci(s.Pr)} /мл`,
      `${s.N >= 1000 ? fmtFixed(s.N / 1000, 2) + ' мМ' : fmtFixed(s.N, 1) + ' мкМ'}`,
    ];
    tx.counterLabels.text = labels.join('\n');
    tx.counters.text = vals.join('\n');

    // Мини-график OD на экране прибора (обновляем 4 раза в секунду).
    if (this.time - this.lastSparkUpdate > 0.25 || this.lastSparkUpdate < 0) {
      this.lastSparkUpdate = this.time;
      const b = this.sparkBox;
      const se = m.series;
      const dur = m.cond.duration;
      let maxOd = 0.1;
      for (const v of se.od) maxOd = Math.max(maxOd, v);
      maxOd *= 1.1;
      this.spark.clear().rect(b.x, b.y, b.w, b.h).fill({ color: 0x060a0e }).rect(b.x, b.y, b.w, b.h).stroke({ width: 1, color: 0x1b2732 });
      const n = se.t.length;
      if (n > 1) {
        const step = Math.max(1, Math.floor(n / 300));
        this.spark.moveTo(b.x, b.y + b.h - (se.od[0] / maxOd) * b.h);
        for (let i = step; i < n; i += step) {
          this.spark.lineTo(b.x + (se.t[i] / dur) * b.w, b.y + b.h - (se.od[i] / maxOd) * b.h);
        }
        this.spark.lineTo(b.x + (se.t[n - 1] / dur) * b.w, b.y + b.h - (se.od[n - 1] / maxOd) * b.h);
        this.spark.stroke({ width: 1.5, color: 0xe8e2cf });
      }
    }
  }

  scenarioName = '';

  /** PNG текущего кадра вместе с часами, линейкой и легендой. */
  async snapshotPng(): Promise<Blob> {
    const canvas = this.app.renderer.extract.canvas({ target: this.app.stage }) as HTMLCanvasElement;
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG'))), 'image/png'));
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  get hostEl(): HTMLElement {
    return this.host;
  }
}
