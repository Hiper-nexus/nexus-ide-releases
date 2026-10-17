import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LAUNCHER_ACTIONS,
  WORKSPACE_OPEN_ACTION,
  launcherAction,
  launcherActionIdForKey,
  launcherShortcutHint,
  requireAccessibleName,
} from './action-names';

describe('action names + launcher shortcuts (T3)', () => {
  it('every launcher action has a stable id, label and accessible name', () => {
    for (const entry of LAUNCHER_ACTIONS) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(requireAccessibleName(entry)).toBe(entry.accessibleName);
    }
  });

  it('accessible names are unique', () => {
    const names = LAUNCHER_ACTIONS.map((a) => a.accessibleName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('shortcuts 1-6 are unique and map to the action id', () => {
    const shortcuts = LAUNCHER_ACTIONS.map((a) => a.shortcut);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
    expect(launcherActionIdForKey('1')).toBe('pane');
    expect(launcherActionIdForKey('2')).toBe('mission');
    expect(launcherActionIdForKey('6')).toBe('memory');
    expect(launcherActionIdForKey('9')).toBeNull();
  });

  it('shortcuts never fire while typing in an editable target', () => {
    expect(
      launcherActionIdForKey('1', { targetIsEditable: true }),
    ).toBeNull();
  });

  it('icon-only action without accessible name is rejected', () => {
    expect(() =>
      requireAccessibleName({ id: 'ghost', accessibleName: '  ', label: '' }),
    ).toThrow(/no accessible name/);
  });

  it('falls back to label when accessibleName is missing', () => {
    expect(
      requireAccessibleName({ id: 'x', label: 'Abrir' }),
    ).toBe('Abrir');
  });

  it('shortcut hint is exposed for each action', () => {
    expect(launcherShortcutHint('pane')).toBe('1');
    expect(launcherShortcutHint('nope')).toBeNull();
  });
});

describe('abrir projeto: o rail e o Início leem o mesmo nome e a mesma explicação', () => {
  it('é a entrada "workspace" do registro, com atalho 3 e nome acessível que começa pelo rótulo visível', () => {
    expect(launcherAction('workspace')).toBe(WORKSPACE_OPEN_ACTION);
    expect(LAUNCHER_ACTIONS).toContain(WORKSPACE_OPEN_ACTION);
    expect(WORKSPACE_OPEN_ACTION.shortcut).toBe('3');
    // WCAG 2.5.3: quem fala o rótulo que lê na tela precisa acertar o nome.
    expect(
      WORKSPACE_OPEN_ACTION.accessibleName.startsWith(WORKSPACE_OPEN_ACTION.label),
    ).toBe(true);
  });

  it('a explicação promete pasta nova só enquanto o seletor do main aceita criar pasta', () => {
    expect(WORKSPACE_OPEN_ACTION.description).toMatch(/pasta do computador/);
    expect(WORKSPACE_OPEN_ACTION.description).toMatch(/pasta nova/);
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/persistence/workspace-store.ts'),
      'utf8',
    );
    const start = source.indexOf('WORKSPACE_CHANNELS.pick,');
    const end = source.indexOf('WORKSPACE_CHANNELS.pickPath');
    expect(start, 'handler de WORKSPACE_CHANNELS.pick não encontrado').toBeGreaterThan(-1);
    expect(end, 'handler de WORKSPACE_CHANNELS.pickPath não encontrado').toBeGreaterThan(start);
    // Sem 'createDirectory' o diálogo não oferece "Nova pasta" e o tooltip mentiria.
    expect(source.slice(start, end)).toContain("'createDirectory'");
  });
});
