import { create } from 'zustand';

/**
 * Confirm estilizado da casa — substitui o window.confirm nativo (que quebra
 * o registro visual e BLOQUEIA o renderer). API por promise: qualquer fluxo
 * chama `askConfirm({...})` e aguarda a decisão; o <ConfirmDialog/> único
 * (App) renderiza o pedido corrente.
 */

export interface ConfirmRequest {
  title: string;
  body: string;
  /** Rótulo verbo+objeto ("Fechar pane"), nunca "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Ação destrutiva: botão de confirmação em danger. */
  danger?: boolean;
  /**
   * When set, shows a required reason textarea. Confirm is disabled until
   * the reason meets `reasonMinLength` (default 8).
   */
  reasonLabel?: string;
  reasonPlaceholder?: string;
  reasonMinLength?: number;
}

export type ConfirmWithReasonResult =
  | { ok: false }
  | { ok: true; reason: string };

interface PendingConfirm extends ConfirmRequest {
  resolve(result: ConfirmWithReasonResult): void;
  requireReason: boolean;
}

interface ConfirmStore {
  pending: PendingConfirm | null;
  /** Pedidos aguardando o atual ser respondido — serialização real. */
  queue: PendingConfirm[];
  ask(request: ConfirmRequest): Promise<boolean>;
  askWithReason(request: ConfirmRequest): Promise<ConfirmWithReasonResult>;
  decide(ok: boolean, reason?: string): void;
}

export const useConfirmStore = create<ConfirmStore>((set, get) => ({
  pending: null,
  queue: [],
  ask: (request) =>
    get()
      .askWithReason({ ...request, reasonLabel: undefined })
      .then((result) => result.ok),
  askWithReason: (request) =>
    new Promise<ConfirmWithReasonResult>((resolve) => {
      // Serializa como o window.confirm serializava: um pedido novo espera o
      // atual ser respondido — NUNCA rouba o dialog aberto (um clique jamais
      // cai numa pergunta que o usuário não leu).
      const requireReason = Boolean(request.reasonLabel?.trim());
      const entry: PendingConfirm = {
        ...request,
        requireReason,
        resolve,
      };
      const { pending, queue } = get();
      if (pending) set({ queue: [...queue, entry] });
      else set({ pending: entry });
    }),
  decide: (ok, reason) => {
    const { pending, queue } = get();
    if (!pending) return;
    const [next, ...rest] = queue;
    set({ pending: next ?? null, queue: rest });
    if (!ok) {
      pending.resolve({ ok: false });
      return;
    }
    if (pending.requireReason) {
      const trimmed = (reason ?? '').trim();
      const min = pending.reasonMinLength ?? 8;
      if (trimmed.length < min) {
        // Should be blocked by the dialog UI; fail closed if bypassed.
        pending.resolve({ ok: false });
        return;
      }
      pending.resolve({ ok: true, reason: trimmed });
      return;
    }
    pending.resolve({ ok: true, reason: '' });
  },
}));

/** Atalho para fluxos fora de componentes React. */
export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  return useConfirmStore.getState().ask(request);
}

/** Confirm with a required justification string (e.g. block mission). */
export function askConfirmWithReason(
  request: ConfirmRequest & { reasonLabel: string },
): Promise<ConfirmWithReasonResult> {
  return useConfirmStore.getState().askWithReason(request);
}

/** Durable description section when the operator ends a mission as blocked. */
export function formatBlockedMissionNote(reason: string, at = Date.now()): string {
  const iso = new Date(at).toISOString();
  return `## Encerrada como bloqueada (${iso})\n${reason.trim()}`;
}

export function appendBlockedMissionDescription(
  currentDescription: string,
  reason: string,
  at = Date.now(),
): string {
  const note = formatBlockedMissionNote(reason, at);
  const base = currentDescription.trim();
  return base ? `${base}\n\n${note}` : note;
}
