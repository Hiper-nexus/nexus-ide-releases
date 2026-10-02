import test from 'node:test';
import assert from 'node:assert/strict';
import data from './data.js';
import { BENCHMARKS, aliasNotes, formatCollectedAt, ownNumberModels, renderBenchmarkTable, renderNotes, sortModels } from './table.js';

const model = (key, label, extra = {}) => ({ key, label, vendor: 'Acme', source: 'https://acme.example/card', ...extra });
const sample = {
  collectedAt: '2026-09-28',
  models: [
    model('a:alpha', 'Alpha', { deepSWE: 70.5, terminalBench21: 80 }),
    model('a:beta', 'Beta', { deepSWE: 74.2 }),
    model('a:gamma', 'Gamma', { terminalBench21: 90.1 }),
    model('a:beta-fast', 'Beta Fast', { sameModelAs: 'a:beta' }),
    model('a:delta-preview', 'Delta Preview', { successorOf: 'a:alpha' }),
  ],
};

test('só entra na tabela quem tem número próprio publicado; variante e herança viram nota, nunca linha', () => {
  const labels = ownNumberModels(sample.models).map(item => item.label);
  assert.deepEqual(labels, ['Alpha', 'Beta', 'Gamma']);
  const html = renderBenchmarkTable(sample);
  assert.equal((html.match(/<tr data-vendor=/g) ?? []).length, 3);
  assert.doesNotMatch(html, /Beta Fast|Delta Preview/);
});

test('o número sai exatamente como o fabricante publicou (vírgula decimal, com %), e célula vazia é traço, nunca número', () => {
  const html = renderBenchmarkTable(sample);
  assert.match(html, /74,2%/);
  assert.match(html, /90,1%/);
  assert.match(html, /80%/);
  const betaRow = html.split('<tr data-vendor=').find(row => row.includes('Beta'));
  assert.equal((betaRow.match(/class="empty"/g) ?? []).length, 2, 'Beta só publicou DeepSWE: as outras duas células são vazias');
  assert.doesNotMatch(betaRow, /terminalBench21"[^>]*data-value/);
});

test('a ordem padrão é DeepSWE do maior para o menor, com quem não publicou por último', () => {
  assert.deepEqual(sortModels(sample.models, 'deepSWE').map(item => item.label), ['Beta', 'Alpha', 'Beta Fast', 'Delta Preview', 'Gamma']);
  assert.deepEqual(sortModels(ownNumberModels(sample.models), 'terminalBench21').map(item => item.label), ['Gamma', 'Alpha', 'Beta']);
  assert.deepEqual(ownNumberModels(sample.models).map(item => item.label), ['Alpha', 'Beta', 'Gamma'], 'ordenar não muda a lista original');
});

test('a tabela é acessível: legenda com a data da coleta, cabeçalhos de coluna e de linha, ordenação por botão', () => {
  const html = renderBenchmarkTable(sample);
  assert.match(html, /<caption>[^<]*28 de setembro de 2026/);
  assert.match(html, /<th scope="col"[^>]*aria-sort="descending"[^>]*><button type="button" data-sort="deepSWE">DeepSWE v1\.1<\/button>/);
  assert.match(html, /<th scope="row">Beta<span class="bench-vendor">Acme<\/span><\/th>/);
  for (const benchmark of BENCHMARKS) assert.ok(html.includes(`data-sort="${benchmark.id}"`), benchmark.id);
});

test('toda linha leva a fonte primária: link https que abre seguro, ou texto quando a fonte não é um link', () => {
  const html = renderBenchmarkTable({ ...sample, models: [...sample.models, model('a:eps', 'Eps', { deepSWE: 60, source: 'System Card do fabricante' })] });
  assert.match(html, /<a href="https:\/\/acme\.example\/card" target="_blank" rel="noopener noreferrer">fonte ↗<\/a>/);
  assert.match(html, /System Card do fabricante/);
  assert.doesNotMatch(html, /href="System Card/);
  assert.doesNotMatch(renderBenchmarkTable({ ...sample, models: [model('a:js', 'Js', { deepSWE: 1, source: 'javascript:alert(1)' })] }), /href="javascript:/i);
});

test('tudo que vem dos dados é escapado', () => {
  const evil = { collectedAt: '2026-09-28', models: [model('a:x', '<img src=x onerror=1>', { deepSWE: 50, source: 'https://a.example/"><script>1</script>' })] };
  const html = renderBenchmarkTable(evil) + renderNotes(evil);
  assert.doesNotMatch(html, /<img|<script/i);
  assert.match(html, /&lt;img/);
});

test('as notas dizem qual variante é o mesmo modelo e qual modelo não publicou número próprio', () => {
  const notes = aliasNotes(sample.models);
  assert.deepEqual(notes.sameModel, [{ label: 'Beta Fast', of: 'Beta' }]);
  assert.deepEqual(notes.noOwnNumbers, ['Delta Preview']);
  const html = renderNotes(sample);
  assert.match(html, /Beta Fast.*mesmo modelo.*Beta/s);
  assert.match(html, /Delta Preview.*não tem número próprio/s);
});

test('a data da coleta sai por extenso em português', () => {
  assert.equal(formatCollectedAt('2026-09-28'), '28 de setembro de 2026');
  assert.equal(formatCollectedAt('lixo'), null);
});

test('os 3 maiores números de cada benchmark ganham destaque (data-rank 1 a 3), e traço nunca ganha', () => {
  const html = renderBenchmarkTable({ collectedAt: '2026-09-28', models: [
    model('a:a', 'A', { deepSWE: 80 }), model('a:b', 'B', { deepSWE: 70 }), model('a:c', 'C', { deepSWE: 60 }), model('a:d', 'D', { deepSWE: 50 }), model('a:e', 'E', { terminalBench21: 99 }),
  ] });
  const rowOf = label => html.split('<tr data-vendor=').find(row => row.includes(`>${label}<`));
  assert.match(rowOf('A'), /data-benchmark="deepSWE" data-value="80" data-rank="1"/);
  assert.match(rowOf('C'), /data-benchmark="deepSWE" data-value="60" data-rank="3"/);
  assert.doesNotMatch(rowOf('D'), /data-rank/);
  assert.match(rowOf('E'), /data-benchmark="terminalBench21" data-value="99" data-rank="1"/);
});

// ---- Integridade dos dados reais exportados do app ----
test('dados reais: números entre 0 e 100, chaves únicas, fonte em todo modelo, e nada inventado para quem só herda nota', () => {
  const keys = new Set();
  for (const item of data.models) {
    assert.ok(!keys.has(item.key), `chave repetida ${item.key}`);
    keys.add(item.key);
    assert.ok(typeof item.source === 'string' && item.source.length > 3, `${item.key}: fonte`);
    assert.ok(item.label && item.vendor, `${item.key}: nome e fabricante`);
    for (const benchmark of BENCHMARKS) {
      const value = item[benchmark.id];
      if (value !== undefined) assert.ok(typeof value === 'number' && value > 0 && value <= 100, `${item.key}.${benchmark.id}=${value}`);
    }
    if (item.successorOf || item.sameModelAs) assert.ok(!BENCHMARKS.some(benchmark => item[benchmark.id] !== undefined), `${item.key}: herdeiro/variante não carrega número próprio`);
  }
  assert.ok(ownNumberModels(data.models).length >= 30);
  assert.match(data.collectedAt, /^\d{4}-\d{2}-\d{2}$/);
});
