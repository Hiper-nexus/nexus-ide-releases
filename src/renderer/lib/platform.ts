/**
 * Platform helpers for cross-OS UI (mac / windows / linux).
 *
 * Problem this encodes: shortcut labels were hardcoded as ⌘ across the
 * renderer (50+ spots), which reads wrong on Windows/Linux. This is the
 * single source for "which modifier glyph do we show" — new UI must use
 * modKey()/formatShortcut() instead of literal ⌘.
 */

export type UiPlatform = 'mac' | 'windows' | 'linux';

export function uiPlatform(): UiPlatform {
  const p =
    typeof window === 'undefined' ? undefined : window.nexus?.platform;
  if (p === 'darwin') return 'mac';
  if (p === 'win32') return 'windows';
  return 'linux';
}

/**
 * F-673: sem `windowsPty` o xterm trata o PTY como Unix — ao ganhar linhas,
 * puxa o histórico de volta para a tela, enquanto o ConPTY do Windows cria
 * linhas vazias e repinta por cima: telas antigas misturadas às novas nos
 * panes (TUIs como o Claude Code). Informar backend e build liga as
 * heurísticas de ConPTY do próprio xterm.
 */
export function xtermWindowsPty(): { backend: 'conpty'; buildNumber?: number } | undefined {
  if (typeof window === 'undefined' || window.nexus?.platform !== 'win32') return undefined;
  const build = window.nexus?.windowsBuild;
  return typeof build === 'number' && build > 0
    ? { backend: 'conpty', buildNumber: build }
    : { backend: 'conpty' };
}

export function isMac(): boolean {
  return uiPlatform() === 'mac';
}

/** Primary accelerator: ⌘ on mac, Ctrl elsewhere. */
export function modKey(): string {
  return isMac() ? '⌘' : 'Ctrl';
}

/**
 * Render a shortcut chord for the current platform.
 * Tokens: `mod` (⌘/Ctrl), `shift` (⇧/Shift), `alt` (⌥/Alt), `ctrl`, or a
 * literal key. Modifiers are always emitted in canonical order
 * (⌃⌥⇧⌘ / Ctrl+Alt+Shift+…) regardless of the order passed in — callers
 * should not depend on it. macOS joins glyphs ("⇧⌘K"); other OSes join
 * with "+" ("Ctrl+Shift+K").
 */
const MOD_RANK_MAC = { ctrl: 0, alt: 1, shift: 2, mod: 3 } as const;
// Windows/Linux: Ctrl lidera (Ctrl+Shift+…); 'mod' e 'ctrl' viram o mesmo
// "Ctrl", então dividem o rank 0.
const MOD_RANK_OTHER = { mod: 0, ctrl: 0, alt: 1, shift: 2 } as const;

export function formatShortcut(...tokens: string[]): string {
  const mac = isMac();
  const rank: Record<string, number> = mac ? MOD_RANK_MAC : MOD_RANK_OTHER;
  const normalized = tokens.map((t) => {
    const k = t.toLowerCase();
    if (k === 'cmd' || k === 'meta') return 'mod';
    if (k === 'option') return 'alt';
    if (k === 'control') return 'ctrl';
    if (k === 'return') return 'enter';
    if (k === 'escape') return 'esc';
    return k;
  });
  const mods = normalized
    .filter((t) => t in rank)
    .sort((a, b) => rank[a] - rank[b]);
  const key = normalized.find((t) => !(t in rank));
  const parts: string[] = mods.map((m) => {
    if (m === 'mod') return mac ? '⌘' : 'Ctrl';
    if (m === 'shift') return mac ? '⇧' : 'Shift';
    if (m === 'alt') return mac ? '⌥' : 'Alt';
    return mac ? '⌃' : 'Ctrl';
  });
  if (key !== undefined) {
    const keyLabel =
      key === 'enter'
        ? mac
          ? '↵'
          : 'Enter'
        : key === 'backspace'
          ? mac
            ? '⌫'
            : 'Backspace'
          : key === 'delete'
            ? mac
              ? '⌦'
              : 'Del'
            : key === 'esc'
              ? 'Esc'
              : key.length === 1
                ? key.toUpperCase()
                : key;
    parts.push(keyLabel);
  }
  return mac ? parts.join('') : parts.join('+');
}
