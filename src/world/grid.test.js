import test from 'node:test';
import assert from 'node:assert/strict';
import { cellAt, isSolid, circleFree, resolveMove, createGrid } from './grid.js';

// 8×6 room with a wall ring, two rack cells and a table cell.
const room = createGrid({
  width: 8, height: 6, cellSize: 1,
  cells: [
    '########',
    '#..R...#',
    '#......#',
    '#...D..#',
    '#......#',
    '########',
  ],
});

test('cellAt reads the map symbols and treats out of bounds as wall', () => {
  assert.equal(cellAt(room, 1.5, 1.5), '.');
  assert.equal(cellAt(room, 3.5, 1.5), 'R');
  assert.equal(cellAt(room, 4.5, 3.5), 'D');
  assert.equal(cellAt(room, -0.5, 2.5), '#');
  assert.equal(cellAt(room, 8.5, 2.5), '#');
  assert.equal(cellAt(room, 4.5, -3), '#');
  assert.equal(isSolid(room, 3.5, 1.5), true);
  assert.equal(isSolid(room, 2.5, 1.5), false);
});

test('createGrid rejects ragged maps instead of guessing', () => {
  assert.throws(() => createGrid({ width: 2, height: 2, cellSize: 1, cells: ['#.', '#'] }));
  assert.throws(() => createGrid({ width: 2, height: 3, cellSize: 1, cells: ['#.', '#.'] }));
});

test('a disc flush with the wall is free, a hair further is not', () => {
  // Centre (1.3, 2.5): radius .3 touches x=1.0 exactly, which is allowed.
  assert.equal(circleFree(room, 1.3, 2.5, .3), true);
  assert.equal(circleFree(room, 1.25, 2.5, .3), false);
  // Corners only block when the circle actually reaches them.
  assert.equal(circleFree(room, 3.7, 2.7, .3), true);
  assert.equal(circleFree(room, 3.85, 2.85, .3), false);
});

test('resolveMove slides along a rack instead of stopping dead, and cannot tunnel through it', () => {
  const pos = { x: 2.5, z: 1.5 };
  const slide = resolveMove(room, pos, { x: 3, z: 2 }, .3);
  assert.equal(slide.x, pos.x, 'blocked on x by the rack cell');
  assert.ok(slide.z > pos.z, 'still moves on z');
  assert.deepEqual(resolveMove(room, { x: 1.3, z: 2.5 }, { x: -3, z: 0 }, .3), { x: 1.3, z: 2.5 }, 'fully blocked keeps the position');
  const open = resolveMove(room, { x: 1.3, z: 2.5 }, { x: 2, z: 0 }, .3);
  assert.deepEqual(open, { x: 3.3, z: 2.5 });
  // A jump sized to clear the rack in one step still stops at its face.
  assert.equal(resolveMove(room, pos, { x: 30, z: 0 }, .3).x, pos.x);
});

test('the dev never ends inside a solid cell, whatever the frame throws at it', () => {
  // Deterministic fuzz: any seed walks the same corridors, so failures reproduce.
  let seed = 20260930;
  const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const radius = .3;
  let pos = { x: 4.5, z: 4.5 };
  for (let step = 0; step < 20000; step++) {
    const angle = rng() * Math.PI * 2;
    const speed = rng() * 14; // far beyond a real frame, so tunnels get a chance
    pos = resolveMove(room, pos, { x: Math.cos(angle) * speed, z: Math.sin(angle) * speed }, radius);
    assert.equal(circleFree(room, pos.x, pos.z, radius), true, `step ${step} at ${pos.x.toFixed(2)},${pos.z.toFixed(2)}`);
  }
  assert.ok(pos.x > 1 && pos.x < 7, 'the walk actually moved somewhere');
});
