import { createHash, randomUUID } from 'node:crypto';
import { missionIntentAuthoritySnapshot } from '../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../shared/types';
import type { WorkingTreeCandidateSnapshot } from '../context/candidate-working-tree-snapshot';
import { missionLifecycleKey } from './mission-lifecycle-lock';
import type { MissionCodeCandidate, MissionCodeReviewResult } from './mission-code-completion';

export interface CodeReviewerSeat { readonly adapterId: string; readonly model: string; readonly effort?: string;
  readonly agentName?: string; readonly allowedTools?: readonly string[] | null; readonly allowedSkills?: readonly string[] | null }
export interface CodeReviewerPane { readonly paneId: string; readonly sessionId: string; readonly failure?: string }
export type CodeReviewBinding = Pick<MissionCodeCandidate, 'scope' | 'executionScope' | 'baseSha' | 'coverage' | 'untrackedSince'> & {
  readonly missionId: string;
  readonly intentVersion: number;
  readonly fingerprint: string;
  readonly headSha: string | null;
  readonly missionSignature: string;
  /** Coverage metadata only; no file contents or prompt are retained. */
  readonly requiredPaths?: readonly string[];
};
export function codeReviewMissionSignature(mission: MissionCodeCandidate['mission']): string {
  return createHash('sha256').update(JSON.stringify([mission.id, mission.intentVersion,
    mission.title, mission.description, mission.intentContract == null
      ? mission.intentContract : missionIntentAuthoritySnapshot(mission.intentContract)])).digest('hex');
}
export interface CodeReviewerPorts {
  now(): number;
  isCurrent(binding: CodeReviewBinding): boolean;
  select(input: MissionCodeCandidate, signal: AbortSignal): Promise<CodeReviewerSeat | null>;
  isFrontier(seat: CodeReviewerSeat): boolean;
  spawn(input: MissionCodeCandidate, seat: CodeReviewerSeat, signal: AbortSignal): Promise<CodeReviewerPane | null>;
  isLive(sessionId: string): boolean;
  capture(binding: CodeReviewBinding): Promise<WorkingTreeCandidateSnapshot>;
  close(scope: ProjectExecutionScope, missionId: string, pane: CodeReviewerPane): Promise<boolean>;
  persist?(binding: CodeReviewBinding, result: Extract<MissionCodeReviewResult, { kind: 'reviewed' }>): Promise<Extract<MissionCodeReviewResult, { kind: 'reviewed' }>>;
}
interface Ticket {
  readonly binding: CodeReviewBinding;
  readonly controller: AbortController;
  pane?: CodeReviewerPane;
  flight?: Promise<void>;
  result?: Extract<MissionCodeReviewResult, { kind: 'reviewed' }>;
  failure?: string;
  retryAt: number;
  retiring?: boolean;
  closeRetryAt?: number;
  closing?: Promise<boolean>;
  submissionKey?: string;
  recording?: { key: string; flight: Promise<CodeReviewRecordResult> };
  lastInput?: MissionCodeCandidate;
  wakeTimer?: ReturnType<typeof setTimeout>;
}
type Reviewed = Extract<MissionCodeReviewResult, { kind: 'reviewed' }>;
export interface CodeReviewRecordResult { readonly handled: boolean; readonly accepted: boolean; readonly reason?: string; readonly result?: Reviewed }
export interface CodeReviewSubmission {
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly sessionId: string;
  readonly adapterId: string;
  readonly model: string;
  readonly readOnly: boolean;
  /** Main-measured Git state; absent never claims a clean checkout. */
  readonly treeDirty?: boolean;
  readonly verdict: 'approve' | 'reject';
  readonly summary: string;
  readonly findings: readonly string[];
}
const RETRY_MS = 30_000;
const MAX_TICKETS = 256;

/** Main-only bindings; no diff, prompt, credentials or file content is retained. */
export class MissionCodeReviewRuntime {
  readonly #tickets = new Map<string, Ticket>();
  constructor(private readonly ports: CodeReviewerPorts) {}

  #current(ticket: Ticket): boolean {
    try { return !ticket.retiring && !ticket.controller.signal.aborted && this.ports.isCurrent(ticket.binding); }
    catch { return false; }
  }

  #retire(key: string, ticket: Ticket): Promise<boolean> {
    ticket.retiring = true;
    ticket.controller.abort();
    if (ticket.wakeTimer) { clearTimeout(ticket.wakeTimer); ticket.wakeTimer = undefined; }
    if (ticket.closing) return ticket.closing;
    if (this.ports.now() < (ticket.closeRetryAt ?? 0)) return Promise.resolve(false);
    ticket.closing = Promise.resolve().then(async () => {
      await ticket.flight;
      if (ticket.pane && !await this.ports.close(ticket.binding.scope, ticket.binding.missionId, ticket.pane)) return false;
      if (this.#tickets.get(key) === ticket) this.#tickets.delete(key);
      return true;
    }).catch(() => false).then(closed => {
      if (!closed) ticket.closeRetryAt = this.ports.now() + RETRY_MS;
      return closed;
    }).finally(() => { ticket.closing = undefined; });
    return ticket.closing;
  }

  /** Lazy lifetime pruning; failed physical closes keep their owned ticket. */
  async prune(): Promise<void> {
    await Promise.all([...this.#tickets].filter(([, ticket]) => !this.#current(ticket))
      .map(([key, ticket]) => this.#retire(key, ticket)));
  }

  async ensure(input: MissionCodeCandidate, signal?: AbortSignal): Promise<MissionCodeReviewResult> {
    void this.prune();
    if (signal?.aborted) return { kind: 'unavailable', reason: 'A solicitação de revisão foi cancelada.' };
    const key = missionLifecycleKey(input.scope, input.mission.id);
    let ticket = this.#tickets.get(key);
    if (ticket && (ticket.retiring || ticket.binding.fingerprint !== input.candidate.fingerprint ||
      ticket.binding.baseSha !== input.baseSha || ticket.binding.intentVersion !== (input.mission.intentVersion ?? 0) ||
      ticket.binding.headSha !== input.candidate.headSha || ticket.binding.coverage !== input.coverage ||
      ticket.binding.untrackedSince !== input.untrackedSince ||
      ticket.binding.missionSignature !== codeReviewMissionSignature(input.mission) ||
      ticket.binding.executionScope.rootRealPath !== input.executionScope.rootRealPath)) {
      if (!await this.#retire(key, ticket)) return { kind: 'waiting', reason: 'A revisão anterior aguarda confirmação de saída física antes da próxima tentativa.' };
      return this.ensure(input, signal);
    }
    if (!ticket) {
      if (this.#tickets.size >= MAX_TICKETS) return { kind: 'waiting', reason: 'O registro de revisões aguarda liberação de missões encerradas.' };
      ticket = { retryAt: 0, controller: new AbortController(), binding: Object.freeze({ scope: Object.freeze({ ...input.scope }), executionScope: Object.freeze({ ...input.executionScope }),
        baseSha: input.baseSha, coverage: input.coverage, missionId: input.mission.id,
        // F-1301: every recapture of this ticket must cut the same delta.
        ...(input.untrackedSince !== undefined ? { untrackedSince: input.untrackedSince } : {}),
        intentVersion: input.mission.intentVersion ?? 0, fingerprint: input.candidate.fingerprint,
        headSha: input.candidate.headSha, missionSignature: codeReviewMissionSignature(input.mission),
        requiredPaths: Object.freeze([...(input.candidate.coveredPaths ?? input.candidate.changedPaths).filter(file => !input.candidate.deletedPaths.includes(file))]) }) };
      this.#tickets.set(key, ticket);
    }
    if (!this.#current(ticket)) { await this.#retire(key, ticket); return { kind: 'unavailable', reason: 'A autoridade da missão mudou antes da revisão.' }; }
    if (ticket.result) return ticket.result;
    if (ticket.pane && this.ports.isLive(ticket.pane.sessionId)) return { kind: 'waiting', reason: 'O revisor independente está verificando a entrega atual.' };
    if (ticket.pane) {
      if (this.ports.now() < ticket.retryAt) return { kind: 'waiting', reason: 'A CLI do revisor saiu; uma nova tentativa aguarda o intervalo de recuperação.' };
      if (!await this.#retire(key, ticket)) return { kind: 'waiting', reason: 'A saída física do revisor anterior ainda não foi confirmada.' };
      return this.ensure(input, signal);
    }
    if (!ticket.flight && this.ports.now() >= ticket.retryAt) {
      const owned = ticket;
      owned.lastInput = input;
      const cancelled = () => { owned.retiring = true; owned.controller.abort(); };
      signal?.addEventListener('abort', cancelled, { once: true });
      // Install ownership before any await so simultaneous completion calls
      // cannot allocate several reviewers for the same candidate.
      owned.flight = Promise.resolve().then(async () => {
        const seat = await this.ports.select(input, owned.controller.signal);
        if (!seat || !this.ports.isFrontier(seat)) { owned.failure = 'Nenhum revisor frontier elegível está disponível agora.'; return; }
        if (this.#tickets.get(key) !== owned || !this.#current(owned)) return;
        const pane = await this.ports.spawn(input, seat, owned.controller.signal);
        if (!pane) { owned.failure = 'O revisor aguarda capacidade, autenticação ou recuperação da CLI.'; return; }
        owned.pane = pane;
        if (pane.failure || this.#tickets.get(key) !== owned || !this.#current(owned)) {
          owned.failure = pane.failure ?? 'A autoridade mudou durante a abertura do revisor.';
          owned.retiring = true;
          return;
        }
        owned.failure = undefined;
      }).catch(() => { owned.failure = 'Não foi possível iniciar a revisão; a entrega foi preservada para nova tentativa.'; })
        .finally(() => {
          signal?.removeEventListener('abort', cancelled);
          owned.flight = undefined; owned.retryAt = this.ports.now() + RETRY_MS;
          if (!this.#current(owned)) { void this.#retire(key, owned); return; }
          // F-1261: wake coalescido no retryAt — missão de aba não tem watcher
          // periódico; sem este timer nada reconsulta retryAt e a missão fica
          // running até alguém mexer. Cancelado em #retire (troca de líder,
          // intenção ou encerramento).
          if (owned.wakeTimer) clearTimeout(owned.wakeTimer);
          owned.wakeTimer = setTimeout(() => {
            owned.wakeTimer = undefined;
            if (!this.#current(owned) || owned.result || owned.pane || owned.flight || !owned.lastInput) return;
            // setTimeout é monotônico e retryAt é relógio de parede: o timer pode
            // disparar um pouco antes do retryAt e o ensure voltaria `waiting`
            // sem ninguém rearmar. O próprio disparo É o prazo vencido.
            owned.retryAt = Math.min(owned.retryAt, this.ports.now());
            void this.ensure(owned.lastInput).catch(() => undefined);
          }, RETRY_MS);
          owned.wakeTimer.unref?.();
        });
    }
    await ticket.flight;
    if (this.#tickets.get(key) !== ticket || !this.#current(ticket)) return { kind: 'unavailable', reason: ticket.failure ?? 'A autoridade da missão mudou durante a revisão.' };
    return ticket.failure ? { kind: 'waiting', reason: ticket.failure }
      : { kind: 'waiting', reason: 'Revisão independente solicitada; aguarde a entrega do revisor.' };
  }

  async record(input: CodeReviewSubmission): Promise<CodeReviewRecordResult> {
    const key = missionLifecycleKey(input.scope, input.missionId);
    const ticket = this.#tickets.get(key);
    if (!ticket || ticket.pane?.sessionId !== input.sessionId) return { handled: false, accepted: false };
    if (!input.readOnly || !this.ports.isFrontier(input) || !this.#current(ticket)) {
      return { handled: true, accepted: false, reason: 'O revisor não possui a autoridade independente exigida.' };
    }
    const submissionKey = JSON.stringify([input.adapterId, input.model, input.verdict, input.summary, input.findings]);
    if (ticket.recording) return ticket.recording.key === submissionKey ? ticket.recording.flight
      : { handled: true, accepted: false, reason: 'Outro veredito desta sessão ainda está sendo registrado; tente novamente.' };
    const flight = this.#recordCurrent(key, ticket, input, submissionKey);
    ticket.recording = { key: submissionKey, flight };
    try { return await flight; } finally { if (ticket.recording?.flight === flight) ticket.recording = undefined; }
  }

  async #recordCurrent(key: string, ticket: Ticket, input: CodeReviewSubmission, submissionKey: string): Promise<CodeReviewRecordResult> {
    const candidate = await this.ports.capture(ticket.binding);
    if (this.#tickets.get(key) !== ticket || !this.#current(ticket) || !candidate.complete ||
      candidate.fingerprint !== ticket.binding.fingerprint || candidate.headSha !== ticket.binding.headSha) {
      return { handled: true, accepted: false, reason: 'O candidato mudou; este veredito não pode autorizar a conclusão.' };
    }
    if (ticket.result && ticket.submissionKey === submissionKey) return { handled: true, accepted: true, result: ticket.result };
    let result: Extract<MissionCodeReviewResult, { kind: 'reviewed' }> = Object.freeze({
      kind: 'reviewed', candidateFingerprint: candidate.fingerprint, baseSha: ticket.binding.baseSha, readOnly: true,
      verdict: Object.freeze({ verdictId: `code-review-${randomUUID()}`, missionId: input.missionId,
        headSha: candidate.headSha, treeDirty: input.treeDirty !== false,
        verdict: input.verdict, reviewerAdapter: input.adapterId, reviewerModel: input.model,
        reviewerSession: input.sessionId, frontier: true, findings: Object.freeze([...input.findings]),
        summary: input.summary, createdAt: this.ports.now() }),
    });
    if (this.ports.persist) {
      try { result = await this.ports.persist(ticket.binding, result); }
      catch { return { handled: true, accepted: false, reason: 'Não foi possível registrar a evidência durável; tente enviar o veredito novamente.' }; }
    }
    const fresh = await this.ports.capture(ticket.binding);
    if (this.#tickets.get(key) !== ticket || !this.#current(ticket) || !fresh.complete ||
        fresh.fingerprint !== ticket.binding.fingerprint || fresh.headSha !== ticket.binding.headSha) {
      return { handled: true, accepted: false, reason: 'A autoridade mudou durante o registro da revisão.' };
    }
    ticket.result = Object.freeze({ ...result, verdict: Object.freeze({ ...result.verdict, findings: Object.freeze([...result.verdict.findings]) }) });
    ticket.submissionKey = submissionKey;
    return { handled: true, accepted: true, result: ticket.result };
  }

  receipt(scope: ProjectExecutionScope, missionId: string): Readonly<{ binding: CodeReviewBinding; result: Reviewed }> | null {
    const ticket = this.#tickets.get(missionLifecycleKey(scope, missionId));
    return ticket && this.#current(ticket) && ticket.result
      ? Object.freeze({ binding: ticket.binding, result: ticket.result }) : null;
  }

  rejection(scope: ProjectExecutionScope, missionId: string): Readonly<{ binding: CodeReviewBinding; result: Reviewed }> | null {
    const receipt = this.receipt(scope, missionId);
    return receipt?.result.verdict.verdict === 'reject' ? receipt : null;
  }

  async forget(scope: ProjectExecutionScope, missionId: string): Promise<void> {
    const key = missionLifecycleKey(scope, missionId), ticket = this.#tickets.get(key);
    if (ticket) await this.#retire(key, ticket);
  }
}
