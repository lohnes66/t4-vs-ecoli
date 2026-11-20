/**
 * Единый генератор псевдослучайных чисел с явно заданным seed.
 *
 * Алгоритм — sfc32 (Small Fast Counting), инициализация через splitmix32.
 * Один и тот же seed всегда даёт одну и ту же последовательность в любом браузере:
 * используются только 32-битные целочисленные операции, без Math.random.
 *
 * Все модули (колба, чашка, микроскоп) берут случайные числа отсюда.
 */
export class Rng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    let s = this.seed;
    const splitmix = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = splitmix();
    this.b = splitmix();
    this.c = splitmix();
    this.d = splitmix();
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  /** Независимый поток для подсистемы (например, для отрисовки), не сбивающий основной. */
  fork(label: number): Rng {
    return new Rng((this.seed ^ Math.imul(label + 1, 0x9e3779b1)) >>> 0);
  }

  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Равномерное число в [0, 1). */
  uniform(): number {
    return this.nextU32() / 4294967296;
  }

  /** Стандартное нормальное (метод Бокса — Мюллера). */
  normal(): number {
    let u = this.uniform();
    while (u <= 1e-300) u = this.uniform();
    const v = this.uniform();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Пуассоновское случайное число со средним mean. */
  poisson(mean: number): number {
    if (!(mean > 0)) return 0;
    if (mean < 12) {
      // Метод Кнута (умножение равномерных).
      const L = Math.exp(-mean);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= this.uniform();
      } while (p > L);
      return k - 1;
    }
    if (mean > 1e7) {
      return Math.max(0, Math.round(mean + Math.sqrt(mean) * this.normal()));
    }
    // PTRS (Hörmann, 1993) — быстрый точный метод для больших средних.
    const slam = Math.sqrt(mean);
    const loglam = Math.log(mean);
    const b = 0.931 + 2.53 * slam;
    const a = -0.059 + 0.02483 * b;
    const invalpha = 1.1239 + 1.1328 / (b - 3.4);
    const vr = 0.9277 - 3.6224 / (b - 2);
    for (;;) {
      const U = this.uniform() - 0.5;
      const V = this.uniform();
      const us = 0.5 - Math.abs(U);
      const k = Math.floor(((2 * a) / us + b) * U + mean + 0.43);
      if (us >= 0.07 && V <= vr) return k;
      if (k < 0 || (us < 0.013 && V > us)) continue;
      if (
        Math.log(V) + Math.log(invalpha) - Math.log(a / (us * us) + b) <=
        -mean + k * loglam - logFactorial(k)
      ) {
        return k;
      }
    }
  }

  /** Биномиальное случайное число B(n, p), n — целое. */
  binomial(n: number, p: number): number {
    if (n <= 0 || p <= 0) return 0;
    if (p >= 1) return n;
    if (p > 0.5) return n - this.binomial(n, 1 - p);
    const mean = n * p;
    if (n <= 40) {
      let k = 0;
      for (let i = 0; i < n; i++) if (this.uniform() < p) k++;
      return k;
    }
    if (p < 0.02 || mean < 15) {
      // Для малых p биномиальное практически совпадает с пуассоновским.
      return Math.min(n, this.poisson(mean));
    }
    // Нормальное приближение с поправкой на непрерывность (n·p ≥ 15, n·(1-p) ≥ 15).
    const sd = Math.sqrt(mean * (1 - p));
    const k = Math.round(mean + sd * this.normal());
    return Math.min(n, Math.max(0, k));
  }
}

const LOG_FACT_TABLE: number[] = (() => {
  const t = [0];
  for (let i = 1; i < 256; i++) t[i] = t[i - 1] + Math.log(i);
  return t;
})();

export function logFactorial(k: number): number {
  if (k < 256) return LOG_FACT_TABLE[k];
  // Формула Стирлинга с поправками.
  const x = k + 1;
  return (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI) + 1 / (12 * x) - 1 / (360 * x * x * x);
}

/** Случайный seed для кнопки «новый seed» (единственное место, где используется Math.random). */
export function freshSeed(): number {
  return Math.floor(Math.random() * 900000) + 100000;
}

/** Стандартная нормальная функция распределения Φ(x). */
export function normalCdf(x: number): number {
  // Аппроксимация через erf (Abramowitz & Stegun 7.1.26 даёт 1.5e-7).
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
