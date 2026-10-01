import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUT, findCells, cellCenter, obstacleHeight, HEIGHTS } from './layout.js';
import { MODELS } from './models.js';
import { createGrid, circleFree, cellAt } from './grid.js';

const grid = createGrid(LAYOUT);
const RADIUS = 0.3;

test('o mapa é retangular e fechado por paredes', () => {
  assert.equal(grid.cells.every(row => row.length === LAYOUT.width), true);
  for (let x = 0; x < LAYOUT.width; x++) {
    assert.equal(LAYOUT.cells[0][x], '#');
    assert.equal(LAYOUT.cells[LAYOUT.height - 1][x], '#');
  }
  for (let z = 0; z < LAYOUT.height; z++) {
    assert.equal(LAYOUT.cells[z][0], '#');
    assert.equal(LAYOUT.cells[z][LAYOUT.width - 1], '#');
  }
});

test('há um rack por LLM, cada um em uma célula R com a frente livre', () => {
  assert.equal(LAYOUT.racks.length, MODELS.length);
  assert.deepEqual(LAYOUT.racks.map(rack => rack.id).sort(), MODELS.map(model => model.id).sort());
  assert.equal(findCells(LAYOUT, 'R').length, MODELS.length, 'nenhum R sobrando no mapa');
  for (const rack of LAYOUT.racks) {
    assert.equal(LAYOUT.cells[rack.z][rack.x], 'R', `${rack.id} está numa célula R`);
    assert.equal(LAYOUT.cells[rack.z + 1][rack.x], '.', `${rack.id} tem o corredor livre na frente`);
  }
});

test('os pontos de interação estão nas células certas', () => {
  assert.equal(LAYOUT.cells[LAYOUT.coffee.z][LAYOUT.coffee.x], 'K');
  assert.ok(LAYOUT.board.width >= 4, 'o painel do sorteio é largo, a atração principal da parede norte');
  for (let i = 0; i < LAYOUT.board.width; i++) assert.equal(LAYOUT.cells[LAYOUT.board.z][LAYOUT.board.x + i], 'B');
  assert.equal(LAYOUT.cells[LAYOUT.board.z][LAYOUT.board.x - 1] === 'B' || LAYOUT.cells[LAYOUT.board.z][LAYOUT.board.x + LAYOUT.board.width] === 'B', false, 'o painel não vaza para fora da largura declarada');
  assert.equal(LAYOUT.cells[LAYOUT.live.z][LAYOUT.live.x], 'L');
  for (let i = 0; i < LAYOUT.dock.width; i++) assert.equal(LAYOUT.cells[LAYOUT.dock.z][LAYOUT.dock.x + i], 'C');
  for (let i = 0; i < LAYOUT.noc.width; i++) assert.equal(LAYOUT.cells[LAYOUT.noc.z][LAYOUT.noc.x + i], 'N');
});

test('o dev nasce em piso livre e alcança a frente de todos os racks e objetos', () => {
  assert.equal(circleFree(grid, LAYOUT.spawn.x, LAYOUT.spawn.z, RADIUS), true);
  // Busca em largura pelas células de piso a partir do spawn.
  const start = [Math.floor(LAYOUT.spawn.x), Math.floor(LAYOUT.spawn.z)];
  const seen = new Set([start.join(',')]);
  const queue = [start];
  while (queue.length) {
    const [x, z] = queue.shift();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${x + dx},${z + dz}`;
      if (seen.has(key) || cellAt(grid, x + dx + 0.5, z + dz + 0.5) !== '.') continue;
      seen.add(key);
      queue.push([x + dx, z + dz]);
    }
  }
  for (const rack of LAYOUT.racks) assert.ok(seen.has(`${rack.x},${rack.z + 1}`), `frente do rack ${rack.id}`);
  for (const spot of [LAYOUT.coffee, LAYOUT.board, LAYOUT.live, LAYOUT.dock]) assert.ok(seen.has(`${spot.x},${spot.z + 1}`));
  for (let i = 0; i < LAYOUT.board.width; i++) assert.ok(seen.has(`${LAYOUT.board.x + i},${LAYOUT.board.z + 1}`), `frente do painel, célula ${i}`);
  const { stand } = LAYOUT.workstation;
  assert.ok(seen.has(`${Math.floor(stand.x)},${Math.floor(stand.z)}`), 'lugar de levantar da estação');
});

test('a estação de trabalho tem mesa, cadeira à frente e um lugar livre para levantar', () => {
  const { desk, chair, seat, stand, screen } = LAYOUT.workstation;
  assert.equal(LAYOUT.cells[desk.z][desk.x], 'D', 'mesa');
  assert.equal(LAYOUT.cells[chair.z][chair.x], 'H', 'cadeira');
  assert.deepEqual([chair.x, chair.z], [desk.x, desk.z + 1], 'cadeira encostada na frente da mesa');
  assert.equal(findCells(LAYOUT, 'H').length, 1, 'uma cadeira só');
  assert.ok(seat.x > chair.x && seat.x < chair.x + 1 && seat.z > chair.z && seat.z < chair.z + 1, 'assento dentro da célula da cadeira');
  assert.equal(circleFree(grid, stand.x, stand.z, RADIUS), true, 'levanta em piso livre');
  assert.ok(screen.z > desk.z && screen.z < desk.z + 0.5 && screen.y > 0.8, 'monitor sobre a mesa, do lado de lá');
});

test('a altura de cada obstáculo segue o diorama: paredes norte e oeste altas, sul e leste baixas', () => {
  assert.equal(obstacleHeight(LAYOUT, 5, 0), HEIGHTS['#']);
  assert.equal(obstacleHeight(LAYOUT, 0, 7), HEIGHTS['#']);
  assert.equal(obstacleHeight(LAYOUT, 5, LAYOUT.height - 1), HEIGHTS.lowWall);
  assert.equal(obstacleHeight(LAYOUT, LAYOUT.width - 1, 7), HEIGHTS.lowWall);
  assert.equal(obstacleHeight(LAYOUT, LAYOUT.racks[0].x, LAYOUT.racks[0].z), HEIGHTS.R);
  assert.equal(obstacleHeight(LAYOUT, 3, 3), 0, 'piso');
  assert.equal(obstacleHeight(LAYOUT, -1, 3), 0, 'fora do salão não há nada');
  for (const symbol of new Set(LAYOUT.cells.join('').replace(/[.#]/g, ''))) assert.ok(HEIGHTS[symbol] > 0, `altura de ${symbol}`);
});

test('cellCenter devolve o centro da célula', () => {
  assert.deepEqual(cellCenter(3, 5), { x: 3.5, z: 5.5 });
});
