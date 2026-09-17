import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  JevPaneHint,
  JevPaneHintEvent,
} from '../../shared/jev-ipc';

/**
 * Renderer mirror do classificador Jev de estado do pane (surface
 * `paneState`): o main empurra `jev:paneHint` e o chip do PaneToolbar lê
 * daqui. Advisory only — nunca altera o estado semântico do pane.
 */

interface JevHintStore {
  bySessionId: ReadonlyMap<string, JevPaneHint>;
}

export const useJevHintStore = create<JevHintStore>(() => ({
  bySessionId: new Map(),
}));

function jevApi() {
  return window.nexus?.jev;
}

/** Mount once — uma única assinatura no push `jev:paneHint`. */
export function useJevHintController(): void {
  useEffect(() => {
    const api = jevApi();
    if (!api?.onPaneHint) return undefined;
    return api.onPaneHint((event: JevPaneHintEvent) => {
      useJevHintStore.setState((s) => {
        const next = new Map(s.bySessionId);
        next.set(event.sessionId, event.hint);
        return { bySessionId: next };
      });
    });
  }, []);
}
