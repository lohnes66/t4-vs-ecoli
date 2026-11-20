/**
 * Автотесты: те же проверки, что в разделе «Проверка модели» приложения,
 * на пресете «T4 дикого типа» со всеми механизмами.
 */
import { describe, test, expect } from 'vitest';
import { VALIDATION_TESTS } from '../src/core/validation/suite';
import { defaultParams, defaultMechanisms } from '../src/core/params';

describe('Проверка модели (пресет T4 дикого типа)', () => {
  for (const t of VALIDATION_TESTS) {
    const fn = t.run;
    if (!fn) {
      test.skip(`${t.name} — ${t.pendingNote}`, () => {});
      continue;
    }
    test(t.name, { timeout: 60000 }, () => {
      for (const seed of [20261108, 1, 2]) {
        const r = fn({ params: defaultParams(), mechanisms: defaultMechanisms(), seed });
        console.log(`${t.name} [seed ${seed}]: ${r.value}${r.details ? ' — ' + r.details : ''}`);
        expect(r.passed, `${t.criterion}: ${r.value}`).toBe(true);
      }
    });
  }
});
