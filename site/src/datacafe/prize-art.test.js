import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_SIZE, COIN_SIZE, paintBillboard, paintCoinFace } from './prize-art.js';
import { billboardView, BILLBOARD, WINNER_PHRASE } from './billboard.js';
import { PRIZES, tickerPhrases } from '../sorteio/prizes.js';

/** Contexto 2D de mentira que anota o texto desenhado e o alfa em que foi desenhado. */
function recorder() {
  const log = [];
  const gradient = { addColorStop() {} };
  const state = { globalAlpha: 1 };
  const context = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'fillText') return (text, x, y) => log.push({ text, x, y, alpha: target.globalAlpha });
      if (key === 'measureText') return text => ({ width: String(text).length * 12 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
      if (key === 'createPattern') return () => ({});
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  return { context, log };
}
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => recorder().context }) };

const canvas = { width: BOARD_SIZE.width, height: BOARD_SIZE.height };
const texts = log => log.map(entry => entry.text);

test('o painel mostra a conta, o 20x, a meta e o ganhador do prêmio da vez', () => {
  const { context, log } = recorder();
  paintBillboard(context, canvas, billboardView(1, { random: () => 0 }), () => null);
  const shown = texts(log);
  assert.ok(shown.includes('CONTA CLAUDE'), shown.join('|'));
  assert.ok(shown.includes(' 20x'));
  assert.ok(shown.includes('AOS 200 NO GRUPO'));
  assert.ok(shown.includes('GANHADOR'));
  assert.ok(shown.some(text => /^SORTEIO NO GRUPO · 1 MÊS$/.test(text)));
  assert.ok(!shown.includes('CONTA CODEX'), 'o seguinte só aparece na fusão');
});

test('na fusão os dois prêmios aparecem, cada um com o seu alfa', () => {
  const { context, log } = recorder();
  const view = billboardView(BILLBOARD.slot - BILLBOARD.fade / 2, { random: () => 0 });
  paintBillboard(context, canvas, view, () => null);
  const claude = log.find(entry => entry.text === 'CONTA CLAUDE'), codex = log.find(entry => entry.text === 'CONTA CODEX');
  assert.ok(claude && codex);
  assert.ok(Math.abs(claude.alpha - 0.5) < 1e-9 && Math.abs(codex.alpha - 0.5) < 1e-9);
  assert.ok(texts(log).includes('AOS 500 NO GRUPO'));
});

test('o letreiro corrido repete todas as frases do sorteio, e a frase do ganhador fecha parada com redução de movimento', () => {
  const { context, log } = recorder();
  paintBillboard(context, canvas, billboardView(0, { calm: true }), () => null);
  const shown = texts(log);
  for (const phrase of tickerPhrases()) assert.ok(shown.includes(phrase), phrase);
  assert.ok(shown.includes(WINNER_PHRASE));
});

test('o letreiro nunca fica sem frases, em nenhum ponto da corrida', () => {
  for (const offset of [0, 17, 999, 123456]) {
    const { context, log } = recorder();
    paintBillboard(context, canvas, { ...billboardView(0, { calm: true }), marquee: offset }, () => null);
    assert.ok(texts(log).filter(text => text === tickerPhrases()[0]).length >= 1, `deslocamento ${offset}`);
  }
});

test('a ficha desenha uma face para cada prêmio, com a marca e o 20x', () => {
  for (const prize of PRIZES) {
    const { context, log } = recorder();
    paintCoinFace(context, { width: COIN_SIZE, height: COIN_SIZE }, prize, { complete: true, naturalWidth: 24 });
    assert.deepEqual(texts(log), [prize.tier]);
  }
  const { context, log } = recorder();
  paintCoinFace(context, { width: COIN_SIZE, height: COIN_SIZE }, PRIZES[0], null);
  assert.deepEqual(texts(log), ['CL', '20x'], 'sem a marca baixada, as iniciais ocupam o lugar');
});
