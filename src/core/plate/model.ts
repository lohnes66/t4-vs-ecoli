/**
 * Модуль 2 — чашка Петри: газон бактерий в мягком агаре и бляшки.
 *
 * Как устроен расчёт.
 *  1. Газон (Lawn) растёт одинаково по всей чашке, пока не кончится питание.
 *  2. Каждый посеянный вирус находит бактерию не сразу: время первой адсорбции t₀ разыгрывается
 *     из вероятности exp(−k∫S dt). Отсюда естественный разброс размеров бляшек: «поздняя» бляшка
 *     начинает расти, когда газон уже гуще, и успевает вырасти меньше.
 *  3. Бляшки с близким t₀ одинаковы, поэтому полностью (радиальная модель PlaqueModel) считается
 *     несколько опорных бляшек — по квантилям t₀ для каждого типа фага; бляшка с промежуточным t₀
 *     получает профиль, интерполированный между соседними опорными.
 *  4. Если бляшек больше, чем имеет смысл рисовать поштучно, остальные учитываются как
 *     равномерное просветление газона (вероятность, что точка не попала ни в одну бляшку).
 *
 * Бляшки не взаимодействуют: при слиянии их мутность перемножается. Это верно, пока бляшки
 * редкие (для счёта бляшек так и делают), а при сплошном лизисе даёт правильную картину в целом.
 */
import { Rng } from '../rng';
import { type Params, type Mechanisms, type Rates, deriveRates } from '../params';
import { Lawn, PlaqueModel, type PhageType } from './plaque';

export interface PlateSpec {
  /** Подпись на крышке. */
  label: string;
  /** Разведение препарата: 10^(−dilution). */
  dilution: number;
  /** Доля r-мутантов в препарате, %. */
  rFractionPct: number;
  /** Механизмы, изменённые на этой чашке (для сравнения с соседней). */
  mech?: Partial<Mechanisms>;
  /** Множитель коэффициента диффузии фага (плотность агара). */
  diffusionFactor?: number;
}

export interface PlateConditions {
  plates: PlateSpec[];
  /** Титр исходного препарата, БОЕ/мл; 0 — «неизвестный образец»: титр выбирается по seed. */
  stockTiter: number;
  /** Сколько миллилитров разведения вносится на чашку. */
  platedMl: number;
  /** Плотность бактерий в верхнем агаре при посеве, клеток/мл. */
  lawnDensity: number;
  /** Время удвоения бактерий в мягком агаре, мин. */
  lawnDoubling: number;
  /** Питание (эквивалент глюкозы) на 1 мл верхнего агара с учётом запаса в нижнем слое, мМ. */
  substrateMM: number;
  temperature: number;
  /** Число колец радиальной сетки бляшки. */
  gridNodes: number;
  /** Одинаковое расположение бляшек на всех чашках — чтобы сравнивать бляшку с бляшкой. */
  sameLayout: boolean;
  /** Длительность инкубации, мин. */
  duration: number;
}

export const DEFAULT_PLATE_CONDITIONS: PlateConditions = {
  plates: [{ label: '10⁻⁷', dilution: 7, rFractionPct: 0 }],
  stockTiter: 5e9,
  platedMl: 0.1,
  lawnDensity: 1e7,
  lawnDoubling: 45,
  substrateMM: 5,
  temperature: 37,
  gridNodes: 256,
  sameLayout: false,
  duration: 960,
};

/** Радиус чашки (внутренний), мм. */
export const DISH_RADIUS_MM = 43;
/** Бляшки — не ближе к стенке, мм. */
const SEED_RADIUS_MM = 41;
/** Больше бляшек на чашке поштучно не рисуем — остальные дают равномерное просветление. */
export const MAX_EXPLICIT = 6000;
/** Бляшка видна глазом, начиная с этого диаметра прозрачной зоны, мм. */
export const VISIBLE_MM = 0.2;
/** Порог мутности прозрачной зоны: край бляшки там, где газон просветлел на 80 %. */
export const CLEAR_LEVEL = 0.2;
/** Внешний край ореола. */
const HALO_LEVEL = 0.9;
/** Квантили времени первой адсорбции для опорных бляшек. */
const PLATING_QUANTILES = [0.03, 0.25, 0.5, 0.75, 0.97];
const DROP_QUANTILES = [0.1, 0.5, 0.9];
/** Радиус области расчёта одной бляшки, мкм. */
const DOMAIN_UM = 3500;
/** Толщина слоя верхнего агара: 3 мл на чашку 90 мм, мкм. */
const LAYER_UM = 470;
/** Капля, которую ставят щелчком, растекается в пятно такого радиуса, мм. */
export const DROP_RADIUS_MM = 2.5;
/** Капля с таким числом вирусов и больше считается сплошным пятном (бляшки сливаются). */
const CONFLUENT_DROP = 1000;
/** Капель не больше (каждая добавляет опорные бляшки). */
export const MAX_DROPS = 8;

/** Опорная бляшка: полностью рассчитанная радиальная модель с заданным t₀. */
export interface PlaqueClass {
  founder: PhageType;
  t0: number;
  model: PlaqueModel | null;
  /** Мутность по кольцам (1 — газон). */
  turb: Float32Array;
  /** Радиус прозрачной зоны и внешнего края ореола, мм. */
  rClear: number;
  rOuter: number;
  /** Средняя «прозрачность» на площади, мм² (для равномерного просветления). */
  clearedArea: number;
}

/** Набор опорных бляшек для одного посева (общий посев или капля) и одного типа фага. */
interface Batch {
  founder: PhageType;
  classes: PlaqueClass[];
}

/** Чашки с одинаковыми механизмами и агаром считаются вместе: газон и опорные бляшки общие. */
interface Group {
  key: string;
  mech: Mechanisms;
  diffusionFactor: number;
  lawn: Lawn;
  /** Накопленная вероятность адсорбции k∫S dt на каждом шаге — для розыгрыша t₀. */
  adsorbCum: Float64Array;
  batches: Batch[];
}

export interface Plaque {
  plate: number;
  /** Положение на чашке относительно центра, мм. */
  x: number;
  y: number;
  founder: PhageType;
  group: number;
  batch: number;
  /** Опорные бляшки, между которыми интерполируем, и вес второй из них. */
  ca: number;
  cb: number;
  w: number;
  t0: number;
}

export interface Drop {
  plate: number;
  x: number;
  y: number;
  t: number;
  phages: number;
  /** Сколько вирусов из капли учтено как сплошное просветление пятна (а не поштучно). */
  excess: number;
  /** Опорные бляшки капли (дикий тип) — для просветления пятна. */
  batch: number;
  group: number;
}

export interface PlateState {
  spec: PlateSpec;
  group: number;
  /** Сколько вирусов попало на чашку (БОЕ в посеве). */
  phages: number;
  /** Из них поштучно. */
  explicit: number;
  /** Остальные — как равномерное просветление. */
  excess: number;
  /** Номер опорной группы бляшек общего посева (для просветления). */
  batch: number;
}

export interface PlateRecord {
  t: number[];
  /** Средний диаметр видимых бляшек на чашке, мм (по чашкам). */
  meanDiameter: number[][];
  /** Число видимых бляшек. */
  visible: number[][];
  /** Мутность газона (0..1). */
  lawn: number[];
  /** Доля питания, оставшаяся в агаре (по чашкам). */
  food: number[][];
}

export interface PlateSnapshot {
  t: number;
  /** Плотность газона, клеток/мл верхнего агара (первая группа). */
  lawnS: number;
  /** Относительная скорость роста газона. */
  growth: number;
  /** Видимая мутность газона 0..1. */
  lawnOpacity: number;
  plates: {
    /** Сплошных пятен от капель с очень большим числом вирусов. */
    spots: number;
    visible: number;
    total: number;
    meanDiameter: number;
    /** Доля площади, оставшаяся под газоном (1 — бляшек нет). */
    lawnLeft: number;
    /** Доля питания, оставшаяся в агаре этой чашки (0..1). */
    food: number;
    /** Относительная скорость роста газона этой чашки. */
    growth: number;
  }[];
}

/** Видимая мутность газона по плотности клеток (насыщается у плотного газона). */
export function lawnOpacity(S: number): number {
  return 1 - Math.exp(-S / 1.5e9);
}

export class PlateModel {
  readonly dt = 0.5;
  readonly recordEvery = 5;
  readonly params: Params;
  readonly mech: Mechanisms;
  readonly cond: PlateConditions;
  readonly rates: Rates;
  readonly rng: Rng;
  readonly stockTiter: number;
  readonly groups: Group[] = [];
  readonly plates: PlateState[] = [];
  readonly plaques: Plaque[] = [];
  readonly drops: Drop[] = [];
  readonly record: PlateRecord;
  step = 0;
  /** Меняется при каждом шаге — вид перерисовывает чашку, только когда что-то изменилось. */
  version = 0;
  private nextRecord = 0;
  private carry = 0;
  private dropRng: Rng;

  constructor(params: Params, mech: Mechanisms, cond: PlateConditions, seed: number) {
    this.params = { ...params };
    this.mech = { ...mech };
    this.cond = { ...cond, plates: cond.plates.map((p) => ({ ...p })) };
    this.rng = new Rng(seed);
    this.dropRng = this.rng.fork(91);
    this.rates = deriveRates(this.params, cond.temperature);
    // «Неизвестный образец»: титр 2·10⁹ … 9·10⁹ БОЕ/мл.
    this.stockTiter = cond.stockTiter > 0 ? cond.stockTiter : Math.round((2 + 7 * this.rng.uniform()) * 10) * 1e8;
    this.record = { t: [], meanDiameter: cond.plates.map(() => []), visible: cond.plates.map(() => []), lawn: [], food: cond.plates.map(() => []) };

    const layoutRng = this.rng.fork(17);
    // Опорные бляшки общего посева одинаковы для всех чашек группы — заводим их один раз.
    const shared = new Map<string, number>();
    const batchFor = (g: number, founder: PhageType) => {
      const key = `${g}:${founder}`;
      let b = shared.get(key);
      if (b === undefined) {
        b = this.addBatch(g, founder, 0, PLATING_QUANTILES);
        shared.set(key, b);
      }
      return b;
    };
    this.cond.plates.forEach((spec, pi) => {
      const g = this.groupFor(spec);
      const group = this.groups[g];
      const mean = this.stockTiter * Math.pow(10, -spec.dilution) * cond.platedMl;
      const prng = cond.sameLayout ? layoutRng.fork(1) : this.rng.fork(100 + pi);
      const phages = prng.poisson(mean);
      const explicit = Math.min(MAX_EXPLICIT, phages);
      const rFrac = Math.min(1, spec.rFractionPct / 100 + (group.mech.rMutations ? 10 * this.rates.muR : 0));
      const bWt = batchFor(g, 'wt');
      for (let i = 0; i < explicit; i++) {
        const [x, y] = diskPoint(prng, SEED_RADIUS_MM);
        const founder: PhageType = prng.uniform() < rFrac ? 'r' : 'wt';
        const t0 = this.drawT0(group, 0, prng);
        if (t0 === null) continue;
        this.plaques.push(this.placePlaque(pi, x, y, founder, g, batchFor(g, founder), t0));
      }
      this.plates.push({ spec, group: g, phages, explicit, excess: phages - explicit, batch: bWt });
    });
    this.writeRecord();
  }

  get t(): number {
    return this.step * this.dt;
  }

  get duration(): number {
    return this.cond.duration;
  }

  get done(): boolean {
    return this.t >= this.cond.duration - 1e-9;
  }

  /** Продвинуть опыт; время копится, пока не наберётся целый шаг модели. */
  advance(minutes: number): void {
    this.carry = Math.min(this.carry + minutes, this.cond.duration - this.t);
    while (this.carry >= this.dt - 1e-9 && !this.done) {
      this.stepOnce();
      this.carry -= this.dt;
    }
    if (this.done) this.carry = 0;
  }

  runToEnd(): void {
    this.advance(this.cond.duration - this.t);
  }

  /** По одной чашке на каждую группу условий (первая чашка группы), в порядке групп. */
  groupRepresentatives(): number[] {
    return this.groups.map((_, g) => this.plates.findIndex((p) => p.group === g));
  }

  /** Подпись группы условий: подписи всех её чашек через запятую. */
  groupLabel(g: number): string {
    return this.plates.filter((p) => p.group === g).map((p) => p.spec.label).join(', ');
  }

  // ------------------------------------------------------------------ устройство

  private groupFor(spec: PlateSpec): number {
    const mech = { ...this.mech, ...(spec.mech ?? {}) };
    const diffusionFactor = spec.diffusionFactor ?? 1;
    const key = JSON.stringify([mech, diffusionFactor]);
    const found = this.groups.findIndex((g) => g.key === key);
    if (found >= 0) return found;
    const c = this.cond;
    const lawn = new Lawn(this.rates, mech, c.lawnDensity, c.substrateMM, c.lawnDoubling);
    // Газон детерминирован — заранее «прогоняем» его копию, чтобы знать k∫S dt на всё время опыта.
    const probe = new Lawn(this.rates, mech, c.lawnDensity, c.substrateMM, c.lawnDoubling);
    const steps = Math.ceil(c.duration / this.dt) + 1;
    const cum = new Float64Array(steps + 1);
    for (let i = 0; i < steps; i++) {
      const s0 = probe.S;
      probe.step(this.dt);
      cum[i + 1] = cum[i] + this.rates.k * 0.5 * (s0 + probe.S) * this.dt;
    }
    this.groups.push({ key, mech, diffusionFactor, lawn, adsorbCum: cum, batches: [] });
    return this.groups.length - 1;
  }

  /** Время первой адсорбции вируса, внесённого в момент from; null — не нашёл бактерию за опыт. */
  private drawT0(group: Group, from: number, rng: Rng): number | null {
    const e = -Math.log(1 - rng.uniform());
    return this.adsorbTime(group, from, e);
  }

  private adsorbTime(group: Group, from: number, e: number): number | null {
    const cum = group.adsorbCum;
    const i0 = Math.min(cum.length - 1, Math.floor(from / this.dt));
    const target = cum[i0] + e;
    if (target > cum[cum.length - 1]) return null;
    let lo = i0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid;
      else hi = mid;
    }
    const f = (target - cum[lo]) / Math.max(1e-30, cum[hi] - cum[lo]);
    return Math.max(from, (lo + f) * this.dt);
  }

  private addBatch(g: number, founder: PhageType, from: number, quantiles: number[]): number {
    const group = this.groups[g];
    const classes: PlaqueClass[] = [];
    for (const q of quantiles) {
      const t0 = this.adsorbTime(group, from, -Math.log(1 - q));
      if (t0 === null) continue;
      classes.push({ founder, t0, model: null, turb: new Float32Array(0), rClear: 0, rOuter: 0, clearedArea: 0 });
    }
    group.batches.push({ founder, classes });
    return group.batches.length - 1;
  }

  private placePlaque(plate: number, x: number, y: number, founder: PhageType, g: number, b: number, t0: number): Plaque {
    const cls = this.groups[g].batches[b].classes;
    let ca = 0;
    let cb = 0;
    let w = 0;
    if (cls.length > 1) {
      if (t0 <= cls[0].t0) ca = cb = 0;
      else if (t0 >= cls[cls.length - 1].t0) ca = cb = cls.length - 1;
      else {
        let i = 0;
        while (i < cls.length - 2 && cls[i + 1].t0 < t0) i++;
        ca = i;
        cb = i + 1;
        w = (t0 - cls[i].t0) / Math.max(1e-9, cls[i + 1].t0 - cls[i].t0);
      }
    }
    return { plate, x, y, founder, group: g, batch: b, ca, cb, w, t0 };
  }

  // ------------------------------------------------------------------ шаг

  private stepOnce(): void {
    const dt = this.dt;
    const t = this.t;
    const c = this.cond;
    for (const g of this.groups) {
      g.lawn.step(dt);
      for (const b of g.batches) {
        for (const k of b.classes) {
          if (!k.model) {
            if (k.t0 > t + dt) continue;
            k.model = new PlaqueModel({
              rates: this.rates, mech: g.mech, founder: b.founder, nodes: c.gridNodes,
              radiusUm: DOMAIN_UM * Math.sqrt(Math.max(1, g.diffusionFactor)),
              diffusionFactor: g.diffusionFactor, layerUm: LAYER_UM,
            }, g.lawn.S);
          }
          k.model.step(dt, g.lawn);
        }
      }
    }
    this.step++;
    this.version++;
    if (this.t >= this.nextRecord - 1e-9) this.writeRecord();
  }

  /** Обновить профили опорных бляшек (мутность, радиусы) для текущего момента. */
  refreshClasses(): void {
    const ghostOd = this.rates.ghostOd;
    for (const g of this.groups) {
      for (const b of g.batches) {
        for (const k of b.classes) {
          const m = k.model;
          if (!m) continue;
          if (k.turb.length !== m.n) k.turb = new Float32Array(m.n);
          m.turbidity(g.lawn, ghostOd, k.turb);
          k.rClear = m.clearRadius(k.turb, CLEAR_LEVEL) / 1000;
          k.rOuter = m.clearRadius(k.turb, HALO_LEVEL) / 1000;
          let a = 0;
          const dr = m.dr / 1000;
          for (let i = 0; i < m.n; i++) a += Math.max(0, 1 - k.turb[i]) * Math.PI * (2 * i + 1) * dr * dr;
          k.clearedArea = a;
        }
      }
    }
  }

  classOf(p: Plaque, which: 'a' | 'b'): PlaqueClass | undefined {
    return this.groups[p.group].batches[p.batch].classes[which === 'a' ? p.ca : p.cb];
  }

  /** Диаметр прозрачной зоны бляшки, мм (после refreshClasses). */
  plaqueDiameter(p: Plaque): number {
    const a = this.classOf(p, 'a');
    const b = this.classOf(p, 'b');
    if (!a || !b) return 0;
    return 2 * (a.rClear + (b.rClear - a.rClear) * p.w);
  }

  /** Внешний радиус ореола, мм. */
  plaqueOuter(p: Plaque): number {
    const a = this.classOf(p, 'a');
    const b = this.classOf(p, 'b');
    if (!a || !b) return 0;
    return a.rOuter + (b.rOuter - a.rOuter) * p.w;
  }

  /** Средняя площадь просветления одной бляшки посева (для равномерного просветления), мм². */
  batchClearedArea(g: number, b: number): number {
    const cls = this.groups[g].batches[b]?.classes ?? [];
    if (!cls.length) return 0;
    let s = 0;
    for (const k of cls) s += k.clearedArea;
    return s / cls.length;
  }

  /** Доля площади чашки, не затронутая «лишними» (не нарисованными поштучно) бляшками. */
  excessFactor(pi: number): number {
    const p = this.plates[pi];
    if (p.excess <= 0) return 1;
    const area = Math.PI * SEED_RADIUS_MM * SEED_RADIUS_MM;
    return Math.exp((-p.excess / area) * this.batchClearedArea(p.group, p.batch));
  }

  /**
   * «Типичная» бляшка чашки — с медианным временем первой адсорбции: диаметр прозрачной зоны
   * и внешний диаметр ореола, мм. Так измеряют рост бляшки в проверках модели.
   */
  typicalPlaque(pi: number): { clear: number; outer: number } {
    this.refreshClasses();
    const list = this.plaques.filter((p) => p.plate === pi).sort((a, b) => a.t0 - b.t0);
    if (!list.length) return { clear: 0, outer: 0 };
    const p = list[Math.floor(list.length / 2)];
    return { clear: this.plaqueDiameter(p), outer: 2 * this.plaqueOuter(p) };
  }

  // ------------------------------------------------------------------ капля по щелчку

  /** Капнуть n вирусов в точку (x, y) мм от центра чашки. */
  addDrop(plate: number, x: number, y: number, phages: number): Drop | null {
    if (this.drops.length >= MAX_DROPS || this.done) return null;
    const ps = this.plates[plate];
    if (!ps) return null;
    const g = this.groups[ps.group];
    const rng = this.dropRng;
    const n = Math.max(1, Math.round(phages));
    const explicit = Math.min(n, 3000);
    const t = this.t;
    const bWt = this.addBatch(ps.group, 'wt', t, DROP_QUANTILES);
    for (let i = 0; i < explicit; i++) {
      const [dx, dy] = diskPoint(rng, DROP_RADIUS_MM);
      const px = x + dx;
      const py = y + dy;
      if (px * px + py * py > DISH_RADIUS_MM * DISH_RADIUS_MM) continue;
      const t0 = this.drawT0(g, t, rng);
      if (t0 === null) continue;
      this.plaques.push(this.placePlaque(plate, px, py, 'wt', ps.group, bWt, t0));
    }
    const d: Drop = { plate, x, y, t, phages: n, excess: n - explicit, batch: bWt, group: ps.group };
    this.drops.push(d);
    this.version++;
    return d;
  }

  dropFactor(d: Drop): number {
    if (d.excess <= 0) return 1;
    const area = Math.PI * DROP_RADIUS_MM * DROP_RADIUS_MM;
    return Math.exp((-d.excess / area) * this.batchClearedArea(d.group, d.batch));
  }

  // ------------------------------------------------------------------ показания

  snapshot(): PlateSnapshot {
    this.refreshClasses();
    const lawn = this.groups[0]?.lawn;
    const stats = this.plates.map(() => ({ visible: 0, total: 0, sum: 0, spots: 0 }));
    // Капля с тысячами вирусов даёт одно сплошное пятно, а не тысячи бляшек.
    const merged = new Set<string>();
    for (const d of this.drops) {
      if (d.phages < CONFLUENT_DROP) continue;
      merged.add(`${d.group}:${d.batch}`);
      stats[d.plate].spots++;
    }
    for (const p of this.plaques) {
      if (merged.size && merged.has(`${p.group}:${p.batch}`)) continue;
      const s = stats[p.plate];
      s.total++;
      const d = this.plaqueDiameter(p);
      if (d >= VISIBLE_MM) {
        s.visible++;
        s.sum += d;
      }
    }
    return {
      t: this.t,
      lawnS: lawn?.S ?? 0,
      growth: lawn?.g ?? 0,
      lawnOpacity: lawnOpacity(lawn?.S ?? 0),
      plates: this.plates.map((ps, i) => {
        const s = stats[i];
        const meanD = s.visible ? s.sum / s.visible : 0;
        // Видимые «лишние» бляшки — в той же доле, что и нарисованные.
        const share = s.total ? s.visible / s.total : 0;
        const gl = this.groups[ps.group]?.lawn;
        return {
          spots: s.spots,
          visible: s.visible + Math.round(ps.excess * share),
          total: s.total + ps.excess,
          meanDiameter: meanD,
          lawnLeft: this.lawnLeft(i),
          food: gl?.food ?? 0,
          growth: gl?.g ?? 0,
        };
      }),
    };
  }

  /** Доля площади чашки под газоном (оценка: бляшки независимы). */
  private lawnLeft(pi: number): number {
    const area = Math.PI * SEED_RADIUS_MM * SEED_RADIUS_MM;
    let cleared = 0;
    for (const p of this.plaques) {
      if (p.plate !== pi) continue;
      const r = this.plaqueDiameter(p) / 2;
      cleared += Math.PI * r * r;
    }
    return Math.exp(-cleared / area) * this.excessFactor(pi);
  }

  private writeRecord(): void {
    const s = this.snapshot();
    const r = this.record;
    r.t.push(s.t);
    r.lawn.push(s.lawnOpacity);
    s.plates.forEach((p, i) => {
      r.meanDiameter[i].push(p.meanDiameter);
      r.visible[i].push(p.visible);
      r.food[i].push(p.food);
    });
    this.nextRecord = this.t + this.recordEvery;
  }
}

/** Равномерная точка в круге радиуса R. */
function diskPoint(rng: Rng, R: number): [number, number] {
  const r = R * Math.sqrt(rng.uniform());
  const a = 2 * Math.PI * rng.uniform();
  return [r * Math.cos(a), r * Math.sin(a)];
}
