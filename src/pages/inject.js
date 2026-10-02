// Injeta, no build e no `vite dev`, as tabelas geradas dos dados nas páginas /benchmarks/ e /comparacao/.
// Assim a página é HTML completo (vale para SEO e para quem desliga o JavaScript) e os números têm uma fonte só: data.js.
import benchmarkData from '../benchmarks/data.js';
import { escapeHtml, formatCollectedAt, ownNumberModels, renderBenchmarkTable, renderNotes, vendorsOf } from '../benchmarks/table.js';
import compareData from '../compare/data.js';
import { renderChoices, renderComparisonTable } from '../compare/render.js';

function renderFilters(data) {
  const buttons = vendorsOf(data).map(vendor => `<button type="button" class="chip" data-vendor-filter="${escapeHtml(vendor)}" aria-pressed="false">${escapeHtml(vendor)}</button>`).join('');
  return `<div class="bench-filters" role="group" aria-label="Filtrar por fabricante"><button type="button" class="chip" data-vendor-filter="" aria-pressed="true">Todos</button>${buttons}</div>`;
}

const SECTIONS = {
  BENCHMARK_TABLE: () => renderBenchmarkTable(benchmarkData),
  BENCHMARK_FILTERS: () => renderFilters(benchmarkData),
  BENCHMARK_NOTES: () => renderNotes(benchmarkData),
  BENCHMARK_DATE: () => escapeHtml(formatCollectedAt(benchmarkData.collectedAt) ?? benchmarkData.collectedAt),
  BENCHMARK_COUNT: () => String(ownNumberModels(benchmarkData.models).length),
  COMPARE_TABLE: () => renderComparisonTable(compareData),
  COMPARE_CHOICES: () => renderChoices(compareData),
  COMPARE_DATE: () => escapeHtml(formatCollectedAt(compareData.checkedAt) ?? compareData.checkedAt),
};

const PLACEHOLDER = /<!--([A-Z_]+)-->/g;

export function injectPages(html) {
  return html.replace(PLACEHOLDER, (whole, name) => (SECTIONS[name] ? SECTIONS[name]() : whole));
}

export function unresolvedPlaceholders(html) {
  return [...html.matchAll(PLACEHOLDER)].map(match => match[1]);
}
