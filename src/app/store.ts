/**
 * Состояние приложения: выбранный модуль, параметры модели, механизмы, условия опыта, seed.
 * Сохраняется в браузере между сессиями. Изменения рассылаются подписчикам.
 */
import {
  type Params, type Mechanisms, type ParamId, type MechanismId,
  defaultParams, defaultMechanisms, clampParams, PARAM_META, MECHANISM_META,
} from '../core/params';
import { DEFAULT_FLASK_CONDITIONS, type FlaskConditions } from '../core/flask/model';
import { FLASK_SCENARIOS, flaskScenario } from '../core/flask/scenarios';
import { sanitizeConditions } from '../core/flask/conditions';
import { MICRO_SCENARIOS, microScenario } from '../core/microscope/scenarios';
import { PLATE_SCENARIOS, plateScenario, COMPARE_OPTIONS, type CompareId } from '../core/plate/scenarios';
import { storageGet, storageSet } from '../ui/dom';

export type ModuleId = 'flask' | 'plate' | 'microscope' | 'validation';

export interface AppState {
  module: ModuleId;
  params: Params;
  mechanisms: Mechanisms;
  seed: number;
  flask: { scenarioId: string; conditions: FlaskConditions };
  micro: MicroSettings;
  plate: PlateSettings;
  sidebarCollapsed: boolean;
}

export interface PlateSettings {
  scenarioId: string;
  /** Что выключено на второй чашке в опыте «Почему бляшки перестают расти». */
  compare: CompareId;
  /** Сколько вирусов в капле, которую ставят щелчком. */
  dropSize: number;
  autoPause: boolean;
  hints: boolean;
  /** Условия посева (для взрослых) — поверх сценария. */
  lawnDensity: number;
  lawnDoubling: number;
  substrateMM: number;
  temperature: number;
  platedMl: number;
  gridNodes: number;
}

export const PLATE_DROP_SIZES = [1, 30, 1000, 1e6];

const PLATE_DEFAULTS = {
  lawnDensity: 1e7, lawnDoubling: 45, substrateMM: 5, temperature: 37, platedMl: 0.1, gridNodes: 256,
};

/** Допустимые значения условий посева (для взрослых). */
export const PLATE_LIMITS: Record<keyof typeof PLATE_DEFAULTS, [number, number]> = {
  lawnDensity: [1e5, 1e9],
  lawnDoubling: [20, 180],
  substrateMM: [0.1, 50],
  temperature: [25, 42],
  platedMl: [0.01, 1],
  gridNodes: [128, 1024],
};

export interface MicroSettings {
  scenarioId: string;
  /** Сколько вирусов в капле, которую ученик ставит щелчком. */
  dropSize: number;
  /** Останавливаться на важных моментах, чтобы успеть рассказать. */
  autoPause: boolean;
  /** Показывать подписи-пояснения. */
  hints: boolean;
  /** Как показывать клетки: светящиеся метки (флуоресценция) или обычный (фазово-контрастный) микроскоп. */
  look: MicroLook;
  /** Замедлять опыт до реального времени, когда лопается бактерия, — чтобы увидеть разлёт вирусов. */
  slowMo: boolean;
}

export type MicroLook = 'fluo' | 'phase';

/**
 * Что именно изменилось — от этого зависит, какой опыт перезапускать:
 * model/seed — все модули; flask — только колбу; micro — только микроскоп; microUi — ничего.
 */
export type ChangeKind = 'module' | 'model' | 'seed' | 'layout' | 'flask' | 'micro' | 'microUi' | 'plate' | 'plateUi';

type Listener = (kind: ChangeKind) => void;

const KEY = 't4lab.state.v1';

function initial(): AppState {
  const sc = FLASK_SCENARIOS[0];
  return {
    module: 'microscope',
    params: defaultParams(),
    mechanisms: defaultMechanisms(),
    seed: 20261108,
    flask: { scenarioId: sc.id, conditions: { ...sc.conditions } },
    micro: { scenarioId: MICRO_SCENARIOS[0].id, dropSize: 100, autoPause: true, hints: true, look: 'fluo', slowMo: true },
    plate: { scenarioId: PLATE_SCENARIOS[0].id, compare: COMPARE_OPTIONS[0].id, dropSize: 30, autoPause: true, hints: true, ...PLATE_DEFAULTS },
    sidebarCollapsed: false,
  };
}

function load(): AppState {
  const base = initial();
  const saved = storageGet<Partial<AppState>>(KEY);
  if (!saved) return base;
  // Восстанавливаем только известные ключи, чтобы новая версия пресета не ломалась.
  const params = { ...base.params };
  for (const m of PARAM_META) {
    const v = saved.params?.[m.id as ParamId];
    if (typeof v === 'number' && Number.isFinite(v)) params[m.id as ParamId] = v;
  }
  const mech = { ...base.mechanisms };
  for (const m of MECHANISM_META) {
    const v = saved.mechanisms?.[m.id as MechanismId];
    if (typeof v === 'boolean') mech[m.id as MechanismId] = v;
  }
  // Неизвестный сценарий заменяем первым; условия проверяем и ограничиваем, как и параметры.
  const scId = flaskScenario(typeof saved.flask?.scenarioId === 'string' ? saved.flask.scenarioId : base.flask.scenarioId).id;
  const conditions = sanitizeConditions(saved.flask?.conditions, { ...DEFAULT_FLASK_CONDITIONS, ...flaskScenario(scId).conditions });
  const seed = typeof saved.seed === 'number' && Number.isFinite(saved.seed) && saved.seed >= 0 ? Math.floor(saved.seed) >>> 0 : base.seed;
  return {
    module: saved.module === 'validation' || saved.module === 'flask' || saved.module === 'microscope' || saved.module === 'plate' ? saved.module : base.module,
    params: clampParams(params),
    mechanisms: mech,
    seed,
    flask: { scenarioId: scId, conditions },
    micro: {
      scenarioId: microScenario(typeof saved.micro?.scenarioId === 'string' ? saved.micro.scenarioId : base.micro.scenarioId).id,
      dropSize: [10, 100, 1000].includes(Number(saved.micro?.dropSize)) ? Number(saved.micro?.dropSize) : base.micro.dropSize,
      autoPause: typeof saved.micro?.autoPause === 'boolean' ? saved.micro.autoPause : base.micro.autoPause,
      hints: typeof saved.micro?.hints === 'boolean' ? saved.micro.hints : base.micro.hints,
      look: saved.micro?.look === 'phase' ? 'phase' : 'fluo',
      slowMo: typeof saved.micro?.slowMo === 'boolean' ? saved.micro.slowMo : base.micro.slowMo,
    },
    plate: loadPlate(saved.plate, base.plate),
    sidebarCollapsed: !!saved.sidebarCollapsed,
  };
}

function loadPlate(saved: Partial<PlateSettings> | undefined, base: PlateSettings): PlateSettings {
  const out: PlateSettings = { ...base };
  if (!saved) return out;
  out.scenarioId = plateScenario(typeof saved.scenarioId === 'string' ? saved.scenarioId : base.scenarioId).id;
  if (COMPARE_OPTIONS.some((o) => o.id === saved.compare)) out.compare = saved.compare as CompareId;
  if (PLATE_DROP_SIZES.includes(Number(saved.dropSize))) out.dropSize = Number(saved.dropSize);
  if (typeof saved.autoPause === 'boolean') out.autoPause = saved.autoPause;
  if (typeof saved.hints === 'boolean') out.hints = saved.hints;
  for (const k of Object.keys(PLATE_LIMITS) as (keyof typeof PLATE_LIMITS)[]) {
    const v = Number(saved[k]);
    const [lo, hi] = PLATE_LIMITS[k];
    if (Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v));
  }
  return out;
}

class Store {
  state: AppState = load();
  private listeners: Listener[] = [];

  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== fn);
    };
  }

  private emit(kind: ChangeKind): void {
    storageSet(KEY, this.state);
    for (const l of this.listeners) l(kind);
  }

  setModule(m: ModuleId): void {
    if (this.state.module === m) return;
    this.state.module = m;
    this.emit('module');
  }

  setParam(id: ParamId, value: number): void {
    this.state.params = clampParams({ ...this.state.params, [id]: value });
    this.emit('model');
  }

  resetParams(): void {
    this.state.params = defaultParams();
    this.state.mechanisms = defaultMechanisms();
    this.emit('model');
  }

  setMechanism(id: MechanismId, on: boolean): void {
    this.state.mechanisms = { ...this.state.mechanisms, [id]: on };
    this.emit('model');
  }

  setSeed(seed: number): void {
    this.state.seed = Math.max(0, Math.floor(seed)) >>> 0;
    this.emit('seed');
  }

  chooseFlaskScenario(id: string): void {
    const sc = flaskScenario(id);
    this.state.flask = { scenarioId: sc.id, conditions: { ...sc.conditions } };
    this.emit('flask');
  }

  setFlaskCondition<K extends keyof FlaskConditions>(key: K, value: FlaskConditions[K]): void {
    this.state.flask = { ...this.state.flask, conditions: { ...this.state.flask.conditions, [key]: value } };
    this.emit('flask');
  }

  chooseMicroScenario(id: string): void {
    this.state.micro = { ...this.state.micro, scenarioId: microScenario(id).id };
    this.emit('micro');
  }

  setMicro<K extends Exclude<keyof MicroSettings, 'scenarioId'>>(key: K, value: MicroSettings[K]): void {
    this.state.micro = { ...this.state.micro, [key]: value };
    this.emit('microUi');
  }

  choosePlateScenario(id: string): void {
    this.state.plate = { ...this.state.plate, scenarioId: plateScenario(id).id };
    this.emit('plate');
  }

  /** Изменение, после которого опыт с чашкой начинается заново. */
  setPlate<K extends 'compare' | keyof typeof PLATE_LIMITS>(key: K, value: PlateSettings[K]): void {
    this.state.plate = { ...this.state.plate, [key]: value };
    this.emit('plate');
  }

  resetPlateConditions(): void {
    this.state.plate = { ...this.state.plate, ...PLATE_DEFAULTS };
    this.emit('plate');
  }

  /** Настройки показа — опыт не перезапускается. */
  setPlateUi<K extends 'dropSize' | 'autoPause' | 'hints'>(key: K, value: PlateSettings[K]): void {
    this.state.plate = { ...this.state.plate, [key]: value };
    this.emit('plateUi');
  }

  setSidebarCollapsed(c: boolean): void {
    this.state.sidebarCollapsed = c;
    this.emit('layout');
  }
}

export const store = new Store();
