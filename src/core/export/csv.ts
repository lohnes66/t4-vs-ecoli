/**
 * Выгрузка данных в CSV для русской локали Excel: разделитель «;», десятичная запятая,
 * кодировка UTF-8 с BOM (иначе Excel покажет кириллицу «кракозябрами»).
 *
 * В начало файла записывается полный список условий, параметров, включённых механизмов
 * и seed — чтобы данные в работе всегда сопровождались описанием модели.
 */
import { PARAM_META, MECHANISM_META, PRESET_INFO, type Params, type Mechanisms, type ParamId, type MechanismId } from '../params';

export const BOM = '﻿';

/** Число в русском формате Excel: «1,234», «2,5E+08». */
export function csvNumber(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '';
  if (x === 0) return '0';
  const ax = Math.abs(x);
  if (ax >= 1e6 || ax < 1e-3) {
    const [mant, exp] = x.toExponential(4).split('e');
    const e = Number(exp);
    return `${mant.replace('.', ',')}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  }
  return String(Number(x.toPrecision(6))).replace('.', ',');
}

export function csvCell(v: string | number | boolean | null | undefined): string {
  if (typeof v === 'number') return csvNumber(v);
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  const s = v ?? '';
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: (string | number | boolean | null | undefined)[]): string {
  return cells.map(csvCell).join(';');
}

export interface ModelDescription {
  title: string;
  scenario: string;
  seed: number;
  conditions: { label: string; value: number | string; unit: string }[];
  params: Params;
  mechanisms: Mechanisms;
}

export function describeModel(d: ModelDescription): string[] {
  const rows: string[] = [];
  rows.push(csvRow([d.title]));
  rows.push(csvRow(['Дата выгрузки', new Date().toLocaleString('ru-RU')]));
  rows.push(csvRow(['Сценарий', d.scenario]));
  rows.push(csvRow(['Seed генератора', String(d.seed)]));
  rows.push(csvRow(['Пресет параметров', PRESET_INFO.name]));
  rows.push('');
  rows.push(csvRow(['Условия опыта', 'Значение', 'Единицы']));
  for (const c of d.conditions) rows.push(csvRow([c.label, c.value, c.unit]));
  rows.push('');
  rows.push(csvRow(['Параметр', 'Обозначение', 'Значение', 'Единицы', 'Значение пресета']));
  for (const m of PARAM_META) rows.push(csvRow([m.label, m.symbol, d.params[m.id as ParamId], m.unit, m.value]));
  rows.push('');
  rows.push(csvRow(['Механизм', 'Включён']));
  for (const m of MECHANISM_META) rows.push(csvRow([m.label, d.mechanisms[m.id as MechanismId]]));
  rows.push('');
  return rows;
}

export interface Column {
  header: string;
  values: number[];
}

/** Таблица временного ряда с заданным шагом (в минутах) по времени. */
export function timeSeriesTable(t: number[], columns: Column[], stepMin: number): string[] {
  const rows: string[] = [csvRow(['Время, мин', 'Время, ч', ...columns.map((c) => c.header)])];
  let next = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] + 1e-9 < next) continue;
    rows.push(csvRow([t[i], t[i] / 60, ...columns.map((c) => c.values[i])]));
    while (next <= t[i] + 1e-9) next += stepMin;
  }
  return rows;
}

export function joinCsv(rows: string[]): string {
  return BOM + rows.join('\r\n') + '\r\n';
}
