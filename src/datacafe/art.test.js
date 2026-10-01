import test from 'node:test';
import assert from 'node:assert/strict';

// Os letreiros desenham num canvas 2D; um stub basta para geometrias e materiais existirem.
const context = new Proxy({}, { get: (target, key) => (key in target ? target[key] : () => ({ addColorStop() {}, width: 10 })), set: (target, key, value) => { target[key] = value; return true; } });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
const THREE = await import('three');
const { createKit } = await import('./kit.js');
const { buildDatacenter } = await import('./datacenter.js');
const { createDev } = await import('./character.js');
const { LAYOUT } = await import('./layout.js');
const { MODELS } = await import('./models.js');

function world() {
  const kit = createKit();
  const scene = new THREE.Scene();
  const dc = buildDatacenter(kit, { scene, layout: LAYOUT, models: MODELS });
  const dev = createDev(kit);
  scene.add(dev.group);
  return { kit, scene, dc, dev };
}

test('o data center tem um rack por LLM e aceita só estados válidos', () => {
  const { dc } = world();
  assert.equal(dc.racks.size, MODELS.length);
  const claude = dc.racks.get('claude');
  claude.setState('on');
  claude.setState('incident');
  claude.pulse();
  assert.throws(() => claude.setState('queimado'), /inválido/);
  dc.update(0.016, 1, false);
  dc.update(0.016, 1.2, true);
});

test('a doca entrega caixas até esvaziar e é reabastecida até o limite', () => {
  const { dc } = world();
  assert.equal(dc.dock.count(), 3);
  assert.equal(dc.dock.takeCrate(), true);
  assert.equal(dc.dock.takeCrate(), true);
  assert.equal(dc.dock.takeCrate(), true);
  assert.equal(dc.dock.takeCrate(), false);
  assert.equal(dc.dock.refill(99), dc.dock.max);
});

test('o dev anima sem erro em todos os estados', () => {
  const { dev } = world();
  for (const motion of [{ speed: 0 }, { speed: 3.4, heading: 1 }, { speed: 2, carrying: true }, { speed: 0, tired: true }, { speed: 3, calm: true }]) {
    for (let i = 0; i < 200; i++) dev.setMotion(motion, 0.05);
  }
  assert.equal(dev.parts.crate.visible, false);
  dev.setMotion({ speed: 1, carrying: true }, 0.016);
  assert.equal(dev.parts.crate.visible, true);
});

test('descartar o kit libera toda geometria, material e textura da cena', () => {
  const { kit, scene } = world();
  const geometries = new Set(), materials = new Set(), textures = new Set();
  scene.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of [].concat(object.material ?? [])) { materials.add(material); if (material.map) textures.add(material.map); }
  });
  assert.ok(geometries.size > 20 && materials.size > 15 && textures.size > 8, 'cena populada');
  let released = 0;
  const all = [...geometries, ...materials, ...textures];
  for (const resource of all) resource.addEventListener('dispose', () => released++);
  kit.dispose();
  assert.equal(released, all.length);
});
