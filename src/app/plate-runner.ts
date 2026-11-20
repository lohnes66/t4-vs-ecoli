/** Контроллер времени для чашки Петри. */
import { PlateModel } from '../core/plate/model';
import { plateScenario } from '../core/plate/scenarios';
import { Runner } from './runner';
import { store } from './store';

export type PlateRunner = Runner<PlateModel>;

export function plateConditions() {
  const s = store.state.plate;
  const sc = plateScenario(s.scenarioId);
  return {
    ...sc.build(s.compare),
    lawnDensity: s.lawnDensity,
    lawnDoubling: s.lawnDoubling,
    substrateMM: s.substrateMM,
    temperature: s.temperature,
    platedMl: s.platedMl,
    gridNodes: Math.round(s.gridNodes),
  };
}

export function createPlateRunner(): PlateRunner {
  // 600× — «одна секунда на экране = 10 минут опыта»: ночь инкубации (16 ч) проходит за полторы минуты.
  return new Runner(() => new PlateModel(store.state.params, store.state.mechanisms, plateConditions(), store.state.seed), {
    speed: 600,
    stepMinutes: 10,
  });
}
