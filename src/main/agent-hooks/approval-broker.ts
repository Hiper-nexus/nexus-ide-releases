// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: o contrato de
// `RuntimeRequestServiceV2.respond` (pedido existe, está vivo e pertence à
// sessão; repetir devolve o recibo sem responder duas vezes) sem Effect nem
// projeção: Map em memória com CAS por requestId/revision, recibo com TTL,
// prazo curto que devolve null (o hook responde `{}` e a TUI assume),
// invalidação quando a TUI respondeu primeiro e registro de quem pode
// responder (card do desktop visível, aparelho pareado conectado).
//
// Sonda real (claude 2.1.283, docs/qa/items/F-965.md): a TUI desenha o
// diálogo no mesmo instante em que o hook começa e uma tecla do operador
// vence na hora; o hook continua vivo e a decisão tardia é ignorada. Por isso
// esperar aqui não tira o terminal do operador — e por isso um evento de
// status posterior da mesma sessão invalida o pedido (`supersede`).

import { createHash, randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalOption,
  ApprovalProvider,
  ApprovalRequestView,
} from '../../shared/approval-decision';

export type ApprovalResponseSource = 'desktop' | 'mobile';

export type ApprovalReceipt = {
  readonly requestId: string;
  readonly revision: number;
  readonly optionId: ApprovalDecision;
  readonly source: ApprovalResponseSource;
  readonly decidedAt: number;
  /** true quando o mesmo pedido/opção chegou de novo: nada foi respondido outra vez. */
  readonly duplicate: boolean;
};

export type ApprovalRejectReason =
  | 'unknown-request'
  | 'stale-revision'
  | 'already-resolved'
  | 'closed'
  | 'option-unavailable';

export type ApprovalRespondResult =
  | { readonly status: 'accepted'; readonly receipt: ApprovalReceipt }
  | { readonly status: 'rejected'; readonly reason: ApprovalRejectReason };

export type ApprovalCloseReason = 'expired' | 'superseded' | 'cancelled';

export type OpenApprovalInput = {
  readonly sessionId: string;
  readonly provider: ApprovalProvider;
  readonly tool: string;
  readonly summary: string;
  readonly options: readonly ApprovalOption[];
  readonly waitMs: number;
  /** Identidade do pedido (ferramenta + argumentos) para `supersede` exato. */
  readonly fingerprint: string;
  /** Comando de alto impacto: a resposta remota que aprova pede o diálogo do desktop. */
  readonly highImpact: boolean;
};

export type OpenedApproval = {
  readonly request: ApprovalRequestView;
  /** Decisão, ou null quando expira/é cancelado/invalidado. */
  readonly decision: Promise<ApprovalDecision | null>;
  readonly cancel: () => void;
};

type PendingEntry = {
  view: ApprovalRequestView;
  fingerprint: string;
  highImpact: boolean;
  resolve: (decision: ApprovalDecision | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ClosedRecord = {
  sessionId: string;
  at: number;
  receipt?: Omit<ApprovalReceipt, 'duplicate'>;
  reason?: ApprovalCloseReason;
};

export type ApprovalBrokerOptions = {
  readonly now?: () => number;
  /** Quanto tempo um recibo/fechamento segue respondendo repetições. */
  readonly receiptTtlMs?: number;
  readonly maxClosedRecords?: number;
};

const DEFAULT_RECEIPT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_CLOSED = 512;
/** Teto de pedidos abertos por sessão: um pane que dispara hooks em laço não enche a memória. */
const MAX_PENDING_PER_SESSION = 8;

/** sha256 curto de ferramenta + argumentos — o PostToolUse do mesmo pedido gera o mesmo valor. */
export function approvalFingerprint(tool: string, toolInput: unknown): string {
  let input = '';
  try {
    input = JSON.stringify(toolInput ?? null) ?? '';
  } catch {
    input = '';
  }
  return createHash('sha256').update(`${tool}\u0000${input}`).digest('hex').slice(0, 32);
}

export class ApprovalBroker {
  readonly #now: () => number;
  readonly #receiptTtlMs: number;
  readonly #maxClosed: number;
  readonly #pending = new Map<string, PendingEntry>();
  readonly #closed = new Map<string, ClosedRecord>();
  readonly #listeners = new Set<() => void>();

  constructor(options: ApprovalBrokerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#receiptTtlMs = options.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS;
    this.#maxClosed = options.maxClosedRecords ?? DEFAULT_MAX_CLOSED;
  }

  open(input: OpenApprovalInput): OpenedApproval | null {
    let perSession = 0;
    for (const entry of this.#pending.values()) {
      if (entry.view.sessionId === input.sessionId) perSession += 1;
    }
    if (perSession >= MAX_PENDING_PER_SESSION) return null;
    const requestId = randomUUID();
    const view: ApprovalRequestView = {
      requestId,
      revision: 1,
      sessionId: input.sessionId,
      provider: input.provider,
      tool: input.tool,
      summary: input.summary,
      options: input.options,
      responseCapability: 'live',
      expiresAt: this.#now() + input.waitMs,
    };
    let resolve!: (decision: ApprovalDecision | null) => void;
    const decision = new Promise<ApprovalDecision | null>((done) => {
      resolve = done;
    });
    const timer = setTimeout(() => this.#close(requestId, 'expired'), input.waitMs);
    timer.unref?.();
    this.#pending.set(requestId, {
      view,
      fingerprint: input.fingerprint,
      highImpact: input.highImpact,
      resolve,
      timer,
    });
    this.#emit();
    return { request: view, decision, cancel: () => this.#close(requestId, 'cancelled') };
  }

  /**
   * Responde um pedido. CAS: `expectedRevision` precisa ser a revisão que o
   * pedido tinha quando foi mostrado. Repetir a MESMA resposta devolve o recibo
   * (`duplicate: true`) sem decidir de novo; outra opção depois de decidido,
   * ou pedido fechado, é recusada.
   */
  respond(input: {
    readonly requestId: string;
    readonly expectedRevision: number;
    readonly optionId: ApprovalDecision;
    readonly source: ApprovalResponseSource;
  }): ApprovalRespondResult {
    this.#prune();
    const entry = this.#pending.get(input.requestId);
    if (!entry) {
      const closed = this.#closed.get(input.requestId);
      if (!closed) return { status: 'rejected', reason: 'unknown-request' };
      if (!closed.receipt) return { status: 'rejected', reason: 'closed' };
      if (
        closed.receipt.optionId === input.optionId &&
        closed.receipt.revision === input.expectedRevision
      ) {
        return { status: 'accepted', receipt: { ...closed.receipt, duplicate: true } };
      }
      return { status: 'rejected', reason: 'already-resolved' };
    }
    if (entry.view.revision !== input.expectedRevision) {
      return { status: 'rejected', reason: 'stale-revision' };
    }
    if (!entry.view.options.some((option) => option.optionId === input.optionId)) {
      return { status: 'rejected', reason: 'option-unavailable' };
    }
    const receipt = {
      requestId: input.requestId,
      revision: entry.view.revision,
      optionId: input.optionId,
      source: input.source,
      decidedAt: this.#now(),
    };
    this.#finish(input.requestId, entry, { sessionId: entry.view.sessionId, at: receipt.decidedAt, receipt });
    entry.resolve(input.optionId);
    return { status: 'accepted', receipt: { ...receipt, duplicate: false } };
  }

  /**
   * Um evento posterior da mesma sessão prova que a TUI já respondeu: fecha o
   * pedido de mesma ferramenta/argumentos, ou todos da sessão (fim de turno,
   * prompt novo) quando `fingerprint` não vem.
   */
  supersede(sessionId: string, fingerprint?: string): number {
    let closed = 0;
    for (const [requestId, entry] of [...this.#pending]) {
      if (entry.view.sessionId !== sessionId) continue;
      if (fingerprint !== undefined && entry.fingerprint !== fingerprint) continue;
      this.#close(requestId, 'superseded');
      closed += 1;
    }
    return closed;
  }

  cancelForSession(sessionId: string): void {
    for (const [requestId, entry] of [...this.#pending]) {
      if (entry.view.sessionId === sessionId) this.#close(requestId, 'cancelled');
    }
  }

  list(): ApprovalRequestView[] {
    return [...this.#pending.values()].map((entry) => entry.view);
  }

  /** Sessão dona do pedido (aberto ou recém-fechado) — para checar autoridade antes de responder. */
  sessionOf(requestId: string): string | null {
    return this.#pending.get(requestId)?.view.sessionId ?? this.#closed.get(requestId)?.sessionId ?? null;
  }

  isHighImpact(requestId: string): boolean {
    return this.#pending.get(requestId)?.highImpact === true;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #close(requestId: string, reason: ApprovalCloseReason): void {
    const entry = this.#pending.get(requestId);
    if (!entry) return;
    this.#finish(requestId, entry, { sessionId: entry.view.sessionId, at: this.#now(), reason });
    entry.resolve(null);
  }

  #finish(requestId: string, entry: PendingEntry, record: ClosedRecord): void {
    clearTimeout(entry.timer);
    this.#pending.delete(requestId);
    this.#closed.set(requestId, record);
    this.#prune();
    this.#emit();
  }

  #prune(): void {
    const cutoff = this.#now() - this.#receiptTtlMs;
    for (const [requestId, record] of this.#closed) {
      if (record.at < cutoff || this.#closed.size > this.#maxClosed) this.#closed.delete(requestId);
      else break; // Map preserva a ordem de inserção: o resto é mais novo.
    }
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn('[approval-broker] listener falhou', error);
      }
    }
  }
}

/** Broker único do Main (um processo, uma fila de pedidos). */
export const approvalBroker = new ApprovalBroker();

// ── Quem pode responder agora ───────────────────────────────────────────────
// Sem respondente o endpoint devolve `{}` na hora e o diálogo da TUI segue
// como sempre. Respondente = card do desktop visível para o pane OU aparelho
// pareado e conectado com autoridade de escrita naquele pane.

let desktopSurfaces: ReadonlySet<string> = new Set();
const remoteResponders = new Set<(sessionId: string) => boolean>();

/** O renderer informa as sessões cujo card de aprovação está visível agora. */
export function setDesktopApprovalSurfaces(sessionIds: readonly string[]): void {
  desktopSurfaces = new Set(sessionIds);
}

export function registerRemoteApprovalResponder(probe: (sessionId: string) => boolean): () => void {
  remoteResponders.add(probe);
  return () => remoteResponders.delete(probe);
}

export function hasApprovalResponder(sessionId: string): boolean {
  if (desktopSurfaces.has(sessionId)) return true;
  for (const probe of remoteResponders) {
    try {
      if (probe(sessionId)) return true;
    } catch {
      // Sonda quebrada não vira respondente: fail-safe para a TUI.
    }
  }
  return false;
}

export function __resetApprovalRespondersForTests(): void {
  desktopSurfaces = new Set();
  remoteResponders.clear();
}
