/**
 * Пресеты сценариев для колбы. Сценарий — это только набор условий опыта;
 * параметры модели и механизмы задаются отдельно (пресет «T4 дикого типа»).
 */
import { DEFAULT_FLASK_CONDITIONS, type FlaskConditions } from './model';

export type FlaskAnalysisKind = 'oneStep' | 'lysis' | 'resistance' | 'competition';

export interface FlaskScenario {
  id: string;
  name: string;
  description: string;
  analysis: FlaskAnalysisKind;
  conditions: FlaskConditions;
}

export const FLASK_SCENARIOS: FlaskScenario[] = [
  {
    id: 'one-step',
    name: 'Одиночный цикл роста',
    analysis: 'oneStep',
    description:
      'Классическая методика Эллиса и Дельбрюка. К плотной культуре в экспоненциальной фазе добавляют фаг, ' +
      'за 10 минут почти весь фаг адсорбируется, затем культуру разводят в 10 000 раз, чтобы потомство ' +
      'не заражало новые клетки. На графике титра видна ступенька: плато, затем резкий подъём после латентного периода.',
    conditions: {
      ...DEFAULT_FLASK_CONDITIONS,
      initialDensity: 5e8,
      substrateMM: 5,
      phageTime: 0,
      moi: 0.1,
      dilutionFactor: 1e4,
      dilutionTime: 10,
      duration: 60,
    },
  },
  {
    id: 'lysis-moi-0.1',
    name: 'Лизис культуры при MOI 0,1',
    analysis: 'lysis',
    description:
      'Растущую культуру заражают при множественности 0,1. Сначала культура продолжает мутнеть, ' +
      'затем после нескольких циклов размножения фага наступает просветление.',
    conditions: {
      ...DEFAULT_FLASK_CONDITIONS,
      initialDensity: 1e7,
      phageTime: 0,
      moi: 0.1,
      duration: 480,
    },
  },
  {
    id: 'resistance',
    name: 'Появление устойчивости',
    analysis: 'resistance',
    description:
      'Культура лизируется фагом, но среди миллиардов клеток есть редкие устойчивые мутанты OmpC⁻. ' +
      'Через несколько часов после лизиса они вновь делают культуру мутной. Момент появления мутантов ' +
      'случаен: сравните прогоны с разным seed.',
    conditions: {
      ...DEFAULT_FLASK_CONDITIONS,
      initialDensity: 1e7,
      phageTime: 0,
      moi: 0.1,
      duration: 24 * 60,
    },
  },
  {
    id: 'wt-vs-r',
    name: 'Дикий тип против r-мутанта',
    analysis: 'competition',
    description:
      'В препарате фага поровну частиц дикого типа и r-мутанта. Следите за долей r-мутантов: ' +
      'торможение лизиса задерживает выход потомства дикого типа, но делает урожай больше.',
    conditions: {
      ...DEFAULT_FLASK_CONDITIONS,
      initialDensity: 1e7,
      phageTime: 0,
      moi: 0.1,
      rFractionPct: 50,
      duration: 480,
    },
  },
];

export function flaskScenario(id: string): FlaskScenario {
  return FLASK_SCENARIOS.find((s) => s.id === id) ?? FLASK_SCENARIOS[0];
}
