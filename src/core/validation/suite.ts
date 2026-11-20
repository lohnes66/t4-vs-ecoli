/**
 * «Проверка модели»: воспроизведение известных из литературы результатов.
 * Таблица проверок совпадает с разделом «Валидация и приёмка» технического задания.
 * Те же функции запускаются автотестами (tests/validation.test.ts).
 */
import { FlaskModel, type FlaskConditions } from '../flask/model';
import { flaskScenario } from '../flask/scenarios';
import { analyzeOneStep, analyzeLysis } from '../flask/analysis';
import type { Params, Mechanisms } from '../params';
import { MicroscopeModel } from '../microscope/model';
import { microScenario } from '../microscope/scenarios';
import { PlateModel, DEFAULT_PLATE_CONDITIONS, type PlateConditions, type PlateSpec } from '../plate/model';

export interface ValidationResult {
  passed: boolean;
  /** Что получилось — коротко, для таблицы. */
  value: string;
  details?: string;
}

export interface ValidationTest {
  id: string;
  name: string;
  expected: string;
  criterion: string;
  module: string;
  /** null — проверка относится к ещё не реализованному этапу. */
  run: ((ctx: ValidationContext) => ValidationResult) | null;
  pendingNote?: string;
}

export interface ValidationContext {
  params: Params;
  mechanisms: Mechanisms;
  seed: number;
}

const f1 = (x: number | null) => (x === null ? '—' : x.toFixed(1).replace('.', ','));
const f0 = (x: number) => Math.round(x).toString();

function runFlask(ctx: ValidationContext, cond: FlaskConditions, mech?: Partial<Mechanisms>, seed?: number): FlaskModel {
  const m = new FlaskModel(ctx.params, { ...ctx.mechanisms, ...mech }, cond, seed ?? ctx.seed);
  m.runToEnd();
  return m;
}

const f2 = (x: number) => x.toFixed(2).replace('.', ',');

function plateCond(plates: PlateSpec[], extra: Partial<PlateConditions> = {}): PlateConditions {
  return { ...DEFAULT_PLATE_CONDITIONS, sameLayout: true, plates, ...extra };
}

/** Рост «типичной» бляшки по часам: диаметр прозрачной зоны и ореола на каждой чашке. */
function plateGrowth(ctx: ValidationContext, cond: PlateConditions, seed = ctx.seed): { t: number[]; clear: number[][]; outer: number[][]; model: PlateModel } {
  const m = new PlateModel(ctx.params, ctx.mechanisms, cond, seed);
  const t: number[] = [];
  const clear: number[][] = cond.plates.map(() => []);
  const outer: number[][] = cond.plates.map(() => []);
  while (!m.done) {
    m.advance(30);
    t.push(m.t);
    cond.plates.forEach((_, i) => {
      const d = m.typicalPlaque(i);
      clear[i].push(d.clear);
      outer[i].push(d.outer);
    });
  }
  return { t, clear, outer, model: m };
}

/**
 * Когда бляшка перестала расти: после этого скорость роста (за двухчасовые окна) не превышает
 * 20 % от максимальной. Медленное просветление ореола после остановки — не рост.
 */
function stopTime(t: number[], d: number[]): { stop: number | null; maxRate: number; lateRate: number } {
  const rate: number[] = [];
  const tm: number[] = [];
  for (let i = 0; i < d.length; i++) {
    const j = t.findIndex((x) => x >= t[i] + 120 - 1e-9);
    if (j < 0) break;
    rate.push((d[j] - d[i]) / ((t[j] - t[i]) / 60));
    tm.push(t[i]);
  }
  const max = Math.max(...rate);
  const lateRate = rate[rate.length - 1] ?? 0;
  if (!(max > 0)) return { stop: null, maxRate: 0, lateRate };
  let last = -1;
  for (let i = 0; i < rate.length; i++) if (rate[i] > 0.2 * max) last = i;
  // Окно, где рост ещё был быстрым, заканчивается через 2 ч после его начала.
  const stop = last < 0 || last === rate.length - 1 ? null : tm[last] + 120;
  return { stop, maxRate: max, lateRate };
}

const WT: PlateSpec = { label: 'T4', dilution: 7, rFractionPct: 0 };
const R: PlateSpec = { label: 'T4r', dilution: 7, rFractionPct: 100 };

export const VALIDATION_TESTS: ValidationTest[] = [
  {
    id: 'one-step',
    name: 'Одиночный цикл роста',
    module: 'Колба',
    expected: 'Плато, затем резкий подъём титра',
    criterion: 'Латентный период 22–25 мин, подъём в 100–200 раз',
    run: (ctx) => {
      const sc = flaskScenario('one-step');
      const m = runFlask(ctx, sc.conditions);
      const r = analyzeOneStep(m.series, sc.conditions);
      const okL = r.latentPeriod !== null && r.latentPeriod >= 22 && r.latentPeriod <= 25;
      const okB = r.riseFactor >= 100 && r.riseFactor <= 200;
      return {
        passed: okL && okB,
        value: `латентный период ${f1(r.latentPeriod)} мин; подъём в ${f0(r.riseFactor)} раз`,
        details: `урожай ${f0(r.burstSize)} частиц/клетку, эклипс ${f1(r.eclipse)} мин, полуподъём ${f1(r.riseTime)} мин`,
      };
    },
  },
  {
    id: 'lysis-low-moi',
    name: 'Лизис культуры при низком MOI',
    module: 'Колба',
    expected: 'Рост OD, затем просветление',
    criterion: 'Просветление через 2–4 ч',
    run: (ctx) => {
      const sc = flaskScenario('lysis-moi-0.1');
      const m = runFlask(ctx, sc.conditions);
      const r = analyzeLysis(m.series, sc.conditions);
      const h = r.clearingTime === null ? null : r.clearingTime / 60;
      const grew = r.peakTime > 10;
      return {
        passed: grew && h !== null && h >= 2 && h <= 4,
        value: h === null ? 'просветления нет' : `просветление через ${f1(h)} ч`,
        details: `максимум OD ${r.peakOd.toFixed(3).replace('.', ',')} через ${f1(r.peakTime)} мин после заражения`,
      };
    },
  },
  {
    id: 'li-flask',
    name: 'Торможение лизиса в жидкой культуре',
    module: 'Колба',
    expected: 'Без торможения лизиса культура просветляется раньше (как у r-мутанта, опыт Дёрмана)',
    criterion: 'Просветление без торможения раньше, чем с ним',
    run: (ctx) => {
      const sc = flaskScenario('lysis-moi-0.1');
      const on = analyzeLysis(runFlask(ctx, sc.conditions, { lysisInhibition: true }).series, sc.conditions);
      const off = analyzeLysis(runFlask(ctx, sc.conditions, { lysisInhibition: false }).series, sc.conditions);
      const a = on.clearingTime;
      const b = off.clearingTime;
      return {
        passed: a !== null && b !== null && b < a,
        value: `с торможением ${f1(a === null ? null : a / 60)} ч; без — ${f1(b === null ? null : b / 60)} ч`,
      };
    },
  },
  {
    id: 'regrowth',
    name: 'Повторный рост за счёт устойчивых мутантов',
    module: 'Колба',
    expected: 'Через несколько часов после лизиса культура снова мутнеет',
    criterion: 'Повторный рост есть с мутациями устойчивости и отсутствует без них',
    run: (ctx) => {
      const sc = flaskScenario('resistance');
      const withR = analyzeLysis(runFlask(ctx, sc.conditions, { resistanceMutations: true }).series, sc.conditions);
      const noR = analyzeLysis(runFlask(ctx, sc.conditions, { resistanceMutations: false }).series, sc.conditions);
      const t = withR.regrowthTime;
      return {
        passed: t !== null && noR.regrowthTime === null,
        value: t === null ? 'повторного роста нет' : `повторный рост через ${f1(t / 60)} ч после заражения`,
        details: noR.regrowthTime === null ? 'без мутаций устойчивости культура остаётся прозрачной' : 'без мутаций тоже есть рост — ошибка',
      };
    },
  },
  {
    id: 'micro-cycle',
    name: 'Цикл заражения в микроскопе',
    module: 'Микроскоп',
    expected: 'Отдельная бактерия лопается через латентный период и выпускает урожай, как в колбе',
    criterion: 'Среднее время до лизиса 22–27 мин, средний урожай 100–200 (клетки без торможения лизиса)',
    run: (ctx) => {
      const sc = microScenario('attack');
      const m = new MicroscopeModel(ctx.params, ctx.mechanisms, { ...sc.conditions, duration: 70 }, ctx.seed);
      const times: number[] = [];
      const bursts: number[] = [];
      while (!m.done) {
        m.advance(5);
        for (const e of m.drainEvents()) {
          if (e.kind === 'lysis' && !e.li) {
            times.push(e.t - e.infectedAt);
            bursts.push(e.burst);
          }
        }
      }
      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
      const lt = mean(times);
      const b = mean(bursts);
      return {
        passed: times.length >= 5 && lt >= 22 && lt <= 27 && b >= 100 && b <= 200,
        value: `время до лизиса ${f1(lt)} мин; урожай ${f0(b)} частиц`,
        details: `по ${times.length} лизированным клеткам за 70 мин`,
      };
    },
  },
  {
    id: 'plaque-wt',
    name: 'Размер бляшки T4 дикого типа',
    module: 'Чашка Петри',
    expected: 'Мелкая бляшка с размытым краем',
    criterion: 'Диаметр 1–2 мм, рост останавливается за 6–10 ч',
    run: (ctx) => {
      const g = plateGrowth(ctx, plateCond([WT]));
      const d = g.clear[0][g.clear[0].length - 1];
      const halo = g.outer[0][g.outer[0].length - 1];
      const st = stopTime(g.t, g.clear[0]);
      const h = st.stop === null ? null : st.stop / 60;
      return {
        passed: d >= 1 && d <= 2 && h !== null && h >= 6 && h <= 10,
        value: `диаметр ${f2(d)} мм через 16 ч; рост остановился через ${f1(h)} ч`,
        details: `с ореолом ${f2(halo)} мм; скорость роста: максимум ${f2(st.maxRate)} мм/ч, в конце ${f2(st.lateRate)} мм/ч (просветляется ореол); типичная бляшка — с медианным временем первой адсорбции`,
      };
    },
  },
  {
    id: 'plaque-r',
    name: 'Бляшка r-мутанта',
    module: 'Чашка Петри',
    expected: 'Крупная бляшка с резким краем',
    criterion: 'Диаметр больше не менее чем на 15 %, мутный край уже, чем у дикого типа',
    run: (ctx) => {
      const g = plateGrowth(ctx, plateCond([WT, R]));
      const n = g.t.length - 1;
      const [dw, dr] = [g.clear[0][n], g.clear[1][n]];
      const [hw, hr] = [(g.outer[0][n] - dw) / 2, (g.outer[1][n] - dr) / 2];
      return {
        passed: dr >= 1.15 * dw && hr < 0.5 * hw,
        value: `r-мутант ${f2(dr)} мм, дикий тип ${f2(dw)} мм (в ${f2(dr / dw)} раза)`,
        details: `ширина мутного края: r ${f2(hr)} мм, дикий тип ${f2(hw)} мм`,
      };
    },
  },
  {
    id: 'titration',
    name: 'Титрование',
    module: 'Чашка Петри',
    expected: 'Число бляшек падает в 10 раз на шаг разведения',
    criterion: 'Наклон прямой lg(число бляшек) от шага разведения −1 ± 0,1',
    run: (ctx) => {
      const dils = [4, 5, 6, 7];
      const m = new PlateModel(ctx.params, ctx.mechanisms, plateCond(dils.map((d) => ({ label: `1e-${d}`, dilution: d, rFractionPct: 0 })), { stockTiter: 0, sameLayout: false }), ctx.seed);
      m.runToEnd();
      const counts = m.plates.map((p) => p.phages);
      const xs = dils;
      const ys = counts.map((c) => Math.log10(Math.max(1, c)));
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let sxy = 0;
      let sxx = 0;
      for (let i = 0; i < xs.length; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) * (xs[i] - mx);
      }
      const slope = sxy / sxx;
      const est = counts[3] * 10 * Math.pow(10, dils[3]);
      return {
        passed: Math.abs(slope + 1) <= 0.1,
        value: `наклон ${f2(slope)}; бляшек ${counts.join(' → ')}`,
        details: `титр по чашке 10⁻⁷: ${est.toExponential(1).replace('.', ',')} БОЕ/мл (заложено ${m.stockTiter.toExponential(1).replace('.', ',')})`,
      };
    },
  },
  {
    id: 'li-off-plaque',
    name: 'Отключение торможения лизиса',
    module: 'Чашка Петри',
    expected: 'Бляшки дикого типа становятся крупнее',
    criterion: 'Воспроизводит эффект r-мутации: крупнее обычных, отличие от r-мутанта менее 5 %',
    run: (ctx) => {
      const g = plateGrowth(ctx, plateCond([WT, R, { ...WT, label: 'T4, без торможения', mech: { lysisInhibition: false } }]));
      const n = g.t.length - 1;
      const [dw, dr, doff] = [g.clear[0][n], g.clear[1][n], g.clear[2][n]];
      return {
        passed: doff > 1.1 * dw && Math.abs(doff / dr - 1) < 0.05,
        value: `без торможения ${f2(doff)} мм; с торможением ${f2(dw)} мм; r-мутант ${f2(dr)} мм`,
      };
    },
  },
  {
    id: 'grid',
    name: 'Сходимость по сетке',
    module: 'Чашка Петри',
    expected: 'Результат не меняется при 256 → 512',
    criterion: 'Отличие диаметра бляшки менее 5 %',
    run: (ctx) => {
      const a = plateGrowth(ctx, plateCond([WT], { gridNodes: 256 }));
      const b = plateGrowth(ctx, plateCond([WT], { gridNodes: 512 }));
      const n = a.t.length - 1;
      const da = a.clear[0][n];
      const db = b.clear[0][n];
      const diff = Math.abs(da / db - 1) * 100;
      return {
        passed: diff < 5,
        value: `256 колец: ${f2(da)} мм; 512 колец: ${f2(db)} мм; отличие ${f1(diff)} %`,
        details: `шаг сетки ${f1(3500 / 256)} и ${f1(3500 / 512)} мкм`,
      };
    },
  },
  {
    id: 'reproducibility',
    name: 'Воспроизводимость',
    module: 'Колба, чашка Петри',
    expected: 'Один seed даёт один результат',
    criterion: 'Полное совпадение; другой seed — другой результат',
    run: (ctx) => {
      const sc = flaskScenario('resistance');
      const a = runFlask(ctx, sc.conditions);
      const b = runFlask(ctx, sc.conditions);
      const c = runFlask(ctx, sc.conditions, undefined, ctx.seed + 1);
      const keys = ['S', 'R', 'I', 'P', 'Pr', 'od'] as const;
      let same = a.series.t.length === b.series.t.length;
      let diffOther = false;
      let n = 0;
      for (const k of keys) {
        const xa = a.series[k];
        const xb = b.series[k];
        const xc = c.series[k];
        for (let i = 0; i < xa.length; i++) {
          n++;
          if (xa[i] !== xb[i]) same = false;
          if (xa[i] !== xc[i]) diffOther = true;
        }
      }
      // Чашка: расположение бляшек и их размеры.
      const pc = plateCond([WT]);
      const pa = new PlateModel(ctx.params, ctx.mechanisms, pc, ctx.seed);
      const pb = new PlateModel(ctx.params, ctx.mechanisms, pc, ctx.seed);
      const pd = new PlateModel(ctx.params, ctx.mechanisms, pc, ctx.seed + 1);
      for (const x of [pa, pb, pd]) x.runToEnd();
      const sig = (x: PlateModel) => { x.refreshClasses(); return x.plaques.map((p) => `${p.x},${p.y},${p.t0},${x.plaqueDiameter(p)}`).join(';'); };
      const plateSame = sig(pa) === sig(pb);
      if (!plateSame) same = false;
      if (sig(pa) === sig(pd)) diffOther = false;
      n += pa.plaques.length * 4;
      return {
        passed: same && diffOther,
        value: same ? `совпали все ${n.toLocaleString('ru-RU')} значений` : 'есть расхождения',
        details: diffOther ? `seed ${ctx.seed + 1} даёт другой прогон` : 'другой seed дал тот же результат — генератор не используется',
      };
    },
  },
];
