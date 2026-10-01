import test from 'node:test';
import assert from 'node:assert/strict';
import { BILLBOARD, WINNER_PHRASE, billboardView, chaseLevel, bulbRing } from './billboard.js';
import { PRIZES } from '../sorteio/prizes.js';
import { DRAW } from '../sorteio/draw.js';

const zero = () => 0;

test('o painel abre no Claude, que é o próximo a sair', () => {
  const view = billboardView(0, { random: zero });
  assert.equal(view.prize, PRIZES[0]);
  assert.equal(view.next, PRIZES[1]);
  assert.equal(view.blend, 0);
});

test('Claude e Codex se alternam, com a troca em fusão no fim de cada vez', () => {
  const { slot, fade } = BILLBOARD;
  const before = billboardView(slot - fade - 0.01, { random: zero });
  assert.equal(before.prize.id, 'claude');
  assert.equal(before.blend, 0);
  const middle = billboardView(slot - fade / 2, { random: zero });
  assert.equal(middle.prize.id, 'claude');
  assert.equal(middle.next.id, 'codex');
  assert.ok(Math.abs(middle.blend - 0.5) < 1e-9, `fusão no meio: ${middle.blend}`);
  const after = billboardView(slot, { random: zero });
  assert.equal(after.prize.id, 'codex');
  assert.equal(after.blend, 0);
  assert.equal(billboardView(slot * 2, { random: zero }).prize.id, 'claude', 'volta ao começo');
});

test('o ganhador gira com o mesmo ritmo do letreiro da página e fecha em "PODE SER VOCÊ"', () => {
  assert.equal(WINNER_PHRASE, 'PODE SER VOCÊ');
  assert.equal(billboardView(0, { random: zero }).reel, 'AAAA AAA AAAA');
  const settled = billboardView(DRAW.spin / 1000 + 0.05, { random: zero });
  assert.equal(settled.reel, WINNER_PHRASE);
  const cycle = (DRAW.spin + DRAW.hold) / 1000;
  assert.equal(billboardView(cycle - 0.1, { random: zero }).reel, WINNER_PHRASE, 'segue parado até o fim da espera');
  assert.notEqual(billboardView(cycle + 0.05, { random: zero }).reel, WINNER_PHRASE, 'gira de novo no ciclo seguinte');
});

test('o letreiro corrido anda em linha reta, sempre para o mesmo lado', () => {
  const a = billboardView(1, { random: zero }).marquee;
  const b = billboardView(2, { random: zero }).marquee;
  assert.ok(b > a && a > 0);
  assert.ok(Math.abs((b - a) - BILLBOARD.marqueeSpeed) < 1e-9);
});

test('o brilho pulsa devagar e nunca apaga', () => {
  for (let t = 0; t < 10; t += 0.13) {
    const { pulse } = billboardView(t, { random: zero });
    assert.ok(pulse >= 0.62 && pulse <= 1, `pulso ${pulse} em ${t}`);
  }
});

test('com redução de movimento o painel fica parado: Claude, frase fechada, sem fusão, sem corrida', () => {
  for (const t of [0, 3.3, 5.8, 6.1, 99]) {
    const view = billboardView(t, { calm: true, random: zero });
    assert.equal(view.prize.id, 'claude');
    assert.equal(view.blend, 0);
    assert.equal(view.reel, WINNER_PHRASE);
    assert.equal(view.marquee, 0);
    assert.equal(view.chase, 0);
    assert.equal(view.pulse, 1);
  }
});

test('o anel de lâmpadas contorna o painel inteiro e nenhuma lâmpada sai da moldura', () => {
  const ring = bulbRing(4.8, 1.3, 0.24);
  assert.ok(ring.length >= 40, `lâmpadas: ${ring.length}`);
  for (const { x, y } of ring) {
    assert.ok(Math.abs(x) <= 4.8 / 2 + 1e-9 && Math.abs(y) <= 1.3 / 2 + 1e-9, `fora da moldura: ${x},${y}`);
  }
  const top = ring.filter(b => b.y > 0.6).length, bottom = ring.filter(b => b.y < -0.6).length;
  assert.ok(top > 8 && bottom > 8, 'bordas de cima e de baixo');
  assert.equal(new Set(ring.map(b => `${b.x.toFixed(3)},${b.y.toFixed(3)}`)).size, ring.length, 'sem lâmpada em cima de outra');
});

test('a corrida de luz acende um trecho do anel e anda com o tempo', () => {
  const count = 60;
  const levels = phase => Array.from({ length: count }, (_, i) => chaseLevel(i, count, phase));
  const now = levels(0.25), later = levels(0.5);
  for (const level of [...now, ...later]) assert.ok(level >= 0.18 && level <= 1, `nível ${level}`);
  const lit = list => list.filter(level => level > 0.7).length;
  assert.ok(lit(now) >= 4 && lit(now) <= count / 2, `trecho aceso: ${lit(now)}`);
  assert.notDeepEqual(now, later, 'a luz andou');
  const peak = list => list.indexOf(Math.max(...list));
  assert.ok(peak(later) > peak(now), 'anda no sentido do anel');
  const trio = Array.from({ length: count }, (_, i) => chaseLevel(i, count, 0.25, 3));
  assert.equal(trio.filter(level => level > 0.99).length, 3, 'três cabeças, igualmente espaçadas');
  assert.ok([15, 35, 55].every(i => trio[i] > 0.99));
  assert.ok(trio.filter(level => level > 0.7).length <= count / 2, 'e ainda sobra anel apagado');
});
