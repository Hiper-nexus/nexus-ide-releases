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
  turnId?: string;
}

export class RealtimeTranscriptWaiter {
  private pending: Pending | null = null;
  private queued: { text: string; turnId?: string } | null = null;
  private activeTurnId: string | null = null;

  constructor(private readonly deps: RealtimeTranscriptWaiterDeps = defaultDeps) {}

  /** Há um transcript já entregue esperando um wait (chegou antes do await). */
  hasQueued(): boolean {
    return this.queued !== null;
  }

  /** Opens a turn boundary and quarantines any final from the previous turn. */
  beginTurn(turnId: string): void {
    const normalized = turnId.trim();
    if (!normalized || normalized === this.activeTurnId) return;
    this.supersede();
    this.activeTurnId = normalized;
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
  deliver(text: string, turnId?: string): boolean {
    if (turnId && this.activeTurnId && turnId !== this.activeTurnId) {
      return true;
    }
    if (this.pending) {
      if (turnId && this.pending.turnId && turnId !== this.pending.turnId) {
        return true;
      }
      this.settle({ text, superseded: false });
      return true;
    }
    this.queued = { text, turnId };
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
   * Encerra o wait pendente ANTES do timeout porque o turno já tem outra prova
   * de resposta do provider (áudio ou tool). Resolve como `{ text: null,
   * superseded: false }` — o mesmo formato do timeout — e deixa a leitura da
   * evidência por conta de quem chamou: aqui não se decide mute nem supersede.
   *
   * Não toca em `queued`: um final que chegue depois fica guardado e morre na
   * virada do turno (`beginTurn`/`supersede`/`resetQueued`). Quando `turnId` é
   * informado, só libera o wait DESSE turno; um wait mais novo (outro turno
   * já assumiu) nunca é encerrado por um chamador atrasado.
   *
   * Devolve true se havia um wait deste turno para liberar.
   */
  settleEarly(turnId?: string): boolean {
    const pending = this.pending;
    if (!pending) return false;
    if (turnId && pending.turnId && turnId !== pending.turnId) return false;
    this.settle({ text: null, superseded: false });
    return true;
  }

  /**
   * Aguarda o transcript final por até `timeoutMs`. Um transcript já
   * enfileirado resolve na hora. Um wait anterior ainda pendente é SUPERSEDED
   * (o novo wait é de um turno mais recente) — jamais vira mute. O timeout é o
   * ÚNICO caminho para `superseded:false, text:null` (silêncio genuíno = mute).
   */
  wait(timeoutMs: number, turnId?: string): Promise<RealtimeTranscriptWaitOutcome> {
    if (this.queued !== null) {
      const queued = this.queued;
      this.queued = null;
      if (!turnId || !queued.turnId || queued.turnId === turnId) {
        return Promise.resolve({ text: queued.text, superseded: false });
      }
    }
    if (this.pending) this.settle({ text: null, superseded: true });
    return new Promise((resolve) => {
      const timer = this.deps.setTimeoutFn(() => {
        if (this.pending?.resolve === resolve) this.pending = null;
        resolve({ text: null, superseded: false });
      }, timeoutMs);
      this.pending = { resolve, timer, turnId };
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
