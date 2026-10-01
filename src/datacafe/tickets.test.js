import test from 'node:test';
import assert from 'node:assert/strict';
import { ticketsFrom, completeTicket, levelFor, titleFor, levelProgress, badgesFor, speedPerk, perkText, TICKET_XP, LEVEL_TITLES } from './tickets.js';
import { createRacks, installGpu, rackStep } from './racks.js';
import { initialProgress } from './progress.js';

const MODELS = [{ id: 'a', name: 'Alfa' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gama' }, { id: 'd', name: 'Delta' }];
const IDS = MODELS.map(model => model.id);

test('incidentes vêm antes do café, que vem antes das instalações', () => {
  let racks = createRacks(IDS, ['a', 'b', 'c']);
  racks = rackStep(racks, 0.1, () => 0).state;
  const tickets = ticketsFrom(racks, { value: 0.1, tired: true }, MODELS);
  assert.deepEqual(tickets.map(ticket => ticket.kind), ['incident', 'coffee', 'install']);
  assert.match(tickets[0].title, /caiu/);
  assert.equal(tickets[2].title, 'Instale uma GPU no rack Delta');
  assert.equal(ticketsFrom(racks, { value: 0.9, tired: false }, MODELS).some(ticket => ticket.kind === 'coffee'), false);
});

test('concluir um ticket soma XP, conta incidentes e avisa quando sobe de nível', () => {
  const start = { ...initialProgress(), xp: 90, level: 1 };
  const { progress, xpGained, leveledUp } = completeTicket(start, { kind: 'install', xp: TICKET_XP.install });
  assert.equal(xpGained, 60);
  assert.equal(progress.xp, 150);
  assert.equal(progress.level, 2);
  assert.equal(leveledUp, true);
  assert.equal(start.xp, 90, 'imutável');
  assert.equal(completeTicket(progress, { kind: 'incident', xp: 40 }).progress.incidents, 1);
});

test('a curva de nível é suave e tem teto', () => {
  assert.deepEqual([0, 99, 100, 399, 400, 900, 1600, 99999].map(levelFor), [1, 1, 2, 2, 3, 4, 5, 6]);
  assert.equal(titleFor(1), 'Estagiário');
  assert.equal(titleFor(99), 'Principal');
  assert.equal(levelProgress(0), 0);
  assert.equal(levelProgress(250), 0.5);
});

test('selos acumulam e nunca somem', () => {
  let racks = createRacks(IDS);
  assert.deepEqual(badgesFor(initialProgress(), racks), []);
  racks = installGpu(racks, 'a');
  assert.deepEqual(badgesFor(initialProgress(), racks), ['primeira-gpu']);
  for (const id of IDS) racks = installGpu(racks, id);
  const all = badgesFor({ ...initialProgress(), incidents: 1 }, racks);
  assert.deepEqual(all, ['primeira-gpu', 'apagou-incendio', 'metade-no-ar', 'data-center-completo']);
  assert.ok(badgesFor({ ...initialProgress(), badges: ['data-center-completo'] }, createRacks(IDS)).includes('data-center-completo'));
});

test('propriedade: concluir tickets nunca reduz o XP', () => {
  let progress = initialProgress();
  for (const xp of [10, 0, -5, 60, undefined, 40]) {
    const next = completeTicket(progress, { kind: 'install', xp }).progress;
    assert.ok(next.xp >= progress.xp);
    progress = next;
  }
});

test('o multiplicador do combo arredonda o XP do ticket', () => {
  const start = initialProgress();
  assert.equal(completeTicket(start, { kind: 'install', xp: 60 }, 1.25).xpGained, 75);
  assert.equal(completeTicket(start, { kind: 'install', xp: 60 }, 2).progress.xp, 120);
  assert.equal(completeTicket(start, { kind: 'install', xp: 60 }, 0.2).xpGained, 60, 'nunca paga menos que o ticket');
});

test('selos de combo, turno, incidentes e missões saem do progresso', () => {
  const racks = createRacks(IDS);
  const earned = badgesFor({ ...initialProgress(), bestCombo: 5, bestShift: 500, incidents: 10, missions: 5 }, racks);
  assert.deepEqual(earned, ['apagou-incendio', 'combo-5', 'turno-500', 'bombeiro-10', 'missoes-5']);
  assert.deepEqual(badgesFor({ ...initialProgress(), bestCombo: 4, bestShift: 499, incidents: 9, missions: 4 }, racks), ['apagou-incendio']);
});

test('cada nível deixa o dev um pouco mais rápido e diz isso em texto', () => {
  const speeds = LEVEL_TITLES.map((_, index) => speedPerk(index + 1));
  assert.equal(speeds[0], 1);
  for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i] > speeds[i - 1]);
  assert.ok(speeds.at(-1) <= 1.2, 'o bônus não quebra o ritmo do jogo');
  assert.equal(perkText(1), '');
  assert.match(perkText(3), /%/);
});
