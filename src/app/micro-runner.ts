/** Контроллер времени для микроскопа. */
import { MicroscopeModel } from '../core/microscope/model';
import { microScenario } from '../core/microscope/scenarios';
import { Runner } from './runner';
import { store } from './store';

export type MicroRunner = Runner<MicroscopeModel>;

export function createMicroRunner(): MicroRunner {
  // 60× — «одна секунда на экране = одна минута опыта»: бактерия лопается примерно за 25 секунд.
  return new Runner(() => {
    const s = store.state;
    return new MicroscopeModel(s.params, s.mechanisms, microScenario(s.micro.scenarioId).conditions, s.seed);
  }, { speed: 60, stepMinutes: 1 });
}
