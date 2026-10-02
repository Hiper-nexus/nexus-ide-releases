import '@fontsource-variable/geist';
import './content.css';
import { browserPlatform } from './downloads/platform.js';
import { nextSort, sortByValue } from './benchmarks/sort.js';

// Botões "Baixar": o link permanente de cada sistema (sempre a última release) conforme o computador de quem visita.
async function recommendDownload() {
  const device = await browserPlatform(navigator);
  const target = device.os === 'macos' ? ['/download/macos', 'macOS'] : device.os === 'windows' ? ['/download/windows', 'Windows'] : null;
  if (!target) return;
  for (const anchor of document.querySelectorAll('[data-recommended-download]')) {
    anchor.href = target[0];
    anchor.textContent = `Baixar para ${target[1]} ↗`;
  }
}
void recommendDownload().catch(() => {});

function initializeBenchmarkTable() {
  const table = document.getElementById('bench-table');
  if (!table) return;
  const body = table.tBodies[0];
  const rows = [...body.rows];
  const count = document.getElementById('bench-count');
  const state = { sort: { id: 'deepSWE', direction: 'desc' }, vendor: '' };
  const valueOf = (row, id) => {
    const cell = row.querySelector(`td[data-benchmark="${id}"]`);
    const parsed = cell ? Number.parseFloat(cell.dataset.value ?? '') : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  const render = () => {
    const items = rows.map(row => ({ row, label: row.querySelector('th[scope="row"]').firstChild.textContent, value: valueOf(row, state.sort.id) }));
    for (const item of sortByValue(items, state.sort.direction)) body.append(item.row);
    let visible = 0;
    for (const row of rows) {
      const show = state.vendor === '' || row.dataset.vendor === state.vendor;
      row.hidden = !show;
      if (show) visible += 1;
    }
    for (const header of table.tHead.querySelectorAll('th')) {
      const id = header.querySelector('button')?.dataset.sort;
      if (id === state.sort.id) header.setAttribute('aria-sort', state.sort.direction === 'desc' ? 'descending' : 'ascending');
      else header.removeAttribute('aria-sort');
    }
    if (count) count.textContent = `${visible} ${visible === 1 ? 'modelo' : 'modelos'}`;
  };
  table.tHead.addEventListener('click', event => {
    const button = event.target.closest('button[data-sort]');
    if (!button) return;
    state.sort = nextSort(state.sort, button.dataset.sort);
    render();
  });
  document.querySelector('.bench-filters')?.addEventListener('click', event => {
    const chip = event.target.closest('button[data-vendor-filter]');
    if (!chip) return;
    state.vendor = chip.dataset.vendorFilter;
    for (const other of document.querySelectorAll('[data-vendor-filter]')) other.setAttribute('aria-pressed', String(other === chip));
    render();
  });
  render();
}
initializeBenchmarkTable();
