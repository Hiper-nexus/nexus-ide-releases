import { create } from 'zustand';
import {
  reduceCommandPaletteUiState,
  type SearchOverlayMode,
} from '../lib/command-palette-logic';

/**
 * Estado da busca global (Mod+K paleta · Mod+P arquivos · Mod+Shift+F
 * conteúdo) — global para o atalho (App) e a WorkspaceBar alcançarem. Um
 * reducer só: os três modos nunca empilham e repetir o atalho fecha.
 */
interface CommandPaletteStore {
  open: boolean;
  mode: SearchOverlayMode;
  /** Mod+K: abre a paleta de comandos ou fecha se já é ela. */
  toggle(): void;
  toggleMode(mode: SearchOverlayMode): void;
  close(): void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  mode: 'command',
  toggle: () =>
    set((s) => reduceCommandPaletteUiState(s, { _tag: 'ToggleMode', mode: 'command' })),
  toggleMode: (mode) =>
    set((s) => reduceCommandPaletteUiState(s, { _tag: 'ToggleMode', mode })),
  close: () =>
    set((s) => reduceCommandPaletteUiState(s, { _tag: 'SetOpen', open: false })),
}));
