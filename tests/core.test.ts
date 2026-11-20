import { describe, test, expect } from 'vitest';
import { Rng, normalCdf } from '../src/core/rng';
import { csvNumber } from '../src/core/export/csv';
import { FlaskModel, DEFAULT_FLASK_CONDITIONS } from '../src/core/flask/model';
import { defaultParams, defaultMechanisms } from '../src/core/params';

describe('генератор случайных чисел', () => {
  test('один seed — одна последовательность', () => {
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });
  test('пуассон и бином имеют правильное среднее', () => {
    const r = new Rng(1);
    for (const mean of [0.3, 5, 40, 900]) {
      let s = 0;
      const n = 20000;
      for (let i = 0; i < n; i++) s += r.poisson(mean);
      expect(Math.abs(s / n - mean) / mean).toBeLessThan(0.03);
    }
    let s = 0;
    for (let i = 0; i < 20000; i++) s += r.binomial(200, 0.3);
    expect(Math.abs(s / 20000 - 60)).toBeLessThan(0.5);
  });
  test('Φ(x)', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });
});

describe('колба', () => {
  test('без фага культура растёт до предельной плотности Y·N₀', () => {
    const p = defaultParams();
    const m = new FlaskModel(p, defaultMechanisms(), { ...DEFAULT_FLASK_CONDITIONS, moi: 0, duration: 900 }, 1);
    m.runToEnd();
    const s = m.snapshot();
    const cap = p.yield * DEFAULT_FLASK_CONDITIONS.substrateMM; // клеток/мл (мкмоль/мл × клеток/мкмоль)
    expect((s.S + s.R) / cap).toBeGreaterThan(0.98);
    expect((s.S + s.R) / cap).toBeLessThan(1.02);
  });
  test('время удвоения в экспоненциальной фазе = 20 мин', () => {
    const m = new FlaskModel(defaultParams(), defaultMechanisms(), { ...DEFAULT_FLASK_CONDITIONS, moi: 0, duration: 60 }, 1);
    const n0 = m.S + m.R;
    m.runToEnd();
    expect((m.S + m.R) / n0).toBeCloseTo(8, 1);
  });
  test('число фагов и клеток не отрицательно, когорт немного', () => {
    const m = new FlaskModel(defaultParams(), defaultMechanisms(), { ...DEFAULT_FLASK_CONDITIONS, moi: 5, phageTime: 30 }, 3);
    while (!m.done) {
      m.advance(10);
      expect(m.S).toBeGreaterThanOrEqual(0);
      expect(m.Pwt).toBeGreaterThanOrEqual(0);
      expect(m.cohorts.length).toBeLessThan(2000);
    }
  });
});

describe('CSV', () => {
  test('десятичная запятая и экспонента', () => {
    expect(csvNumber(1.5)).toBe('1,5');
    expect(csvNumber(2.5e8)).toBe('2,5000E+08');
    expect(csvNumber(1e-9)).toBe('1,0000E-09');
  });
});

import { MicroscopeModel } from '../src/core/microscope/model';
import { microScenario } from '../src/core/microscope/scenarios';

describe('микроскоп', () => {
  test('один seed — одна и та же колония', () => {
    const cond = { ...microScenario('attack').conditions, duration: 30 };
    const run = (seed: number) => {
      const m = new MicroscopeModel(defaultParams(), defaultMechanisms(), cond, seed);
      m.advance(30);
      return m.cells.map((c) => `${c.id}:${c.x.toFixed(6)}:${c.y.toFixed(6)}:${c.state}`).join('|');
    };
    expect(run(5)).toBe(run(5));
    expect(run(5)).not.toBe(run(6));
  });
  test('без фага клетки не заражаются, а колония растёт', () => {
    const m = new MicroscopeModel(defaultParams(), defaultMechanisms(), microScenario('colony-grows').conditions, 1);
    m.advance(60);
    const s = m.snapshot();
    expect(s.I + s.LI).toBe(0);
    expect(s.cells).toBeGreaterThanOrEqual(6);
  });
});
