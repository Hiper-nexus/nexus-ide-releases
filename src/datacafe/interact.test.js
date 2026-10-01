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
