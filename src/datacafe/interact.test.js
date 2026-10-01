import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractables, register, nearest, holdStep } from './interact.js';

function fixture() {
  const items = createInteractables();
  register(items, {
    id: 'dock', x: 0, z: 0, radius: 1.6, duration: .8,
    label: ({ carrying }) => carrying ? null : 'Pegar caixa de GPU',
  });
  register(items, {
    id: 'coffee', x: 3, z: 0, radius: 2.4, duration: 1.1,
    label: ({ energy }) => energy.level > .05 ? 'Tomar café' : null,
    onComplete: state => { state.energy.level = 1; },
  });
  return items;
}

test('nearest picks the closest item whose label applies, ignoring inert ones', () => {
  const items = fixture();
  const state = { carrying: false, energy: { level: .4 } };
  // Standing between the two: coffee is closer (3 units away, inside radius 1.2? no —
  // use positions that really are inside each radius).
  assert.equal(nearest(items, { x: .5, z: 0 }, state)?.id, 'dock');
  assert.equal(nearest(items, { x: 2.9, z: 0 }, state)?.id, 'coffee');
  assert.equal(nearest(items, { x: 10, z: 10 }, state), null, 'out of range');
  state.carrying = true;
  assert.ok(nearest(items, { x: .5, z: 0 }, state) == null, 'dock goes inert while carrying');
});

test('a null label beats distance: an inert neighbour never steals the prompt', () => {
  const items = fixture();
  const state = { carrying: true, energy: { level: .4 } };
  // The dock is closer, but it is inert while carrying: coffee keeps the prompt.
  assert.equal(nearest(items, { x: 1.3, z: 0 }, state)?.id, 'coffee');
  assert.equal(nearest(items, { x: 1.3, z: 0 }, { ...state, energy: { level: 0 } }), null);
});

test('holdStep reports progress and completion without drifting past 1', () => {
  const hold = { item: null, duration: 1.2, elapsed: 0 };
  assert.deepEqual(holdStep(hold, .3), { progress: .25, done: false });
  const second = holdStep(hold, .3);
  assert.equal(second.progress, .5);
  const done = holdStep(hold, 5);
  assert.equal(done.done, true);
  assert.equal(done.progress, 1);
  assert.ok(hold.elapsed >= 1.2);
});

test('advanceHold: tempo segurado num alvo não vale para outro, nem passando por um bloqueado', async () => {
  const { advanceHold } = await import('./interact.js');
  const a = { id: 'a' }, b = { id: 'b' };
  const install = { text: 'Instalar', duration: 1.4, blocked: false };
  const need = { text: 'Precisa de GPU', duration: 1, blocked: true };
  const hold = { item: null, label: null, duration: 1, elapsed: 0 };
  for (let i = 0; i < 8; i++) assert.equal(advanceHold(hold, a, install, true, 0.1), 'progress');
  assert.ok(Math.abs(hold.elapsed - 0.8) < 1e-9);
  assert.equal(advanceHold(hold, b, need, true, 0.1), 'blocked');
  assert.equal(hold.elapsed, 0, 'o bloqueado zera a barra');
  let result;
  for (let i = 0; i < 6; i++) result = advanceHold(hold, a, install, true, 0.1);
  assert.equal(result, 'progress', 'voltar ao alvo A recomeça do zero');
  for (let i = 0; i < 8 && result !== 'done'; i++) result = advanceHold(hold, a, install, true, 0.1);
  assert.equal(result, 'done');
});

test('advanceHold: soltar ou mudar a ação do mesmo alvo recomeça a contagem', async () => {
  const { advanceHold } = await import('./interact.js');
  const rack = { id: 'rack' };
  const install = { text: 'Instalar', duration: 1, blocked: false };
  const reboot = { text: 'Reiniciar', duration: 1, blocked: false };
  const hold = { item: null, label: null, duration: 1, elapsed: 0 };
  advanceHold(hold, rack, install, true, 0.6);
  assert.equal(advanceHold(hold, rack, install, false, 0.1), 'idle');
  assert.equal(hold.elapsed, 0);
  advanceHold(hold, rack, install, true, 0.6);
  assert.equal(advanceHold(hold, rack, reboot, true, 0.5), 'progress');
  assert.ok(Math.abs(hold.elapsed - 0.5) < 1e-9, 'a ação nova começou do zero');
  assert.equal(advanceHold(hold, null, null, true, 0.1), 'idle');
});

test('advanceHold: o texto do rótulo pode mudar no meio do segurar sem reiniciar (mesmo holdId)', async () => {
  const { advanceHold } = await import('./interact.js');
  const freezer = { id: 'freezer' };
  const hold = { item: null, label: null, elapsed: 0, duration: 0 };
  const eight = Object.freeze({ text: 'Pegar um Nexus+ (8)', duration: 0.9, blocked: false, holdId: 'freezer-ready' });
  const nine = Object.freeze({ text: 'Pegar um Nexus+ (9)', duration: 0.9, blocked: false, holdId: 'freezer-ready' });
  assert.equal(advanceHold(hold, freezer, eight, true, 0.4), 'progress');
  assert.equal(advanceHold(hold, freezer, nine, true, 0.4), 'progress', 'a lata que voltou ao estoque não zera o gole');
  assert.equal(advanceHold(hold, freezer, nine, true, 0.2), 'done', '0,4 + 0,4 + 0,2 completa os 0,9 s');
  const other = Object.freeze({ text: 'Outro', duration: 0.9, blocked: false, holdId: 'outro' });
  hold.elapsed = 0.5;
  assert.equal(advanceHold(hold, freezer, other, true, 0.1), 'progress');
  assert.ok(hold.elapsed <= 0.1 + 1e-9, 'um holdId diferente continua reiniciando');
});
