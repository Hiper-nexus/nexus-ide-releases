import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_HANDLER_SHORTCUT_IDS,
  SHORTCUTS,
  primaryShortcuts,
  shortcutById,
  shortcutKeys,
  shortcutsInGroup,
} from './shortcuts';

/**
 * O catálogo de atalhos existe para que UMA lista sirva o cheatsheet, as
 * Configurações e o rodapé do Home. Esses testes são o que impede a volta do
 * problema original: ⌘⇧N existia em App.tsx desde sempre e não aparecia em
 * nenhuma das três listas escritas à mão.
 */

const APP_TSX = readFileSync(
  join(__dirname, '..', 'App.tsx'),
  'utf8',
);

describe('catálogo de atalhos', () => {
  it('não tem id duplicado', () => {
    const ids = SHORTCUTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('não tem combinação de teclas duplicada', () => {
    const keys = SHORTCUTS.map((entry) => entry.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('cobre ⌘⇧N — a missão rápida que faltava nas três listas', () => {
    const quick = SHORTCUTS.find((entry) => entry.id === 'mission-quick');
    expect(quick).toBeDefined();
    expect(quick?.action).toMatch(/objetivo/i);
  });

  it('todo atalho declarado como servido por handler global existe', () => {
    const ids = new Set(SHORTCUTS.map((entry) => entry.id));
    for (const id of GLOBAL_HANDLER_SHORTCUT_IDS) {
      expect(ids, `handler global sem entrada no catálogo: ${id}`).toContain(
        id,
      );
    }
  });

  it('todo atalho primary tem rótulo curto para o rodapé', () => {
    for (const entry of SHORTCUTS.filter((item) => item.primary)) {
      expect(
        entry.short,
        `atalho primary sem short: ${entry.id}`,
      ).toBeTruthy();
    }
  });

  it('cada grupo tem ao menos um atalho', () => {
    expect(shortcutsInGroup('command').length).toBeGreaterThan(0);
    expect(shortcutsInGroup('fleet').length).toBeGreaterThan(0);
    expect(shortcutsInGroup('surfaces').length).toBeGreaterThan(0);
  });

  it('o rodapé filtra por view: split é grid, centralizar é canvas', () => {
    const grid = primaryShortcuts('grid').map((entry) => entry.id);
    const canvas = primaryShortcuts('canvas').map((entry) => entry.id);
    expect(grid).toContain('split-right');
    expect(grid).not.toContain('canvas-center');
    expect(canvas).toContain('canvas-center');
    expect(canvas).not.toContain('split-right');
    // O palette vale nas duas views.
    expect(grid).toContain('command-palette');
    expect(canvas).toContain('command-palette');
  });

  it('shortcutById / shortcutKeys resolvem o catálogo e rejeitam id desconhecido', () => {
    expect(shortcutById('mission-quick')?.action).toMatch(/objetivo/i);
    expect(shortcutKeys('ops-board')).toBe(
      SHORTCUTS.find((entry) => entry.id === 'ops-board')?.keys,
    );
    expect(shortcutById('nao-existe')).toBeUndefined();
    expect(shortcutKeys('nao-existe')).toBeUndefined();
  });
});

describe('contrato com os handlers de App.tsx', () => {
  /**
   * Guarda grosseira mas efetiva: se alguém registrar um handler global novo
   * sem catalogá-lo, o atalho volta a ser invisível. Casa pela tecla que o
   * handler testa, não pelo rótulo renderizado.
   */
  const HANDLER_PROBES: ReadonlyArray<{ id: string; probe: RegExp }> = [
    { id: 'settings', probe: /e\.key === ','/ },
    { id: 'operator-profile', probe: /'o' && e\.shiftKey/ },
    { id: 'ops-board', probe: /'b' && !e\.shiftKey/ },
    { id: 'command-palette', probe: /'k' && !e\.shiftKey/ },
    { id: 'cheatsheet', probe: /e\.key === '\/'/ },
    { id: 'mission-quick', probe: /'n' && e\.shiftKey/ },
    { id: 'mission-new', probe: /'n' && !e\.shiftKey/ },
  ];

  it.each(HANDLER_PROBES)(
    'o handler de $id está no catálogo',
    ({ id, probe }) => {
      expect(
        probe.test(APP_TSX),
        `handler de ${id} não encontrado em App.tsx — o probe ficou obsoleto?`,
      ).toBe(true);
      expect(SHORTCUTS.some((entry) => entry.id === id)).toBe(true);
    },
  );

  it('⌘⇧N é servido por um handler real, não só documentado', () => {
    expect(/'n' && e\.shiftKey/.test(APP_TSX)).toBe(true);
    expect(/openForAgentic\(\)/.test(APP_TSX)).toBe(true);
  });
});
