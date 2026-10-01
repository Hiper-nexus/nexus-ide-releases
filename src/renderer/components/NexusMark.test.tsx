/** @vitest-environment jsdom */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';

import { NEXUS_N_CELLS, NexusMark } from './NexusMark';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(ui: ReactElement) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(ui));
  return host;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

it('desenha o N pixel do site: grade 4×4 com as pontas cheias e a diagonal', () => {
  const grid = Array.from({ length: 4 }, () => Array<string>(4).fill('.'));
  for (const [col, row] of NEXUS_N_CELLS) grid[row]![col] = '#';
  expect(grid.map((row) => row.join(''))).toEqual(['#..#', '##.#', '#.##', '#..#']);
});

it('renderiza uma célula por quadradinho, nomeada e herdando a cor do contexto', async () => {
  const container = await render(<NexusMark size={22} className="marca" />);
  const svg = container.querySelector('svg')!;
  expect(svg.getAttribute('viewBox')).toBe('0 0 4 4');
  expect(svg.getAttribute('aria-label')).toBe('NexusIDE');
  expect(svg.getAttribute('fill')).toBe('currentColor');
  expect(svg.getAttribute('width')).toBe('22');
  expect(svg.getAttribute('class')).toBe('marca');
  expect(svg.querySelectorAll('rect')).toHaveLength(NEXUS_N_CELLS.length);
});
