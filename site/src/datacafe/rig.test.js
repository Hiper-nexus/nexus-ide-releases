import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RIG, clampYaw, clampTarget, createCamera, cameraStep, wheelZoom, pinchZoom, occlusionPitch, seatFraming,
} from './rig.js';
import { LAYOUT, obstacleHeight } from './layout.js';
import { createGrid, circleFree } from './grid.js';

const grid = createGrid(LAYOUT);
const PHONE = 390 / 844, DESKTOP = 1440 / 900;
const CHEST = RIG.focusHeight;

function input(overrides = {}) {
  return {
    playing: true, calm: false, aspect: DESKTOP,
    body: { x: 12.5, z: 8.5, vx: 0, vz: 0 },
    yaw: 0, pitch: RIG.pitch, zoom: 1, focus: null, seat: null, idle: { x: 13, z: 7 },
    ...overrides,
  };
}

/** Roda a câmera até assentar. Com `calm` ela chega de uma vez; sem, dá tempo de sobra. */
function settle(cam, given, seconds = 6, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) cameraStep(cam, given, LAYOUT, dt);
  return cam;
}

const solidAt = (x, y, z) => y < obstacleHeight(LAYOUT, Math.floor(x), Math.floor(z));

/** O segmento da câmera até o ponto não atravessa nenhum obstáculo do salão (a célula do
 * próprio ponto não conta: o monitor está dentro da célula da mesa). */
function clearLine(cam, x, y, z) {
  const length = Math.hypot(cam.x - x, cam.y - y, cam.z - z);
  const steps = Math.ceil(length / 0.02);
  const home = `${Math.floor(x)},${Math.floor(z)}`;
  for (let i = 1; i < steps; i++) {
    const k = i / steps;
    const px = x + (cam.x - x) * k, py = y + (cam.y - y) * k, pz = z + (cam.z - z) * k;
    if (`${Math.floor(px)},${Math.floor(pz)}` !== home && solidAt(px, py, pz)) return false;
  }
  return true;
}

/** Posição do ponto na tela, de -1 a 1 nos dois eixos (pinhole com o mesmo fov do jogo). */
function project(cam, aspect, x, y, z) {
  const f = [cam.tx - cam.x, cam.ty - cam.y, cam.tz - cam.z];
  const fl = Math.hypot(...f); f.forEach((v, i) => { f[i] = v / fl; });
  const r = [-f[2], 0, f[0]]; const rl = Math.hypot(...r); r.forEach((v, i) => { r[i] = v / rl; });
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const p = [x - cam.x, y - cam.y, z - cam.z];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const depth = dot(p, f), tan = Math.tan(RIG.fov * Math.PI / 360);
  return { x: dot(p, r) / depth / (tan * aspect), y: dot(p, u) / depth / tan, depth };
}

test('o giro fica no limite e a câmera segue sem saltos, igual a 30 e a 144 quadros por segundo', () => {
  assert.equal(clampYaw(5), RIG.yawMax);
  const run = fps => {
    const cam = settle(createCamera(), input({ body: { x: 8, z: 8.5, vx: 0, vz: 0 } }));
    const dt = 1 / fps;
    for (let t = 0; t < 1.5; t += dt) {
      const x = 8 + 2 * Math.min(t, 1.5);
      cameraStep(cam, input({ body: { x, z: 8.5, vx: 2, vz: 0 } }), LAYOUT, dt);
    }
    return cam;
  };
  const slow = run(30), fast = run(144);
  for (const key of ['x', 'y', 'z', 'tx', 'tz']) assert.ok(Math.abs(slow[key] - fast[key]) < 0.06, `${key}: ${slow[key]} ≈ ${fast[key]}`);
  // Alvo que salta e fica parado: depois de meio segundo sobra o mesmo caminho a 30 e a 144 fps.
  const rest = fps => {
    const cam = settle(createCamera(), input({ body: { x: 8, z: 8.5, vx: 0, vz: 0 } }));
    for (let i = 0; i < fps / 2; i++) cameraStep(cam, input({ body: { x: 12, z: 8.5, vx: 0, vz: 0 } }), LAYOUT, 1 / fps);
    return 12 - cam.tx;
  };
  assert.ok(Math.abs(rest(30) - rest(144)) < 0.002, `${rest(30)} ≈ ${rest(144)}`);
  // Um quadro nunca move a câmera mais do que o dev andou nele mais a antecipação.
  const cam = settle(createCamera(), input());
  const before = { ...cam };
  cameraStep(cam, input({ body: { x: 12.56, z: 8.5, vx: 3.4, vz: 0 } }), LAYOUT, 1 / 60);
  assert.ok(Math.hypot(cam.x - before.x, cam.z - before.z) < 0.15);
});

test('antecipa para onde o dev anda, sem passar do limite, e volta quando ele para', () => {
  const walking = input({ body: { x: 12.5, z: 8.5, vx: 3.4, vz: 0 } });
  const cam = settle(createCamera(), walking);
  const ahead = cam.tx - walking.body.x;
  assert.ok(ahead > 0.6 && ahead <= RIG.leadMax + 1e-6, `olha ${ahead.toFixed(2)} à frente`);
  settle(cam, input());
  assert.ok(Math.abs(cam.tx - 12.5) < 0.05, 'parado, centraliza de novo');
});

test('zoom pela roda e pela pinça fica dentro dos limites', () => {
  assert.equal(wheelZoom(1, 1e6), RIG.zoomMax);
  assert.equal(wheelZoom(1, -1e6), RIG.zoomMin);
  assert.ok(wheelZoom(1, 100) > 1 && wheelZoom(1, -100) < 1, 'rolar para baixo afasta, para cima aproxima');
  assert.equal(pinchZoom(1, 100, 200), RIG.zoomMin, 'abrir os dedos aproxima até o limite');
  assert.equal(pinchZoom(1, 200, 100), RIG.zoomMax, 'fechar os dedos afasta até o limite');
  assert.ok(Math.abs(pinchZoom(1, 100, 110) - 100 / 110) < 1e-9);
  const near = settle(createCamera(), input({ zoom: RIG.zoomMin }));
  const far = settle(createCamera(), input({ zoom: RIG.zoomMax }));
  assert.ok(near.range < far.range);
});

test('atrás de uma fileira de racks a câmera sobe até ver o peito do dev', () => {
  const behind = input({ body: { x: 6.5, z: 5.7, vx: 0, vz: 0 } });
  assert.ok(occlusionPitch(LAYOUT, behind.body, 0, RIG.range) > RIG.pitch, 'o rack exige subir');
  const cam = settle(createCamera(), behind);
  assert.ok(cam.pitch > RIG.pitch + 0.2, `subiu para ${cam.pitch.toFixed(2)}`);
  assert.ok(clearLine(cam, 6.5, CHEST, 5.7), 'nada entre a câmera e o peito');
  // Longe de obstáculos, fica na elevação de sempre.
  assert.ok(Math.abs(settle(createCamera(), input()).pitch - RIG.pitch) < 0.01);
});

test('em qualquer ponto do salão, giro, zoom e tela, o dev fica no quadro e à vista, e a câmera fora das paredes', () => {
  const spots = [];
  for (let z = 0; z < LAYOUT.height; z++) {
    for (let x = 0; x < LAYOUT.width; x++) {
      for (const [dx, dz] of [[0.5, 0.5], [0.3, 0.3], [0.7, 0.7], [0.3, 0.7], [0.7, 0.3]]) {
        if (circleFree(grid, x + dx, z + dz, 0.3)) spots.push({ x: x + dx, z: z + dz });
      }
    }
  }
  assert.ok(spots.length > 600);
  let checked = 0;
  for (const aspect of [PHONE, DESKTOP]) {
    for (const yaw of [RIG.yawMin, 0, RIG.yawMax]) {
      for (const zoom of [RIG.zoomMin, 1, RIG.zoomMax]) {
        for (const pitch of [RIG.pitchMin, RIG.userPitchMax]) {
          const cam = createCamera();
          for (const body of spots) {
            cameraStep(cam, input({ calm: true, aspect, yaw, zoom, pitch, body: { ...body, vx: 0, vz: 0 } }), LAYOUT, 1 / 60);
            const where = JSON.stringify({ body, aspect: aspect.toFixed(2), yaw, zoom, pitch });
            assert.ok(clearLine(cam, body.x, CHEST, body.z), `peito escondido ${where}`);
            const screen = project(cam, aspect, body.x, CHEST, body.z);
            assert.ok(screen.depth > 0 && Math.abs(screen.x) < 0.9 && Math.abs(screen.y) < 0.9, `fora do quadro ${where} → ${screen.x.toFixed(2)}, ${screen.y.toFixed(2)}`);
            assert.ok(cam.y > obstacleHeight(LAYOUT, Math.floor(cam.x), Math.floor(cam.z)) + 0.2, `câmera dentro de um obstáculo ${where}`);
            checked++;
          }
        }
      }
    }
  }
  assert.ok(checked > 20000);
});

test('sentado, a câmera enquadra o monitor por cima do ombro, legível no celular', () => {
  const { screen, seat } = LAYOUT.workstation;
  for (const aspect of [PHONE, DESKTOP]) {
    const framing = seatFraming(screen, aspect, {});
    assert.ok(framing.range >= 1.8 && framing.range <= 3.2, `alcance ${framing.range}`);
    const cam = settle(createCamera(), input({ aspect, body: { x: seat.x, z: seat.z, vx: 0, vz: 0 }, seat: { blend: 1, screen } }));
    assert.ok(Math.hypot(cam.tx - screen.x, cam.ty - screen.y, cam.tz - screen.z) < 0.02, 'olha para o monitor');
    assert.ok(clearLine(cam, screen.x, screen.y, screen.z), 'nada entre a câmera e o monitor');
    // A cabeça do dev sentado (centro a ~1,3 m) não tapa nenhum canto do monitor.
    const head = { x: seat.x, y: 1.3, z: seat.z };
    for (const [dx, dy] of [[-0.4, -0.25], [0.4, -0.25], [-0.4, 0.25], [0.4, 0.25], [0, 0]]) {
      const corner = { x: screen.x + dx, y: screen.y + dy, z: screen.z };
      const d = { x: corner.x - cam.x, y: corner.y - cam.y, z: corner.z - cam.z };
      const t = ((head.x - cam.x) * d.x + (head.y - cam.y) * d.y + (head.z - cam.z) * d.z) / (d.x ** 2 + d.y ** 2 + d.z ** 2);
      const gap = Math.hypot(cam.x + d.x * t - head.x, cam.y + d.y * t - head.y, cam.z + d.z * t - head.z);
      assert.ok(gap > 0.25, `a cabeça tapa o canto ${dx}, ${dy} (folga ${gap.toFixed(2)})`);
    }
    // O monitor (0,8 de largura) ocupa boa parte da largura da tela; no celular, mais da metade.
    const left = project(cam, aspect, screen.x - 0.4, screen.y, screen.z), right = project(cam, aspect, screen.x + 0.4, screen.y, screen.z);
    const width = (right.x - left.x) / 2;
    const least = aspect < 1 ? 0.5 : 0.2;
    assert.ok(width > least && width < 1, `monitor ocupa ${(width * 100).toFixed(0)}% da largura`);
    assert.ok(cam.y > obstacleHeight(LAYOUT, Math.floor(cam.x), Math.floor(cam.z)) + 0.2);
  }
});

test('ao chegar perto de algo interativo, aproxima e olha um pouco para o objeto', () => {
  const free = settle(createCamera(), input());
  const near = settle(createCamera(), input({ focus: { x: 14.5, z: 8.5 } }));
  assert.ok(near.range < free.range, 'aproxima');
  assert.ok(near.tx > free.tx + 0.3, 'olha para o objeto');
});

test('com redução de movimento chega ao objetivo sem deslizar nem antecipar', () => {
  const cam = createCamera();
  const walking = input({ calm: true, body: { x: 12.5, z: 8.5, vx: 3.4, vz: 0 } });
  cameraStep(cam, walking, LAYOUT, 1 / 60);
  const again = { ...cam };
  cameraStep(cam, walking, LAYOUT, 1 / 60);
  for (const key of ['x', 'y', 'z', 'tx', 'tz']) assert.ok(Math.abs(cam[key] - again[key]) < 1e-9, key);
  assert.ok(Math.abs(cam.tx - 12.5) < 1e-9, 'sem antecipação');
});

test('fora do jogo olha o salão do alto e mantém o alvo dentro do salão', () => {
  const cam = settle(createCamera(), input({ playing: false }));
  assert.ok(Math.abs(cam.tx - 13) < 0.05 && Math.abs(cam.tz - 7) < 0.05);
  const playing = settle(createCamera(), input());
  assert.ok(cam.range > playing.range, 'mais aberto que no jogo');
  const edge = clampTarget(-5, 99, LAYOUT);
  assert.ok(edge.x >= RIG.margin && edge.z <= LAYOUT.height);
});

test('andando ao longo de uma fileira de racks o peito do dev fica à vista em todos os quadros', () => {
  // A elevação segura era calculada para o destino e depois suavizada: no caminho a câmera
  // interpolada passava alguns quadros com um rack entre ela e o dev.
  const body = { x: 10.5, z: 5.5, vx: 0, vz: 0 };
  const given = input({ body, pitch: 0.8 });
  const cam = settle(createCamera(), given);
  const dt = 1 / 60;
  let hidden = 0;
  body.vx = -3.4;
  for (let frame = 0; frame < 240 && body.x > 2; frame++) {
    body.x += body.vx * dt;
    cameraStep(cam, given, LAYOUT, dt);
    if (!clearLine(cam, body.x, CHEST, body.z)) hidden++;
  }
  assert.equal(hidden, 0, `${hidden} quadros com o dev escondido atrás de um rack`);
});

test('a espiada com peso zero não muda nada: a câmera segue o dev como sempre', () => {
  const plain = settle(createCamera(), input());
  const glance = { x: 14.5, y: 1.35, z: 1.9, range: 6, weight: 0 };
  const same = settle(createCamera(), input({ glance }));
  assert.deepEqual(same, plain);
  assert.deepEqual(settle(createCamera(), input({ glance: null })), plain);
});

test('com a espiada inteira a câmera mira o ponto, chega perto e vira de frente; pela metade fica no meio do caminho', () => {
  const glance = { x: 14.5, y: 1.35, z: 1.9, range: 6, weight: 1 };
  const full = settle(createCamera(), input({ glance }));
  assert.ok(Math.hypot(full.tx - glance.x, full.tz - glance.z) < 0.05, `mira o ponto: ${full.tx},${full.tz}`);
  assert.ok(Math.abs(full.ty - glance.y) < 0.05);
  assert.ok(Math.abs(full.range - glance.range) < 0.05);
  assert.ok(Math.abs(full.yaw) < 0.02, 'de frente para a parede norte');
  const half = settle(createCamera(), input({ glance: { ...glance, weight: 0.5 } }));
  const none = settle(createCamera(), input());
  assert.ok(half.tx > Math.min(none.tx, full.tx) && half.tx < Math.max(none.tx, full.tx), 'meio do caminho em x');
  assert.ok(half.range < none.range && half.range > full.range, 'meio do caminho no zoom');
});

test('terminada a espiada a câmera volta ao dev e a elevação segura continua valendo', () => {
  const cam = createCamera();
  settle(cam, input({ glance: { x: 14.5, y: 1.35, z: 1.9, range: 6, weight: 1 } }), 3);
  settle(cam, input(), 6);
  const plain = settle(createCamera(), input());
  assert.ok(Math.hypot(cam.tx - plain.tx, cam.tz - plain.tz) < 0.05, 'de volta ao dev');
  assert.ok(Math.abs(cam.range - plain.range) < 0.05);
  const body = { x: 5.5, z: 7.5, vx: 0, vz: 0 };
  const behind = settle(createCamera(), input({ body }));
  assert.ok(behind.pitch >= occlusionPitch(LAYOUT, body, behind.yaw, behind.range, { x: behind.tx, z: behind.tz }) - 0.02, 'o dev continua à vista');
});
