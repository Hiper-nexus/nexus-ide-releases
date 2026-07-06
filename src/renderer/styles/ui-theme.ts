import type { TerminalThemeId } from '../../shared/settings-types';

/**
 * App-wide UI palettes, one per terminal theme. Selecting a theme in
 * Settings → Terminal restyles the WHOLE IDE (bar, drawers, launcher,
 * panels) by overriding the CSS custom properties on :root — the terminal
 * panes get their matching xterm palette via terminal-host.
 */

interface UiPalette {
  bg: string;
  bgElevated: string;
  bgBar: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  accent: string;
  accentSoft: string;
  danger: string;
}

const PALETTES: Record<TerminalThemeId, UiPalette> = {
  'nexus-dark': {
    bg: '#0b0e14',
    bgElevated: '#10141d',
    bgBar: '#0d1119',
    border: '#1c2333',
    borderStrong: '#273049',
    text: '#c9d1e0',
    // ~5.3:1 sobre --bg (clears WCAG AA). NÃO baixar pra #6b7690 (~4.25:1,
    // falha AA) — este valor tem que casar com o de global.css:root.
    textDim: '#7c869e',
    accent: '#6ea8fe',
    accentSoft: 'rgba(110, 168, 254, 0.14)',
    danger: '#f7768e',
  },
  'nexus-light': {
    bg: '#f7f8fb',
    bgElevated: '#ffffff',
    bgBar: '#eef1f6',
    border: '#dde3ee',
    borderStrong: '#c3cddf',
    text: '#2a3040',
    textDim: '#6b7690',
    accent: '#2563eb',
    accentSoft: 'rgba(37, 99, 235, 0.10)',
    danger: '#c73a52',
  },
  dracula: {
    bg: '#282a36',
    bgElevated: '#2f3242',
    bgBar: '#21222c',
    border: '#3b3e51',
    borderStrong: '#4d5170',
    text: '#f8f8f2',
    textDim: '#8b91b0',
    accent: '#bd93f9',
    accentSoft: 'rgba(189, 147, 249, 0.14)',
    danger: '#ff5555',
  },
  'solarized-dark': {
    bg: '#002b36',
    bgElevated: '#073642',
    bgBar: '#01313d',
    border: '#0e4250',
    borderStrong: '#1a5261',
    text: '#93a1a1',
    textDim: '#586e75',
    accent: '#268bd2',
    accentSoft: 'rgba(38, 139, 210, 0.14)',
    danger: '#dc322f',
  },
};

const VAR_MAP: Array<[keyof UiPalette, string]> = [
  ['bg', '--bg'],
  ['bgElevated', '--bg-elevated'],
  ['bgBar', '--bg-bar'],
  ['border', '--border'],
  ['borderStrong', '--border-strong'],
  ['text', '--text'],
  ['textDim', '--text-dim'],
  ['accent', '--accent'],
  ['accentSoft', '--accent-soft'],
  ['danger', '--danger'],
];

/** Restyle the whole app to the palette matching the selected theme. */
export function applyUiTheme(themeId: TerminalThemeId): void {
  const palette = PALETTES[themeId] ?? PALETTES['nexus-dark'];
  const root = document.documentElement;
  for (const [key, cssVar] of VAR_MAP) {
    root.style.setProperty(cssVar, palette[key]);
  }
  root.dataset.theme = themeId;
}
