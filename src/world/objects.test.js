import test from 'node:test';
import assert from 'node:assert/strict';

// The signs draw on a 2D canvas; a stub is enough for the geometry and materials to exist.
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, fillText() {}, measureText: () => ({ width: 10 }), beginPath() {}, roundRect() {}, fill() {}, drawImage() {} }) }) };
globalThis.Image = class { set src(_) {} };
const THREE = await import('three');
const { makeWorld, makeRover, makeBarrels, makeProps, disposeObjects, disposeShared, ANIMATED } = await import('./objects.js');

test('disposing a world releases every geometry, material and texture and empties the shared caches', () => {
  const scene = new THREE.Scene();
  makeWorld(scene); makeRover(scene); makeBarrels(scene); makeProps(scene);
  const geometries = new Set(), materials = new Set(), textures = new Set(), instanced = new Set();
  scene.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.isInstancedMesh) instanced.add(object);
    for (const material of [].concat(object.material ?? [])) { materials.add(material); if (material.map) textures.add(material.map); }
  });
  assert.ok(geometries.size > 100 && materials.size > 10 && textures.size > 5 && instanced.size > 3, 'the fixture world is populated');
  assert.ok(ANIMATED.pulse.length > 0 && ANIMATED.blink.length > 0);
  const released = { geometries: 0, materials: 0, textures: 0, instanced: 0 };
  for (const g of geometries) g.addEventListener('dispose', () => released.geometries++);
  for (const m of materials) m.addEventListener('dispose', () => released.materials++);
  for (const t of textures) t.addEventListener('dispose', () => released.textures++);
  for (const i of instanced) i.addEventListener('dispose', () => released.instanced++);
  disposeObjects(scene); disposeShared();
  assert.deepEqual(released, { geometries: geometries.size, materials: materials.size, textures: textures.size, instanced: instanced.size });
  assert.equal(ANIMATED.pulse.length + ANIMATED.blink.length, 0);
  // A second world after disposal gets fresh shared materials instead of the disposed ones.
  const again = new THREE.Scene(); makeRover(again);
  const reused = new Set(); again.traverse(object => { for (const material of [].concat(object.material ?? [])) reused.add(material); });
  for (const material of reused) assert.ok(!materials.has(material), 'materials are rebuilt after disposeShared');
});
