import { detectDevServerUrls } from './dev-server-detect';

/**
 * Dev-server registry (VISUAL-EDIT-001, F1.5): passively scans PTY output for
 * the URLs dev servers announce and keeps a paneId/sessionId → url map so the
 * IDE can offer "abrir no browser pane". Pure logic over injected deps — the
 * pane-registry wires the real taps and the renderer push.
 */

export interface DevServerEntry {
  /** Null until the pane mirror has synced this session's pane. */
  paneId: string | null;
  sessionId: string;
  /** All local URLs announced by the session (first one wins as primary). */
  urls: string[];
  /** Primary URL — the first announced (usually the "Local:" one). */
  url: string;
  detectedAt: number;
}

export interface DevServerScannerDeps {
  paneIdOf(sessionId: string): string | null;
  emit(entry: DevServerEntry): void;
  now?(): number;
}

export interface DevServerScanner {
  onData(sessionId: string, chunk: string): void;
  onExit(sessionId: string): void;
  get(paneOrSessionRef: string): DevServerEntry | null;
  reset(): void;
}

/** Longest URL prefix that can be cut at a chunk boundary. */
const TAIL_CARRY_CHARS = 300;
const MAX_URLS_PER_SESSION = 4;

interface SessionScanState {
  entry: DevServerEntry;
  tail: string;
  announcedPane: boolean;
}

export function createDevServerScanner(
  deps: DevServerScannerDeps,
): DevServerScanner {
  const sessions = new Map<string, SessionScanState>();
  const now = deps.now ?? Date.now;

  function announce(state: SessionScanState): void {
    state.entry.paneId = deps.paneIdOf(state.entry.sessionId);
    state.announcedPane = state.entry.paneId !== null;
    deps.emit({ ...state.entry, urls: [...state.entry.urls] });
  }

  return {
    onData(sessionId, chunk) {
      let state = sessions.get(sessionId);
      if (!state) {
        state = {
          entry: { paneId: null, sessionId, urls: [], url: '', detectedAt: 0 },
          tail: '',
          announcedPane: false,
        };
        sessions.set(sessionId, state);
      }
      const scanText = state.tail + chunk;
      const found = detectDevServerUrls(scanText);
      state.tail = scanText.slice(-TAIL_CARRY_CHARS);

      const known = new Set(state.entry.urls);
      const fresh = found.filter((url) => !known.has(url));

      if (fresh.length) {
        for (const url of fresh) {
          if (state.entry.urls.length >= MAX_URLS_PER_SESSION) break;
          state.entry.urls.push(url);
        }
        state.entry.url = state.entry.urls[0];
        state.entry.detectedAt = now();
        announce(state);
        return;
      }
      // No new URL, but the pane mirror may have caught up: re-announce once
      // so the UI can attach the chip to the (now known) pane.
      if (!state.announcedPane && state.entry.urls.length) {
        const paneId = deps.paneIdOf(sessionId);
        if (paneId) announce(state);
      }
    },

    onExit(sessionId) {
      sessions.delete(sessionId);
    },

    get(ref) {
      for (const state of sessions.values()) {
        if (
          state.entry.sessionId === ref ||
          (state.entry.paneId ?? deps.paneIdOf(state.entry.sessionId)) === ref
        ) {
          if (!state.entry.urls.length) return null;
          // Keep the paneId fresh for late-synced panes.
          state.entry.paneId = deps.paneIdOf(state.entry.sessionId);
          return { ...state.entry, urls: [...state.entry.urls] };
        }
      }
      return null;
    },

    reset() {
      sessions.clear();
    },
  };
}
