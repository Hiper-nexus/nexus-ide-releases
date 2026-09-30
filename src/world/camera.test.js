import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA, chaseStep, initialCamera } from './camera.js';

const still = (x = 0, z = 0, heading = 0) => ({ x, z, heading, vx: 0, vz: 0, speed: 0 });

test('the chase camera settles behind and above the rover, looking slightly ahead of it', () => {
  let camera = initialCamera(still(0, 0, 0));
  for (let i = 0; i < 240; i++) camera = chaseStep(camera, still(0, 0, 0), 1 / 60);
  assert.ok(camera.z > CAMERA.distance * 0.95 && camera.z < CAMERA.distance * 1.05, 'behind: heading 0 drives toward -z, so the camera sits at +z');
  assert.ok(Math.abs(camera.x) < 0.01);
  assert.ok(camera.y > 3 && camera.y < 8);
  assert.ok(camera.tz < 0 && camera.tz > -3, 'the focus point is a little ahead of the rover');
});

test('turning the rover swings the camera around it and the result does not depend on frame rate', () => {
  const rover = still(4, -3, Math.PI / 2);
  const run = (fps) => { let camera = initialCamera(still()); for (let i = 0; i < fps * 2; i++) camera = chaseStep(camera, rover, 1 / fps); return camera; };
  const slow = run(30), fast = run(120);
  for (const key of ['x', 'y', 'z', 'tx', 'tz']) assert.ok(Math.abs(slow[key] - fast[key]) < 0.05, key);
  const dx = fast.x - rover.x, dz = fast.z - rover.z;
  const forward = { x: -Math.sin(rover.heading), z: -Math.cos(rover.heading) };
  assert.ok(dx * forward.x + dz * forward.z < -CAMERA.distance * 0.8, 'camera stays behind the new heading');
});

test('an orbit drag offsets the camera around the rover and boost widens the field of view', () => {
  let orbited = initialCamera(still());
  for (let i = 0; i < 300; i++) orbited = chaseStep(orbited, still(), 1 / 60, { orbit: Math.PI / 2 });
  assert.ok(Math.abs(orbited.x) > CAMERA.distance * 0.8, 'a quarter turn puts the camera to the side');
  let boosted = initialCamera(still());
  for (let i = 0; i < 120; i++) boosted = chaseStep(boosted, { ...still(), speed: 12 }, 1 / 60, { boost: true });
  assert.ok(boosted.fov > CAMERA.fov + 4 && boosted.fov <= CAMERA.boostFov);
  const calm = chaseStep(boosted, still(), 1);
  assert.ok(calm.fov < boosted.fov);
});

test('the intro flight orbits the world slowly and only while nobody is driving', () => {
  const start = initialCamera(still());
  const a = chaseStep(start, still(), 0.5, { attract: true });
  const b = chaseStep(a, still(), 0.5, { attract: true });
  assert.notDeepEqual([a.x, a.z], [b.x, b.z]);
  assert.ok(Math.hypot(a.x, a.z) > CAMERA.distance * 2, 'attract mode keeps a wide view');
});
