/** O data center em 3D. Recebe o LAYOUT (dados puros) e o catálogo de LLMs e
 * devolve os controles que o jogo usa: estado de cada rack, cafeteira, doca,
 * telão do NOC e o anel de destaque. Tudo que repete é InstancedMesh. */
import {
  BufferAttribute, BufferGeometry, Color, CylinderGeometry, Group, IcosahedronGeometry,
  Mesh, MeshBasicMaterial, Object3D, OctahedronGeometry, PlaneGeometry, RingGeometry,
} from 'three';
import { PALETTE, hex } from './palette.js';
import { findCells } from './layout.js';

const RACK = { w: 0.86, h: 2.05, d: 0.9 };
const LED_ROWS = 5;
const LEDS_PER_RACK = LED_ROWS * 2;
const ATLAS = { cols: 3, rows: 6, width: 1024, height: 512 };
const NOC_SIZE = { width: 1024, height: 274 };

function tileFloor(context, canvas) {
  const s = canvas.width;
  context.fillStyle = hex(PALETTE.floor);
  context.fillRect(0, 0, s, s);
  context.strokeStyle = hex(PALETTE.floorLine);
  context.lineWidth = 3;
  context.strokeRect(1.5, 1.5, s - 3, s - 3);
  context.fillStyle = 'rgba(255,255,255,0.025)';
  context.fillRect(6, 6, s - 12, s / 2 - 6);
  context.fillStyle = 'rgba(0,0,0,0.18)';
  for (let x = 20; x < s - 12; x += 14) for (let y = 20; y < s - 12; y += 14) context.fillRect(x, y, 3, 3);
}

function rackDoor(context, canvas) {
  const { width: w, height: h } = canvas;
  context.fillStyle = hex(PALETTE.door);
  context.fillRect(0, 0, w, h);
  for (let i = 0; i < 9; i++) {
    const y = 6 + i * (h - 12) / 9;
    context.fillStyle = '#2c2833';
    context.fillRect(4, y, w - 8, (h - 12) / 9 - 3);
    context.fillStyle = '#48414f';
    context.fillRect(4, y, w - 8, 2);
  }
  context.fillStyle = 'rgba(0,0,0,0.25)';
  for (let x = 3; x < w; x += 5) for (let y = 3; y < h; y += 5) context.fillRect(x, y, 2, 2);
}

function crateArt(context, canvas) {
  const s = canvas.width;
  context.fillStyle = hex(PALETTE.kraft);
  context.fillRect(0, 0, s, s);
  context.fillStyle = 'rgba(0,0,0,0.12)';
  for (let y = 0; y < s; y += 16) context.fillRect(0, y, s, 2);
  context.fillStyle = hex(PALETTE.pink);
  context.fillRect(0, s * 0.38, s, s * 0.14);
  context.fillStyle = '#19171d';
  context.font = `700 ${Math.round(s * 0.2)}px ui-monospace, monospace`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('GPU', s / 2, s * 0.72);
  context.font = `600 ${Math.round(s * 0.09)}px ui-monospace, monospace`;
  context.fillText('NEXUS · FRÁGIL', s / 2, s * 0.2);
}

function sunsetWindow(context, canvas) {
  const { width: w, height: h } = canvas;
  const gradient = context.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, '#2a1640');
  gradient.addColorStop(0.45, '#9b3f68');
  gradient.addColorStop(0.75, '#ff6f91');
  gradient.addColorStop(1, '#ffb27a');
  context.fillStyle = gradient;
  context.fillRect(0, 0, w, h);
  context.fillStyle = 'rgba(255,214,170,0.9)';
  context.beginPath();
  context.arc(w * 0.6, h * 0.78, h * 0.12, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = 'rgba(26,15,34,0.85)';
  for (let x = 0; x < w; x += w / 7) context.fillRect(x + 8, h * 0.82 - (x * 13 % 37), w / 9, h);
  context.fillStyle = '#1c1820';
  const bars = 4;
  for (let i = 0; i <= bars; i++) context.fillRect(i * (w - 6) / bars, 0, 6, h);
  context.fillRect(0, 0, w, 6);
  context.fillRect(0, h - 6, w, 6);
  context.fillRect(0, h / 2 - 3, w, 6);
}

function rollupDoor(context, canvas) {
  const { width: w, height: h } = canvas;
  context.fillStyle = '#3a3440';
  context.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 10) {
    context.fillStyle = '#4a4352';
    context.fillRect(0, y, w, 6);
  }
  context.fillStyle = hex(PALETTE.gold);
  context.font = `700 ${Math.round(h * 0.09)}px ui-monospace, monospace`;
  context.textAlign = 'center';
  context.fillText('DOCA · ENTREGA DE GPUs', w / 2, h * 0.3);
}

function hazard(context, canvas) {
  const { width: w, height: h } = canvas;
  context.fillStyle = '#19171d';
  context.fillRect(0, 0, w, h);
  context.fillStyle = hex(PALETTE.gold);
  for (let x = -h; x < w + h; x += h * 1.2) {
    context.beginPath();
    context.moveTo(x, h); context.lineTo(x + h * 0.6, h); context.lineTo(x + h * 1.2, 0); context.lineTo(x + h * 0.6, 0);
    context.fill();
  }
}

function codeScreen(context, canvas) {
  const { width: w, height: h } = canvas;
  context.fillStyle = '#0e0c12';
  context.fillRect(0, 0, w, h);
  const colors = [hex(PALETTE.pink), hex(PALETTE.green), hex(PALETTE.gold), '#8b80ff', '#aaa2a8'];
  for (let y = 8, i = 0; y < h - 6; y += 8, i++) {
    const indent = (i * 7 % 4) * 8;
    context.fillStyle = colors[i % colors.length];
    context.fillRect(8 + indent, y, 18 + (i * 29 % 60), 3);
    context.fillStyle = '#5c5460';
    context.fillRect(30 + indent + (i * 29 % 60), y, 10 + (i * 17 % 40), 3);
  }
}

function neonText(text, color) {
  return (context, canvas) => {
    const { width: w, height: h } = canvas;
    context.clearRect(0, 0, w, h);
    context.font = `400 ${Math.round(h * 0.78)}px VT323, ui-monospace, monospace`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.shadowColor = color;
    context.shadowBlur = h * 0.25;
    context.fillStyle = color;
    context.fillText(text, w / 2, h / 2 + h * 0.05, w * 0.96);
    context.shadowBlur = 0;
    context.fillStyle = '#ffe3ec';
    context.fillText(text, w / 2, h / 2 + h * 0.05, w * 0.96);
  };
}

function boardArt(context, canvas) {
  const { width: w, height: h } = canvas;
  context.fillStyle = '#f4efe6';
  context.fillRect(0, 0, w, h);
  context.fillStyle = hex(PALETTE.whatsapp);
  context.fillRect(0, 0, w, h * 0.2);
  context.fillStyle = '#0b2e1a';
  context.textAlign = 'center';
  context.font = `700 ${Math.round(h * 0.07)}px ui-monospace, monospace`;
  context.fillText('GRUPO NO WHATSAPP', w / 2, h * 0.12);
  context.fillStyle = '#19171d';
  context.font = `400 ${Math.round(h * 0.14)}px VT323, ui-monospace, monospace`;
  context.fillText('SORTEIO', w / 2, h * 0.34);
  context.font = `600 ${Math.round(h * 0.055)}px ui-monospace, monospace`;
  context.fillStyle = hex(PALETTE.pink);
  context.fillText('200 no grupo', w / 2, h * 0.47);
  context.fillStyle = '#19171d';
  context.fillText('conta Claude 20x', w / 2, h * 0.54);
  context.fillStyle = hex(PALETTE.pink);
  context.fillText('500 no grupo', w / 2, h * 0.66);
  context.fillStyle = '#19171d';
  context.fillText('conta Codex 20x', w / 2, h * 0.73);
  context.fillStyle = '#6b6468';
  context.font = `500 ${Math.round(h * 0.045)}px ui-monospace, monospace`;
  context.fillText('ao vivo, numa live', w / 2, h * 0.86);
  context.fillStyle = '#e8c547';
  context.fillRect(w * 0.08, h * 0.24, w * 0.12, w * 0.12);
  context.fillStyle = '#ff9fbf';
  context.fillRect(w * 0.8, h * 0.78, w * 0.12, w * 0.12);
}

function liveArt(context, canvas) {
  const { width: w, height: h } = canvas;
  context.fillStyle = '#120f16';
  context.fillRect(0, 0, w, h);
  context.fillStyle = '#ff3b3b';
  context.beginPath();
  context.arc(w * 0.1, h * 0.18, h * 0.06, 0, Math.PI * 2);
  context.fill();
  context.textAlign = 'left';
  context.fillStyle = '#faf7f9';
  context.font = `700 ${Math.round(h * 0.11)}px ui-monospace, monospace`;
  context.fillText('AO VIVO', w * 0.18, h * 0.22);
  context.textAlign = 'center';
  context.fillStyle = hex(PALETTE.pink);
  context.font = `400 ${Math.round(h * 0.28)}px VT323, ui-monospace, monospace`;
  context.fillText('VIBE CODING', w / 2, h * 0.58);
  context.fillStyle = '#aaa2a8';
  context.font = `500 ${Math.round(h * 0.09)}px ui-monospace, monospace`;
  context.fillText('do prompt ao deploy', w / 2, h * 0.8);
}

function menuArt(context, canvas) {
  const { width: w, height: h } = canvas;
  context.fillStyle = '#19171d';
  context.fillRect(0, 0, w, h);
  context.textAlign = 'center';
  context.fillStyle = hex(PALETTE.ember);
  context.font = `400 ${Math.round(h * 0.36)}px VT323, ui-monospace, monospace`;
  context.fillText('CAFÉ DO NEXUS', w / 2, h * 0.42);
  context.fillStyle = '#faf7f9';
  context.font = `500 ${Math.round(h * 0.16)}px ui-monospace, monospace`;
  context.fillText('espresso · coado · refil ∞', w / 2, h * 0.78);
}

/** Letreiros dos racks num atlas: ícone, nome e faixa na cor da marca. */
function paintAtlas(models, images) {
  return (context, canvas) => {
    const cellW = canvas.width / ATLAS.cols, cellH = canvas.height / ATLAS.rows;
    context.fillStyle = '#141217';
    context.fillRect(0, 0, canvas.width, canvas.height);
    models.forEach((model, index) => {
      const col = index % ATLAS.cols, row = Math.floor(index / ATLAS.cols);
      const x = col * cellW, y = row * cellH;
      context.fillStyle = '#18161c';
      context.fillRect(x + 3, y + 3, cellW - 6, cellH - 6);
      context.fillStyle = hex(model.color);
      context.fillRect(x + 3, y + 3, 10, cellH - 6);
      const icon = images[index];
      const size = cellH * 0.62;
      if (icon?.complete && icon.naturalWidth) {
        context.fillStyle = '#faf7f9';
        context.beginPath();
        context.arc(x + 24 + size / 2, y + cellH / 2, size * 0.6, 0, Math.PI * 2);
        context.fill();
        context.drawImage(icon, x + 24 + size * 0.12, y + cellH / 2 - size * 0.38, size * 0.76, size * 0.76);
      } else {
        context.fillStyle = hex(model.color);
        context.font = `700 ${Math.round(cellH * 0.4)}px ui-monospace, monospace`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(model.name.slice(0, 2).toUpperCase(), x + 24 + size / 2, y + cellH / 2);
      }
      context.fillStyle = '#faf7f9';
      context.font = `600 ${Math.round(cellH * 0.34)}px ui-monospace, monospace`;
      context.textAlign = 'left';
      context.textBaseline = 'middle';
      context.fillText(model.name, x + 34 + size, y + cellH / 2, cellW - size - 46);
    });
  };
}

/** Telão do NOC: tickets, mapa dos racks e carga. */
function paintNoc(context, canvas, lines = [], states = [], clock = 0) {
  const { width: w, height: h } = canvas;
  context.fillStyle = '#060508';
  context.fillRect(0, 0, w, h);
  const panels = [[8, 8, w * 0.42 - 12], [w * 0.42 + 4, 8, w * 0.33 - 8], [w * 0.75, 8, w * 0.25 - 8]];
  for (const [x, y, pw] of panels) {
    context.fillStyle = '#0f0d13';
    context.fillRect(x, y, pw, h - 16);
    context.strokeStyle = '#2a2530';
    context.lineWidth = 2;
    context.strokeRect(x, y, pw, h - 16);
  }
  context.textBaseline = 'top';
  context.textAlign = 'left';
  context.fillStyle = hex(PALETTE.pink);
  context.font = '600 22px ui-monospace, monospace';
  context.fillText('TICKETS', 24, 22);
  context.font = '500 19px ui-monospace, monospace';
  const shown = lines.length ? lines.slice(0, 5) : ['Tudo em ordem. Bora de café?'];
  shown.forEach((line, i) => {
    context.fillStyle = i === 0 && lines.length ? '#faf7f9' : '#aaa2a8';
    context.fillText(`${lines.length ? '›' : ' '} ${line}`, 24, 58 + i * 38, w * 0.42 - 40);
  });
  const [gx] = panels[1];
  const powered = states.filter(state => state !== 'off').length;
  context.fillStyle = hex(PALETTE.green);
  context.font = '600 22px ui-monospace, monospace';
  context.fillText(`RACKS ${powered}/${states.length}`, gx + 16, 22);
  const cell = 44, gap = 8, cols = 6;
  states.forEach((state, i) => {
    const cx = gx + 16 + (i % cols) * (cell + gap), cy = 62 + Math.floor(i / cols) * (cell + gap);
    context.fillStyle = state === 'on' ? hex(PALETTE.green) : state === 'incident' ? (Math.floor(clock * 2) % 2 ? '#ff4d4d' : '#6b1c24') : '#2c2830';
    context.fillRect(cx, cy, cell, cell);
  });
  const [bx, , bw] = panels[2];
  context.fillStyle = hex(PALETTE.gold);
  context.fillText('CARGA', bx + 16, 22);
  const bars = 10;
  for (let i = 0; i < bars; i++) {
    const load = powered === 0 ? 0.05 : 0.25 + 0.6 * Math.abs(Math.sin(clock * 0.7 + i * 1.3)) * (powered / Math.max(1, states.length));
    const bh = (h - 90) * load;
    context.fillStyle = i % 3 === 0 ? hex(PALETTE.pink) : '#8b80ff';
    context.fillRect(bx + 16 + i * ((bw - 32) / bars), h - 20 - bh, (bw - 32) / bars - 5, bh);
  }
}

export function buildDatacenter(kit, { scene, layout, models, tier = 'desktop' }) {
  const root = new Group();
  root.name = 'datacenter';
  scene.add(root);
  const W = layout.width, H = layout.height;
  const byId = new Map(models.map((model, index) => [model.id, { model, index }]));

  // Piso de placas elevadas.
  const floorTex = kit.canvasTexture(128, 128, tileFloor, { repeat: [W, H] });
  const floor = kit.mesh(root, kit.geo('floor', () => new PlaneGeometry(W, H)), kit.mat(0xffffff, { roughness: 0.92 }), [W / 2, 0, H / 2], { cast: false });
  floor.material = kit.own(floor.material.clone());
  floor.material.map = floorTex.texture;
  floor.rotation.x = -Math.PI / 2;

  // Paredes: norte e oeste altas, sul e leste baixas (corte de diorama para a câmera).
  const walls = findCells(layout, '#');
  const tall = walls.filter(c => c.z === 0 || c.x === 0);
  const low = walls.filter(c => !(c.z === 0 || c.x === 0));
  kit.instanced(root, kit.boxGeo(1, 2.8, 1), kit.mat(PALETTE.wall), tall, (d, c) => d.position.set(c.x + 0.5, 1.4, c.z + 0.5));
  kit.instanced(root, kit.boxGeo(1, 0.45, 1), kit.mat(PALETTE.wallDark), low, (d, c) => d.position.set(c.x + 0.5, 0.225, c.z + 0.5));
  kit.instanced(root, kit.boxGeo(1, 0.04, 0.08), kit.mat(PALETTE.pink, { basic: true }), low, (d, c) => {
    d.position.set(c.x + 0.5, 0.47, c.z + 0.5);
    if (c.x === W - 1 && c.z !== H - 1) d.rotation.y = Math.PI / 2;
  }, { cast: false, receive: false });
  // Rodapé luminoso nas paredes altas.
  kit.instanced(root, kit.boxGeo(1, 0.05, 0.03), kit.mat(PALETTE.dusk, { basic: true }), tall.filter(c => c.z === 0 && c.x > 0 && c.x < W - 1), (d, c) => d.position.set(c.x + 0.5, 0.06, 1.02), { cast: false, receive: false });
  kit.instanced(root, kit.boxGeo(0.04, 2.3, 0.03), kit.mat(PALETTE.pink, { basic: true }), [7.5, 12.5, 18.5, 24.5], (d, x) => d.position.set(x, 1.3, 1.02), { cast: false, receive: false });

  // Janelas a oeste com o entardecer, e as manchas de luz que entram por elas.
  const windowTex = kit.canvasTexture(256, 160, sunsetWindow);
  const windowMat = kit.own(new MeshBasicMaterial({ map: windowTex.texture, toneMapped: false }));
  for (const [z0, z1] of [[2.2, 5.8], [7.2, 11.8]]) {
    const pane = kit.mesh(root, kit.geo(`window:${z1 - z0}`, () => new PlaneGeometry(z1 - z0, 1.7)), windowMat, [1.006, 1.6, (z0 + z1) / 2], { cast: false, receive: false });
    pane.rotation.y = Math.PI / 2;
    const pool = kit.mesh(root, kit.geo(`pool:${z1 - z0}`, () => new PlaneGeometry(3.2, z1 - z0)), kit.mat(PALETTE.ember, { basic: true, transparent: true, opacity: 0.1 }), [2.9, 0.012, (z0 + z1) / 2 + 0.4], { cast: false, receive: false });
    pool.rotation.x = -Math.PI / 2;
    pool.material.polygonOffset = true;
    pool.material.polygonOffsetFactor = -2;
  }

  // Letreiro principal na parede norte.
  const titleTex = kit.canvasTexture(1024, 128, neonText('NEXUS DATA CAFÉ', '#ff4f8b'));
  const title = kit.mesh(root, kit.geo('title', () => new PlaneGeometry(5.2, 0.65)), kit.own(new MeshBasicMaterial({ map: titleTex.texture, transparent: true, toneMapped: false, depthWrite: false })), [12.4, 2.4, 1.03], { cast: false, receive: false });
  title.renderOrder = 2;

  // ---------- Racks ----------
  const rackEntries = layout.racks.map(rack => ({ ...rack, cx: rack.x + 0.5, cz: rack.z + 0.5, front: rack.z + 0.5 + RACK.d / 2 }));
  kit.instanced(root, kit.boxGeo(RACK.w, RACK.h, RACK.d), kit.mat(PALETTE.rack, { roughness: 0.55, metalness: 0.35 }), rackEntries, (d, r) => d.position.set(r.cx, RACK.h / 2, r.cz));
  kit.instanced(root, kit.boxGeo(RACK.w + 0.02, 0.06, RACK.d + 0.02), kit.mat(PALETTE.rackEdge, { metalness: 0.4 }), rackEntries, (d, r) => d.position.set(r.cx, 0.03, r.cz), { cast: false });
  const doorTex = kit.canvasTexture(64, 128, rackDoor);
  const doorMat = kit.own(kit.mat(0xffffff, { roughness: 0.5, metalness: 0.3 }).clone());
  doorMat.map = doorTex.texture;
  kit.instanced(root, kit.boxGeo(0.74, 1.46, 0.02), doorMat, rackEntries, (d, r) => d.position.set(r.cx, 0.86, r.front + 0.006), { cast: false });

  const ledMesh = kit.instanced(root, kit.boxGeo(0.06, 0.035, 0.015), kit.mat(0xffffff, { basic: true }), rackEntries.flatMap(r => Array.from({ length: LEDS_PER_RACK }, (_, i) => ({ r, i }))), (d, { r, i }) => {
    const col = i % 2, row = Math.floor(i / 2);
    d.position.set(r.cx + (col ? 0.3 : -0.3), 0.3 + row * 0.25, r.front + 0.02);
  }, { cast: false, receive: false });
  const neonMesh = kit.instanced(root, kit.boxGeo(RACK.w - 0.02, 0.05, 0.05), kit.mat(0xffffff, { basic: true }), rackEntries, (d, r) => d.position.set(r.cx, RACK.h - 0.02, r.front), { cast: false, receive: false });
  kit.instanced(root, kit.geo('fanring', () => new RingGeometry(0.13, 0.17, 18)), kit.mat(0x0c0b0e, { basic: true }), rackEntries.flatMap(r => [0, 1].map(k => ({ r, k }))), (d, { r, k }) => {
    d.position.set(r.cx + (k ? 0.2 : -0.2), RACK.h + 0.004, r.cz);
    d.rotation.x = -Math.PI / 2;
  }, { cast: false, receive: false });
  const fanSlots = rackEntries.flatMap((r, rack) => [0, 1].flatMap(k => [0, 1].map(b => ({ r, k, b, rack }))));
  const fanMesh = kit.instanced(root, kit.boxGeo(0.25, 0.012, 0.045), kit.mat(0x5c5662, { metalness: 0.5 }), fanSlots, (d, { r, k, b }) => {
    d.position.set(r.cx + (k ? 0.2 : -0.2), RACK.h + 0.012, r.cz);
    d.rotation.y = b * Math.PI / 2;
  }, { cast: false, receive: false, dynamic: true });
  const alertMesh = kit.instanced(root, kit.geo('alert', () => new OctahedronGeometry(0.2)), kit.mat(PALETTE.red, { basic: true }), rackEntries, (d, r) => { d.position.set(r.cx, RACK.h + 0.38, r.cz + 0.3); d.scale.setScalar(0); }, { cast: false, receive: false, dynamic: true });
  alertMesh.frustumCulled = false;

  // Letreiros: um único mesh com 18 quads apontando para o atlas; a cor de vértice apaga ou acende.
  const images = models.map(model => {
    if (typeof Image === 'undefined') return null;
    const image = new Image();
    image.decoding = 'async';
    image.src = `/providers/${model.icon}`;
    return image;
  });
  const atlas = kit.canvasTexture(ATLAS.width, ATLAS.height, paintAtlas(models, images));
  images.forEach(image => { if (image) image.onload = () => atlas.redraw(); });
  const signGeo = kit.own(new BufferGeometry());
  const positions = new Float32Array(rackEntries.length * 12);
  const uvs = new Float32Array(rackEntries.length * 8);
  const colors = new Float32Array(rackEntries.length * 12);
  const index = [];
  rackEntries.forEach((r, i) => {
    const slot = byId.get(r.id).index;
    const col = slot % ATLAS.cols, row = Math.floor(slot / ATLAS.cols);
    const u0 = col / ATLAS.cols, u1 = (col + 1) / ATLAS.cols, v1 = 1 - row / ATLAS.rows, v0 = 1 - (row + 1) / ATLAS.rows;
    const hw = 0.41, y0 = 1.66, y1 = 1.97, z = r.front + 0.012;
    positions.set([r.cx - hw, y0, z, r.cx + hw, y0, z, r.cx + hw, y1, z, r.cx - hw, y1, z], i * 12);
    uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], i * 8);
    colors.fill(0.28, i * 12, i * 12 + 12);
    const b = i * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  signGeo.setAttribute('position', new BufferAttribute(positions, 3));
  signGeo.setAttribute('uv', new BufferAttribute(uvs, 2));
  signGeo.setAttribute('color', new BufferAttribute(colors, 3));
  signGeo.setIndex(index);
  kit.mesh(root, signGeo, kit.own(new MeshBasicMaterial({ map: atlas.texture, vertexColors: true, toneMapped: false })), [0, 0, 0], { cast: false, receive: false });

  // Faixa fria no corredor em frente de cada rack.
  kit.instanced(root, kit.geo('aisle', () => new PlaneGeometry(0.92, 0.9)), (() => {
    const material = kit.mat(PALETTE.green, { basic: true, transparent: true, opacity: 0.1 });
    material.polygonOffset = true; material.polygonOffsetFactor = -1;
    return material;
  })(), rackEntries, (d, r) => { d.position.set(r.cx, 0.008, r.front + 0.5); d.rotation.x = -Math.PI / 2; }, { cast: false, receive: false });

  const rackState = rackEntries.map(() => ({ state: 'off', pulse: 0, dirty: true }));
  const color = new Color();
  const mover = new Object3D();

  function paintSign(i, bright) {
    colors.fill(bright, i * 12, i * 12 + 12);
    signGeo.attributes.color.needsUpdate = true;
  }

  const racks = new Map(rackEntries.map((r, i) => [r.id, {
    x: r.cx, z: r.cz, front: r.front,
    setState(state) {
      if (!['off', 'on', 'incident'].includes(state)) throw new Error(`estado de rack inválido: ${state}`);
      if (rackState[i].state === state) return;
      rackState[i].state = state;
      rackState[i].dirty = true;
      paintSign(i, state === 'off' ? 0.28 : 1);
    },
    pulse() { rackState[i].pulse = 1; rackState[i].dirty = true; },
  }]));

  // ---------- Cafeteria ----------
  const coffeeCell = layout.coffee;
  const cx = coffeeCell.x + 0.5, cz = coffeeCell.z + 0.5;
  const wood = kit.mat(PALETTE.wood), woodTop = kit.mat(PALETTE.woodTop), steel = kit.mat(PALETTE.steel, { metalness: 0.6, roughness: 0.35 });
  for (const dx of [-1, 1]) {
    kit.box(root, [0.96, 0.86, 0.78], [cx + dx, 0.43, cz - 0.05], wood);
    kit.box(root, [1, 0.05, 0.82], [cx + dx, 0.885, cz - 0.05], woodTop);
  }
  kit.box(root, [0.96, 0.86, 0.78], [cx, 0.43, cz - 0.05], kit.mat(0x2c2530));
  kit.box(root, [1, 0.05, 0.82], [cx, 0.885, cz - 0.05], woodTop);
  kit.box(root, [0.74, 0.48, 0.5], [cx, 1.15, cz - 0.15], steel);
  kit.box(root, [0.62, 0.14, 0.02], [cx, 1.3, cz + 0.11], kit.mat(PALETTE.pink, { emissive: PALETTE.pink, emissiveIntensity: 0.9 }), { cast: false });
  const group = kit.geo('grouphead', () => new CylinderGeometry(0.05, 0.05, 0.1, 10));
  for (const dx of [-0.18, 0.18]) kit.mesh(root, group, steel, [cx + dx, 0.96, cz + 0.05]);
  const mugGeo = kit.geo('bigmug', () => new CylinderGeometry(0.05, 0.045, 0.09, 10));
  const white = kit.mat(PALETTE.ink);
  kit.mesh(root, mugGeo, white, [cx - 0.18, 0.955, cz + 0.08]);
  for (const [x, z] of [[cx - 1.25, cz - 0.2], [cx - 1.05, cz + 0.1], [cx + 1.2, cz - 0.1]]) kit.mesh(root, mugGeo, white, [x, 0.955, z]);
  kit.box(root, [0.22, 0.34, 0.22], [cx + 0.95, 1.08, cz - 0.15], kit.mat(0x19171d));
  const menuTex = kit.canvasTexture(512, 128, menuArt);
  kit.mesh(root, kit.geo('menu', () => new PlaneGeometry(2.4, 0.6)), kit.own(new MeshBasicMaterial({ map: menuTex.texture, toneMapped: false })), [cx, 1.95, 1.02], { cast: false, receive: false });
  const coffee = { x: cx, z: cz, spout: { x: cx - 0.18, y: 1.02, z: cz + 0.1 } };

  // Mesas do café e banquinhos.
  const tables = findCells(layout, 'T').map(c => ({ x: c.x + 0.5, z: c.z + 0.5 }));
  const stools = tables.flatMap(t => [-0.62, 0.62].map(dx => ({ x: t.x + dx, z: t.z })));
  kit.instanced(root, kit.geo('tabletop', () => new CylinderGeometry(0.44, 0.44, 0.05, 20)), woodTop, tables, (d, t) => d.position.set(t.x, 0.74, t.z));
  kit.instanced(root, kit.geo('pole', () => new CylinderGeometry(0.04, 0.04, 0.72, 8)), steel, tables, (d, t) => d.position.set(t.x, 0.37, t.z));
  kit.instanced(root, kit.geo('stool', () => new CylinderGeometry(0.17, 0.17, 0.06, 14)), kit.mat(PALETTE.pink), stools, (d, s) => d.position.set(s.x, 0.46, s.z));
  kit.instanced(root, kit.geo('stoolleg', () => new CylinderGeometry(0.03, 0.05, 0.44, 6)), steel, stools, (d, s) => d.position.set(s.x, 0.22, s.z));
  kit.instanced(root, mugGeo, white, tables, (d, t) => d.position.set(t.x + 0.12, 0.81, t.z - 0.1), { cast: false });

  // ---------- Doca ----------
  const dockX = layout.dock.x, dockZ = layout.dock.z;
  kit.box(root, [layout.dock.width - 0.1, 0.1, 0.86], [dockX + layout.dock.width / 2, 0.05, dockZ + 0.5], kit.mat(0x3b3139));
  const rollTex = kit.canvasTexture(256, 128, rollupDoor);
  kit.mesh(root, kit.geo('rollup', () => new PlaneGeometry(layout.dock.width + 0.4, 2.3)), kit.own(new MeshBasicMaterial({ map: rollTex.texture })), [dockX + layout.dock.width / 2, 1.15, 1.015], { cast: false, receive: false });
  const hazardTex = kit.canvasTexture(256, 32, hazard);
  const stripe = kit.mesh(root, kit.geo('hazard', () => new PlaneGeometry(layout.dock.width, 0.22)), kit.own(new MeshBasicMaterial({ map: hazardTex.texture, polygonOffset: true, polygonOffsetFactor: -1 })), [dockX + layout.dock.width / 2, 0.01, dockZ + 1.14], { cast: false, receive: false });
  stripe.rotation.x = -Math.PI / 2;
  const crateTex = kit.canvasTexture(128, 128, crateArt);
  const crateMat = kit.own(kit.mat(0xffffff).clone());
  crateMat.map = crateTex.texture;
  const crateSlots = [0, 1, 2, 3, 4].map(i => ({ x: dockX + 0.5 + i, y: 0.28, rot: (i % 2) * 0.12 })).concat([0.5, 1.5, 2.5].map((dx, i) => ({ x: dockX + 1 + dx, y: 0.66, rot: -0.1 + i * 0.1 })));
  const crates = kit.instanced(root, kit.boxGeo(0.52, 0.36, 0.44), crateMat, crateSlots, (d, s) => { d.position.set(s.x, s.y, dockZ + 0.5); d.rotation.y = s.rot; });
  crates.count = 3;
  const dock = {
    x: dockX + layout.dock.width / 2, z: dockZ + 0.5, max: crateSlots.length,
    count: () => crates.count,
    takeCrate() { if (crates.count === 0) return false; crates.count -= 1; return true; },
    refill(n = 1) { crates.count = Math.min(crateSlots.length, crates.count + n); return crates.count; },
    setCount(n) { crates.count = Math.max(0, Math.min(crateSlots.length, n)); },
  };

  // ---------- Mural do sorteio e TV da live ----------
  const board = layout.board;
  const boardTex = kit.canvasTexture(256, 320, boardArt);
  kit.box(root, [0.05, 1.7, 0.05], [board.x + 0.12, 0.85, board.z + 0.5], steel);
  kit.box(root, [0.05, 1.7, 0.05], [board.x + 0.88, 0.85, board.z + 0.5], steel);
  kit.box(root, [0.92, 1.12, 0.06], [board.x + 0.5, 1.2, board.z + 0.5], kit.mat(0x3a2f38));
  kit.mesh(root, kit.geo('boardface', () => new PlaneGeometry(0.84, 1.04)), kit.own(new MeshBasicMaterial({ map: boardTex.texture })), [board.x + 0.5, 1.2, board.z + 0.535], { cast: false, receive: false });
  const live = layout.live;
  const liveTex = kit.canvasTexture(256, 150, liveArt);
  kit.box(root, [0.08, 1.05, 0.08], [live.x + 0.5, 0.52, live.z + 0.4], steel);
  kit.box(root, [0.5, 0.04, 0.4], [live.x + 0.5, 0.02, live.z + 0.4], steel);
  kit.box(root, [1.08, 0.64, 0.07], [live.x + 0.5, 1.32, live.z + 0.42], kit.mat(0x0c0b0e));
  kit.mesh(root, kit.geo('liveface', () => new PlaneGeometry(1, 0.57)), kit.own(new MeshBasicMaterial({ map: liveTex.texture, toneMapped: false })), [live.x + 0.5, 1.32, live.z + 0.46], { cast: false, receive: false });

  // ---------- NOC ----------
  const noc = layout.noc;
  kit.box(root, [noc.width - 0.1, 0.78, 0.72], [noc.x + noc.width / 2, 0.39, noc.z + 0.45], kit.mat(0x17151b));
  kit.box(root, [noc.width - 0.06, 0.04, 0.76], [noc.x + noc.width / 2, 0.8, noc.z + 0.45], kit.mat(PALETTE.lift));
  kit.instanced(root, kit.boxGeo(0.46, 0.02, 0.16), kit.mat(0x2e2a35), [0, 1, 2, 3], (d, i) => d.position.set(noc.x + 0.8 + i * 1.45, 0.83, noc.z + 0.6), { cast: false });
  let nocState = { lines: [], states: rackEntries.map(() => 'off'), clock: 0 };
  const nocTex = kit.canvasTexture(NOC_SIZE.width, NOC_SIZE.height, (context, canvas) => paintNoc(context, canvas, nocState.lines, nocState.states, nocState.clock));
  kit.box(root, [noc.width - 0.2, 1.58, 0.06], [noc.x + noc.width / 2, 1.78, 1.03], kit.mat(0x0c0b0e));
  kit.mesh(root, kit.geo('nocface', () => new PlaneGeometry(noc.width - 0.32, 1.48)), kit.own(new MeshBasicMaterial({ map: nocTex.texture, toneMapped: false })), [noc.x + noc.width / 2, 1.78, 1.065], { cast: false, receive: false });
  let nocClock = 0;

  // ---------- Mesas dos devs ----------
  const desks = findCells(layout, 'D').filter(c => c.z > 2).map(c => ({ x: c.x + 0.5, z: c.z + 0.5 }));
  const codeTex = kit.canvasTexture(128, 80, codeScreen);
  kit.instanced(root, kit.boxGeo(0.96, 0.05, 0.8), kit.mat(0xe9e2da, { roughness: 0.6 }), desks, (d, s) => d.position.set(s.x, 0.74, s.z));
  kit.instanced(root, kit.boxGeo(0.04, 0.72, 0.72), kit.mat(0x2a2530), desks.flatMap(s => [-0.44, 0.44].map(dx => ({ x: s.x + dx, z: s.z }))), (d, s) => d.position.set(s.x, 0.36, s.z));
  kit.instanced(root, kit.boxGeo(0.56, 0.35, 0.03), kit.mat(0x121015), desks, (d, s) => d.position.set(s.x, 1.02, s.z - 0.18));
  kit.instanced(root, kit.geo('screen', () => new PlaneGeometry(0.5, 0.3)), kit.own(new MeshBasicMaterial({ map: codeTex.texture, toneMapped: false })), desks, (d, s) => d.position.set(s.x, 1.02, s.z - 0.163), { cast: false, receive: false });
  kit.instanced(root, kit.boxGeo(0.36, 0.02, 0.12), kit.mat(0x2e2a35), desks, (d, s) => d.position.set(s.x, 0.775, s.z + 0.12), { cast: false });
  kit.instanced(root, mugGeo, kit.mat(PALETTE.pink), desks.filter((_, i) => i % 2 === 0), (d, s) => d.position.set(s.x + 0.34, 0.81, s.z + 0.05), { cast: false });

  // ---------- Plantas ----------
  const plants = findCells(layout, 'P').map(c => ({ x: c.x + 0.5, z: c.z + 0.5 }));
  kit.instanced(root, kit.geo('pot', () => new CylinderGeometry(0.22, 0.17, 0.36, 10)), kit.mat(PALETTE.pot), plants, (d, p) => d.position.set(p.x, 0.18, p.z));
  const leaves = plants.flatMap((p, i) => [[0, 0.62, 0, 0.3], [0.12, 0.85, 0.05, 0.22], [-0.1, 0.78, -0.08, 0.2]].map(([dx, y, dz, s]) => ({ x: p.x + dx, y, z: p.z + dz, s, tint: (i + dx) > 0 })));
  kit.instanced(root, kit.geo('leaf', () => new IcosahedronGeometry(1, 0)), kit.mat(PALETTE.leaf), leaves, (d, l) => { d.position.set(l.x, l.y, l.z); d.scale.setScalar(l.s); d.rotation.set(l.x, l.z, 0); });

  // ---------- Destaque do objeto interativo ----------
  const ringMat = kit.mat(PALETTE.pink, { basic: true, transparent: true, opacity: 0.8 });
  const ring = kit.mesh(root, kit.geo('ring', () => new RingGeometry(0.42, 0.52, 36)), ringMat, [0, 0.02, 0], { cast: false, receive: false });
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;

  // ---------- Farol do objetivo: feixe translúcido e seta que quica ----------
  const beam = kit.mesh(root, kit.geo('beam', () => new CylinderGeometry(0.32, 0.42, 3.2, 20, 1, true)), kit.mat(PALETTE.pink, { basic: true, transparent: true, opacity: 0.16 }), [0, 1.6, 0], { cast: false, receive: false });
  beam.material.depthWrite = false;
  beam.renderOrder = 3;
  const arrow = kit.mesh(root, kit.geo('arrow', () => new OctahedronGeometry(0.18)), kit.mat(PALETTE.pink, { basic: true }), [0, 2.9, 0], { cast: false, receive: false });
  arrow.scale.set(1, 1.6, 1);
  beam.visible = arrow.visible = false;
  let objectiveY = 0;

  function setObjective(target) {
    beam.visible = arrow.visible = Boolean(target);
    if (!target) return;
    objectiveY = target.y ?? 0;
    beam.position.set(target.x, 1.6 + objectiveY, target.z);
    arrow.position.set(target.x, 2.9 + objectiveY, target.z);
  }

  function highlight(target) {
    if (!target) { ring.visible = false; return; }
    ring.visible = true;
    ring.position.set(target.x, 0.02, target.z);
  }

  const fanAngle = new Float32Array(rackEntries.length);
  function update(dt, time, calm) {
    const blink = Math.floor(time * 4) % 2 === 0;
    let ledsChanged = false, neonChanged = false, alertsChanged = false, fansChanged = false;
    rackEntries.forEach((r, i) => {
      const slot = rackState[i];
      const model = byId.get(r.id).model;
      const animated = !calm && slot.state !== 'off';
      if (slot.pulse > 0) { slot.pulse = Math.max(0, slot.pulse - dt * 2.5); slot.dirty = true; }
      if (!slot.dirty && !animated) return;
      for (let k = 0; k < LEDS_PER_RACK; k++) {
        const row = Math.floor(k / 2);
        if (slot.state === 'off') color.set(PALETTE.ledOff);
        else if (slot.state === 'incident') color.set(calm || blink ? PALETTE.red : 0x3a1014);
        else {
          const wave = calm ? 1 : Math.sin(time * 5 - row * 1.1 + i * 0.7 + (k % 2) * 1.7);
          color.set(wave > -0.2 ? PALETTE.ledOn : 0x2e5a45);
        }
        ledMesh.setColorAt(i * LEDS_PER_RACK + k, color);
      }
      ledsChanged = true;
      if (slot.state === 'off') color.set(model.color).multiplyScalar(0.12);
      else if (slot.state === 'incident') color.set(PALETTE.red).multiplyScalar(calm ? 1 : 0.55 + 0.45 * Math.abs(Math.sin(time * 6)));
      else color.set(model.color).multiplyScalar(1.1 + slot.pulse * 1.5);
      neonMesh.setColorAt(i, color);
      neonChanged = true;
      if (slot.state !== 'off' && !calm) { fanAngle[i] += dt * (slot.state === 'on' ? 14 : 3); fansChanged = true; }
      if (slot.dirty || slot.state === 'incident') {
        const shown = slot.state === 'incident' ? 1 : 0;
        const lift = shown && !calm ? Math.sin(time * 3 + i) * 0.08 : 0;
        mover.position.set(r.cx, RACK.h + 0.38 + lift, r.cz + 0.3);
        mover.rotation.set(0, calm ? 0 : time * 2, 0);
        mover.scale.setScalar(shown);
        mover.updateMatrix();
        alertMesh.setMatrixAt(i, mover.matrix);
        alertsChanged = true;
      }
      slot.dirty = false;
    });
    if (fansChanged) {
      for (let j = 0; j < fanSlots.length; j++) {
        const { r, k, b, rack } = fanSlots[j];
        if (rackState[rack].state === 'off') continue;
        mover.position.set(r.cx + (k ? 0.2 : -0.2), RACK.h + 0.012, r.cz);
        mover.rotation.set(0, fanAngle[rack] + b * Math.PI / 2, 0);
        mover.scale.setScalar(1);
        mover.updateMatrix();
        fanMesh.setMatrixAt(j, mover.matrix);
      }
      fanMesh.instanceMatrix.needsUpdate = true;
    }
    if (ledsChanged) ledMesh.instanceColor.needsUpdate = true;
    if (neonChanged) neonMesh.instanceColor.needsUpdate = true;
    if (alertsChanged) alertMesh.instanceMatrix.needsUpdate = true;
    if (ring.visible) ringMat.opacity = calm ? 0.8 : 0.55 + 0.35 * Math.sin(time * 5);
    if (arrow.visible && !calm) {
      arrow.position.y = 2.9 + objectiveY + Math.abs(Math.sin(time * 3)) * 0.25;
      arrow.rotation.y = time * 1.5;
      beam.material.opacity = 0.12 + 0.06 * Math.sin(time * 2.4);
    }
    nocClock += dt;
    if (nocClock > 1) { nocClock = 0; nocState = { ...nocState, clock: time }; nocTex.redraw(); }
  }

  function setNoc(lines, states) {
    nocState = { lines, states, clock: nocState.clock };
    nocTex.redraw();
  }

  // Primeira pintura dos racks, antes do primeiro quadro.
  update(0, 0, true);

  return { root, racks, coffee, dock, highlight, setObjective, setNoc, update, tier };
}
