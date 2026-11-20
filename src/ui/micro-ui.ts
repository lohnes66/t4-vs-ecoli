/**
 * Боковая панель модуля «Микроскоп». Рассчитана на ученика 4-го класса: простые слова,
 * крупные действия, пояснения к важным моментам и карточка выбранной бактерии.
 * Полный набор параметров — во вкладке «Для взрослых».
 */
import { h, clear, download, stamp, toast } from './dom';
import { icon } from './icons';
import { renderModelPanel } from './model-panel';
import { VideoRecorder } from './recorder';
import { store } from '../app/store';
import type { Runner } from '../app/runner';
import type { MicroscopeModel, MicroEvent, Cell } from '../core/microscope/model';
import { MICRO_SCENARIOS, microScenario } from '../core/microscope/scenarios';
import type { MicroscopeView } from '../views/microscope-view';
import { CSS_COLORS } from '../views/palette';
import { fmtDuration, fmtFixed } from './format';

type Tab = 'experiment' | 'glossary' | 'adults' | 'save';

interface StoryNote {
  t: number;
  text: string;
}

/** Пояснения к важным моментам — показываются один раз за опыт. */
const STORY: Record<string, { text: (x: number) => string; pause: boolean }> = {
  drop: { text: () => 'Капля с вирусами упала на колонию. Вирусы — бактериофаги T4 — расплываются в разные стороны и ищут бактерию.', pause: false },
  adsorb: { text: () => 'Вирус прицепился к бактерии! Он садится на неё «ножками» и, как шприц, впрыскивает внутрь свою ДНК — инструкцию, как делать новые вирусы.', pause: true },
  eclipse: { text: () => 'Внутри заражённой бактерии уже собираются новые вирусы. Бактерия больше не растёт: теперь она работает на вирус, как фабрика.', pause: true },
  lysis: { text: (n) => `Бактерия лопнула! Из неё вышло ${n} новых вирусов. Каждый из них может заразить другую бактерию.`, pause: true },
  li: { text: () => 'На заражённую бактерию сел ещё один вирус. Теперь она лопнет позже, зато вирусов внутри соберётся больше. Учёные называют это торможением лизиса.', pause: true },
  plaque: { text: () => 'На месте лопнувших бактерий получается пустое пятно. На чашке Петри такие пятна видно даже без микроскопа — их называют бляшками.', pause: true },
  divide: { text: () => 'Бактерия выросла вдвое и разделилась пополам. Теперь их две! Так бактерии размножаются — примерно каждые 20 минут.', pause: true },
  resistant: { text: () => 'Фиолетовые бактерии устойчивые: у них нет «замочка», к которому цепляется вирус. Вирусы им не страшны, и они продолжают расти.', pause: true },
  starving: { text: () => 'В агаре кончается питание, и бактерии почти перестали расти. В голодных бактериях вирусы размножаются плохо — поэтому пятно перестаёт расти.', pause: true },
  mutantR: { text: () => 'При делении появилась бактерия-мутант, устойчивая к вирусу! Такое случается очень редко — примерно один раз на миллион делений.', pause: true },
};

export class MicroUi {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabs: Record<Tab, HTMLButtonElement>;
  private tab: Tab = 'experiment';
  private openGroups = new Set<string>();
  private recorder: VideoRecorder;

  private shown = new Set<string>();
  private notes: StoryNote[] = [];
  private notesEl = h('div', { class: 'storylog' });
  private cellCard = h('div', { class: 'cellcard' });
  private dropBtn!: HTMLButtonElement;
  private lastCardUpdate = 0;
  /** Последнее, что мы знали о выбранной клетке (на случай, если она лопнула). */
  private lastSelected: { cell: Cell; t: number } | null = null;
  private lysedSelected: { burst: number; t: number } | null = null;
  /** Замедленный показ лизиса: сколько секунд экрана осталось и какая скорость была до него. */
  private slow: { left: number; prev: number } | null = null;
  private lastTickReal = 0;
  /** Вызывается, когда панель сама меняет скорость опыта (чтобы обновить ползунок). */
  onSpeed: (() => void) | null = null;

  constructor(private runner: Runner<MicroscopeModel>, private view: () => MicroscopeView | null) {
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
      // После перемотки или паузы такты прекращаются — обновляем карточку сразу.
      if (e === 'status') this.updateCellCard(true);
    });
    store.subscribe((kind) => {
      if (kind === 'micro' || kind === 'microUi' || ((kind === 'model' || kind === 'seed') && this.tab === 'adults')) this.render();
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
    clear(this.body);
    if (this.tab === 'experiment') this.body.append(this.renderExperiment());
    else if (this.tab === 'glossary') this.body.append(this.renderGlossary());
    else if (this.tab === 'adults') this.body.append(this.renderAdults());
    else this.body.append(this.renderSave());
    this.body.scrollTop = scroll;
  }

  // ------------------------------------------------------------------ события опыта

  private onReset(): void {
    this.endSlowMo();
    this.shown.clear();
    this.notes = [];
    this.lastSelected = null;
    this.lysedSelected = null;
    const v = this.view();
    if (v) {
      v.scenarioName = microScenario(store.state.micro.scenarioId).name;
      v.dropMode = false;
      v.resetScene();
    }
    this.updateDropBtn();
    this.renderNotes();
    this.updateCellCard(true);
  }

  private onTick(): void {
    const now0 = performance.now();
    const dtReal = Math.min(0.1, (now0 - this.lastTickReal) / 1000);
    this.lastTickReal = now0;
    if (this.slow) {
      // Ученик сам сдвинул скорость — замедление больше не нужно.
      if (this.runner.speed !== 1) this.endSlowMo(false);
      else if ((this.slow.left -= dtReal) <= 0) this.endSlowMo();
    }
    const m = this.runner.model;
    const events = m.drainEvents();
    if (events.length) {
      this.view()?.handleEvents(events);
      this.story(events);
    }
    // Проверки «состояния», а не отдельных событий.
    const snap = m.snapshot();
    if (snap.lysed >= 25) this.tell('plaque', 0);
    if (snap.growth < 0.3 && snap.I + snap.LI > 0) this.tell('starving', 0);
    if (snap.R > 0 && snap.lysed >= 15 && m.cond.resistantPct > 0) this.tell('resistant', 0);
    const now = performance.now();
    if (now - this.lastCardUpdate > 250) {
      this.lastCardUpdate = now;
      this.updateCellCard(false);
    }
  }

  private story(events: MicroEvent[]): void {
    const sc = microScenario(store.state.micro.scenarioId);
    const v = this.view();
    for (const e of events) {
      if (e.kind === 'drop') this.tell('drop', 0, e.t);
      else if (e.kind === 'adsorb' && e.primary) {
        if (sc.followFirst && v && v.selectedId === null && !this.shown.has('adsorb')) v.selectedId = e.cellId;
        this.tell('adsorb', 0, e.t);
      } else if (e.kind === 'eclipse') this.tell('eclipse', 0, e.t);
      else if (e.kind === 'lysis') {
        if (v && v.selectedId === e.cellId) this.lysedSelected = { burst: e.burst, t: e.t };
        if (!this.shown.has('lysis') || (v && v.selectedId === e.cellId)) this.startSlowMo();
        this.tell('lysis', e.burst, e.t);
      } else if (e.kind === 'li') this.tell('li', 0, e.t);
      else if (e.kind === 'divide' && sc.id === 'colony-grows') this.tell('divide', 0, e.t);
      else if (e.kind === 'mutantR') this.tell('mutantR', 0, e.t);
    }
  }

  /**
   * Свободный вирус после лизиса живёт всего несколько секунд опыта — потом садится на соседнюю
   * бактерию. На обычной скорости это доли секунды экрана, поэтому на 6 секунд замедляем опыт
   * до реального времени (×1): видно, как вирусы разлетаются и прилипают к соседям.
   */
  private startSlowMo(): void {
    const s = store.state.micro;
    if (!s.slowMo || s.look !== 'fluo' || this.slow || this.runner.speed <= 2) return;
    this.slow = { left: 6, prev: this.runner.speed };
    this.runner.speed = 1;
    const v = this.view();
    if (v) v.slowMo = true;
    this.onSpeed?.();
  }

  private endSlowMo(restore = true): void {
    if (!this.slow) return;
    if (restore && this.runner.speed === 1) this.runner.speed = this.slow.prev;
    this.slow = null;
    const v = this.view();
    if (v) v.slowMo = false;
    this.onSpeed?.();
  }

  private tell(key: string, x: number, t = this.runner.model.t): void {
    if (this.shown.has(key)) return;
    this.shown.add(key);
    const st = STORY[key];
    const text = st.text(x);
    this.notes.unshift({ t, text });
    this.notes.sort((a, b) => b.t - a.t);
    this.renderNotes();
    const s = store.state.micro;
    if (s.hints) this.view()?.showCaption(text);
    if (s.autoPause && st.pause && this.runner.running) {
      this.runner.pause();
      toast('Пауза: важный момент. Расскажи, что произошло, и нажми «Пуск» (или пробел).', 4000);
    }
  }

  private renderNotes(): void {
    clear(this.notesEl);
    if (!this.notes.length) {
      this.notesEl.append(h('div', { class: 'hint' }, 'Здесь появятся пояснения к тому, что происходит под микроскопом.'));
      return;
    }
    for (const n of this.notes) this.notesEl.append(h('div', { class: 'note' }, h('span', {}, fmtDuration(n.t)), n.text));
  }

  // ------------------------------------------------------------------ выбранная бактерия

  private updateCellCard(force: boolean): void {
    if (!force && this.tab !== 'experiment') return;
    const v = this.view();
    const m = this.runner.model;
    clear(this.cellCard);
    const id = v?.selectedId ?? null;
    const c = id !== null ? m.cellById(id) : undefined;
    if (c) this.lastSelected = { cell: c, t: m.t };
    if (!c && this.lysedSelected && this.lastSelected) {
      this.cellCard.append(
        h('div', { class: 'cc-title' }, h('span', { class: 'dot', style: `background:${CSS_COLORS.P}` }), 'Эта бактерия лопнула'),
        h('p', {}, `Из неё вышло ${this.lysedSelected.burst} новых вирусов. Выбери другую бактерию щелчком.`),
      );
      return;
    }
    if (!c) {
      this.cellCard.append(h('p', { class: 'hint', style: 'margin:0' }, 'Щёлкни по любой бактерии на экране — здесь появится рассказ о ней.'));
      return;
    }
    const r = m.rates;
    const starving = m.relGrowth < 0.3;
    let color = CSS_COLORS.S;
    let title = 'Здоровая бактерия';
    const lines: (string | HTMLElement)[] = [];
    let progress: number | null = null;
    if (c.state === 'S') {
      if (starving) {
        color = CSS_COLORS.starving;
        title = 'Голодная бактерия';
        lines.push('Питание в агаре почти кончилось, поэтому она почти не растёт.');
      } else {
        lines.push(`Длина ${fmtFixed(c.len, 1)} мкм. Она растёт и, когда вытянется до ${fmtFixed(c.divLen, 1)} мкм, разделится пополам.`);
        progress = Math.min(1, (c.len - c.divLen / 2) / (c.divLen / 2));
      }
    } else if (c.state === 'R') {
      color = CSS_COLORS.R;
      title = 'Устойчивая бактерия';
      lines.push('Вирусы не могут к ней прицепиться: у неё нет нужного «замочка» на поверхности. Она спокойно растёт и делится.');
    } else {
      const ago = m.t - c.infectedAt;
      const inside = Math.round(Math.min(c.progeny, r.burstMaxLI));
      color = c.state === 'LI' ? CSS_COLORS.LI : CSS_COLORS.I;
      title = c.state === 'LI' ? 'Заражена, лопнет позже' : 'Заражённая бактерия';
      lines.push(`Вирус заразил её ${fmtDuration(ago)} назад.`);
      if (c.age < r.eclipse) lines.push('Вирус уже впрыснул свою ДНК, но готовых новых вирусов внутри пока нет — бактерия их только начинает собирать.');
      else lines.push(`Внутри уже около ${inside} новых вирусов.`);
      if (c.state === 'I') {
        const left = Math.max(0, (c.lysisAge - c.age) / Math.max(0.05, r.tempFactor));
        lines.push(left > 0.5 ? `Лопнет примерно через ${Math.max(1, Math.round(left))} мин.` : 'Сейчас лопнет!');
        progress = Math.min(1, c.age / c.lysisAge);
      } else {
        lines.push('На неё садятся всё новые вирусы, и она откладывает момент, когда лопнет. Вирусов внутри становится всё больше.');
        progress = Math.min(1, inside / r.burstMaxLI);
      }
    }
    this.cellCard.append(
      h('div', { class: 'cc-title' }, h('span', { class: 'dot', style: `background:${color}` }), title, h('span', { class: 'cc-id' }, `№ ${c.id}`)),
      ...lines.map((x) => h('p', {}, x)),
    );
    if (progress !== null) {
      this.cellCard.append(h('div', { class: 'bar' }, h('div', { style: `width:${Math.round(Math.max(0, progress) * 100)}%;background:${color}` })));
    }
  }

  // ------------------------------------------------------------------ вкладки

  private updateDropBtn(): void {
    if (!this.dropBtn) return;
    const on = this.view()?.dropMode ?? false;
    this.dropBtn.classList.toggle('active', on);
    this.dropBtn.replaceChildren(icon('drop', 20), on ? 'Щёлкни по полю…' : 'Капнуть вирусы');
  }

  private renderExperiment(): HTMLElement {
    const s = store.state.micro;
    const sc = microScenario(s.scenarioId);
    const cards = h('div', { class: 'scenarios' });
    for (const x of MICRO_SCENARIOS) {
      cards.append(h('button', { class: `scenario${x.id === sc.id ? ' active' : ''}`, onclick: () => store.chooseMicroScenario(x.id) },
        h('b', {}, x.name), h('span', {}, x.short)));
    }
    this.dropBtn = h('button', {
      class: 'bigbtn',
      onclick: () => {
        const v = this.view();
        if (!v) return;
        v.dropMode = !v.dropMode;
        this.updateDropBtn();
      },
    });
    this.updateDropBtn();
    const sizes = h('div', { class: 'segmented' },
      ...[[10, 'мало'], [100, 'средне'], [1000, 'много']].map(([n, label]) =>
        h('button', { class: s.dropSize === n ? 'active' : '', onclick: () => store.setMicro('dropSize', n as number) }, `${label} (${n})`)));
    const sw = (label: string, key: 'autoPause' | 'hints' | 'slowMo', hint: string) => {
      const cb = h('input', { type: 'checkbox', checked: s[key] });
      cb.addEventListener('change', () => store.setMicro(key, cb.checked));
      return h('label', { class: 'toggle' }, h('span', { class: 'switch' }, cb, h('span', {})), h('span', {}, label, h('div', { class: 'hint' }, hint)), h('span', {}));
    };
    this.updateCellCard(true);
    this.renderNotes();
    return h('div', {},
      h('div', { class: 'section' }, h('h3', {}, 'Что будем смотреть'), cards),
      h('div', { class: 'section' }, h('div', { class: 'card story' }, sc.story)),
      h('div', { class: 'section' },
        h('h3', {}, 'Вирусы'),
        this.dropBtn,
        h('div', { class: 'hint', style: 'margin:6px 0 4px' }, 'Сколько вирусов в капле:'),
        sizes,
      ),
      h('div', { class: 'section' }, h('h3', {}, 'Выбранная бактерия'), h('div', { class: 'card' }, this.cellCard)),
      h('div', { class: 'section' }, h('h3', {}, 'Что произошло'), this.notesEl),
      h('div', { class: 'section' }, h('h3', {}, 'Как смотреть'),
        h('div', { class: 'segmented' },
          ...([['fluo', 'Светящиеся метки'], ['phase', 'Обычный микроскоп']] as const).map(([k, label]) =>
            h('button', { class: s.look === k ? 'active' : '', onclick: () => store.setMicro('look', k) }, label))),
        h('div', { class: 'hint', style: 'margin-top:6px' }, s.look === 'fluo'
          ? 'Учёные «подкрашивают» бактерии и вирусы светящимися белками, чтобы видеть, что происходит внутри. Цвет показывает, что с бактерией.'
          : 'Так бактерии выглядят в обычный микроскоп: тёмные палочки со светлым ободком. Вирусов не видно — они слишком маленькие.'),
      ),
      h('div', { class: 'section' }, h('h3', {}, 'Как показывать'),
        h('div', { class: 'card' },
          sw('Останавливаться на важных моментах', 'autoPause', 'Опыт сам встанет на паузу, чтобы ты успел рассказать.'),
          sw('Подсказки на экране', 'hints', 'Пояснения появляются внизу картинки.'),
          sw('Замедлять, когда бактерия лопается', 'slowMo', 'На несколько секунд время пойдёт как в жизни — видно, как разлетаются новые вирусы.'),
        )),
    );
  }

  private renderGlossary(): HTMLElement {
    const item = (color: string | null, title: string, text: string) =>
      h('div', { class: 'gloss' }, h('div', { class: 'cc-title' }, color ? h('span', { class: 'dot', style: `background:${color}` }) : null, title), h('p', {}, text));
    return h('div', {},
      h('div', { class: 'section' }, h('h3', {}, 'Кто здесь живёт'),
        item(CSS_COLORS.S, 'Бактерия кишечная палочка (E. coli)', 'Крошечная палочка длиной 2–4 мкм — в тысячу раз меньше миллиметра. Она ест сахар из агара, растёт в длину и делится пополам примерно каждые 20 минут.'),
        item(null, 'Что внутри бактерии', 'Светлый ободок — оболочка (мембрана) бактерии. Тёмное пятно в середине — её ДНК, «инструкция», как жить и расти. Перед делением ДНК копируется, и две копии расходятся к будущим дочерним клеткам; посередине вырастает перегородка. Мелкие тёмные крупинки — запасы питательных веществ.'),
        item(CSS_COLORS.P, 'Вирус-бактериофаг T4', 'Вирус, который заражает только бактерии. Он ещё меньше бактерии: его головка — около 0,1 мкм. У него есть «ножки», которыми он цепляется к бактерии, и хвост, похожий на шприц.'),
      ),
      h('div', { class: 'section' }, h('h3', {}, 'Как вирус заражает бактерию'),
        h('ol', { class: 'steps' },
          h('li', {}, h('b', {}, 'Находит. '), 'Вирус не умеет плавать сам — его носит в агаре, пока он случайно не натолкнётся на бактерию.'),
          h('li', {}, h('b', {}, 'Прицепляется. '), 'Ножки вируса узнают на поверхности бактерии особый «замочек» и цепляются за него.'),
          h('li', {}, h('b', {}, 'Впрыскивает ДНК. '), 'Хвост работает как шприц: внутрь бактерии попадает ДНК вируса — инструкция, как делать новые вирусы. Сам вирус остаётся снаружи пустой оболочкой.'),
          h('li', {}, h('b', {}, 'Захватывает фабрику. '), 'Бактерия перестаёт расти и по инструкции вируса собирает новые вирусы. Свою ДНК бактерии вирус разрушает — тёмное пятно внутри исчезает. На экране бактерия меняет цвет: зелёная → жёлтая → красная, а внутри появляются светлые крупинки — новые вирусы.'),
          h('li', {}, h('b', {}, 'Бактерия лопается. '), 'Примерно через 25 минут бактерия лопается, и наружу выходят 100–200 новых вирусов. Они заражают соседей — и всё повторяется.'),
        ),
      ),
      h('div', { class: 'section' }, h('h3', {}, 'Что ещё можно увидеть'),
        item(CSS_COLORS.LI, 'Торможение лизиса', 'Если на уже заражённую бактерию садятся новые вирусы, она лопается позже, но вирусов внутри собирается больше. Это особенность именно вируса T4.'),
        item(CSS_COLORS.R, 'Устойчивые бактерии', 'Иногда у бактерии ломается «замочек», и вирус больше не может к ней прицепиться. Такие бактерии выживают, когда все остальные погибли.'),
        item('#ffd166', 'Еда в агаре', 'Жёлтые крупинки — питание для бактерий (сахар). Бактерии едят его, чтобы расти и делиться: крупинки исчезают одна за другой. Когда еда кончается, бактерии голодают и перестают делиться, а вирусы в голодных бактериях размножаются плохо. Справа на панели «Еда для бактерий» видно, сколько еды осталось. На самом деле сахар в микроскоп не виден — это подсказка программы.'),
        item(null, 'Бляшка', 'Пустое пятно в колонии на месте лопнувших бактерий. На чашке Петри бляшки видно глазом: это прозрачные кружочки на мутном слое бактерий.'),
      ),
      h('div', { class: 'section' }, h('div', { class: 'card hint' },
        'Картинка — это модель: компьютер считает, как растут бактерии и как распространяются вирусы, по правилам и числам из научных статей. ',
        'Настоящие бактерии под обычным микроскопом не светятся разными цветами. Учёные добавляют в них светящиеся белки (такие нашли у медуз), ',
        'а здесь цвет ещё и показывает, что происходит внутри. Чтобы увидеть бактерии как в обычный микроскоп, выбери на вкладке «Опыт» → «Обычный микроскоп».')),
    );
  }

  private renderAdults(): HTMLElement {
    return h('div', {},
      h('div', { class: 'section' }, h('div', { class: 'card hint' },
        'Параметры модели общие для всех модулей (колба, микроскоп). Любое изменение начинает опыт заново с тем же seed. ',
        'Микроскоп — агентная модель: клетки-капсулы растут, делятся и расталкивают друг друга; фаг — непрерывное поле на сетке 1 мкм с диффузией; ',
        'заражение разыгрывается из локальной концентрации фага и площади клетки.')),
      renderModelPanel(this.openGroups),
    );
  }

  private renderSave(): HTMLElement {
    const recBtn = h('button', { class: 'btn rec' });
    const recLabel = () => recBtn.replaceChildren(...(this.recorder.active ? [icon('stop', 14), 'Остановить запись'] : [icon('record', 14), 'Записать видео']));
    recLabel();
    recBtn.addEventListener('click', () => {
      if (this.recorder.active) this.recorder.stop();
      else this.recorder.start();
      recLabel();
    });
    return h('div', {},
      h('div', { class: 'section' }, h('h3', {}, 'Картинки и видео для презентации'),
        h('div', { class: 'card' },
          h('p', { class: 'hint', style: 'margin-top:0' }, 'Картинка сохраняется вместе с часами, масштабной линейкой, счётчиками и подсказкой. Видео можно вставить в презентацию.'),
          h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
            h('button', { class: 'btn primary', onclick: () => this.exportPng() }, icon('download', 14), 'Сохранить картинку'),
            recBtn,
          ),
        )),
    );
  }

  private async exportPng(): Promise<void> {
    const v = this.view();
    if (!v) return;
    const blob = await v.snapshotPng();
    download(`микроскоп_${stamp()}_${Math.round(this.runner.model.t)}мин.png`, blob);
    toast('Картинка сохранена');
  }

  /** Щелчок по полю микроскопа. */
  handleClick(x: number, y: number, cell: Cell | undefined): void {
    const v = this.view();
    if (!v) return;
    if (v.dropMode) {
      this.runner.model.addDrop(x, y, store.state.micro.dropSize);
      v.dropMode = false;
      this.updateDropBtn();
      // Событие капли обработается в ближайшем такте; если опыт на паузе — показываем сразу.
      if (!this.runner.running) this.onTick();
      return;
    }
    v.selectedId = cell ? cell.id : null;
    this.lysedSelected = null;
    if (this.tab !== 'experiment') this.setTab('experiment');
    this.updateCellCard(true);
  }
}
