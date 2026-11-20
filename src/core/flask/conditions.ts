/**
 * Описание полей «Условий эксперимента» для колбы: подписи, единицы, границы.
 * Используется и формой в интерфейсе, и выгрузкой CSV.
 */
import type { FlaskConditions } from './model';

export interface ConditionMeta {
  key: keyof FlaskConditions;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  scale: 'linear' | 'log';
  /** Допустим ли 0 вне диапазона [min, max] (например, MOI = 0 — контроль без фага). */
  allowZero?: boolean;
  hint: string;
}

export const FLASK_CONDITION_META: ConditionMeta[] = [
  { key: 'initialDensity', label: 'Начальная плотность бактерий', unit: 'КОЕ/мл', min: 1e3, max: 2e9, step: 0, scale: 'log',
    hint: 'Число живых клеток E. coli в 1 мл культуры в начале инкубации.' },
  { key: 'substrateMM', label: 'Богатство среды', unit: 'мМ глюкозы', min: 0.01, max: 20, step: 0, scale: 'log',
    hint: 'Количество лимитирующего субстрата в эквиваленте глюкозы. Определяет, до какой плотности вырастет культура: ≈ выход биомассы × концентрация.' },
  { key: 'temperature', label: 'Температура', unit: '°C', min: 25, max: 40, step: 0.5, scale: 'linear',
    hint: 'Все скорости модели (рост, развитие фага) пересчитываются от 37 °C через коэффициент Q₁₀.' },
  { key: 'volumeMl', label: 'Объём культуры', unit: 'мл', min: 1, max: 500, step: 1, scale: 'log',
    hint: 'Объём жидкости в колбе. Важен для случайных событий: чем больше объём, тем больше клеток и тем раньше появляются редкие мутанты.' },
  { key: 'phageTime', label: 'Внесение фага через', unit: 'мин', min: 0, max: 600, step: 1, scale: 'linear', allowZero: true,
    hint: 'Момент добавления препарата фага от начала инкубации.' },
  { key: 'moi', label: 'Множественность заражения (MOI)', unit: 'фагов/клетку', min: 1e-6, max: 100, step: 0, scale: 'log', allowZero: true,
    hint: 'Отношение числа внесённых фаговых частиц к числу бактерий в момент внесения. 0 — опыт без фага (контроль).' },
  { key: 'phageTiter', label: 'Титр препарата фага', unit: 'БОЕ/мл', min: 1e6, max: 1e12, step: 0, scale: 'log',
    hint: 'Концентрация фага в исходном препарате. По нему рассчитывается, сколько мл препарата нужно внести для заданного MOI.' },
  { key: 'rFractionPct', label: 'Доля r-мутантов в препарате', unit: '%', min: 0, max: 100, step: 0.1, scale: 'linear', allowZero: true,
    hint: 'Какая часть фаговых частиц в препарате — r-мутанты (не тормозят лизис).' },
  { key: 'dilutionFactor', label: 'Разведение культуры', unit: 'раз', min: 1, max: 1e6, step: 0, scale: 'log',
    hint: 'Во сколько раз культуру разводят свежей средой (1 — без разведения). В опыте одиночного цикла разведение останавливает повторное заражение.' },
  { key: 'dilutionTime', label: 'Разведение через', unit: 'мин', min: 0, max: 600, step: 0.5, scale: 'linear', allowZero: true,
    hint: 'Когда выполняется разведение, от начала инкубации.' },
  { key: 'duration', label: 'Длительность опыта', unit: 'мин', min: 10, max: 2880, step: 10, scale: 'linear',
    hint: 'Сколько длится инкубация (до 48 ч).' },
];

export function flaskConditionRows(c: FlaskConditions): { label: string; value: number; unit: string }[] {
  return FLASK_CONDITION_META.map((m) => ({ label: m.label, value: c[m.key], unit: m.unit }));
}

/** Приводит условия опыта к допустимым: неизвестные и нечисловые значения — по умолчанию, остальные — в границы. */
export function sanitizeConditions(raw: unknown, fallback: FlaskConditions): FlaskConditions {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...fallback };
  for (const m of FLASK_CONDITION_META) {
    const v = src[m.key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[m.key] = m.allowZero && v === 0 ? 0 : Math.min(m.max, Math.max(m.min, v));
  }
  return out;
}
