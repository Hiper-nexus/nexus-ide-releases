import test from 'node:test';
import assert from 'node:assert/strict';
import { movePlayer, collectNearby } from './movement.js';

test('diagonal movement cannot exceed straight movement speed', () => {
  const initial = {x:0,z:0};
  const straight = movePlayer(initial, {x:1,z:0}, 1);
  const diagonal = movePlayer(initial, {x:1,z:1}, 1);
  assert.ok(Math.abs(Math.hypot(diagonal.x,diagonal.z)-Math.hypot(straight.x,straight.z)) < 1e-8);
  assert.deepEqual(initial,{x:0,z:0});
});

test('player stays inside the world after a long frame', () => {
  const next = movePlayer({x:12,z:12},{x:1,z:1},100);
  assert.ok(next.x<=12 && next.z<=12);
});

test('each coffee is collected once and has no effect on raffle eligibility', () => {
  const items=[{id:1,x:1,z:0},{id:2,x:8,z:8}];
  const collected=new Set();
  const next=collectNearby({x:1,z:0},items,collected);
  assert.deepEqual(next,[1]);
  assert.equal(collected.size,0);
  assert.deepEqual(collectNearby({x:1,z:0},items,new Set(next)),[]);
});
