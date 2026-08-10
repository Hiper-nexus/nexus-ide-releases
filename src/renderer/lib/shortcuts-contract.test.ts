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
 * Um catálogo único serve o cheatsheet, Configurações e as superfícies que
 * exibem atalhos. O comportamento dos handlers globais é coberto por App.test.
 */


describe('catálogo de atalhos', () => {
  it('não tem id duplicado', () => {
    const ids = SHORTCUTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('não tem combinação de teclas duplicada', () => {
    const keys = SHORTCUTS.map((entry) => entry.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('expõe uma única entrada canônica para criar missão', () => {
    const missionShortcuts = SHORTCUTS.filter((entry) =>
      entry.id.startsWith('mission-'),
    );
    expect(missionShortcuts).toEqual([
      expect.objectContaining({ id: 'mission-new', action: 'Nova missão' }),
    ]);
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
    expect(shortcutById('mission-new')?.action).toBe('Nova missão');
    expect(shortcutKeys('task-board')).toBe(
      SHORTCUTS.find((entry) => entry.id === 'task-board')?.keys,
    );
    expect(shortcutById('nao-existe')).toBeUndefined();
    expect(shortcutKeys('nao-existe')).toBeUndefined();
  });
});

