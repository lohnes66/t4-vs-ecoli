/** Сценарии микроскопа. Названия и описания — простым языком: программой пользуется ученик. */
import type { MicroConditions } from './model';

export interface MicroScenario {
  id: string;
  name: string;
  /** Одна фраза для кнопки. */
  short: string;
  /** Что увидеть и о чём рассказать. */
  story: string;
  conditions: MicroConditions;
  /** Автоматически следить за первой заражённой бактерией. */
  followFirst: boolean;
}

const BASE: MicroConditions = {
  // Газон в мягком агаре — это разреженные микроколонии, между которыми диффундирует фаг.
  width: 60, height: 40, seedCells: 45, pregrowMin: 30, resistantPct: 0,
  dropTime: 2, dropAmount: 300, dropX: 0.5, dropY: 0.5, dropRPct: 0,
  // Питания в агаре хватает на несколько часов: потом газон перестаёт расти — бляшка остаётся пустой.
  temperature: 37, substrateMM: 0.15, duration: 240,
};

export const MICRO_SCENARIOS: MicroScenario[] = [
  {
    id: 'one-infection',
    name: 'История одного заражения',
    short: 'Вирус находит бактерию, бактерия лопается',
    story:
      'Крупный план: несколько бактерий и всего пара вирусов. Посмотри, как вирус прицепляется к бактерии, ' +
      'как бактерия меняет цвет, пока внутри собираются новые вирусы, и как она лопается.',
    followFirst: true,
    conditions: { ...BASE, substrateMM: 2, width: 16, height: 10, seedCells: 3, pregrowMin: 30, dropTime: 1, dropAmount: 6, dropX: 0.2, dropY: 0.5, duration: 90 },
  },
  {
    id: 'colony-grows',
    name: 'Колония растёт',
    short: 'Одна бактерия делится снова и снова',
    story:
      'Одна бактерия растёт, удлиняется и делится пополам — каждые 20 минут. Через пару часов получается целая колония. ' +
      'Капни вирусы, когда захочешь: выбери «Капнуть вирусы» и щёлкни по экрану.',
    followFirst: false,
    conditions: { ...BASE, substrateMM: 2, width: 40, height: 27, seedCells: 1, pregrowMin: 0, dropAmount: 0, duration: 300 },
  },
  {
    id: 'attack',
    name: 'Вирусы нападают на колонию',
    short: 'Волна заражения идёт по бактериям',
    story:
      'В середину колонии капнули вирусы. Бактерии лопаются, новые вирусы заражают соседей — и по колонии идёт волна. ' +
      'На её месте остаётся пустое пятно. На чашке Петри такие пятна видно глазом — их называют бляшками.',
    followFirst: false,
    conditions: { ...BASE },
  },
  {
    id: 'resistant',
    name: 'Устойчивые бактерии',
    short: 'Некоторые бактерии вирусу не по зубам',
    story:
      'Среди бактерий есть немного устойчивых (фиолетовых): у них нет «замочка», к которому прицепляется вирус. ' +
      'Волна заражения проходит мимо них, и они продолжают расти.',
    followFirst: false,
    conditions: { ...BASE, pregrowMin: 60, substrateMM: 2, resistantPct: 4 },
  },
];

export function microScenario(id: string): MicroScenario {
  return MICRO_SCENARIOS.find((s) => s.id === id) ?? MICRO_SCENARIOS[0];
}
