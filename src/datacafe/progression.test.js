import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgression, scoreTicket, progressionStep, closeShift, awardMessage } from './progression.js';
import { initialProgress } from './progress.js';
import { COMBO } from './combo.js';
import { SHIFT_SECONDS } from './shift.js';

const install = id => ({ id: `install:${id}`, kind: 'install', rackId: id, xp: 60 });
const pool = [
  { id: 'a', text: 'Ligue 2 racks', kind: 'install', goal: 2, xp: 50 },
  { id: 'b', text: 'Resolva 1 incidente', kind: 'incident', goal: 1, xp: 70 },
];

test('entrega em sequência multiplica o XP, soma no turno e guarda o melhor combo', () => {
  let game = createProgression(pool);
  let step = scoreTicket(game, initialProgress(), install('claude'), pool);
  assert.equal(step.xpGained, 60);
  assert.equal(step.multiplier, 1);
  step = scoreTicket(step.state, step.progress, install('codex'), pool);
  assert.equal(step.multiplier, 1 + COMBO.step);
  assert.equal(step.xpGained, Math.round(60 * (1 + COMBO.step)));
  assert.equal(step.progress.bestCombo, 2);
  assert.deepEqual(step.finished.map(mission => mission.id), ['a'], 'a missão de ligar 2 racks fechou');
  assert.equal(step.bonus, 50);
  assert.equal(step.progress.xp, 60 + step.xpGained + 50);
  assert.equal(step.progress.missions, 1);
  assert.equal(step.state.shift.score, 60 + step.xpGained + 50);
});

test('café não entra no combo nem o quebra', () => {
  const game = createProgression(pool);
  const first = scoreTicket(game, initialProgress(), install('claude'), pool);
  const coffee = scoreTicket(first.state, first.progress, { id: 'coffee', kind: 'coffee', xp: 10 }, pool);
  assert.equal(coffee.multiplier, 1);
  assert.equal(coffee.state.combo.streak, 1);
  assert.equal(coffee.xpGained, 10);
});

test('o tempo derruba o combo e fecha o turno; o recorde só sobe', () => {
  const game = createProgression(pool);
  const first = scoreTicket(game, initialProgress(), install('claude'), pool);
  assert.equal(progressionStep(first.state, COMBO.window + 1).comboLost, false, 'uma entrega só ainda não é combo');
  const scored = scoreTicket(first.state, first.progress, { id: 'incident:x', kind: 'incident', xp: 0 }, pool);
  let step = progressionStep(scored.state, COMBO.window + 1);
  assert.equal(step.comboLost, true);
  assert.equal(step.shiftOver, false);
  step = progressionStep(step.state, SHIFT_SECONDS);
  assert.equal(step.shiftOver, true);
  const closed = closeShift(step.state, scored.progress);
  assert.deepEqual([closed.score, closed.record, closed.progress.bestShift], [130, true, 130]);
  assert.equal(closed.state.shift.left, SHIFT_SECONDS, 'um turno novo começa');
  const worse = closeShift({ ...closed.state, shift: { left: 0, score: 20, over: true } }, closed.progress);
  assert.deepEqual([worse.record, worse.progress.bestShift], [false, 130]);
});

test('deploy no terminal entra no combo e avança a missão de deploy', () => {
  const deployPool = [{ id: 'd', text: 'Faça 2 deploys no terminal', kind: 'deploy', goal: 2, xp: 90 }];
  const deploy = { id: 'deploy', kind: 'deploy', xp: 35 };
  const first = scoreTicket(createProgression(deployPool), initialProgress(), deploy, deployPool);
  assert.equal(first.xpGained, 35);
  assert.deepEqual(first.finished, []);
  const second = scoreTicket(first.state, first.progress, deploy, deployPool);
  assert.equal(second.multiplier, 1 + COMBO.step);
  assert.deepEqual(second.finished.map(mission => mission.id), ['d']);
  assert.equal(second.progress.xp, 35 + Math.round(35 * (1 + COMBO.step)) + 90);
  assert.equal(second.progress.incidents, 0, 'deploy não conta como incidente');
});

test('combo alto não fecha na mesma entrega a missão de sequência que acabou de entrar', () => {
  const deck = [
    { id: 'i1', text: 'Ligue 1 rack', kind: 'install', goal: 1, xp: 40 },
    { id: 'c2', text: 'Faça 2 entregas em sequência', kind: 'combo', goal: 2, xp: 90 },
  ];
  let game = { ...createProgression(deck), missions: { active: [{ id: 'i1', done: 0 }], next: 1, completed: 0 } };
  game = { ...game, combo: { streak: 6, left: COMBO.window } };
  const step = scoreTicket(game, initialProgress(), install('claude'), deck);
  assert.deepEqual(step.finished.map(mission => mission.id), ['i1']);
  assert.equal(step.bonus, 40, 'o XP pago bate com as missões que o jogador viu fechar');
  assert.deepEqual(step.state.missions.active.map(entry => entry.id), ['c2']);
});

test('o aviso da premiação diz o XP total que entrou, todas as missões fechadas, o nível e o selo', () => {
  const deck = [
    { id: 'i1', text: 'Ligue 1 rack', kind: 'install', goal: 1, xp: 80 },
    { id: 'c1', text: 'Faça 1 entrega em sequência', kind: 'combo', goal: 1, xp: 90 },
  ];
  const result = scoreTicket(createProgression(deck), { ...initialProgress(), xp: 90 }, install('claude'), deck);
  assert.equal(result.finished.length, 2);
  const text = awardMessage('Claude no ar', result, ['primeira-gpu']);
  assert.match(text, /Missões cumpridas: Ligue 1 rack e Faça 1 entrega em sequência/);
  assert.match(text, new RegExp(`\\+${result.xpGained + result.bonus} XP`), 'o total mostrado é o total gravado');
  assert.equal(result.progress.xp, 90 + result.xpGained + result.bonus);
  assert.match(text, /subiu para /);
  assert.match(text, /selo: Primeira GPU instalada/);
  const plain = scoreTicket(createProgression([]), initialProgress(), install('codex'), []);
  assert.equal(awardMessage('Codex no ar', plain), 'Codex no ar · +60 XP');
});
