/**
 * Модуль 3 — микроскоп: агентная модель небольшого участка колонии.
 *
 * Каждая клетка — капсула (отрезок с радиусом) с координатами, углом и длиной. Клетка
 * удлиняется со скоростью, зависящей от субстрата, и делится пополам с небольшим
 * отклонением угла. Перекрывающиеся капсулы мягко расталкиваются (позиционная динамика,
 * без инерции — среда вязкая); соседей ищем через равномерную пространственную сетку.
 *
 * Фаг — непрерывное поле на сетке 1 мкм (отдельные вирионы не моделируются). Фаг
 * диффундирует; доля фага в узле, поглощённая клетками за шаг, = 1 − exp(−k·φ·dt/H),
 * где φ — доля площади узла, занятая клетками, H — толщина слоя. Поглощённые фаги
 * распределяются по клеткам, накрывающим узел, и разыгрываются как отдельные события.
 * При лизисе клетка удаляется, а в её узлы добавляются частицы потомства.
 *
 * Биология заражения — та же, что в колбе: фиксированный латентный период с разбросом,
 * эклипс, торможение лизиса, исключение суперинфекции, физиология хозяина, r-мутации.
 * Ядро ничего не знает об отрисовке; для анимации модель складывает события в очередь.
 */
import { Rng } from '../rng';
import {
  type Params, type Mechanisms, type Rates,
  deriveRates, phageDevelopmentSpeed, phageBurstQuality,
} from '../params';

export type CellState = 'S' | 'I' | 'LI' | 'R';

export interface Cell {
  id: number;
  x: number;
  y: number;
  angle: number;
  /** Полная длина вместе со скруглёнными концами, мкм. */
  len: number;
  divLen: number;
  state: CellState;
  /** 0 — заражена фагом дикого типа, 1 — r-мутантом. */
  genotype: 0 | 1;
  /** Время заражения, мин модели. */
  infectedAt: number;
  /** Возраст развития фага внутри, мин (при нормальной физиологии = времени с заражения). */
  age: number;
  /** Индивидуальный момент лизиса (по возрасту развития). */
  lysisAge: number;
  /** Зрелых частиц внутри. */
  progeny: number;
  /** Время последней повторной адсорбции — поддерживает торможение лизиса. */
  lastSecondary: number;
  /** Точки прикрепления фагов на поверхности: доля вдоль оси (−1..1) и сторона (±1). */
  attached: { u: number; side: number; t: number }[];
  /** Накопленное ожидаемое число попаданий за текущий шаг механики. */
  hitWt: number;
  hitR: number;
  /** Поколение — для подписи в карточке клетки. */
  generation: number;
  /** Узлы сетки фага, накрытые клеткой, и доля площади клетки в каждом (пересчитываются каждый шаг механики). */
  sIdx: Int32Array;
  sW: Float32Array;
  sN: number;
}

const MAX_SAMPLES = 16;

export type MicroEvent =
  | { kind: 'adsorb'; t: number; cellId: number; x: number; y: number; primary: boolean }
  | { kind: 'eclipse'; t: number; cellId: number }
  | { kind: 'lysis'; t: number; cellId: number; x: number; y: number; angle: number; len: number; burst: number; li: boolean; infectedAt: number }
  | { kind: 'li'; t: number; cellId: number }
  | { kind: 'divide'; t: number; cellId: number; childId: number }
  | { kind: 'drop'; t: number; x: number; y: number; amount: number }
  | { kind: 'mutantR'; t: number; cellId: number };

export interface MicroConditions {
  /** Размер поля зрения, мкм. */
  width: number;
  height: number;
  /** Сколько клеток посеяно в начале. */
  seedCells: number;
  /** Сколько минут колония «подрастает» до начала опыта (не показывается). */
  pregrowMin: number;
  /** Доля устойчивых клеток в посеве, %. */
  resistantPct: number;
  /** Капля фага: когда (мин), сколько частиц, где (доли поля). Количество 0 — без капли. */
  dropTime: number;
  dropAmount: number;
  dropX: number;
  dropY: number;
  /** Доля r-мутантов в капле, %. */
  dropRPct: number;
  temperature: number;
  /** Субстрат в агаре, мМ глюкозы. */
  substrateMM: number;
  duration: number;
}

export interface MicroSnapshot {
  t: number;
  cells: number;
  S: number;
  starving: number;
  I: number;
  LI: number;
  R: number;
  phage: number;
  lysed: number;
  growth: number;
  lastBurst: number;
}

/** Толщина слоя агара, в котором находятся клетки и фаг, мкм (для пересчёта концентраций). */
const LAYER_DEPTH = 1;
/** Глубина агара под полем зрения — запас субстрата, мкм. */
const AGAR_DEPTH = 4000;
const MECH_DT = 0.04; // мин — шаг роста, деления и механики

export class MicroscopeModel {
  readonly rng: Rng;
  readonly params: Params;
  readonly mech: Mechanisms;
  readonly cond: MicroConditions;
  readonly rates: Rates;

  // сетка фага
  readonly h = 1; // мкм
  readonly gw: number;
  readonly gh: number;
  pWt: Float32Array;
  pR: Float32Array;
  private tmp: Float32Array;
  private cover: Float32Array;
  private covered: Uint8Array;
  private capWt: Float32Array;
  private capR: Float32Array;
  private readonly diffDt: number;

  cells: Cell[] = [];
  private nextId = 1;
  time = 0;
  private mechClock = 0;
  /** Субстрат, мкМ (общий для поля — глюкоза в агаре выравнивается очень быстро). */
  N: number;
  private readonly reservoirMl: number;
  relGrowth = 1;

  lysed = 0;
  lastBurst = 0;
  readonly events: MicroEvent[] = [];
  private dropped = false;

  constructor(params: Params, mech: Mechanisms, cond: MicroConditions, seed: number) {
    this.params = { ...params };
    this.mech = { ...mech };
    this.cond = { ...cond };
    this.rng = new Rng(seed);
    this.rates = deriveRates(this.params, cond.temperature);
    this.gw = Math.ceil(cond.width / this.h);
    this.gh = Math.ceil(cond.height / this.h);
    const n = this.gw * this.gh;
    this.pWt = new Float32Array(n);
    this.pR = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.cover = new Float32Array(n);
    this.covered = new Uint8Array(n);
    this.capWt = new Float32Array(n);
    this.capR = new Float32Array(n);
    // Устойчивость явной схемы диффузии: dt ≤ h²/(4D); берём с запасом.
    this.diffDt = Math.min(MECH_DT / 2, (0.24 * this.h * this.h) / Math.max(1e-6, this.rates.phageDiffusion));
    this.N = cond.substrateMM * 1000;
    // Объём агара под полем зрения, мл: мкм³ × 10⁻¹².
    this.reservoirMl = cond.width * cond.height * AGAR_DEPTH * 1e-12;
    this.seed();
  }

  get t(): number {
    return this.time;
  }

  /** Доля питания, оставшаяся в агаре (1 — как в начале, 0 — всё съедено). */
  get food(): number {
    const n0 = this.cond.substrateMM * 1000;
    return n0 > 0 ? Math.min(1, this.N / n0) : 0;
  }

  get duration(): number {
    return this.cond.duration;
  }

  get done(): boolean {
    return this.time >= this.cond.duration - 1e-9;
  }

  get radius(): number {
    return this.rates.cellWidth / 2;
  }

  // ------------------------------------------------------------------ посев

  private newCell(x: number, y: number, angle: number, len: number, state: CellState, generation: number): Cell {
    return {
      id: this.nextId++, x, y, angle, len,
      divLen: this.drawDivLen(), state, genotype: 0, infectedAt: 0, age: 0, lysisAge: 0, progeny: 0,
      lastSecondary: 0, attached: [], hitWt: 0, hitR: 0, generation,
      sIdx: new Int32Array(MAX_SAMPLES), sW: new Float32Array(MAX_SAMPLES), sN: 0,
    };
  }

  private drawDivLen(): number {
    return this.rates.divisionLength * (1 + 0.1 * Math.max(-2.5, Math.min(2.5, this.rng.normal())));
  }

  private seed(): void {
    const c = this.cond;
    const L = this.rates.divisionLength;
    for (let i = 0; i < c.seedCells; i++) {
      const spread = c.seedCells <= 4 ? 0.06 : 0.9;
      const x = c.width * (0.5 + (this.rng.uniform() - 0.5) * spread);
      const y = c.height * (0.5 + (this.rng.uniform() - 0.5) * spread);
      const len = L * (0.5 + 0.5 * this.rng.uniform());
      this.cells.push(this.newCell(x, y, this.rng.uniform() * Math.PI, len, 'S', 0));
    }
    // Подращиваем колонию без фага: получается естественная упаковка палочек.
    const PRE_DT = 0.1; // предварительный рост — крупными шагами, это быстро и незаметно
    const steps = Math.round(c.pregrowMin / PRE_DT);
    for (let i = 0; i < steps; i++) this.mechStep(true, PRE_DT);
    if (c.resistantPct > 0) {
      for (const cell of this.cells) if (this.rng.uniform() * 100 < c.resistantPct) cell.state = 'R';
    }
    for (const cell of this.cells) cell.generation = 0;
    this.events.length = 0;
  }

  // ------------------------------------------------------------------ управление

  /** Капнуть фаг в точку (мкм). Используется и протоколом, и кликом пользователя. */
  addDrop(x: number, y: number, amount: number, rPct = this.cond.dropRPct): void {
    const sigma = 2.0;
    const total = Math.max(0, Math.round(amount));
    const nR = this.rng.binomial(total, Math.min(1, Math.max(0, rPct / 100)));
    for (let i = 0; i < total; i++) {
      const px = x + sigma * this.rng.normal();
      const py = y + sigma * this.rng.normal();
      const gx = Math.floor(px / this.h);
      const gy = Math.floor(py / this.h);
      if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) continue;
      if (i < nR) this.pR[gy * this.gw + gx] += 1;
      else this.pWt[gy * this.gw + gx] += 1;
    }
    this.events.push({ kind: 'drop', t: this.time, x, y, amount: total });
  }

  advance(minutes: number): void {
    const target = Math.min(this.cond.duration, this.time + minutes);
    while (this.time < target - 1e-9) {
      if (!this.dropped && this.cond.dropAmount > 0 && this.time >= this.cond.dropTime - 1e-9) {
        this.dropped = true;
        this.addDrop(this.cond.dropX * this.cond.width, this.cond.dropY * this.cond.height, this.cond.dropAmount);
      }
      const dt = Math.min(this.diffDt, target - this.time, MECH_DT - this.mechClock);
      this.phageStep(dt);
      this.time += dt;
      this.mechClock += dt;
      if (this.mechClock >= MECH_DT - 1e-9) {
        this.mechClock = 0;
        this.mechStep(false);
      }
    }
  }

  // ------------------------------------------------------------------ фаг: диффузия и захват

  private phageStep(dt: number): void {
    const D = this.rates.phageDiffusion;
    const a = (D * dt) / (this.h * this.h);
    this.diffuse(this.pWt, a);
    this.diffuse(this.pR, a);
    const kLayer = this.rates.k * 1e12 / (LAYER_DEPTH * this.h * this.h); // мл/мин → мкм³/мин, на узел
    const decay = this.mech.phageDecay ? Math.exp(-this.rates.decay * dt) : 1;
    for (let j = 0; j < this.pWt.length; j++) {
      const phi = this.cover[j];
      if (phi > 0) {
        const f = 1 - Math.exp(-kLayer * phi * dt);
        const cw = this.pWt[j] * f;
        const cr = this.pR[j] * f;
        this.pWt[j] -= cw;
        this.pR[j] -= cr;
        this.capWt[j] += cw;
        this.capR[j] += cr;
      }
      if (decay < 1) {
        this.pWt[j] *= decay;
        this.pR[j] *= decay;
      }
    }
  }

  /** Явная схема диффузии с непроницаемыми краями поля. */
  private diffuse(f: Float32Array, a: number): void {
    const w = this.gw;
    const hh = this.gh;
    const t = this.tmp;
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        const j = y * w + x;
        const c = f[j];
        const l = x > 0 ? f[j - 1] : c;
        const r = x < w - 1 ? f[j + 1] : c;
        const u = y > 0 ? f[j - w] : c;
        const d = y < hh - 1 ? f[j + w] : c;
        t[j] = c + a * (l + r + u + d - 4 * c);
      }
    }
    f.set(t);
  }

  // ------------------------------------------------------------------ клетки: рост, механика, заражение

  /** Точки вдоль оси клетки (для покрытия сетки и выпуска потомства). */
  private samples(c: Cell): { x: number; y: number; w: number }[] {
    const n = Math.max(2, Math.ceil(c.len / 0.5));
    const area = c.len * this.rates.cellWidth;
    const ux = Math.cos(c.angle);
    const uy = Math.sin(c.angle);
    const half = c.len / 2 - this.radius * 0.5;
    const out: { x: number; y: number; w: number }[] = [];
    for (let i = 0; i < n; i++) {
      const s = n === 1 ? 0 : -half + (2 * half * i) / (n - 1);
      out.push({ x: c.x + ux * s, y: c.y + uy * s, w: area / n });
    }
    return out;
  }

  /** Пересчитать узлы сетки под клеткой (без выделения памяти). */
  private rasterize(c: Cell): void {
    const n = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(c.len / 0.5)));
    const ux = Math.cos(c.angle);
    const uy = Math.sin(c.angle);
    const half = c.len / 2 - this.radius * 0.5;
    const area = (c.len * this.rates.cellWidth) / n;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const sx = -half + (2 * half * i) / (n - 1);
      const j = this.gridIndex(c.x + ux * sx, c.y + uy * sx);
      if (j < 0) continue;
      c.sIdx[k] = j;
      c.sW[k] = area;
      k++;
    }
    c.sN = k;
  }

  private gridIndex(x: number, y: number): number {
    const gx = Math.floor(x / this.h);
    const gy = Math.floor(y / this.h);
    if (gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh) return -1;
    return gy * this.gw + gx;
  }

  private absorbs(c: Cell): number {
    if (c.state === 'R') return this.rates.alphaR;
    return 1;
  }

  private mechStep(pregrow: boolean, dt = MECH_DT): void {
    const r = this.rates;
    const m = this.mech;
    const t = this.time;

    // --- субстрат и физиология
    const g = this.N / (r.monodKs + this.N);
    this.relGrowth = g;

    // --- распределяем захваченные фаги по клеткам
    if (!pregrow) this.distributeHits();

    // --- рост и деление
    const born: Cell[] = [];
    let births = 0;
    for (const c of this.cells) {
      if (c.state === 'S' || c.state === 'R') {
        const mu = (c.state === 'R' ? r.muMaxResistant : r.muMax) * g;
        c.len *= Math.exp(mu * dt);
        if (c.len >= c.divLen) {
          const half = c.len / 2;
          const ux = Math.cos(c.angle);
          const uy = Math.sin(c.angle);
          const off = half / 2;
          const child = this.newCell(c.x + ux * off, c.y + uy * off, c.angle + 0.06 * this.rng.normal(), half, c.state, c.generation + 1);
          c.x -= ux * off;
          c.y -= uy * off;
          c.angle += 0.06 * this.rng.normal();
          c.len = half;
          c.divLen = this.drawDivLen();
          c.generation += 1;
          if (c.state === 'S' && m.resistanceMutations && this.rng.uniform() < r.muRes) {
            child.state = 'R';
            if (!pregrow) this.events.push({ kind: 'mutantR', t, cellId: child.id });
          }
          born.push(child);
          births++;
          if (!pregrow) this.events.push({ kind: 'divide', t, cellId: c.id, childId: child.id });
        }
      } else if (c.state === 'LI') {
        // Клетка с заторможенным лизисом слегка раздувается.
        c.len = Math.min(c.len * (1 + 0.004 * dt), c.divLen * 1.25);
      }
    }
    for (const b of born) this.cells.push(b);
    if (m.substrateDepletion && births > 0) {
      this.N = Math.max(0, this.N - (births * 1000) / (r.yieldPerUmol * this.reservoirMl));
    }

    // --- развитие фага и лизис
    if (!pregrow) {
      const speed = phageDevelopmentSpeed(r, g, m.hostPhysiology);
      const quality = phageBurstQuality(r, g, m.hostPhysiology);
      const survivors: Cell[] = [];
      for (const c of this.cells) {
        if (c.state === 'I' || c.state === 'LI') {
          const a0 = c.age;
          const a1 = a0 + speed * dt;
          c.age = a1;
          if (a1 > r.eclipse) c.progeny += (a1 - Math.max(a0, r.eclipse)) * r.progenyRate * quality;
          if (a0 < r.eclipse && a1 >= r.eclipse) this.events.push({ kind: 'eclipse', t, cellId: c.id });
          let lyse = false;
          if (c.state === 'I') lyse = a1 >= c.lysisAge;
          else {
            const maintained = m.lysisInhibition && t - c.lastSecondary < r.liWindow;
            lyse = a1 >= r.latent && (!maintained || a1 - r.latent >= r.liMaxDuration);
          }
          if (lyse) {
            this.lyse(c);
            continue;
          }
        }
        survivors.push(c);
      }
      this.cells = survivors;
    }

    // --- механика: мягкое отталкивание перекрывающихся капсул
    this.relax(2);

    // --- клетки, вытесненные за край поля зрения, уходят из кадра (поле — окно в большой газон)
    const margin = 1.5;
    const W = this.cond.width;
    const H = this.cond.height;
    this.cells = this.cells.filter((c) => c.x > -margin && c.y > -margin && c.x < W + margin && c.y < H + margin);

    // --- карта покрытия для следующего шага захвата фага
    this.cover.fill(0);
    this.covered.fill(0);
    const inv = 1 / (this.h * this.h);
    for (const c of this.cells) {
      this.rasterize(c);
      const ab = this.absorbs(c);
      if (ab <= 0) continue;
      for (let k = 0; k < c.sN; k++) {
        this.cover[c.sIdx[k]] += c.sW[k] * inv * ab;
        this.covered[c.sIdx[k]] = 1;
      }
    }
  }

  private distributeHits(): void {
    const r = this.rates;
    const m = this.mech;
    const t = this.time;
    const inv = 1 / (this.h * this.h);
    // ожидаемое число попаданий на каждую клетку (узлы и покрытие — с прошлого шага, как и захват)
    for (const c of this.cells) {
      c.hitWt = 0;
      c.hitR = 0;
      const ab = this.absorbs(c);
      if (ab <= 0) continue;
      for (let k = 0; k < c.sN; k++) {
        const j = c.sIdx[k];
        if (this.cover[j] <= 0) continue;
        const share = (c.sW[k] * inv * ab) / this.cover[j];
        c.hitWt += this.capWt[j] * share;
        c.hitR += this.capR[j] * share;
      }
    }
    // Новые клетки (родились на прошлом шаге) ещё не растеризованы — у них sN = 0, они просто не получают фаг.
    // Узлы, где клетка лизировалась, остаются «покрытыми» без хозяина — захваченный там фаг возвращаем в поле.
    const alive = this.covered;
    alive.fill(0);
    for (const c of this.cells) {
      if (this.absorbs(c) <= 0) continue;
      for (let k = 0; k < c.sN; k++) alive[c.sIdx[k]] = 1;
    }
    for (let j = 0; j < alive.length; j++) {
      if (!alive[j] && (this.capWt[j] > 0 || this.capR[j] > 0)) {
        this.pWt[j] += this.capWt[j];
        this.pR[j] += this.capR[j];
      }
    }
    this.capWt.fill(0);
    this.capR.fill(0);

    // события: разыгрываем целые числа попаданий
    for (const c of this.cells) {
      if (c.hitWt <= 0 && c.hitR <= 0) continue;
      const nw = this.rng.poisson(c.hitWt);
      const nr = this.rng.poisson(c.hitR);
      const n = nw + nr;
      if (n === 0) continue;
      if (c.state === 'S') {
        c.state = 'I';
        c.genotype = this.rng.uniform() * n < nr ? 1 : 0;
        c.infectedAt = t;
        c.age = 0;
        c.progeny = 0;
        c.lysisAge = r.latent + r.lysisSd * Math.max(-3, Math.min(3, this.rng.normal()));
        c.lastSecondary = -1e9;
        this.addAttachment(c, n);
        this.events.push({ kind: 'adsorb', t, cellId: c.id, x: c.x, y: c.y, primary: true });
      } else if (c.state === 'I' || c.state === 'LI') {
        this.addAttachment(c, n);
        if (c.age >= r.sieTime) {
          c.lastSecondary = t;
          if (c.state === 'I' && c.genotype === 0 && m.lysisInhibition) {
            c.state = 'LI';
            this.events.push({ kind: 'li', t, cellId: c.id });
          }
        }
        this.events.push({ kind: 'adsorb', t, cellId: c.id, x: c.x, y: c.y, primary: false });
        if (!m.superinfectionExclusion) {
          // Упрощённая модель: встреча с заражённой клеткой не тратит фаг — возвращаем его в поле.
          const j = this.gridIndex(c.x, c.y);
          if (j >= 0) {
            this.pWt[j] += nw;
            this.pR[j] += nr;
          }
        }
      }
      // На устойчивые клетки (α_R > 0) фаг садится, но не заражает — просто теряется.
    }
  }

  private addAttachment(c: Cell, n: number): void {
    for (let i = 0; i < Math.min(n, 3); i++) {
      if (c.attached.length >= 6) c.attached.shift();
      c.attached.push({ u: this.rng.uniform() * 1.6 - 0.8, side: this.rng.uniform() < 0.5 ? -1 : 1, t: this.time });
    }
  }

  private lyse(c: Cell): void {
    const r = this.rates;
    const burstMean = Math.min(c.progeny, r.burstMaxLI);
    const burst = this.rng.poisson(burstMean);
    let mutR = 0;
    if (this.mech.rMutations && c.genotype === 0 && burst > 0) mutR = Math.min(burst, this.rng.poisson(r.muR * burst));
    const smp = this.samples(c);
    const per = 1 / smp.length;
    for (const s of smp) {
      const j = this.gridIndex(s.x, s.y);
      if (j < 0) continue;
      if (c.genotype === 1) this.pR[j] += burst * per;
      else {
        this.pWt[j] += (burst - mutR) * per;
        this.pR[j] += mutR * per;
      }
    }
    this.lysed++;
    this.lastBurst = burst;
    this.events.push({ kind: 'lysis', t: this.time, cellId: c.id, x: c.x, y: c.y, angle: c.angle, len: c.len, burst, li: c.state === 'LI', infectedAt: c.infectedAt });
  }

  /** Позиционная динамика: раздвигаем перекрывающиеся капсулы (поступательно и поворотом). */
  private relax(iterations: number): void {
    const cells = this.cells;
    const n = cells.length;
    if (n < 2) return;
    const d = this.rates.cellWidth;
    const bucket = Math.max(this.rates.divisionLength * 1.3, 3);
    const W = this.cond.width + 4;
    const H = this.cond.height + 4;
    const bw = Math.ceil(W / bucket) + 1;
    const bh = Math.ceil(H / bucket) + 1;
    for (let it = 0; it < iterations; it++) {
      const heads = new Int32Array(bw * bh).fill(-1);
      const next = new Int32Array(n).fill(-1);
      for (let i = 0; i < n; i++) {
        const bx = Math.min(bw - 1, Math.max(0, Math.floor((cells[i].x + 2) / bucket)));
        const by = Math.min(bh - 1, Math.max(0, Math.floor((cells[i].y + 2) / bucket)));
        const b = by * bw + bx;
        next[i] = heads[b];
        heads[b] = i;
      }
      for (let i = 0; i < n; i++) {
        const a = cells[i];
        const bx = Math.min(bw - 1, Math.max(0, Math.floor((a.x + 2) / bucket)));
        const by = Math.min(bh - 1, Math.max(0, Math.floor((a.y + 2) / bucket)));
        for (let oy = -1; oy <= 1; oy++) {
          const yy = by + oy;
          if (yy < 0 || yy >= bh) continue;
          for (let ox = -1; ox <= 1; ox++) {
            const xx = bx + ox;
            if (xx < 0 || xx >= bw) continue;
            for (let j = heads[yy * bw + xx]; j !== -1; j = next[j]) {
              if (j <= i) continue;
              this.resolvePair(a, cells[j], d);
            }
          }
        }
      }
    }
  }

  private resolvePair(a: Cell, b: Cell, d: number): void {
    const rad = d / 2;
    const ha = Math.max(0, a.len / 2 - rad);
    const hb = Math.max(0, b.len / 2 - rad);
    const dxc = b.x - a.x;
    const dyc = b.y - a.y;
    const reach = ha + hb + d;
    if (dxc * dxc + dyc * dyc > reach * reach) return;
    const uax = Math.cos(a.angle), uay = Math.sin(a.angle);
    const ubx = Math.cos(b.angle), uby = Math.sin(b.angle);
    // Ближайшие точки двух отрезков (Ericson, «Real-Time Collision Detection»).
    const p1x = a.x - uax * ha, p1y = a.y - uay * ha;
    const d1x = 2 * uax * ha, d1y = 2 * uay * ha;
    const p2x = b.x - ubx * hb, p2y = b.y - uby * hb;
    const d2x = 2 * ubx * hb, d2y = 2 * uby * hb;
    const rx = p1x - p2x, ry = p1y - p2y;
    const A = d1x * d1x + d1y * d1y;
    const E = d2x * d2x + d2y * d2y;
    const F = d2x * rx + d2y * ry;
    let s = 0;
    let t = 0;
    if (A <= 1e-9 && E <= 1e-9) {
      s = t = 0;
    } else if (A <= 1e-9) {
      t = clamp01(F / E);
    } else {
      const C = d1x * rx + d1y * ry;
      if (E <= 1e-9) {
        s = clamp01(-C / A);
      } else {
        const B = d1x * d2x + d1y * d2y;
        const den = A * E - B * B;
        s = den > 1e-9 ? clamp01((B * F - C * E) / den) : 0;
        t = (B * s + F) / E;
        if (t < 0) {
          t = 0;
          s = clamp01(-C / A);
        } else if (t > 1) {
          t = 1;
          s = clamp01((B - C) / A);
        }
      }
    }
    const cax = p1x + d1x * s, cay = p1y + d1y * s;
    const cbx = p2x + d2x * t, cby = p2y + d2y * t;
    let nx = cax - cbx;
    let ny = cay - cby;
    let dist = Math.sqrt(nx * nx + ny * ny);
    const overlap = d - dist;
    if (overlap <= 0) return;
    if (dist < 1e-6) {
      // Совпадающие оси — раздвигаем перпендикулярно оси a.
      nx = -uay;
      ny = uax;
      dist = 1;
    } else {
      nx /= dist;
      ny /= dist;
    }
    // Твёрдые тела единичной массы: делим поправку с учётом «инерции» поворота.
    const ra_x = cax - a.x, ra_y = cay - a.y;
    const rb_x = cbx - b.x, rb_y = cby - b.y;
    const Ia = (a.len * a.len) / 12 + rad * rad;
    const Ib = (b.len * b.len) / 12 + rad * rad;
    const ca = ra_x * ny - ra_y * nx;
    const cb = rb_x * ny - rb_y * nx;
    const wsum = 2 + (ca * ca) / Ia + (cb * cb) / Ib;
    const lambda = (overlap * 0.8) / wsum;
    a.x += nx * lambda;
    a.y += ny * lambda;
    a.angle += (ca * lambda) / Ia;
    b.x -= nx * lambda;
    b.y -= ny * lambda;
    b.angle -= (cb * lambda) / Ib;
  }

  // ------------------------------------------------------------------ показания

  cellById(id: number): Cell | undefined {
    for (const c of this.cells) if (c.id === id) return c;
    return undefined;
  }

  /** Клетка под точкой (мкм), если есть. */
  cellAt(x: number, y: number): Cell | undefined {
    let best: Cell | undefined;
    let bestD = Infinity;
    for (const c of this.cells) {
      const ux = Math.cos(c.angle);
      const uy = Math.sin(c.angle);
      const half = Math.max(0, c.len / 2 - this.radius);
      const s = Math.max(-half, Math.min(half, (x - c.x) * ux + (y - c.y) * uy));
      const ex = x - (c.x + ux * s);
      const ey = y - (c.y + uy * s);
      const dd = Math.sqrt(ex * ex + ey * ey);
      if (dd < bestD) {
        bestD = dd;
        best = c;
      }
    }
    return bestD <= this.radius * 1.6 ? best : undefined;
  }

  phageTotal(): number {
    let s = 0;
    for (let j = 0; j < this.pWt.length; j++) s += this.pWt[j] + this.pR[j];
    return s;
  }

  snapshot(): MicroSnapshot {
    let S = 0, I = 0, LI = 0, R = 0, starving = 0;
    const starved = this.relGrowth < 0.3;
    for (const c of this.cells) {
      if (c.state === 'S') {
        S++;
        if (starved) starving++;
      } else if (c.state === 'I') I++;
      else if (c.state === 'LI') LI++;
      else R++;
    }
    return {
      t: this.time, cells: this.cells.length, S, starving, I, LI, R,
      phage: this.phageTotal(), lysed: this.lysed, growth: this.relGrowth, lastBurst: this.lastBurst,
    };
  }

  /** Забрать накопленные события (для анимации и подсказок). */
  drainEvents(): MicroEvent[] {
    return this.events.splice(0, this.events.length);
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
