import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import type { PaneModel } from '../../shared/types';
import type { TerminalSettings } from '../../shared/settings-types';
import { DEFAULT_TERMINAL_SETTINGS } from '../../shared/settings-types';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { getActiveWorkspacePath } from '../state/active-workspace';
import { TERMINAL_THEMES } from '../styles/terminal-theme';

/**
 * Persistent terminal manager.
 *
 * Each pane gets ONE long-lived xterm instance + PTY, keyed by pane id and kept
 * in this module-level map. The layout tree only renders empty slots; on every
 * (re)mount a pane's React wrapper re-parents the SAME DOM node into its slot.
 * Because the terminal element is never recreated, splitting or closing panes
 * reshapes the grid without resetting any shell — the terminal survives the
 * DOM move. Disposal happens only via `reconcileHosts` when a pane truly
 * leaves the tree.
 */

interface Host {
  element: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
  ro: ResizeObserver;
  sessionId: string | null;
  opened: boolean;
  spawnStarted: boolean;
  disposed: boolean;
  cleanups: Array<() => void>;
}

const hosts = new Map<string, Host>();

const DEFAULT_FONT_STACK =
  'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Monaco, monospace';

// Live user settings (theme/font/shell) pushed in by the settings controller.
// New terminals read them at build time; applyTerminalSettings restyles the
// already-open ones.
let currentSettings: TerminalSettings = DEFAULT_TERMINAL_SETTINGS;

function fontFamilyOf(settings: TerminalSettings): string {
  return settings.fontFamily.trim() !== ''
    ? settings.fontFamily
    : DEFAULT_FONT_STACK;
}

function themeOf(settings: TerminalSettings) {
  return (TERMINAL_THEMES[settings.themeId] ?? TERMINAL_THEMES['nexus-dark'])
    .theme;
}

/** Apply user settings: restyle every live terminal, remember for new ones. */
export function applyTerminalSettings(settings: TerminalSettings): void {
  currentSettings = settings;
  for (const host of hosts.values()) {
    if (host.disposed) continue;
    host.term.options.theme = themeOf(settings);
    host.term.options.fontFamily = fontFamilyOf(settings);
    host.term.options.fontSize = settings.fontSize;
    try {
      // Force an immediate repaint — the WebGL renderer can otherwise defer
      // recoloring until the next data write.
      host.term.refresh(0, Math.max(0, host.term.rows - 1));
    } catch {
      // Terminal not opened yet.
    }
    try {
      host.fit.fit();
      if (host.sessionId) {
        window.nexus.pty.resize(host.sessionId, host.term.cols, host.term.rows);
      }
    } catch {
      // Not measurable yet — the ResizeObserver will settle it.
    }
  }
}

function buildTerminal(): {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
} {
  const term = new Terminal({
    fontFamily: fontFamilyOf(currentSettings),
    fontSize: currentSettings.fontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: true,
    theme: themeOf(currentSettings),
    scrollback: 10_000,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  const serialize = new SerializeAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(serialize);
  return { term, fit, search, serialize };
}

function startSpawn(pane: PaneModel, host: Host, resume = false): void {
  host.spawnStarted = true;
  void (async () => {
    try {
      const res = await window.nexus.pty.spawn({
        // Panes always live inside the active workspace: restored panes from
        // older sessions (or the fresh initial tree) may lack a cwd — they
        // must open in the workspace folder, never the user's home.
        cwd: pane.cwd ?? getActiveWorkspacePath() ?? undefined,
        shell:
          pane.kind === 'shell' && currentSettings.shell !== ''
            ? currentSettings.shell
            : undefined,
        cols: host.term.cols,
        rows: host.term.rows,
        kind: pane.kind,
        resume,
        adapterId: pane.adapterId,
        model: pane.model,
        orchRequestId: pane.orchRequestId,
      });
      if (host.disposed) {
        if (res.ok) window.nexus.pty.kill(res.sessionId);
        return;
      }
      if (!res.ok) {
        host.term.writeln(
          `\r\n\x1b[31m[nexus] failed to start: ${res.error}\x1b[0m`,
        );
        if (pane.kind === 'cli-agent') {
          useSessionStateStore.getState().clearPaneState(pane.id);
        }
        return;
      }
      host.sessionId = res.sessionId;

      if (pane.kind === 'cli-agent') {
        host.cleanups.push(
          window.nexus.pty.onStateChange(res.sessionId, (state) => {
            useSessionStateStore.getState().setPaneState(pane.id, state);
          }),
        );
      }

      host.cleanups.push(
        window.nexus.pty.onData(res.sessionId, (data) => host.term.write(data)),
      );
      host.cleanups.push(
        window.nexus.pty.onExit(res.sessionId, ({ exitCode }) => {
          host.term.writeln(
            `\r\n\x1b[90m[nexus] process exited (code ${exitCode})\x1b[0m`,
          );
          if (pane.kind === 'cli-agent') {
            useSessionStateStore.getState().clearPaneState(pane.id);
          }
        }),
      );
      const input = host.term.onData((data) => {
        if (host.sessionId) window.nexus.pty.write(host.sessionId, data);
      });
      host.cleanups.push(() => input.dispose());
    } catch (err) {
      if (host.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      host.term.writeln(
        `\r\n\x1b[31m[nexus] failed to start: ${message}\x1b[0m`,
      );
      if (pane.kind === 'cli-agent') {
        useSessionStateStore.getState().clearPaneState(pane.id);
      }
    }
  })();
}

/**
 * Debounced fit-on-resize. An interactive node resize (or a canvas pan that
 * re-parents the terminal) fires the ResizeObserver in a tight burst; calling
 * fit()+pty.resize on each frame floods the child with SIGWINCH and thrashes
 * the renderer (the resize storm Maestri hit). Coalesce to one fit ~60ms after
 * the last resize.
 */
const RESIZE_DEBOUNCE_MS = 60;

function makeResizeObserver(host: Host): ResizeObserver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return new ResizeObserver(() => {
    if (host.disposed || !host.opened) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (host.disposed || !host.opened) return;
      try {
        host.fit.fit();
      } catch {
        return;
      }
      if (host.sessionId) {
        window.nexus.pty.resize(host.sessionId, host.term.cols, host.term.rows);
      }
    }, RESIZE_DEBOUNCE_MS);
  });
}

function createShellHost(pane: PaneModel): Host {
  const element = document.createElement('div');
  element.className = 'term-host';

  const { term, fit, search, serialize } = buildTerminal();

  const host: Host = {
    element,
    term,
    fit,
    search,
    serialize,
    ro: null as unknown as ResizeObserver,
    sessionId: null,
    opened: false,
    spawnStarted: false,
    disposed: false,
    cleanups: [],
  };

  host.ro = makeResizeObserver(host);
  host.ro.observe(element);

  term.onTitleChange((title) =>
    useLayoutStore.getState().setTitle(pane.id, title),
  );
  element.addEventListener('mousedown', () =>
    useLayoutStore.getState().focus(pane.id),
  );
  wireInteractions(host);
  return host;
}

/** Build a cli-agent host. The backing terminal is the same as a shell host but
 *  the spawn request routes through the adapter registry in the main process. */
function createCliAgentHost(pane: PaneModel): Host {
  const element = document.createElement('div');
  element.className = 'term-host term-host--agent';

  const { term, fit, search, serialize } = buildTerminal();

  const host: Host = {
    element,
    term,
    fit,
    search,
    serialize,
    ro: null as unknown as ResizeObserver,
    sessionId: null,
    opened: false,
    spawnStarted: false,
    disposed: false,
    cleanups: [],
  };

  host.ro = makeResizeObserver(host);
  host.ro.observe(element);

  term.onTitleChange((title) =>
    useLayoutStore.getState().setTitle(pane.id, title),
  );
  element.addEventListener('mousedown', () =>
    useLayoutStore.getState().focus(pane.id),
  );
  wireInteractions(host);

  useSessionStateStore.getState().setPaneState(pane.id, 'spawning');
  return host;
}

/** Shell-quote a path only if it contains characters that need it. */
function shellQuote(p: string): string {
  return /[\s'"\\$`(){}[\]!*?&;|<>]/.test(p) ? `'${p.replace(/'/g, "'\\''")}'` : p;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Save a pasted/dropped binary blob into ~/.nexus/dropped, inject its path. */
async function injectSavedBlob(host: Host, file: File): Promise<void> {
  try {
    const base64 = bufferToBase64(await file.arrayBuffer());
    const res = await window.nexus.files.saveDropped(file.name || 'pasted', base64);
    if (res.ok && res.path && host.sessionId) {
      window.nexus.pty.write(host.sessionId, `${shellQuote(res.path)} `);
    }
  } catch {
    // Ignore — a failed drop should never break the terminal.
  }
}

/**
 * Make a terminal fully operable: copy the selection (⌘/Ctrl+C when text is
 * selected), paste text (native xterm) or an image (saved to disk, path
 * injected), and accept drag-and-dropped files (real path injected as if
 * typed). Nothing here can break the terminal — every branch is guarded.
 */
function wireInteractions(host: Host): void {
  const { element, term } = host;

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'c' && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      return false; // handled — don't send ^C to the pty
    }
    return true;
  });

  element.addEventListener(
    'paste',
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          e.preventDefault();
          const file = items[i].getAsFile();
          if (file) void injectSavedBlob(host, file);
          return;
        }
      }
      // Plain text → let xterm's native paste handle it.
    },
    true,
  );

  element.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  element.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const p = window.nexus.files.pathForFile(files[i]);
      if (p) paths.push(p);
    }
    if (paths.length > 0 && host.sessionId) {
      window.nexus.pty.write(
        host.sessionId,
        paths.map(shellQuote).join(' ') + ' ',
      );
    } else {
      // No real path (e.g. an image dragged from a browser) → save + inject.
      for (let i = 0; i < files.length; i++) void injectSavedBlob(host, files[i]);
    }
  });
}

/**
 * Build the backing host for a pane, dispatched on its session kind.
 */
function createHostForKind(pane: PaneModel): Host {
  switch (pane.kind) {
    case 'cli-agent':
      return createCliAgentHost(pane);
    case 'shell':
    default:
      return createShellHost(pane);
  }
}

export function getOrCreateHost(pane: PaneModel): Host {
  const existing = hosts.get(pane.id);
  if (existing) return existing;
  const host = createHostForKind(pane);
  hosts.set(pane.id, host);
  return host;
}

/**
 * Move a pane's terminal into `slot`, opening + spawning on first attach.
 * Idempotent: re-parenting the same node is a no-op move for xterm.
 */
export function attachHost(pane: PaneModel, slot: HTMLElement): void {
  const host = getOrCreateHost(pane);
  slot.appendChild(host.element);

  if (!host.opened) {
    host.term.open(host.element);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      host.term.loadAddon(webgl);
    } catch {
      // Canvas/DOM renderer fallback.
    }
    host.opened = true;
  }

  try {
    host.fit.fit();
  } catch {
    // Slot not measurable yet; the ResizeObserver will retry.
  }

  if (!host.spawnStarted) startSpawn(pane, host);
}

export function focusHost(paneId: string): void {
  hosts.get(paneId)?.term.focus();
}

/**
 * Failover re-spawn: kill the pane's current CLI session and start a fresh one
 * with --resume in the SAME xterm, so the conversation continues on the newly
 * activated account. The old output stays as scrollback.
 */
export function respawnWithResume(pane: PaneModel): void {
  const host = hosts.get(pane.id);
  if (!host || host.disposed) return;
  host.cleanups.forEach((fn) => fn());
  host.cleanups = [];
  if (host.sessionId) window.nexus.pty.kill(host.sessionId);
  host.sessionId = null;
  host.spawnStarted = false;
  host.term.writeln(
    '\r\n\x1b[33m[nexus] limite atingido — trocando de conta e retomando…\x1b[0m',
  );
  startSpawn(pane, host, true);
}

/** The live PTY session id backing a pane, or null if not spawned yet. */
export function getPaneSessionId(paneId: string): string | null {
  return hosts.get(paneId)?.sessionId ?? null;
}

/**
 * Write text into a pane's PTY as if the user typed it — the exact same path as
 * keyboard input. Used by voice routing to inject the transcribed prompt into
 * the focused pane. Returns false when the pane has no live session.
 */
export function writeToPane(paneId: string, data: string): boolean {
  const sessionId = getPaneSessionId(paneId);
  if (!sessionId) return false;
  window.nexus.pty.write(sessionId, data);
  return true;
}

function disposeHost(host: Host, paneId: string): void {
  host.disposed = true;
  host.ro.disconnect();
  host.cleanups.forEach((fn) => fn());
  if (host.sessionId) window.nexus.pty.kill(host.sessionId);
  host.term.dispose();
  host.element.remove();
  useSessionStateStore.getState().clearPaneState(paneId);
}

/** Dispose every terminal whose pane id is no longer present in the layout. */
export function reconcileHosts(liveIds: Set<string>): void {
  for (const [id, host] of hosts) {
    if (!liveIds.has(id)) {
      disposeHost(host, id);
      hosts.delete(id);
    }
  }
}
