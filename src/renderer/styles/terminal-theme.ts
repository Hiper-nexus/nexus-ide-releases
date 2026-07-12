import type { ITheme } from '@xterm/xterm';
import type { TerminalThemeId } from '../../shared/settings-types';

/** Terminal palette tuned to the NexusIDE deep-navy shell.
    background/cursor casados com os tokens da UI (--bg #0a0e15, --accent
    ciano #45d7ff) — hex-drift entre shell e terminal é regressão. */
export const TERMINAL_THEME: ITheme = {
  background: '#0a0e15',
  foreground: '#d7dfec',
  cursor: '#45d7ff',
  cursorAccent: '#0a0e15',
  selectionBackground: '#2a3a5c',
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

/** Selectable terminal palettes (TERMINAL module of the settings drawer). */
export const TERMINAL_THEMES: Record<
  TerminalThemeId,
  { label: string; theme: ITheme }
> = {
  'nexus-dark': { label: 'Nexus Dark', theme: TERMINAL_THEME },
  'nexus-light': { label: 'Nexus Light', theme: NEXUS_LIGHT },
  dracula: { label: 'Dracula', theme: DRACULA },
  'solarized-dark': { label: 'Solarized Dark', theme: SOLARIZED_DARK },
};
