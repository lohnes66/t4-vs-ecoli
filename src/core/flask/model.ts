/**
 * Модуль 1 — колба с перемешанной жидкой культурой.
 *
 * Переменные (абсолютные числа во всём объёме культуры):
 *   S — чувствительные клетки, R — устойчивые мутанты (OmpC⁻),
 *   I(a) — заражённые клетки, хранятся когортами по «возрасту развития» a,
 *   Pwt, Pr — свободные фаги дикого типа и r-мутанты, N — субстрат (мкМ),
 *   ghosts — оболочки лизированных клеток (дают остаточную мутность).
 *
 * Латентный период — фиксированная задержка: клетка лизируется, когда возраст её когорты
 * достигает L (с небольшим нормальным разбросом σ_L), а не с постоянной вероятностью.
 *
 * Гибридная стохастика: каждое событие (деление, мутация, адсорбция, лизис, распад)
 * при среднем числе событий за шаг больше порога считается детерминированно, а при
 * меньшем — разыгрывается (Пуассон/бином) генератором с заданным seed. Популяции
 * меньше порога всегда хранятся целыми числами.
 *
 * Ядро ничего не знает об отрисовке.
 */
import { Rng, normalCdf } from '../rng';
import {
  type Params, type Mechanisms, type Rates,
  deriveRates, phageDevelopmentSpeed, phageBurstQuality,
} from '../params';

export interface FlaskConditions {
  /** Объём культуры, мл. */
  volumeMl: number;
  /** Начальная плотность бактерий, КОЕ/мл. */
  initialDensity: number;
  /** Богатство среды: лимитирующий субстрат в эквиваленте глюкозы, мМ. */
  substrateMM: number;
  /** Температура инкубации, °C. */
  temperature: number;
  /** Когда вносится фаг, мин от начала инкубации. */
  phageTime: number;
  /** Множественность заражения в момент внесения фага. */
  moi: number;
  /** Титр препарата фага, БОЕ/мл (определяет объём вносимого препарата). */
  phageTiter: number;
  /** Доля r-мутантов в препарате фага, %. */
  rFractionPct: number;
  /** Кратность разведения культуры (1 — без разведения). */
  dilutionFactor: number;
  /** Когда выполняется разведение, мин. */
  dilutionTime: number;
  /** Длительность опыта, мин. */
  duration: number;
}

export const DEFAULT_FLASK_CONDITIONS: FlaskConditions = {
  volumeMl: 20,
  initialDensity: 1e7,
  substrateMM: 2,
  temperature: 37,
  phageTime: 60,
  moi: 0.1,
  phageTiter: 1e10,
  rFractionPct: 0,
  dilutionFactor: 1,
  dilutionTime: 10,
  duration: 480,
};

/** Когорта заражённых клеток, заразившихся почти одновременно. */
interface Cohort {
  /** Возраст развития фага, мин (при нормальной физиологии равен времени с момента заражения). */
  age: number;
  /** Заражённые фагом дикого типа, без торможения лизиса. */
  nWt: number;
  /** Заражённые r-мутантом. */
  nR: number;
  /** Клетки с торможением лизиса (только дикий тип). */
  nLI: number;
  /** Зрелых фаговых частиц внутри одной клетки. */
  progeny: number;
}

/** Мгновенное состояние культуры в пересчёте на 1 мл — для приборов и графиков. */
export interface FlaskSnapshot {
  t: number;
  S: number;
  R: number;
  I: number;
  LI: number;
  Pwt: number;
  Pr: number;
  P: number;
  N: number;
  ghosts: number;
  od: number;
  /** Титр по бляшкам: свободные фаги + инфекционные центры (каждая заражённая клетка даёт одну бляшку). */
  titer: number;
  /** Титр после обработки хлороформом: свободные фаги + зрелые частицы внутри клеток. */
  titerChloroform: number;
  /** Относительная скорость роста хозяина (0 — голод, 1 — максимальная). */
  growth: number;
  /** Средняя доля пройденного латентного периода у заражённых клеток (0..1). */
  infectionProgress: number;
  /** Лизировалось клеток за последний шаг записи, на мл. */
  lysisRate: number;
}

export interface FlaskSeries {
  t: number[];
  S: number[];
  R: number[];
  I: number[];
  LI: number[];
  Pwt: number[];
  Pr: number[];
  P: number[];
  N: number[];
  od: number[];
  titer: number[];
  titerChloroform: number[];
}

export type SeriesKey = Exclude<keyof FlaskSeries, 't'>;

export function emptySeries(): FlaskSeries {
  return { t: [], S: [], R: [], I: [], LI: [], Pwt: [], Pr: [], P: [], N: [], od: [], titer: [], titerChloroform: [] };
}

export interface FlaskEventLog {
  t: number;
  text: string;
}

const COHORT_WIDTH = 0.25; // мин: новые заражения в пределах этого окна объединяются в одну когорту

export class FlaskModel {
  readonly dt = 0.05; // мин
  readonly recordEvery = 0.5; // мин
  readonly rng: Rng;
  readonly params: Params;
  readonly mech: Mechanisms;
  readonly cond: FlaskConditions;
  readonly rates: Rates;
  readonly V: number;

  step = 0;
  S = 0;
  R = 0;
  Pwt = 0;
  Pr = 0;
  N = 0;
  ghosts = 0;
  cohorts: Cohort[] = [];

  /** Накопленные счётчики событий за весь опыт. */
  totals = { resistantMutants: 0, rMutants: 0, lysed: 0, infections: 0 };
  firstResistantTime: number | null = null;
  readonly series = emptySeries();
  readonly log: FlaskEventLog[] = [];
  private lysedSinceRecord = 0;
  private phageAdded = false;
  private diluted = false;
  private relGrowth = 1;
  private nextRecordStep = 0;
  /** Объём внесённого препарата фага, мл (для протокола). */
  phageVolumeMl = 0;

  constructor(params: Params, mech: Mechanisms, cond: FlaskConditions, seed: number) {
    this.params = { ...params };
    this.mech = { ...mech };
    this.cond = { ...cond };
    this.rng = new Rng(seed);
    this.rates = deriveRates(this.params, cond.temperature);
    this.V = cond.volumeMl;
    this.N = cond.substrateMM * 1000;
    const total = cond.initialDensity * this.V;
    const r0 = this.mech.resistanceMutations ? this.precultureMutants(total) : 0;
    this.R = this.toCount(r0);
    this.S = this.toCount(total - r0);
    if (r0 > 0) this.firstResistantTime = 0;
    this.relGrowth = this.computeRelGrowth();
    this.record();
  }

  /**
   * Инокулят выращен из небольшого числа клеток, поэтому в нём уже есть устойчивые
   * мутанты. Их число получаем, «выращивая» предкультуру от 1000 клеток с мутациями
   * при каждом делении — так само собой возникает распределение Луриа — Дельбрюка
   * с редкими «джекпотами» (ранняя мутация даёт большой клон).
   */
  private precultureMutants(total: number): number {
    const r = this.rates;
    let S = Math.min(1000, total);
    let R = 0;
    const dt = 0.5;
    const grow = Math.exp((Math.LN2 / 20) * dt) - 1; // предкультура растёт в оптимальных условиях
    const growR = Math.exp((Math.LN2 / 20) * (1 - this.params.resistanceCost / 100) * dt) - 1;
    for (let i = 0; i < 100000 && S + R < total; i++) {
      const births = this.count(S * grow);
      const mut = Math.min(births, this.rng.poisson(r.muRes * births));
      const birthsR = this.count(R * growR);
      S += births - mut;
      R += mut + birthsR;
    }
    // Нормируем на нужное число клеток, сохраняя долю мутантов.
    const frac = R / (S + R);
    return frac > 0 ? this.toCount(total * frac) : 0;
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

  /** Продвинуть модель на заданное число минут инкубации. */
  advance(minutes: number): void {
    const target = Math.min(this.cond.duration, this.t + minutes);
    while (this.t < target - 1e-9) this.stepOnce();
  }

  runToEnd(): void {
    this.advance(this.cond.duration - this.t);
  }

  // ---------------------------------------------------------------- гибридные розыгрыши

  /** Сколько из n особей испытают событие с вероятностью prob за шаг. */
  private draw(n: number, prob: number): number {
    if (n <= 0 || prob <= 0) return 0;
    if (prob >= 1) return n;
    const T = this.rates.threshold;
    const mean = n * prob;
    const rest = n - mean;
    if (mean >= T && rest >= T) return mean;
    if (n >= T) {
      // Большая (непрерывная) популяция, но редкое событие — или наоборот, почти все.
      if (mean < T) return Math.min(n, this.rng.poisson(mean));
      return n - Math.min(n, this.rng.poisson(rest));
    }
    return this.rng.binomial(Math.round(n), prob);
  }

  /** Число событий, происходящих в среднем mean раз (рождения, частицы потомства). */
  private count(mean: number): number {
    if (mean <= 0) return 0;
    return mean >= this.rates.threshold ? mean : this.rng.poisson(mean);
  }

  /** Популяции меньше порога храним целыми: дробную часть разыгрываем. */
  private toCount(x: number): number {
    if (!(x > 0)) return 0;
    if (x >= this.rates.threshold) return x;
    const f = Math.floor(x);
    return f + (this.rng.uniform() < x - f ? 1 : 0);
  }

  // ---------------------------------------------------------------- шаг модели

  private computeRelGrowth(): number {
    return this.N / (this.rates.monodKs + this.N);
  }

  private infectedTotal(): number {
    let s = 0;
    for (const c of this.cohorts) s += c.nWt + c.nR + c.nLI;
    return s;
  }

  private stepOnce(): void {
    const t = this.t;
    const dt = this.dt;
    const r = this.rates;
    const m = this.mech;

    // --- протокол опыта
    if (!this.phageAdded && t >= this.cond.phageTime - 1e-9) this.addPhage();
    if (!this.diluted && this.cond.dilutionFactor > 1 && t >= this.cond.dilutionTime - 1e-9) this.dilute();

    // --- рост S и R по Моно с потреблением субстрата
    const g = this.computeRelGrowth();
    this.relGrowth = g;
    const muS = r.muMax * g;
    const muRr = r.muMaxResistant * g;
    let birthsS = this.count(this.S * (Math.exp(muS * dt) - 1));
    let birthsR = this.count(this.R * (Math.exp(muRr * dt) - 1));
    if (m.substrateDepletion) {
      const maxBirths = (this.N * this.V * r.yieldPerUmol) / 1000;
      const want = birthsS + birthsR;
      if (want > maxBirths) {
        const k = maxBirths / want;
        birthsS = Math.floor(birthsS * k);
        birthsR = Math.floor(birthsR * k);
      }
      this.N = Math.max(0, this.N - ((birthsS + birthsR) * 1000) / (r.yieldPerUmol * this.V));
    }
    let newMutants = 0;
    if (m.resistanceMutations && birthsS > 0) {
      newMutants = Math.min(birthsS, this.rng.poisson(r.muRes * birthsS));
      if (newMutants > 0) {
        this.totals.resistantMutants += newMutants;
        if (this.firstResistantTime === null) {
          this.firstResistantTime = t;
          this.log.push({ t, text: 'возник первый устойчивый мутант' });
        }
      }
    }
    this.S += birthsS - newMutants;
    this.R += birthsR + newMutants;

    // --- адсорбция фага
    const Iall = this.infectedTotal();
    const Ptot = this.Pwt + this.Pr;
    if (Ptot > 0) {
      const targetR = r.alphaR * this.R;
      const targets = this.S + targetR + Iall;
      if (targets > 0) {
        const fAds = 1 - Math.exp((-r.k * targets * dt) / this.V);
        const aWt = this.draw(this.Pwt, fAds);
        const aR = this.draw(this.Pr, fAds);
        const shS = this.S / targets;
        const shI = Iall / targets;
        const [wtS, wtI, wtRes] = this.split3(aWt, shS, shI);
        const [rS, rI, rRes] = this.split3(aR, shS, shI);

        // Заражение чувствительных: число разных клеток, получивших хотя бы один фаг.
        const hits = wtS + rS;
        if (hits > 0 && this.S > 0) {
          const nInf = this.draw(this.S, 1 - Math.exp(-hits / this.S));
          const nWt = this.draw(nInf, wtS / hits);
          const nR = nInf - nWt;
          this.S -= nInf;
          this.totals.infections += nInf;
          this.addToOpenCohort(nWt, nR);
        }

        // Повторная адсорбция на заражённые клетки: фаг тратится (если есть исключение
        // суперинфекции), а у дикого типа запускается торможение лизиса.
        const lostOnInfected = m.superinfectionExclusion ? 1 : 0;
        this.Pwt -= wtS + wtRes + wtI * lostOnInfected;
        this.Pr -= rS + rRes + rI * lostOnInfected;
        if (this.Pwt < 0) this.Pwt = 0;
        if (this.Pr < 0) this.Pr = 0;

        if (m.lysisInhibition && Iall > 0) {
          const pe = 1 - Math.exp((-r.k * Ptot * dt) / this.V);
          for (const c of this.cohorts) {
            if (c.nWt > 0 && c.age >= r.sieTime) {
              const conv = this.draw(c.nWt, pe);
              c.nWt -= conv;
              c.nLI += conv;
            }
          }
        }
      }
    }

    // --- развитие фага внутри клеток и лизис
    const speed = phageDevelopmentSpeed(r, g, m.hostPhysiology);
    const quality = phageBurstQuality(r, g, m.hostPhysiology);
    const Pdens = (this.Pwt + this.Pr) / this.V;
    const sd = r.lysisSd;
    const liCollapse = Math.exp(-r.k * Pdens * r.liWindow) / r.liWindow;
    const pCollapse = 1 - Math.exp(-liCollapse * dt * r.tempFactor);
    let releasedWt = 0;
    let releasedR = 0;
    let lysedNow = 0;
    for (const c of this.cohorts) {
      const a0 = c.age;
      const a1 = a0 + speed * dt;
      c.age = a1;
      if (a1 > r.eclipse) c.progeny += (a1 - Math.max(a0, r.eclipse)) * r.progenyRate * quality;
      const burst = Math.min(c.progeny, r.burstMaxLI);

      // Обычный лизис около a = L с разбросом σ_L.
      let pLyse: number;
      if (sd <= 0) pLyse = a1 >= r.latent ? 1 : 0;
      else if (a1 < r.latent - 6 * sd) pLyse = 0;
      else if (a0 > r.latent + 6 * sd) pLyse = 1;
      else {
        const F0 = normalCdf((a0 - r.latent) / sd);
        const F1 = normalCdf((a1 - r.latent) / sd);
        pLyse = F0 >= 1 ? 1 : Math.min(1, Math.max(0, (F1 - F0) / (1 - F0)));
      }
      if (pLyse > 0 && (c.nWt > 0 || c.nR > 0)) {
        const lw = this.draw(c.nWt, pLyse);
        const lr = this.draw(c.nR, pLyse);
        c.nWt -= lw;
        c.nR -= lr;
        releasedWt += lw * burst;
        releasedR += lr * burst;
        lysedNow += lw + lr;
      }

      // Клетки с заторможенным лизисом: срыв торможения, если суперинфекция прекратилась,
      // либо по истечении максимальной длительности.
      if (c.nLI > 0 && a1 >= r.latent) {
        let pl: number;
        if (!m.lysisInhibition) pl = pLyse;
        else if (a1 - r.latent >= r.liMaxDuration) pl = 1;
        else pl = pCollapse;
        const ll = this.draw(c.nLI, pl);
        c.nLI -= ll;
        releasedWt += ll * burst;
        lysedNow += ll;
      }
    }

    if (lysedNow > 0) {
      const progWt = this.count(releasedWt);
      const progR = this.count(releasedR);
      let mutR = 0;
      if (m.rMutations && progWt > 0) mutR = Math.min(progWt, this.rng.poisson(r.muR * progWt));
      this.totals.rMutants += mutR;
      this.Pwt += progWt - mutR;
      this.Pr += progR + mutR;
      this.ghosts += lysedNow;
      this.totals.lysed += lysedNow;
      this.lysedSinceRecord += lysedNow;
    }

    // --- распад свободных фагов
    if (m.phageDecay && r.decay > 0) {
      const pd = 1 - Math.exp(-r.decay * dt);
      this.Pwt -= this.draw(this.Pwt, pd);
      this.Pr -= this.draw(this.Pr, pd);
    }

    // --- малые популяции — целыми числами; пустые когорты удаляем
    this.S = this.toCount(this.S);
    this.R = this.toCount(this.R);
    this.Pwt = this.toCount(this.Pwt);
    this.Pr = this.toCount(this.Pr);
    for (const c of this.cohorts) {
      c.nWt = this.toCount(c.nWt);
      c.nR = this.toCount(c.nR);
      c.nLI = this.toCount(c.nLI);
    }
    this.compactCohorts();

    this.step++;
    if (this.step >= this.nextRecordStep) this.record();
  }

  /** Разделить n частиц на три адресата с долями a, b и остатком. */
  private split3(n: number, a: number, b: number): [number, number, number] {
    if (n <= 0) return [0, 0, 0];
    const x = this.draw(n, a);
    const restShare = 1 - a;
    const y = restShare > 1e-12 ? this.draw(n - x, Math.min(1, b / restShare)) : 0;
    return [x, y, n - x - y];
  }

  private addToOpenCohort(nWt: number, nR: number): void {
    if (nWt <= 0 && nR <= 0) return;
    const last = this.cohorts[this.cohorts.length - 1];
    if (last && last.age < COHORT_WIDTH) {
      last.nWt += nWt;
      last.nR += nR;
    } else {
      this.cohorts.push({ age: 0, nWt, nR, nLI: 0, progeny: 0 });
    }
  }

  private compactCohorts(): void {
    const r = this.rates;
    const lateAge = r.latent + 6 * r.lysisSd + 1;
    const out: Cohort[] = [];
    for (let i = 0; i < this.cohorts.length; i++) {
      const c = this.cohorts[i];
      const empty = c.nWt <= 0 && c.nR <= 0 && c.nLI <= 0;
      if (empty && i !== this.cohorts.length - 1) continue;
      if (empty && c.age >= COHORT_WIDTH) continue;
      // Старые когорты, где остались только заторможенные клетки, сливаем — их судьба
      // почти не зависит от точного возраста, а число когорт остаётся небольшим.
      const prev = out[out.length - 1];
      if (
        prev && c.age > lateAge && prev.age > lateAge && c.nWt <= 0 && c.nR <= 0 &&
        prev.nWt <= 0 && prev.nR <= 0 && prev.age - c.age < 2
      ) {
        const n = prev.nLI + c.nLI;
        if (n > 0) {
          prev.age = (prev.age * prev.nLI + c.age * c.nLI) / n;
          prev.progeny = (prev.progeny * prev.nLI + c.progeny * c.nLI) / n;
        }
        prev.nLI = n;
        continue;
      }
      out.push(c);
    }
    this.cohorts = out;
  }

  private addPhage(): void {
    this.phageAdded = true;
    const c = this.cond;
    if (c.moi <= 0) return;
    const cells = this.S + this.R + this.infectedTotal();
    const total = this.count(c.moi * cells);
    const rFrac = Math.min(1, Math.max(0, c.rFractionPct / 100));
    const nR = this.draw(total, rFrac);
    this.Pwt += total - nR;
    this.Pr += nR;
    this.phageVolumeMl = total / c.phageTiter;
    this.log.push({
      t: this.t,
      text: `внесён фаг: MOI ${fmtNum(c.moi)}, ${fmtNum(total / this.V)} БОЕ/мл (${fmtNum(this.phageVolumeMl)} мл препарата)`,
    });
  }

  private dilute(): void {
    this.diluted = true;
    const f = 1 / this.cond.dilutionFactor;
    this.S = this.toCount(this.draw(this.S, f));
    this.R = this.toCount(this.draw(this.R, f));
    this.Pwt = this.toCount(this.draw(this.Pwt, f));
    this.Pr = this.toCount(this.draw(this.Pr, f));
    this.ghosts *= f;
    for (const c of this.cohorts) {
      c.nWt = this.toCount(this.draw(c.nWt, f));
      c.nR = this.toCount(this.draw(c.nR, f));
      c.nLI = this.toCount(this.draw(c.nLI, f));
    }
    // Разводим свежей средой того же состава.
    const fresh = this.cond.substrateMM * 1000;
    this.N = this.N * f + fresh * (1 - f);
    this.compactCohorts();
    this.log.push({ t: this.t, text: `культура разведена в ${fmtNum(this.cond.dilutionFactor)} раз свежей средой` });
  }

  // ---------------------------------------------------------------- показания

  snapshot(): FlaskSnapshot {
    const V = this.V;
    let I = 0;
    let LI = 0;
    let intracellular = 0;
    let progSum = 0;
    for (const c of this.cohorts) {
      const n = c.nWt + c.nR + c.nLI;
      I += n;
      LI += c.nLI;
      intracellular += n * Math.min(c.progeny, this.rates.burstMaxLI);
      progSum += n * Math.min(1, c.age / this.rates.latent);
    }
    const P = this.Pwt + this.Pr;
    const intact = this.S + this.R + I;
    const od = (intact + this.rates.ghostOd * this.ghosts) / V / this.rates.odPerCell;
    return {
      t: this.t,
      S: this.S / V,
      R: this.R / V,
      I: I / V,
      LI: LI / V,
      Pwt: this.Pwt / V,
      Pr: this.Pr / V,
      P: P / V,
      N: this.N,
      ghosts: this.ghosts / V,
      od,
      titer: (P + I) / V,
      titerChloroform: (P + intracellular) / V,
      growth: this.relGrowth,
      infectionProgress: I > 0 ? progSum / I : 0,
      lysisRate: this.lysedSinceRecord / V,
    };
  }

  private record(): void {
    const s = this.snapshot();
    const se = this.series;
    se.t.push(s.t);
    se.S.push(s.S);
    se.R.push(s.R);
    se.I.push(s.I);
    se.LI.push(s.LI);
    se.Pwt.push(s.Pwt);
    se.Pr.push(s.Pr);
    se.P.push(s.P);
    se.N.push(s.N);
    se.od.push(s.od);
    se.titer.push(s.titer);
    se.titerChloroform.push(s.titerChloroform);
    this.lysedSinceRecord = 0;
    this.nextRecordStep = this.step + Math.round(this.recordEvery / this.dt);
  }
}

function fmtNum(x: number): string {
  if (x === 0) return '0';
  if (Math.abs(x) >= 1e4 || Math.abs(x) < 1e-2) return x.toExponential(1).replace('.', ',');
  return String(Math.round(x * 100) / 100).replace('.', ',');
}
