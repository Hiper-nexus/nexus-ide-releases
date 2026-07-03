import { create } from 'zustand';

/** Lightweight transient notifications (failover, save errors, …). */

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

interface ToastStore {
  toasts: Toast[];
  push(kind: ToastKind, title: string, detail?: string): void;
  dismiss(id: number): void;
}

let nextId = 1;
const TTL_MS = 7000;

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (kind, title, detail) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, title, detail }] }));
    setTimeout(() => get().dismiss(id), TTL_MS);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
