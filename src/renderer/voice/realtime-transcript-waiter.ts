/**
 * BUG A fix (turn-scoped realtime-transcript wait). O caminho de wake espera o
 * transcript final do provider para decidir o turno. Antes, o pending era um
 * par de globais soltos (`pendingRealtimeTranscript` + `queuedRealtimeTranscript`)
 * e QUALQUER coisa que resolvia o pending com `null` era lida como MUTE. Um
 * novo "Hey Jarvis" (ou o início de um novo wait) resolvia o pending do turno
 * ANTERIOR com null → `realtimeMuteDegraded` disparava em ~75ms, muito antes de
 * um silêncio real de socket (3–5s), e o Classic degradava por engano.
 *
 * Este waiter torna o pending ESCOPADO AO TURNO: distingue três desfechos —
 *  - `text`           → transcript real chegou (não é mute).
 *  - timeout          → silêncio GENUÍNO do socket dentro da janela (mute real).
 *  - `superseded`     → um novo turno/wake tomou a conversa; NÃO é mute, o
 *                       awaiter deve sair em silêncio (sem degradar p/ Classic).
 *
 * Relógio injetável (setTimeout/clearTimeout) → puro e testável.
 */

export interface RealtimeTranscriptWaitOutcome {
  /** Transcript final do provider, ou null quando não houve (timeout/supersede). */
  text: string | null;
  /** True quando um novo turno cancelou este wait — jamais tratar como mute. */
  superseded: boolean;
}

export interface RealtimeTranscriptWaiterDeps {
  setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn: (timer: ReturnType<typeof setTimeout>) => void;
}

const defaultDeps: RealtimeTranscriptWaiterDeps = {
  setTimeoutFn: (cb, ms) => setTimeout(cb, ms),
  clearTimeoutFn: (timer) => clearTimeout(timer),
};

interface Pending {
  resolve: (outcome: RealtimeTranscriptWaitOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RealtimeTranscriptWaiter {
  private pending: Pending | null = null;
  private queued: string | null = null;

  constructor(private readonly deps: RealtimeTranscriptWaiterDeps = defaultDeps) {}

  /** Há um transcript já entregue esperando um wait (chegou antes do await). */
  hasQueued(): boolean {
    return this.queued !== null;
  }

  /** Há um wait em curso aguardando resolução. */
  hasPending(): boolean {
    return this.pending !== null;
  }

  /**
   * Um transcript final do provider chegou. Entrega ao waiter atual (se houver)
   * como desfecho REAL (superseded:false); senão, guarda para o próximo wait.
   * Retorna true se foi entregue a um waiter (o chamador então NÃO precisa
   * agendar o fechamento manual do turno).
   */
  deliver(text: string): boolean {
    if (this.pending) {
      this.settle({ text, superseded: false });
      return true;
    }
    this.queued = text;
    return false;
  }

  /**
   * Um novo turno/wake tomou a conversa: resolve o wait atual como SUPERSEDED
   * (não é mute) e descarta qualquer transcript enfileirado do turno anterior.
   */
  supersede(): void {
    this.queued = null;
    if (this.pending) this.settle({ text: null, superseded: true });
  }

  /** Limpa só o transcript enfileirado (novo turno sem cancelar um wait ativo). */
  resetQueued(): void {
    this.queued = null;
  }

  /**
   * Aguarda o transcript final por até `timeoutMs`. Um transcript já
   * enfileirado resolve na hora. Um wait anterior ainda pendente é SUPERSEDED
   * (o novo wait é de um turno mais recente) — jamais vira mute. O timeout é o
   * ÚNICO caminho para `superseded:false, text:null` (silêncio genuíno = mute).
   */
  wait(timeoutMs: number): Promise<RealtimeTranscriptWaitOutcome> {
    if (this.queued !== null) {
      const text = this.queued;
      this.queued = null;
      return Promise.resolve({ text, superseded: false });
    }
    if (this.pending) this.settle({ text: null, superseded: true });
    return new Promise((resolve) => {
      const timer = this.deps.setTimeoutFn(() => {
        if (this.pending?.resolve === resolve) this.pending = null;
        resolve({ text: null, superseded: false });
      }, timeoutMs);
      this.pending = { resolve, timer };
    });
  }

  private settle(outcome: RealtimeTranscriptWaitOutcome): void {
    const pending = this.pending;
    if (!pending) return;
    this.deps.clearTimeoutFn(pending.timer);
    this.pending = null;
    pending.resolve(outcome);
  }
}
