import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  formatClarifyForNativeSelector,
  parseClarifyAnswerArtifact,
  parseClarifyDismissArtifact,
  parseClarifyQuestionArtifact,
  resolveClarifyAnswer,
  type ClarifyAnswer,
  type Clarify,
  type ClarifyAnswerArtifact,
  type ClarifyAnswerInput,
  type ClarifyAnswerResult,
  type ClarifyQuestionArtifact,
  type DurableClarifyQuestion,
} from '../../shared/clarify';
import type { Handoff, Mission } from '../../shared/orch-types';
import {
  hasCurrentApprovedDispatchContract,
  hasCurrentDispatchAuthority,
} from '../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../shared/types';
import type { AgentGateContext } from './gate';
import { assertOrchestratorMission } from './gate';
import { requireMissionLeaderSession } from './mission-leader-gate';
import type { SubmitHandoffInput } from './handoff-store';
import type { MissionEngine } from './mission-engine';
import { missionEngineForScope } from './mission-engine-registry';
import { onHandoffSubmitted } from './idle-delivery';
import { getProjectDomainStores } from './project-domain-store-registry';
import { orchWriteSession } from '../pty/pty-manager';
import { wasMissionRuntimeClosedByOperator } from '../../shared/mission-recovery-policy';

const identifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
export const clarifyAnswerInputSchema = z
  .object({
    missionId: identifierSchema,
    questionId: identifierSchema,
    answer: z.string().trim().min(1).max(4_000).optional(),
    dismiss: z.literal(true).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.dismiss === true) return;
    if (!value.answer) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['answer'],
        message: 'resposta ausente',
      });
    }
  });

interface ClarifyStores {
  readonly missions: {
    get(id: string): Mission | null;
    transitionLifecycle?(
      id: string,
      expectation: { readonly updatedAt: number; readonly intentVersion: number },
      patch: { readonly status: Mission['status']; readonly intentState: NonNullable<Mission['intentState']> },
    ): Mission | null;
  };
  readonly handoffs: {
    submit(input: SubmitHandoffInput): Handoff;
    submitOperatorConfirmed(input: SubmitHandoffInput): Handoff;
    get(id: string): Handoff | null;
    list(filter?: {
      missionId?: string;
      includeDelivered?: boolean;
    }): Handoff[];
    markSubmitted(id: string): boolean;
    markConsumed(id: string, missionId: string): boolean;
  };
}

type DeliverClarifyAnswer = (
  handoff: Handoff,
  scope: ProjectExecutionScope,
) => unknown;

function activeMission(stores: ClarifyStores, missionId: string): Mission {
  const mission = stores.missions.get(missionId);
  if (!mission || mission.id !== missionId) {
    throw new Error('a missão da pergunta não existe neste workspace');
  }
  // Worker-decision blocks stay answerable: the clarify chips ARE the exit.
  if (
    mission.status === 'blocked' &&
    mission.intentState === 'blocked_user'
  ) {
    return mission;
  }
  if (mission.status !== 'pending' && mission.status !== 'running') {
    throw new Error(
      'a missão da pergunta já está encerrada; reabra a missão antes de responder',
    );
  }
  return mission;
}

function safeAgentLabel(ctx: Pick<AgentGateContext, 'agentName' | 'label'>): string {
  const label = (ctx.agentName ?? ctx.label)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, 256);
  return label || 'Orquestrador Nexus';
}

function questionArtifact(handoff: Handoff): ClarifyQuestionArtifact | null {
  for (const artifact of handoff.artifacts) {
    const parsed = parseClarifyQuestionArtifact(artifact);
    if (parsed) return parsed;
  }
  return null;
}

function answerArtifact(handoff: Handoff): ClarifyAnswerArtifact | null {
  // The durable store origin is selected by a dedicated main-only method after
  // native confirmation. Labels, missing session ids and artifacts are all
  // reporter-controlled and therefore never constitute human authority.
  if (handoff.authorityOrigin !== 'operator-confirmed') {
    return null;
  }
  for (const artifact of handoff.artifacts) {
    const parsed = parseClarifyAnswerArtifact(artifact);
    if (parsed) return parsed;
  }
  return null;
}

export interface ClarifyAnswerAuthorityCandidate {
  readonly missionId: string;
  readonly missionTitle: string;
  readonly intentVersion: number;
  readonly orchestratorSessionId: string;
  readonly questionId: string;
  readonly question: string;
  readonly chips: readonly { readonly id: string; readonly label: string }[];
  readonly allowFreeform: boolean;
  readonly answer: Exclude<ClarifyAnswer, { kind: 'unmatched' }>;
  /** Hash of scope + mission revision/session + durable question + answer. */
  readonly fence: string;
}

function resolveAnswerCandidate(
  stores: ClarifyStores,
  scope: ProjectExecutionScope,
  rawInput: ClarifyAnswerInput,
): {
  readonly input: z.infer<typeof clarifyAnswerInputSchema>;
  readonly mission: Mission;
  readonly question: Handoff;
  readonly clarify: Clarify;
  readonly answer: Exclude<ClarifyAnswer, { kind: 'unmatched' }>;
  readonly fence: string;
} {
  const input = clarifyAnswerInputSchema.parse(rawInput);
  const mission = activeMission(stores, input.missionId);
  const answerableState =
    (mission.status === 'running' &&
      ['dispatched', 'executing', 'validating'].includes(
        mission.intentState ?? '',
      )) ||
    (mission.status === 'blocked' &&
      mission.intentState === 'blocked_user');
  const hasAnswerAuthority =
    mission.status === 'blocked'
      ? hasCurrentApprovedDispatchContract(mission)
      : hasCurrentDispatchAuthority(mission);
  if (!hasAnswerAuthority || !answerableState) {
    throw new Error('a resposta exige a autoridade atual da missão');
  }
  const question = stores.handoffs.get(input.questionId);
  const clarify = question ? questionArtifact(question)?.clarify : undefined;
  if (!question || !clarify) {
    throw new Error('a pergunta não existe neste workspace');
  }
  if (question.missionId !== input.missionId) {
    throw new Error('a pergunta não pertence a esta missão');
  }
  if (!requireMissionLeaderSession(scope, mission.id, { sessionId: question.sessionId }).ok) {
    throw new Error(
      'a pergunta não pertence à sessão atual do orquestrador; reabra a missão',
    );
  }
  if (!input.answer) {
    throw new Error('resposta ausente');
  }
  const answer = resolveClarifyAnswer(clarify, input.answer);
  if (answer.kind === 'unmatched') {
    throw new Error('Escolha uma das opções exibidas para a missão continuar.');
  }
  const fence = createHash('sha256')
    .update(JSON.stringify({
      scope: {
        installationId: scope.installationId,
        projectId: scope.projectId,
        checkoutId: scope.checkoutId,
        rootRealPath: scope.rootRealPath,
      },
      mission: {
        id: mission.id,
        title: mission.title,
        status: mission.status,
        intentState: mission.intentState,
        intentVersion: mission.intentVersion,
        intentContract: mission.intentContract,
        orchestratorSessionId: mission.orchestratorSessionId,
      },
      question: {
        id: question.id,
        sessionId: question.sessionId,
        deliveryState: question.deliveryState,
        artifact: questionArtifact(question),
      },
      answer,
    }))
    .digest('hex');
  return { input, mission, question, clarify, answer, fence };
}

export function prepareClarifyAnswerAuthorityCandidate(
  stores: ClarifyStores,
  scope: ProjectExecutionScope,
  rawInput: ClarifyAnswerInput,
): ClarifyAnswerAuthorityCandidate {
  const resolved = resolveAnswerCandidate(stores, scope, rawInput);
  return Object.freeze({
    missionId: resolved.mission.id,
    missionTitle: resolved.mission.title,
    intentVersion: resolved.mission.intentVersion ?? 0,
    orchestratorSessionId: resolved.mission.orchestratorSessionId!,
    questionId: resolved.question.id,
    question: resolved.clarify.question,
    chips: Object.freeze(resolved.clarify.chips.map((chip) => Object.freeze({ ...chip }))),
    allowFreeform: resolved.clarify.allowFreeform,
    answer: Object.freeze({ ...resolved.answer }),
    fence: resolved.fence,
  });
}

function deliveryResult(
  missionId: string,
  questionId: string,
  handoff: Handoff,
  artifact: ClarifyAnswerArtifact,
): ClarifyAnswerResult {
  const accepted = handoff.deliveryState !== 'queued';
  return {
    ok: true,
    missionId,
    questionId,
    handoffId: handoff.id,
    answer: artifact.answer,
    deliveryState: handoff.deliveryState,
    accepted,
    cta: accepted
      ? 'Resposta entregue ao orquestrador.'
      : 'Resposta salva. Mantenha a missão aberta; o Nexus vai reenviar ao orquestrador.',
  };
}

function questionTextOf(handoff: Handoff): string | null {
  for (const raw of handoff.artifacts) {
    const parsed = parseClarifyQuestionArtifact(raw);
    if (parsed) return parsed.clarify.question;
  }
  return null;
}

function isClosedQuestion(
  handoffs: readonly Handoff[],
  questionId: string,
): 'answered' | 'dismissed' | null {
  for (const handoff of handoffs) {
    for (const raw of handoff.artifacts) {
      const answer = parseClarifyAnswerArtifact(raw);
      if (answer?.questionId === questionId) return 'answered';
      const dismiss = parseClarifyDismissArtifact(raw);
      if (dismiss?.questionId === questionId) return 'dismissed';
    }
  }
  return null;
}

function findReusableClarifyQuestion(
  stores: ClarifyStores,
  missionId: string,
  sessionId: string,
  question: string,
): DurableClarifyQuestion | null {
  const handoffs = stores.handoffs.list({
    missionId,
    includeDelivered: true,
  });
  const match = handoffs
    .filter(
      (handoff) =>
        handoff.missionId === missionId &&
        handoff.sessionId === sessionId &&
        questionTextOf(handoff) === question,
    )
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  if (!match) return null;
  const closed = isClosedQuestion(handoffs, match.id);
  if (closed === 'answered') return null;
  const artifact = match.artifacts
    .map((raw) => parseClarifyQuestionArtifact(raw))
    .find(Boolean);
  if (!artifact) return null;
  return {
    missionId,
    questionId: match.id,
    ...artifact.clarify,
  };
}

const forwardedNativeClarify = new Set<string>();

export function resetForwardedNativeClarifyForTests(): void {
  forwardedNativeClarify.clear();
}

export function forwardClarifyToNativeSelector(
  sessionId: string,
  clarify: Clarify,
): boolean {
  const key = `${sessionId}:${clarify.question}`;
  if (forwardedNativeClarify.has(key)) return false;
  const text = formatClarifyForNativeSelector(clarify);
  const ok = orchWriteSession(sessionId, `\x1b[200~${text}\x1b[201~`, {
    markInputBusy: false,
  });
  if (ok) forwardedNativeClarify.add(key);
  return ok;
}

/**
 * Persist the question before returning its MCP result. The question handoff
 * is marked submitted because its destination is the project-scoped renderer,
 * not the orchestrator PTY. Renderer hydration/broadcast reads the same
 * durable ledger after a reload. The same text is also forwarded once into
 * the CLI composer so Grok/Codex can show their native selector.
 */
export function persistClarifyQuestion(
  stores: ClarifyStores,
  ctx: AgentGateContext,
  clarify: Clarify,
  requestedMissionId = ctx.missionId,
): DurableClarifyQuestion {
  if (!requestedMissionId) {
    throw new Error(
      'nexus_clarify exige um orquestrador vinculado a uma missão',
    );
  }
  assertOrchestratorMission(ctx, requestedMissionId);
  const mission = activeMission(stores, requestedMissionId);
  if (
    !ctx.sessionId ||
    !requireMissionLeaderSession(ctx.scope, mission.id, { sessionId: ctx.sessionId }).ok
  ) {
    throw new Error(
      'a sessão do orquestrador está obsoleta; reabra a missão antes de perguntar',
    );
  }

  const reusable = findReusableClarifyQuestion(
    stores,
    requestedMissionId,
    ctx.sessionId,
    clarify.question,
  );
  if (reusable) {
    return reusable;
  }

  const artifact: ClarifyQuestionArtifact = {
    kind: 'nexus-clarify-question',
    schemaVersion: 1,
    clarify,
  };
  const handoff = stores.handoffs.submit({
    missionId: requestedMissionId,
    sessionId: ctx.sessionId,
    fromAgent: safeAgentLabel(ctx),
    status: 'progress',
    summary: `Pergunta ao operador: ${clarify.question}`,
    artifacts: [artifact],
    evidenceIds: [],
  });
  // A crash before this CAS is harmless: includeDelivered hydration still
  // projects the question, and answer persistence retries the CAS.
  stores.handoffs.markSubmitted(handoff.id);
  try {
    forwardClarifyToNativeSelector(ctx.sessionId, clarify);
  } catch {
    // Composer forward is best-effort; chips remain the durable path.
  }
  return {
    missionId: requestedMissionId,
    questionId: handoff.id,
    ...clarify,
  };
}

/** Production wrapper used by the MCP tool after its gate context is minted. */
export function emitClarifyQuestion(
  ctx: AgentGateContext,
  clarify: Clarify,
): DurableClarifyQuestion {
  if (!ctx.missionId) {
    throw new Error(
      'nexus_clarify exige um orquestrador vinculado a uma missão',
    );
  }
  return persistClarifyQuestion(
    getProjectDomainStores(ctx.scope),
    ctx,
    clarify,
    ctx.missionId,
  );
}

/**
 * Validate a renderer answer against the exact durable question, then persist
 * an idempotent response handoff before asking idle-delivery to inject it.
 * Scoped stores plus mission/question equality prevent cross-workspace and
 * cross-mission replies even if a renderer replays a stale id.
 */
export async function persistClarifyDismiss(
  stores: ClarifyStores,
  scope: ProjectExecutionScope,
  rawInput: ClarifyAnswerInput,
  _missionEngine: Pick<MissionEngine, 'command'> = missionEngineForScope(scope),
): Promise<ClarifyAnswerResult> {
  const input = clarifyAnswerInputSchema.parse(rawInput);
  if (input.dismiss !== true) {
    throw new Error('adiamento exige dismiss=true');
  }
  const mission = activeMission(stores, input.missionId);
  const question = stores.handoffs.get(input.questionId);
  const clarify = question ? questionArtifact(question)?.clarify : undefined;
  if (!question || !clarify) {
    throw new Error('a pergunta não existe neste workspace');
  }
  if (question.missionId !== input.missionId) {
    throw new Error('a pergunta não pertence a esta missão');
  }
  const handoffs = stores.handoffs.list({
    missionId: input.missionId,
    includeDelivered: true,
  });
  const existingDismiss = handoffs.find((handoff) =>
    handoff.artifacts.some((raw) => {
      const parsed = parseClarifyDismissArtifact(raw);
      return parsed?.questionId === input.questionId;
    }),
  );
  if (existingDismiss) {
    if (question.deliveryState !== 'consumed') {
      stores.handoffs.markConsumed(question.id, input.missionId);
    }
    return {
      ok: true,
      missionId: input.missionId,
      questionId: input.questionId,
      handoffId: existingDismiss.id,
      dismissed: true,
      deliveryState: existingDismiss.deliveryState,
      accepted: true,
      cta: 'Pergunta adiada. A missão segue sem resposta vazia.',
    };
  }
  if (isClosedQuestion(handoffs, input.questionId) === 'answered') {
    throw new Error('esta pergunta já recebeu outra resposta');
  }
  const dismiss = stores.handoffs.submit({
    missionId: input.missionId,
    fromAgent: 'Operador Nexus',
    status: 'progress',
    summary: `Operador adiou a pergunta "${clarify.question}" (agora não).`,
    artifacts: [
      {
        kind: 'nexus-clarify-dismiss',
        schemaVersion: 1,
        questionId: input.questionId,
      },
    ],
    evidenceIds: [],
  });
  if (question.deliveryState === 'queued') {
    stores.handoffs.markSubmitted(question.id);
  }
  if (question.deliveryState !== 'consumed') {
    stores.handoffs.markConsumed(question.id, input.missionId);
  }
  if (
    !wasMissionRuntimeClosedByOperator(mission) &&
    mission.status === 'blocked' &&
    mission.intentState === 'blocked_user' &&
    stores.missions.transitionLifecycle
  ) {
    stores.missions.transitionLifecycle(
      mission.id,
      {
        updatedAt: mission.updatedAt,
        intentVersion: mission.intentVersion ?? 0,
      },
      { status: 'running', intentState: 'executing' },
    );
  }
  return {
    ok: true,
    missionId: input.missionId,
    questionId: input.questionId,
    handoffId: dismiss.id,
    dismissed: true,
    deliveryState: dismiss.deliveryState,
    accepted: true,
    cta: 'Pergunta adiada. A missão segue sem resposta vazia.',
  };
}

export async function persistClarifyAnswer(
  stores: ClarifyStores,
  scope: ProjectExecutionScope,
  rawInput: ClarifyAnswerInput,
  expectedFence: string,
  deliver: DeliverClarifyAnswer = onHandoffSubmitted,
  missionEngine: Pick<MissionEngine, 'command'> = missionEngineForScope(scope),
): Promise<ClarifyAnswerResult> {
  const preview = clarifyAnswerInputSchema.parse(rawInput);
  if (preview.dismiss === true) {
    return persistClarifyDismiss(stores, scope, preview, missionEngine);
  }
  if (!/^[a-f0-9]{64}$/.test(expectedFence)) {
    throw new Error('confirmação humana ausente ou inválida');
  }
  const resolved = resolveAnswerCandidate(stores, scope, rawInput);
  if (resolved.fence !== expectedFence) {
    throw new Error('a missão, pergunta ou resposta mudou durante a confirmação');
  }
  const { input, question, clarify, answer } = resolved;

  // Recover idempotently after renderer retry or a crash between durable
  // response insertion and source-question consumption.
  const existing = stores.handoffs
    .list({ missionId: input.missionId, includeDelivered: true })
    .find((handoff) => {
      const artifact = answerArtifact(handoff);
      return artifact?.questionId === input.questionId;
    });
  if (existing) {
    const artifact = answerArtifact(existing);
    if (!artifact) throw new Error('resposta persistida inválida');
    if (
      artifact.answer.kind !== answer.kind ||
      artifact.answer.value !== answer.value
    ) {
      throw new Error('esta pergunta já recebeu outra resposta');
    }
    if (question.deliveryState === 'queued') {
      stores.handoffs.markSubmitted(question.id);
    }
    if (question.deliveryState !== 'consumed') {
      if (!stores.handoffs.markConsumed(question.id, input.missionId)) {
        throw new Error('a pergunta mudou enquanto a resposta era persistida');
      }
    }
    if (
      resolved.mission.status === 'blocked' &&
      resolved.mission.intentState === 'blocked_user'
    ) {
      await missionEngine.command(scope, {
        kind: 'answer-question',
        missionId: input.missionId,
        questionId: input.questionId,
        ...(answer.kind === 'chip'
          ? { optionId: answer.chipId }
          : { text: answer.value }),
      });
    }
    if (existing.deliveryState === 'queued') {
      // Idempotent enqueue also repairs a crash after durable insertion but
      // before the in-memory idle-delivery queue was populated.
      deliver(existing, scope);
    }
    const persisted = stores.handoffs.get(existing.id) ?? existing;
    return deliveryResult(
      input.missionId,
      input.questionId,
      persisted,
      artifact,
    );
  }

  if (question.deliveryState === 'consumed') {
    throw new Error('esta pergunta já foi respondida');
  }
  const artifact: ClarifyAnswerArtifact = {
    kind: 'nexus-clarify-answer',
    schemaVersion: 1,
    questionId: input.questionId,
    answer,
  };
  const response = stores.handoffs.submitOperatorConfirmed({
    missionId: input.missionId,
    fromAgent: 'Operador Nexus',
    status: 'progress',
    summary:
      `Resposta humana à pergunta "${clarify.question}": ${answer.value}. ` +
      'Use esta decisão na missão atual e não volte a perguntar sem novo conflito.',
    artifacts: [artifact],
    evidenceIds: [],
  });
  if (question.deliveryState === 'queued') {
    stores.handoffs.markSubmitted(question.id);
  }
  if (!stores.handoffs.markConsumed(question.id, input.missionId)) {
    throw new Error('a pergunta mudou enquanto a resposta era persistida');
  }
  if (
    resolved.mission.status === 'blocked' &&
    resolved.mission.intentState === 'blocked_user'
  ) {
    await missionEngine.command(scope, {
      kind: 'answer-question',
      missionId: input.missionId,
      questionId: input.questionId,
      ...(answer.kind === 'chip'
        ? { optionId: answer.chipId }
        : { text: answer.value }),
    });
  }
  deliver(response, scope);
  const persisted = stores.handoffs.get(response.id) ?? response;
  return deliveryResult(
    input.missionId,
    input.questionId,
    persisted,
    artifact,
  );
}
