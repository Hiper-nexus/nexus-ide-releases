import { create } from 'zustand';
import type { DevServerDetectedPayload } from '../../shared/types';

/**
 * Dev servers detected in PTY panes (VISUAL-EDIT-001, F1.5). Fed by the main
 * process push (devserver:detected); consumed by the pane toolbar chip that
 * offers "abrir no browser pane".
 */

export interface DevServerInfo {
  url: string;
  urls: string[];
  detectedAt: number;
}

interface DevServerState {
  byPane: Record<string, DevServerInfo>;
  setDetected(payload: DevServerDetectedPayload): void;
  reset(): void;
}

export const useDevServerStore = create<DevServerState>((set) => ({
  byPane: {},
  setDetected: (payload) => {
    if (!payload.paneId || !payload.url) return;
    set((state) => ({
      byPane: {
        ...state.byPane,
        [payload.paneId as string]: {
          url: payload.url,
          urls: payload.urls,
          detectedAt: payload.detectedAt,
        },
      },
    }));
  },
  reset: () => set({ byPane: {} }),
}));

/** Wire the main-process push into the store; returns the unsubscribe. */
export function initDevServerStore(): () => void {
  return window.nexus.devServer.onDetected((payload) => {
    useDevServerStore.getState().setDetected(payload);
  });
}
