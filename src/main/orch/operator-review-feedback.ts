import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  hasCurrentApprovedDispatchContract,
} from '../../shared/mission-intent';
import type {
  Handoff,
  Mission,
  OperatorReviewFeedbackInput,
  OperatorReviewFeedbackResult,
} from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type {
  ScopedHandoffStore,
  SubmitHandoffInput,
} from './handoff-store';
import { onHandoffSubmitted } from './idle-delivery';

const annotationPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    'caminho contém controle',
  )
  .refine(
    (value) => !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value),
    'caminho deve ser relativo ao workspace',
  )
  .refine(
    (value) =>
      !value
        .replace(/\\/g, '/')
        .split('/')
        .some((part) => part === '..'),
    'caminho não pode escapar do workspace',
  );

export const operatorReviewFeedbackInputSchema = z
  .object({
    missionId: z.string().min(1).max(128),
    annotations: z
      .array(
        z
          .object({
            path: annotationPathSchema,
            line: z.number().int().positive().max(10_000_000),
            body: z
              .string()
              .trim()
              .min(1)
              .max(4_000)
              .refine(
                (value) =>
                  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
                'comentário contém controle',
              ),
          })
          .strict(),
      )
      .min(1)
      .max(256),
  })
  .strict();

interface OperatorReviewStores {
  readonly missions: Pick<{ get(id: string): Mission | null }, 'get'>;
  readonly handoffs: Pick<
    ScopedHandoffStore,
    'submitOperatorConfirmed' | 'get' | 'list'
  >;
}

type DeliverReview = (
  handoff: Handoff,
  scope: ProjectExecutionScope,
) => unknown;

function feedbackSummary(input: OperatorReviewFeedbackInput): string {
  const comments = input.annotations.map(
    (annotation, index) =>
      `${index + 1}. ${annotation.path}:${annotation.line} — ${annotation.body}`,
  );
  return (
    `Revisão humana durável (${input.annotations.length} ` +
    `${input.annotations.length === 1 ? 'comentário' : 'comentários'}). ` +
    'Trate cada item como instrução de correção, delegue ao worker responsável ' +
    'pelo dispatcher Nexus e só conclua depois de validar o novo diff. ' +
    comments.join(' ')
  ).slice(0, 65_536);
}

export interface OperatorReviewAuthorityCandidate {
  readonly missionId: string;
  readonly missionTitle: string;
  readonly intentVersion: number;
  readonly orchestratorSessionId: string;
  readonly annotations: OperatorReviewFeedbackInput['annotations'];
  /** Hash of scope + current approved mission/session + exact annotations. */
  readonly fence: string;
}

function resolveReviewCandidate(
  stores: OperatorReviewStores,
  scope: ProjectExecutionScope,
  rawInput: unknown,
): {
  readonly input: OperatorReviewFeedbackInput;
  readonly mission: Mission;
  readonly fence: string;
} {
  const input = operatorReviewFeedbackInputSchema.parse(rawInput);
  const mission = stores.missions.get(input.missionId);
  if (!mission || mission.id !== input.missionId) {
    throw new Error('missão da revisão não existe neste workspace');
  }
  if (mission.status !== 'running') {
    throw new Error(
      'a revisão só pode ser entregue enquanto a missão está em execução; ' +
        'reabra a missão ou crie uma nova correção',
    );
  }
  if (!hasCurrentApprovedDispatchContract(mission)) {
    throw new Error('a revisão exige a versão atual da missão aprovada');
  }
  if (!mission.orchestratorSessionId) {
    throw new Error('a revisão exige a sessão atual do orquestrador');
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
      annotations: input.annotations,
    }))
    .digest('hex');
  return { input, mission, fence };
}

export function prepareOperatorReviewAuthorityCandidate(
  stores: OperatorReviewStores,
  scope: ProjectExecutionScope,
  rawInput: unknown,
): OperatorReviewAuthorityCandidate {
  const resolved = resolveReviewCandidate(stores, scope, rawInput);
  return Object.freeze({
    missionId: resolved.mission.id,
    missionTitle: resolved.mission.title,
    intentVersion: resolved.mission.intentVersion ?? 0,
    orchestratorSessionId: resolved.mission.orchestratorSessionId!,
    annotations: Object.freeze(
      resolved.input.annotations.map((annotation) => Object.freeze({ ...annotation })),
    ),
    fence: resolved.fence,
  });
}

/**
 * Persist human diff feedback as a non-terminal handoff before any TUI write.
 * The regular idle-delivery transport supplies finite acceptance/retry proof;
 * the renderer never gets authority to type into a running mission directly.
 */
export function persistOperatorReviewFeedback(
  stores: OperatorReviewStores,
  scope: ProjectExecutionScope,
  rawInput: unknown,
  expectedFence: string,
  deliver: DeliverReview = onHandoffSubmitted,
): OperatorReviewFeedbackResult {
  if (!/^[a-f0-9]{64}$/.test(expectedFence)) {
    throw new Error('confirmação humana ausente ou inválida');
  }
  const resolved = resolveReviewCandidate(stores, scope, rawInput);
  if (resolved.fence !== expectedFence) {
    throw new Error('a missão ou revisão mudou durante a confirmação');
  }
  const { input } = resolved;

  const existing = stores.handoffs
    .list({ missionId: input.missionId, includeDelivered: true })
    .find((handoff) =>
      handoff.authorityOrigin === 'operator-confirmed' &&
      handoff.artifacts.some((artifact) => {
        if (!artifact || typeof artifact !== 'object') return false;
        const candidate = artifact as { kind?: unknown; reviewId?: unknown };
        return candidate.kind === 'nexus-diff-review' &&
          candidate.reviewId === expectedFence;
      }),
    );
  if (existing) {
    if (existing.deliveryState === 'queued') deliver(existing, scope);
    const persisted = stores.handoffs.get(existing.id) ?? existing;
    return {
      ok: true,
      handoffId: existing.id,
      deliveryState: persisted.deliveryState,
    };
  }

  const handoff = stores.handoffs.submitOperatorConfirmed({
    status: 'progress',
    missionId: input.missionId,
    fromAgent: 'Operador Nexus',
    summary: feedbackSummary(input),
    artifacts: [
      {
        kind: 'nexus-diff-review',
        schemaVersion: 1,
        reviewId: expectedFence,
        annotations: input.annotations.map((annotation) => ({ ...annotation })),
      },
    ],
    evidenceIds: [],
  } satisfies SubmitHandoffInput);
  deliver(handoff, scope);
  const persisted = stores.handoffs.get(handoff.id) ?? handoff;
  return {
    ok: true,
    handoffId: handoff.id,
    deliveryState: persisted.deliveryState,
  };
}
