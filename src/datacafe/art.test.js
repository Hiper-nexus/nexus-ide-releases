import test from 'node:test';
import assert from 'node:assert/strict';

// Os letreiros desenham num canvas 2D; um stub basta para geometrias e materiais existirem.
const context = new Proxy({}, { get: (target, key) => (key in target ? target[key] : () => ({ addColorStop() {}, width: 10 })), set: (target, key, value) => { target[key] = value; return true; } });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => context }) };
const THREE = await import('three');
const { createKit } = await import('./kit.js');
const { buildDatacenter, RACK } = await import('./datacenter.js');
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

test('racks vizinhos se tocam: o dev não pisca pelas frestas ao andar atrás da fileira', () => {
  const { dc } = world();
  const instancedBoxes = (w, h) => dc.root.children.find(o => o.isInstancedMesh && o.geometry.parameters?.height === h && o.geometry.parameters?.width === w);
  const body = instancedBoxes(RACK.w, RACK.h);
  const plinth = dc.root.children.find(o => o.isInstancedMesh && o.geometry.parameters?.height === 0.06 && o.count === LAYOUT.racks.length);
  assert.ok(body && plinth, 'malhas dos racks');
  const boxAt = (mesh, i) => {
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(i, matrix);
    mesh.geometry.computeBoundingBox();
    return mesh.geometry.boundingBox.clone().applyMatrix4(matrix);
  };
  let neighbours = 0;
  LAYOUT.racks.forEach((rack, i) => {
    const next = LAYOUT.racks.findIndex(other => other.z === rack.z && other.x === rack.x + 1);
    if (next < 0) return;
    neighbours++;
    assert.ok(Math.abs(boxAt(body, next).min.x - boxAt(body, i).max.x) < 1e-6, `fresta entre ${rack.id} e ${LAYOUT.racks[next].id}`);
  });
  assert.ok(neighbours >= 15, 'fileiras contínuas');
  // O rodapé não pode dividir o plano lateral com o corpo do rack (cores diferentes).
  const a = boxAt(body, 0), b = boxAt(plinth, 0);
  assert.ok(b.min.x > a.min.x + 1e-4 && b.max.x < a.max.x - 1e-4, 'rodapé recuado nas laterais');
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

/** Faces de caixas alinhadas aos eixos, em coordenadas do mundo. Caixas giradas fora dos eixos ficam de fora. */
function boxFaces(root) {
  root.updateMatrixWorld(true);
  const faces = [];
  const box = new THREE.Box3(), rotation = new THREE.Matrix4();
  root.traverse(mesh => {
    if (!mesh.isMesh || !mesh.visible || mesh.geometry.type !== 'BoxGeometry') return;
    rotation.extractRotation(mesh.matrixWorld);
    const aligned = rotation.elements.every(value => Math.abs(value) < 1e-6 || Math.abs(Math.abs(value) - 1) < 1e-6);
    if (!aligned) return;
    box.setFromObject(mesh, true);
    for (const [axis, u, v] of [['x', 'y', 'z'], ['y', 'x', 'z'], ['z', 'x', 'y']]) {
      for (const side of ['min', 'max']) {
        faces.push({ mesh, axis, side, at: box[side][axis], u: [box.min[u], box.max[u]], v: [box.min[v], box.max[v]] });
      }
    }
  });
  return faces;
}

/** Pares de faces no mesmo plano, voltadas para o mesmo lado e com cores diferentes: z-fighting. */
function fightingFaces(root) {
  const faces = boxFaces(root), found = [];
  const overlap = ([a0, a1], [b0, b1]) => Math.min(a1, b1) - Math.max(a0, b0);
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const a = faces[i], b = faces[j];
      if (a.mesh === b.mesh || a.axis !== b.axis || a.side !== b.side || Math.abs(a.at - b.at) > 1e-4) continue;
      if (a.mesh.material.color.equals(b.mesh.material.color)) continue;
      if (overlap(a.u, b.u) > 1e-4 && overlap(a.v, b.v) > 1e-4) found.push(`${a.axis}=${a.at.toFixed(3)} #${a.mesh.material.color.getHexString()} × #${b.mesh.material.color.getHexString()}`);
    }
  }
  return found;
}

test('nenhuma face do dev divide o plano com outra de cor diferente (sem z-fighting)', () => {
  const { dev } = world();
  assert.deepEqual(fightingFaces(dev.group), [], 'de pé');
  for (let i = 0; i < 60; i++) dev.setMotion({ speed: 0, seat: 1 }, 0.05);
  assert.deepEqual(fightingFaces(dev.group), [], 'sentado');
});

test('a caneca do cinto nunca é atravessada por braços ou pernas', () => {
  const { dev } = world();
  const { mug, torso, arms, legs } = dev.parts;
  const states = [{ speed: 3.4 }, { speed: 3.4, tired: true }, { speed: 2, carrying: true }, { speed: 0, tired: true }, { speed: 0, seat: 1, typing: true }];
  const inverse = new THREE.Matrix4(), mugBox = new THREE.Box3(), limbBox = new THREE.Box3(), part = new THREE.Box3(), corner = new THREE.Vector3();
  const mugParts = [];
  mug.traverse(object => { if (object.isMesh) mugParts.push(object); });
  const mugIn = frame => { mugBox.makeEmpty(); for (const object of mugParts) mugBox.union(boxIn(frame, object, part)); return mugBox; };
  // Caixa de cada malha no espaço de um pai comum, a partir dos oito cantos transformados.
  const boxIn = (frame, mesh, out) => {
    inverse.copy(frame.matrixWorld).invert();
    out.makeEmpty();
    const { min, max } = mesh.geometry.boundingBox ?? (mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox);
    for (let k = 0; k < 8; k++) {
      corner.set(k & 1 ? max.x : min.x, k & 2 ? max.y : min.y, k & 4 ? max.z : min.z).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
      out.expandByPoint(corner);
    }
    return out;
  };
  for (const motion of states) {
    for (let i = 0; i < 90; i++) {
      dev.setMotion(motion, 1 / 60);
      dev.group.updateMatrixWorld(true);
      mugIn(torso);
      for (const arm of arms) arm.traverse(part => { if (part.isMesh) assert.ok(!boxIn(torso, part, limbBox).intersectsBox(mugBox), `braço na caneca (${JSON.stringify(motion)})`); });
      mugIn(torso.parent);
      for (const leg of legs) leg.traverse(part => { if (part.isMesh) assert.ok(!boxIn(torso.parent, part, limbBox).intersectsBox(mugBox), `perna na caneca (${JSON.stringify(motion)})`); });
    }
  }
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
