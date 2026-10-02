// Monta a tabela pública de benchmarks a partir de `data.js`. Puro: sem DOM, sem rede, sem relógio. Roda no build (plugin do Vite)
// e no navegador (ordenação). Regras: o número sai como o fabricante publicou; célula sem número é traço, nunca estimativa;
// variante "mesmo modelo" e modelo que só herda nota viram NOTA, nunca linha com número.

export const BENCHMARKS = Object.freeze([
  { id: 'deepSWE', label: 'DeepSWE v1.1', hint: 'engenharia de software em tarefas reais' },
  { id: 'terminalBench21', label: 'Terminal-Bench 2.1', hint: 'tarefas de terminal' },
  { id: 'swebenchVerified', label: 'SWE-bench Verified', hint: 'correção de issues reais' },
]);

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function formatCollectedAt(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} de ${month} de ${match[1]}` : null;
}

export function formatPercent(value) {
  return `${String(value).replace('.', ',')}%`;
}

const hasOwnNumber = model => BENCHMARKS.some(benchmark => typeof model[benchmark.id] === 'number');

export function ownNumberModels(models) {
  return models.filter(hasOwnNumber);
}

/** Ordena do maior para o menor no benchmark pedido; quem não publicou vai por último, em ordem alfabética. Não muda a entrada. */
export function sortModels(models, benchmarkId = 'deepSWE') {
  return [...models].sort((left, right) => {
    const a = typeof left[benchmarkId] === 'number' ? left[benchmarkId] : -Infinity;
    const b = typeof right[benchmarkId] === 'number' ? right[benchmarkId] : -Infinity;
    return a === b ? left.label.localeCompare(right.label, 'pt-BR') : b - a;
  });
}

export function aliasNotes(models) {
  const byKey = new Map(models.map(model => [model.key, model]));
  return {
    sameModel: models.filter(model => model.sameModelAs && byKey.has(model.sameModelAs)).map(model => ({ label: model.label, of: byKey.get(model.sameModelAs).label })),
    noOwnNumbers: models.filter(model => model.successorOf && !hasOwnNumber(model)).map(model => model.label),
  };
}

/** Link só se for https; qualquer outra coisa (inclusive `javascript:`) sai como texto. */
function sourceHtml(source) {
  const text = String(source);
  if (/^https:\/\/[^\s"'<>]+$/.test(text)) return `<a href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer">fonte ↗</a>`;
  return `<span class="bench-source-text">${escapeHtml(text)}</span>`;
}

function rangeFor(models, benchmarkId) {
  const values = models.map(model => model[benchmarkId]).filter(value => typeof value === 'number');
  return { min: Math.min(...values), max: Math.max(...values) };
}

const TOP_RANKS = 3;

/** Posição (1 a 3) do valor entre os maiores do benchmark; empate divide a posição. Fora do pódio: nenhuma. */
function rankOf(value, sortedDescending) {
  const rank = sortedDescending.findIndex(other => other === value) + 1;
  return rank >= 1 && rank <= TOP_RANKS ? rank : null;
}

function cellHtml(model, benchmark, range, sortedValues) {
  const value = model[benchmark.id];
  if (typeof value !== 'number') return `<td class="empty" data-benchmark="${benchmark.id}"><span aria-label="não publicado pelo fabricante">—</span></td>`;
  const span = range.max - range.min || 1;
  const ratio = Math.max(0.04, (value - range.min) / span);
  const rank = rankOf(value, sortedValues);
  return `<td data-benchmark="${benchmark.id}" data-value="${value}"${rank ? ` data-rank="${rank}"` : ''}><span class="bench-value">${formatPercent(value)}</span><span class="bench-bar" aria-hidden="true" style="--v:${ratio.toFixed(3)}"></span></td>`;
}

export function renderBenchmarkTable(data) {
  const rows = sortModels(ownNumberModels(data.models), 'deepSWE');
  const ranges = Object.fromEntries(BENCHMARKS.map(benchmark => [benchmark.id, rangeFor(rows, benchmark.id)]));
  const sorted = Object.fromEntries(BENCHMARKS.map(benchmark => [benchmark.id, rows.map(model => model[benchmark.id]).filter(value => typeof value === 'number').sort((a, b) => b - a)]));
  const collected = formatCollectedAt(data.collectedAt);
  const caption = `Números oficiais dos fabricantes${collected ? `, coletados em ${collected}` : ''}. Traço (—) significa que o fabricante não publicou o número.`;
  const head = BENCHMARKS.map((benchmark, index) => `<th scope="col"${index === 0 ? ' aria-sort="descending"' : ''}><button type="button" data-sort="${benchmark.id}">${escapeHtml(benchmark.label)}</button></th>`).join('');
  const body = rows.map(model => `<tr data-vendor="${escapeHtml(model.vendor)}"><th scope="row">${escapeHtml(model.label)}<span class="bench-vendor">${escapeHtml(model.vendor)}</span></th>${BENCHMARKS.map(benchmark => cellHtml(model, benchmark, ranges[benchmark.id], sorted[benchmark.id])).join('')}<td class="bench-source">${sourceHtml(model.source)}</td></tr>`).join('');
  return `<table class="bench-table" id="bench-table"><caption>${escapeHtml(caption)}</caption><thead><tr><th scope="col">Modelo</th>${head}<th scope="col">Fonte</th></tr></thead><tbody>${body}</tbody></table>`;
}

export function renderNotes(data) {
  const notes = aliasNotes(data.models);
  const items = [
    ...notes.sameModel.map(item => `<li><strong>${escapeHtml(item.label)}</strong> é o mesmo modelo que ${escapeHtml(item.of)}, servido mais rápido, segundo o fabricante.</li>`),
    ...notes.noOwnNumbers.map(label => `<li><strong>${escapeHtml(label)}</strong> ainda não tem número próprio publicado: fica de fora da tabela.</li>`),
  ];
  return items.length === 0 ? '' : `<ul class="bench-notes">${items.join('')}</ul>`;
}

/** Vendors distintos, na ordem em que aparecem na tabela ordenada (para os filtros). */
export function vendorsOf(data) {
  return [...new Set(sortModels(ownNumberModels(data.models), 'deepSWE').map(model => model.vendor))];
}
