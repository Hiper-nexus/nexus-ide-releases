import type {
  BrowserDesignElementContext,
  BrowserDesignEvent,
} from '../../shared/browser-design';
import type { ProjectExecutionScope } from '../../shared/types';
import { browserDesignEventSchema } from './browser-design-schema';

/**
 * Per-pane design-mode session state (VISUAL-EDIT-001, Fase 0). Pure logic —
 * no electron imports — so the push-event contract is unit-testable. The
 * browser-manager owns the ipcMain wiring: it resolves the sender WebContents
 * to a paneId and forwards the raw payload here.
 */

interface DesignSessionState {
  generation: string;
  phase: 'enabling' | 'active' | 'disabling' | 'inactive';
  seenEventIds: Set<string>;
  lastSelection: BrowserDesignElementContext | null;
  /** Multi-selection set (F4): shift+click accumulates/toggles, cap 8. */
  selections: BrowserDesignElementContext[];
  modeActive: boolean;
  updatedAt: number;
}

const MAX_SELECTIONS = 8;

export interface DesignIngestResult {
  ok: boolean;
  error?: string;
}

/**
 * Main-owned origin attached after the browser WebContents has been resolved
 * to its host window. It is deliberately absent from the untrusted preload
 * payload and therefore cannot be forged by page JavaScript.
 */
export interface TrustedDesignEventSource {
  owner: Readonly<{ id: number }>;
  scope: ProjectExecutionScope;
}

export type DesignEventListener = (
  paneId: string,
  event: BrowserDesignEvent,
  source?: TrustedDesignEventSource,
) => void;

const sessions = new Map<string, DesignSessionState>();
const listeners = new Set<DesignEventListener>();
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function prepareDesignModeTransition(
  paneId: string,
  generation: string,
  active: boolean,
): void {
  if (!UUID.test(generation)) throw new Error('invalid design generation');
  const current = sessions.get(paneId);
  if (!active && current?.generation === generation) {
    current.phase = 'disabling';
    current.modeActive = false;
    current.lastSelection = null;
    current.selections = [];
    return;
  }
  sessions.set(paneId, {
    generation,
    phase: active ? 'enabling' : 'disabling',
    seenEventIds: new Set(),
    lastSelection: null,
    selections: [],
    modeActive: false,
    updatedAt: 0,
  });
}

export function getDesignGeneration(paneId: string): string | null {
  const state = sessions.get(paneId);
  return state && state.phase !== 'inactive' ? state.generation : null;
}

export function abortDesignModeTransition(
  paneId: string,
  generation: string,
): void {
  if (sessions.get(paneId)?.generation === generation) sessions.delete(paneId);
}

export function ingestDesignEvent(
  paneId: string,
  raw: unknown,
  source?: TrustedDesignEventSource,
): DesignIngestResult {
  const parsed = browserDesignEventSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `invalid design event: ${issue?.message ?? 'malformed'}`.slice(0, 256),
    };
  }
  const event = parsed.data as BrowserDesignEvent;
  const state = sessions.get(paneId);
  if (!state) return { ok: false, error: 'design mode is not armed' };
  if (event.generation !== state.generation) {
    return { ok: false, error: 'stale design generation' };
  }
  if (state.seenEventIds.has(event.eventId)) {
    return { ok: false, error: 'duplicate design event' };
  }
  if (event.type === 'mode' && event.mode) {
    const validEnable = event.mode.active && state.phase === 'enabling';
    const validDisable =
      !event.mode.active &&
      (state.phase === 'active' || state.phase === 'disabling');
    if (!validEnable && !validDisable) {
      return { ok: false, error: 'unexpected design mode transition' };
    }
    state.phase = event.mode.active ? 'active' : 'inactive';
    state.modeActive = event.mode.active;
    if (!event.mode.active) {
      state.lastSelection = null;
      state.selections = [];
    }
  } else if (state.phase !== 'active') {
    return { ok: false, error: 'design mode is not active' };
  }

  state.seenEventIds.add(event.eventId);
  state.updatedAt = event.at;
  if (event.type === 'selection' && event.selection) {
    const selection = event.selection;
    if (selection.additive) {
      const existingIndex = state.selections.findIndex(
        (candidate) => candidate.ref === selection.ref,
      );
      if (existingIndex >= 0) {
        // Shift+click on an already-selected element toggles it off.
        state.selections.splice(existingIndex, 1);
      } else {
        state.selections.push(selection);
        if (state.selections.length > MAX_SELECTIONS) state.selections.shift();
      }
      state.lastSelection = state.selections.at(-1) ?? null;
    } else {
      state.selections = [selection];
      state.lastSelection = selection;
    }
  }
  for (const listener of listeners) {
    try {
      listener(paneId, event, source);
    } catch {
      // A faulty subscriber must never break ingestion or its peers.
    }
  }
  return { ok: true };
}

export function getLastSelection(
  paneId: string,
): BrowserDesignElementContext | null {
  return sessions.get(paneId)?.lastSelection ?? null;
}

/** Current multi-selection set (F4); [] when nothing is selected. */
export function getSelections(paneId: string): BrowserDesignElementContext[] {
  return [...(sessions.get(paneId)?.selections ?? [])];
}

export function isDesignModeActive(paneId: string): boolean {
  return sessions.get(paneId)?.modeActive ?? false;
}

export function clearDesignSession(paneId: string): void {
  sessions.delete(paneId);
}

export function onDesignEvent(listener: DesignEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetDesignSessionsForTest(): void {
  sessions.clear();
  listeners.clear();
}
