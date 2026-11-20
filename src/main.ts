/**
 * Виртуальная лаборатория «T4 vs E. coli».
 * Сборка интерфейса: верхняя панель (модули, время, seed), рабочая область, боковая панель.
 * Панель времени управляет опытом того модуля, который сейчас открыт.
 */
import './styles.css';
import { h, toast } from './ui/dom';
import { store, type ModuleId } from './app/store';
import { createFlaskRunner } from './app/flask-runner';
import { createMicroRunner } from './app/micro-runner';
import { createPlateRunner } from './app/plate-runner';
import type { Runner, Steppable } from './app/runner';
import { FlaskView } from './views/flask-view';
import { MicroscopeView } from './views/microscope-view';
import { PlateView } from './views/plate-view';
import { FlaskUi } from './ui/flask-ui';
import { MicroUi } from './ui/micro-ui';
import { PlateUi } from './ui/plate-ui';
import { ValidationPage } from './ui/validation-page';
import { fmtClock, fmtDuration } from './ui/format';
import { icon } from './ui/icons';
import { freshSeed } from './core/rng';
import { flaskScenario } from './core/flask/scenarios';
import { microScenario } from './core/microscope/scenarios';
import { plateScenario } from './core/plate/scenarios';

const root = document.getElementById('app')!;
const flaskRunner = createFlaskRunner();
const microRunner = createMicroRunner();
const plateRunner = createPlateRunner();
let flaskView: FlaskView | null = null;
let microView: MicroscopeView | null = null;
let plateView: PlateView | null = null;

function activeRunner(): Runner<Steppable> | null {
  const m = store.state.module;
  if (m === 'flask') return flaskRunner as unknown as Runner<Steppable>;
  if (m === 'microscope') return microRunner as unknown as Runner<Steppable>;
  if (m === 'plate') return plateRunner as unknown as Runner<Steppable>;
  return null;
}

// ---------------------------------------------------------------- верхняя панель

const moduleTabs: Record<ModuleId, HTMLButtonElement> = {
  microscope: h('button', { class: 'tab', onclick: () => store.setModule('microscope') }, 'Микроскоп'),
  flask: h('button', { class: 'tab', onclick: () => store.setModule('flask') }, 'Колба'),
  plate: h('button', { class: 'tab', onclick: () => store.setModule('plate') }, 'Чашка Петри'),
  validation: h('button', { class: 'tab', onclick: () => store.setModule('validation') }, 'Проверка модели'),
};

const playBtn = h('button', { class: 'btn primary', onclick: () => activeRunner()?.toggle(), title: 'Пуск / пауза (пробел)' }, icon('play'), 'Пуск');
const stepBtn = h('button', { class: 'btn icon', onclick: () => activeRunner()?.stepOnce(), title: 'Шаг: +1 минута' }, icon('step'));
const resetBtn = h('button', { class: 'btn icon', onclick: () => activeRunner()?.reset(), title: 'Начать опыт заново' }, icon('reset'));

const speedInput = h('input', { type: 'range', min: 0, max: 300, step: 1, value: '0', 'aria-label': 'Скорость' });
const speedOut = h('output', {});
function niceSpeed(v: number): number {
  const nice = v < 10 ? Math.round(v) : v < 100 ? Math.round(v / 5) * 5 : Math.round(v / 50) * 50;
  return Math.max(1, Math.min(1000, nice));
}
function showSpeed(r: Runner<Steppable>): void {
  speedInput.value = String(Math.round(Math.log10(r.speed) * 100));
  speedOut.textContent = `×${r.speed}`;
  speedOut.title = `1 секунда на экране = ${fmtDuration(r.speed / 60) === '0 мин' ? `${r.speed} с` : fmtDuration(r.speed / 60)} опыта`;
}
speedInput.addEventListener('input', () => {
  const r = activeRunner();
  if (!r) return;
  r.speed = niceSpeed(Math.pow(10, Number(speedInput.value) / 100));
  showSpeed(r);
});

const untilInput = h('input', { type: 'number', min: 0, step: 0.5, value: '', placeholder: 'ч', 'aria-label': 'Перемотать до, ч' });
const untilBtn = h('button', {
  class: 'btn small',
  title: 'Быстро перемотать опыт до указанного времени (пусто — до конца)',
  onclick: () => {
    const r = activeRunner();
    if (!r) return;
    const hours = Number(String(untilInput.value).replace(',', '.'));
    const target = untilInput.value === '' ? r.model.duration : hours * 60;
    if (!(target > r.model.t)) {
      toast('Укажите время больше текущего');
      return;
    }
    r.runUntil(target);
  },
}, icon('forward', 14));

const clock = h('div', { class: 'clock' }, fmtClock(0));
const seedInput = h('input', { type: 'text', value: String(store.state.seed), 'aria-label': 'Seed', spellcheck: false });
seedInput.addEventListener('change', () => {
  const raw = seedInput.value.trim();
  const v = raw === '' ? NaN : Number(raw);
  if (Number.isFinite(v) && v >= 0) store.setSeed(v);
  else seedInput.value = String(store.state.seed);
});
const seedBtn = h('button', { class: 'btn small', title: 'Новый случайный seed', onclick: () => store.setSeed(freshSeed()) }, icon('dice', 14));

const timebar = h('div', { class: 'timebar' },
  clock,
  playBtn, stepBtn, resetBtn,
  h('div', { class: 'speed' }, 'скорость', speedInput, speedOut),
  h('div', { class: 'until' }, 'до', untilInput, 'ч', untilBtn),
  h('div', { class: 'seedbox' }, 'seed', seedInput, seedBtn),
);

const topbar = h('header', { class: 'topbar' },
  h('div', { class: 'brand' }, h('b', {}, 'T4 vs ', h('i', {}, 'E. coli')), h('span', {}, 'как вирусы заражают бактерии')),
  h('nav', { class: 'tabs' }, Object.values(moduleTabs)),
  timebar,
);

// ---------------------------------------------------------------- рабочая область

const workspace = h('div', { class: 'workspace' });
const flaskHost = h('div', { style: 'position:absolute;inset:0' });
const microHost = h('div', { style: 'position:absolute;inset:0' });
const plateHost = h('div', { style: 'position:absolute;inset:0' });
const collapseBtn = h('button', {
  class: 'btn small',
  title: 'Скрыть/показать боковую панель (F)',
  onclick: () => store.setSidebarCollapsed(!store.state.sidebarCollapsed),
}, icon('panel', 14), 'Панель');
const fullscreenBtn = h('button', {
  class: 'btn small',
  title: 'Во весь экран — для показа на проекторе',
  onclick: () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else {
      store.setSidebarCollapsed(true);
      document.documentElement.requestFullscreen?.().catch(() => {});
    }
  },
}, icon('fullscreen', 14), 'Весь экран');
const overlayBtns = h('div', { class: 'ws-overlay-btns' }, collapseBtn, fullscreenBtn);
workspace.append(flaskHost, microHost, plateHost, overlayBtns);

const flaskUi = new FlaskUi(flaskRunner, () => flaskView);
const microUi = new MicroUi(microRunner, () => microView);
const plateUi = new PlateUi(plateRunner, () => plateView);
const validationPage = new ValidationPage();
microUi.onSpeed = () => {
  if (activeRunner() === (microRunner as unknown as Runner<Steppable>)) showSpeed(microRunner as unknown as Runner<Steppable>);
};
const main = h('div', { class: 'main' }, workspace, flaskUi.el, microUi.el, plateUi.el);
root.append(topbar, main);

// ---------------------------------------------------------------- синхронизация

function applyModule(): void {
  const m = store.state.module;
  for (const [k, b] of Object.entries(moduleTabs)) b.classList.toggle('active', k === m);
  const isFlask = m === 'flask';
  const isMicro = m === 'microscope';
  const isPlate = m === 'plate';
  const isSim = isFlask || isMicro || isPlate;
  timebar.style.visibility = isSim ? 'visible' : 'hidden';
  overlayBtns.style.display = isSim ? '' : 'none';
  if (!isFlask) flaskRunner.pause();
  if (!isMicro) microRunner.pause();
  if (!isPlate) plateRunner.pause();
  flaskRunner.active = isFlask;
  microRunner.active = isMicro;
  plateRunner.active = isPlate;
  flaskHost.style.display = isFlask ? 'block' : 'none';
  microHost.style.display = isMicro ? 'block' : 'none';
  plateHost.style.display = isPlate ? 'block' : 'none';
  flaskUi.el.style.display = isFlask ? '' : 'none';
  microUi.el.style.display = isMicro ? '' : 'none';
  plateUi.el.style.display = isPlate ? '' : 'none';
  flaskView?.setVisible(isFlask);
  microView?.setVisible(isMicro);
  plateView?.setVisible(isPlate);
  if (isSim) {
    if (validationPage.el.parentElement) validationPage.el.remove();
    main.classList.toggle('collapsed', store.state.sidebarCollapsed);
    showSpeed(activeRunner()!);
  } else {
    main.classList.add('collapsed');
    workspace.append(validationPage.el);
  }
  updateStatus();
}

function updateStatus(): void {
  const r = activeRunner();
  if (!r) return;
  playBtn.replaceChildren(
    ...(r.running ? [icon('pause'), 'Пауза'] : r.model.done ? [icon('reset'), 'Заново'] : [icon('play'), 'Пуск']),
  );
  stepBtn.disabled = r.model.done;
  clock.textContent = fmtClock(r.model.t);
}

for (const r of [flaskRunner, microRunner, plateRunner] as unknown as Runner<Steppable>[]) {
  r.on((e) => {
    if (r !== activeRunner()) return;
    if (e === 'status' || e === 'reset' || e === 'finished') updateStatus();
    clock.textContent = fmtClock(r.model.t);
  });
}

store.subscribe((kind) => {
  if (kind === 'model' || kind === 'seed') {
    seedInput.value = String(store.state.seed);
    flaskRunner.reset();
    microRunner.reset();
    plateRunner.reset();
  }
  if (kind === 'plate') plateRunner.reset();
  if (kind === 'flask') flaskRunner.reset();
  if (kind === 'micro') microRunner.reset();
  if (kind === 'microUi') microView?.setLook(store.state.micro.look);
  if (kind === 'module') applyModule();
  if (kind === 'layout') main.classList.toggle('collapsed', store.state.sidebarCollapsed);
});

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const r = activeRunner();
  if (!r) return;
  // Ctrl+F, Cmd+F и прочие сочетания принадлежат браузеру.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') {
    // Пробел на кнопке или ссылке в фокусе нажимает её саму — не перехватываем.
    if (t && (t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'SUMMARY')) return;
    e.preventDefault();
    r.toggle();
  } else if (e.key === 'f' || e.key === 'а') {
    store.setSidebarCollapsed(!store.state.sidebarCollapsed);
  } else if (e.key === 'Escape' && microView?.dropMode) {
    microView.dropMode = false;
  } else if (e.key === 'Escape' && plateView && store.state.module === 'plate') {
    if (plateView.mode === 'drop') plateView.mode = 'none';
    else plateView.showAll();
  }
});

main.classList.toggle('collapsed', store.state.sidebarCollapsed);
applyModule();

const webglError = (host: HTMLElement) => (err: unknown) => {
  console.error(err);
  host.append(h('div', { class: 'placeholder' },
    'Не удалось запустить WebGL-отрисовку. Обновите браузер или включите аппаратное ускорение.'));
};

FlaskView.create(flaskHost, flaskRunner)
  .then((v) => {
    flaskView = v;
    v.scenarioName = flaskScenario(store.state.flask.scenarioId).name;
    v.resetScene();
    // Дальнейшие сбросы сцены делает FlaskUi.onReset (по событию 'reset').
    v.setVisible(store.state.module === 'flask');
  })
  .catch(webglError(flaskHost));

MicroscopeView.create(microHost, microRunner)
  .then((v) => {
    microView = v;
    v.scenarioName = microScenario(store.state.micro.scenarioId).name;
    v.setLook(store.state.micro.look);
    v.resetScene();
    v.onClick = (c) => microUi.handleClick(c.x, c.y, c.cell);
    v.setVisible(store.state.module === 'microscope');
  })
  .catch(webglError(microHost));

PlateView.create(plateHost, plateRunner)
  .then((v) => {
    plateView = v;
    v.scenarioName = plateScenario(store.state.plate.scenarioId).name;
    v.resetScene();
    v.mode = plateScenario(store.state.plate.scenarioId).counting ? 'count' : 'none';
    v.onClick = (c) => plateUi.handleClick(c.plate, c.x, c.y);
    v.onCamera = () => plateUi.updateCount();
    v.setVisible(store.state.module === 'plate');
  })
  .catch(webglError(plateHost));
