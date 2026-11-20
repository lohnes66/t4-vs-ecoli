/** Графики временных рядов (uPlot) в тёмной научной стилистике. */
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { h } from './dom';
import { fmtSci, fmtFixed } from './format';

export interface ChartSeriesDef {
  label: string;
  color: string;
  dash?: number[];
  width?: number;
  /** Скрыт по умолчанию (включается щелчком по легенде). */
  hidden?: boolean;
}

export interface ChartOptions {
  title: string;
  series: ChartSeriesDef[];
  log: boolean;
  height: number;
  yFormat?: (v: number) => string;
  /** Постоянный диапазон оси Y (только для линейной шкалы), например [0, 100] для процентов. */
  yRange?: [number, number];
}

const AXIS = {
  stroke: '#7f909c',
  grid: { stroke: '#1b273280', width: 1 },
  ticks: { stroke: '#1b2732', width: 1 },
  font: '11px Inter, Segoe UI, Roboto, sans-serif',
  labelFont: '11px Inter, Segoe UI, Roboto, sans-serif',
};

export class TimeChart {
  readonly el: HTMLDivElement;
  private plot: uPlot | null = null;
  private opts: ChartOptions;
  private host: HTMLDivElement;
  private titleRight: HTMLSpanElement;
  private useHours = true;
  private ro: ResizeObserver;

  constructor(opts: ChartOptions) {
    this.opts = opts;
    this.titleRight = h('span', {});
    this.host = h('div', {});
    this.el = h('div', { class: 'chart' }, h('div', { class: 'title' }, h('span', {}, opts.title), this.titleRight), this.host);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
  }

  setNote(text: string): void {
    this.titleRight.textContent = text;
  }

  private build(useHours: boolean): void {
    this.plot?.destroy();
    this.useHours = useHours;
    const o = this.opts;
    const yFmt = o.yFormat ?? ((v: number) => (o.log ? fmtSci(v, 1) : fmtFixed(v, 2)));
    const width = Math.max(200, this.el.clientWidth - 10);
    const options: uPlot.Options = {
      width,
      height: o.height,
      pxAlign: false,
      cursor: { drag: { x: false, y: false }, points: { size: 6 } },
      legend: { live: true },
      scales: {
        x: { time: false },
        y: o.log
          ? {
              distr: 3,
              log: 10,
              range: (_u, min, max) => {
                const lo = Number.isFinite(min) && min > 0 ? Math.pow(10, Math.floor(Math.log10(min))) : 1;
                const hi = Number.isFinite(max) && max > 0 ? Math.pow(10, Math.ceil(Math.log10(max))) : 10;
                return [Math.min(lo, hi / 10), hi];
              },
            }
          : o.yRange
            ? { range: (): uPlot.Range.MinMax => [o.yRange![0], o.yRange![1]] }
            : { range: (_u, _min, max) => [0, Math.max(0.05, (Number.isFinite(max) ? max : 0) * 1.1)] },
      },
      axes: [
        {
          ...AXIS,
          label: useHours ? 'время, ч' : 'время, мин',
          labelSize: 16,
          size: 32,
          values: (_u, vals) => vals.map((v) => (useHours ? fmtFixed(v, Number.isInteger(v) ? 0 : 1) : String(Math.round(v)))),
        },
        {
          ...AXIS,
          size: 58,
          values: (_u, vals) => vals.map((v) => (v === null ? '' : yFmt(v))),
          ...(o.log ? { splits: logSplits } : {}),
        },
      ],
      series: [
        { label: useHours ? 'ч' : 'мин', value: (_u, v) => (v === null ? '—' : useHours ? fmtFixed(v, 2) : fmtFixed(v, 1)) },
        ...o.series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: s.width ?? 1.6,
          dash: s.dash,
          show: !s.hidden,
          spanGaps: false,
          points: { show: false },
          value: (_u: uPlot, v: number | null) => (v === null ? '—' : yFmt(v)),
        })),
      ],
    };
    const empty: uPlot.AlignedData = [[], ...o.series.map(() => [])] as any;
    this.plot = new uPlot(options, empty, this.host);
  }

  /** t — время в минутах; ys — значения рядов в порядке определения. */
  setData(t: number[], ys: number[][], durationMin: number): void {
    const useHours = durationMin > 120;
    if (!this.plot || useHours !== this.useHours) this.build(useHours);
    const xs = useHours ? t.map((x) => x / 60) : t;
    const data: (number | null)[][] = [xs];
    for (const y of ys) data.push(this.opts.log ? y.map((v) => (v > 0 ? v : null)) : y);
    const plot = this.plot!;
    plot.batch(() => {
      plot.setData(data as uPlot.AlignedData, false);
      const xmax = useHours ? durationMin / 60 : durationMin;
      plot.setScale('x', { min: 0, max: xmax });
    });
  }

  destroy(): void {
    this.ro.disconnect();
    this.plot?.destroy();
    this.plot = null;
  }

  private resize(): void {
    if (!this.plot) return;
    const w = Math.max(200, this.el.clientWidth - 10);
    if (Math.abs(w - this.plot.width) > 2) this.plot.setSize({ width: w, height: this.opts.height });
  }
}

/** Деления логарифмической оси — только целые степени десяти, не больше ~6 подписей. */
function logSplits(u: uPlot): number[] {
  const sc = u.scales.y;
  const lo = Math.floor(Math.log10(sc.min ?? 1));
  const hi = Math.ceil(Math.log10(sc.max ?? 10));
  const span = hi - lo;
  const stepE = Math.max(1, Math.ceil(span / 6));
  const out: number[] = [];
  for (let e = lo; e <= hi; e += stepE) out.push(Math.pow(10, e));
  return out;
}
