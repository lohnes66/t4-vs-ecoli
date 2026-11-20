/** Панели «Что включено в модель» и «Параметры» — общие для всех модулей. */
import { h } from './dom';
import { icon } from './icons';
import { numberField, switchField } from './fields';
import { fmtParam } from './format';
import { store } from '../app/store';
import { PARAM_GROUPS, PARAM_META, MECHANISM_META, PRESET_INFO, type ParamId, type MechanismId } from '../core/params';

export function renderModelPanel(openGroups: Set<string>): HTMLElement {
  const s = store.state;
  const root = h('div', {});

  const mech = h('div', { class: 'card' });
  for (const m of MECHANISM_META) {
    mech.append(
      switchField(m.label, s.mechanisms[m.id as MechanismId], { title: m.label, body: m.description }, (v) =>
        store.setMechanism(m.id as MechanismId, v),
      ),
    );
  }
  root.append(
    h('div', { class: 'section' },
      h('h3', {}, 'Что включено в модель'),
      h('p', { class: 'hint', style: 'margin:0 0 8px' },
        'Сравнение прогонов с включённым и выключенным механизмом — основной метод исследования. Изменения применяются к новому прогону.'),
      mech,
    ),
  );

  const params = h('div', { class: 'section' },
    h('h3', {}, 'Параметры', h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => store.resetParams(), title: 'Вернуть все параметры и механизмы к пресету' }, icon('reset', 12), `Пресет «${PRESET_INFO.name}»`),
    ),
    h('p', { class: 'hint', style: 'margin:0 0 8px' }, PRESET_INFO.description, ' Изменённые значения отмечены точкой.'),
  );
  for (const g of PARAM_GROUPS) {
    const det = h('details', { class: 'group', open: openGroups.has(g.id) });
    det.addEventListener('toggle', () => {
      if (det.open) openGroups.add(g.id);
      else openGroups.delete(g.id);
    });
    const form = h('div', { class: 'form' });
    for (const m of PARAM_META.filter((x) => x.group === g.id)) {
      const id = m.id as ParamId;
      form.append(
        numberField({
          label: m.label,
          unit: m.unit,
          value: s.params[id],
          min: m.min,
          max: m.max,
          step: m.step,
          scale: m.scale,
          defaultValue: m.value,
          tip: () => ({
            title: `${m.label}${m.symbol && m.symbol !== '—' ? ` (${m.symbol})` : ''}`,
            value: `${fmtParam(store.state.params[id], m.scale, m.step)} ${m.unit} · пресет: ${fmtParam(m.value, m.scale, m.step)} · допустимо ${fmtParam(m.min, m.scale, m.step)}–${fmtParam(m.max, m.scale, m.step)}`,
            range: m.range,
            body: m.description,
            sources: m.sources,
            check: 'Значение пресета приведено по памяти — перед сдачей работы сверить с источником.',
          }),
          onChange: (v) => store.setParam(id, v),
        }),
      );
    }
    det.append(h('summary', {}, g.name), form);
    params.append(det);
  }
  root.append(params);
  return root;
}
