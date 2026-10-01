/**
 * Gera `assets/icon.png` (1024×1024), a fonte canônica dos ícones do app: o
 * `.ico` do Windows e o `.icns` do macOS saem dele (`npm run build:app-icons`).
 *
 * O desenho é a logomarca do site (`nexus-site/public/favicon.svg`): o "N"
 * pixel rosa numa grade 4×4, sobre o near-black da marca. Ele é calculado por
 * geometria, sem depender de ferramenta de imagem, para o ícone ser reproduzível
 * em qualquer máquina e não derivar do site sem alguém perceber (o teste confere).
 *
 *   node scripts/build-app-icon-source.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encodePngEntry } from './build-windows-icon.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Células [coluna, linha] do N na grade 4×4: pontas cheias e a diagonal no meio. */
export const NEXUS_N_CELLS = Object.freeze([
  [0, 0], [0, 1], [0, 2], [0, 3],
  [3, 0], [3, 1], [3, 2], [3, 3],
  [1, 1], [2, 2],
]);

/**
 * Recuo de 100 px nos quatro lados: o macOS não mascara o ícone, então o
 * quadrado arredondado de 824 px na tela de 1024 é o que o faz ter o mesmo
 * tamanho visual dos outros apps no Dock. O N ocupa metade do quadrado, como
 * no favicon (32 de 64).
 */
export const ICON_LAYOUT = Object.freeze({
  size: 1024,
  margin: 100,
  radius: 188,
  cell: 103,
  glyphX: 306,
  glyphY: 306,
});

const INK = [0x08, 0x07, 0x09];
const PINK = [0xff, 0x4f, 0x8b];
const EDGE = [0xff, 0xff, 0xff];
/** Fio de luz de 3 px na borda de dentro do quadrado, só para separar do Dock escuro. */
const EDGE_WIDTH = 3;
const EDGE_STRENGTH = 0.09;
const SAMPLES = 4;

const mix = (from, to, amount) => from.map((channel, i) => channel + (to[i] - channel) * amount);

/** Distância assinada ao quadrado arredondado: negativa dentro. */
function roundedSquareDistance(x, y) {
  const { size, margin, radius } = ICON_LAYOUT;
  const half = (size - margin * 2) / 2;
  const qx = Math.abs(x - size / 2) - (half - radius);
  const qy = Math.abs(y - size / 2) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function insideGlyph(x, y) {
  const { cell, glyphX, glyphY } = ICON_LAYOUT;
  const col = Math.floor((x - glyphX) / cell);
  const row = Math.floor((y - glyphY) / cell);
  if (col < 0 || row < 0 || col > 3 || row > 3) return false;
  return NEXUS_N_CELLS.some(([c, r]) => c === col && r === row);
}

export function renderAppIcon() {
  const { size } = ICON_LAYOUT;
  const rgba = Buffer.alloc(size * size * 4);
  const weight = 1 / (SAMPLES * SAMPLES);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let covered = 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = px + (sx + 0.5) / SAMPLES;
          const y = py + (sy + 0.5) / SAMPLES;
          const distance = roundedSquareDistance(x, y);
          if (distance > 0) continue;
          covered += 1;
          let color = insideGlyph(x, y) ? PINK : INK;
          if (distance > -EDGE_WIDTH && color === INK) color = mix(INK, EDGE, EDGE_STRENGTH);
          red += color[0];
          green += color[1];
          blue += color[2];
        }
      }
      const i = (py * size + px) * 4;
      if (covered === 0) continue;
      rgba[i] = Math.round(red / covered);
      rgba[i + 1] = Math.round(green / covered);
      rgba[i + 2] = Math.round(blue / covered);
      rgba[i + 3] = Math.round(covered * weight * 255);
    }
  }
  return encodePngEntry(rgba, size);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const target = resolve(ROOT, 'assets', 'icon.png');
  writeFileSync(target, renderAppIcon());
  console.log(`ícone-fonte escrito em ${target}`);
}
