import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAW, drawFrame } from './draw.js';

const first = () => 0;

test('no começo do sorteio nenhuma letra da frase aparece, e os espaços ficam no lugar', () => {
  assert.equal(drawFrame('PODE SER VOCÊ', 0, first), 'AAAA AAA AAAA');
});

test('a frase se revela da esquerda para a direita', () => {
  assert.equal(drawFrame('PODE SER VOCÊ', 0.5, first), 'PODE SAA AAAA');
});

test('no fim sobra a frase inteira', () => {
  assert.equal(drawFrame('PODE SER VOCÊ', 1, first), 'PODE SER VOCÊ');
});

test('progresso fora do intervalo não quebra nem muda o tamanho do letreiro', () => {
  assert.equal(drawFrame('PODE SER VOCÊ', -3, first), 'AAAA AAA AAAA');
  assert.equal(drawFrame('PODE SER VOCÊ', 9, first), 'PODE SER VOCÊ');
});

test('as letras embaralhadas saem só do alfabeto do letreiro', () => {
  const last = () => 0.999999;
  const frame = drawFrame('SORTEIO', 0, last);
  assert.equal(frame, DRAW.glyphs.at(-1).repeat(7));
});
