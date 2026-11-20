/** Форматирование чисел и времени для интерфейса — по-русски: запятая, «·10ⁿ», «ч/мин». */

const SUP: Record<string, string> = {
  '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
};

export function superscript(n: number | string): string {
  return String(n).split('').map((c) => SUP[c] ?? c).join('');
}

/** 2,3·10⁸ */
export function fmtSci(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  if (x === 0) return '0';
  const sign = x < 0 ? '−' : '';
  const ax = Math.abs(x);
  let e = Math.floor(Math.log10(ax));
  let m = ax / Math.pow(10, e);
  if (Number(m.toFixed(digits)) >= 10) {
    m /= 10;
    e += 1;
  }
  if (e >= -2 && e <= 3) return sign + fmtFixed(ax, Math.max(0, digits - e));
  const ms = m.toFixed(digits).replace('.', ',').replace(/,0+$/, '');
  return `${sign}${ms === '1' ? '' : ms + '·'}10${superscript(e)}`;
}

export function fmtFixed(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return x.toFixed(digits).replace('.', ',').replace('-', '−');
}

/** Численность для счётчика: целые малые числа без экспоненты. */
export function fmtCount(x: number): string {
  if (!Number.isFinite(x)) return '—';
  if (x === 0) return '0';
  if (x < 1) return fmtFixed(x, 2);
  if (x < 10000) return Math.round(x).toLocaleString('ru-RU');
  return fmtSci(x, 1);
}

/** «4 ч 25 мин» */
export function fmtDuration(minutes: number): string {
  const total = Math.max(0, Math.floor(minutes + 1e-6));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} мин`;
  return `${h} ч ${String(m).padStart(2, '0')} мин`;
}

export function fmtClock(minutes: number): string {
  return `инкубация: ${fmtDuration(minutes)}`;
}

/** Значение параметра в зависимости от масштаба ползунка. */
export function fmtParam(x: number, scale: 'linear' | 'log', step: number): string {
  if (scale === 'log' || (Math.abs(x) >= 1e5 && x !== 0)) return fmtSci(x, 1);
  const digits = step > 0 ? Math.max(0, Math.min(4, Math.ceil(-Math.log10(step) - 1e-9))) : 2;
  return fmtFixed(x, digits);
}

/** Разбор ввода пользователя: «1,5», «1e-9», «2·10^8», «2*10^-9», «1·10⁻⁹». */
export function parseNumber(s: string): number {
  let t = s.trim().replace(/\s/g, '').replace(/,/g, '.').replace(/−/g, '-');
  // Number('') === 0: пустое поле не должно превращаться в ноль.
  if (t === '') return NaN;
  const supMap: Record<string, string> = { '⁻': '-', '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
  t = t.replace(/[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => supMap[c]);
  const m = t.match(/^([-+]?\d*\.?\d*)?[·*x×]?10\^?([-+]?\d+)$/);
  if (m && t.includes('10') && /[·*x×^]/.test(t)) {
    const mant = m[1] === undefined || m[1] === '' ? 1 : Number(m[1]);
    return mant * Math.pow(10, Number(m[2]));
  }
  return Number(t);
}
