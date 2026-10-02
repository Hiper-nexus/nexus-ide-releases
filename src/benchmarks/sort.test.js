import test from 'node:test';
import assert from 'node:assert/strict';
import { nextSort, sortByValue } from './sort.js';

const items = [
  { id: 'a', label: 'Alpha', value: 70 }, { id: 'b', label: 'Beta', value: null }, { id: 'c', label: 'Gamma', value: 90 }, { id: 'd', label: 'Delta', value: 70 },
];

test('ordena do maior para o menor, com empate em ordem alfabética e sem número sempre por último', () => {
  assert.deepEqual(sortByValue(items, 'desc').map(item => item.id), ['c', 'a', 'd', 'b']);
});

test('do menor para o maior, quem não publicou continua por último (nunca vira o menor)', () => {
  assert.deepEqual(sortByValue(items, 'asc').map(item => item.id), ['a', 'd', 'c', 'b']);
});

test('não muda a lista original', () => {
  const copy = items.map(item => item.id);
  sortByValue(items, 'asc');
  assert.deepEqual(items.map(item => item.id), copy);
});

test('clicar no mesmo benchmark inverte a direção; outro benchmark começa do maior', () => {
  assert.deepEqual(nextSort({ id: 'deepSWE', direction: 'desc' }, 'deepSWE'), { id: 'deepSWE', direction: 'asc' });
  assert.deepEqual(nextSort({ id: 'deepSWE', direction: 'asc' }, 'deepSWE'), { id: 'deepSWE', direction: 'desc' });
  assert.deepEqual(nextSort({ id: 'deepSWE', direction: 'asc' }, 'terminalBench21'), { id: 'terminalBench21', direction: 'desc' });
});
