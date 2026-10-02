import test from 'node:test';
import assert from 'node:assert/strict';
import { chipParts, stationRows, groupStation } from './prize-ui.js';
import { PRIZES, hudLine, DISCLAIMER } from '../sorteio/prizes.js';

test('o chip do HUD abre com "sorteio", cita o prêmio e a meta, e o rótulo falado é a linha inteira', () => {
  const chip = chipParts(PRIZES[0]);
  assert.deepEqual(chip.parts, ['SORTEIO', 'CONTA CLAUDE 20x', 'AOS 200 NO GRUPO']);
  assert.equal(chip.label, hudLine(PRIZES[0]));
  assert.equal(chip.parts.join(' · '), chip.label);
});

test('o painel do sorteio lista os dois prêmios como bilhetes, com o Claude em destaque', () => {
  const rows = stationRows();
  assert.equal(rows.length, PRIZES.length);
  assert.deepEqual(rows.map(row => row.name), ['Conta Claude 20x', 'Conta Codex 20x']);
  assert.deepEqual(rows.map(row => row.goal), ['Aos 200 no grupo', 'Aos 500 no grupo']);
  assert.deepEqual(rows.map(row => row.next), [true, false]);
  assert.equal(rows[0].badge, 'PRÓXIMO A SAIR');
  assert.equal(rows[1].badge, 'NA SEQUÊNCIA');
  assert.match(rows[0].meta, /1 mês/);
  assert.match(rows[0].meta, /primeira live/);
  assert.match(rows[1].meta, /segunda live/);
});

test('o painel do grupo mantém o convite, o aviso de regras e nada de contagem de membros', () => {
  const group = groupStation('https://example.test/grupo');
  assert.equal(group.url, 'https://example.test/grupo');
  assert.equal(group.whatsapp, true);
  assert.equal(group.note, DISCLAIMER);
  assert.match(group.copy, /ao vivo/i);
  assert.match(group.title, /inscrição/i);
  const everything = JSON.stringify(group) + JSON.stringify(stationRows());
  assert.doesNotMatch(everything, /faltam|já somos|\d+\s*\/\s*\d+|membros ativos/i);
  assert.equal(group.prizes.length, PRIZES.length);
});
