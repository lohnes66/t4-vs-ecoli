/**
 * Управление временем опыта (общее для всех модулей): пуск/пауза/шаг, скорость
 * проигрывания (1× — реальное время, 1000× — тысячекратное ускорение) и «инкубировать до…».
 */

/** Всё, что нужно контроллеру от модели. */
export interface Steppable {
  readonly t: number;
  readonly done: boolean;
  readonly duration: number;
  advance(minutes: number): void;
}

export type RunnerEvent = 'tick' | 'reset' | 'status' | 'finished';
type Listener = (e: RunnerEvent) => void;

/** Сколько миллисекунд расчёта допускается за кадр — чтобы анимация не замирала. */
const FRAME_BUDGET_MS = 28;

export class Runner<M extends Steppable> {
  model!: M;
  running = false;
  /** Скорость проигрывания: минут модели за минуту реального времени. */
  speed: number;
  /** Цель «инкубировать до…», мин; пока задана, считаем максимально быстро. */
  target: number | null = null;
  /** Не успеваем за заданной скоростью (слабый компьютер или очень высокая скорость). */
  lagging = false;
  private listeners: Listener[] = [];
  private lastFrame = 0;
  private raf = 0;
  /** Шаг кнопки «шаг», мин. */
  readonly stepMinutes: number;
  /** Если false — цикл не крутится (модуль скрыт). */
  active = true;

  constructor(private create: () => M, opts: { speed: number; stepMinutes: number }) {
    this.speed = opts.speed;
    this.stepMinutes = opts.stepMinutes;
    this.reset();
    const loop = (now: number) => {
      // Следующий кадр планируем заранее: ошибка в отрисовке или панели не должна останавливать время опыта.
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  on(fn: Listener): void {
    this.listeners.push(fn);
  }

  private emit(e: RunnerEvent): void {
    for (const l of this.listeners) l(e);
  }

  reset(): void {
    this.model = this.create();
    this.running = false;
    this.target = null;
    this.emit('reset');
    this.emit('status');
  }

  play(): void {
    if (this.model.done) this.reset();
    this.running = true;
    this.emit('status');
  }

  pause(): void {
    if (!this.running && this.target === null) return;
    this.running = false;
    this.target = null;
    this.emit('status');
  }

  toggle(): void {
    if (this.running) this.pause();
    else this.play();
  }

  stepOnce(): void {
    if (this.model.done) return;
    this.running = false;
    this.target = null;
    this.model.advance(this.stepMinutes);
    this.emit('tick');
    this.emit('status');
    if (this.model.done) this.emit('finished');
  }

  runUntil(minutes: number): void {
    const t = Math.min(this.model.duration, Math.max(0, minutes));
    if (t <= this.model.t) return;
    this.target = t;
    this.running = true;
    this.emit('status');
  }

  private frame(now: number): void {
    const dtReal = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    if (!this.running || !this.active) return;
    const m = this.model;
    const t0 = performance.now();
    if (this.target !== null) {
      while (m.t < this.target - 1e-9 && performance.now() - t0 < FRAME_BUDGET_MS) {
        m.advance(Math.min(0.5, this.target - m.t));
      }
      if (m.t >= this.target - 1e-9) {
        this.target = null;
        this.running = false;
        this.emit('status');
      }
    } else {
      // Продвигаемся порциями и останавливаемся, если кончился бюджет кадра.
      let want = (this.speed * dtReal) / 60;
      const chunk = Math.max(want / 8, 0.05);
      while (want > 1e-9 && !m.done) {
        const d = Math.min(chunk, want);
        m.advance(d);
        want -= d;
        if (performance.now() - t0 > FRAME_BUDGET_MS) break;
      }
      this.lagging = want > 1e-6 && !m.done;
    }
    this.emit('tick');
    if (m.done) {
      this.running = false;
      this.target = null;
      this.emit('status');
      this.emit('finished');
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
  }
}
