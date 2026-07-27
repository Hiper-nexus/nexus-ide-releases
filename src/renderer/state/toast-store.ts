import { create } from 'zustand';
import { humanizeMissionErrorDetail } from '../lib/user-facing-mission-error';

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
  /** Stable incident key used to replace repeated notifications in-place. */
  dedupeKey: string;
}

export interface PushToastOptions {
  detail?: string;
  action?: ToastAction;
  /**
   * Notifications for the same incident replace each other while visible.
   * Callers normally do not need this: common mission events are inferred.
   */
  dedupeKey?: string;
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
const MAX_TRANSIENT_TOASTS = 3;
const ttlTimers = new Map<number, ReturnType<typeof setTimeout>>();

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Toasts are a brief recovery surface, not a transport log. Electron wraps
 * useful copy in IPC method names and internal error codes; strip those while
 * keeping the actionable part. Full diagnostics remain in Operações/journals.
 */
export function humanizeToastDetail(
  detail: string | undefined,
): string | undefined {
  return humanizeMissionErrorDetail(detail);
}

function inferredDedupeKey(
  kind: ToastKind,
  title: string,
  detail: string | undefined,
): string {
  // These are successive views of the same launch incident. A confirmed retry
  // still replaces the previous error because every new state remains visible.
  if (
    /^(?:Frota em campo|Não deu pra iniciar (?:a execução|o squad)|Missão precisa de você)$/i.test(
      title.trim(),
    )
  ) {
    return 'mission-execution';
  }
  return `${kind}:${normalizeWhitespace(title).toLocaleLowerCase('pt-BR')}:${
    detail?.toLocaleLowerCase('pt-BR') ?? ''
  }`;
}

function clearToastTimer(id: number): void {
  const timer = ttlTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    ttlTimers.delete(id);
  }
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push: (kind, title, detailOrOptions) => {
    const id = nextId++;
    const opts: PushToastOptions =
      typeof detailOrOptions === 'string'
        ? { detail: detailOrOptions }
        : detailOrOptions ?? {};
    const detail = humanizeToastDetail(opts.detail);
    const dedupeKey =
      opts.dedupeKey ?? inferredDedupeKey(kind, title, detail);
    const toast: Toast = {
      id,
      kind,
      title,
      detail,
      action: opts.action,
      dedupeKey,
    };

    const current = get().toasts;
    const duplicateIndex = current.findIndex(
      (item) => item.dedupeKey === dedupeKey,
    );
    const duplicate = duplicateIndex >= 0 ? current[duplicateIndex] : undefined;

    // The pet mirrors a failed launch as a generic "needs you" warning. Keep
    // the concrete recovery instruction already shown instead of stacking it.
    if (
      dedupeKey === 'mission-execution' &&
      duplicate?.kind === 'error' &&
      kind === 'warn' &&
      /^Missão precisa de você$/i.test(title.trim())
    ) {
      return;
    }

    const next = [...current];
    if (duplicateIndex >= 0) {
      clearToastTimer(next[duplicateIndex].id);
      next.splice(duplicateIndex, 1);
    }
    next.push(toast);

    const removedIds: number[] = [];
    while (next.length > MAX_TRANSIENT_TOASTS) {
      const removableIndex = next.findIndex((item) => !item.action);
      // Prefer removing transient signals. If every visible item is actionable,
      // retire the oldest one so the viewport contract remains bounded.
      const evictionIndex = removableIndex >= 0 ? removableIndex : 0;
      removedIds.push(next[evictionIndex].id);
      next.splice(evictionIndex, 1);
    }
    for (const removedId of removedIds) clearToastTimer(removedId);
    set({ toasts: next });

    // If three actionable alerts already occupy the stack, a new transient
    // signal is intentionally omitted; durable mission state remains in Ops.
    if (!next.some((item) => item.id === id)) return;
    const ttl =
      opts.ttlMs ??
      (opts.action ? ACTION_TTL_MS : TTL_MS);
    const timer = setTimeout(() => get().dismiss(id), ttl);
    ttlTimers.set(id, timer);
  },
  dismiss: (id) => {
    clearToastTimer(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
