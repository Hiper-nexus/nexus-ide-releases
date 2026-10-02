import test from 'node:test';
import assert from 'node:assert/strict';
import data from './data.js';
import { SOURCE_HOSTS, renderChoices, renderComparisonTable } from './render.js';

const COMPETITORS = data.products.filter(product => product.id !== 'nexus');

test('toda linha tem uma célula para cada produto, com texto', () => {
  for (const row of data.rows) {
    assert.ok(row.label, `${row.id}: rótulo`);
    for (const product of data.products) {
      const cell = row.cells[product.id];
      assert.ok(cell && typeof cell.text === 'string' && cell.text.length > 2, `${row.id}/${product.id}: texto`);
    }
  }
});

test('toda afirmação sobre um concorrente traz a fonte (https, no domínio do próprio concorrente), ou diz que o site não informa', () => {
  for (const row of data.rows) {
    for (const product of COMPETITORS) {
      const cell = row.cells[product.id];
      if (cell.unstated) { assert.equal(cell.source, undefined, `${row.id}/${product.id}: "não informado" não cita fonte`); continue; }
      assert.match(cell.source, /^https:\/\//, `${row.id}/${product.id}: fonte https`);
      assert.ok(SOURCE_HOSTS[product.id].includes(new URL(cell.source).hostname), `${row.id}/${product.id}: ${cell.source} fora do domínio do concorrente`);
    }
  }
});

test('a página não é propaganda: nenhum adjetivo de superioridade nas células nem nas escolhas', () => {
  const SUPERLATIVE = /\b(melhor|pior|superior|inferior|líder|número\s*1|o mais|a mais|imbatível|revolucion)/i;
  for (const row of data.rows) for (const product of data.products) assert.doesNotMatch(row.cells[product.id].text, SUPERLATIVE, `${row.id}/${product.id}`);
  for (const choice of data.choices) assert.doesNotMatch(choice.when.join(' '), SUPERLATIVE, choice.product);
});

test('a data da conferência é válida e aparece na página, com a ressalva de que os dados dos outros podem mudar', () => {
  assert.match(data.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
  const html = renderComparisonTable(data);
  assert.match(html, /2 de outubro de 2026/);
  assert.match(html, /podem mudar/);
});

test('o HTML é uma tabela acessível: legenda, colunas por produto, linha com th scope=row, fonte como link seguro', () => {
  const html = renderComparisonTable(data);
  assert.match(html, /<caption>/);
  for (const product of data.products) assert.ok(html.includes(`>${product.name}</th>`), product.name);
  assert.equal((html.match(/<th scope="row">/g) ?? []).length, data.rows.length);
  assert.match(html, /<a href="https:\/\/[^"]+" target="_blank" rel="noopener noreferrer">fonte ↗<\/a>/);
  assert.doesNotMatch(html, /href="javascript:/i);
});

test('valores do Nexus que mudam (preço, dias de teste) vêm da API ao vivo, nunca escritos na página', () => {
  const html = renderComparisonTable(data);
  assert.match(html, /data-live="price"/);
  assert.match(html, /data-live="trial"/);
  assert.doesNotMatch(html, /R\$\s?\d/);
});

test('tudo que vem dos dados é escapado', () => {
  const evil = { checkedAt: '2026-10-02', products: [{ id: 'nexus', name: '<b>N</b>' }, { id: 'overclock', name: 'O' }, { id: 'bridgemind', name: 'B' }],
    rows: [{ id: 'x', label: '<i>x</i>', cells: { nexus: { text: '<script>1</script>' }, overclock: { text: 'a', source: 'https://overclock.sh/"><img>' }, bridgemind: { text: 'b', unstated: true } } }], choices: [] };
  const html = renderComparisonTable(evil);
  assert.doesNotMatch(html, /<script|<img|<b>|<i>/i);
});

test('"quando escolher cada um" inclui o Nexus e os dois concorrentes, e admite onde o concorrente serve melhor o caso (sem usar superlativo)', () => {
  assert.deepEqual(data.choices.map(choice => choice.product), ['nexus', 'overclock', 'bridgemind']);
  for (const choice of data.choices) assert.ok(choice.when.length >= 2, choice.product);
  const html = renderChoices(data);
  assert.match(html, /Linux/);
  assert.equal((html.match(/<article/g) ?? []).length, 3);
});
