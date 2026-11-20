/**
 * Обработка результатов опытов в колбе — так, как это сделал бы экспериментатор
 * по своим измерениям (титр, OD), без заглядывания во внутренние переменные модели.
 */
import type { FlaskConditions, FlaskSeries } from './model';

export interface Measurement {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  /** Знаков после запятой при выводе (или 'sci' для научной записи). */
  digits: number | 'sci';
  note?: string;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function window(series: FlaskSeries, key: keyof FlaskSeries, t0: number, t1: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < series.t.length; i++) {
    const t = series.t[i];
    if (t >= t0 - 1e-9 && t <= t1 + 1e-9) out.push(series[key][i]);
  }
  return out;
}

/** Время, когда ряд впервые пересекает уровень level (с линейной интерполяцией), начиная с from. */
export function crossingTime(
  t: number[], y: number[], level: number, from: number, direction: 'up' | 'down',
): number | null {
  for (let i = 1; i < t.length; i++) {
    if (t[i] < from) continue;
    const a = y[i - 1];
    const b = y[i];
    const hit = direction === 'up' ? a < level && b >= level : a > level && b <= level;
    if (hit) {
      const f = (level - a) / (b - a);
      return t[i - 1] + f * (t[i] - t[i - 1]);
    }
  }
  return null;
}

export interface OneStepResult {
  latentPeriod: number | null;
  riseTime: number | null;
  plateau: number;
  final: number;
  riseFactor: number;
  burstSize: number;
  eclipse: number | null;
}

/**
 * Одиночный цикл роста. Время отсчитывается от внесения фага.
 * Плато — средний титр между разведением и 15-й минутой; итог — второе плато после ступеньки.
 * Латентный период — момент, когда титр впервые превышает плато вдвое (начало подъёма).
 * Урожай — прирост титра, делённый на число инфекционных центров; свободный фаг
 * определяется по титру после хлороформа на плато (до эклипса он не содержит внутриклеточных фагов).
 */
export function analyzeOneStep(series: FlaskSeries, cond: FlaskConditions): OneStepResult {
  const t0 = cond.phageTime;
  // Разведение задаёт начало плато, только если оно сделано после внесения фага (и не позже конца окна);
  // иначе окно захватило бы титр до внесения фага (нули) или оказалось бы пустым.
  const dilutedAfterPhage = cond.dilutionFactor > 1 && cond.dilutionTime >= t0 && cond.dilutionTime + 0.5 < t0 + 15;
  const tPlateau0 = dilutedAfterPhage ? cond.dilutionTime + 0.5 : t0 + 5;
  const plateauVals = window(series, 'titer', tPlateau0, t0 + 15);
  const plateau = mean(plateauVals);
  // Итоговый титр — второе плато сразу после ступеньки (до начала следующего цикла заражения):
  // находим середину подъёма в логарифмической шкале и берём окно 8–15 мин после неё.
  let maxTiter = 0;
  for (let i = 0; i < series.t.length; i++) if (series.t[i] >= tPlateau0) maxTiter = Math.max(maxTiter, series.titer[i]);
  const tMidLog = crossingTime(series.t, series.titer, Math.sqrt(plateau * maxTiter), t0 + 5, 'up');
  const finalVals = tMidLog === null ? [] : window(series, 'titer', tMidLog + 8, tMidLog + 15);
  const final = finalVals.length ? mean(finalVals) : maxTiter;
  // Свободный фаг — минимум титра с хлороформом на плато (до эклипса внутри клеток нет зрелых фагов).
  const chl = window(series, 'titerChloroform', tPlateau0, t0 + 15);
  const freePhage = chl.length ? Math.min(...chl) : 0;
  const centers = Math.max(plateau - freePhage, 1e-12);
  const tCross = crossingTime(series.t, series.titer, 2 * plateau, t0 + 5, 'up');
  const tHalf = crossingTime(series.t, series.titer, plateau + 0.5 * (final - plateau), t0 + 5, 'up');
  // Эклипс: момент, когда титр после хлороформа поднимается вдвое над уровнем свободного фага.
  const tEcl = crossingTime(series.t, series.titerChloroform, 2 * freePhage + 0.01 * centers, t0 + 2, 'up');
  return {
    latentPeriod: tCross === null ? null : tCross - t0,
    riseTime: tHalf === null ? null : tHalf - t0,
    plateau,
    final,
    riseFactor: final / plateau,
    burstSize: (final - freePhage) / centers,
    eclipse: tEcl === null ? null : tEcl - t0,
  };
}

export interface LysisResult {
  peakOd: number;
  peakTime: number;
  /** Время от внесения фага до падения OD вдвое от максимума. */
  clearingTime: number | null;
  minOdAfter: number;
  /** Время повторного роста: OD после просветления снова превышает половину максимума. */
  regrowthTime: number | null;
}

export function analyzeLysis(series: FlaskSeries, cond: FlaskConditions): LysisResult {
  const t0 = cond.phageTime;
  let peakOd = 0;
  let peakIdx = 0;
  for (let i = 0; i < series.t.length; i++) {
    if (series.t[i] < t0) continue;
    if (series.od[i] > peakOd) {
      peakOd = series.od[i];
      peakIdx = i;
    }
    // Ищем первый максимум: после просветления (OD < 0,3 пика) прекращаем поиск.
    if (peakOd > 0 && series.od[i] < 0.3 * peakOd) break;
  }
  const peakTime = series.t[peakIdx];
  const tClear = crossingTime(series.t, series.od, 0.5 * peakOd, peakTime, 'down');
  let minOd = peakOd;
  let minIdx = peakIdx;
  if (tClear !== null) {
    for (let i = peakIdx; i < series.t.length; i++) {
      if (series.od[i] < minOd) {
        minOd = series.od[i];
        minIdx = i;
      }
    }
  }
  const tRegrowth = tClear === null ? null : crossingTime(series.t, series.od, 0.5 * peakOd, series.t[minIdx], 'up');
  return {
    peakOd,
    peakTime: peakTime - t0,
    clearingTime: tClear === null ? null : tClear - t0,
    minOdAfter: minOd,
    regrowthTime: tRegrowth === null ? null : tRegrowth - t0,
  };
}

export function oneStepMeasurements(r: OneStepResult): Measurement[] {
  return [
    { id: 'latent', label: 'Латентный период (начало подъёма)', value: r.latentPeriod, unit: 'мин', digits: 1 },
    { id: 'rise', label: 'Время полуподъёма', value: r.riseTime, unit: 'мин', digits: 1 },
    { id: 'eclipse', label: 'Эклипс (по титру с хлороформом)', value: r.eclipse, unit: 'мин', digits: 1 },
    { id: 'riseFactor', label: 'Подъём титра', value: r.riseFactor, unit: 'раз', digits: 0 },
    { id: 'burst', label: 'Размер урожая', value: r.burstSize, unit: 'частиц/клетку', digits: 0 },
    { id: 'plateau', label: 'Титр на плато', value: r.plateau, unit: 'БОЕ/мл', digits: 'sci' },
  ];
}

export function lysisMeasurements(r: LysisResult): Measurement[] {
  return [
    { id: 'peakOd', label: 'Максимум OD₆₀₀', value: r.peakOd, unit: '', digits: 3 },
    { id: 'peakTime', label: 'Максимум OD через', value: r.peakTime / 60, unit: 'ч после заражения', digits: 2 },
    { id: 'clearing', label: 'Просветление (OD ↓ вдвое) через', value: r.clearingTime === null ? null : r.clearingTime / 60, unit: 'ч', digits: 2 },
    { id: 'minOd', label: 'Минимум OD после лизиса', value: r.minOdAfter, unit: '', digits: 3 },
    { id: 'regrowth', label: 'Повторный рост через', value: r.regrowthTime === null ? null : r.regrowthTime / 60, unit: 'ч', digits: 2 },
  ];
}
