import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRIZES, goalLine, DISCLAIMER } from './prizes.js';

const home = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const community = readFileSync(new URL('../../comunidade/index.html', import.meta.url), 'utf8');

test('a home e a comunidade falam dos mesmos prêmios que a fonte única', () => {
  for (const page of [home, community]) {
    for (const prize of PRIZES) {
      assert.ok(page.includes(`${prize.brand} ${prize.tier}`), `${prize.brand} ${prize.tier}`);
      assert.ok(page.includes(`${prize.goal}`), `meta de ${prize.goal}`);
    }
  }
});

test('o convite do sorteio nunca vira cadastro nem promessa de ganho', () => {
  for (const page of [home, community]) {
    assert.doesNotMatch(page, /<form/i);
    assert.doesNotMatch(page, /garantid|certeza de ganhar|todo mundo ganha|dobra as chances/i);
  }
  assert.match(community, /não aumentam chances|nem mudam as chances|não registram/i);
});

test('a meta do primeiro prêmio aparece na primeira tela da comunidade e na faixa da home', () => {
  assert.ok(community.includes('intro-prize') && community.includes(goalLine(PRIZES[0]).toUpperCase()));
  assert.ok(home.includes('prize-ticket') && home.includes(goalLine(PRIZES[0]).toUpperCase()));
});

test('a faixa do prêmio na home repete o aviso: gratuito, e jogar ou XP não mudam as chances', () => {
  assert.ok(home.includes(DISCLAIMER));
});
