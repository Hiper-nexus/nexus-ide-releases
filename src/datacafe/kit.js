/** Utilitários 3D do Data Café: cache de materiais e geometrias por mundo,
 * texturas de canvas, partículas instanciadas e descarte completo. Cada mundo
 * cria o seu kit, então descartar um mundo nunca afeta outro. */
import {
  BoxGeometry, CanvasTexture, Color, DynamicDrawUsage, InstancedMesh, Matrix4, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, Object3D, RepeatWrapping, SRGBColorSpace,
} from 'three';

export function createKit() {
  const materials = new Map();
  const geometries = new Map();
  const disposables = new Set();

  function own(resource) {
    disposables.add(resource);
    return resource;
  }

  /** Material padrão, com cache por cor e opções. */
  function mat(color, { emissive = 0, emissiveIntensity = 1, roughness = 0.78, metalness = 0.08, flat = true, basic = false, transparent = false, opacity = 1 } = {}) {
    const key = `${color}|${emissive}|${emissiveIntensity}|${roughness}|${metalness}|${flat}|${basic}|${transparent}|${opacity}`;
    if (!materials.has(key)) {
      const material = basic
        ? new MeshBasicMaterial({ color, toneMapped: false, transparent, opacity, depthWrite: !transparent })
        : new MeshStandardMaterial({ color, roughness, metalness, flatShading: flat, emissive, emissiveIntensity, transparent, opacity });
      materials.set(key, own(material));
    }
    return materials.get(key);
  }

  function geo(key, make) {
    if (!geometries.has(key)) geometries.set(key, own(make()));
    return geometries.get(key);
  }

  function boxGeo(w, h, d) {
    return geo(`box:${w}:${h}:${d}`, () => new BoxGeometry(w, h, d));
  }

  /** Caixa posicionada, com sombra. */
  function box(parent, [w, h, d], [x, y, z], material, { cast = true, receive = true } = {}) {
    const mesh = new Mesh(boxGeo(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    parent.add(mesh);
    return mesh;
  }

  function mesh(parent, geometry, material, [x, y, z] = [0, 0, 0], { cast = true, receive = true } = {}) {
    const object = new Mesh(geometry, material);
    object.position.set(x, y, z);
    object.castShadow = cast;
    object.receiveShadow = receive;
    parent.add(object);
    return object;
  }

  /** Textura desenhada num canvas. `paint(context, canvas)` pode ser chamado de novo via redraw(). */
  function canvasTexture(width, height, paint, { repeat = null } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const texture = own(new CanvasTexture(canvas));
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 4;
    if (repeat) {
      texture.wrapS = texture.wrapT = RepeatWrapping;
      texture.repeat.set(repeat[0], repeat[1]);
    }
    const redraw = (...args) => { paint(context, canvas, ...args); texture.needsUpdate = true; };
    redraw();
    return { texture, canvas, context, redraw };
  }

  /** InstancedMesh com matrizes definidas por `place(dummy, entry, index)`. */
  function instanced(parent, geometry, material, entries, place, { cast = true, receive = true, dynamic = false } = {}) {
    const object = own(new InstancedMesh(geometry, material, Math.max(1, entries.length)));
    object.count = entries.length;
    object.castShadow = cast;
    object.receiveShadow = receive;
    if (dynamic) object.instanceMatrix.setUsage(DynamicDrawUsage);
    const dummy = new Object3D();
    entries.forEach((entry, index) => {
      dummy.position.set(0, 0, 0); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1);
      place(dummy, entry, index);
      dummy.updateMatrix();
      object.setMatrixAt(index, dummy.matrix);
    });
    object.instanceMatrix.needsUpdate = true;
    object.computeBoundingSphere();
    parent.add(object);
    return object;
  }

  function dispose() {
    for (const resource of disposables) resource.dispose?.();
    disposables.clear();
    materials.clear();
    geometries.clear();
  }

  return { mat, geo, boxGeo, box, mesh, canvasTexture, instanced, own, dispose };
}

/** Partículas em cubinhos instanciados. Rajadas com gravidade própria: faíscas caem, vapor sobe. */
export class Particles {
  constructor(kit, parent, capacity = 240) {
    this.capacity = capacity;
    this.mesh = kit.own(new InstancedMesh(kit.boxGeo(0.09, 0.09, 0.09), kit.mat(0xffffff, { basic: true }), capacity));
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.items = Array.from({ length: capacity }, () => ({ life: 0, ttl: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: 0, size: 1 }));
    this.dummy = new Object3D();
    this.cursor = 0;
    this.color = new Color();
    const hidden = new Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, hidden);
    this.mesh.setColorAt(0, this.color.set(0xffffff));
    parent.add(this.mesh);
  }

  burst(x, y, z, { count = 12, colors = [0xffffff], speed = 2, up = 2, gravity = 9, life = 0.8, size = 1, spread = 1 } = {}) {
    for (let i = 0; i < count; i++) {
      const item = this.items[this.cursor];
      const angle = Math.random() * Math.PI * 2;
      const push = Math.random() * speed * spread;
      item.ttl = item.life = life * (0.6 + Math.random() * 0.6);
      item.x = x; item.y = y; item.z = z;
      item.vx = Math.cos(angle) * push;
      item.vz = Math.sin(angle) * push;
      item.vy = up * (0.5 + Math.random());
      item.g = gravity;
      item.size = size * (0.7 + Math.random() * 0.6);
      this.mesh.setColorAt(this.cursor, this.color.set(colors[i % colors.length]));
      this.cursor = (this.cursor + 1) % this.capacity;
    }
    this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt) {
    let active = false;
    const dummy = this.dummy;
    for (let i = 0; i < this.capacity; i++) {
      const item = this.items[i];
      if (item.life <= 0) continue;
      active = true;
      item.life -= dt;
      if (item.life <= 0) {
        dummy.scale.setScalar(0);
      } else {
        item.vy -= item.g * dt;
        item.x += item.vx * dt; item.y += item.vy * dt; item.z += item.vz * dt;
        if (item.y < 0.05) { item.y = 0.05; item.vy *= -0.3; item.vx *= 0.6; item.vz *= 0.6; }
        dummy.position.set(item.x, item.y, item.z);
        dummy.scale.setScalar(item.size * (item.life / item.ttl));
        dummy.rotation.set(item.life * 6, item.life * 4, 0);
      }
      dummy.updateMatrix();
      this.mesh.setMatrixAt(i, dummy.matrix);
    }
    if (active) this.mesh.instanceMatrix.needsUpdate = true;
    return active;
  }
}

/** Libera tudo que ficou pendurado na cena e ainda não foi registrado no kit. */
export function disposeTree(root) {
  const seen = new Set();
  const release = resource => { if (resource && !seen.has(resource)) { seen.add(resource); resource.dispose?.(); } };
  root.traverse(object => {
    release(object.geometry);
    for (const material of [].concat(object.material ?? [])) { release(material.map); release(material); }
    if (object.isInstancedMesh) release(object);
  });
}
