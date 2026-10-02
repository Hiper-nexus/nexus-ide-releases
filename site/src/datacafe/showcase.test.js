import test from 'node:test';
import assert from 'node:assert/strict';
import { ATTRACT, REVEAL, IDLE_NUDGE, attractPose, revealWeight, glanceTarget, glanceRange, prizeObjective, shouldPointToPrize, prizePath, pathMarks } from './showcase.js';
import { LAYOUT } from './layout.js';

test('antes de começar a câmera passeia pelo salão, sempre com o painel do sorteio na área do quadro', () => {
  const out = { x: 0, z: 0, yaw: 0, zoom: 0 };
  const panel = glanceTarget(LAYOUT).x;
  let minX = Infinity, maxX = -Infinity;
  for (let t = 0; t < 120; t += 0.5) {
    assert.equal(attractPose(t, false, out), out, 'reaproveita o objeto de saída');
    assert.ok(out.x >= ATTRACT.x - ATTRACT.sweepX - 1e-9 && out.x <= ATTRACT.x + ATTRACT.sweepX + 1e-9, `x ${out.x}`);
    assert.ok(out.z >= ATTRACT.z - ATTRACT.sweepZ - 1e-9 && out.z <= ATTRACT.z + ATTRACT.sweepZ + 1e-9, `z ${out.z}`);
    assert.ok(Math.abs(out.yaw) <= ATTRACT.yaw + 1e-9, `giro ${out.yaw}`);
    assert.ok(out.zoom >= ATTRACT.zoom - ATTRACT.dolly - 1e-9 && out.zoom <= ATTRACT.zoom + 1e-9, `zoom ${out.zoom}`);
    assert.ok(Math.abs(out.x - panel) <= ATTRACT.reach, `o painel (${panel}) saiu de vista com a câmera em ${out.x}`);
    minX = Math.min(minX, out.x); maxX = Math.max(maxX, out.x);
  }
  assert.ok(maxX - minX > 2, 'a câmera realmente anda');
});

test('com redução de movimento a câmera não passeia: fica no centro do salão, como antes', () => {
  const out = { x: 0, z: 0, yaw: 9, zoom: 9 };
  for (const t of [0, 17, 91]) {
    attractPose(t, true, out);
    assert.deepEqual(out, { x: LAYOUT.width / 2, z: LAYOUT.height / 2 - 0.5, yaw: 0, zoom: 1 });
  }
});

test('a espiada no painel sobe, segura e desce; fora da janela de 2,5 s não pesa nada', () => {
  assert.equal(REVEAL.duration, 2.5);
  assert.equal(revealWeight(0, false), 0);
  assert.ok(revealWeight(REVEAL.rise / 2, false) > 0.3 && revealWeight(REVEAL.rise / 2, false) < 0.7);
  assert.equal(revealWeight(REVEAL.rise, false), 1);
  assert.equal(revealWeight(REVEAL.duration - REVEAL.fall, false), 1);
  assert.equal(revealWeight(REVEAL.duration, false), 0);
  assert.equal(revealWeight(9, false), 0);
  assert.equal(revealWeight(-1, false), 0);
  let last = 0;
  for (let t = 0; t <= REVEAL.rise; t += 0.05) { const w = revealWeight(t, false); assert.ok(w >= last - 1e-9, 'sobe sem voltar'); last = w; }
});

test('com redução de movimento não há espiada', () => {
  for (const t of [0, 0.5, 1.2, 2]) assert.equal(revealWeight(t, true), 0);
});

test('a espiada mira o centro do painel do sorteio, na parede norte', () => {
  const glance = glanceTarget(LAYOUT);
  assert.equal(glance.x, LAYOUT.board.x + LAYOUT.board.width / 2);
  assert.ok(glance.y > 1 && glance.y < 2.2);
  assert.ok(glance.z >= 1 && glance.z < 3);
});

test('o objetivo do prêmio fica em piso livre, de frente para o painel, e diz o que é', () => {
  const goal = prizeObjective(LAYOUT);
  assert.equal(goal.kind, 'prize');
  assert.equal(LAYOUT.cells[Math.floor(goal.z)][Math.floor(goal.x)], '.', 'célula livre');
  assert.ok(goal.x >= LAYOUT.board.x && goal.x <= LAYOUT.board.x + LAYOUT.board.width);
  assert.match(goal.text, /Claude 20x/);
  assert.match(goal.text, /aos 200 no grupo/);
});

test('o farol aponta para o prêmio depois da primeira missão ou de um tempo parado, nunca no meio de uma tarefa', () => {
  const base = { topKind: 'install', carrying: false, visited: false, finishedMissions: 0, idleSeconds: 0 };
  assert.equal(shouldPointToPrize(base), false, 'no começo, o plantão manda');
  assert.equal(shouldPointToPrize({ ...base, finishedMissions: 1 }), true, 'depois da primeira missão');
  assert.equal(shouldPointToPrize({ ...base, idleSeconds: IDLE_NUDGE }), true, 'parado o bastante');
  assert.equal(shouldPointToPrize({ ...base, idleSeconds: IDLE_NUDGE - 1 }), false);
  assert.equal(shouldPointToPrize({ ...base, finishedMissions: 3, carrying: true }), false, 'com a GPU na mão não');
  assert.equal(shouldPointToPrize({ ...base, finishedMissions: 3, topKind: 'incident' }), false, 'incidente primeiro');
  assert.equal(shouldPointToPrize({ ...base, finishedMissions: 3, topKind: 'coffee' }), false, 'café baixo primeiro');
  assert.equal(shouldPointToPrize({ ...base, finishedMissions: 3, visited: true }), false, 'quem já viu o painel não é cutucado de novo');
});

test('na espiada o painel inteiro cabe no quadro, de tela larga a celular em pé', () => {
  const tan = Math.tan(40 * Math.PI / 360);
  for (const aspect of [16 / 9, 1.4, 390 / 844]) {
    const range = glanceRange(aspect);
    const visible = 2 * range * tan * aspect;
    assert.ok(visible >= LAYOUT.board.width * 0.95 || range >= 16, `aspecto ${aspect.toFixed(2)}: vê ${visible.toFixed(1)} de ${LAYOUT.board.width}`);
    assert.ok(range >= 5.5 && range <= 16, `distância ${range}`);
  }
  assert.ok(glanceRange(390 / 844) > glanceRange(16 / 9), 'no celular a câmera recua mais');
});

test('o caminho do chão sai do spawn, contorna as mesas e chega em frente ao painel, sempre em piso livre', () => {
  const points = prizePath(LAYOUT);
  assert.ok(points.length >= 3);
  assert.ok(Math.hypot(points[0].x - LAYOUT.spawn.x, points[0].z - LAYOUT.spawn.z) < 0.6, 'começa perto de onde o dev nasce');
  const last = points.at(-1);
  assert.ok(last.x >= LAYOUT.board.x && last.x <= LAYOUT.board.x + LAYOUT.board.width && last.z > LAYOUT.board.z + 1, 'termina de frente para o painel');
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], length = Math.hypot(b.x - a.x, b.z - a.z);
    for (let step = 0; step <= 40; step++) {
      const x = a.x + (b.x - a.x) * step / 40, z = a.z + (b.z - a.z) * step / 40;
      assert.equal(LAYOUT.cells[Math.floor(z)][Math.floor(x)], '.', `o trecho ${i} passa por cima de algo em (${x.toFixed(2)}, ${z.toFixed(2)}), ${length.toFixed(1)} de comprimento`);
    }
  }
});

test('as setas do caminho ficam espaçadas, em cima do traçado e apontam para onde ele vai', () => {
  const points = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }];
  const marks = pathMarks(points, 1);
  assert.equal(marks.length, 7, 'uma seta por metro, a primeira meio metro à frente e nenhuma no ponto final');
  assert.deepEqual(marks.slice(0, 4).map(m => [m.x, m.z]), [[0.5, 0], [1.5, 0], [2.5, 0], [3.5, 0]]);
  assert.ok(marks.slice(0, 4).every(m => Math.abs(m.angle) < 1e-9), 'para +x o ângulo é zero');
  assert.deepEqual(marks.slice(4).map(m => [m.x, m.z]), [[4, 0.5], [4, 1.5], [4, 2.5]], 'dobra a esquina sem perder o passo');
  assert.ok(Math.abs(marks[4].angle - -Math.PI / 2) < 1e-9, 'para +z o ângulo é -90 graus');
  assert.deepEqual(pathMarks([{ x: 1, z: 1 }], 1), [], 'um ponto só não é caminho');
});
