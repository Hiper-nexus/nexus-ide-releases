/** The map of Pink City: districts, roads and everything the rover can meet.
 * Pure data, so the layout can be tested without Three.js. Heading 0 looks
 * toward -z; +x is east. Units are world units (the rover is about 1.8 long). */

const road = (x, z, width, length, heading = 0) => ({ x, z, width, length, heading });

const CAFE = { x: 0, z: -34 };
const DROPS = { x: 34 };
const LIVE = { x: -36, z: 0 };
const YARD = { x: 32, z: -34 };
const PINS = { x: -32, z: 34 };

const trees = [
  [-8, -22, 1.3], [8, -22, 1.1], [-12, -40, 1.4], [12, -40, 1.5], [-22, -30, 1.2], [22, -30, 1.3],
  [26, -16, 1.1], [42, -16, 1.4], [42, 16, 1.2], [26, 16, 1.5], [-26, -12, 1.4], [-44, -10, 1.2], [-44, 10, 1.3], [-26, 12, 1.1],
  [-8, 14, 1.2], [8, 14, 1.3], [-24, 24, 1.4], [24, 24, 1.2], [-8, 52, 1.5], [8, 52, 1.3], [24, 50, 1.1], [-24, 50, 1.4],
  [40, -44, 1.2], [46, -30, 1.3], [-44, 44, 1.2], [-20, 44, 1.1], [46, 40, 1.4], [40, 48, 1.1],
];
const lamps = [[-5, -12], [5, -12], [-5, 12], [5, 12], [-14, -5], [-14, 5], [14, -5], [14, 5], [-22, 28], [22, 28], [-22, 46], [22, 46], [28, -26], [-28, 26]];

export const WORLD = {
  limit: 56,
  spawn: { x: 0, z: 18, heading: 0 },
  roads: [
    road(0, 4, 6, 92), road(0, 0, 6, 88, Math.PI / 2),
    road(0, 26, 6, 40, Math.PI / 2), road(0, 48, 6, 40, Math.PI / 2), road(-20, 37, 6, 22), road(20, 37, 6, 22),
    road(32, -18, 6, 32), road(-32, 18, 6, 32),
  ],
  districts: [
    { key: 'cafe', x: CAFE.x, z: CAFE.z, label: 'DEV CAFÉ' },
    { key: 'drops', x: DROPS.x, z: 0, label: 'DROPS' },
    { key: 'live', x: LIVE.x, z: LIVE.z, label: 'AO VIVO' },
    { key: 'track', x: 0, z: 37, label: 'PISTA' },
    { key: 'yard', x: YARD.x, z: YARD.z, label: 'BARRIS' },
    { key: 'pins', x: PINS.x, z: PINS.z, label: 'PINOS' },
  ],
  stations: [
    { key: 'claude', x: DROPS.x, z: -8, approach: 3.4, label: '01 / Claude 20x', anchorY: 3.6 },
    { key: 'codex', x: DROPS.x, z: 8, approach: 3.4, label: '02 / Codex 20x', anchorY: 3.6 },
    { key: 'live', x: LIVE.x, z: LIVE.z, approach: 4.5, label: '03 / As lives', anchorY: 5.3 },
  ],
  coffees: [[0, -16], [18, 0], [-18, -8], [10, 30], [-26, 20]],
  barrels: [[YARD.x - 4, YARD.z], [YARD.x + 4, YARD.z], [YARD.x, YARD.z - 5], [YARD.x - 3, YARD.z + 5], [YARD.x + 5, YARD.z + 5], [8, 40]],
  props: [[YARD.x - 7, YARD.z - 3, 'crate'], [YARD.x + 7, YARD.z + 2, 'crate'], [2, -8, 'cone'], [-2, -8, 'cone'], [-12, 30, 'cone'], [12, 44, 'cone'], [-30, 6, 'crate'], [16, 8, 'crate']],
  pins: [[PINS.x, PINS.z - 4], [PINS.x - 1.2, PINS.z - 2], [PINS.x + 1.2, PINS.z - 2], [PINS.x - 2.4, PINS.z], [PINS.x, PINS.z], [PINS.x + 2.4, PINS.z], [PINS.x - 3.6, PINS.z + 2], [PINS.x - 1.2, PINS.z + 2], [PINS.x + 1.2, PINS.z + 2], [PINS.x + 3.6, PINS.z + 2]],
  ramps: [{ x: 0, z: 31, heading: Math.PI, length: 6, width: 4.4, height: 1.6 }],
  boostPads: [{ x: 12, z: 48, heading: Math.PI / 2, length: 3, width: 4 }, { x: -20, z: 34, heading: 0, length: 3, width: 4 }, { x: 0, z: -6, heading: 0, length: 3, width: 4 }],
  trees, lamps,
  signs: [
    { text: 'NEXUS DEV CAFÉ', x: 0, z: 0, width: 22, height: 4, rotation: 0, tone: 'title' },
    { text: 'W A S D  DIRIGE', x: 0, z: 13, width: 12, height: 1.4, rotation: 0 },
    { text: 'SHIFT  BOOST   ESPAÇO  FREIO DE MÃO', x: 0, z: 9.6, width: 24, height: 1.5, rotation: 0 },
    { text: 'DROPS  →', x: 12, z: 3.6, width: 7, height: 1.3, rotation: 0 },
    { text: '←  LIVES', x: -12, z: 3.6, width: 7, height: 1.3, rotation: 0 },
    { text: 'PISTA  ↓', x: 3.6, z: 22, width: 7, height: 1.3, rotation: 0 },
    { text: 'CAFÉ  ↑', x: -3.6, z: -14, width: 7, height: 1.3, rotation: 0 },
    { text: 'BARRIS  ↗', x: 26, z: -10, width: 8, height: 1.3, rotation: 0 },
    { text: 'PINOS  ↙', x: -22, z: 12, width: 8, height: 1.3, rotation: 0 },
    { text: 'E  ATIVA A ESTAÇÃO', x: DROPS.x - 6, z: 0, width: 12, height: 1.2, rotation: 0 },
  ],
};

/** Axis-aligned boxes the rover cannot enter (buildings, stands, trunks). */
export const OBSTACLES = [
  { x: CAFE.x, z: CAFE.z, width: 8.2, depth: 1.6 },
  { x: CAFE.x - 12, z: CAFE.z + 6, width: 6.4, depth: 3.6 }, { x: CAFE.x + 12, z: CAFE.z + 6, width: 6.4, depth: 3.6 },
  { x: DROPS.x, z: -8, width: 2.6, depth: 2.6 }, { x: DROPS.x, z: 8, width: 2.6, depth: 2.6 },
  { x: LIVE.x, z: LIVE.z - 0.5, width: 4.4, depth: 1.4 },
  ...trees.map(([x, z]) => ({ x, z, width: 1.1, depth: 1.1 })),
  ...lamps.map(([x, z]) => ({ x, z, width: 0.5, depth: 0.5 })),
];

export function insideObstacle(x, z, margin = 0) {
  return OBSTACLES.some(o => Math.abs(x - o.x) < o.width / 2 + margin && Math.abs(z - o.z) < o.depth / 2 + margin);
}
