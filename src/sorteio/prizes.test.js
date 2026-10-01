import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRIZES, nextPrize, goalLine, hudLine, tickerPhrases, DISCLAIMER } from './prizes.js';

test('são dois prêmios, na ordem em que saem: Claude aos 200, Codex aos 500', () => {
  assert.deepEqual(PRIZES.map(p => [p.id, p.goal]), [['claude', 200], ['codex', 500]]);
  assert.ok(PRIZES.every(p => p.tier === '20x' && p.duration === '1 mês'));
});

test('o próximo a sair é sempre o primeiro da fila', () => {
  assert.equal(nextPrize(), PRIZES[0]);
});

test('o prêmio é imutável: nenhum trecho da página consegue reescrever a meta', () => {
  assert.throws(() => { 'use strict'; PRIZES[0].goal = 1; }, TypeError);
  assert.throws(() => { 'use strict'; PRIZES.push({}); }, TypeError);
});

test('a meta diz quantas pessoas, sem inventar contagem atual', () => {
  assert.equal(goalLine(PRIZES[0]), 'aos 200 no grupo');
  assert.equal(goalLine(PRIZES[1]), 'aos 500 no grupo');
  for (const prize of PRIZES) assert.doesNotMatch(goalLine(prize), /faltam|já somos|\d+\s*\/\s*\d+|%/i);
});

test('a linha do HUD abre com o prêmio e fecha com a meta, em caixa alta', () => {
  assert.equal(hudLine(PRIZES[0]), 'SORTEIO · CONTA CLAUDE 20x · AOS 200 NO GRUPO');
  assert.equal(hudLine(PRIZES[1]), 'SORTEIO · CONTA CODEX 20x · AOS 500 NO GRUPO');
});

test('o letreiro corrido cita os dois prêmios e o convite, e nunca promete mais do que existe', () => {
  const phrases = tickerPhrases();
  assert.ok(phrases.length >= 3);
  const text = phrases.join(' | ');
  assert.match(text, /CLAUDE 20x/);
  assert.match(text, /CODEX 20x/);
  assert.match(text, /GRUPO/);
  assert.doesNotMatch(text, /garantid|certeza|todo mundo ganha|compre|assine|R\$/i);
});

test('o aviso fixa as duas regras que o site nunca pode apagar', () => {
  assert.match(DISCLAIMER, /gratuit/i);
  assert.match(DISCLAIMER, /XP/);
  assert.match(DISCLAIMER, /não/i);
});
