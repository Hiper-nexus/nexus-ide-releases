import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import type { PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
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
 *
 * This is the extension seam for later phases: a `cli-agent` pane will create
 * its host here the same way a shell does, just with a different backing PTY.
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

function startSpawn(pane: PaneModel, host: Host): void {
  host.spawnStarted = true;
  void (async () => {
    try {
      const res = await window.nexus.pty.spawn({
        cwd: pane.cwd,
        cols: host.term.cols,
        rows: host.term.rows,
        kind: pane.kind,
      });
      if (host.disposed) {
        if (res.ok) window.nexus.pty.kill(res.sessionId);
        return;
      }
      if (!res.ok) {
        host.term.writeln(
          `\r\n\x1b[31m[nexus] failed to start shell: ${res.error}\x1b[0m`,
        );
        return;
      }
      host.sessionId = res.sessionId;
      host.cleanups.push(
        window.nexus.pty.onData(res.sessionId, (data) => host.term.write(data)),
      );
      host.cleanups.push(
        window.nexus.pty.onExit(res.sessionId, ({ exitCode }) =>
          host.term.writeln(
            `\r\n\x1b[90m[nexus] process exited (code ${exitCode})\x1b[0m`,
          ),
        ),
      );
      const input = host.term.onData((data) => {
        if (host.sessionId) window.nexus.pty.write(host.sessionId, data);
      });
      host.cleanups.push(() => input.dispose());
    } catch (err) {
      // A rejected IPC invoke (bridge torn down, main crash) would otherwise be
      // swallowed silently — surface it in the same format as the !res.ok path.
      if (host.disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      host.term.writeln(
        `\r\n\x1b[31m[nexus] failed to start shell: ${message}\x1b[0m`,
      );
    }
  })();
}

function createShellHost(pane: PaneModel): Host {
  const element = document.createElement('div');
  element.className = 'term-host';

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

  // Keep the PTY sized to whatever slot currently holds this terminal.
  host.ro = new ResizeObserver(() => {
    if (host.disposed || !host.opened) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    if (host.sessionId) {
      window.nexus.pty.resize(host.sessionId, term.cols, term.rows);
    }
  });
  host.ro.observe(element);

  // Reflect shell title escape sequences and focus-on-click into the store.
  term.onTitleChange((title) =>
    useLayoutStore.getState().setTitle(pane.id, title),
  );
  element.addEventListener('mousedown', () =>
    useLayoutStore.getState().focus(pane.id),
  );

  return host;
}

/**
 * Build the backing host for a pane, dispatched on its session kind. Today every
 * kind resolves to a shell-backed terminal; phase 2b plugs a dedicated
 * `cli-agent` host in here without touching the grid/attach plumbing.
 */
function createHostForKind(pane: PaneModel): Host {
  switch (pane.kind) {
    case 'shell':
      return createShellHost(pane);
    case 'cli-agent':
      // Extension seam for 2b: a cli-agent adapter will build its own host here.
      // Until then it falls back to a plain shell so the pane still works.
      return createShellHost(pane);
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

function disposeHost(host: Host): void {
  host.disposed = true;
  host.ro.disconnect();
  host.cleanups.forEach((fn) => fn());
  if (host.sessionId) window.nexus.pty.kill(host.sessionId);
  host.term.dispose();
  host.element.remove();
}

/** Dispose every terminal whose pane id is no longer present in the layout. */
export function reconcileHosts(liveIds: Set<string>): void {
  for (const [id, host] of hosts) {
    if (!liveIds.has(id)) {
      disposeHost(host);
      hosts.delete(id);
    }
  }
}
