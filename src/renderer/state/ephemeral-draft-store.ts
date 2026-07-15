import { create } from 'zustand';

/**
 * Cross-surface draft pocket for UI that soft-closes.
 * Survives overlay/Jarvis dismiss so reopening restores in-progress input.
 * Not persisted to disk — session-only by design.
 */

export type EphemeralDraftKey =
  | 'voice-settings'
  | 'diff-annotate'
  | 'agent-picker'
  | 'settings-nav';

interface EphemeralDraftStore {
  byKey: Partial<Record<EphemeralDraftKey, unknown>>;
  save<T>(key: EphemeralDraftKey, value: T): void;
  peek<T>(key: EphemeralDraftKey): T | undefined;
  clear(key: EphemeralDraftKey): void;
  clearAll(): void;
}

export const useEphemeralDraftStore = create<EphemeralDraftStore>((set, get) => ({
  byKey: {},

  save: (key, value) =>
    set((s) => ({
      byKey: { ...s.byKey, [key]: value },
    })),

  peek: <T,>(key: EphemeralDraftKey): T | undefined =>
    get().byKey[key] as T | undefined,

  clear: (key) =>
    set((s) => {
      if (!(key in s.byKey)) return s;
      const byKey = { ...s.byKey };
      delete byKey[key];
      return { byKey };
    }),

  clearAll: () => set({ byKey: {} }),
}));

/** Module-level helpers for non-React call sites (Jarvis executor, etc.). */
export function saveEphemeralDraft<T>(key: EphemeralDraftKey, value: T): void {
  useEphemeralDraftStore.getState().save(key, value);
}

export function peekEphemeralDraft<T>(key: EphemeralDraftKey): T | undefined {
  return useEphemeralDraftStore.getState().peek<T>(key);
}

export function clearEphemeralDraft(key: EphemeralDraftKey): void {
  useEphemeralDraftStore.getState().clear(key);
}
