// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: leitura de cor (hex com alpha, color(display-p3|srgb)), composição de alpha, detecção de tema e nomes portados de apps/web/src/vscodeThemeImport.ts; a paleta de destino é a UiPalette de 14 vars + xterm do Nexus (não os papéis do T3), o piso de contraste é WCAG AA (4,5:1 para texto e acento) com ajuste de luminosidade OKLCH em vez da separação 1,1:1, o CTA primário fica neutro por regra do DESIGN.md, a aparência segue o fundo real, o id ganha o prefixo `vscode-`, JSONC é aceito e não há pareamento claro/escuro nem Effect.
import { parseJsonc } from '../../shared/jsonc';
import {
  IMPORTED_TERMINAL_KEYS,
  MAX_IMPORTED_THEMES,
  importedThemeSchema,
  type ImportedTheme,
} from '../../shared/settings-types';
import {
  contrastRatio,
  hexToOklch,
  maxChromaAt,
  NON_TEXT_CONTRAST_FLOOR,
  oklchToHex,
  relativeLuminance,
} from './palette-gen';
import { TERMINAL_THEMES } from './terminal-theme';
import { PALETTES } from './ui-theme';

/**
 * Best-effort import of a VS Code color theme (`*-color-theme.json`).
 *
 * VS Code themes describe editor chrome, not an app palette: they carry a few
 * hundred workbench keys, leave most of them unset, and freely use 8-digit
 * hex with alpha for overlays. The conversion starts from the editor
 * background, layers usable workbench colors on top and derives the rest.
 * Foregrounds must remain readable on every Nexus surface they land on.
 */

type VsCodeRgba = { r: number; g: number; b: number; a: number };
type VsCodeRgb = { r: number; g: number; b: number };

/** WCAG AA para texto pequeno: --text*, --accent (rótulos) e --danger. */
const TEXT_CONTRAST_FLOOR = 4.5;
/** Separação mínima de borda/acento candidato contra a superfície (upstream). */
const SEPARATION_FLOOR = 1.1;
/** Luminância em que branco e preto empatam em contraste. */
const DARK_LUMINANCE_THRESHOLD = 0.179;
/** Tema do VS Code com tokenColors costuma ter 50–500 KB. */
export const MAX_VSCODE_THEME_CHARS = 2_000_000;

/**
 * CTA primário neutro (DESIGN.md §2: "a ação primária é a coisa mais clara da
 * tela, o acento fica para ESTADO"). Nunca deriva de `button.background` nem do
 * acento importado — são os valores de Nexus Dark / Nexus Light.
 */
const NEUTRAL_CTA = {
  dark: {
    btnPrimary: PALETTES['nexus-dark'].btnPrimary,
    btnPrimaryInk: PALETTES['nexus-dark'].btnPrimaryInk,
    btnPrimaryHover: PALETTES['nexus-dark'].btnPrimaryHover,
  },
  light: {
    btnPrimary: PALETTES['nexus-light'].btnPrimary,
    btnPrimaryInk: PALETTES['nexus-light'].btnPrimaryInk,
    btnPrimaryHover: PALETTES['nexus-light'].btnPrimaryHover,
  },
} as const;

/** Paleta embutida que preenche o que o arquivo não define. */
const FALLBACK_PALETTE = {
  dark: PALETTES['nexus-pink-city'],
  light: PALETTES['nexus-light'],
} as const;

/** As 16 cores ANSI: tudo depois de fundo, texto, cursor e seleção. */
const ANSI_KEYS = IMPORTED_TERMINAL_KEYS.filter(
  (key) =>
    key !== 'background' &&
    key !== 'foreground' &&
    key !== 'cursor' &&
    key !== 'cursorAccent' &&
    key !== 'selectionBackground',
);

const ACCENT_KEYS = [
  'focusBorder',
  'button.background',
  'textLink.foreground',
  'activityBarBadge.background',
  'progressBar.background',
  'badge.background',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** sRGB transfer function, and its inverse, shared by the wide-gamut path. */
function decodeGamma(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function encodeGamma(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/**
 * `color(display-p3 r g b / a)` shows up in themes authored for wide-gamut
 * displays. Out-of-gamut colors clip to the sRGB edge, which is what a browser
 * on an sRGB screen shows anyway.
 */
function parseColorFunction(value: string): VsCodeRgba | null {
  const match = /^color\(\s*(display-p3|srgb)\s+([^)]+)\)$/i.exec(value);
  if (!match) return null;
  const [space, body] = [match[1]!.toLowerCase(), match[2]!];
  const [channelPart, alphaPart] = body.split('/');
  const channels = channelPart!
    .trim()
    .split(/\s+/)
    .map((part) =>
      part.endsWith('%') ? Number.parseFloat(part) / 100 : Number.parseFloat(part),
    );
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel)))
    return null;
  const alphaRaw = alphaPart?.trim();
  const alpha =
    alphaRaw === undefined
      ? 1
      : alphaRaw.endsWith('%')
        ? Number.parseFloat(alphaRaw) / 100
        : Number.parseFloat(alphaRaw);
  if (!Number.isFinite(alpha)) return null;

  const [red, green, blue] = channels as [number, number, number];
  if (space === 'srgb') {
    return {
      r: red * 255,
      g: green * 255,
      b: blue * 255,
      a: Math.max(0, Math.min(1, alpha)),
    };
  }
  const [linearRed, linearGreen, linearBlue] = [red, green, blue].map(
    decodeGamma,
  ) as [number, number, number];
  // Display P3 linear -> sRGB linear.
  const srgb = [
    1.2249401762805 * linearRed - 0.2249401762805 * linearGreen,
    -0.042056961239 * linearRed + 1.042056961239 * linearGreen,
    -0.0196375547643 * linearRed -
      0.0786360655012 * linearGreen +
      1.0982736202656 * linearBlue,
  ].map((channel) => encodeGamma(channel) * 255) as [number, number, number];
  return { r: srgb[0], g: srgb[1], b: srgb[2], a: Math.max(0, Math.min(1, alpha)) };
}

/** VS Code accepts #RGB, #RGBA, #RRGGBB, and #RRGGBBAA; some themes also use
 *  CSS color() notation for wide-gamut palettes. Anything else is refused. */
export function parseVsCodeColor(value: unknown): VsCodeRgba | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('color(')) return parseColorFunction(trimmed);
  const hex = trimmed.replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const expand = (part: string) =>
    part.length === 1 ? Number.parseInt(part + part, 16) : Number.parseInt(part, 16);
  if (hex.length <= 4) {
    return {
      r: expand(hex[0]!),
      g: expand(hex[1]!),
      b: expand(hex[2]!),
      a: hex.length === 4 ? expand(hex[3]!) / 255 : 1,
    };
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

function toHex(color: VsCodeRgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function rgbOf(hex: string): VsCodeRgb {
  return parseVsCodeColor(hex) ?? { r: 0, g: 0, b: 0 };
}

/** Overlays are semi-transparent in VS Code; our roles are opaque, so they are
 *  composited onto whatever surface they sit on. */
export function flattenOver(color: VsCodeRgba, base: VsCodeRgb): string {
  if (color.a >= 1) return toHex(color);
  return toHex({
    r: color.r * color.a + base.r * (1 - color.a),
    g: color.g * color.a + base.g * (1 - color.a),
    b: color.b * color.a + base.b * (1 - color.a),
  });
}

/** `color-mix(in srgb, from, to amount)` em hex. */
function mix(from: string, to: string, amount: number): string {
  return flattenOver({ ...rgbOf(to), a: amount }, rgbOf(from));
}

function isDark(hex: string): boolean {
  return relativeLuminance(hex) < DARK_LUMINANCE_THRESHOLD;
}

function clearsOn(color: string, surfaces: readonly string[], floor: number): boolean {
  return surfaces.every((surface) => contrastRatio(color, surface) >= floor);
}

/**
 * Nexus: em vez de trocar uma cor ilegível por branco/preto, anda a
 * luminosidade OKLCH para longe das superfícies até passar o piso em todas,
 * mantendo matiz (e o croma que o gamut permitir). Só o extremo da escala de
 * cinza sobra quando nem isso basta.
 */
function ensureContrast(
  color: string,
  surfaces: readonly string[],
  floor: number,
): string {
  if (clearsOn(color, surfaces, floor)) return color;
  const lighten = isDark(surfaces[0]!);
  const start = hexToOklch(color);
  for (let step = 1; step <= 50; step += 1) {
    const l = start.l + (lighten ? step : -step) * 0.02;
    if (l < 0 || l > 1) break;
    const candidate = oklchToHex({
      l,
      c: Math.min(start.c, maxChromaAt(l, start.h)),
      h: start.h,
    });
    if (clearsOn(candidate, surfaces, floor)) return candidate;
  }
  return lighten ? '#ffffff' : '#000000';
}

/**
 * A VS Code theme is recognised by its workbench colors: the keys are dotted
 * paths (`editor.background`).
 */
export function isVsCodeThemeFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hasWorkbenchColors =
    isRecord(value.colors) && Object.keys(value.colors).some((key) => key.includes('.'));
  return hasWorkbenchColors || Array.isArray(value.tokenColors);
}

/** Extension `name` fields are often package slugs; read them as words. */
export function humanizeThemeName(raw: string): string {
  const trimmed = raw.trim();
  if (/\s/.test(trimmed) || !/[-_.]/.test(trimmed)) return trimmed;
  return trimmed
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function resolveName(value: Record<string, unknown>): string {
  // Judge candidates by their humanized form: a displayName of "---"
  // humanizes to nothing and must fall through to the name.
  for (const candidate of [value.displayName, value.name]) {
    if (typeof candidate !== 'string') continue;
    const humanized = humanizeThemeName(candidate);
    if (humanized.length > 0) return humanized.slice(0, 48);
  }
  return 'Tema do VS Code';
}

/**
 * Id estável a partir do nome: reimportar o mesmo tema substitui o anterior.
 * Nexus: nome sem nenhum caractere [a-z0-9] (ex.: só cirílico) vira hash do
 * próprio nome, para dois temas assim não colidirem num id genérico.
 */
export function importedThemeIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  if (slug) return `vscode-${slug}`;
  let hash = 5381;
  for (const char of name) hash = ((hash * 33) ^ char.codePointAt(0)!) >>> 0;
  return `vscode-${hash.toString(36)}`;
}

export function parseVsCodeThemeFile(value: unknown): ImportedTheme {
  if (!isRecord(value)) throw new Error('O arquivo de tema precisa conter um objeto JSON.');
  const colors = isRecord(value.colors) ? value.colors : {};

  /** First key that carries a usable color, in priority order. */
  const pick = (...keys: ReadonlyArray<string>): VsCodeRgba | null => {
    for (const key of keys) {
      const parsed = parseVsCodeColor(colors[key]);
      if (parsed) return parsed;
    }
    return null;
  };
  const solidOver = (base: string, ...keys: ReadonlyArray<string>): string | null => {
    const parsed = pick(...keys);
    return parsed ? flattenOver(parsed, rgbOf(base)) : null;
  };

  const canvasColor = pick('editor.background', 'editorPane.background');
  if (!canvasColor) {
    throw new Error(
      'Esse tema do VS Code não tem a cor "editor.background", então não há base para montar a paleta.',
    );
  }
  const bg = toHex(canvasColor);
  // Nexus: a aparência segue o fundo real, não o `type` declarado — é ela que
  // escolhe a rampa de superfícies, os sinais e o CTA neutro.
  const appearance = isDark(bg) ? 'dark' : 'light';
  const fallback = FALLBACK_PALETTE[appearance];

  /** Superfície do arquivo só entra se ficar do mesmo lado claro/escuro do
   *  fundo: o mesmo texto precisa ser legível nas três. */
  const surfaceOr = (derived: string, ...keys: ReadonlyArray<string>): string => {
    const specified = solidOver(bg, ...keys);
    return specified && isDark(specified) === isDark(bg) ? specified : derived;
  };
  const bgElevated = surfaceOr(
    appearance === 'dark' ? mix(bg, '#ffffff', 0.04) : mix(bg, '#ffffff', 0.7),
    'editorWidget.background',
    'dropdown.background',
    'menu.background',
  );
  const bgBar = surfaceOr(
    appearance === 'dark' ? mix(bg, '#ffffff', 0.02) : mix(bg, '#000000', 0.04),
    'titleBar.activeBackground',
    'sideBar.background',
    'activityBar.background',
  );
  const surfaces = [bg, bgElevated, bgBar];

  /** Foregrounds only win when they stay readable on the surfaces they land
   *  on; a theme tuned for its own chrome can be unreadable on ours. */
  const readableOn = (
    on: readonly string[],
    derived: string,
    ...keys: ReadonlyArray<string>
  ): string => {
    const specified = solidOver(on[0]!, ...keys);
    if (specified && clearsOn(specified, on, TEXT_CONTRAST_FLOOR)) return specified;
    return ensureContrast(derived, on, TEXT_CONTRAST_FLOOR);
  };
  /** Borda do arquivo só entra se não sumir no fundo. */
  const separatedOr = (derived: string, ...keys: ReadonlyArray<string>): string => {
    const specified = solidOver(bg, ...keys);
    return specified && contrastRatio(specified, bg) >= SEPARATION_FLOOR
      ? specified
      : derived;
  };

  const text = readableOn(surfaces, fallback.text, 'editor.foreground', 'foreground');
  const textDim = readableOn(surfaces, mix(text, bg, 0.3), 'descriptionForeground');
  const textFaint = readableOn(surfaces, mix(text, bg, 0.42), 'disabledForeground');

  // Candidates that are visibly not the surface (a transparent focusBorder
  // flattens onto the canvas and is skipped); the first one that is already
  // readable wins, otherwise the first one's hue is walked until it is.
  const accentCandidates = ACCENT_KEYS.flatMap((key) => {
    const parsed = parseVsCodeColor(colors[key]);
    return parsed ? [flattenOver(parsed, rgbOf(bg))] : [];
  }).filter((hex) => clearsOn(hex, surfaces, SEPARATION_FLOOR));
  const accent =
    accentCandidates.find((hex) => clearsOn(hex, surfaces, TEXT_CONTRAST_FLOOR)) ??
    ensureContrast(accentCandidates[0] ?? fallback.accent, surfaces, TEXT_CONTRAST_FLOOR);
  const accentInk = ensureContrast(bg, [accent], TEXT_CONTRAST_FLOOR);

  const terminalBackground = solidOver(bg, 'terminal.background', 'panel.background') ?? bg;
  const terminalBase =
    TERMINAL_THEMES[isDark(terminalBackground) ? 'nexus-pink-city' : 'nexus-light'].theme;
  const cursorCandidate = solidOver(
    terminalBackground,
    'terminalCursor.foreground',
    'editorCursor.foreground',
  );
  // `terminal.ansiBrightBlue` etc.; o que faltar vem da paleta embutida do
  // mesmo lado claro/escuro do fundo do terminal.
  const ansi = Object.fromEntries(
    ANSI_KEYS.map((key) => [
      key,
      solidOver(
        terminalBackground,
        `terminal.ansi${key.charAt(0).toUpperCase()}${key.slice(1)}`,
      ) ?? (terminalBase[key] as string),
    ]),
  ) as Record<(typeof ANSI_KEYS)[number], string>;

  const label = resolveName(value);
  const theme: ImportedTheme = {
    id: importedThemeIdFromName(label),
    label,
    appearance,
    ui: {
      bg,
      bgElevated,
      bgBar,
      border: separatedOr(
        mix(bg, text, 0.12),
        'panel.border',
        'editorGroup.border',
        'sideBar.border',
      ),
      borderStrong: separatedOr(
        mix(bg, text, 0.22),
        'input.border',
        'dropdown.border',
        'contrastBorder',
      ),
      text,
      textDim,
      textFaint,
      accent,
      accentInk,
      ...NEUTRAL_CTA[appearance],
      danger: readableOn(
        surfaces,
        fallback.danger,
        'editorError.foreground',
        'errorForeground',
      ),
    },
    terminal: {
      ...ansi,
      background: terminalBackground,
      foreground: readableOn([terminalBackground], text, 'terminal.foreground'),
      cursor: ensureContrast(
        cursorCandidate ?? accent,
        [terminalBackground],
        NON_TEXT_CONTRAST_FLOOR,
      ),
      cursorAccent: solidOver(terminalBackground, 'terminalCursor.background') ?? terminalBackground,
      selectionBackground:
        solidOver(terminalBackground, 'terminal.selectionBackground', 'editor.selectionBackground') ??
        mix(terminalBackground, accent, 0.3),
    },
  };
  // Mesma validação da leitura do settings.json: só hex sai daqui.
  return importedThemeSchema.parse(theme);
}

/** Texto do arquivo (JSON ou JSONC, como o VS Code grava) → tema importado. */
export function parseVsCodeThemeText(text: string): ImportedTheme {
  if (text.length > MAX_VSCODE_THEME_CHARS) {
    throw new Error('Arquivo grande demais para um tema de cores (máximo de 2 MB).');
  }
  let value: unknown;
  try {
    value = parseJsonc(text);
  } catch {
    throw new Error('O arquivo não é um JSON válido.');
  }
  if (!isVsCodeThemeFile(value)) {
    throw new Error(
      'Isso não parece um tema de cores do VS Code: faltam as cores do workbench ("colors").',
    );
  }
  return parseVsCodeThemeFile(value);
}

/** Reimportar o mesmo tema (mesmo id) substitui no lugar; novo entra no fim. */
export function upsertImportedTheme(
  themes: readonly ImportedTheme[],
  theme: ImportedTheme,
): ImportedTheme[] {
  if (themes.some((entry) => entry.id === theme.id)) {
    return themes.map((entry) => (entry.id === theme.id ? theme : entry));
  }
  if (themes.length >= MAX_IMPORTED_THEMES) {
    throw new Error(
      `Limite de ${MAX_IMPORTED_THEMES} temas importados. Remova um antes de importar outro.`,
    );
  }
  return [...themes, theme];
}
