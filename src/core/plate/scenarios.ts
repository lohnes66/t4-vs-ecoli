/** Сценарии чашки Петри. Названия и описания — простым языком: программой пользуется ученик. */
import { DEFAULT_PLATE_CONDITIONS, type PlateConditions, type PlateSpec } from './model';

/** Что выключить на второй чашке в опыте «Почему бляшки перестают расти». */
export type CompareId = 'lysisInhibition' | 'substrateDepletion' | 'hostPhysiology' | 'diffusion';

export const COMPARE_OPTIONS: { id: CompareId; label: string; plate: string; hint: string }[] = [
  {
    id: 'substrateDepletion', label: 'Еда не кончается', plate: 'еды хватает',
    hint: 'На правой чашке питание в агаре не кончается: бактерии растут всё время. Проверим, остановятся ли бляшки.',
  },
  {
    id: 'hostPhysiology', label: 'Голодные бактерии', plate: 'голод не мешает',
    hint: 'На правой чашке вирус размножается в голодной бактерии так же быстро, как в сытой. Это «понарошку» — в жизни так не бывает.',
  },
  {
    id: 'lysisInhibition', label: 'Торможение лизиса', plate: 'без торможения',
    hint: 'На правой чашке заражённые бактерии не откладывают момент, когда лопнут, даже если на них сели новые вирусы.',
  },
  {
    id: 'diffusion', label: 'Жидкий агар', plate: 'агар жиже',
    hint: 'На правой чашке агар жиже, и вирусы расплываются в нём в 4 раза быстрее.',
  },
];

export interface PlateScenario {
  id: string;
  name: string;
  short: string;
  story: string;
  /** Опыт со счётом бляшек (титрование). */
  counting: boolean;
  /** Показывать график роста бляшек. */
  kinetics: boolean;
  /** В опыте выбирают, какой механизм выключить на второй чашке. */
  compare: boolean;
  /** Пустая чашка — вирусы капают щелчком. */
  dropsOnly: boolean;
  build: (compare: CompareId) => PlateConditions;
}

const base = DEFAULT_PLATE_CONDITIONS;
const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
/** Подпись разведения: «10⁻⁶». */
export const dil = (d: number): string => `10${String(-d).split('').map((c) => SUP[c] ?? c).join('')}`;

export const PLATE_SCENARIOS: PlateScenario[] = [
  {
    id: 'plaques',
    name: 'Бляшки на газоне',
    short: 'Как вирусы проедают дырки в слое бактерий',
    story:
      'В тёплый мягкий агар добавили бактерии и совсем немного вирусов и вылили на чашку. Бактерии размножаются, и агар мутнеет — ' +
      'получается «газон». А там, где вирус заразил первую бактерию, появляется прозрачное пятно — бляшка.',
    counting: false, kinetics: true, compare: false, dropsOnly: false,
    build: () => ({ ...base, plates: [{ label: dil(7), dilution: 7, rFractionPct: 0 }] }),
  },
  {
    id: 'titration',
    name: 'Сколько вирусов в пробирке?',
    short: 'Разводим, сеем и считаем бляшки',
    story:
      'В пробирке неизвестно сколько вирусов — так много, что их не сосчитать. Поэтому пробу разводят в 10 раз, ещё в 10 раз и так далее ' +
      'и сеют каждое разведение на свою чашку. Каждая бляшка выросла из одного вируса. Найди чашку, где бляшки можно сосчитать, ' +
      'и пощёлкай по ним — компьютер будет вести счёт.',
    counting: true, kinetics: false, compare: false, dropsOnly: false,
    build: () => ({
      ...base,
      stockTiter: 0,
      plates: [3, 4, 5, 6, 7, 8].map((d) => ({ label: dil(d), dilution: d, rFractionPct: 0 })),
    }),
  },
  {
    id: 'wt-vs-r',
    name: 'Обычный вирус и мутант',
    short: 'Мелкие мутные бляшки против крупных прозрачных',
    story:
      'Слева — обычный вирус T4, справа — его мутант (r-мутант). У мутанта сломан «тормоз»: заражённая им бактерия всегда лопается вовремя. ' +
      'Сравни бляшки: какие крупнее и у каких край чётче?',
    counting: false, kinetics: true, compare: false, dropsOnly: false,
    build: () => ({
      ...base,
      sameLayout: true,
      plates: [
        { label: 'обычный T4', dilution: 7, rFractionPct: 0 },
        { label: 'r-мутант', dilution: 7, rFractionPct: 100 },
      ],
    }),
  },
  {
    id: 'why-stop',
    name: 'Почему бляшки перестают расти?',
    short: 'Две чашки: как обычно и «понарошку»',
    story:
      'Бляшки растут несколько часов, а потом останавливаются. Почему? Проверим, как настоящие учёные: на левой чашке всё как обычно, ' +
      'а на правой мы «выключаем» одну причину. Если бляшки на правой чашке не остановятся — значит, причина найдена.',
    counting: false, kinetics: true, compare: true, dropsOnly: false,
    build: (cmp) => {
      const opt = COMPARE_OPTIONS.find((o) => o.id === cmp) ?? COMPARE_OPTIONS[0];
      const right: PlateSpec = { label: opt.plate, dilution: 7, rFractionPct: 0 };
      if (cmp === 'diffusion') right.diffusionFactor = 4;
      else right.mech = { [cmp]: false };
      return { ...base, sameLayout: true, plates: [{ label: 'как обычно', dilution: 7, rFractionPct: 0 }, right] };
    },
  },
  {
    id: 'drops',
    name: 'Капни сам',
    short: 'Пустая чашка — вирусы капаешь ты',
    story:
      'На чашке только бактерии. Выбери, сколько вирусов в капле, и щёлкни по чашке. Попробуй капнуть сразу, через 3 часа и через 6 часов — ' +
      'что получится? А что будет, если капнуть очень много вирусов сразу?',
    counting: false, kinetics: false, compare: false, dropsOnly: true,
    build: () => ({ ...base, plates: [{ label: 'газон', dilution: 30, rFractionPct: 0 }] }),
  },
];

export function plateScenario(id: string): PlateScenario {
  return PLATE_SCENARIOS.find((s) => s.id === id) ?? PLATE_SCENARIOS[0];
}
