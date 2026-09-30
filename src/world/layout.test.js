import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD, insideObstacle } from './layout.js';

const points = [
  ...WORLD.coffees.map(([x, z]) => ({ x, z, what: 'coffee' })),
  ...WORLD.barrels.map(([x, z]) => ({ x, z, what: 'barrel' })),
  ...WORLD.props.map(([x, z]) => ({ x, z, what: 'prop' })),
  ...WORLD.pins.map(([x, z]) => ({ x, z, what: 'pin' })),
  { x: WORLD.spawn.x, z: WORLD.spawn.z, what: 'spawn' },
];

test('the world keeps the three stations, five coffees and enough barrels for the demolition mission', () => {
  assert.deepEqual(WORLD.stations.map(station => station.key).sort(), ['claude', 'codex', 'live']);
  assert.equal(WORLD.coffees.length, 5);
  assert.ok(WORLD.barrels.length >= 3);
  assert.ok(WORLD.ramps.length >= 1 && WORLD.boostPads.length >= 1);
});

test('nothing the rover must reach is buried inside a building, and everything is inside the drivable area', () => {
  for (const point of points) {
    assert.equal(insideObstacle(point.x, point.z, 0.9), false, `${point.what} at ${point.x},${point.z}`);
    assert.ok(Math.abs(point.x) < WORLD.limit && Math.abs(point.z) < WORLD.limit, `${point.what} inside limit`);
  }
  for (const station of WORLD.stations) assert.equal(insideObstacle(station.x, station.z + station.approach, 0.9), false, station.key + ' approach');
});

test('collectibles do not overlap each other', () => {
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    assert.ok(Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z) >= 1.6, `${points[i].what} vs ${points[j].what}`);
  }
});
