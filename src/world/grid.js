/** The data-center floor as a grid of unit cells. Pure math, no Three.js.
 * Cell (x, z) spans the world square [x, x+1) × [z, z+1), so the centre of
 * cell (3, 5) sits at world (3.5, 5.5). Everything that is not '.' is solid:
 * walls, racks, dock, coffee machine, NOC screen, tables and plants. */

export const FLOOR = '.';

/** Reads the character at a world position. Out of bounds reads as wall. */
export function cellAt(grid, x, z) {
  const ix = Math.floor(x / grid.cellSize), iz = Math.floor(z / grid.cellSize);
  if (ix < 0 || iz < 0 || ix >= grid.width || iz >= grid.height) return '#';
  return grid.cells[iz][ix];
}

export function isSolid(grid, x, z) {
  return cellAt(grid, x, z) !== FLOOR;
}

/** True when the whole disc centred at (x, z) is on floor cells, which is
 * the invariant every movement must preserve. */
export function circleFree(grid, x, z, radius) {
  const s = grid.cellSize;
  const minCx = Math.floor((x - radius) / s), maxCx = Math.floor((x + radius) / s);
  const minCz = Math.floor((z - radius) / s), maxCz = Math.floor((z + radius) / s);
  for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      // Probe the cell by its centre so the probe itself never lands on a border.
      if (cellAt(grid, (cx + .5) * s, (cz + .5) * s) === FLOOR) continue;
      const nearX = Math.max(cx * s, Math.min(x, (cx + 1) * s));
      const nearZ = Math.max(cz * s, Math.min(z, (cz + 1) * s));
      const dx = nearX - x, dz = nearZ - z;
      if (dx * dx + dz * dz < radius * radius) return false;
    }
  }
  return true;
}

/** Moves pos by delta, one axis at a time, so the dev slides along walls and
 * racks instead of sticking to them. Each axis marches in half-cell substeps
 * and stops at the first blocked one, which also keeps a huge delta (a slow
 * frame, a resumed tab) from tunnelling through a one-cell wall.
 * ponytail: substeps are O(distance); a swept test is the upgrade path if
 * deltas ever grow far beyond one cell per frame. */
export function resolveMove(grid, pos, delta, radius) {
  const step = grid.cellSize / 2;
  let x = pos.x, z = pos.z;
  const apply = (axis, amount) => {
    const sign = Math.sign(amount);
    for (let remaining = Math.abs(amount); remaining > 0;) {
      const move = Math.min(step, remaining) * sign;
      if (axis === 'x') {
        if (!circleFree(grid, x + move, z, radius)) return;
        x += move;
      } else {
        if (!circleFree(grid, x, z + move, radius)) return;
        z += move;
      }
      remaining -= Math.min(step, remaining);
    }
  };
  apply('x', delta.x);
  apply('z', delta.z);
  return { x, z };
}

/** Flattens a LAYOUT into the grid the functions above read. */
export function createGrid(layout) {
  const cells = layout.cells;
  if (!Array.isArray(cells) || cells.length !== layout.height) {
    throw new Error('layout.cells must have exactly layout.height rows');
  }
  cells.forEach((row, z) => {
    if (typeof row !== 'string' || row.length !== layout.width) {
      throw new Error(`layout.cells row ${z} must be a string of layout.width chars`);
    }
  });
  return { width: layout.width, height: layout.height, cellSize: layout.cellSize, cells };
}
