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

  it('reportar um problema tem atalho global próprio, em qualquer tela', () => {
    const entry = shortcutById('bug-report');
    expect(entry?.action).toMatch(/problema/i);
    expect(entry?.keys.toUpperCase()).toContain('B');
    expect(GLOBAL_HANDLER_SHORTCUT_IDS).toContain('bug-report');
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

  it('o rodapé do Home recebe os atalhos primary do catálogo', () => {
    const ids = primaryShortcuts().map((entry) => entry.id);
    expect(ids).toContain('split-right');
    expect(ids).toContain('command-palette');
    expect(ids).toContain('focus-pane-n');
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

