// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: casos do reducer (CommandPalette.logic.test.ts:181-260) sem openIntent; casos novos para Backspace-volta, mapa comando→modo e caminho relativo do hit.
import { describe, expect, it } from 'vitest';
import {
  overlayModeForCommand,
  paletteBackStep,
  reduceCommandPaletteUiState,
  workspaceRelativePath,
} from './command-palette-logic';

describe('reduceCommandPaletteUiState', () => {
  const closedState = { open: false, mode: 'command' } as const;

  it('toggles each overlay mode open and closed', () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: 'ToggleMode',
      mode: 'files',
    });
    expect(filesOpen).toEqual({ open: true, mode: 'files' });

    const contentOpen = reduceCommandPaletteUiState(filesOpen, {
      _tag: 'ToggleMode',
      mode: 'content',
    });
    expect(contentOpen).toEqual({ open: true, mode: 'content' });

    expect(
      reduceCommandPaletteUiState(contentOpen, { _tag: 'ToggleMode', mode: 'content' }),
    ).toEqual({ open: false, mode: 'content' });
  });

  it('switches between open modes without closing (nunca empilha)', () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: 'ToggleMode',
      mode: 'files',
    });
    expect(
      reduceCommandPaletteUiState(filesOpen, { _tag: 'ToggleMode', mode: 'command' }),
    ).toEqual({ open: true, mode: 'command' });
  });

  it('repetir Mod+K fecha a paleta de comandos', () => {
    const open = reduceCommandPaletteUiState(closedState, {
      _tag: 'ToggleMode',
      mode: 'command',
    });
    expect(open.open).toBe(true);
    expect(
      reduceCommandPaletteUiState(open, { _tag: 'ToggleMode', mode: 'command' }).open,
    ).toBe(false);
  });

  it('preserves the mode on close and resets it on open', () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: 'ToggleMode',
      mode: 'files',
    });
    const closed = reduceCommandPaletteUiState(filesOpen, {
      _tag: 'SetOpen',
      open: false,
    });
    expect(closed).toEqual({ open: false, mode: 'files' });
    expect(
      reduceCommandPaletteUiState(closed, { _tag: 'SetOpen', open: true }),
    ).toEqual({ open: true, mode: 'command' });
  });
});

describe('paletteBackStep', () => {
  it('Backspace no vazio sai do submenu antes de sair do modo', () => {
    expect(paletteBackStep({ query: '', mode: 'command', viewDepth: 1 })).toBe(
      'pop-view',
    );
    expect(paletteBackStep({ query: '', mode: 'files', viewDepth: 0 })).toBe(
      'command-mode',
    );
    expect(paletteBackStep({ query: '', mode: 'content', viewDepth: 0 })).toBe(
      'command-mode',
    );
  });

  it('com texto, ou na raiz da paleta, Backspace é só edição', () => {
    expect(paletteBackStep({ query: 'a', mode: 'files', viewDepth: 1 })).toBeNull();
    expect(paletteBackStep({ query: '', mode: 'command', viewDepth: 0 })).toBeNull();
  });
});

describe('overlayModeForCommand', () => {
  it('mapeia os três atalhos da busca global e ignora o resto', () => {
    expect(overlayModeForCommand('command-palette')).toBe('command');
    expect(overlayModeForCommand('file-picker')).toBe('files');
    expect(overlayModeForCommand('content-search')).toBe('content');
    expect(overlayModeForCommand('mission-new')).toBeNull();
    expect(overlayModeForCommand(null)).toBeNull();
  });
});

describe('workspaceRelativePath', () => {
  it('tira a raiz do workspace do caminho do hit', () => {
    expect(workspaceRelativePath('/p/app/src/a.ts', '/p/app')).toBe('src/a.ts');
    expect(workspaceRelativePath('/p/app/src/a.ts', '/p/app/')).toBe('src/a.ts');
    expect(workspaceRelativePath('C:\\p\\app\\src\\a.ts', 'C:\\p\\app')).toBe(
      'src/a.ts',
    );
  });

  it('não confunde prefixo de irmão com a raiz', () => {
    expect(workspaceRelativePath('/p/app-2/a.ts', '/p/app')).toBe('/p/app-2/a.ts');
  });
});
