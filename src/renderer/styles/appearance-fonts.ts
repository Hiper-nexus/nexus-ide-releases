/**
 * Font preferences from Settings → Aparência, applied as CSS custom
 * properties. The default stacks mirror `--font-ui` / `--font-mono` in
 * base.css; a custom family is always prepended to the matching default
 * stack so glyph coverage never regresses.
 */

/** Mirrors `--font-ui` in base.css (Inter + system fallbacks). */
export const DEFAULT_SANS_FONT_STACK =
  "'Inter', ui-sans-serif, -apple-system, \"SF Pro Text\", Segoe UI, system-ui, sans-serif";

/** Mirrors `--font-mono` in base.css (JetBrains Mono + system fallbacks). */
export const DEFAULT_CODE_FONT_STACK =
  "'JetBrains Mono', ui-monospace, \"SF Mono\", Menlo, monospace";

export const DEFAULT_INTERFACE_FONT_SIZE = 13;
export const MIN_INTERFACE_FONT_SIZE = 11;
export const MAX_INTERFACE_FONT_SIZE = 20;

export const DEFAULT_CODE_FONT_SIZE = 13;
export const MIN_CODE_FONT_SIZE = 9;
export const MAX_CODE_FONT_SIZE = 24;

/** Official type ramp (DESIGN.md → base.css). Scaled by the interface size. */
const TYPE_RAMP_TOKENS: ReadonlyArray<readonly [token: string, basePx: number]> = [
  ['--text-2xs', 10],
  ['--text-xs', 11],
  ['--text-sm', 12],
  ['--text-md', 13],
  ['--text-lg', 14],
  ['--text-xl', 16],
  ['--text-2xl', 18],
  ['--text-3xl', 22],
  ['--text-hero', 34],
];

function quoteFontFamilyName(name: string): string {
  const bare = name.trim();
  if (bare.length === 0) return '';
  // Nomes de fonte não carregam `;{}<>` nem controle — esses saem antes de
  // ir para `style.setProperty` (mesmo em custom property, não é entrada
  // de CSS arbitrária).
  const safe = bare.replace(/[\u0000-\u001f\u007f;{}<>]/g, '');
  if (safe.length === 0) return '';
  if (/^(['"]).*\1$/.test(safe)) return safe;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(safe)) return safe;
  return `"${safe.replaceAll('"', '')}"`;
}

/**
 * Normalize a user-entered family (single name or comma-separated list) into
 * a safe CSS font-family list, or null when the input is effectively empty.
 */
export function cssFontFamilies(input: string): string | null {
  const families = input
    .split(',')
    .map(quoteFontFamilyName)
    .filter((name) => name.length > 0);
  return families.length > 0 ? families.join(', ') : null;
}

/** Full stack a preference resolves to: custom families before the default. */
export function appearanceFontStack(custom: string, defaultStack: string): string {
  const families = cssFontFamilies(custom);
  return families === null ? defaultStack : `${families}, ${defaultStack}`;
}

function clampFontSize(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function clampInterfaceFontSize(value: number): number {
  return clampFontSize(
    value,
    MIN_INTERFACE_FONT_SIZE,
    MAX_INTERFACE_FONT_SIZE,
    DEFAULT_INTERFACE_FONT_SIZE,
  );
}

export function clampCodeFontSize(value: number): number {
  return clampFontSize(value, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE, DEFAULT_CODE_FONT_SIZE);
}

export interface AppearanceFontPreferences {
  /** Empty = the default sans stack (and any theme/pixel override). */
  readonly interfaceFamily: string;
  readonly codeFamily: string;
  readonly interfaceSize: number;
  readonly codeSize: number;
}

/**
 * Apply the preferences to the root element. Unset families remove the
 * override so the stylesheet defaults (and pixel mode) stay in charge.
 *
 * Interface size drives the `--text-*` type ramp (px tokens, not rem), so
 * every surface that already follows the scale moves together. Code size
 * stays in absolute pixels on `--font-size-code` so it does not scale twice.
 */
export function applyAppearanceFontVariables(
  root: HTMLElement,
  preferences: AppearanceFontPreferences,
): void {
  const families: ReadonlyArray<readonly [variable: string, custom: string]> = [
    ['--font-ui', preferences.interfaceFamily],
    ['--font-mono', preferences.codeFamily],
  ];
  for (const [variable, custom] of families) {
    const list = cssFontFamilies(custom);
    if (list === null) {
      root.style.removeProperty(variable);
    } else {
      const fallback = variable === '--font-ui' ? DEFAULT_SANS_FONT_STACK : DEFAULT_CODE_FONT_STACK;
      root.style.setProperty(variable, `${list}, ${fallback}`);
    }
  }

  const interfaceSize = clampInterfaceFontSize(preferences.interfaceSize);
  const scale = interfaceSize / DEFAULT_INTERFACE_FONT_SIZE;
  for (const [token, basePx] of TYPE_RAMP_TOKENS) {
    if (scale === 1) root.style.removeProperty(token);
    else root.style.setProperty(token, `${Math.round(basePx * scale)}px`);
  }
  root.style.setProperty('--font-size-interface', `${interfaceSize}px`);

  const code = clampCodeFontSize(preferences.codeSize);
  root.style.setProperty('--font-size-code', `${code}px`);
}

export interface InstalledFontFamiliesResult {
  readonly families: readonly string[];
  /**
   * "unsupported" — engine has no Local Font Access API; "denied" — the API
   * exists but the user declined (or the list came back empty).
   */
  readonly status: 'granted' | 'denied' | 'unsupported';
}

let installedFamiliesCache: InstalledFontFamiliesResult | null = null;

/** Test hook: drop the enumeration cache between cases. */
export function resetInstalledFontFamiliesCache(): void {
  installedFamiliesCache = null;
}

/**
 * Every installed family via the Local Font Access API (Chromium/Electron).
 * Call from a user gesture: the first call may raise the permission prompt.
 * A denial is not cached, so reopening the picker can ask again.
 */
export async function queryInstalledFontFamilies(): Promise<InstalledFontFamiliesResult> {
  if (installedFamiliesCache !== null) return installedFamiliesCache;
  const query = (
    globalThis as {
      queryLocalFonts?: () => Promise<ReadonlyArray<{ readonly family: string }>>;
    }
  ).queryLocalFonts;
  if (typeof query !== 'function') {
    return { families: [], status: 'unsupported' };
  }
  try {
    const fonts = await query.call(globalThis);
    const families = [...new Set(fonts.map((font) => font.family))]
      // Dot-prefixed families are OS-internal UI faces; selecting one is never
      // intended and most refuse to render for web content.
      .filter((family) => !family.startsWith('.'))
      .sort((left, right) => left.localeCompare(right));
    if (families.length === 0) return { families: [], status: 'denied' };
    installedFamiliesCache = { families, status: 'granted' };
    return installedFamiliesCache;
  } catch {
    return { families: [], status: 'denied' };
  }
}

export type FontEnumerationState =
  | { readonly status: 'unknown' }
  | { readonly status: 'granted'; readonly families: readonly string[] }
  | { readonly status: 'unavailable' };

// Shared across every picker row: once one row learns the fonts (or learns
// the permission is blocked), the others follow without re-querying.
let enumerationState: FontEnumerationState =
  typeof (globalThis as { queryLocalFonts?: unknown }).queryLocalFonts === 'function'
    ? { status: 'unknown' }
    : { status: 'unavailable' };
const enumerationListeners = new Set<() => void>();
let enumerationLoad: Promise<void> | null = null;

export function subscribeFontEnumeration(listener: () => void): () => void {
  enumerationListeners.add(listener);
  return () => {
    enumerationListeners.delete(listener);
  };
}

export function readFontEnumeration(): FontEnumerationState {
  return enumerationState;
}

/** Test hook: restore the shared enumeration store. */
export function resetFontEnumeration(): void {
  enumerationState =
    typeof (globalThis as { queryLocalFonts?: unknown }).queryLocalFonts === 'function'
      ? { status: 'unknown' }
      : { status: 'unavailable' };
  enumerationLoad = null;
  resetInstalledFontFamiliesCache();
  for (const listener of [...enumerationListeners]) enumerationListeners.delete(listener);
}

/** Query installed fonts; call from a user gesture (the permission prompt needs one). */
export function discoverInstalledFonts(): void {
  if (enumerationState.status !== 'unknown' || enumerationLoad !== null) return;
  enumerationLoad = queryInstalledFontFamilies()
    .then((result) => {
      enumerationState =
        result.status === 'granted'
          ? { status: 'granted', families: result.families }
          : { status: 'unavailable' };
      for (const listener of enumerationListeners) listener();
    })
    .catch(() => {
      enumerationState = { status: 'unavailable' };
      for (const listener of enumerationListeners) listener();
    })
    .finally(() => {
      enumerationLoad = null;
    });
}
