/**
 * Модуль 2 — одна бляшка в газоне мягкого агара.
 *
 * Почему модель радиальная, а не сетка на всю чашку. Фронт бляшки узкий: свободный фаг
 * проходит до адсорбции всего λ = √(D/kS) ≈ 5–30 мкм. Сетка 512 × 512 на чашку 90 мм
 * (ячейка 0,18 мм) такой фронт не разрешает — скорость роста бляшки зависела бы от размера
 * ячейки. Поэтому каждая бляшка считается отдельно в полярных координатах с шагом в несколько
 * микрометров (бляшка круглая, пока не встретила соседнюю), а чашка составляется из бляшек.
 *
 * Слой мягкого агара тонкий, поэтому все плотности — на 1 мл верхнего агара, усреднённые
 * по толщине слоя. Переменные в каждом кольце: S — чувствительные клетки,
 * заражённые когортами по времени заражения (как в колбе), P — свободный фаг, ghosts — оболочки.
 * Диффундирует только фаг (неявная схема, без ограничения на шаг).
 *
 * Субстрат и рост газона общие для чашки (см. Lawn): глюкоза в агаре диффундирует
 * на миллиметры за минуты — на масштабе бляшки её концентрация однородна.
 */
import { normalCdf } from '../rng';
import {
  type Mechanisms, type Rates, phageDevelopmentSpeed, phageBurstQuality,
} from '../params';

/** Газон: перемешивания нет, но питание общее — рост одинаков по всей чашке. */
export class Lawn {
  /** Чувствительные клетки на мл верхнего агара. */
  S: number;
  /** Субстрат, мкМ (в пересчёте на объём верхнего агара, с запасом нижнего слоя). */
  N: number;
  /** Относительная скорость роста (0 — голод, 1 — максимальная). */
  g = 1;
  /** Во сколько раз выросли клетки за последний шаг. */
  growth = 1;

  /** Максимальная скорость роста в мягком агаре, 1/мин. */
  readonly mu: number;
  /** Субстрат в начале опыта, мкМ. */
  readonly N0: number;

  constructor(private rates: Rates, private mech: Mechanisms, S0: number, substrateMM: number, doublingMin: number) {
    this.S = S0;
    this.mu = (Math.LN2 / doublingMin) * rates.tempFactor;
    this.N = substrateMM * 1000;
    this.N0 = this.N;
    this.g = this.relGrowth();
  }

  /** Доля питания, оставшаяся в агаре (1 — как в начале, 0 — всё съедено). */
  get food(): number {
    return this.N0 > 0 ? Math.min(1, this.N / this.N0) : 0;
  }

  private relGrowth(): number {
    return this.mech.substrateDepletion ? this.N / (this.rates.monodKs + this.N) : 1;
  }

  step(dt: number): void {
    const r = this.rates;
    this.g = this.relGrowth();
    let births = this.S * (Math.exp(this.mu * this.g * dt) - 1);
    if (this.mech.substrateDepletion) {
      births = Math.min(births, (this.N * r.yieldPerUmol) / 1000);
      this.N = Math.max(0, this.N - (births * 1000) / r.yieldPerUmol);
    } else {
      // Без истощения питания газон всё равно не плотнее плотной упаковки клеток.
      births = Math.min(births, Math.max(0, LAWN_PACKED - this.S));
    }
    this.growth = (this.S + births) / this.S;
    this.S += births;
  }
}

/** Меньше этого (клеток/мл) — уже не клетки, а погрешность счёта: обнуляем. */
const S_FLOOR = 1e-6;
const N_FLOOR = 1e-12;

/** Заражения в пределах этого возраста развития объединяются в одну когорту, мин. */
const COHORT_AGE = 0.5;

/** Плотнее клетки в слое агара не упаковать (клетка ≈ 1 мкм³), клеток/мл. */
const LAWN_PACKED = 2e11;

export type PhageType = 'wt' | 'r';

export interface PlaqueSetup {
  rates: Rates;
  mech: Mechanisms;
  /** Каким фагом основана бляшка: дикий тип или r-мутант (без торможения лизиса). */
  founder: PhageType;
  /** Число колец сетки. */
  nodes: number;
  /** Радиус области расчёта, мкм. */
  radiusUm: number;
  /** Множитель коэффициента диффузии фага (плотность агара). */
  diffusionFactor: number;
  /** Толщина слоя верхнего агара, мкм. */
  layerUm: number;
}

/** Когорта клеток, заражённых за один шаг: возраст развития и урожай общие для всех колец. */
interface Cohort {
  age: number;
  progeny: number;
  /** Заражённые без торможения лизиса, клеток/мл по кольцам. */
  n: Float64Array;
  /** С торможением лизиса. */
  li: Float64Array;
  /** Есть ли ещё клетки (чтобы не пробегать пустые массивы). */
  any: boolean;
  liAny: boolean;
  /** Кольца [lo, hi), где у когорты есть клетки: когорта возникает на узком фронте бляшки. */
  lo: number;
  hi: number;
}

export class PlaqueModel {
  readonly n: number;
  readonly dr: number;
  readonly S: Float64Array;
  readonly P: Float64Array;
  readonly ghosts: Float64Array;
  cohorts: Cohort[] = [];
  /** Сколько фагов выпущено за всё время (для проверки баланса). */
  released = 0;
  private D: number;
  private lower: Float64Array;
  private upper: Float64Array;
  private cprime: Float64Array;
  private dprime: Float64Array;
  private pool: Float64Array[] = [];
  private dtPrepared = 0;
  /** За этим кольцом нет ни фага, ни заражённых — там просто газон (расчёт только до него). */
  private hi = 1;

  constructor(readonly setup: PlaqueSetup, lawnS: number) {
    const n = setup.nodes;
    this.n = n;
    this.dr = setup.radiusUm / n;
    this.S = new Float64Array(n).fill(lawnS);
    this.P = new Float64Array(n);
    this.ghosts = new Float64Array(n);
    this.D = setup.rates.phageDiffusion * setup.diffusionFactor;
    this.lower = new Float64Array(n);
    this.upper = new Float64Array(n);
    this.cprime = new Float64Array(n);
    this.dprime = new Float64Array(n);
    // Основатель — одна заражённая клетка в центральном кружке.
    const c = this.newCohort();
    const vol = this.ringVolumeMl(0);
    c.n[0] = 1 / vol;
    c.any = true;
    c.hi = 1;
    this.S[0] = Math.max(0, this.S[0] - c.n[0]);
    this.cohorts.push(c);
  }

  /** Объём кольца i, мл (площадь × толщина слоя). */
  ringVolumeMl(i: number): number {
    const dr = this.dr * 1e-4; // см
    return Math.PI * (2 * i + 1) * dr * dr * (this.setup.layerUm * 1e-4);
  }

  private take(): Float64Array {
    const a = this.pool.pop();
    if (a) {
      a.fill(0);
      return a;
    }
    return new Float64Array(this.n);
  }

  private newCohort(): Cohort {
    return { age: 0, progeny: 0, n: this.take(), li: this.take(), any: false, liAny: false, lo: 0, hi: 0 };
  }

  /** Неявная схема диффузии в полярных координатах: коэффициенты матрицы для шага dt. */
  private prepare(dt: number): void {
    this.dtPrepared = dt;
    const n = this.n;
    const a = (this.D * dt) / (this.dr * this.dr);
    // dP_i/dt = D/dr² · [2(i+1)(P_{i+1}−P_i) − 2i(P_i−P_{i−1})] / (2i+1); внешняя граница без потока.
    for (let i = 0; i < n; i++) {
      const w = 1 / (2 * i + 1);
      this.lower[i] = i > 0 ? -a * 2 * i * w : 0;
      this.upper[i] = i < n - 1 ? -a * 2 * (i + 1) * w : 0;
    }
  }

  private diffuse(dt: number): void {
    if (dt !== this.dtPrepared) this.prepare(dt);
    const n = this.n;
    const P = this.P;
    const lo = this.lower;
    const up = this.upper;
    const cp = this.cprime;
    const dp = this.dprime;
    // Алгоритм прогонки; диагональ = 1 − lower − upper (схема консервативна).
    let b = 1 - up[0];
    cp[0] = up[0] / b;
    dp[0] = P[0] / b;
    for (let i = 1; i < n; i++) {
      b = 1 - lo[i] - up[i] - lo[i] * cp[i - 1];
      cp[i] = up[i] / b;
      dp[i] = (P[i] - lo[i] * dp[i - 1]) / b;
    }
    P[n - 1] = dp[n - 1];
    for (let i = n - 2; i >= 0; i--) P[i] = dp[i] - cp[i] * P[i + 1];
  }

  /** Шаг модели: сначала реакции в каждом кольце, затем диффузия фага. */
  step(dt: number, lawn: Lawn): void {
    const { rates: r, mech: m, founder } = this.setup;
    const N = this.n;
    const n = this.hi;
    const S = this.S;
    const P = this.P;

    // Рост чувствительных клеток — как в газоне.
    const G = lawn.growth;
    if (G !== 1) for (let i = 0; i < N; i++) S[i] *= G;

    // Всего заражённых в каждом кольце (мишени для повторной адсорбции).
    const Itot = this.take();
    for (const c of this.cohorts) {
      if (c.any) for (let i = c.lo; i < c.hi; i++) Itot[i] += c.n[i];
      if (c.liAny) for (let i = c.lo; i < c.hi; i++) Itot[i] += c.li[i];
    }

    // Адсорбция и заражение.
    const fresh = this.newCohort();
    const P0 = this.take();
    P0.set(P);
    const lostOnInfected = m.superinfectionExclusion ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const p = P[i];
      if (p <= 0) continue;
      const targets = S[i] + Itot[i];
      if (targets <= 0) continue;
      const ads = p * (1 - Math.exp(-r.k * targets * dt));
      const onS = (ads * S[i]) / targets;
      const onI = ads - onS;
      if (onS > 0 && S[i] > 0) {
        const inf = S[i] * (1 - Math.exp(-onS / S[i]));
        S[i] -= inf;
        // Внутри бляшки чувствительных клеток практически не осталось — обнуляем остаток.
        if (S[i] < S_FLOOR) S[i] = 0;
        if (inf > N_FLOOR) {
          fresh.n[i] = inf;
          if (!fresh.any) fresh.lo = i;
          fresh.hi = i + 1;
          fresh.any = true;
        }
      }
      P[i] = Math.max(0, p - onS - onI * lostOnInfected);
    }

    // Повторная адсорбция переводит заражённых диким типом в торможение лизиса.
    // Вероятности за шаг, общие для всех когорт кольца: повторная адсорбция и срыв торможения.
    const liOn = founder === 'wt' && m.lysisInhibition;
    const pSec = this.take();
    const pCol = this.take();
    if (liOn) {
      const tau = r.liWindow;
      for (let i = 0; i < n; i++) {
        const kp = r.k * P0[i];
        pSec[i] = 1 - Math.exp(-kp * dt);
        pCol[i] = 1 - Math.exp((-Math.exp(-kp * tau) / tau) * dt * r.tempFactor);
      }
    }
    if (liOn) {
      for (const c of this.cohorts) {
        if (!c.any || c.age < r.sieTime) continue;
        for (let i = c.lo; i < c.hi; i++) {
          const x = c.n[i];
          if (x <= 0 || P0[i] <= 0) continue;
          const conv = x * pSec[i];
          c.n[i] = x - conv;
          c.li[i] += conv;
          c.liAny = true;
        }
      }
    }

    // Развитие фага и лизис (возраст и урожай общие для когорты: питание общее для чашки).
    const speed = phageDevelopmentSpeed(r, lawn.g, m.hostPhysiology);
    const quality = phageBurstQuality(r, lawn.g, m.hostPhysiology);
    const sd = r.lysisSd;
    for (const c of this.cohorts) {
      const a0 = c.age;
      const a1 = a0 + speed * dt;
      c.age = a1;
      if (a1 > r.eclipse) c.progeny += (a1 - Math.max(a0, r.eclipse)) * r.progenyRate * quality;
      const burst = Math.min(c.progeny, r.burstMaxLI);
      let pLyse: number;
      if (sd <= 0) pLyse = a1 >= r.latent ? 1 : 0;
      else if (a1 < r.latent - 6 * sd) pLyse = 0;
      else if (a0 > r.latent + 6 * sd) pLyse = 1;
      else {
        const F0 = normalCdf((a0 - r.latent) / sd);
        const F1 = normalCdf((a1 - r.latent) / sd);
        pLyse = F0 >= 1 ? 1 : Math.min(1, Math.max(0, (F1 - F0) / (1 - F0)));
      }
      if (pLyse > 0 && c.any) {
        let left = false;
        for (let i = c.lo; i < c.hi; i++) {
          const x = c.n[i];
          if (x <= 0) continue;
          const l = x * pLyse;
          c.n[i] = x - l;
          if (c.n[i] < N_FLOOR) c.n[i] = 0;
          else left = true;
          P[i] += l * burst;
          this.released += l * burst * this.ringVolumeMl(i);
          this.ghosts[i] += l;
        }
        c.any = left;
      }
      if (c.liAny && a1 >= r.latent) {
        const forced = !m.lysisInhibition || a1 - r.latent >= r.liMaxDuration;
        let left = false;
        for (let i = c.lo; i < c.hi; i++) {
          const x = c.li[i];
          if (x <= 0) continue;
          const pl = !m.lysisInhibition ? pLyse : forced ? 1 : pCol[i];
          const l = x * pl;
          c.li[i] = x - l;
          if (c.li[i] < N_FLOOR) c.li[i] = 0;
          else left = true;
          P[i] += l * burst;
          this.released += l * burst * this.ringVolumeMl(i);
          this.ghosts[i] += l;
        }
        c.liAny = left;
      }
    }

    // Распад свободного фага.
    if (m.phageDecay && r.decay > 0) {
      const f = Math.exp(-r.decay * dt);
      for (let i = 0; i < n; i++) P[i] *= f;
    }

    this.diffuse(dt);
    // Неявная схема даёт исчезающе малые значения по всей области — обнуляем их,
    // чтобы не считать «пустые» кольца (и не тормозить на денормализованных числах).
    let last = 0;
    for (let i = 0; i < N; i++) {
      if (P[i] < 1e-9) P[i] = 0;
      else last = i;
    }
    this.hi = Math.min(N, Math.max(this.hi, last + 2));

    // Новая когорта. Заражения за последние COHORT_AGE минут развития объединяем в одну:
    // у голодных клеток возраст растёт медленно, иначе когорт стало бы слишком много.
    const open = this.cohorts[this.cohorts.length - 1];
    if (fresh.any && open && open.age < COHORT_AGE) {
      for (let i = fresh.lo; i < fresh.hi; i++) open.n[i] += fresh.n[i];
      if (!open.any && !open.liAny) {
        open.lo = fresh.lo;
        open.hi = fresh.hi;
      } else {
        open.lo = Math.min(open.lo, fresh.lo);
        open.hi = Math.max(open.hi, fresh.hi);
      }
      open.any = true;
      this.give(fresh);
    } else if (fresh.any) this.cohorts.push(fresh);
    else this.give(fresh);
    const keep: Cohort[] = [];
    for (const c of this.cohorts) {
      if (c.any || c.liAny) keep.push(c);
      else this.give(c);
    }
    this.cohorts = this.mergeOld(keep);
    this.pool.push(Itot, P0, pSec, pCol);
  }

  private give(c: Cohort): void {
    this.pool.push(c.n, c.li);
  }

  /**
   * Старые когорты, где остались только клетки с торможением лизиса, сливаем: их судьба
   * почти не зависит от точного возраста, а число когорт (и время расчёта) остаётся небольшим.
   */
  private mergeOld(list: Cohort[]): Cohort[] {
    const r = this.setup.rates;
    const late = r.latent + 6 * r.lysisSd + 1;
    const out: Cohort[] = [];
    for (const c of list) {
      const prev = out[out.length - 1];
      if (prev && !prev.any && !c.any && prev.age > late && c.age > late && prev.age - c.age < 5) {
        let wp = 0;
        let wc = 0;
        const lo = Math.min(prev.lo, c.lo);
        const hi = Math.max(prev.hi, c.hi);
        for (let i = lo; i < hi; i++) {
          wp += prev.li[i] * (2 * i + 1);
          wc += c.li[i] * (2 * i + 1);
          prev.li[i] += c.li[i];
        }
        prev.lo = lo;
        prev.hi = hi;
        const w = wp + wc;
        if (w > 0) {
          prev.age = (prev.age * wp + c.age * wc) / w;
          prev.progeny = (prev.progeny * wp + c.progeny * wc) / w;
        }
        this.give(c);
        continue;
      }
      out.push(c);
    }
    return out;
  }

  /** Мутность по кольцам относительно газона (1 — газон, 0 — пусто). */
  turbidity(lawn: Lawn, ghostOd: number, out: Float32Array = new Float32Array(this.n)): Float32Array {
    const n = this.n;
    const intact = out;
    for (let i = 0; i < n; i++) intact[i] = this.S[i] + ghostOd * this.ghosts[i];
    for (const c of this.cohorts) {
      if (c.any) for (let i = c.lo; i < c.hi; i++) intact[i] += c.n[i];
      if (c.liAny) for (let i = c.lo; i < c.hi; i++) intact[i] += c.li[i];
    }
    const ref = lawn.S;
    for (let i = 0; i < n; i++) intact[i] = Math.min(1.2, intact[i] / ref);
    return intact;
  }

  /** Радиус прозрачной зоны, мкм: где мутность опускается до половины газона. */
  clearRadius(turb: Float32Array, level = 0.5): number {
    if (turb[0] >= level) return 0;
    for (let i = 1; i < this.n; i++) {
      if (turb[i] >= level) {
        const f = (level - turb[i - 1]) / (turb[i] - turb[i - 1]);
        return (i - 0.5 + f) * this.dr;
      }
    }
    return this.setup.radiusUm;
  }
}
