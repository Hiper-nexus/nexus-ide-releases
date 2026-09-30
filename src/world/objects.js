import * as THREE from 'three';

export const COLORS = {
  floor: 0x242127, rim: 0x111013, raised: 0x37333d, pink: 0xff4f8b,
  white: 0xfaf0e8, dark: 0x19171d, mint: 0x7ee2a8, orange: 0xe5a388,
  coffee: 0x62412f, metal: 0x4b4551, leaf: 0x687b69,
};
const materials = new Map();

function material(color, emissive = false) {
  const key = `${color}-${emissive}`;
  if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({
    color, roughness: 0.7, metalness: 0.12,
    ...(emissive ? { emissive: color, emissiveIntensity: 0.45 } : {}),
  }));
  return materials.get(key);
}

export function box(parent, dimensions, position, color, emissive = false) {
  const object = new THREE.Mesh(new THREE.BoxGeometry(...dimensions), material(color, emissive));
  object.position.set(...position);
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

export function cylinder(parent, radius, height, position, color, segments = 16) {
  const object = new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,height,segments), material(color));
  object.position.set(...position);
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

export function sign(parent, text, width, height, position, foreground = '#faf7f9', background = '#19171d') {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round(512 * height / width);
  const context = canvas.getContext('2d');
  context.fillStyle = background;
  context.fillRect(0,0,canvas.width,canvas.height);
  context.fillStyle = foreground;
  context.font = `600 ${Math.round(canvas.height*.48)}px monospace`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text,256,canvas.height/2,480);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width,height), new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide}));
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

function cup(parent, position, scale = 1, color = COLORS.white) {
  const group = new THREE.Group();
  group.position.set(...position);
  group.scale.setScalar(scale);
  cylinder(group,0.45,0.75,[0,0.4,0],color);
  cylinder(group,0.4,0.03,[0,0.79,0],COLORS.coffee);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.25,0.09,6,14),material(color));
  handle.position.set(0.47,0.46,0);
  group.add(handle);
  parent.add(group);
  return group;
}

function workstation(parent) {
  const group = new THREE.Group();
  group.position.set(-5,0,-2);
  box(group,[6,.3,3.2],[0,1.8,0],COLORS.white);
  for (const x of [-2.5,2.5]) for (const z of [-1.2,1.2]) box(group,[.2,1.8,.2],[x,.85,z],COLORS.metal);
  for (const x of [-1.45,1.45]) {
    box(group,[.2,.7,.2],[x,2.25,-.6],COLORS.metal);
    box(group,[2.4,1.6,.15],[x,3.15,-.6],COLORS.dark);
    box(group,[2.15,1.35,.04],[x,3.15,-.51],COLORS.rim);
    for (let line=0;line<6;line++) box(group,[.5+(line%3)*.42,.04,.025],[x-.38+(line%2)*.2,3.58-line*.16,-.48],line%3===0?COLORS.pink:COLORS.mint,true);
    box(group,[1.7,.1,.6],[x,2.02,.65],COLORS.metal);
    for (let row=0;row<3;row++) for(let key=0;key<8;key++) box(group,[.12,.03,.1],[x-.67+key*.19,2.09,.45+row*.17],COLORS.dark);
    cylinder(group,.7,.15,[x,.8,2.1],COLORS.pink);
    cylinder(group,.12,.8,[x,.38,2.1],COLORS.metal);
    box(group,[1.45,1.35,.2],[x,1.5,2.75],COLORS.raised);
  }
  cup(group,[.3,1.97,.9],.8);
  parent.add(group);
}

function plant(parent, position, scale = 1) {
  const group = new THREE.Group();
  group.position.set(...position);
  group.scale.setScalar(scale);
  cylinder(group,.5,.65,[0,.32,0],COLORS.metal);
  for(let i=0;i<5;i++) {
    const leaf=new THREE.Mesh(new THREE.ConeGeometry(.4,1.7,5),material(COLORS.leaf));
    leaf.position.set(Math.cos(i*1.25)*.23,1.13,Math.sin(i*1.25)*.23);
    leaf.rotation.z=Math.sin(i*1.25)*.35;
    group.add(leaf);
  }
  parent.add(group);
}

function prize(parent, position, color, label, key) {
  const group=new THREE.Group();
  group.position.set(...position);
  cylinder(group,1.8,.25,[0,.16,0],COLORS.raised,6);
  box(group,[2.1,2.1,2.1],[0,1.42,0],color);
  box(group,[2.3,.2,2.3],[0,2.48,0],COLORS.dark);
  box(group,[.18,2.35,2.13],[0,1.48,0],COLORS.white);
  box(group,[2.13,2.35,.18],[0,1.48,0],COLORS.white);
  const tag=sign(group,label,1.4,.65,[0,1.52,1.075],'#19171d',color===COLORS.orange?'#e5a388':'#7ee2a8');
  tag.position.z=1.081;
  parent.add(group);
  group.userData.station=key;
  return group;
}

function cafe(parent) {
  const group = new THREE.Group();
  group.position.set(-7,0,-8);
  box(group,[7.5,3,.55],[0,1.4,0],COLORS.raised);
  sign(group,'DEV CAFE',6.5,1,[0,2.0,.29],'#ff4f8b');
  sign(group,'CODE + COFFEE',5.1,.45,[0,1.1,.29],'#aaa2a8');
  box(group,[7.9,.3,1.2],[0,3.1,0],COLORS.white);
  cylinder(group,.13,3.1,[-3.8,1.45,0],COLORS.dark);
  cylinder(group,.13,3.1,[3.8,1.45,0],COLORS.dark);
  cup(group,[-2,3.25,0],2.6,COLORS.orange);
  box(group,[2,1.4,1.8],[4.6,.7,.2],COLORS.white);
  box(group,[1.6,1,.7],[4.6,1.7,.1],COLORS.metal);
  box(group,[1.3,.15,1.4],[4.6,2.35,.3],COLORS.dark);
  parent.add(group);
}

function liveStation(parent) {
  const group=new THREE.Group();
  group.position.set(6,0,-7);
  cylinder(group,2.8,.25,[0,.2,0],COLORS.raised);
  box(group,[4,3,.25],[0,2.4,-.5],COLORS.dark);
  sign(group,'>_ AO VIVO',3.6,1.3,[0,2.7,-.36],'#ff4f8b');
  sign(group,'VIBE CODING',3.6,.6,[0,1.6,-.35],'#aaa2a8');
  for(const x of [-1.8,1.8]) {
    box(group,[.25,2.2,.3],[x,1.1,-.5],COLORS.metal);
    box(group,[.8,1.5,.7],[x,.85,1],COLORS.metal);
    cylinder(group,.24,.1,[x,1.25,1.38],COLORS.dark).rotation.x=Math.PI/2;
    cylinder(group,.3,.1,[x,.65,1.38],COLORS.dark).rotation.x=Math.PI/2;
  }
  parent.add(group);
  return group;
}

export function makeWorld(scene) {
  const root=new THREE.Group();
  scene.add(root);
  box(root,[34,.8,34],[0,-.55,0],COLORS.rim);
  box(root,[33.6,.2,33.6],[0,-.08,0],COLORS.floor);
  const grid=new THREE.GridHelper(32,32,COLORS.metal,COLORS.raised);
  grid.position.y=.03;
  grid.material.transparent=true;
  grid.material.opacity=.35;
  root.add(grid);
  for(const x of [-16.5,16.5]) box(root,[.08,.08,33],[x,.03,0],COLORS.pink,true);
  for(const z of [-16.5,16.5]) box(root,[33,.08,.08],[0,.03,z],COLORS.pink,true);
  for(let i=0;i<7;i++) box(root,[.55,.035,.16],[-2+i*.8,.03,6.4],COLORS.white);
  const welcome=sign(root,'NEXUS / DEV CAFE',10,1.5,[0,.04,8.8],'#aaa2a8','#242127');
  welcome.rotation.x=-Math.PI/2;
  box(root,[3.2,.05,31],[0,.025,0],COLORS.rim);
  box(root,[31,.05,3.2],[0,.026,9],COLORS.rim);
  for(let i=-14;i<15;i+=2) box(root,[.1,.02,.75],[0,.06,i],COLORS.white);
  for(let i=-14;i<15;i+=2) box(root,[.75,.02,.1],[i,.065,9],COLORS.white);
  for(const x of [-3,3]) box(root,[.35,4,.35],[x,2,13.5],COLORS.metal);
  box(root,[6.4,.35,.4],[0,4,13.5],COLORS.pink,true);
  sign(root,'START / NEXUS',5.6,.65,[0,3.5,13.72],'#ff4f8b');
  for(const x of [-14,14]) for(const z of [-12,-3,6]) {
    cylinder(root,.12,3,[x,1.4,z],COLORS.metal);
    box(root,[.55,.15,.55],[x,2.95,z],COLORS.white,true);
  }
  workstation(root);
  cafe(root);
  plant(root,[-10,0,-6],1.4);
  plant(root,[10,0,-7],1.25);
  plant(root,[-10,0,6],1);
  plant(root,[10,0,7],1.5);
  box(root,[1.4,.7,1.4],[-9,.35,0],COLORS.raised);
  cup(root,[-9,.7,0],2,COLORS.white);
  const claude=prize(root,[-8,0,6],COLORS.orange,'CLAUDE','claude');
  const codex=prize(root,[8,0,4],COLORS.mint,'CODEX','codex');
  const live=liveStation(root);
  const coffeePositions=[[0,6],[-11,1],[-3,-5],[10,-7],[11,9]];
  const coffees=coffeePositions.map(([x,z],id)=>({id,x,z,mesh:cup(root,[x,.1,z],.65,COLORS.orange)}));
  return {root,coffees,stations:[{key:'claude',mesh:claude,label:'01 / Claude 20x',anchor:new THREE.Vector3(-8,3.6,6)},{key:'codex',mesh:codex,label:'02 / Codex 20x',anchor:new THREE.Vector3(8,3.6,4)},{key:'live',mesh:live,label:'03 / As lives',anchor:new THREE.Vector3(6,5.3,-7)}]};
}

export function makeRover(scene) {
  const group=new THREE.Group();
  box(group,[1.3,.35,1.8],[0,.55,0],COLORS.white);
  box(group,[.9,.6,.9],[0,.98,-.15],COLORS.pink);
  box(group,[.65,.35,.04],[0,1.05,.32],COLORS.dark);
  box(group,[.17,.14,.05],[-.2,1.05,.35],COLORS.mint,true);
  box(group,[.17,.14,.05],[.2,1.05,.35],COLORS.mint,true);
  cylinder(group,.04,.65,[0,1.55,-.5],COLORS.metal);
  const antenna=new THREE.Mesh(new THREE.SphereGeometry(.1,8,8),material(COLORS.pink,true));
  antenna.position.set(0,1.87,-.5);
  group.add(antenna);
  for(const x of [-.7,.7]) for(const z of [-.55,.55]) {
    const wheel=cylinder(group,.32,.22,[x,.35,z],COLORS.dark,12);
    wheel.rotation.z=Math.PI/2;
  }
  group.position.set(0,0,4.5);
  scene.add(group);
  return group;
}
