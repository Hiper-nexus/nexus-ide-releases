import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import type { PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';
import { TERMINAL_THEME } from '../styles/terminal-theme';

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

function buildTerminal(): {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  serialize: SerializeAddon;
} {
  const term = new Terminal({
    fontFamily:
      'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Monaco, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: true,
    theme: TERMINAL_THEME,
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

function startSpawn(pane: PaneModel, host: Host): void {
  host.spawnStarted = true;
  void (async () => {
    try {
      const res = await window.nexus.pty.spawn({
        cwd: pane.cwd,
        cols: host.term.cols,
        rows: host.term.rows,
        kind: pane.kind,
        adapterId: pane.adapterId,
        model: pane.model,
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

  host.ro = new ResizeObserver(() => {
    if (host.disposed || !host.opened) return;
    try { fit.fit(); } catch { return; }
    if (host.sessionId) {
      window.nexus.pty.resize(host.sessionId, term.cols, term.rows);
    }
  });
  host.ro.observe(element);

  term.onTitleChange((title) =>
    useLayoutStore.getState().setTitle(pane.id, title),
  );
  element.addEventListener('mousedown', () =>
    useLayoutStore.getState().focus(pane.id),
  );
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

  host.ro = new ResizeObserver(() => {
    if (host.disposed || !host.opened) return;
    try { fit.fit(); } catch { return; }
    if (host.sessionId) {
      window.nexus.pty.resize(host.sessionId, term.cols, term.rows);
    }
  });
  host.ro.observe(element);

  term.onTitleChange((title) =>
    useLayoutStore.getState().setTitle(pane.id, title),
  );
  element.addEventListener('mousedown', () =>
    useLayoutStore.getState().focus(pane.id),
  );

  useSessionStateStore.getState().setPaneState(pane.id, 'spawning');
  return host;
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
