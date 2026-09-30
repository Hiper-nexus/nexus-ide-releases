import {
  BackSide, BoxGeometry, CanvasTexture, CircleGeometry, Color, ConeGeometry, CylinderGeometry,
  DodecahedronGeometry, DoubleSide, ExtrudeGeometry, Float32BufferAttribute, Group,
  InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D,
  PlaneGeometry, Shape, SphereGeometry, SpotLight, SRGBColorSpace, TorusGeometry, Vector3,
} from 'three';
import { initialBarrels } from './props.js';
import { WORLD } from './layout.js';

/** Pink City at dusk: warm ground, dark asphalt, neon signs, coloured trees. */
export const COLORS = {
  ground: 0xb0616a, groundLight: 0xc6767c, asphalt: 0x2a2430, marking: 0xfaf0e8, curb: 0x4b3a45,
  floor: 0x242127, rim: 0x111013, raised: 0x37333d, pink: 0xff4f8b,
  white: 0xfaf0e8, dark: 0x19171d, mint: 0x7ee2a8, orange: 0xe5a388,
  coffee: 0x62412f, metal: 0x4b4551, leaf: 0x687b69, red: 0xc2452f, amber: 0xffb35c,
  trunk: 0x4b3038, foliageA: 0xff7a6e, foliageB: 0x7ee2a8, foliageC: 0xffb35c, grass: 0x5bb68f,
  skyTop: 0x1a0f2e, skyHorizon: 0xff6f91, skyGlow: 0xffb27a, fog: 0xff6f91, water: 0x3a2a55,
};
const materials = new Map();
export const ANIMATED = { pulse: [], blink: [] };

function material(color, emissive = false) {
  const key = `${color}-${emissive}`;
  if (!materials.has(key)) {
    const created = new MeshStandardMaterial({
      color, roughness: 0.72, metalness: 0.1,
      ...(emissive ? { emissive: color, emissiveIntensity: 0.55 } : {}),
    });
    materials.set(key, created);
    if (emissive) ANIMATED.pulse.push(created);
  }
  return materials.get(key);
}

function blinkMaterial(color) {
  const created = new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1 });
  ANIMATED.blink.push(created);
  return created;
}

export function glowBox(parent, dimensions, position, color) {
  const object = new Mesh(new BoxGeometry(...dimensions), blinkMaterial(color));
  object.position.set(...position);
  parent.add(object);
  return object;
}

export function box(parent, dimensions, position, color, emissive = false) {
  const object = new Mesh(new BoxGeometry(...dimensions), material(color, emissive));
  object.position.set(...position);
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

export function cylinder(parent, radius, height, position, color, segments = 16) {
  const object = new Mesh(new CylinderGeometry(radius,radius,height,segments), material(color));
  object.position.set(...position);
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

/** Text on a plane. VT323 is loaded by the page before the world is built. */
export function sign(parent, text, width, height, position, foreground = '#faf7f9', background = '#19171d', font = 'monospace') {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = Math.max(32, Math.round(1024 * height / width));
  const context = canvas.getContext('2d');
  if (background) { context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height); }
  context.fillStyle = foreground;
  context.font = `${font === 'VT323' ? 400 : 600} ${Math.round(canvas.height * (font === 'VT323' ? 0.86 : 0.48))}px ${font === 'VT323' ? 'VT323, monospace' : 'ui-monospace, monospace'}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 512, canvas.height / 2 + (font === 'VT323' ? canvas.height * 0.04 : 0), 990);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const mesh = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ map: texture, side: DoubleSide, transparent: !background, depthWrite: Boolean(background) }));
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

/** Text painted on the ground, the way a track teaches its rules. */
function groundText(parent, entry) {
  const tone = entry.tone === 'title' ? 'rgba(250,240,232,.92)' : 'rgba(250,240,232,.72)';
  const mesh = sign(parent, entry.text, entry.width, entry.height, [entry.x, 0.035, entry.z], entry.tone === 'title' ? '#ff4f8b' : tone, null, 'VT323');
  mesh.rotation.set(-Math.PI / 2, 0, entry.rotation);
  mesh.receiveShadow = false;
  return mesh;
}

function cup(parent, position, scale = 1, color = COLORS.white) {
  const group = new Group();
  group.position.set(...position);
  group.scale.setScalar(scale);
  cylinder(group,0.45,0.75,[0,0.4,0],color);
  cylinder(group,0.4,0.03,[0,0.79,0],COLORS.coffee);
  const handle = new Mesh(new TorusGeometry(0.25,0.09,6,14),material(color));
  handle.position.set(0.47,0.46,0);
  group.add(handle);
  parent.add(group);
  return group;
}

function workstation(parent, position) {
  const group = new Group();
  group.position.set(...position);
  box(group,[6,.3,3.2],[0,1.8,0],COLORS.white);
  for (const x of [-2.5,2.5]) for (const z of [-1.2,1.2]) box(group,[.2,1.8,.2],[x,.85,z],COLORS.metal);
  for (const x of [-1.45,1.45]) {
    box(group,[.2,.7,.2],[x,2.25,-.6],COLORS.metal);
    box(group,[2.4,1.6,.15],[x,3.15,-.6],COLORS.dark);
    box(group,[2.15,1.35,.04],[x,3.15,-.51],COLORS.rim);
    for (let line=0;line<6;line++) box(group,[.5+(line%3)*.42,.04,.025],[x-.38+(line%2)*.2,3.58-line*.16,-.48],line%3===0?COLORS.pink:COLORS.mint,true);
    box(group,[1.7,.1,.6],[x,2.02,.65],COLORS.metal);
    cylinder(group,.7,.15,[x,.8,2.1],COLORS.pink);
    cylinder(group,.12,.8,[x,.38,2.1],COLORS.metal);
    box(group,[1.45,1.35,.2],[x,1.5,2.75],COLORS.raised);
  }
  cup(group,[.3,1.97,.9],.8);
  parent.add(group);
}

function prize(parent, position, color, label, key) {
  const group=new Group();
  group.position.set(...position);
  cylinder(group,2.2,.3,[0,.16,0],COLORS.raised,8);
  const halo=new Mesh(new CylinderGeometry(2.5,2.5,.06,8),material(color,true));
  halo.position.set(0,.34,0);
  group.add(halo);
  box(group,[2.1,2.1,2.1],[0,1.42,0],color);
  box(group,[2.3,.2,2.3],[0,2.48,0],COLORS.dark);
  box(group,[.18,2.35,2.13],[0,1.48,0],COLORS.white);
  box(group,[2.13,2.35,.18],[0,1.48,0],COLORS.white);
  const tag=sign(group,label,1.4,.65,[0,1.52,1.081],'#19171d',color===COLORS.orange?'#e5a388':'#7ee2a8');
  tag.rotation.y=0;
  for(const x of [-2.1,2.1]) { cylinder(group,.08,3.2,[x,1.6,2.1],COLORS.metal); box(group,[.5,.14,.5],[x,3.2,2.1],color,true); }
  parent.add(group);
  group.userData.station=key;
  return group;
}

function cafe(parent, position) {
  const group = new Group();
  group.position.set(...position);
  box(group,[8,3.4,1.2],[0,1.7,0],COLORS.raised);
  box(group,[8.4,.35,2.4],[0,3.5,0],COLORS.white);
  sign(group,'DEV CAFÉ',7,1.2,[0,2.2,.62],'#ff4f8b','#19171d','VT323');
  sign(group,'CODE + COFFEE',5.4,.5,[0,1.15,.62],'#aaa2a8');
  for(const x of [-3.9,3.9]) cylinder(group,.14,3.4,[x,1.7,.9],COLORS.dark);
  cup(group,[-2.2,3.7,0],2.6,COLORS.orange);
  glowBox(group,[3.2,.18,.18],[1.6,3.85,-.2],COLORS.pink);
  box(group,[2,1.4,1.8],[5.2,.7,1.4],COLORS.white);
  box(group,[1.6,1,.7],[5.2,1.7,1.3],COLORS.metal);
  box(group,[1.3,.15,1.4],[5.2,2.35,1.5],COLORS.dark);
  for(const [x,z] of [[-2.5,4.5],[2.5,4.5]]) { cylinder(group,.9,.12,[x,.85,z],COLORS.white); cylinder(group,.1,.85,[x,.42,z],COLORS.metal); cup(group,[x+.3,.92,z-.2],.5,COLORS.pink); }
  parent.add(group);
}

function liveStation(parent, position) {
  const group=new Group();
  group.position.set(...position);
  cylinder(group,3.2,.3,[0,.15,0],COLORS.raised,24);
  box(group,[4.6,3.2,.3],[0,2.4,-.5],COLORS.dark);
  sign(group,'>_ AO VIVO',4.2,1.4,[0,2.75,-.34],'#ff4f8b','#19171d','VT323');
  sign(group,'VIBE CODING',3.6,.6,[0,1.6,-.34],'#aaa2a8');
  for(const x of [-2.1,2.1]) {
    box(group,[.25,2.6,.3],[x,1.3,-.5],COLORS.metal);
    box(group,[.8,1.5,.7],[x,.9,1],COLORS.metal);
    cylinder(group,.24,.1,[x,1.3,1.38],COLORS.dark).rotation.x=Math.PI/2;
    cylinder(group,.3,.1,[x,.7,1.38],COLORS.dark).rotation.x=Math.PI/2;
  }
  glowBox(group,[1.8,.22,.22],[0,4.25,-.5],COLORS.pink);
  for(const x of [-3,3]) { cylinder(group,.08,4.4,[x,2.2,-.5],COLORS.metal); box(group,[.4,.3,.4],[x,4.4,-.5],COLORS.pink,true); }
  parent.add(group);
  return group;
}

function barrelMesh(parent, x, z) {
  const group = new Group();
  group.position.set(x,0,z);
  cylinder(group,.5,1.15,[0,.58,0],COLORS.red,14);
  cylinder(group,.52,.1,[0,1.14,0],COLORS.dark,14);
  const band = new Mesh(new CylinderGeometry(.51,.51,.16,14), material(COLORS.amber,true));
  band.position.set(0,.92,0);
  group.add(band);
  parent.add(group);
  return group;
}

export function makeBarrels(scene) {
  return initialBarrels().map(barrel => ({...barrel, mesh: barrelMesh(scene, barrel.x, barrel.z)}));
}

function propMesh(kind) {
  const group = new Group();
  if (kind === 'cone') {
    const cone = new Mesh(new ConeGeometry(.34,.8,10), material(COLORS.orange));
    cone.position.set(0,.4,0);
    cone.castShadow = true;
    group.add(cone);
    box(group,[.4,.07,.4],[0,.05,0],COLORS.dark);
  } else if (kind === 'pin') {
    cylinder(group,.22,1,[0,.5,0],COLORS.white,10);
    cylinder(group,.24,.12,[0,.72,0],COLORS.pink,10);
    cylinder(group,.16,.3,[0,1.1,0],COLORS.white,10);
  } else {
    box(group,[.85,.85,.85],[0,.43,0],COLORS.metal);
    box(group,[.9,.14,.9],[0,.43,0],COLORS.white);
  }
  return group;
}

/** Cones, crates and bowling pins are all pushable props. */
export function makeProps(scene) {
  const spots = [...WORLD.props, ...WORLD.pins.map(([x,z]) => [x,z,'pin'])];
  return spots.map(([x,z,kind],index) => {
    const group = propMesh(kind);
    group.position.set(x,0,z);
    scene.add(group);
    return {id:index,kind,x,z,vx:0,vz:0,mesh:group};
  });
}

function instanced(parent, geometry, color, entries, place) {
  const mesh = new InstancedMesh(geometry, material(color), entries.length);
  const dummy = new Object3D();
  entries.forEach((entry, index) => { place(dummy, entry); dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix); });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function trees(parent) {
  const groups = [[], [], []];
  WORLD.trees.forEach((tree, index) => groups[index % 3].push(tree));
  instanced(parent, new CylinderGeometry(.16,.24,1.4,6), COLORS.trunk, WORLD.trees, (d,[x,z,s]) => { d.position.set(x,.7*s,z); d.scale.setScalar(s); d.rotation.set(0,0,0); });
  [COLORS.foliageA, COLORS.foliageB, COLORS.foliageC].forEach((color, index) => {
    if (!groups[index].length) return;
    instanced(parent, new DodecahedronGeometry(1.1, 0), color, groups[index], (d,[x,z,s]) => { d.position.set(x,1.9*s,z); d.scale.set(s,s*1.2,s); d.rotation.set(0,x*.7+z*.3,0); });
  });
}

/** Deterministic scatter of grass tufts and rocks off the roads, so the plain never looks empty. */
function scatter(parent) {
  const tufts = [], rocks = [];
  let seed = 7;
  const random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const onRoad = (x, z) => WORLD.roads.some(r => { const fx = -Math.sin(r.heading), fz = -Math.cos(r.heading); const dx = x - r.x, dz = z - r.z; const along = dx*fx + dz*fz, across = dx*Math.cos(r.heading) - dz*Math.sin(r.heading); return Math.abs(along) < r.length/2 + 1 && Math.abs(across) < r.width/2 + 1; });
  for (let i = 0; i < 260; i++) {
    const x = (random() - .5) * 110, z = (random() - .5) * 110;
    if (onRoad(x, z) || Math.hypot(x, z) < 6 || Math.hypot(x - 32, z + 34) < 10 || Math.hypot(x + 32, z - 34) < 8) continue;
    (random() < .82 ? tufts : rocks).push([x, z, .5 + random() * .9, random() * Math.PI]);
  }
  instanced(parent, new ConeGeometry(.45, .9, 5), COLORS.grass, tufts, (d,[x,z,s,r]) => { d.position.set(x,.4*s,z); d.scale.set(s,s,s); d.rotation.set(0,r,0); });
  instanced(parent, new DodecahedronGeometry(.5, 0), COLORS.curb, rocks, (d,[x,z,s,r]) => { d.position.set(x,.25*s,z); d.scale.set(s,s*.7,s); d.rotation.set(0,r,0); });
  // The edge of the city: a ring of neon posts where the drivable area ends.
  const edge = WORLD.limit + 2.5, posts = [];
  for (let i = -6; i <= 6; i++) { const t = i / 6 * edge; posts.push([t, -edge], [t, edge], [-edge, t], [edge, t]); }
  instanced(parent, new BoxGeometry(.3, 2.6, .3), COLORS.dark, posts, (d,[x,z]) => { d.position.set(x,1.3,z); d.scale.setScalar(1); d.rotation.set(0,0,0); });
  const glow = new InstancedMesh(new BoxGeometry(.34, .5, .34), new MeshStandardMaterial({ color: COLORS.pink, emissive: COLORS.pink, emissiveIntensity: 1.2 }), posts.length);
  const dummy = new Object3D();
  posts.forEach(([x,z], index) => { dummy.position.set(x,2.5,z); dummy.updateMatrix(); glow.setMatrixAt(index, dummy.matrix); });
  parent.add(glow);
}

function lamps(parent) {
  instanced(parent, new CylinderGeometry(.08,.11,4.4,6), COLORS.metal, WORLD.lamps, (d,[x,z]) => { d.position.set(x,2.2,z); d.scale.setScalar(1); d.rotation.set(0,0,0); });
  const heads = new InstancedMesh(new BoxGeometry(.6,.18,.6), new MeshStandardMaterial({ color: COLORS.amber, emissive: COLORS.amber, emissiveIntensity: 1.4 }), WORLD.lamps.length);
  const pools = new InstancedMesh(new CircleGeometry(3.2, 20), new MeshBasicMaterial({ color: COLORS.amber, transparent: true, opacity: .16, depthWrite: false }), WORLD.lamps.length);
  const dummy = new Object3D();
  WORLD.lamps.forEach(([x,z], index) => {
    dummy.position.set(x,4.4,z); dummy.rotation.set(0,0,0); dummy.updateMatrix(); heads.setMatrixAt(index, dummy.matrix);
    dummy.position.set(x,.04,z); dummy.rotation.set(-Math.PI/2,0,0); dummy.updateMatrix(); pools.setMatrixAt(index, dummy.matrix);
  });
  parent.add(heads, pools);
}

function roads(parent) {
  for (const road of WORLD.roads) {
    const strip = new Mesh(new PlaneGeometry(road.width, road.length), material(COLORS.asphalt));
    strip.rotation.set(-Math.PI/2, 0, road.heading);
    strip.position.set(road.x, .02, road.z);
    strip.receiveShadow = true;
    parent.add(strip);
    const dashes = Math.floor(road.length / 3);
    const marks = new InstancedMesh(new PlaneGeometry(.14, 1.4), new MeshBasicMaterial({ color: COLORS.marking }), dashes);
    const dummy = new Object3D();
    for (let i = 0; i < dashes; i++) {
      const along = -road.length/2 + 1.5 + i*3;
      dummy.position.set(road.x - Math.sin(road.heading)*along, .03, road.z - Math.cos(road.heading)*along);
      dummy.rotation.set(-Math.PI/2, 0, road.heading);
      dummy.updateMatrix();
      marks.setMatrixAt(i, dummy.matrix);
    }
    parent.add(marks);
  }
}

function ramp(parent, entry) {
  const group = new Group();
  group.position.set(entry.x, 0, entry.z);
  group.rotation.y = entry.heading;
  const shape = new Shape();
  shape.moveTo(-entry.length/2, 0); shape.lineTo(entry.length/2, 0); shape.lineTo(entry.length/2, entry.height);
  const geometry = new ExtrudeGeometry(shape, { depth: entry.width, bevelEnabled: false });
  const mesh = new Mesh(geometry, material(COLORS.pink));
  // The shape rises along local x; rotate so it rises toward the group's forward (-z) direction.
  mesh.rotation.set(0, Math.PI/2, 0);
  mesh.position.set(entry.width/2, 0, 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  for (let i = 0; i < 4; i++) box(group, [entry.width + .2, .05, .3], [0, .06 + i*entry.height/4, entry.length/2 - i*entry.length/4 - .6], COLORS.white);
  parent.add(group);
  return group;
}

function boostPad(parent, entry) {
  const group = new Group();
  group.position.set(entry.x, .045, entry.z);
  group.rotation.y = entry.heading;
  const base = new Mesh(new PlaneGeometry(entry.width, entry.length), material(COLORS.rim));
  base.rotation.x = -Math.PI/2;
  group.add(base);
  const chevrons = new Mesh(new PlaneGeometry(entry.width*.7, entry.length*.8), blinkMaterial(COLORS.mint));
  chevrons.rotation.x = -Math.PI/2;
  chevrons.position.y = .01;
  group.add(chevrons);
  parent.add(group);
  return group;
}

function sky(scene) {
  const geometry = new SphereGeometry(230, 24, 12);
  const colors = [];
  const position = geometry.attributes.position;
  const top = new Color(COLORS.skyTop), horizon = new Color(COLORS.skyHorizon), glow = new Color(COLORS.skyGlow);
  for (let i = 0; i < position.count; i++) {
    const t = Math.max(0, Math.min(1, position.getY(i) / 230));
    const c = t < .06 ? glow.clone().lerp(horizon, t / .06) : horizon.clone().lerp(top, Math.min(1, (t - .06) / .5));
    colors.push(c.r, c.g, c.b);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  const dome = new Mesh(geometry, new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, toneMapped: false }));
  scene.add(dome);
  return dome;
}

export function makeWorld(scene) {
  const root = new Group();
  scene.add(root);
  sky(scene);
  const size = WORLD.limit * 2 + 12;
  const ground = new Mesh(new CircleGeometry(size * 1.4, 64), material(COLORS.ground));
  ground.rotation.x = -Math.PI/2;
  ground.receiveShadow = true;
  root.add(ground);
  for (const [x,z,r] of [[-14,-18,7],[18,-20,6],[-38,-30,9],[40,30,8],[-10,40,6],[30,44,5],[-46,16,6],[46,-6,5]]) {
    const patch = new Mesh(new CircleGeometry(r, 18), material(COLORS.grass));
    patch.rotation.x = -Math.PI/2; patch.position.set(x,.015,z); patch.receiveShadow = true; root.add(patch);
  }
  roads(root);
  for (const entry of WORLD.signs) groundText(root, entry);
  trees(root);
  scatter(root);
  lamps(root);
  const rampMeshes = WORLD.ramps.map(entry => ramp(root, entry));
  const padMeshes = WORLD.boostPads.map(entry => boostPad(root, entry));
  const cafeDistrict = WORLD.districts.find(d => d.key === 'cafe');
  cafe(root, [cafeDistrict.x, 0, cafeDistrict.z]);
  workstation(root, [cafeDistrict.x - 12, 0, cafeDistrict.z + 6]);
  workstation(root, [cafeDistrict.x + 12, 0, cafeDistrict.z + 6]);
  const yard = WORLD.districts.find(d => d.key === 'yard');
  box(root, [16, .05, 16], [yard.x, .025, yard.z], COLORS.rim);
  for (const [dx,dz] of [[-8,-8],[8,-8],[-8,8],[8,8]]) { cylinder(root,.12,2.2,[yard.x+dx,1.1,yard.z+dz],COLORS.metal); box(root,[.4,.2,.4],[yard.x+dx,2.2,yard.z+dz],COLORS.amber,true); }
  const pins = WORLD.districts.find(d => d.key === 'pins');
  const lane = new Mesh(new PlaneGeometry(8, 14), material(COLORS.raised));
  lane.rotation.x = -Math.PI/2; lane.position.set(pins.x, .02, pins.z + 2); lane.receiveShadow = true; root.add(lane);
  const stations = WORLD.stations.map(entry => {
    const mesh = entry.key === 'live' ? liveStation(root, [entry.x, 0, entry.z]) : prize(root, [entry.x, 0, entry.z], entry.key === 'claude' ? COLORS.orange : COLORS.mint, entry.key.toUpperCase(), entry.key);
    mesh.userData.station = entry.key;
    return { ...entry, mesh, anchor: new Vector3(entry.x, entry.anchorY, entry.z) };
  });
  const coffees = WORLD.coffees.map(([x,z], id) => ({ id, x, z, mesh: cup(root, [x,.1,z], .65, COLORS.orange) }));
  return { root, coffees, stations, ramps: rampMeshes, pads: padMeshes };
}

export function makeRover(scene) {
  const group=new Group();
  const chassis=new Group();
  group.add(chassis);
  box(chassis,[1.3,.32,1.9],[0,.55,0],COLORS.white);
  box(chassis,[1.36,.12,.5],[0,.44,.72],COLORS.dark);
  box(chassis,[.9,.6,.95],[0,.98,-.1],COLORS.pink);
  box(chassis,[.7,.36,.05],[0,1.06,.39],COLORS.dark);
  box(chassis,[.17,.14,.05],[-.2,1.05,.42],COLORS.mint,true);
  box(chassis,[.17,.14,.05],[.2,1.05,.42],COLORS.mint,true);
  const headlights=[-.42,.42].map(x=>{const lamp=new Mesh(new BoxGeometry(.22,.12,.06),new MeshStandardMaterial({color:COLORS.white,emissive:COLORS.amber,emissiveIntensity:1.6}));lamp.position.set(x,.62,.97);chassis.add(lamp);return lamp;});
  const brakeMaterial=new MeshStandardMaterial({color:COLORS.red,emissive:COLORS.red,emissiveIntensity:.25});
  const brakes=[-.42,.42].map(x=>{const lamp=new Mesh(new BoxGeometry(.22,.1,.05),brakeMaterial);lamp.position.set(x,.62,-.96);chassis.add(lamp);return lamp;});
  const exhaust=new Mesh(new ConeGeometry(.16,.6,8),new MeshBasicMaterial({color:COLORS.amber,transparent:true,opacity:0,toneMapped:false}));
  exhaust.position.set(0,.5,-1.25);exhaust.rotation.x=-Math.PI/2;chassis.add(exhaust);
  cylinder(chassis,.04,.65,[0,1.55,-.5],COLORS.metal);
  const antenna=new Mesh(new SphereGeometry(.1,8,8),material(COLORS.pink,true));
  antenna.position.set(0,1.87,-.5);
  chassis.add(antenna);
  const wheels=[],fronts=[];
  for(const [x,z,front] of [[-.72,.62,1],[.72,.62,1],[-.72,-.62,0],[.72,-.62,0]]) {
    const pivot=new Group();
    pivot.position.set(x,.35,z);
    const wheel=cylinder(pivot,.32,.24,[0,0,0],COLORS.dark,12);
    wheel.rotation.z=Math.PI/2;
    const hub=cylinder(pivot,.14,.26,[0,0,0],COLORS.white,8);
    hub.rotation.z=Math.PI/2;
    group.add(pivot);
    wheels.push(wheel,hub);
    if(front)fronts.push(pivot);
  }
  const headlight=new SpotLight(0xffd9a8,0,26,.55,.6,1.2);
  headlight.position.set(0,1,1);
  headlight.target.position.set(0,.2,9);
  group.add(headlight,headlight.target);
  scene.add(group);
  return {group,chassis,wheels,fronts,headlights,brakeMaterial,exhaust,headlight};
}

/** Release everything a scene holds on the GPU: geometries, materials (with their maps) and instanced buffers. */
export function disposeObjects(scene) {
  const seen = new Set();
  const release = resource => { if (resource && !seen.has(resource)) { seen.add(resource); resource.dispose(); } };
  scene.traverse(object => {
    release(object.geometry);
    for (const material of [].concat(object.material ?? [])) { release(material.map); release(material.emissiveMap); release(material); }
    if (object.isInstancedMesh) release(object);
  });
}

/** Forget the shared material cache and the animated lists, so the next world rebuilds them instead of reusing
 * the ones disposeObjects() just released through the scene. */
export function disposeShared() {
  materials.clear();
  ANIMATED.pulse.length = 0;
  ANIMATED.blink.length = 0;
}
