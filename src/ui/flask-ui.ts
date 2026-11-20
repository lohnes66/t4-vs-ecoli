/** Боковая панель модуля «Колба»: приборы, условия опыта, модель, данные. */
import { h, clear, download, stamp, toast } from './dom';
import { numberField } from './fields';
import { infoIcon } from './tooltip';
import { TimeChart, type ChartSeriesDef } from './charts';
import { fmtSci, fmtFixed, fmtDuration } from './format';
import { renderModelPanel } from './model-panel';
import { CSS_COLORS } from '../views/palette';
import { store } from '../app/store';
import type { FlaskRunner } from '../app/flask-runner';
import type { FlaskView } from '../views/flask-view';
import { FLASK_SCENARIOS, flaskScenario, type FlaskAnalysisKind } from '../core/flask/scenarios';
import { FLASK_CONDITION_META, flaskConditionRows } from '../core/flask/conditions';
import {
  analyzeOneStep, analyzeLysis, oneStepMeasurements, lysisMeasurements, type Measurement,
} from '../core/flask/analysis';
import type { FlaskModel } from '../core/flask/model';
import { describeModel, timeSeriesTable, joinCsv, csvRow } from '../core/export/csv';
import { VideoRecorder } from './recorder';
import { icon } from './icons';

type SideTab = 'instruments' | 'experiment' | 'model' | 'data';

interface PopSeries extends ChartSeriesDef {
  key: 'S' | 'I' | 'LI' | 'R' | 'P' | 'Pr' | 'titer' | 'titerChloroform';
}

function popSeries(kind: FlaskAnalysisKind): PopSeries[] {
  const oneStep = kind === 'oneStep';
  return [
    { key: 'S', label: 'S', color: CSS_COLORS.S, hidden: oneStep },
    { key: 'I', label: 'I', color: CSS_COLORS.I, hidden: oneStep },
    { key: 'LI', label: 'I торм.', color: CSS_COLORS.LI, hidden: true, dash: [4, 3] },
    { key: 'R', label: 'R', color: CSS_COLORS.R, hidden: oneStep },
    { key: 'P', label: 'P', color: CSS_COLORS.P },
    { key: 'Pr', label: 'P r-мут.', color: CSS_COLORS.Pr, hidden: kind !== 'competition', dash: [5, 3] },
    { key: 'titer', label: 'Титр', color: CSS_COLORS.titer, hidden: !oneStep, width: 2 },
    { key: 'titerChloroform', label: 'С хлороформом', color: '#f2c879', hidden: !oneStep, dash: [5, 3] },
  ];
}

export class FlaskUi {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabs: Record<SideTab, HTMLButtonElement>;
  private tab: SideTab = 'instruments';
  private openGroups = new Set<string>(['phage']);

  // приборы
  private instruments: HTMLElement;
  private readoutEls: Record<string, HTMLElement> = {};
  private odChart!: TimeChart;
  private popChart!: TimeChart;
  private pops: PopSeries[] = [];
  private resultsEl = h('div', { class: 'results' });
  private popSlot = h('div', {});
  private logEl = h('div', { class: 'eventlog' });
  private lastUiUpdate = 0;
  private recorder: VideoRecorder;
  /** Сколько записей протокола уже выведено и для какой модели — чтобы дописывать только новые. */
  private logModel: FlaskModel | null = null;
  private logCount = 0;
  /** Для какой модели и в каком состоянии (завершена или нет) нарисована таблица результатов. */
  private resultsModel: FlaskModel | null = null;
  private resultsDone = false;
  private renderPending = false;

  constructor(private runner: FlaskRunner, private view: () => FlaskView | null) {
    const mk = (id: SideTab, label: string) =>
      h('button', { class: 'sidetab', onclick: () => this.setTab(id) }, label);
    this.tabs = {
      instruments: mk('instruments', 'Приборы'),
      experiment: mk('experiment', 'Опыт'),
      model: mk('model', 'Модель'),
      data: mk('data', 'Данные'),
    };
    this.body = h('div', { class: 'sidebody' });
    this.el = h('aside', { class: 'sidebar' }, h('nav', { class: 'sidetabs' }, Object.values(this.tabs)), this.body);
    this.instruments = this.buildInstruments();
    this.recorder = new VideoRecorder(() => this.view()?.canvas ?? null);

    runner.on((e) => {
      if (e === 'reset') this.onReset();
      if (e === 'tick') this.onTick(false);
      // Перемотка может закончиться раньше очередного обновления — по смене статуса обновляем принудительно.
      if (e === 'finished' || e === 'status') this.onTick(true);
    });
    store.subscribe((kind) => {
      if (kind === 'model' || kind === 'seed' || kind === 'flask') {
        if (this.tab !== 'instruments') this.scheduleRender();
      }
    });
    this.setTab('instruments');
    this.onReset();
  }

  setTab(t: SideTab): void {
    this.tab = t;
    for (const [k, b] of Object.entries(this.tabs)) b.classList.toggle('active', k === t);
    this.render();
  }

  /**
   * Перерисовка после изменения поля откладывается до конца текущего события: при уходе из поля по Tab
   * событие change приходит раньше, чем фокус переходит в следующее поле. Отложив перерисовку,
   * мы знаем, куда ушёл фокус, и возвращаем его в то же поле новой разметки.
   */
  private scheduleRender(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    setTimeout(() => {
      this.renderPending = false;
      if (this.tab !== 'instruments') this.render();
    }, 0);
  }

  private render(): void {
    const scroll = this.body.scrollTop;
    const active = document.activeElement as HTMLElement | null;
    const fkey = active && this.body.contains(active) ? active.getAttribute('data-fkey') : null;
    clear(this.body);
    if (this.tab === 'instruments') this.body.append(this.instruments);
    else if (this.tab === 'experiment') this.body.append(this.renderExperiment());
    else if (this.tab === 'model') this.body.append(renderModelPanel(this.openGroups));
    else this.body.append(this.renderData());
    this.body.scrollTop = scroll;
    if (fkey) {
      const el = Array.from(this.body.querySelectorAll<HTMLElement>('[data-fkey]')).find((x) => x.getAttribute('data-fkey') === fkey);
      if (el) {
        el.focus({ preventScroll: true });
        if (el instanceof HTMLInputElement && el.type === 'text') el.select();
      }
    }
  }

  // ------------------------------------------------------------------ приборы

  private buildInstruments(): HTMLElement {
    const ro = (key: string, label: string, color: string | null, unit: string, tip: string) => {
      const v = h('span', {}, '—');
      this.readoutEls[key] = v;
      return h('div', { class: 'readout' },
        h('div', { class: 'k' }, color ? h('span', { class: 'dot', style: `background:${color}` }) : null, label, infoIcon({ title: label, body: tip })),
        h('div', { class: 'v' }, v, h('span', { class: 'u' }, unit)),
      );
    };
    this.odChart = new TimeChart({ title: 'Оптическая плотность OD₆₀₀', series: [{ label: 'OD₆₀₀', color: CSS_COLORS.od, width: 2 }], log: false, height: 170 });
    this.popChart = new TimeChart({ title: 'Численности, на 1 мл (лог. шкала)', series: popSeries('lysis'), log: true, height: 230 });
    return h('div', {},
      h('div', { class: 'section' },
        h('h3', {}, 'Показания'),
        h('div', { class: 'readouts' },
          ro('od', 'OD₆₀₀', CSS_COLORS.od, '', 'Оптическая плотность культуры при 600 нм — мера мутности. Пересчитывается из числа целых клеток и обломков.'),
          ro('S', 'Чувствительные S', CSS_COLORS.S, 'КОЕ/мл', 'Клетки, которые фаг может заразить.'),
          ro('I', 'Заражённые I', CSS_COLORS.I, '/мл', 'Клетки, внутри которых развивается фаг (включая клетки с торможением лизиса).'),
          ro('LI', 'Торможение лизиса', CSS_COLORS.LI, '/мл', 'Заражённые клетки, лизис которых задержан повторной адсорбцией фага.'),
          ro('R', 'Устойчивые R', CSS_COLORS.R, 'КОЕ/мл', 'Мутанты OmpC⁻, на которые фаг не адсорбируется.'),
          ro('P', 'Свободный фаг P', CSS_COLORS.P, 'БОЕ/мл', 'Свободные фаговые частицы в среде.'),
          ro('titer', 'Титр (бляшки)', CSS_COLORS.titer, 'БОЕ/мл', 'Что покажет посев на газон: свободный фаг плюс инфекционные центры (каждая заражённая клетка даёт одну бляшку).'),
          ro('N', 'Глюкоза', CSS_COLORS.N, '', 'Остаток лимитирующего субстрата в среде.'),
        ),
      ),
      h('div', { class: 'section' }, this.odChart.el),
      h('div', { class: 'section' }, this.popSlot,
        h('div', { class: 'hint', style: 'margin-top:4px' }, 'Щелчок по названию ряда в легенде скрывает или показывает его.')),
      h('div', { class: 'section' }, h('h3', {}, 'Результаты опыта'), h('div', { class: 'card' }, this.resultsEl)),
      h('div', { class: 'section' }, h('h3', {}, 'Протокол'), this.logEl),
    );
  }

  private onReset(): void {
    const sc = flaskScenario(store.state.flask.scenarioId);
    this.pops = popSeries(sc.analysis);
    this.popChart.destroy();
    this.popChart = new TimeChart({ title: 'Численности, на 1 мл (лог. шкала)', series: this.pops, log: true, height: 230 });
    this.popSlot.replaceChildren(this.popChart.el);
    const v = this.view();
    if (v) {
      v.scenarioName = sc.name;
      v.resetScene();
    }
    this.logModel = null;
    this.resultsModel = null;
    this.onTick(true);
  }

  private onTick(force: boolean): void {
    const now = performance.now();
    if (!force && now - this.lastUiUpdate < 160) return;
    this.lastUiUpdate = now;
    const m = this.runner.model;
    const s = m.snapshot();
    const r = this.readoutEls;
    r.od.textContent = fmtFixed(s.od, 3);
    r.S.textContent = fmtSci(s.S);
    r.I.textContent = fmtSci(s.I);
    r.LI.textContent = fmtSci(s.LI);
    r.R.textContent = fmtSci(s.R);
    r.P.textContent = fmtSci(s.P);
    r.titer.textContent = fmtSci(s.titer);
    r.N.textContent = s.N >= 1000 ? `${fmtFixed(s.N / 1000, 2)} мМ` : `${fmtFixed(s.N, 1)} мкМ`;

    const se = m.series;
    const dur = m.cond.duration;
    this.odChart.setData(se.t, [se.od], dur);
    this.popChart.setData(se.t, this.pops.map((p) => se[p.key]), dur);
    this.odChart.setNote(fmtDuration(m.t));

    this.renderResults(m);
    this.renderLog(m);
  }

  /** Протокол только пополняется, поэтому дописываем новые записи, а не пересобираем весь список. */
  private renderLog(m: FlaskModel): void {
    if (this.logModel !== m || m.log.length < this.logCount) {
      this.logModel = m;
      this.logCount = 0;
      clear(this.logEl);
    }
    if (m.log.length === this.logCount) {
      if (!m.log.length && !this.logEl.childElementCount) this.logEl.append(h('div', {}, 'Событий пока нет.'));
      return;
    }
    if (this.logCount === 0) clear(this.logEl); // убрать «Событий пока нет»
    for (const e of m.log.slice(this.logCount)) this.logEl.append(h('div', {}, h('span', {}, fmtDuration(e.t)), e.text));
    this.logCount = m.log.length;
  }

  private renderResults(m: FlaskModel): void {
    // Таблица меняется только при смене модели или по окончании опыта.
    if (this.resultsModel === m && this.resultsDone === m.done) return;
    this.resultsModel = m;
    this.resultsDone = m.done;
    clear(this.resultsEl);
    const sc = flaskScenario(store.state.flask.scenarioId);
    if (!m.done) {
      this.resultsEl.append(h('div', { class: 'hint' }, `Результаты появятся по окончании инкубации (${fmtDuration(m.cond.duration)}). Чтобы не ждать, используйте «до … ч» на верхней панели.`));
      return;
    }
    const rows = this.measurements(m, sc.analysis);
    const table = h('table', {});
    for (const x of rows) {
      const val = x.value === null ? '—' : x.digits === 'sci' ? fmtSci(x.value) : fmtFixed(x.value, x.digits);
      table.append(h('tr', {}, h('td', {}, x.label), h('td', { class: 'v' }, val), h('td', { class: 'u' }, x.unit)));
    }
    this.resultsEl.append(table);
  }

  private measurements(m: FlaskModel, kind: FlaskAnalysisKind): Measurement[] {
    if (kind === 'oneStep') return oneStepMeasurements(analyzeOneStep(m.series, m.cond));
    const rows = lysisMeasurements(analyzeLysis(m.series, m.cond));
    const n = m.series.t.length - 1;
    const P = m.series.P[n];
    rows.push({ id: 'rfrac', label: 'Доля r-мутантов среди фагов в конце', value: P > 0 ? (100 * m.series.Pr[n]) / P : null, unit: '%', digits: 2 });
    rows.push({ id: 'firstR', label: 'Устойчивые мутанты в инокуляте', value: m.series.R[0], unit: 'КОЕ/мл', digits: 'sci' });
    return rows;
  }

  // ------------------------------------------------------------------ опыт

  private renderExperiment(): HTMLElement {
    const s = store.state;
    const sc = flaskScenario(s.flask.scenarioId);
    const c = s.flask.conditions;
    const cards = h('div', { class: 'scenarios' });
    for (const x of FLASK_SCENARIOS) {
      cards.append(
        h('button', { class: `scenario${x.id === sc.id ? ' active' : ''}`, onclick: () => store.chooseFlaskScenario(x.id) },
          h('b', {}, x.name),
          h('span', {}, x.description.split('. ')[0] + '.'),
        ),
      );
    }
    const form = h('div', { class: 'form' });
    for (const meta of FLASK_CONDITION_META) {
      let sub: string | undefined;
      if (meta.key === 'substrateMM') sub = `предельная плотность ≈ ${fmtSci(s.params.yield * c.substrateMM)} кл/мл`;
      if (meta.key === 'moi') sub = c.moi === 0 ? 'фаг не вносится (контроль)' : `≈ ${fmtSci(c.moi * c.initialDensity)} БОЕ/мл при плотности на старте`;
      if (meta.key === 'phageTiter') {
        const vol = c.moi > 0 ? (c.moi * c.initialDensity * c.volumeMl) / c.phageTiter : 0;
        sub = vol > c.volumeMl * 0.1 ? `⚠ нужно ≈ ${fmtSci(vol)} мл препарата — слишком много, возьмите препарат с бо́льшим титром` : undefined;
      }
      if (meta.key === 'dilutionTime' && c.dilutionFactor <= 1) sub = 'разведение выключено';
      const scDefault = sc.conditions[meta.key];
      form.append(numberField({
        label: meta.label, unit: meta.unit, value: c[meta.key], min: meta.min, max: meta.max, step: meta.step, scale: meta.scale,
        defaultValue: scDefault, allowZero: meta.allowZero,
        tip: { title: meta.label, body: meta.hint },
        sub,
        onChange: (v) => store.setFlaskCondition(meta.key, v),
      }));
    }
    return h('div', {},
      h('div', { class: 'section' }, h('h3', {}, 'Сценарии'), cards),
      h('div', { class: 'section' }, h('div', { class: 'card hint' }, h('b', {}, sc.name), h('br'), sc.description)),
      h('div', { class: 'section' },
        h('h3', {}, 'Условия эксперимента', h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', onclick: () => store.chooseFlaskScenario(sc.id) }, icon('reset', 12), 'как в сценарии')),
        h('p', { class: 'hint', style: 'margin:0 0 8px' }, 'Любое изменение начинает опыт заново с тем же seed.'),
        form,
      ),
    );
  }

  // ------------------------------------------------------------------ данные

  private renderData(): HTMLElement {
    const stepSel = h('select', {},
      ...[0.5, 1, 5, 10, 30, 60].map((x) => h('option', { value: String(x), selected: x === 5 }, x < 1 ? '30 с' : x < 60 ? `${x} мин` : '1 ч')));
    const recBtn = h('button', { class: 'btn rec' });
    const recLabel = () => recBtn.replaceChildren(...(this.recorder.active ? [icon('stop', 14), 'Остановить запись'] : [icon('record', 14), 'Записать видео']));
    recLabel();
    // Рекордер сам сообщает о начале и конце записи; кнопка с прошлой отрисовки вкладки просто перезаписывается.
    this.recorder.onChange = recLabel;
    recBtn.addEventListener('click', () => {
      if (this.recorder.active) this.recorder.stop();
      else this.recorder.start();
    });
    return h('div', {},
      h('div', { class: 'section' },
        h('h3', {}, 'Выгрузка в Excel'),
        h('div', { class: 'card' },
          h('p', { class: 'hint', style: 'margin-top:0' },
            'Файл CSV открывается в русском Excel двойным щелчком: разделитель «;», десятичная запятая. ',
            'В начале файла — сценарий, seed, условия опыта, все параметры и включённые механизмы, затем результаты и временные ряды.'),
          h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
            h('span', { class: 'hint' }, 'Шаг по времени:'), stepSel,
            h('button', { class: 'btn primary', onclick: () => this.exportCsv(Number(stepSel.value)) }, icon('download', 14), 'Временные ряды (CSV)'),
          ),
        ),
      ),
      h('div', { class: 'section' },
        h('h3', {}, 'Иллюстрации'),
        h('div', { class: 'card' },
          h('p', { class: 'hint', style: 'margin-top:0' }, 'Кадр сохраняется вместе с часами, масштабной линейкой, счётчиками и легендой. Видео записывается в формате WebM (или MP4 в Safari).'),
          h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
            h('button', { class: 'btn', onclick: () => this.exportPng() }, icon('download', 14), 'Кадр (PNG)'),
            recBtn,
          ),
        ),
      ),
      h('div', { class: 'section' },
        h('h3', {}, 'Воспроизводимость'),
        h('div', { class: 'card hint' },
          'Текущий seed: ', h('b', {}, String(store.state.seed)), '. Один и тот же seed с теми же параметрами и условиями всегда даёт тот же результат. ',
          'Seed записывается в каждый выгружаемый файл.'),
      ),
      h('div', { class: 'section' },
        h('h3', {}, 'Журнал опытов и серии прогонов'),
        h('div', { class: 'card hint' }, 'Автоматический журнал всех запусков, серии повторностей со средним и доверительным интервалом и серии по параметру появятся на этапе 5.'),
      ),
    );
  }

  private exportCsv(step: number): void {
    const m = this.runner.model;
    const s = store.state;
    const sc = flaskScenario(s.flask.scenarioId);
    const rows = describeModel({
      title: 'Виртуальная лаборатория «T4 vs E. coli» — модуль «Колба»',
      scenario: sc.name,
      seed: s.seed,
      conditions: flaskConditionRows(m.cond),
      params: m.params,
      mechanisms: m.mech,
    });
    rows.push(csvRow(['Результаты опыта', 'Значение', 'Единицы']));
    if (m.done) for (const x of this.measurements(m, sc.analysis)) rows.push(csvRow([x.label, x.value, x.unit]));
    else rows.push(csvRow([`опыт не завершён: выгружено ${fmtDuration(m.t)} из ${fmtDuration(m.cond.duration)}`]));
    rows.push('');
    const se = m.series;
    rows.push(...timeSeriesTable(se.t, [
      { header: 'OD600', values: se.od },
      { header: 'Чувствительные S, КОЕ/мл', values: se.S },
      { header: 'Заражённые I, /мл', values: se.I },
      { header: 'из них с торможением лизиса, /мл', values: se.LI },
      { header: 'Устойчивые R, КОЕ/мл', values: se.R },
      { header: 'Свободный фаг P, БОЕ/мл', values: se.P },
      { header: 'из них r-мутанты, БОЕ/мл', values: se.Pr },
      { header: 'Титр по бляшкам (P + инфекционные центры), БОЕ/мл', values: se.titer },
      { header: 'Титр после хлороформа, БОЕ/мл', values: se.titerChloroform },
      { header: 'Глюкоза, мкМ', values: se.N },
    ], step));
    download(`колба_${sc.id}_seed${s.seed}_${stamp()}.csv`, joinCsv(rows), 'text/csv;charset=utf-8');
    toast('CSV сохранён');
  }

  private async exportPng(): Promise<void> {
    const v = this.view();
    if (!v) {
      toast('Кадр недоступен: WebGL-отрисовка не запущена');
      return;
    }
    try {
      const blob = await v.snapshotPng();
      download(`колба_${stamp()}_${Math.round(this.runner.model.t)}мин.png`, blob);
      toast('Кадр сохранён');
    } catch (e) {
      console.error(e);
      toast('Не удалось сохранить кадр');
    }
  }
}
