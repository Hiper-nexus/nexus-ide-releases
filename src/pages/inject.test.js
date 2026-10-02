import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { injectPages, unresolvedPlaceholders } from './inject.js';

test('os marcadores das páginas viram HTML dos dados, e a página pronta não tem marcador sobrando', () => {
  for (const file of ['benchmarks/index.html']) {
    const html = injectPages(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
    assert.deepEqual(unresolvedPlaceholders(html), [], file);
  }
});

test('a página de benchmarks recebe tabela, filtros por fabricante, notas e data', () => {
  const html = injectPages(readFileSync(new URL('../../benchmarks/index.html', import.meta.url), 'utf8'));
  assert.match(html, /<table class="bench-table"/);
  assert.match(html, /data-vendor-filter="Anthropic"/);
  assert.match(html, /bench-notes/);
  assert.match(html, /28 de setembro de 2026/);
});

test('marcador desconhecido continua à vista (não some em silêncio)', () => {
  assert.deepEqual(unresolvedPlaceholders('<p><!--ALGO_NOVO--></p>'), ['ALGO_NOVO']);
});
