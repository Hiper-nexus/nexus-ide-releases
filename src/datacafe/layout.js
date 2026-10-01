/** O andar do Nexus Data Café como dados puros. Cada caractere é uma célula de
 * 1 × 1 unidade: a célula (x, z) cobre [x, x+1) × [z, z+1), então o centro da
 * célula (3, 5) fica em (3.5, 5.5). A câmera olha do sul (+z) para o norte,
 * por isso a parede sul é baixa e a norte é alta.
 *
 *   '.' piso      '#' parede     'R' rack        'C' caixa de GPU na doca
 *   'K' cafeteira 'D' mesa/balcão 'N' telão NOC  'T' mesa do café
 *   'P' planta    'B' mural da comunidade        'L' TV da live
 */
import { MODELS } from './models.js';

export const CELLS = [
  '##########################',
  '#NNNNNN..DKD.PB.LP.CCCCC.#',
  '#........................#',
  '#.......T...T............#',
  '#........................#',
  '#........................#',
  '#...RRRRRR.....RRRRRR....#',
  '#........................#',
  '#........................#',
  '#........................#',
  '#...RRRRRR.....DDDDDD....#',
  '#........................#',
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
  board: { x: 14, z: 1 },
  live: { x: 16, z: 1 },
});

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
