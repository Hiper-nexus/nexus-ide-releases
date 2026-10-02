import test from 'node:test';
import assert from 'node:assert/strict';
import { MISSIONS, createMissions, missionEvent, missionView, dropUnavailable } from './missions.js';

const pool = [
  { id: 'a', text: 'Ligue 2 racks', kind: 'install', goal: 2, xp: 50 },
  { id: 'b', text: 'Resolva 1 incidente', kind: 'incident', goal: 1, xp: 70 },
  { id: 'c', text: 'Chegue ao combo ×3', kind: 'combo', goal: 3, xp: 90 },
  { id: 'd', text: 'Ligue 4 racks', kind: 'install', goal: 4, xp: 120 },
];

test('o turno começa com as primeiras missões do baralho, sem repetir', () => {
  const state = createMissions(pool, 3);
  assert.deepEqual(state.active.map(mission => mission.id), ['a', 'b', 'c']);
  assert.equal(new Set(createMissions(MISSIONS).active.map(mission => mission.id)).size, 3);
});

test('evento do tipo certo avança; ao fechar paga a recompensa e entra a próxima do baralho', () => {
  let state = createMissions(pool, 3);
  let step = missionEvent(state, { kind: 'install' }, pool);
  assert.deepEqual(step.finished, []);
  assert.equal(missionView(step.state, pool)[0].done, 1);
  step = missionEvent(step.state, { kind: 'install' }, pool);
  assert.deepEqual(step.finished.map(mission => [mission.id, mission.xp]), [['a', 50]]);
  assert.deepEqual(step.state.active.map(mission => mission.id), ['d', 'b', 'c'], 'a vaga recebe a próxima missão');
  assert.equal(step.state.completed, 1);
  assert.equal(missionView(step.state, pool)[0].done, 0);
});

test('missão de combo guarda o maior valor e evento de outro tipo não mexe em nada', () => {
  const state = createMissions(pool, 3);
  assert.equal(missionEvent(state, { kind: 'coffee' }, pool).state, state);
  let step = missionEvent(state, { kind: 'combo', value: 2 }, pool);
  step = missionEvent(step.state, { kind: 'combo', value: 1 }, pool);
  assert.equal(missionView(step.state, pool)[2].done, 2, 'combo menor não diminui o progresso');
  step = missionEvent(step.state, { kind: 'combo', value: 3 }, pool);
  assert.deepEqual(step.finished.map(mission => mission.id), ['c']);
});

test('com o baralho esgotado a vaga volta ao começo sem duplicar missão ativa', () => {
  let state = createMissions(pool, 3);
  for (let i = 0; i < 12; i++) {
    state = missionEvent(state, { kind: 'install' }, pool).state;
    state = missionEvent(state, { kind: 'incident' }, pool).state;
    const ids = state.active.map(mission => mission.id);
    assert.equal(new Set(ids).size, ids.length);
  }
  assert.ok(state.completed > 4);
});

test('missão que ficou impossível sai da lista (data center completo não tem o que instalar)', () => {
  const state = createMissions(pool, 3);
  const next = dropUnavailable(state, pool, ['install']);
  assert.deepEqual(next.active.map(mission => mission.id), ['b', 'c']);
  assert.equal(dropUnavailable(next, pool, ['install']), next, 'nada a tirar devolve o mesmo estado');
  const after = missionEvent(next, { kind: 'incident' }, pool, ['install']);
  assert.deepEqual(after.state.active.map(mission => mission.id), ['c'], 'nenhuma missão de instalar volta');
});

test('missão sacada para a vaga não fecha no mesmo ticket: ela aparece antes de valer', () => {
  const deck = [
    { id: 'i2', text: 'Ligue 2 racks', kind: 'install', goal: 2, xp: 50 },
    { id: 'c3', text: 'Faça 3 entregas em sequência', kind: 'combo', goal: 3, xp: 90 },
  ];
  let state = createMissions(deck, 1);
  state = missionEvent(state, [{ kind: 'install' }, { kind: 'combo', value: 9 }], deck).state;
  const step = missionEvent(state, [{ kind: 'install' }, { kind: 'combo', value: 10 }], deck);
  assert.deepEqual(step.finished.map(mission => mission.id), ['i2'], 'só a missão que já estava ativa fecha');
  assert.deepEqual(missionView(step.state, deck).map(mission => [mission.id, mission.done]), [['c3', 0]], 'a nova entra zerada e visível');
  const next = missionEvent(step.state, [{ kind: 'install' }, { kind: 'combo', value: 11 }], deck);
  assert.deepEqual(next.finished.map(mission => mission.id), ['c3']);
});

test('dois eventos do mesmo ticket fecham duas missões ativas de uma vez', () => {
  let state = createMissions(pool, 3);
  state = missionEvent(state, [{ kind: 'install' }, { kind: 'combo', value: 2 }], pool).state;
  const step = missionEvent(state, [{ kind: 'install' }, { kind: 'combo', value: 3 }], pool);
  assert.deepEqual(step.finished.map(mission => mission.id).sort(), ['a', 'c']);
  assert.equal(step.state.completed, 2);
});

test('tirar missão impossível repõe a vaga com a próxima possível', () => {
  const state = createMissions(MISSIONS, 3);
  assert.ok(state.active.some(entry => MISSIONS.find(mission => mission.id === entry.id).kind === 'install'));
  const next = dropUnavailable(state, MISSIONS, ['install']);
  assert.equal(next.active.length, 3, 'continuam três missões ativas');
  assert.ok(next.active.every(entry => MISSIONS.find(mission => mission.id === entry.id).kind !== 'install'));
  assert.equal(new Set(next.active.map(entry => entry.id)).size, 3);
});

test('a missão do turbo Nexus+ existe no baralho, avança só com o evento de turbo e paga XP', () => {
  const mission = MISSIONS.find(item => item.kind === 'turbo');
  assert.ok(mission, 'missão de turbo no baralho');
  assert.equal(mission.goal, 2);
  assert.ok(mission.xp > 0 && mission.text.includes('Nexus+'));
  const deck = [{ id: 'x', text: 'Ligue 2 racks', kind: 'install', goal: 2, xp: 50 }, mission];
  let state = createMissions(deck, 2);
  assert.equal(missionEvent(state, { kind: 'install' }, deck).finished.length, 0);
  state = missionEvent(state, { kind: 'turbo' }, deck).state;
  const done = missionEvent(state, { kind: 'turbo' }, deck);
  assert.deepEqual(done.finished.map(item => item.id), [mission.id]);
});

test('o baralho continua com ids únicos e a abertura do turno não muda', () => {
  assert.equal(new Set(MISSIONS.map(item => item.id)).size, MISSIONS.length);
  assert.deepEqual(createMissions(MISSIONS).active.map(entry => entry.id), ['ligar-3', 'bombeiro-2', 'combo-3']);
});
