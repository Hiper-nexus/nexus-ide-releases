// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: reducer de modos (CommandPalette.logic.ts:55-122) sem openIntent — o Nexus não abre a paleta com intenção; mapa comando→modo (CommandPalette.tsx:439-447); pilha de submenu e "Backspace no vazio volta" (CommandPalette.tsx:1517-1531, 3133-3137) como funções puras que também tiram a paleta dos modos de arquivo/conteúdo; placeholders por modo em PT-BR (CommandPalette.logic.ts:584-623); caminho de hit de conteúdo relativo ao workspace.

/**
 * A busca global hospeda três superfícies mutuamente exclusivas: a paleta de
 * comandos (Mod+K), o seletor de arquivos do projeto (Mod+P) e a busca no
 * conteúdo do projeto (Mod+Shift+F). Um reducer só manda em aberto/modo, então
 * as superfícies nunca empilham e repetir o atalho de um modo o fecha.
 */
export type SearchOverlayMode = 'command' | 'files' | 'content';

export interface CommandPaletteUiState {
  readonly open: boolean;
  readonly mode: SearchOverlayMode;
}

export type CommandPaletteUiAction =
  | { readonly _tag: 'SetOpen'; readonly open: boolean }
  | { readonly _tag: 'ToggleMode'; readonly mode: SearchOverlayMode };

export function reduceCommandPaletteUiState(
  state: CommandPaletteUiState,
  action: CommandPaletteUiAction,
): CommandPaletteUiState {
  switch (action._tag) {
    case 'SetOpen':
      return action.open
        ? { open: true, mode: 'command' }
        : { ...state, open: false };
    case 'ToggleMode':
      return state.open && state.mode === action.mode
        ? { ...state, open: false }
        : { open: true, mode: action.mode };
  }
}

const OVERLAY_MODE_BY_COMMAND: Readonly<Record<string, SearchOverlayMode>> = {
  'command-palette': 'command',
  'file-picker': 'files',
  'content-search': 'content',
};

/** Comando de atalho (lib/keybindings) → modo da busca global, ou null. */
export function overlayModeForCommand(
  command: string | null,
): SearchOverlayMode | null {
  return command === null ? null : (OVERLAY_MODE_BY_COMMAND[command] ?? null);
}

/**
 * Backspace com o campo vazio volta um degrau: primeiro sai do submenu,
 * depois do modo de arquivo/conteúdo para a paleta. Na raiz da paleta não
 * faz nada (Esc é quem fecha).
 */
export type PaletteBackStep = 'pop-view' | 'command-mode' | null;

export function paletteBackStep(input: {
  readonly query: string;
  readonly mode: SearchOverlayMode;
  readonly viewDepth: number;
}): PaletteBackStep {
  if (input.query !== '') return null;
  if (input.viewDepth > 0) return 'pop-view';
  if (input.mode !== 'command') return 'command-mode';
  return null;
}

export function paletteInputPlaceholder(
  mode: SearchOverlayMode,
  inSubmenu: boolean,
): string {
  if (mode === 'files') return 'Arquivo do projeto: nome ou caminho…';
  if (mode === 'content') return 'Texto nos arquivos do projeto…';
  return inSubmenu ? 'Filtrar…' : 'Pane, missão ou ação…';
}

/**
 * O ripgrep do SearchMixer devolve caminho absoluto sob a raiz canônica. O
 * editor trabalha com o relativo; fora da raiz (raiz com symlink) o caminho
 * segue absoluto e o main — que resolve dentro do escopo — é quem decide.
 */
export function workspaceRelativePath(
  filePath: string,
  workspaceRoot: string | null,
): string {
  const file = filePath.replace(/\\/g, '/');
  if (!workspaceRoot) return file;
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
}
