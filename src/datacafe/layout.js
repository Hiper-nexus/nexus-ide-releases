/** O andar do Nexus Data Café como dados puros. Cada caractere é uma célula de
 * 1 × 1 unidade: a célula (x, z) cobre [x, x+1) × [z, z+1), então o centro da
 * célula (3, 5) fica em (3.5, 5.5). A câmera olha do sul (+z) para o norte,
 * por isso a parede sul é baixa e a norte é alta.
 *
 *   '.' piso      '#' parede     'R' rack        'C' caixa de GPU na doca
 *   'K' cafeteira 'D' mesa/balcão 'N' telão NOC  'T' mesa do café
 *   'P' planta    'B' painel de LED do sorteio   'L' TV da live
 *   'H' cadeira da estação de trabalho, na frente da mesa com o terminal
 */
import { MODELS } from './models.js';

export const CELLS = [
  '##########################',
  '#NNNNNN..DKDBBBBBLPCCCCC.#',
  '#........................#',
  '#.......T...T............#',
  '#........................#',
  '#........................#',
  '#...RRRRRR.....RRRRRR....#',
  '#........................#',
  '#........................#',
  '#........................#',
  '#...RRRRRR.....DDDDDD....#',
  '#................H.......#',
  '#P.......................#',
  '#.................P......#',
  '##########################',
];

/** Fileiras de racks, na ordem em que as LLMs são distribuídas. Todos abrem para o sul (+z). */
const RACK_ROWS = [
  { z: 6, from: 4, to: 9 },
  { z: 6, from: 15, to: 20 },
  { z: 10, from: 4, to: 9 },
];

function rackSlots() {
  const slots = [];
  for (const row of RACK_ROWS) for (let x = row.from; x <= row.to; x++) slots.push({ x, z: row.z });
  return slots;
}

export const LAYOUT = Object.freeze({
  width: CELLS[0].length,
  height: CELLS.length,
  cellSize: 1,
  cells: CELLS,
  spawn: { x: 10.5, z: 4.5 },
  racks: rackSlots().map((slot, index) => ({ id: MODELS[index].id, x: slot.x, z: slot.z, facing: 's' })),
  coffee: { x: 10, z: 1 },
  dock: { x: 19, z: 1, width: 5 },
  noc: { x: 1, z: 1, width: 6 },
  /** O painel do sorteio: cinco células de largura, a atração da parede norte. */
  board: { x: 12, z: 1, width: 5 },
  live: { x: 17, z: 1 },
  /** A mesa do terminal: o dev senta em `seat`, de costas para a câmera, e levanta em `stand`. */
  workstation: {
    desk: { x: 17, z: 10 },
    chair: { x: 17, z: 11 },
    seat: { x: 17.5, z: 11.28 },
    stand: { x: 17.5, z: 12.42 },
    screen: { x: 17.5, y: 1.1, z: 10.3 },
  },
});

/** Altura de cada tipo de célula, a mesma da arte em datacenter.js. A câmera usa isto
 * para subir quando algo ficaria entre ela e o dev. */
export const HEIGHTS = Object.freeze({
  '#': 2.8, lowWall: 0.45, R: 2.05, N: 2.6, K: 1.45, D: 1.4, T: 0.8, P: 1.1, B: 2.1, L: 1.7, C: 0.95, H: 1,
});

/** Altura do que ocupa a célula (x, z); piso e fora do salão valem 0. */
export function obstacleHeight(layout, x, z) {
  if (x < 0 || z < 0 || x >= layout.width || z >= layout.height) return 0;
  const symbol = layout.cells[z][x];
  if (symbol === '.') return 0;
  if (symbol === '#') return z === 0 || x === 0 ? HEIGHTS['#'] : HEIGHTS.lowWall;
  return HEIGHTS[symbol] ?? HEIGHTS['#'];
}

export function cellCenter(x, z, size = 1) {
  return { x: (x + 0.5) * size, z: (z + 0.5) * size };
}

/** Todas as células com um símbolo, em ordem de leitura. */
export function findCells(layout, symbol) {
  const found = [];
  layout.cells.forEach((row, z) => {
    for (let x = 0; x < row.length; x++) if (row[x] === symbol) found.push({ x, z });
  });
  return found;
}
