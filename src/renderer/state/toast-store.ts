import { create } from 'zustand';

/** Lightweight transient notifications (failover, save errors, …). */

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface ToastAction {
  readonly label: string;
  /** Called when the operator clicks the action; toast dismisses after. */
  readonly onClick: () => void | Promise<void>;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  action?: ToastAction;
}

export interface PushToastOptions {
  detail?: string;
  action?: ToastAction;
  /** Override default TTL (ms). Longer for actionable toasts. */
  ttlMs?: number;
}

interface ToastStore {
  toasts: Toast[];
  push(
    kind: ToastKind,
    title: string,
    detailOrOptions?: string | PushToastOptions,
  ): void;
  dismiss(id: number): void;
}

let nextId = 1;
const TTL_MS = 7000;
const ACTION_TTL_MS = 20_000;
const ttlTimers = new Map<number, ReturnType<typeof setTimeout>>();

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (kind, title, detailOrOptions) => {
    const id = nextId++;
    const opts: PushToastOptions =
      typeof detailOrOptions === 'string'
        ? { detail: detailOrOptions }
        : detailOrOptions ?? {};
    const toast: Toast = {
      id,
      kind,
      title,
      detail: opts.detail,
      action: opts.action,
    };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    const ttl =
      opts.ttlMs ??
      (opts.action ? ACTION_TTL_MS : TTL_MS);
    const timer = setTimeout(() => get().dismiss(id), ttl);
    ttlTimers.set(id, timer);
  },
  dismiss: (id) => {
    const timer = ttlTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      ttlTimers.delete(id);
    }
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
