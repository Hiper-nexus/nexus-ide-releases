/**
 * Livro de decisão por missão (F-1164). Em memória. Reserva o custo estimado
 * ANTES da chamada e acerta pelo recibo real depois; custo desconhecido mantém
 * o estimado (nunca vira zero). O valor cobrado vai ao diário
 * (`budgetChargedUsd`) e é dele que o livro se reconstrói após um reinício.
 *
 * Aquecimento assíncrono: o diário (até 10 MB) é lido fora do caminho quente,
 * no boot ou na primeira consulta, sem bloquear a thread. Enquanto aquece, as
 * reservas e os acertos acumulam em memória; ao terminar, o gasto anterior ao
 * nascimento do livro é somado (as linhas deste processo já estão em memória).
 *
 * O JS do Main é single-thread: `reserve` confere e soma no mesmo tique, então
 * N chamadas paralelas nunca reservam além do teto. Nada aqui lança.
 */
import type { DecisionUsageReceipt } from '../../shared/decision-models';
import { jevMissionChargedSpend } from '../jev/jev-decision-log';

export const SOFT_BUDGET_RATIO = 0.8;
/** Missão sem atividade há mais que isto sai da memória. */
export const LEDGER_IDLE_EVICTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export type DecisionBudgetLevel = 'normal' | 'soft' | 'exhausted';

export interface DecisionBudgetReservation {
  readonly missionId: string;
  readonly estimatedUsd: number;
  /** false = só contabiliza (modo explícito, surface fixa no Jev); nunca recusa. */
  readonly enforced: boolean;
  settled: boolean;
  chargedUsd?: number;
}

interface MissionBook { spent: number; reserved: number; lastActivityAt: number }

export interface DecisionBudgetSnapshot {
  spentUsd: number; reservedUsd: number; budgetUsd: number; ratio: number; level: DecisionBudgetLevel;
}

type SpendLoader = (before: number) => Record<string, number> | Promise<Record<string, number>>;

/** Regra única de cobrança: medido; desconhecido = estimado; incompleto = o maior. */
export function decisionBudgetCharge(estimatedUsd: number, actualUsd: number | null, incomplete = false): number {
  const measured = actualUsd !== null && Number.isFinite(actualUsd) && actualUsd >= 0 ? actualUsd : null;
  if (measured === null) return estimatedUsd;
  return incomplete ? Math.max(measured, estimatedUsd) : measured;
}

/** Cobrança de uma consulta sem resposta: nenhuma requisição devolve tudo; sem recibo fica o estimado. */
export function decisionBudgetChargeForUsage(estimatedUsd: number, usage: DecisionUsageReceipt | undefined): number {
  if (!usage) return estimatedUsd;
  if (usage.requestCount === 0) return 0;
  return decisionBudgetCharge(estimatedUsd, usage.usd, usage.usageIncomplete);
}

export class DecisionBudgetLedger {
  private readonly books = new Map<string, MissionBook>();
  private readonly bornAt: number;
  private warming: Promise<void> | undefined;
  private warmed = false;
  private lastPruneAt: number;

  constructor(
    private readonly loadSpent: SpendLoader = () => ({}),
    private readonly now: () => number = Date.now,
  ) {
    this.bornAt = now();
    this.lastPruneAt = this.bornAt;
  }

  get isWarm(): boolean { return this.warmed; }

  /** Idempotente e nunca rejeita. Só soma o gasto gravado antes do nascimento do livro. */
  warm(): Promise<void> {
    this.warming ??= (async () => {
      let spent: Record<string, number> = {};
      try { spent = (await this.loadSpent(this.bornAt)) ?? {}; } catch { spent = {}; }
      for (const [missionId, usd] of Object.entries(spent)) {
        if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) this.book(missionId).spent += usd;
      }
      this.warmed = true;
    })();
    return this.warming;
  }

  private book(missionId: string): MissionBook {
    let book = this.books.get(missionId);
    if (!book) { book = { spent: 0, reserved: 0, lastActivityAt: this.now() }; this.books.set(missionId, book); }
    return book;
  }

  /** Quantas missões estão em memória (limite de memória testável). */
  get size(): number { return this.books.size; }

  /** Missão encerrada: sai da memória (reservas em voo voltam a criar a entrada só para o acerto). */
  forget(missionId: string): void {
    this.books.delete(missionId);
  }

  /** Remove missões sem reserva em voo e sem atividade há mais de 7 dias. */
  prune(): void {
    const at = this.now();
    this.lastPruneAt = at;
    for (const [missionId, book] of this.books) {
      if (book.reserved <= 0 && at - book.lastActivityAt > LEDGER_IDLE_EVICTION_MS) this.books.delete(missionId);
    }
  }

  private touch(): void {
    if (!this.warming) void this.warm();
    if (this.now() - this.lastPruneAt >= PRUNE_INTERVAL_MS) this.prune();
  }

  snapshot(missionId: string, budgetUsd: number): DecisionBudgetSnapshot {
    this.touch();
    const book = this.books.get(missionId) ?? { spent: 0, reserved: 0 };
    const committed = book.spent + book.reserved;
    const ratio = budgetUsd > 0 ? committed / budgetUsd : 1;
    return { spentUsd: book.spent, reservedUsd: book.reserved, budgetUsd, ratio,
      level: ratio >= 1 ? 'exhausted' : ratio >= SOFT_BUDGET_RATIO ? 'soft' : 'normal' };
  }

  /** `null` = a reserva estouraria o teto: a surface recebe `noAnswer('budget')`. */
  reserve(missionId: string, estimatedUsd: number, budgetUsd: number, enforced = true): DecisionBudgetReservation | null {
    this.touch();
    const estimate = Number.isFinite(estimatedUsd) && estimatedUsd > 0 ? estimatedUsd : 0;
    const book = this.book(missionId);
    if (enforced && (book.spent + book.reserved >= budgetUsd || book.spent + book.reserved + estimate > budgetUsd)) return null;
    book.reserved += estimate;
    book.lastActivityAt = this.now();
    return { missionId, estimatedUsd: estimate, enforced, settled: false };
  }

  /** Acerto pelo recibo (`decisionBudgetCharge`). Idempotente; devolve o valor cobrado. */
  settle(reservation: DecisionBudgetReservation, actualUsd: number | null, incomplete = false): number {
    if (reservation.settled) return reservation.chargedUsd ?? 0;
    reservation.settled = true;
    const book = this.book(reservation.missionId);
    book.reserved = Math.max(0, book.reserved - reservation.estimatedUsd);
    const charged = decisionBudgetCharge(reservation.estimatedUsd, actualUsd, incomplete);
    reservation.chargedUsd = charged;
    book.spent += charged;
    book.lastActivityAt = this.now();
    return charged;
  }
}

let defaultLedger: DecisionBudgetLedger | undefined;

/** Ledger do processo. Aquece sozinho na primeira consulta, sem bloquear. */
export function getDecisionBudgetLedger(): DecisionBudgetLedger {
  defaultLedger ??= new DecisionBudgetLedger(before => jevMissionChargedSpend({ before }));
  return defaultLedger;
}

const TERMINAL_MISSION_STATUSES = new Set(['done', 'failed', 'cancelled']);

/**
 * Boot: cria o livro, aquece fora do caminho quente e esquece missões
 * encerradas. Devolve o disposer da inscrição. Nunca lança.
 */
export function startDecisionBudgetLedger(deps: {
  subscribe?: (listener: (event: { kind: string; payload: Readonly<Record<string, unknown>> }) => void) => () => void;
  delayMs?: number;
} = {}): () => void {
  const ledger = getDecisionBudgetLedger();
  const timer = setTimeout(() => { void ledger.warm(); }, deps.delayMs ?? 2_000);
  timer.unref?.();
  let unsubscribe: () => void = () => {};
  try {
    unsubscribe = deps.subscribe?.(event => {
      const missionId = event.payload.missionId;
      if (typeof missionId !== 'string') return;
      if (event.kind === 'mission.completed'
        || (event.kind === 'mission.state' && TERMINAL_MISSION_STATUSES.has(String(event.payload.status)))) {
        ledger.forget(missionId);
      }
    }) ?? unsubscribe;
  } catch { /* sem barramento de eventos: só o despejo por inatividade */ }
  return () => { clearTimeout(timer); unsubscribe(); };
}

export function resetDecisionBudgetLedgerForTesting(): void {
  defaultLedger = undefined;
}
