/** Контроллер времени для колбы: модель создаётся из текущего состояния приложения. */
import { FlaskModel } from '../core/flask/model';
import { Runner } from './runner';
import { store } from './store';

export type FlaskRunner = Runner<FlaskModel>;

export function createFlaskRunner(): FlaskRunner {
  return new Runner(() => {
    const s = store.state;
    return new FlaskModel(s.params, s.mechanisms, s.flask.conditions, s.seed);
  }, { speed: 300, stepMinutes: 1 });
}
