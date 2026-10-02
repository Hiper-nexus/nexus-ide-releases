// Monta a página /comparacao/ a partir de `data.js`. Puro e escapado; roda no build (plugin do Vite).
import { escapeHtml, formatCollectedAt } from '../benchmarks/table.js';

/** Domínios em que a fonte de cada concorrente pode estar: a afirmação tem de vir do site do próprio concorrente. */
export const SOURCE_HOSTS = Object.freeze({
  overclock: ['overclock.sh'],
  bridgemind: ['www.bridgemind.ai', 'bridgemind.ai'],
});

const LIVE_SLOT = { price: 'ver na seção Planos', trial: 'ver na seção Planos' };

function sourceLink(url) {
  return /^https:\/\/[^\s"'<>]+$/.test(String(url)) ? ` <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">fonte ↗</a>` : '';
}

function cellHtml(product, cell) {
  const live = cell.live ? ` <span class="compare-live" data-live="${escapeHtml(cell.live)}">${escapeHtml(LIVE_SLOT[cell.live] ?? '…')}</span>` : '';
  const internal = cell.internal ? ` <a href="${escapeHtml(cell.internal)}">ver a página ↗</a>` : '';
  const className = cell.unstated ? ' class="unstated"' : '';
  return `<td${className} data-product="${escapeHtml(product.name)}">${escapeHtml(cell.text)}${live}${sourceLink(cell.source)}${internal}</td>`;
}

export function renderComparisonTable(data) {
  const checked = formatCollectedAt(data.checkedAt);
  const caption = `Comparação conferida em ${checked ?? data.checkedAt} nos sites públicos de cada produto. Os dados dos concorrentes podem mudar.`;
  const head = data.products.map(product => `<th scope="col">${escapeHtml(product.name)}</th>`).join('');
  const body = data.rows.map(row => `<tr><th scope="row">${escapeHtml(row.label)}</th>${data.products.map(product => cellHtml(product, row.cells[product.id])).join('')}</tr>`).join('');
  return `<table class="compare-table"><caption>${escapeHtml(caption)}</caption><thead><tr><th scope="col"><span class="sr-only">Critério</span></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderChoices(data) {
  const names = Object.fromEntries(data.products.map(product => [product.id, product.name]));
  return data.choices.map(choice => `<article class="compare-choice"><h3>Escolha o ${escapeHtml(names[choice.product] ?? choice.product)} se</h3><ul>${choice.when.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></article>`).join('');
}
