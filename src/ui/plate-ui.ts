/**
 * Боковая панель модуля «Чашка Петри». Для ученика: выбор опыта, капля по щелчку,
 * счёт бляшек и расчёт титра по шагам, график роста бляшек, пояснения.
 * Условия посева и параметры модели — во вкладке «Для взрослых».
 */
import { h, clear, download, stamp, toast } from './dom';
import { icon } from './icons';
import { renderModelPanel } from './model-panel';
import { numberField } from './fields';
import { VideoRecorder } from './recorder';
import { TimeChart } from './charts';
import { seriesColor } from '../views/palette';
import { store, PLATE_DROP_SIZES, PLATE_LIMITS, type PlateSettings } from '../app/store';
import type { Runner } from '../app/runner';
import type { PlateModel } from '../core/plate/model';
import { PLATE_SCENARIOS, plateScenario, COMPARE_OPTIONS } from '../core/plate/scenarios';
import { describeModel, timeSeriesTable, joinCsv, csvRow } from '../core/export/csv';
import type { PlateView } from '../views/plate-view';
import { fmtDuration, fmtFixed, fmtSci, superscript } from './format';

type Tab = 'experiment' | 'glossary' | 'adults' | 'save';

const STORY: Record<string, { text: string; pause: boolean }> = {
  start: { text: 'Бактерии и вирусы уже в агаре, но пока ничего не видно: бактерий мало, а вирусы слишком маленькие. Подождём!', pause: false },
  lawn: { text: 'Бактерии размножились, и агар помутнел. Этот мутный слой называют газоном — в нём миллиарды бактерий.', pause: true },
  plaques: { text: 'Появились прозрачные пятнышки — бляшки! Каждая выросла из одного вируса: он заразил бактерию, она лопнула, новые вирусы заразили соседей — и так снова и снова.', pause: true },
  halo: { text: 'Увеличь бляшку (колёсико мыши): посередине она прозрачная, а край мутный, как туман. Там бактерии заражены, но не лопаются — это торможение лизиса.', pause: true },
  stop: { text: 'Питание в агаре кончилось, и бактерии перестали расти. В голодной бактерии вирус почти не размножается — поэтому бляшки почти перестали расти.', pause: true },
  drop: { text: 'Капля с вирусами упала на газон. Каждый вирус, который найдёт бактерию, начнёт свою бляшку.', pause: false },
  late: { text: 'Капля упала на уже густой газон, где бактерии голодают. Вирусы в них почти не размножаются — бляшки получатся крошечными или не появятся совсем.', pause: true },
  confluent: { text: 'Вирусов в капле было так много, что бляшки слились в одно большое прозрачное пятно. Это называют сплошным лизисом.', pause: true },
  done: { text: 'Инкубация закончена. Теперь можно рассмотреть бляшки поближе и измерить их.', pause: false },
  doneCount: { text: 'Инкубация закончена! Найди чашку, где бляшек не слишком много и не слишком мало, открой её и пощёлкай по каждой бляшке.', pause: false },
};

export class PlateUi {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabs: Record<Tab, HTMLButtonElement>;
  private tab: Tab = 'experiment';
  private openGroups = new Set<string>();
  private recorder: VideoRecorder;
  private shown = new Set<string>();
  private notes: { t: number; text: string }[] = [];
  private notesEl = h('div', { class: 'storylog' });
  private countEl = h('div', {});
  private dropBtn: HTMLButtonElement | null = null;
  private chart: TimeChart | null = null;
  private foodChart: TimeChart | null = null;
  /** Чашки, по которым рисуем еду: по одной на каждый вариант условий. */
  private foodPlates: number[] = [];
  private chartAt = 0;
  private revealed = false;
  private lastDropCount = 0;

  constructor(private runner: Runner<PlateModel>, private view: () => PlateView | null) {
    const mk = (id: Tab, label: string) => h('button', { class: 'sidetab', onclick: () => this.setTab(id) }, label);
    this.tabs = {
      experiment: mk('experiment', 'Опыт'),
      glossary: mk('glossary', 'Что я вижу'),
      adults: mk('adults', 'Для взрослых'),
      save: mk('save', 'Сохранить'),
    };
    this.body = h('div', { class: 'sidebody' });
    this.el = h('aside', { class: 'sidebar' }, h('nav', { class: 'sidetabs' }, Object.values(this.tabs)), this.body);
    this.recorder = new VideoRecorder(() => this.view()?.canvas ?? null);
    runner.on((e) => {
      if (e === 'reset') this.onReset();
      if (e === 'tick') this.onTick();
      if (e === 'finished') this.onFinished();
      if (e === 'status') {
        this.updateCount();
        // Опыт остановился (пауза, «до N ч», шаг) — дорисовать графики до текущего момента.
        if (!this.runner.running) this.updateChart(true);
      }
    });
    store.subscribe((kind) => {
      if (kind === 'plate' || kind === 'plateUi' || ((kind === 'model' || kind === 'seed') && this.tab === 'adults')) this.render();
    });
    this.setTab('experiment');
  }

  setTab(t: Tab): void {
    this.tab = t;
    for (const [k, b] of Object.entries(this.tabs)) b.classList.toggle('active', k === t);
    this.render();
  }

  private render(): void {
    const scroll = this.body.scrollTop;
    this.chart?.destroy();
    this.chart = null;
    this.foodChart?.destroy();
    this.foodChart = null;
    clear(this.body);
    if (this.tab === 'experiment') this.body.append(this.renderExperiment());
    else if (this.tab === 'glossary') this.body.append(this.renderGlossary());
    else if (this.tab === 'adults') this.body.append(this.renderAdults());
    else this.body.append(this.renderSave());
    this.body.scrollTop = scroll;
    this.updateChart(true);
  }

  // ------------------------------------------------------------------ события опыта

  private onReset(): void {
    this.shown.clear();
    this.notes = [];
    this.revealed = false;
    this.lastDropCount = 0;
    const sc = plateScenario(store.state.plate.scenarioId);
    const v = this.view();
    if (v) {
      v.scenarioName = sc.name;
      v.resetScene();
      v.mode = sc.counting ? 'count' : 'none';
    }
    // Панель перерисовываем целиком: у нового опыта может быть другое число чашек (ряды графика, таблица счёта).
    this.render();
  }

  private storyAt = 0;

  private onTick(force = false): void {
    const m = this.runner.model;
    const sc = plateScenario(store.state.plate.scenarioId);
    const now = performance.now();
    if (now - this.chartAt > 500) {
      this.chartAt = now;
      this.updateChart(false);
      this.updateCount();
    }
    if (!force && now - this.storyAt < 250) return;
    this.storyAt = now;
    if (m.t > 0 && !sc.dropsOnly) this.tell('start', m.t);
    const s = m.snapshot();
    if (s.lawnOpacity > 0.3) this.tell('lawn');
    const visible = s.plates.reduce((a, p) => a + p.visible, 0);
    if (visible > 0 && s.lawnOpacity > 0.05) this.tell('plaques');
    if ((sc.id === 'plaques' || sc.id === 'wt-vs-r') && s.plates[0].meanDiameter > 0.9 && s.lawnOpacity > 0.5) this.tell('halo');
    if (s.growth < 0.2 && visible > 0) this.tell('stop');
    // Капли.
    if (m.drops.length > this.lastDropCount) {
      const d = m.drops[m.drops.length - 1];
      this.lastDropCount = m.drops.length;
      this.tell(s.growth < 0.3 ? 'late' : 'drop', d.t);
    }
    for (const d of m.drops) {
      if (d.excess > 0 && m.dropFactor(d) < 0.2) this.tell('confluent');
    }
  }

  private onFinished(): void {
    const sc = plateScenario(store.state.plate.scenarioId);
    this.tell(sc.counting ? 'doneCount' : 'done');
    this.updateChart(true);
  }

  private tell(key: string, t = this.runner.model.t): void {
    if (this.shown.has(key)) return;
    this.shown.add(key);
    const st = STORY[key];
    this.notes.unshift({ t, text: st.text });
    this.notes.sort((a, b) => b.t - a.t);
    this.renderNotes();
    const s = store.state.plate;
    if (s.hints) this.view()?.showCaption(st.text);
    if (s.autoPause && st.pause && this.runner.running && this.runner.target === null) {
      this.runner.pause();
      toast('Пауза: важный момент. Расскажи, что произошло, и нажми «Пуск» (или пробел).', 4000);
    }
  }

  private renderNotes(): void {
    clear(this.notesEl);
    if (!this.notes.length) {
      this.notesEl.append(h('div', { class: 'hint' }, 'Здесь появятся пояснения к тому, что происходит на чашке.'));
      return;
    }
    for (const n of this.notes) this.notesEl.append(h('div', { class: 'note' }, h('span', {}, fmtDuration(n.t)), n.text));
  }

  // ------------------------------------------------------------------ щелчок по чашке

  handleClick(plate: number, x: number, y: number): void {
    const v = this.view();
    if (!v) return;
    const m = this.runner.model;
    if (v.mode === 'drop') {
      const d = m.addDrop(plate, x, y, store.state.plate.dropSize);
      if (!d) toast(m.done ? 'Инкубация закончена — начни опыт заново.' : 'Капель уже достаточно — начни опыт заново.');
      else v.dropAt(plate, x, y);
      v.mode = plateScenario(store.state.plate.scenarioId).counting ? 'count' : 'none';
      this.updateDropBtn();
      if (!this.runner.running) this.onTick(true);
      return;
    }
    if (v.mode === 'count') {
      const r = v.toggleMark(plate, x, y);
      if (r === 'none') toast('Здесь нет бляшки. Щёлкни прямо по прозрачному пятнышку.', 1800);
      this.updateCount();
    }
  }

  private updateDropBtn(): void {
    const b = this.dropBtn;
    if (!b) return;
    const on = this.view()?.mode === 'drop';
    b.classList.toggle('active', on);
    b.replaceChildren(icon('drop', 20), on ? 'Щёлкни по чашке…' : 'Капнуть вирусы');
  }

  // ------------------------------------------------------------------ вкладка «Опыт»

  private renderExperiment(): HTMLElement {
    const s = store.state.plate;
    const sc = plateScenario(s.scenarioId);
    const cards = h('div', { class: 'scenarios' });
    for (const x of PLATE_SCENARIOS) {
      cards.append(h('button', { class: `scenario${x.id === sc.id ? ' active' : ''}`, onclick: () => store.choosePlateScenario(x.id) },
        h('b', {}, x.name), h('span', {}, x.short)));
    }
    const out = h('div', {},
      h('div', { class: 'section' }, h('h3', {}, 'Какой опыт ставим'), cards),
      h('div', { class: 'section' }, h('div', { class: 'card story' }, sc.story)),
    );

    if (sc.compare) {
      const opt = COMPARE_OPTIONS.find((o) => o.id === s.compare) ?? COMPARE_OPTIONS[0];
      const btns = h('div', { class: 'scenarios' });
      for (const o of COMPARE_OPTIONS) {
        btns.append(h('button', { class: `scenario${o.id === opt.id ? ' active' : ''}`, onclick: () => store.setPlate('compare', o.id) },
          h('b', {}, o.label)));
      }
      out.append(h('div', { class: 'section' }, h('h3', {}, 'Что «выключить» на правой чашке'), btns,
        h('div', { class: 'hint', style: 'margin-top:6px' }, opt.hint)));
    }

    if (sc.counting) {
      out.append(h('div', { class: 'section' }, h('h3', {}, 'Считаем вирусы'), h('div', { class: 'card' }, this.countEl)));
      this.updateCount();
    }

    if (sc.kinetics) {
      this.chart = new TimeChart({
        title: 'Диаметр бляшек, мм',
        log: false,
        height: 170,
        series: this.runner.model.plates.map((p, i) => ({ label: p.spec.label, color: seriesColor(i, '#e8e2cf') })),
        yFormat: (v) => fmtFixed(v, 1),
      });
      out.append(h('div', { class: 'section' }, h('h3', {}, 'Как растут бляшки'), this.chart.el,
        h('div', { class: 'hint', style: 'margin-top:4px' }, 'Средний диаметр прозрачных пятен на чашке. Смотри, когда линия перестаёт подниматься.')));
    }

    if (!sc.counting) {
      const m = this.runner.model;
      this.foodPlates = m.groupRepresentatives();
      const many = this.foodPlates.length > 1;
      this.foodChart = new TimeChart({
        title: 'Еды осталось в агаре, %',
        log: false,
        height: 140,
        series: this.foodPlates.map((i, k) => ({ label: many ? m.groupLabel(m.plates[i].group) : 'еда', color: seriesColor(k, '#ffd166') })),
        yFormat: (v) => String(Math.round(v)),
        yRange: [0, 100],
      });
      out.append(h('div', { class: 'section' }, h('h3', {}, 'Еда для бактерий'), this.foodChart.el,
        h('div', { class: 'hint', style: 'margin-top:4px' }, 'Бактерии едят питание из агара. Когда еда кончается, газон перестаёт расти — и бляшки тоже.')));
    }

    if (!sc.counting) {
      this.dropBtn = h('button', {
        class: 'bigbtn',
        onclick: () => {
          const v = this.view();
          if (!v) return;
          v.mode = v.mode === 'drop' ? 'none' : 'drop';
          this.updateDropBtn();
        },
      });
      this.updateDropBtn();
      const labels: Record<number, string> = { 1: 'один', 30: '30', 1000: '1000', 1e6: 'миллион' };
      const sizes = h('div', { class: 'segmented' },
        ...PLATE_DROP_SIZES.map((n) => h('button', { class: s.dropSize === n ? 'active' : '', onclick: () => store.setPlateUi('dropSize', n) }, labels[n])));
      out.append(h('div', { class: 'section' }, h('h3', {}, 'Вирусы'), this.dropBtn,
        h('div', { class: 'hint', style: 'margin:6px 0 4px' }, 'Сколько вирусов в капле:'), sizes));
    } else this.dropBtn = null;

    const sw = (label: string, key: 'autoPause' | 'hints', hint: string) => {
      const cb = h('input', { type: 'checkbox', checked: s[key] });
      cb.addEventListener('change', () => store.setPlateUi(key, cb.checked));
      return h('label', { class: 'toggle' }, h('span', { class: 'switch' }, cb, h('span', {})), h('span', {}, label, h('div', { class: 'hint' }, hint)), h('span', {}));
    };
    this.renderNotes();
    out.append(
      h('div', { class: 'section' }, h('h3', {}, 'Что произошло'), this.notesEl),
      h('div', { class: 'section' }, h('h3', {}, 'Как показывать'),
        h('div', { class: 'card' },
          sw('Останавливаться на важных моментах', 'autoPause', 'Опыт сам встанет на паузу, чтобы ты успел рассказать.'),
          sw('Подсказки на экране', 'hints', 'Пояснения появляются внизу картинки.'),
        ),
        h('div', { class: 'hint', style: 'margin-top:6px' }, 'Колёсико мыши над чашкой — увеличить, перетаскивание — сдвинуть.')),
    );
    return out;
  }

  /** Счёт бляшек и расчёт титра по шагам. */
  updateCount(): void {
    const sc = plateScenario(store.state.plate.scenarioId);
    if (!sc.counting || this.tab !== 'experiment') return;
    const v = this.view();
    const m = this.runner.model;
    clear(this.countEl);
    const table = h('table', { class: 'counttable' },
      h('tr', {}, h('th', {}, 'Чашка'), h('th', {}, 'Отмечено'), h('th', {}, '')));
    m.plates.forEach((p, i) => {
      const n = v?.markCount(i) ?? 0;
      const focused = v?.focus === i;
      table.append(h('tr', { class: focused ? 'active' : '' },
        h('td', {}, `разведение ${p.spec.label}`),
        h('td', {}, n ? String(n) : '—'),
        h('td', {}, h('button', { class: 'btn small', onclick: () => v?.focusPlate(i) }, focused ? 'открыта' : 'открыть'))));
    });
    this.countEl.append(table);
    if (m.t < 8 * 60) {
      this.countEl.append(h('p', { class: 'hint' }, 'Бляшки растут ещё несколько часов. Чтобы сразу получить готовые чашки, введи вверху «до 16 ч» и нажми ⏩.'));
    }
    // Чашка для расчёта: открытая, а если не открыта — та, где больше всего отметок.
    let pi = v?.focus ?? -1;
    if (pi < 0 || !(v?.markCount(pi))) {
      let best = 0;
      m.plates.forEach((_, i) => {
        const n = v?.markCount(i) ?? 0;
        if (n > best) {
          best = n;
          pi = i;
        }
      });
    }
    const n = pi >= 0 ? (v?.markCount(pi) ?? 0) : 0;
    if (pi < 0 || n === 0) {
      this.countEl.append(h('p', { class: 'hint' }, 'Открой чашку, где бляшки можно сосчитать (удобнее всего, когда их от 30 до 300), и щёлкай по каждой.'));
      return;
    }
    const p = m.plates[pi];
    const d = p.spec.dilution;
    const vol = m.cond.platedMl;
    const titer = (n / vol) * Math.pow(10, d);
    const big = Math.pow(10, d).toLocaleString('ru-RU');
    this.countEl.append(
      h('div', { class: 'calc' },
        h('p', {}, h('b', {}, `1. `), `На чашке ${p.spec.label} ты насчитал `, h('b', {}, String(n)), ` бляшек — значит, в капле было ${n} вирусов.`),
        h('p', {}, h('b', {}, '2. '), `Капля — это ${fmtFixed(vol, vol < 0.1 ? 2 : 1)} мл. В целом миллилитре в ${fmtFixed(1 / vol, 0)} раз больше: ${n} × ${fmtFixed(1 / vol, 0)} = ${Math.round(n / vol)}.`),
        h('p', {}, h('b', {}, '3. '), `Пробу разводили в ${big} раз (10${superscript(d)}). Значит, в пробирке вирусов в ${big} раз больше:`),
        h('p', { class: 'answer' }, `${Math.round(n / vol)} × 10${superscript(d)} = ${fmtSci(titer, 1)} вирусов в 1 мл`),
        h('p', { class: 'hint' }, 'Учёные пишут это так: титр = ', fmtSci(titer, 1), ' БОЕ/мл (бляшкообразующих единиц на миллилитр).'),
      ),
    );
    if (n < 15) this.countEl.append(h('p', { class: 'hint' }, 'Бляшек маловато — ответ получится неточным. Лучше сосчитать чашку, где их больше.'));
    const check = h('button', { class: 'btn', onclick: () => { this.revealed = true; this.updateCount(); } }, 'Проверить ответ');
    if (!this.revealed) this.countEl.append(check);
    else {
      const err = (titer / m.stockTiter - 1) * 100;
      this.countEl.append(h('div', { class: 'card story' },
        `На самом деле в пробирке ${fmtSci(m.stockTiter, 1)} вирусов в 1 мл. `,
        Math.abs(err) <= 25
          ? `Ты ошибся всего на ${Math.round(Math.abs(err))} % — отличный результат! Небольшая ошибка бывает всегда: вирусы в капле распределяются случайно.`
          : `Разница ${Math.round(Math.abs(err))} %. Проверь, все ли бляшки отмечены, или сосчитай другую чашку.`));
    }
  }

  private updateChart(force: boolean): void {
    this.updateFoodChart(force);
    const c = this.chart;
    if (!c) return;
    const m = this.runner.model;
    if (!force && !this.runner.running) return;
    const r = m.record;
    c.setData(r.t, r.meanDiameter, m.duration);
  }

  private updateFoodChart(force: boolean): void {
    const c = this.foodChart;
    if (!c) return;
    const m = this.runner.model;
    if (!force && !this.runner.running) return;
    const r = m.record;
    c.setData(r.t, this.foodPlates.map((i) => r.food[i].map((v) => v * 100)), m.duration);
  }

  // ------------------------------------------------------------------ «Что я вижу»

  private renderGlossary(): HTMLElement {
    const item = (title: string, text: string) => h('div', { class: 'gloss' }, h('div', { class: 'cc-title' }, title), h('p', {}, text));
    return h('div', {},
      h('div', { class: 'section' }, h('h3', {}, 'Что на чашке'),
        item('Чашка Петри', 'Плоская прозрачная чашка с крышкой. На дне — слой питательного агара (желе из водорослей с питанием для бактерий). Сверху налит тонкий слой мягкого агара, в который добавили бактерии и вирусы.'),
        item('Еда в агаре', 'В агаре растворено питание для бактерий. На экране агар янтарный, пока еды много, и сереет, когда бактерии её съедают. Справа на разрезе чашки видны крупинки еды: они исчезают одна за другой. В настоящей чашке цвет почти не меняется — это подсказка программы.'),
        item('Газон', 'Бактерии размножаются в агаре и делают его мутным. Сплошной мутный слой называют газоном. В одном миллилитре газона — несколько миллиардов бактерий.'),
        item('Бляшка', 'Прозрачное пятнышко на газоне. Каждая бляшка начинается с одного вируса: он заражает бактерию, она лопается, и новые вирусы заражают соседей. Бактерии здесь погибли — поэтому пятно прозрачное.'),
        item('Ореол', 'Мутное кольцо вокруг бляшки обычного вируса T4. Здесь бактерии уже заражены, но ещё не лопнули: на них сели новые вирусы, и бактерия откладывает момент, когда лопнет (торможение лизиса).'),
      ),
      h('div', { class: 'section' }, h('h3', {}, 'Почему бляшки останавливаются'),
        h('ol', { class: 'steps' },
          h('li', {}, h('b', {}, 'Кончается питание. '), 'Через 6–7 часов бактерии съедают питание в агаре и перестают расти.'),
          h('li', {}, h('b', {}, 'Голодные бактерии — плохая фабрика. '), 'В голодной бактерии вирус размножается медленно, и новых вирусов выходит мало.'),
          h('li', {}, h('b', {}, 'Вирусы далеко не уплывают. '), 'В агаре вирус движется медленно и быстро прилипает к ближайшей бактерии.'),
          h('li', {}, h('b', {}, 'Торможение лизиса. '), 'Заражённые бактерии на краю бляшки долго не лопаются — поэтому бляшки обычного T4 мельче, чем у r-мутанта.'),
        ),
        h('p', { class: 'hint' }, 'Это можно проверить в опыте «Почему бляшки перестают расти?»: выключи одну причину и посмотри, что изменится.'),
      ),
      h('div', { class: 'section' }, h('h3', {}, 'Как сосчитать вирусы'),
        item('Разведение', 'Каплю пробы смешивают с 9 каплями воды — получается разведение в 10 раз (10⁻¹). Из него ещё раз в 10 раз — 10⁻² и так далее. На чашке 10⁻⁶ вирусов в миллион раз меньше, чем в пробирке.'),
        item('Титр', 'Сколько вирусов в 1 мл пробы. Его считают по бляшкам: бляшек на чашке × 10 (капля 0,1 мл) × во сколько раз разводили. Пишут в БОЕ/мл — «бляшкообразующих единицах на миллилитр».'),
        item('r-мутант', 'Вирус T4 со сломанным «тормозом» (гены rI, rII). Его бляшки крупнее и с чётким краем. На таких мутантах Сеймур Бензер в 1950-х годах изучал, как устроен ген.'),
      ),
      h('div', { class: 'section' }, h('div', { class: 'card hint' },
        'Картинка — это модель: компьютер считает, как растёт газон и как от бактерии к бактерии распространяются вирусы, ',
        'по тем же правилам и числам, что в «Колбе» и «Микроскопе». Каждая бляшка начинается с одного вируса в случайном месте.')),
    );
  }

  // ------------------------------------------------------------------ «Для взрослых»

  private renderAdults(): HTMLElement {
    const s = store.state.plate;
    const m = this.runner.model;
    const field = (key: keyof typeof PLATE_LIMITS, label: string, unit: string, scale: 'linear' | 'log', step: number, def: number, body: string) =>
      numberField({
        label, unit, value: s[key] as number, min: PLATE_LIMITS[key][0], max: PLATE_LIMITS[key][1], step, scale, defaultValue: def,
        tip: { title: label, body },
        onChange: (v) => store.setPlate(key, v as PlateSettings[typeof key]),
      });
    const grid = h('div', { class: 'segmented' },
      ...[256, 512].map((n) => h('button', { class: s.gridNodes === n ? 'active' : '', onclick: () => store.setPlate('gridNodes', n) }, `${n} колец`)));
    return h('div', {},
      h('div', { class: 'section' }, h('div', { class: 'card hint' },
        'Газон растёт одинаково по всей чашке (питание общее). Каждая бляшка — радиальная модель реакции–диффузии с шагом ',
        `${fmtFixed(3500 / s.gridNodes, 1)} мкм: в кольцах — чувствительные клетки, заражённые когортами по возрасту (как в колбе, с торможением лизиса), `,
        'свободный фаг с диффузией D_p. Время первой адсорбции каждого посеянного фага разыгрывается из exp(−k∫S dt) — отсюда разброс размеров бляшек. ',
        'Диаметр бляшки — по прозрачной зоне (мутность ниже 20 % от газона). Подробнее — в README.')),
      h('div', { class: 'section' }, h('h3', {}, 'Посев', h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: () => store.resetPlateConditions() }, icon('reset', 12), 'По умолчанию')),
        h('div', { class: 'card' },
          field('lawnDensity', 'Бактерий в верхнем агаре при посеве', 'клеток/мл', 'log', 0, 1e7, 'Сколько клеток индикаторного штамма вносят в мягкий агар (обычно 0,1–0,3 мл ночной культуры на 3 мл агара, разбавленной так, чтобы газон вырос к 5–7 ч).'),
          field('lawnDoubling', 'Время удвоения в мягком агаре', 'мин', 'linear', 1, 45, 'В неперемешиваемом агаре бактериям не хватает кислорода, и они растут медленнее, чем в колбе (20 мин). Задаёт, когда газон перестаёт расти.'),
          field('substrateMM', 'Питание в агаре', 'мМ', 'log', 0, 5, 'Эквивалент глюкозы на 1 мл верхнего агара с учётом запаса в нижнем слое. Задаёт плотность газона: Y × N.'),
          field('temperature', 'Температура инкубации', '°C', 'linear', 1, 37, 'Скорости роста бактерий и развития фага масштабируются через Q₁₀.'),
          field('platedMl', 'Объём посева', 'мл', 'log', 0, 0.1, 'Сколько миллилитров разведения фага вносят на чашку.'),
          h('div', { class: 'hint', style: 'margin:8px 0 4px' }, 'Сетка бляшки (проверка сходимости):'), grid,
          h('p', { class: 'hint' }, `Титр препарата в этом опыте: ${fmtSci(m.stockTiter, 2)} БОЕ/мл${m.cond.stockTiter > 0 ? '' : ' (неизвестный образец: выбирается по seed)'}.`),
        )),
      renderModelPanel(this.openGroups),
    );
  }

  // ------------------------------------------------------------------ «Сохранить»

  private renderSave(): HTMLElement {
    const recBtn = h('button', { class: 'btn rec' });
    const recLabel = () => recBtn.replaceChildren(...(this.recorder.active ? [icon('stop', 14), 'Остановить запись'] : [icon('record', 14), 'Записать видео']));
    recLabel();
    this.recorder.onChange = recLabel;
    recBtn.addEventListener('click', () => {
      if (this.recorder.active) this.recorder.stop();
      else this.recorder.start();
      recLabel();
    });
    return h('div', {},
      h('div', { class: 'section' }, h('h3', {}, 'Картинки и видео для презентации'),
        h('div', { class: 'card' },
          h('p', { class: 'hint', style: 'margin-top:0' }, 'Картинка сохраняется вместе с часами, масштабной линейкой и подписями.'),
          h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
            h('button', { class: 'btn primary', onclick: () => this.exportPng() }, icon('download', 14), 'Сохранить картинку'),
            recBtn,
          ))),
      h('div', { class: 'section' }, h('h3', {}, 'Данные (Excel)'),
        h('div', { class: 'card' },
          h('p', { class: 'hint', style: 'margin-top:0' }, 'Таблицы для русского Excel: в начале файла — условия опыта, параметры модели и seed.'),
          h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
            h('button', { class: 'btn primary', onclick: () => this.exportSeries() }, icon('download', 14), 'Рост бляшек (CSV)'),
            h('button', { class: 'btn', onclick: () => this.exportPlaques() }, icon('download', 14), 'Все бляшки (CSV)'),
          ))),
    );
  }

  private header(): string[] {
    const s = store.state;
    const m = this.runner.model;
    const sc = plateScenario(s.plate.scenarioId);
    const c = m.cond;
    return describeModel({
      title: 'Виртуальная лаборатория «T4 vs E. coli» — чашка Петри',
      scenario: sc.name,
      seed: s.seed,
      conditions: [
        { label: 'Бактерий в верхнем агаре при посеве', value: c.lawnDensity, unit: 'клеток/мл' },
        { label: 'Время удвоения в мягком агаре', value: c.lawnDoubling, unit: 'мин' },
        { label: 'Питание в агаре', value: c.substrateMM, unit: 'мМ' },
        { label: 'Температура', value: c.temperature, unit: '°C' },
        { label: 'Титр препарата фага', value: m.stockTiter, unit: 'БОЕ/мл' },
        { label: 'Объём посева', value: c.platedMl, unit: 'мл' },
        { label: 'Колец в сетке бляшки', value: c.gridNodes, unit: '' },
        ...m.plates.map((p, i) => ({
          label: `Чашка ${i + 1}: ${p.spec.label}`,
          value: `разведение 10^-${p.spec.dilution}; r-мутантов ${p.spec.rFractionPct} %${p.spec.mech ? '; выключено: ' + Object.keys(p.spec.mech).join(', ') : ''}${p.spec.diffusionFactor ? `; диффузия ×${p.spec.diffusionFactor}` : ''}; вирусов посеяно ${p.phages}`,
          unit: '',
        })),
      ],
      params: s.params,
      mechanisms: s.mechanisms,
    });
  }

  private exportSeries(): void {
    const m = this.runner.model;
    const rows = this.header();
    rows.push(csvRow(['Средний диаметр видимых бляшек (прозрачная зона), мм; число видимых бляшек (диаметр от 0,2 мм)']));
    const cols = m.plates.flatMap((p, i) => [
      { header: `${p.spec.label}: диаметр, мм`, values: m.record.meanDiameter[i] },
      { header: `${p.spec.label}: бляшек видно`, values: m.record.visible[i] },
    ]);
    rows.push(...timeSeriesTable(m.record.t, [...cols, { header: 'Мутность газона (0–1)', values: m.record.lawn },
      ...m.plates.map((p, i) => ({ header: `${p.spec.label}: еды осталось (0–1)`, values: m.record.food[i] }))], 5));
    download(`чашка_${store.state.plate.scenarioId}_seed${store.state.seed}_${stamp()}.csv`, joinCsv(rows), 'text/csv;charset=utf-8');
  }

  private exportPlaques(): void {
    const m = this.runner.model;
    m.refreshClasses();
    const rows = this.header();
    rows.push(csvRow([`Состояние на ${fmtDuration(m.t)} инкубации`]));
    rows.push(csvRow(['Чашка', 'x, мм', 'y, мм', 'Фаг', 'Первая адсорбция, мин', 'Диаметр прозрачной зоны, мм', 'Диаметр с ореолом, мм', 'Отмечена при счёте']));
    const v = this.view();
    m.plaques.forEach((p, i) => {
      rows.push(csvRow([m.plates[p.plate].spec.label, p.x, p.y, p.founder === 'r' ? 'r-мутант' : 'дикий тип', p.t0,
        m.plaqueDiameter(p), 2 * m.plaqueOuter(p), v?.marks.get(p.plate)?.has(i) ?? false]));
    });
    download(`бляшки_${store.state.plate.scenarioId}_seed${store.state.seed}_${stamp()}.csv`, joinCsv(rows), 'text/csv;charset=utf-8');
  }

  private async exportPng(): Promise<void> {
    const v = this.view();
    if (!v) return;
    const blob = await v.snapshotPng();
    download(`чашка_${stamp()}_${Math.round(this.runner.model.t)}мин.png`, blob);
    toast('Картинка сохранена');
  }
}
