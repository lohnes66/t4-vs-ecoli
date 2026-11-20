/**
 * Отрисовка модуля «Микроскоп» (PixiJS / WebGL). Только читает модель; анимации эффектов
 * идут в реальном времени и берут случайность из отдельного генератора — на результаты
 * опыта не влияют.
 */
import {
  Application, Container, Graphics, Sprite, Text, NineSliceSprite, TilingSprite, BlurFilter, Texture,
  type TextStyleOptions, type BLEND_MODES,
} from 'pixi.js';
import type { Runner } from '../app/runner';
import type { MicroscopeModel, Cell, MicroEvent } from '../core/microscope/model';
import { Rng } from '../core/rng';
import { COLORS, lerpColor, infectedColor } from './palette';
import { hash2 } from './hash';
import {
  softDot, glowSpot, ring, fluoCell, phaseCell, phaseHalo, phaseGhost, vignette, cameraNoise, nucleoid, PINCH_LEVELS, ROUGH_VARIANTS,
  CELL_D, CELL_PAD, CELL_CAP, CELL_TEX_H,
} from './textures';
import type { MicroLook } from '../app/store';
import { fmtDuration } from '../ui/format';
import { FoodPanel, microFoodData } from './food-panel';

const FONT = 'Inter, Segoe UI, Roboto, Helvetica, sans-serif';
const MONO = 'JetBrains Mono, Cascadia Mono, Consolas, monospace';

/**
 * Спрайты одной клетки. Клетка рисуется двумя половинками-палочками: пока они перекрываются,
 * видна одна ровная палочка; перед делением перекрытие уменьшается и появляется перетяжка.
 */
interface CellSprite {
  root: Container;
  a: NineSliceSprite;
  b: NineSliceSprite;
  /** Фазовый ореол — в отдельном слое под всеми клетками. */
  halo: Container | null;
  ha: NineSliceSprite | null;
  hb: NineSliceSprite | null;
  /** ДНК бактерии (нуклеоид): перед делением расходится на два. */
  nuc: [Sprite, Sprite];
  /** Мелкие включения в цитоплазме. */
  granules: Sprite[];
  /** Новые вирусы, собирающиеся внутри заражённой клетки. */
  specks: Sprite[];
  dots: Sprite[];
  seen: number;
  /** Текущая ступень перетяжки (индекс в PINCH_LEVELS), −1 — ещё не задана. */
  level: number;
}

/** Детерминированное «случайное» число 0…1 для клетки: ширина, яркость, положение точек. */
function hash(id: number, k: number): number {
  return hash2(id, k, 3);
}

function cellSlice(texture: Texture): NineSliceSprite {
  return new NineSliceSprite({ texture, leftWidth: CELL_CAP, rightWidth: CELL_CAP, topHeight: 0, bottomHeight: 0 });
}

/** Положить половинку клетки длиной len мкм (от кончика до кончика) с центром в x. */
function placeSlice(spr: NineSliceSprite, x: number, len: number, scale: number): void {
  spr.scale.set(scale);
  const w = len / scale + 2 * CELL_PAD;
  spr.width = w;
  spr.height = CELL_TEX_H;
  spr.pivot.set(w / 2, CELL_TEX_H / 2);
  spr.position.set(x, 0);
}

/** Свободный вирус, видимый как светящаяся точка (флуоресцентная метка). */
interface Phage {
  sp: Sprite;
  x: number;
  y: number;
  /** Скорость, мкм/мин (случайное блуждание с памятью — процесс Орнштейна–Уленбека). */
  vx: number;
  vy: number;
  /** Возраст в секундах экрана — для плавного появления. */
  age: number;
}

/** Сколько вирусов рисовать точками самое большее; если их больше, точка — это несколько вирусов. */
const MAX_PHAGES = 1500;
/** Время «памяти» скорости при блуждании, мин. Длинные шаги без рывков, диффузия та же, что в модели. */
const PHAGE_TAU = 0.1;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

interface Fx {
  sprite: Sprite | NineSliceSprite;
  age: number;
  life: number;
  vx: number;
  vy: number;
  grow: number;
  alpha0: number;
  baseScale: number;
}

/**
 * Крупинка еды в агаре. Настоящий сахар в микроскоп не виден — это условность: крупинки
 * исчезают (их «съедают» ближайшие бактерии) по мере того, как в агаре кончается питание.
 */
interface FoodDot {
  sp: Sprite;
  x: number;
  y: number;
  /** Крупинка видна, пока доля оставшейся еды больше этого порога. */
  thr: number;
  phase: number;
  /** −1 — лежит; 0…1 — её съедают (летит в бактерию); 2 — съедена. */
  eat: number;
  tx: number;
  ty: number;
}

const FOOD_COLOR = 0xffd166;
/** Сколько крупинок на 1 мкм² поля (и пределы на всё поле). */
const FOOD_DENSITY = 0.12;
const FOOD_MIN = 40;
const FOOD_MAX = 320;
/** Сколько секунд экрана крупинку «съедают». */
const FOOD_EAT_S = 0.9;

function style(o: TextStyleOptions): TextStyleOptions {
  return { fontFamily: FONT, fill: COLORS.text, fontSize: 14, ...o };
}

export type MicroClick = { x: number; y: number; cell: Cell | undefined };

export class MicroscopeView {
  readonly app: Application;
  private runner: Runner<MicroscopeModel>;
  private rng = new Rng(11).fork(3);

  private bg = new Graphics();
  private world = new Container();
  private fieldFrame = new Graphics();
  private phageSprite: Sprite;
  private phageCanvas = document.createElement('canvas');
  private phageTex: Texture;
  private decor = new Container();
  /** Лёгкий тёплый оттенок агара: пока в нём много еды. */
  private agarTint = new Graphics();
  private foodLayer = new Container();
  private foodDots: FoodDot[] = [];
  private food = new FoodPanel();
  private sideX = 0;
  private foodY = 0;
  private haloLayer = new Container();
  private cellsLayer = new Container();
  private vignetteSprite = new Sprite(vignette());
  private grain = new TilingSprite({ texture: cameraNoise(), width: 1, height: 1 });
  private fxLayer = new Container();
  private phageLayer = new Container();
  private phages: Phage[] = [];
  private phageScale = 1;
  private lastSimT = 0;
  private nodeCount = new Float32Array(0);
  private selection = new Graphics();
  private fieldMask = new Graphics();
  private hud = new Container();
  private texts: Record<string, Text> = {};
  private scaleBar = new Graphics();
  private legend = new Container();
  private panel = new Graphics();
  private caption = new Container();
  private captionBg = new Graphics();
  private captionText: Text;

  private sprites = new Map<number, CellSprite>();
  private fx: Fx[] = [];
  private frameNo = 0;
  private time = 0;
  private pxPerUm = 20;
  private visible = true;
  private captionAge = 99;

  /** Как показывать: светящиеся метки (флуоресценция) или обычный фазово-контрастный микроскоп. */
  private look: MicroLook = 'fluo';
  selectedId: number | null = null;
  scenarioName = '';
  /** Режим «капнуть вирусы»: следующий щелчок ставит каплю. */
  dropMode = false;
  /** Идёт замедленный показ лизиса (подпись под полем). */
  slowMo = false;
  onClick: ((c: MicroClick) => void) | null = null;

  private constructor(app: Application, runner: Runner<MicroscopeModel>) {
    this.app = app;
    this.runner = runner;
    this.phageCanvas.width = 4;
    this.phageCanvas.height = 4;
    this.phageTex = Texture.from(this.phageCanvas);
    this.phageSprite = new Sprite(this.phageTex);
    this.captionText = new Text({ text: '', style: style({ fontSize: 18, wordWrap: true, wordWrapWidth: 700, lineHeight: 25 }) });
  }

  static async create(host: HTMLElement, runner: Runner<MicroscopeModel>): Promise<MicroscopeView> {
    const app = new Application();
    await app.init({
      resizeTo: host,
      background: 0x020406,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      preference: 'webgl',
    });
    host.append(app.canvas);
    const v = new MicroscopeView(app, runner);
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
  }

  private build(): void {
    const stage = this.app.stage;
    stage.addChild(this.bg, this.world, this.hud);
    this.phageSprite.filters = [new BlurFilter({ strength: 10, quality: 3 })];
    this.phageSprite.blendMode = 'add';
    this.phageSprite.tint = COLORS.phage;
    this.phageSprite.alpha = 0.45;
    // Всё, что за краем поля зрения, не видно — как в окуляре.
    const clipped = new Container();
    clipped.addChild(
      this.agarTint, this.decor, this.foodLayer, this.haloLayer, this.cellsLayer, this.phageSprite, this.phageLayer, this.fxLayer,
      this.vignetteSprite, this.grain, this.selection,
    );
    clipped.mask = this.fieldMask;
    this.world.addChild(this.fieldFrame, clipped, this.fieldMask);

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
    t('scaleNote', { fontSize: 11, fill: COLORS.muted });
    t('countTitle', { fontSize: 11, fill: COLORS.muted, letterSpacing: 1 });
    t('countLabels', { fontSize: 14, fill: COLORS.muted, lineHeight: 24 });
    t('countVals', { fontFamily: MONO, fontSize: 15, lineHeight: 24 });
    t('mode', { fontSize: 15, fill: COLORS.phage });
    this.caption.addChild(this.captionBg, this.captionText);
    this.caption.visible = false;
    this.buildLegend();

    // Щелчок по полю: поставить каплю или выбрать бактерию.
    stage.eventMode = 'static';
    stage.hitArea = this.app.screen;
    stage.on('pointertap', (e) => {
      const p = this.world.toLocal(e.global);
      const m = this.runner.model;
      if (p.x < 0 || p.y < 0 || p.x > m.cond.width || p.y > m.cond.height) return;
      this.onClick?.({ x: p.x, y: p.y, cell: m.cellAt(p.x, p.y) });
    });
    this.app.renderer.on('resize', () => this.layout());
    this.app.ticker.add((tk) => this.frame(tk.deltaMS / 1000));
    this.layout();
  }

  private buildLegend(): void {
    const items: [number, string][] = this.look === 'fluo'
      ? [
        [COLORS.sensitive, 'здоровая, растёт'],
        [COLORS.starving, 'голодает'],
        [COLORS.infectedMid, 'заражена: собирает вирусы'],
        [COLORS.infectedLate, 'вот-вот лопнет'],
        [COLORS.lysisInhibited, 'лопнет позже'],
        [COLORS.resistant, 'устойчивая к вирусу'],
        [COLORS.phage, 'вирусы'],
        [FOOD_COLOR, 'еда в агаре'],
      ]
      : [
        [0x2c302c, 'бактерия'],
        [0xc9cdc3, 'пустая оболочка лопнувшей'],
        [FOOD_COLOR, 'еда в агаре'],
      ];
    for (const ch of this.legend.removeChildren()) ch.destroy();
    items.forEach(([c, label], i) => {
      const d = new Graphics();
      if (c === FOOD_COLOR) {
        d.circle(4, 8.5 + i * 20, 2.2).fill({ color: c }).circle(10, 6.5 + i * 20, 1.8).fill({ color: c }).circle(13, 10.5 + i * 20, 2).fill({ color: c });
      } else d.roundRect(0, 4 + i * 20, 16, 9, 4.5).fill({ color: c });
      if (this.look === 'phase' && c !== FOOD_COLOR) d.roundRect(-1, 3 + i * 20, 18, 11, 5.5).stroke({ width: 1, color: 0xe8ece4, alpha: 0.6 });
      const tx = new Text({ text: label, style: style({ fontSize: 12.5, fill: COLORS.muted }) });
      tx.position.set(24, i * 20);
      this.legend.addChild(d, tx);
    });
    if (this.look === 'phase') {
      const note = new Text({
        text: 'Вирусы слишком маленькие —\nв обычный микроскоп их не видно.\nЗаражённая бактерия выглядит\nкак здоровая, пока не лопнет.',
        style: style({ fontSize: 12.5, fill: COLORS.muted, lineHeight: 18 }),
      });
      note.position.set(0, items.length * 20 + 10);
      this.legend.addChild(note);
    }
  }

  /** Переключить вид: светящиеся метки или обычный микроскоп. Опыт не перезапускается. */
  setLook(look: MicroLook): void {
    if (look === this.look) return;
    this.look = look;
    this.clearSprites();
    this.buildLegend();
    this.buildDecor();
    this.layout();
  }

  private clearSprites(): void {
    for (const s of this.sprites.values()) {
      s.root.destroy({ children: true });
      s.halo?.destroy({ children: true });
    }
    this.sprites.clear();
    for (const f of this.fx) f.sprite.destroy();
    this.fx = [];
    for (const ph of this.phages) ph.sp.destroy();
    this.phages = [];
    this.lastSimT = this.runner.model.t;
  }

  /**
   * Фон поля зрения в обычном микроскопе: неравномерная подсветка и размытые соринки
   * вне фокуса. Расположение постоянно для данного размера поля.
   */
  private buildDecor(): void {
    for (const ch of this.decor.removeChildren()) ch.destroy();
    this.decor.visible = this.look === 'phase';
    if (this.look !== 'phase') return;
    const { width: w, height: hh } = this.runner.model.cond;
    const rng = new Rng(7).fork(Math.round(w * 100 + hh));
    const light = new Sprite(glowSpot());
    light.anchor.set(0.5);
    light.position.set(w * 0.4, hh * 0.42);
    light.scale.set((Math.max(w, hh) * 1.3) / light.texture.width);
    light.alpha = 0.16;
    this.decor.addChild(light);
    const n = Math.min(30, Math.round((w * hh) / 70) + 3);
    for (let i = 0; i < n; i++) {
      const dot = new Sprite(softDot());
      dot.anchor.set(0.5);
      dot.position.set(rng.uniform() * w, rng.uniform() * hh);
      const big = rng.uniform() < 0.6;
      const size = big ? 1 + rng.uniform() * 3 : 0.2 + rng.uniform() * 0.25;
      dot.scale.set(size / dot.texture.width);
      dot.tint = rng.uniform() < 0.25 ? 0xf4f6ef : 0x3a3f39;
      dot.alpha = big ? 0.06 + rng.uniform() * 0.1 : 0.35 + rng.uniform() * 0.3;
      this.decor.addChild(dot);
    }
  }

  /** При сбросе опыта: удаляем все спрайты, пересчитываем масштаб поля. */
  resetScene(): void {
    this.clearSprites();
    this.selectedId = null;
    this.captionAge = 99;
    this.caption.visible = false;
    const m = this.runner.model;
    this.phageCanvas.width = m.gw;
    this.phageCanvas.height = m.gh;
    this.phageTex.source.resize(m.gw, m.gh);
    this.phageTex.source.update();
    this.buildDecor();
    this.buildFood();
    this.layout();
  }

  private layout(): void {
    const W = this.app.screen.width;
    const H = this.app.screen.height;
    this.bg.clear().rect(0, 0, W, H).fill({ color: 0x020406 });
    const m = this.runner.model;
    const wide = W > 900;
    const panelW = wide ? 285 : 0;
    const top = 92;
    const bottom = 56;
    const availW = W - panelW - (wide ? 50 : 30);
    const availH = H - top - bottom;
    this.pxPerUm = Math.max(4, Math.min(availW / m.cond.width, availH / m.cond.height));
    const fw = m.cond.width * this.pxPerUm;
    const fh = m.cond.height * this.pxPerUm;
    this.world.scale.set(this.pxPerUm);
    this.world.position.set(15 + (availW - fw) / 2, top + (availH - fh) / 2);
    // Поле зрения: тёмное (светящиеся метки) или серое (обычный микроскоп) с едва заметной рамкой.
    const phase = this.look === 'phase';
    this.fieldFrame.clear()
      .rect(0, 0, m.cond.width, m.cond.height).fill({ color: phase ? 0x878c84 : 0x05080b })
      .rect(0, 0, m.cond.width, m.cond.height).stroke({ width: 1.5 / this.pxPerUm, color: 0x1b2732 });
    this.fieldMask.clear().rect(0, 0, m.cond.width, m.cond.height).fill({ color: 0xffffff });
    this.agarTint.clear().rect(0, 0, m.cond.width, m.cond.height).fill({ color: phase ? 0xc89a3c : 0xb07a2a });
    this.phageSprite.position.set(0, 0);
    this.phageSprite.width = m.cond.width;
    this.phageSprite.height = m.cond.height;
    this.vignetteSprite.position.set(0, 0);
    this.vignetteSprite.width = m.cond.width;
    this.vignetteSprite.height = m.cond.height;
    this.vignetteSprite.alpha = phase ? 0.75 : 0.6;
    this.grain.width = m.cond.width;
    this.grain.height = m.cond.height;
    this.grain.tileScale.set(1 / this.pxPerUm);
    this.grain.blendMode = phase ? 'normal' : 'add';
    this.grain.alpha = phase ? 0.07 : 0.045;

    const tx = this.texts;
    tx.clock.position.set(20, 14);
    tx.scenario.position.set(20, 44);
    tx.info.position.set(20, 66);
    tx.mode.position.set(this.world.x, this.world.y + fh + 10);

    // Масштабная линейка: 10 мкм (5 мкм для крупного плана).
    const um = m.cond.width <= 20 ? 2 : m.cond.width <= 45 ? 5 : 10;
    const len = um * this.pxPerUm;
    const sx = this.world.x + fw - len;
    const sy = this.world.y + fh + 22;
    this.scaleBar.clear()
      .moveTo(sx, sy).lineTo(sx + len, sy).stroke({ width: 3, color: COLORS.text })
      .moveTo(sx, sy - 5).lineTo(sx, sy + 5).stroke({ width: 2, color: COLORS.text })
      .moveTo(sx + len, sy - 5).lineTo(sx + len, sy + 5).stroke({ width: 2, color: COLORS.text });
    tx.scale.text = `${um} мкм`;
    tx.scale.position.set(sx + len / 2 - tx.scale.width / 2, sy - 21);
    tx.scaleNote.text = '1 мкм = одна тысячная миллиметра';
    tx.scaleNote.position.set(sx + len - tx.scaleNote.width, sy + 8);

    if (wide) {
      const px = W - panelW - 16;
      const py = 14;
      const ph = 214;
      this.panel.clear()
        .roundRect(px, py, panelW, ph, 10).fill({ color: 0x0a1016, alpha: 0.88 })
        .roundRect(px, py, panelW, ph, 10).stroke({ width: 1, color: 0x1f2d38 });
      tx.countTitle.text = 'СЧЁТЧИКИ';
      tx.countTitle.position.set(px + 14, py + 12);
      tx.countLabels.position.set(px + 14, py + 34);
      tx.countVals.anchor.set(1, 0);
      tx.countVals.position.set(px + panelW - 14, py + 34);
        this.sideX = px;
      this.foodY = py + ph + 12;
      this.food.setWidth(panelW);
      this.food.position.set(px, this.foodY);
      this.panel.visible = tx.countTitle.visible = tx.countLabels.visible = tx.countVals.visible = true;
      this.food.visible = H > this.foodY + 200;
      if (this.food.visible) this.food.draw(m, microFoodData(m));
      this.placeLegend();
    } else {
      this.panel.visible = tx.countTitle.visible = tx.countLabels.visible = tx.countVals.visible = false;
      this.food.visible = false;
      this.legend.visible = false;
    }
    this.captionText.style.wordWrapWidth = Math.min(760, W - panelW - 80);
  }

  /** Условные обозначения — под панелью еды, если хватает места. */
  private placeLegend(): void {
    if (!this.panel.visible) return;
    const y = this.food.visible ? this.foodY + this.food.panelH + 14 : this.foodY + 6;
    this.legend.position.set(this.sideX + 4, y);
    this.legend.visible = this.app.screen.height > y + this.legend.height + 10;
  }

  /** Рассыпать крупинки еды по полю (заново при сбросе опыта). */
  private buildFood(): void {
    for (const f of this.foodDots) f.sp.destroy();
    this.foodDots = [];
    const { width: w, height: hh } = this.runner.model.cond;
    const rng = new Rng(5).fork(Math.round(w * 100 + hh));
    const n = Math.max(FOOD_MIN, Math.min(FOOD_MAX, Math.round(w * hh * FOOD_DENSITY)));
    for (let i = 0; i < n; i++) {
      const sp = new Sprite(softDot());
      sp.anchor.set(0.5);
      sp.tint = FOOD_COLOR;
      this.foodLayer.addChild(sp);
      this.foodDots.push({
        sp, x: rng.uniform() * w, y: rng.uniform() * hh, thr: rng.uniform(),
        phase: rng.uniform() * 6.283, eat: -1, tx: 0, ty: 0,
      });
    }
  }

  /** Крупинки еды: лишние «съедают» ближайшие растущие бактерии. */
  private updateFood(m: MicroscopeModel, dt: number): void {
    const food = m.food;
    const fluo = this.look === 'fluo';
    this.agarTint.alpha = (fluo ? 0.09 : 0.1) * food;
    const size = Math.min(0.6, Math.max(0.22, 10 / this.pxPerUm));
    const k = size / 64;
    const baseAlpha = fluo ? 0.8 : 0.85;
    for (const f of this.foodDots) {
      const want = f.thr < food;
      if (want) {
        f.eat = -1;
        f.sp.visible = true;
        // Еле заметное дрожание — крупинки «плавают» в агаре.
        f.sp.position.set(f.x + 0.12 * Math.sin(this.time * 0.9 + f.phase), f.y + 0.12 * Math.cos(this.time * 0.7 + f.phase * 1.3));
        f.sp.scale.set(k);
        f.sp.alpha = baseAlpha;
        continue;
      }
      if (f.eat === 2) continue;
      if (f.eat < 0) {
        // Ближайшая живая бактерия — она и съест крупинку.
        let best = Infinity;
        f.tx = f.x;
        f.ty = f.y;
        for (const c of m.cells) {
          if (c.state !== 'S' && c.state !== 'R') continue;
          const d2 = (c.x - f.x) ** 2 + (c.y - f.y) ** 2;
          if (d2 < best) {
            best = d2;
            f.tx = c.x;
            f.ty = c.y;
          }
        }
        // Далеко от бактерий крупинка просто растворяется на месте.
        if (best > 36) {
          f.tx = f.x;
          f.ty = f.y;
        }
        f.eat = 0;
      }
      f.eat = Math.min(1, f.eat + dt / FOOD_EAT_S);
      const e = smoothstep(0, 1, f.eat);
      f.sp.position.set(f.x + (f.tx - f.x) * e, f.y + (f.ty - f.y) * e);
      f.sp.scale.set(k * (1 - 0.7 * e));
      f.sp.alpha = baseAlpha * (1 - e);
      if (f.eat >= 1) {
        f.eat = 2;
        f.sp.visible = false;
      }
    }
  }

  // ------------------------------------------------------------------ события модели → эффекты

  handleEvents(events: MicroEvent[]): void {
    let lysisFx = 0;
    for (const e of events) {
      if (e.kind === 'adsorb' && e.primary && this.look === 'fluo') {
        const c = this.runner.model.cellById(e.cellId);
        const a = c?.attached[c.attached.length - 1];
        if (c && a && this.fx.length < 400) {
          const p = this.attachPoint(c, a);
          this.spawn(ring(), p.x, p.y, COLORS.phage, 0.5, 0.6, 2.5, 0, 0, 0.9);
        }
      } else if (e.kind === 'lysis' && lysisFx < 6 && this.fx.length < 500) {
        lysisFx++;
        this.lysisFx(e);
      } else if (e.kind === 'drop') {
        const tint = this.look === 'fluo' ? COLORS.phage : 0xffffff;
        this.spawn(ring(), e.x, e.y, tint, 2, 1.4, 6, 0, 0, this.look === 'fluo' ? 0.9 : 0.35);
        if (this.look === 'fluo') this.spawn(glowSpot(), e.x, e.y, COLORS.phage, 3, 2.0, 2, 0, 0, 0.6);
      }
    }
  }

  private lysisFx(e: Extract<MicroEvent, { kind: 'lysis' }>): void {
    const ux = Math.cos(e.angle);
    const uy = Math.sin(e.angle);
    const d = this.runner.model.rates.cellWidth * (0.92 + 0.16 * hash(e.cellId, 1));
    const sc = d / CELL_D;
    const shell = (tex: Texture, tint: number, blend: BLEND_MODES, life: number, grow: number, alpha: number) => {
      const sp = cellSlice(tex);
      placeSlice(sp, 0, e.len, sc);
      sp.position.set(e.x, e.y);
      sp.rotation = e.angle;
      sp.tint = tint;
      sp.blendMode = blend;
      sp.alpha = alpha;
      this.fxLayer.addChild(sp);
      this.fx.push({ sprite: sp, age: 0, life, vx: 0, vy: 0, grow, alpha0: alpha, baseScale: sc });
    };
    const debris = (n: number, tint: number, blend: BLEND_MODES, alpha: number) => {
      for (let i = 0; i < n; i++) {
        const along = (this.rng.uniform() - 0.5) * e.len;
        const ang = this.rng.uniform() * Math.PI * 2;
        const sp = 1 + this.rng.uniform() * 2.5;
        this.spawn(softDot(), e.x + ux * along, e.y + uy * along, tint, 0.3 + this.rng.uniform() * 0.25,
          1.2 + this.rng.uniform(), 0, Math.cos(ang) * sp, Math.sin(ang) * sp, alpha, blend);
      }
    };
    if (this.look === 'phase') {
      // В обычный микроскоп лопнувшая клетка становится светлой пустой оболочкой — «призраком»,
      // который постепенно исчезает. Вирусов не видно: они слишком малы.
      shell(phaseGhost(), 0xffffff, 'normal', 6, 0.04, 1);
      debris(5, 0x353a34, 'normal', 0.5);
      return;
    }
    // «Лопание»: вспышка клетки, облако содержимого и новых вирусов.
    shell(fluoCell(), 0xffe2c0, 'add', 0.15, 0.3, 1);
    this.spawn(glowSpot(), e.x, e.y, COLORS.phage, 1.5, 1.2, 4, 0, 0, 0.45);
    debris(9, COLORS.debris, 'add', 0.8);
    // Новые вирусы разлетаются из клетки и дальше плавают вокруг (см. updatePhages).
    const n = Math.min(400, Math.round(e.burst * this.phageScale));
    for (let i = 0; i < n; i++) {
      const along = (this.rng.uniform() - 0.5) * e.len * 0.8;
      const ang = this.rng.uniform() * Math.PI * 2;
      const sp = 20 + this.rng.uniform() * 40;
      this.addPhage(e.x + ux * along, e.y + uy * along, Math.cos(ang) * sp, Math.sin(ang) * sp);
    }
  }

  private spawn(
    tex: Texture, x: number, y: number, tint: number, size: number, life: number, grow: number,
    vx: number, vy: number, alpha: number, blend: BLEND_MODES = 'add',
  ): void {
    const sp = new Sprite(tex);
    sp.anchor.set(0.5);
    sp.position.set(x, y);
    sp.tint = tint;
    sp.blendMode = blend;
    const base = size / tex.width;
    sp.scale.set(base);
    sp.alpha = alpha;
    this.fxLayer.addChild(sp);
    this.fx.push({ sprite: sp, age: 0, life, vx, vy, grow, alpha0: alpha, baseScale: base });
  }

  private attachPoint(c: Cell, a: { u: number; side: number }): { x: number; y: number } {
    const r = this.runner.model.radius;
    const ux = Math.cos(c.angle);
    const uy = Math.sin(c.angle);
    const along = a.u * Math.max(0, c.len / 2 - r);
    const off = a.side * (r + 0.08);
    return { x: c.x + ux * along - uy * off, y: c.y + uy * along + ux * off };
  }

  /** Показать подпись-пояснение внизу кадра (попадает и в видео). */
  showCaption(text: string): void {
    this.captionText.text = text;
    const W = this.app.screen.width;
    const pad = 14;
    const w = this.captionText.width + pad * 2;
    const h = this.captionText.height + pad * 2;
    const fieldBottom = this.world.y + this.runner.model.cond.height * this.pxPerUm;
    const x = Math.max(16, this.world.x + (this.runner.model.cond.width * this.pxPerUm - w) / 2);
    const y = Math.min(this.app.screen.height - h - 50, fieldBottom - h - 16);
    this.captionBg.clear()
      .roundRect(0, 0, w, h, 10).fill({ color: 0x08131b, alpha: 0.9 })
      .roundRect(0, 0, w, h, 10).stroke({ width: 1.5, color: COLORS.phage, alpha: 0.6 });
    this.captionText.position.set(pad, pad);
    this.caption.position.set(Math.min(x, W - w - 16), y);
    this.caption.visible = true;
    this.caption.alpha = 1;
    this.captionAge = 0;
  }

  hideCaption(): void {
    this.caption.visible = false;
  }

  // ------------------------------------------------------------------ кадр

  private frame(dt: number): void {
    if (!this.visible) return;
    this.time += dt;
    this.frameNo++;
    const m = this.runner.model;
    const r = m.rates;
    const d = r.cellWidth;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 6);
    const g = m.relGrowth;
    const healthy = lerpColor(COLORS.starving, COLORS.sensitive, Math.min(1, g * 1.15));
    const fluo = this.look === 'fluo';
    this.updateFood(m, dt);

    // --- клетки
    for (const c of m.cells) {
      let cs = this.sprites.get(c.id);
      if (!cs) cs = this.makeCellSprite(c.id);
      cs.seen = this.frameNo;
      cs.root.position.set(c.x, c.y);
      cs.root.rotation = c.angle;

      let color: number;
      let scaleK = 1;
      let alpha = 1;
      let prog = 0;
      if (c.state === 'S') {
        color = healthy;
        alpha = 0.75 + 0.25 * Math.min(1, g);
      } else if (c.state === 'R') {
        color = COLORS.resistant;
      } else if (c.state === 'I') {
        prog = Math.min(1, c.age / Math.max(1, c.lysisAge));
        color = infectedColor(prog);
        scaleK = 1 + 0.05 * prog;
      } else {
        prog = 1;
        color = lerpColor(COLORS.lysisInhibited, 0xffb3bb, pulse * 0.5);
        scaleK = 1.08 + 0.03 * pulse;
      }
      // Клетки немного различаются толщиной и яркостью, как настоящие.
      const dd = d * (0.92 + 0.16 * hash(c.id, 1)) * scaleK;
      const sc = dd / CELL_D;
      // Перед делением (заражённые клетки не делятся) клетка рисуется двумя половинками,
      // смыкающимися концами: на стыке растёт перегородка и появляется перетяжка.
      let level = 0;
      if (c.state === 'S' || c.state === 'R') {
        const k = smoothstep(0.7, 1, c.len / c.divLen);
        level = Math.min(PINCH_LEVELS.length - 1, Math.floor(k * PINCH_LEVELS.length));
      }
      const split = level > 0;
      if (cs.level !== level) {
        cs.level = level;
        // У каждой клетки свой рисунок шероховатости; у половинок — разный.
        const va = Math.floor(hash(c.id, 9) * ROUGH_VARIANTS);
        const vb = (va + 1) % ROUGH_VARIANTS;
        const pl = split ? PINCH_LEVELS[level] : -1;
        cs.a.texture = fluo ? fluoCell(pl, va) : phaseCell(pl, va);
        cs.b.texture = fluo ? fluoCell(pl, vb) : phaseCell(pl, vb);
        if (cs.ha && cs.hb) {
          const ht = split ? phaseHalo(PINCH_LEVELS[level]) : phaseHalo();
          cs.ha.texture = ht;
          cs.hb.texture = ht;
        }
      }
      const half = split ? Math.max(dd, c.len / 2) : c.len;
      const off = split ? c.len / 4 : 0;
      placeSlice(cs.a, -off, half, sc);
      placeSlice(cs.b, off, half, sc);
      cs.b.rotation = Math.PI;
      cs.b.visible = split;
      if (cs.hb) cs.hb.visible = split;
      if (fluo) {
        const a = alpha * (0.82 + 0.18 * hash(c.id, 2));
        cs.a.tint = cs.b.tint = color;
        cs.a.alpha = cs.b.alpha = a;
      } else if (cs.halo && cs.ha && cs.hb) {
        cs.halo.position.set(c.x, c.y);
        cs.halo.rotation = c.angle;
        placeSlice(cs.ha, -off, half, sc);
        placeSlice(cs.hb, off, half, sc);
        cs.hb.rotation = Math.PI;
      }

      // ДНК бактерии (нуклеоид). Перед делением копия ДНК расходится к будущим дочерним клеткам.
      // Вирус T4 в первые минуты разрушает ДНК бактерии — нуклеоид в заражённой клетке тает.
      const q = c.len / c.divLen;
      const sepK = c.state === 'S' || c.state === 'R' ? smoothstep(0.55, 0.85, q) : 0;
      const dnaFade = c.state === 'I' || c.state === 'LI' ? Math.max(0, 1 - c.age / 6) : 1;
      const nucLen = c.len * (0.46 - 0.18 * sepK);
      const nucW = dd * 0.56;
      const sep = (c.len / 4) * sepK;
      const nucTint = fluo ? lerpColor(color, 0x000000, 0.55) : 0x9da396;
      const nucAlpha = (fluo ? 0.75 : 0.5) * dnaFade;
      for (let i = 0; i < 2; i++) {
        const sp = cs.nuc[i];
        sp.visible = nucAlpha > 0.02;
        if (!sp.visible) continue;
        const jx = (hash(c.id, 60 + i) - 0.5) * 0.12 * c.len;
        sp.position.set((i === 0 ? -sep : sep) + jx * (1 - sepK * 0.5), (hash(c.id, 62 + i) - 0.5) * dd * 0.12);
        sp.width = nucLen;
        sp.height = nucW;
        sp.rotation = (hash(c.id, 64 + i) - 0.5) * 0.25;
        sp.tint = nucTint;
        sp.alpha = nucAlpha * (sepK > 0 ? 1 : i === 0 ? 1 : 0);
      }
      // Включения в цитоплазме — мелкие тёмные крупинки, у каждой клетки свои.
      const gReach = Math.max(0, c.len / 2 - dd * 0.35);
      for (let i = 0; i < cs.granules.length; i++) {
        const sp = cs.granules[i];
        sp.position.set((hash(c.id, 80 + i) * 2 - 1) * gReach, (hash(c.id, 90 + i) * 2 - 1) * dd * 0.28);
        sp.tint = fluo ? lerpColor(color, 0x000000, 0.6) : 0x14170f;
        sp.alpha = fluo ? 0.55 : 0.45;
      }

      // Новые вирусы внутри заражённой клетки — светлые крупинки (при флуоресцентной метке).
      const nSpecks = fluo && prog > 0 ? Math.min(18, Math.floor(c.progeny / 8)) : 0;
      while (cs.specks.length < nSpecks) {
        const sp = new Sprite(softDot());
        sp.anchor.set(0.5);
        sp.blendMode = 'add';
        sp.scale.set(0.2 / 64);
        cs.root.addChild(sp);
        cs.specks.push(sp);
      }
      const reach = Math.max(0, c.len / 2 - dd * 0.4);
      const speckTint = lerpColor(color, 0xffffff, 0.65);
      for (let i = 0; i < cs.specks.length; i++) {
        const sp = cs.specks[i];
        sp.visible = i < nSpecks;
        if (!sp.visible) continue;
        const w = this.time * 2.2 + i * 1.7;
        sp.position.set(
          (hash(c.id, 10 + i) * 2 - 1) * reach + 0.04 * Math.sin(w),
          (hash(c.id, 40 + i) * 2 - 1) * dd * 0.24 + 0.04 * Math.cos(w * 1.3),
        );
        sp.tint = speckTint;
        sp.alpha = 0.7;
      }

      // прилипшие вирусы (оболочки фагов остаются на поверхности); в обычный микроскоп их не видно
      const att = fluo ? c.attached.filter((a) => m.t - a.t < 40) : [];
      while (cs.dots.length < att.length) {
        const dot = new Sprite(softDot());
        dot.anchor.set(0.5);
        dot.tint = COLORS.phage;
        dot.blendMode = 'add';
        cs.root.addChild(dot);
        cs.dots.push(dot);
      }
      for (let i = 0; i < cs.dots.length; i++) {
        const dot = cs.dots[i];
        const a = att[i];
        if (!a) {
          dot.visible = false;
          continue;
        }
        dot.visible = true;
        const rr = dd / 2;
        dot.position.set(a.u * Math.max(0, c.len / 2 - rr), a.side * (rr + 0.1));
        const sz = 0.42 / 64;
        dot.scale.set(sz * (1 + 0.15 * Math.sin(this.time * 5 + i)));
        dot.alpha = 0.95;
      }
    }
    // удалить спрайты исчезнувших клеток
    for (const [id, cs] of this.sprites) {
      if (cs.seen !== this.frameNo) {
        cs.root.destroy({ children: true });
        cs.halo?.destroy({ children: true });
        this.sprites.delete(id);
      }
    }

    // --- поле свободного фага (интенсивность по логарифму концентрации)
    if (!fluo) this.phageSprite.visible = false;
    else if (this.frameNo % 2 === 0) this.drawPhageField(m);
    this.updatePhages(m, dt);

    // --- шум камеры: каждый кадр немного другой
    this.grain.tilePosition.set(this.rng.uniform() * 128, this.rng.uniform() * 128);

    // --- выделенная клетка
    this.selection.clear();
    if (this.selectedId !== null) {
      const c = m.cellById(this.selectedId);
      if (c) {
        const k = c.state === 'LI' ? 1.2 : 1.1;
        const rr = (d / 2) * k + 0.35;
        const L = c.len * (c.state === 'LI' ? 1.02 : 1) + 0.7;
        const ux = Math.cos(c.angle);
        const uy = Math.sin(c.angle);
        // контур-капсула вокруг клетки (рисуем повернутый прямоугольник со скруглениями)
        const pts: number[] = [];
        const half = L / 2 - rr;
        for (let i = 0; i <= 16; i++) {
          const a = -Math.PI / 2 + (Math.PI * i) / 16;
          pts.push(half + Math.cos(a) * rr, Math.sin(a) * rr);
        }
        for (let i = 0; i <= 16; i++) {
          const a = Math.PI / 2 + (Math.PI * i) / 16;
          pts.push(-half + Math.cos(a) * rr, Math.sin(a) * rr);
        }
        const world: number[] = [];
        for (let i = 0; i < pts.length; i += 2) {
          world.push(c.x + ux * pts[i] - uy * pts[i + 1], c.y + uy * pts[i] + ux * pts[i + 1]);
        }
        this.selection.poly(world, true).stroke({ width: 2.5 / this.pxPerUm, color: fluo ? 0xffffff : 0xffd23f, alpha: 0.55 + 0.4 * pulse });
      } else {
        this.selectedId = null;
      }
    }

    // --- эффекты
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.age += dt;
      const k = f.age / f.life;
      if (k >= 1) {
        f.sprite.destroy();
        this.fx.splice(i, 1);
        continue;
      }
      f.sprite.x += f.vx * dt;
      f.sprite.y += f.vy * dt;
      f.vx *= Math.exp(-2.5 * dt);
      f.vy *= Math.exp(-2.5 * dt);
      if (f.grow) f.sprite.scale.set(f.baseScale * (1 + f.grow * k));
      f.sprite.alpha = f.alpha0 * (1 - k);
    }

    // --- подпись: гаснет через 9 секунд
    if (this.caption.visible) {
      this.captionAge += dt;
      if (this.captionAge > 9) this.caption.alpha = Math.max(0, 1 - (this.captionAge - 9) / 1.5);
      if (this.captionAge > 10.5) this.caption.visible = false;
    }

    this.updateHud(m);
  }

  private makeCellSprite(id: number): CellSprite {
    const fluo = this.look === 'fluo';
    const v = Math.floor(hash(id, 9) * ROUGH_VARIANTS);
    const tex = fluo ? fluoCell(-1, v) : phaseCell(-1, v);
    const root = new Container();
    const a = cellSlice(tex);
    const b = cellSlice(tex);
    root.addChild(a, b);
    const nuc: [Sprite, Sprite] = [0, 1].map((i) => {
      const sp = new Sprite(nucleoid(Math.floor(hash(id, 70 + i) * 4)));
      sp.anchor.set(0.5);
      if (hash(id, 72 + i) < 0.5) sp.scale.x *= -1;
      root.addChild(sp);
      return sp;
    }) as [Sprite, Sprite];
    const granules: Sprite[] = [];
    const ng = 2 + Math.floor(hash(id, 75) * 3);
    for (let i = 0; i < ng; i++) {
      const sp = new Sprite(softDot());
      sp.anchor.set(0.5);
      sp.scale.set((0.1 + 0.06 * hash(id, 76 + i)) / 64);
      root.addChild(sp);
      granules.push(sp);
    }
    this.cellsLayer.addChild(root);
    let halo: Container | null = null;
    let ha: NineSliceSprite | null = null;
    let hb: NineSliceSprite | null = null;
    if (!fluo) {
      halo = new Container();
      ha = cellSlice(phaseHalo());
      hb = cellSlice(phaseHalo());
      halo.addChild(ha, hb);
      this.haloLayer.addChild(halo);
    }
    const cs: CellSprite = { root, a, b, halo, ha, hb, nuc, granules, specks: [], dots: [], seen: 0, level: -1 };
    this.sprites.set(id, cs);
    return cs;
  }

  // ------------------------------------------------------------------ свободные вирусы

  private addPhage(x: number, y: number, vx: number, vy: number): void {
    const sp = new Sprite(softDot());
    sp.anchor.set(0.5);
    sp.tint = COLORS.phage;
    sp.blendMode = 'add';
    sp.alpha = 0;
    this.phageLayer.addChild(sp);
    this.phages.push({ sp, x, y, vx, vy, age: 0 });
  }

  /**
   * Точки-вирусы следуют за полем свободного фага в модели. Каждая точка блуждает случайно
   * с тем же коэффициентом диффузии, что и в модели; число точек и их распределение
   * сверяются с полем: где вирусы поглотили бактерии — точки исчезают, где поле прибавилось
   * (капля) — появляются. На расчёт модели это не влияет.
   */
  private updatePhages(m: MicroscopeModel, dt: number): void {
    const fluo = this.look === 'fluo';
    this.phageLayer.visible = fluo;
    if (!fluo) return;
    const W = m.cond.width;
    const H = m.cond.height;
    const gw = m.gw;
    const n = gw * m.gh;
    let total = 0;
    for (let j = 0; j < n; j++) total += m.pWt[j] + m.pR[j];
    this.phageScale = Math.min(1, MAX_PHAGES / Math.max(1, total));
    const target = Math.round(total * this.phageScale);
    let dtSim = m.t - this.lastSimT;
    this.lastSimT = m.t;
    if (dtSim < 0) dtSim = 0;

    // движение
    const D = m.rates.phageDiffusion;
    if (dtSim > 1.5) {
      // Долгая перемотка: точки «перетасовываются» по полю заново.
      for (const ph of this.phages) ph.sp.destroy();
      this.phages = [];
    } else if (dtSim > 0) {
      const a = Math.exp(-dtSim / PHAGE_TAU);
      const sv = Math.sqrt(D / PHAGE_TAU) * Math.sqrt(1 - a * a);
      for (const ph of this.phages) {
        ph.vx = ph.vx * a + sv * this.rng.normal();
        ph.vy = ph.vy * a + sv * this.rng.normal();
        ph.x += ph.vx * dtSim;
        ph.y += ph.vy * dtSim;
        if (ph.x < 0) { ph.x = -ph.x; ph.vx = -ph.vx; }
        if (ph.x > W) { ph.x = 2 * W - ph.x; ph.vx = -ph.vx; }
        if (ph.y < 0) { ph.y = -ph.y; ph.vy = -ph.vy; }
        if (ph.y > H) { ph.y = 2 * H - ph.y; ph.vy = -ph.vy; }
        ph.x = Math.min(W - 0.01, Math.max(0.01, ph.x));
        ph.y = Math.min(H - 0.01, Math.max(0.01, ph.y));
      }
    }

    // сверка с полем модели
    if (this.phages.length !== target) {
      if (this.nodeCount.length !== n) this.nodeCount = new Float32Array(n);
      const cnt = this.nodeCount;
      cnt.fill(0);
      const node = (x: number, y: number) =>
        Math.min(m.gh - 1, Math.floor(y / m.h)) * gw + Math.min(gw - 1, Math.floor(x / m.h));
      for (const ph of this.phages) cnt[node(ph.x, ph.y)]++;
      if (this.phages.length > target) {
        // Убираем точки там, где их больше, чем вирусов в поле (их поглотили бактерии).
        const keyed = this.phages.map((ph) => {
          const j = node(ph.x, ph.y);
          return { ph, k: cnt[j] - (m.pWt[j] + m.pR[j]) * this.phageScale + this.rng.uniform() * 0.5 };
        });
        keyed.sort((p, q) => q.k - p.k);
        const drop = new Set(keyed.slice(0, this.phages.length - target).map((x) => x.ph));
        const size = Math.max(0.26, 3 / this.pxPerUm);
        for (const ph of drop) {
          // Вирус садится на бактерию: точка подлетает к её поверхности и гаснет.
          if (this.fx.length < 300) {
            const c = drop.size <= 60 ? m.cellAt(ph.x, ph.y) : undefined;
            let vx = 0;
            let vy = 0;
            if (c) {
              const ux = Math.cos(c.angle);
              const uy = Math.sin(c.angle);
              const halfLen = Math.max(0, c.len / 2 - m.radius);
              const s = Math.max(-halfLen, Math.min(halfLen, (ph.x - c.x) * ux + (ph.y - c.y) * uy));
              const ax = c.x + ux * s;
              const ay = c.y + uy * s;
              const dx = ph.x - ax;
              const dy = ph.y - ay;
              const dl = Math.hypot(dx, dy) || 1;
              const r = m.radius + 0.08;
              // скорость подобрана так, чтобы за 0,3 с (с затуханием) точка дошла до оболочки
              vx = (ax + (dx / dl) * r - ph.x) / 0.21;
              vy = (ay + (dy / dl) * r - ph.y) / 0.21;
            }
            this.spawn(softDot(), ph.x, ph.y, COLORS.phage, size, 0.3, 0.3, vx, vy, 0.9);
          }
          ph.sp.destroy();
        }
        this.phages = this.phages.filter((ph) => !drop.has(ph));
      } else {
        // Добавляем точки там, где вирусов в поле больше, чем точек.
        let need = target - this.phages.length;
        let wsum = 0;
        const w = new Float32Array(n);
        for (let j = 0; j < n; j++) {
          w[j] = Math.max(0, (m.pWt[j] + m.pR[j]) * this.phageScale - cnt[j]);
          wsum += w[j];
        }
        if (wsum <= 0) {
          for (let j = 0; j < n; j++) wsum += (w[j] = m.pWt[j] + m.pR[j]);
        }
        while (need-- > 0 && wsum > 0) {
          let r = this.rng.uniform() * wsum;
          let j = 0;
          while (j < n - 1 && (r -= w[j]) > 0) j++;
          const gx = j % gw;
          const gy = Math.floor(j / gw);
          const sv = Math.sqrt(D / PHAGE_TAU);
          this.addPhage(
            Math.min(W - 0.01, (gx + this.rng.uniform()) * m.h),
            Math.min(H - 0.01, (gy + this.rng.uniform()) * m.h),
            sv * this.rng.normal(), sv * this.rng.normal(),
          );
        }
      }
    }

    // отрисовка
    const size = Math.max(0.26, 3 / this.pxPerUm) / 64;
    for (const ph of this.phages) {
      ph.age += dt;
      ph.sp.position.set(ph.x, ph.y);
      ph.sp.scale.set(size);
      ph.sp.alpha = 0.95 * Math.min(1, ph.age / 0.25);
    }
  }

  private drawPhageField(m: MicroscopeModel): void {
    const w = m.gw;
    const h = m.gh;
    if (this.phageCanvas.width !== w || this.phageCanvas.height !== h) {
      this.phageCanvas.width = w;
      this.phageCanvas.height = h;
      this.phageTex.source.resize(w, h);
    }
    const ctx = this.phageCanvas.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    let any = false;
    for (let j = 0; j < w * h; j++) {
      const n = m.pWt[j] + m.pR[j];
      if (n <= 0.001) continue;
      any = true;
      const a = Math.min(1, Math.log10(1 + n * 6) / 2.6);
      const o = j * 4;
      img.data[o] = 255;
      img.data[o + 1] = 255;
      img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(a * 220);
    }
    ctx.putImageData(img, 0, 0);
    this.phageSprite.visible = any;
    this.phageTex.source.update();
  }

  private updateHud(m: MicroscopeModel): void {
    const s = m.snapshot();
    const tx = this.texts;
    tx.clock.text = `прошло: ${fmtDuration(s.t)}`;
    tx.scenario.text = this.scenarioName;
    tx.info.text = `поле зрения ${m.cond.width} × ${m.cond.height} мкм · ${m.cond.temperature} °C · seed ${m.rng.seed}`;
    tx.mode.text = this.dropMode
      ? 'Щёлкни по полю — туда упадёт капля с вирусами'
      : this.slowMo ? 'Замедление ×1: время идёт как в жизни — смотри, как разлетаются вирусы' : '';
    if (this.food.visible) {
      this.food.draw(m, microFoodData(m));
      this.placeLegend();
    } else {
      tx.info.text += ` · еды в агаре ${Math.round(m.food * 100)} %`;
    }
    if (tx.countLabels.visible) {
      tx.countLabels.text = ['Бактерий всего', '   здоровых', '   заражённых', '   устойчивых', 'Лопнуло бактерий', 'Вирусов вокруг', 'Вышло из последней'].join('\n');
      const free = s.phage;
      tx.countVals.text = [
        String(s.cells), String(s.S), String(s.I + s.LI), String(s.R), String(s.lysed),
        free < 1 ? '0' : free < 1000 ? String(Math.round(free)) : `≈ ${Math.round(free / 100) * 100}`,
        s.lastBurst ? String(s.lastBurst) : '—',
      ].join('\n');
    }
  }

  async snapshotPng(): Promise<Blob> {
    const canvas = this.app.renderer.extract.canvas({ target: this.app.stage }) as HTMLCanvasElement;
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG'))), 'image/png'));
  }
}
