/**
 * Параметры модели и переключатели механизмов.
 *
 * Все значения хранятся в одном JSON-пресете (t4-wild-type.json) в «лабораторных»
 * единицах — тех, что видит пользователь. Перевод во внутренние единицы модели
 * (минуты, мл, мкМ) делается в одном месте — в deriveRates().
 */
import preset from './t4-wild-type.json';

export type ParamScale = 'linear' | 'log';

export interface ParamMeta {
  id: string;
  group: string;
  label: string;
  symbol: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  scale: ParamScale;
  range: string;
  description: string;
  sources: string[];
}

export interface MechanismMeta {
  id: string;
  label: string;
  value: boolean;
  description: string;
}

export const PRESET_INFO = preset.preset;
export const PARAM_GROUPS: { id: string; name: string }[] = preset.groups;
export const PARAM_META: ParamMeta[] = preset.parameters as ParamMeta[];
export const MECHANISM_META: MechanismMeta[] = preset.mechanisms;

export type ParamId =
  | 'doublingTime' | 'monodKs' | 'yield' | 'resistanceMutationRate' | 'resistanceCost'
  | 'resistantAdsorption' | 'latentPeriod' | 'lysisSpread' | 'eclipsePeriod' | 'burstSize'
  | 'adsorptionRate' | 'decayRate' | 'rMutationRate' | 'maxBurstLI' | 'liWindow'
  | 'liMaxDuration' | 'sieTime' | 'starvedDevelopmentRate' | 'starvedBurst' | 'q10'
  | 'odPerCell' | 'ghostOd' | 'stochasticThreshold' | 'cellWidth' | 'divisionLength' | 'phageDiffusion';

export type MechanismId =
  | 'lysisInhibition' | 'superinfectionExclusion' | 'resistanceMutations' | 'rMutations'
  | 'substrateDepletion' | 'phageDecay' | 'hostPhysiology';

export type Params = Record<ParamId, number>;
export type Mechanisms = Record<MechanismId, boolean>;

export function defaultParams(): Params {
  const p = {} as Params;
  for (const m of PARAM_META) p[m.id as ParamId] = m.value;
  return p;
}

export function defaultMechanisms(): Mechanisms {
  const m = {} as Mechanisms;
  for (const x of MECHANISM_META) m[x.id as MechanismId] = x.value;
  return m;
}

export function paramMeta(id: ParamId): ParamMeta {
  const m = PARAM_META.find((x) => x.id === id);
  if (!m) throw new Error(`Неизвестный параметр ${id}`);
  return m;
}

/** Ограничение значений границами из пресета: нельзя случайно уйти в нефизичную область. */
export function clampParams(p: Params): Params {
  const out = { ...p };
  for (const m of PARAM_META) {
    const id = m.id as ParamId;
    const v = Number(out[id]);
    out[id] = Number.isFinite(v) ? Math.min(m.max, Math.max(m.min, v)) : m.value;
  }
  return out;
}

/** Скорости во внутренних единицах модели: время — минуты, объём — мл, субстрат — мкМ. */
export interface Rates {
  /** Множитель всех скоростей от температуры (1 при 37 °C). */
  tempFactor: number;
  muMax: number;
  muMaxResistant: number;
  monodKs: number;
  /** Клеток на мкмоль субстрата. */
  yieldPerUmol: number;
  muRes: number;
  alphaR: number;
  latent: number;
  lysisSd: number;
  eclipse: number;
  burst: number;
  /** Скорость накопления потомства после эклипса, частиц на минуту развития. */
  progenyRate: number;
  k: number;
  decay: number;
  muR: number;
  burstMaxLI: number;
  liWindow: number;
  liMaxDuration: number;
  sieTime: number;
  rhoMin: number;
  betaMin: number;
  odPerCell: number;
  ghostOd: number;
  threshold: number;
  cellWidth: number;
  divisionLength: number;
  /** Коэффициент диффузии фага, мкм²/мин. */
  phageDiffusion: number;
}

export function deriveRates(params: Params, temperatureC: number): Rates {
  const p = clampParams(params);
  const tempFactor = Math.pow(p.q10, (temperatureC - 37) / 10);
  const muMax = (Math.LN2 / p.doublingTime) * tempFactor;
  const latent = p.latentPeriod;
  const eclipse = Math.min(p.eclipsePeriod, latent - 0.5);
  return {
    tempFactor,
    muMax,
    muMaxResistant: muMax * (1 - p.resistanceCost / 100),
    monodKs: p.monodKs,
    yieldPerUmol: p.yield,
    muRes: p.resistanceMutationRate,
    alphaR: p.resistantAdsorption / 100,
    latent,
    lysisSd: p.lysisSpread,
    eclipse,
    burst: p.burstSize,
    progenyRate: p.burstSize / (latent - eclipse),
    // Адсорбция — диффузионный процесс, слабо зависит от температуры: берём корень из множителя.
    k: p.adsorptionRate * Math.sqrt(tempFactor),
    decay: p.decayRate / 60,
    muR: p.rMutationRate,
    burstMaxLI: Math.max(p.maxBurstLI, p.burstSize),
    liWindow: p.liWindow,
    liMaxDuration: p.liMaxDuration,
    sieTime: Math.min(p.sieTime, eclipse),
    rhoMin: p.starvedDevelopmentRate / 100,
    betaMin: p.starvedBurst / 100,
    odPerCell: p.odPerCell,
    ghostOd: p.ghostOd / 100,
    threshold: p.stochasticThreshold,
    cellWidth: p.cellWidth,
    divisionLength: p.divisionLength,
    // см²/с → мкм²/мин: ×10⁸ мкм²/см² × 60 с/мин; диффузия слабо зависит от температуры.
    phageDiffusion: p.phageDiffusion * 1e8 * 60,
  };
}

/**
 * Фаговые возрасты и урожаи заданы для 37 °C. Температура ускоряет/замедляет развитие
 * фага так же, как рост хозяина: скорость развития умножается на tempFactor.
 */
export function phageDevelopmentSpeed(rates: Rates, relGrowth: number, physiologyOn: boolean): number {
  const g = physiologyOn ? relGrowth : 1;
  return (rates.rhoMin + (1 - rates.rhoMin) * g) * rates.tempFactor;
}

export function phageBurstQuality(rates: Rates, relGrowth: number, physiologyOn: boolean): number {
  const g = physiologyOn ? relGrowth : 1;
  return rates.betaMin + (1 - rates.betaMin) * g;
}
