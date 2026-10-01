import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgression, scoreTicket, progressionStep, closeShift } from './progression.js';
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
