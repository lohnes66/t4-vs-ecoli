/** Раздел «Проверка модели»: таблица литературных проверок с кнопкой «прогнать все тесты». */
import { h, clear, download, stamp } from './dom';
import { icon } from './icons';
import { store } from '../app/store';
import { VALIDATION_TESTS, type ValidationResult } from '../core/validation/suite';
import { defaultParams, defaultMechanisms, type Params, type Mechanisms } from '../core/params';
import { joinCsv, csvRow, describeModel } from '../core/export/csv';

type Status = { state: 'wait' | 'run' | 'done' | 'pending'; result?: ValidationResult; ms?: number };

/** С чем именно прогонялись тесты — это и пишется в шапку CSV, а не текущее состояние формы. */
interface RunContext {
  usePreset: boolean;
  params: Params;
  mechanisms: Mechanisms;
  seed: number;
}

export class ValidationPage {
  readonly el: HTMLElement;
  private statuses = new Map<string, Status>();
  private tbody = h('tbody', {});
  private usePreset = true;
  private running = false;
  private lastRun: RunContext | null = null;
  private runBtn: HTMLButtonElement;
  private summary = h('span', { class: 'hint' });

  constructor() {
    for (const t of VALIDATION_TESTS) this.statuses.set(t.id, { state: t.run ? 'wait' : 'pending' });
    const presetCb = h('input', { type: 'checkbox', checked: true });
    presetCb.addEventListener('change', () => (this.usePreset = presetCb.checked));
    this.runBtn = h('button', { class: 'btn primary', onclick: () => this.runAll() }, icon('play'), 'Прогнать все тесты');
    this.el = h('div', { class: 'validation' },
      h('h2', {}, 'Проверка модели'),
      h('p', {},
        'Модель считается состоятельной, только если воспроизводит известные из литературы результаты. ',
        'Каждая проверка ставит настоящий опыт в модели и обрабатывает его так же, как экспериментатор — по титру и оптической плотности. ',
        'Эта таблица — готовый раздел «Проверка модели» для проектной работы.'),
      h('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' },
        this.runBtn,
        h('label', { class: 'hint', style: 'display:flex;gap:6px;align-items:center' }, presetCb, 'на пресете «T4 дикого типа» со всеми механизмами (снимите, чтобы проверить текущие параметры)'),
        h('button', { class: 'btn', onclick: () => this.exportCsv() }, icon('download', 14), 'Результаты (CSV)'),
        this.summary,
      ),
      h('table', { class: 'vtable' },
        h('thead', {}, h('tr', {}, ...['Проверка', 'Модуль', 'Что должно получиться', 'Критерий', 'Результат', 'Статус'].map((x) => h('th', {}, x)))),
        this.tbody,
      ),
      h('p', { style: 'margin-top:18px' },
        'Последние две проверки — о корректности вычислений, а не о биологии: сходимость по сетке и воспроизводимость по seed.'),
    );
    this.renderRows();
  }

  private renderRows(): void {
    clear(this.tbody);
    let ok = 0;
    let fail = 0;
    for (const t of VALIDATION_TESTS) {
      const st = this.statuses.get(t.id)!;
      let badge: HTMLElement;
      if (st.state === 'pending') badge = h('span', { class: 'badge wait' }, t.pendingNote ?? 'позже');
      else if (st.state === 'wait') badge = h('span', { class: 'badge wait' }, 'не запускалась');
      else if (st.state === 'run') badge = h('span', { class: 'badge run' }, 'идёт…');
      else if (st.result?.passed) {
        badge = h('span', { class: 'badge ok' }, '✓ пройдена');
        ok++;
      } else {
        badge = h('span', { class: 'badge fail' }, '✗ не пройдена');
        fail++;
      }
      this.tbody.append(h('tr', {},
        h('td', {}, h('b', {}, t.name)),
        h('td', { class: 'hint' }, t.module),
        h('td', {}, t.expected),
        h('td', {}, t.criterion),
        h('td', { class: 'res' }, st.result ? st.result.value : '', st.result?.details ? h('div', { class: 'hint' }, st.result.details) : null),
        h('td', {}, badge),
      ));
    }
    const done = ok + fail;
    this.summary.textContent = done ? `пройдено ${ok} из ${done}` : '';
  }

  async runAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.runBtn.disabled = true;
    const ctx = this.currentContext();
    this.lastRun = ctx;
    for (const t of VALIDATION_TESTS) {
      if (!t.run) continue;
      this.statuses.set(t.id, { state: 'run' });
      this.renderRows();
      await new Promise((r) => setTimeout(r, 30)); // дать браузеру перерисовать таблицу
      const t0 = performance.now();
      let result: ValidationResult;
      try {
        result = t.run(ctx);
      } catch (e) {
        result = { passed: false, value: `ошибка: ${(e as Error).message}` };
      }
      this.statuses.set(t.id, { state: 'done', result, ms: performance.now() - t0 });
      this.renderRows();
    }
    this.running = false;
    this.runBtn.disabled = false;
  }

  private currentContext(): RunContext {
    const s = store.state;
    return this.usePreset
      ? { usePreset: true, params: defaultParams(), mechanisms: defaultMechanisms(), seed: s.seed }
      : { usePreset: false, params: { ...s.params }, mechanisms: { ...s.mechanisms }, seed: s.seed };
  }

  private exportCsv(): void {
    // Если тесты уже прогонялись — описываем модель того прогона; иначе (таблица пустая) — текущие настройки.
    const ctx = this.lastRun ?? this.currentContext();
    const rows = describeModel({
      title: 'Виртуальная лаборатория «T4 vs E. coli» — проверка модели',
      scenario: ctx.usePreset ? 'пресет «T4 дикого типа», все механизмы' : 'текущие параметры',
      seed: ctx.seed,
      conditions: [],
      params: ctx.params,
      mechanisms: ctx.mechanisms,
    });
    rows.push(csvRow(['Проверка', 'Модуль', 'Что должно получиться', 'Критерий', 'Результат', 'Подробности', 'Статус']));
    for (const t of VALIDATION_TESTS) {
      const st = this.statuses.get(t.id)!;
      const status = st.state === 'pending' ? t.pendingNote ?? '' : st.state === 'done' ? (st.result?.passed ? 'пройдена' : 'не пройдена') : 'не запускалась';
      rows.push(csvRow([t.name, t.module, t.expected, t.criterion, st.result?.value ?? '', st.result?.details ?? '', status]));
    }
    download(`проверка_модели_${stamp()}.csv`, joinCsv(rows), 'text/csv;charset=utf-8');
  }
}
