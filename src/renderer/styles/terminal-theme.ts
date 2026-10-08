import type { ITheme } from '@xterm/xterm';
import type { TerminalThemeId } from '../../shared/settings-types';

/** Stable untinted dark xterm palette. Pink City deliberately reuses this
    exact object: terminal content remains independent from UI chrome, while
    Nexus Dark keeps the same background, cursor and ANSI colors as before. */
export const TERMINAL_THEME: ITheme = {
  background: '#0b0b0c',
  foreground: '#ededef',
  cursor: '#7c86ff',
  cursorAccent: '#0b0b0c',
  selectionBackground: '#2d3055',
  black: '#0b0e14',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#6ea8fe',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#c9d1e0',
  brightBlack: '#3b4261',
  brightRed: '#ff9aa8',
  brightGreen: '#b9f27c',
  brightYellow: '#ffcf8f',
  brightBlue: '#9ec5ff',
  brightMagenta: '#d3b6ff',
  brightCyan: '#a4e0ff',
  brightWhite: '#eef2ff',
};

/** Paleta xterm ciano legada (pré-0.21) — preservada para a Camada 2
    registrar junto com o tema "nexus-legacy" (par da
    LEGACY_NEXUS_CYAN_PALETTE de ui-theme.ts). */
export const LEGACY_NEXUS_CYAN_TERMINAL: ITheme = {
  ...TERMINAL_THEME,
  background: '#0a0e15',
  foreground: '#d7dfec',
  cursor: '#3dd9ff',
  cursorAccent: '#0a0e15',
  selectionBackground: '#2a3a5c',
};

const NEXUS_LIGHT: ITheme = {
  background: '#f7f8fb',
  foreground: '#2a3040',
  cursor: '#2563eb',
  cursorAccent: '#f7f8fb',
  selectionBackground: '#c7d7f5',
  black: '#3b4261',
  red: '#c73a52',
  green: '#4e7d2c',
  yellow: '#946a17',
  blue: '#2563eb',
  magenta: '#7c3aed',
  cyan: '#0e7490',
  white: '#2a3040',
  brightBlack: '#6b7690',
  brightRed: '#e05a72',
  brightGreen: '#659a41',
  brightYellow: '#b3862f',
  brightBlue: '#4f83f1',
  brightMagenta: '#9a63f5',
  brightCyan: '#1d94b8',
  brightWhite: '#111522',
};

const DRACULA: ITheme = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#bd93f9',
  cursorAccent: '#282a36',
  selectionBackground: '#44475a',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
};

const SOLARIZED_DARK: ITheme = {
  background: '#002b36',
  foreground: '#93a1a1',
  cursor: '#268bd2',
  cursorAccent: '#002b36',
  selectionBackground: '#073642',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightRed: '#cb4b16',
  brightGreen: '#93a1a1',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3',
};

// Nexus Gray (paridade 1.3: tema Cinza) — neutro de baixa saturação.
const NEXUS_GRAY: ITheme = {
  background: '#141518',
  foreground: '#e4e6ea',
  cursor: '#e4e6ea',
  cursorAccent: '#141518',
  selectionBackground: '#3a3d44',
  black: '#141518',
  red: '#e06c6c',
  green: '#7fbf8e',
  yellow: '#c9b06b',
  blue: '#7d95c9',
  magenta: '#b18ccf',
  cyan: '#7cb9c9',
  white: '#e4e6ea',
  brightBlack: '#5c6069',
  brightRed: '#ef8c8c',
  brightGreen: '#98d3a6',
  brightYellow: '#dcc287',
  // Era '#9aafcfd' (7 dígitos, cor inválida desde c2ec961bf). Derivado pela
  // regra dos outros 5 pares normal→bright deste tema, medida em OKLCH:
  // ΔL ≈ +0.07, croma ×0.85, matiz do `blue` (#7d95c9 → L .741 C .070 H 265).
  brightBlue: '#96abd9',
  brightMagenta: '#c6a7de',
  brightCyan: '#9ccfdd',
  brightWhite: '#f5f6f8',
};

// Nexus Red (paridade 1.3.9: 4º tema Vermelho) — trabalho noturno, acento
// quente sem estourar contraste no grid escuro.
const NEXUS_RED: ITheme = {
  background: '#120c0d',
  foreground: '#f2e6e7',
  cursor: '#f2e6e7',
  cursorAccent: '#120c0d',
  selectionBackground: '#4a262a',
  black: '#120c0d',
  red: '#ff7b72',
  green: '#9fbf87',
  yellow: '#d2a85f',
  blue: '#a08fbf',
  magenta: '#d98aa6',
  cyan: '#8fb4bf',
  white: '#f2e6e7',
  brightBlack: '#6e5255',
  brightRed: '#ff9a92',
  brightGreen: '#b3d39c',
  brightYellow: '#e3c07d',
  brightBlue: '#b6a7d1',
  brightMagenta: '#e6a5bc',
  brightCyan: '#a9cbd5',
  brightWhite: '#faf0f1',
};

/** Selectable terminal palettes (TERMINAL module of the settings drawer). */
export const TERMINAL_THEMES: Record<
  TerminalThemeId,
  { label: string; theme: ITheme }
> = {
  'nexus-pink-city': { label: 'Pink City', theme: TERMINAL_THEME },
  'nexus-dark': { label: 'Nexus Dark', theme: TERMINAL_THEME },
  'nexus-light': { label: 'Nexus Light', theme: NEXUS_LIGHT },
  'nexus-gray': { label: 'Nexus Gray', theme: NEXUS_GRAY },
  'nexus-red': { label: 'Nexus Red', theme: NEXUS_RED },
  dracula: { label: 'Dracula', theme: DRACULA },
  'solarized-dark': { label: 'Solarized Dark', theme: SOLARIZED_DARK },
};
