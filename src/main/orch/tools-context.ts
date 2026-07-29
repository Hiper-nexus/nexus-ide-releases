import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  getContextKnowledgeService,
  getContextWorkflowService,
} from '../context/context-workflow-registry';
import { workflowStageSchema } from '../context/contract-compiler';
import {
  assertMcpInvocationCurrent,
  type McpToolDef,
  type McpToolInvocation,
} from './mcp-protocol';
import type { AgentGateContext } from './gate';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { assertMainTaskDispatcherAuthority } from './task-dispatch-authority';
import { automatedReviewSessions } from '../context/automated-review-session';
import {
  normalizeWorkflowIdentity,
} from '../context/context-workflow-service';
import {
  assertOrchestratorMission,
  executionScopeFor,
  getContextBySession,
  rotateContextRevisionAuthority,
} from './gate';
import { MergeValidationCoordinator } from '../context/merge-validation-coordinator';
import { getProjectDomainStores } from './project-domain-store-registry';
import { CliContextDraftReviewer } from '../context/cli-context-draft-reviewer';
import { inspectConfiguredNexusReadiness } from '../runtime/nexus-doctor';
import {
  runContextBootstrapAutopilot,
  type ContextBootstrapAutopilotResult,
} from '../context/context-bootstrap-autopilot';
import { bindFreezeDraftToApprovedIntent } from './mission-freeze-authority';
import { getAgentSessionInfo } from '../pty/pty-manager';
import { requestPaneClose } from './pane-registry';
import { getSquad } from './squad-store';
import {
  resolveMissionPaneAuthoritySeal,
  sameMissionPaneAuthoritySeal,
} from './mission-pane-authority';
import { hasCurrentDispatchAuthority } from '../../shared/mission-intent';
import {
  drivePrevcAutopilot,
  runPrevcCouncilReview,
  runPrevcFinalValidation,
} from './prevc-autopilot-coordinator';
import { ensurePrevcMergeReady } from './prevc-merge-preparation';

// Doctor is an idempotent project operation, not a fan-out primitive. Several
// model retries used to launch independent reviewers for the same drafts.
const contextDoctorFlights = new Map<
  string,
  Promise<ContextBootstrapAutopilotResult>
>();

function contextDoctorCheckoutKey(ctx: AgentGateContext): string {
  return [
    ctx.scope.installationId,
    ctx.scope.projectId,
    ctx.scope.checkoutId,
    ctx.scope.rootRealPath,
  ].join('\0');
}

function contextDoctorScopeKey(ctx: AgentGateContext): string {
  return `${contextDoctorCheckoutKey(ctx)}\0${ctx.missionId ?? ''}`;
}

function hasContextDoctorFlightForCheckout(ctx: AgentGateContext): boolean {
  const prefix = `${contextDoctorCheckoutKey(ctx)}\0`;
  return [...contextDoctorFlights.keys()].some((key) => key.startsWith(prefix));
}

const identifier = z.string().trim().min(1).max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
function normalizeCompatibleIdentifier(value: string, prefix: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(normalized)) return normalized;
  const slug = normalized
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+$/g, '')
    .slice(0, 160);
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(slug)) return slug;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${prefix}-${digest}`;
}

function compatibleIdentifier(prefix: string) {
  return z.string().trim().min(1).max(4_096)
    .transform((value) => normalizeCompatibleIdentifier(value, prefix));
}

const criterionSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  const { description, ...rest } = raw;
  return {
    ...rest,
    statement:
      typeof rest.statement === 'string' ? rest.statement : description,
  };
}, z
  .object({
    // Models frequently provide a valid checklist but omit bookkeeping ids.
    // The id is not business authority, so Nexus may derive it deterministically.
    id: identifier.optional(),
    statement: z.string().trim().min(1).max(4_096),
    requiredSensorIds: z.array(identifier).max(64).default([]),
    invariantRefs: z.array(identifier).max(64).default([]),
    requiredArtifactIds: z.array(compatibleIdentifier('artifact')).max(64).default([]),
  })
  .strict());
const freezeSchema = z
  .object({
    missionId: identifier,
    goal: z.string().trim().min(1).max(16_384),
    nonGoals: z.array(z.string().trim().min(1).max(4_096)).max(256).default([]),
    acceptanceCriteria: z.array(criterionSchema).min(1).max(256),
    businessInvariantRefs: z.array(identifier).max(256).default([]),
    impactedDomains: z.array(identifier).max(256).default([]),
    impactedSymbols: z.array(z.string().trim().min(1).max(512)).max(1_024).default([]),
    requestedSensors: z.array(identifier).max(256).default([]),
    requiredArtifacts: z.array(compatibleIdentifier('artifact')).max(256).default([]),
    riskHints: z.array(z.string().trim().min(1).max(256)).max(256).default([]),
  })
  .strict();
const findingSchema = z
  .object({
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    category: z.enum(['correctness', 'business', 'security', 'data', 'performance', 'ux']),
    file: z.string().trim().min(1).max(4_096),
    line: z.number().int().positive().optional(),
    criterionRefs: z.array(identifier).max(256).default([]),
    invariantRefs: z.array(identifier).max(256).default([]),
    evidence: z.string().trim().min(1).max(65_536),
    recommendation: z.string().trim().min(1).max(65_536),
  })
  .strict();
const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
// sourceHash opcional: agentes hospedados não têm tool de hash — o Nexus
// computa o sha256 do arquivo no propose e re-verifica em review/apply.
// Hash fornecido é afirmação de conteúdo exato (divergência rejeita).
const contextSourceSchema = z.object({
  type: z.enum(['file', 'git', 'test', 'schema', 'connector', 'decision']),
  locator: z.string().trim().min(1).max(4_096),
  sourceHash: contentHashSchema.optional(),
}).strict();

function missionIdentity(ctx: AgentGateContext) {
  if (!ctx.sessionId) throw new Error('workflow action requires a bound agent session');
  return {
    id: ctx.agentName ?? ctx.label,
    sessionId: ctx.sessionId,
    provider: ctx.providerId ?? ctx.label,
  };
}

function assertMission(ctx: AgentGateContext, requested: string): void {
  if (ctx.missionId && ctx.missionId !== requested) {
    throw new Error('not authorized: workflow mission differs from session mission');
  }
  if (!ctx.missionId && ctx.role !== 'user') {
    throw new Error('not authorized: agent session is not bound to a mission');
  }
}

function sameProjectScope(
  left: Readonly<AgentGateContext['scope']>,
  right: Readonly<AgentGateContext['scope']>,
): boolean {
  return left.version === right.version &&
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath;
}

/**
 * Manual/recovery merge tools are a legacy shell around MergeQueue. Bind that
 * shell to the exact live orchestrator pane and approved intent so the queue's
 * post-await authority checkpoints and rollback path are never optional.
 */
function captureManualMergeAuthority(
  ctx: AgentGateContext,
  missionId: string,
  operation: 'nexus_merge_task' | 'nexus_merge_retry',
): () => void {
  assertOrchestratorMission(ctx, missionId);
  const sessionId = ctx.sessionId;
  if (!sessionId) throw new Error('merge authority requires a bound session');
  const stores = getProjectDomainStores(ctx.scope);
  assertMainTaskDispatcherAuthority(stores, missionId, operation);
  const mission = stores.missions.get(missionId);
  const squad = mission?.squadId ? getSquad(mission.squadId) : null;
  const live = getAgentSessionInfo(sessionId);
  const pane = live?.paneId
    ? stores.missionPanes.findByPaneId(live.paneId)
    : null;
  const seal = mission && squad
    ? resolveMissionPaneAuthoritySeal(ctx.scope, mission, squad)
    : null;
  const gate = getContextBySession(sessionId);
  if (
    !mission ||
    !hasCurrentDispatchAuthority(mission) ||
    mission.orchestratorSessionId !== sessionId ||
    !live ||
    live.role !== 'orchestrator' ||
    live.missionId !== missionId ||
    !live.paneId ||
    !sameProjectScope(live.scope, ctx.scope) ||
    !pane ||
    pane.missionId !== missionId ||
    pane.role !== 'orchestrator' ||
    pane.paneId !== live.paneId ||
    !sameMissionPaneAuthoritySeal(pane.authoritySeal, seal) ||
    !gate ||
    gate.token !== ctx.token ||
    gate.role !== 'orchestrator' ||
    gate.missionId !== missionId ||
    !sameProjectScope(gate.scope, ctx.scope)
  ) {
    throw new Error('merge authority requires the exact current sealed orchestrator');
  }
  const intentVersion = mission.intentVersion ?? 0;
  const paneId = live.paneId;
  const expectedSeal = pane.authoritySeal;
  const expectedContextRevision = ctx.contextRevision;

  return () => {
    const currentStores = getProjectDomainStores(ctx.scope);
    const currentMission = currentStores.missions.get(missionId);
    const currentSquad = currentMission?.squadId
      ? getSquad(currentMission.squadId)
      : null;
    const currentLive = getAgentSessionInfo(sessionId);
    const currentPane = currentStores.missionPanes.findByPaneId(paneId);
    const currentSeal = currentMission && currentSquad
      ? resolveMissionPaneAuthoritySeal(ctx.scope, currentMission, currentSquad)
      : null;
    const currentGate = getContextBySession(sessionId);
    if (
      !currentMission ||
      !hasCurrentDispatchAuthority(currentMission) ||
      (currentMission.intentVersion ?? 0) !== intentVersion ||
      currentMission.orchestratorSessionId !== sessionId ||
      !currentLive ||
      currentLive.paneId !== paneId ||
      currentLive.role !== 'orchestrator' ||
      currentLive.missionId !== missionId ||
      !sameProjectScope(currentLive.scope, ctx.scope) ||
      !currentPane ||
      currentPane.missionId !== missionId ||
      currentPane.role !== 'orchestrator' ||
      !sameMissionPaneAuthoritySeal(currentPane.authoritySeal, expectedSeal) ||
      !sameMissionPaneAuthoritySeal(currentPane.authoritySeal, currentSeal) ||
      !currentGate ||
      currentGate.token !== ctx.token ||
      currentGate.role !== 'orchestrator' ||
      currentGate.missionId !== missionId ||
      currentGate.contextRevision !== expectedContextRevision ||
      !sameProjectScope(currentGate.scope, ctx.scope)
    ) {
      throw new Error('merge authority revoked: mission, session or seal changed');
    }
    assertMainTaskDispatcherAuthority(currentStores, missionId, operation);
  };
}

/**
 * Freeze/refreeze rotates only the live orchestrator onto the new PREVC
 * binding. Existing workers retain their prior seal and their processes are
 * revoked; continuing implementation requires a fresh route/spawn under the
 * new contract. A legacy/unsealed orchestrator is never upgraded here.
 */
async function rotateMissionPaneWorkflowAuthority(
  ctx: AgentGateContext,
  missionId: string,
  assertCurrentAuthority: () => void = () => {},
): Promise<void> {
  assertCurrentAuthority();
  const suite = getProjectDomainStores(ctx.scope);
  const panes = suite.missionPanes.list(missionId);
  if (panes.length === 0) return;
  if (ctx.role !== 'orchestrator' || !ctx.sessionId) {
    throw new Error(
      'workflow authority rotation requires the live mission orchestrator',
    );
  }
  const mission = suite.missions.get(missionId);
  const squad = mission?.squadId ? getSquad(mission.squadId) : null;
  const nextSeal =
    mission && squad
      ? resolveMissionPaneAuthoritySeal(ctx.scope, mission, squad)
      : null;
  const live = getAgentSessionInfo(ctx.sessionId);
  const orchestratorPane =
    live?.missionId === missionId &&
    live.role === 'orchestrator' &&
    live.paneId
      ? suite.missionPanes.findByPaneId(live.paneId)
      : null;
  if (
    !nextSeal ||
    !orchestratorPane ||
    orchestratorPane.missionId !== missionId ||
    orchestratorPane.role !== 'orchestrator' ||
    !orchestratorPane.authoritySeal ||
    !orchestratorPane.paneId
  ) {
    throw new Error(
      'exact sealed orchestrator pane is unavailable for workflow rotation',
    );
  }
  assertCurrentAuthority();
  suite.missionPanes.rebindOrchestratorAuthority({
    missionId,
    paneId: orchestratorPane.paneId,
    expectedAuthoritySeal: orchestratorPane.authoritySeal,
    authoritySeal: nextSeal,
  });

  for (const pane of panes) {
    if (
      pane.role === 'worker' &&
      !sameMissionPaneAuthoritySeal(pane.authoritySeal, nextSeal) &&
      pane.paneId
    ) {
      assertCurrentAuthority();
      if (!(await requestPaneClose(pane.paneId))) {
        throw new Error(
          `worker pane ${pane.paneId} did not produce physical exit proof`,
        );
      }
      assertCurrentAuthority();
    }
  }
}

function invocationAuthority(
  invocation?: McpToolInvocation,
): () => void {
  return () => assertMcpInvocationCurrent(invocation);
}

function markMergedTaskDone(
  ctx: AgentGateContext,
  taskId: string,
): void {
  const updated = getProjectDomainStores(ctx.scope).tasks.update(
    taskId,
    { status: 'done' },
  );
  if (!updated) {
    throw new Error(`integrated task ${taskId} disappeared`);
  }
}

const doctorTool: McpToolDef = {
  name: 'nexus_context_doctor',
  description:
    'Fail-closed project readiness + autonomous bootstrap pilot. Warms the structural map, scaffolds .context, proposes source-bound drafts, and when an independent provider quorum exists runs review→apply→commit without self-approval. Workers get a read-only readiness report only.',
  inputSchema: {
    type: 'object',
    properties: {
      autoReview: {
        type: 'boolean',
        description: 'Run independent draft review when quorum exists (default true for orchestrator).',
      },
      autoCommit: {
        type: 'boolean',
        description: 'Commit applied drafts when readiness is green (default true).',
      },
    },
  },
  handler: async (args, ctx, invocation) => {
    assertMcpInvocationCurrent(invocation);
    const input = z
      .object({
        autoReview: z.boolean().optional(),
        autoCommit: z.boolean().optional(),
      })
      .strict()
      .parse(args ?? {});

    // Workers only observe — never mutate authority.
    if (ctx.role === 'worker') {
      const readiness = getContextWorkflowService(ctx.scope).inspectReadiness();
      return Object.freeze({
        ...readiness,
        phase: readiness.ready ? 'ready' : 'blocked',
        orientation: null,
        bootstrapProposals: Object.freeze([]),
        proposedDraftIds: Object.freeze([]),
        draftOutcomes: Object.freeze([]),
        appliedDraftIds: Object.freeze([]),
        rejectedDraftIds: Object.freeze([]),
        commitSha: null,
        quorumAvailable: false,
        autopilotHint: readiness.ready
          ? 'Context ready (worker observation only).'
          : 'Context not ready. Orchestrator must run bootstrap pilot.',
      });
    }

    const key = contextDoctorScopeKey(ctx);
    let flight = contextDoctorFlights.get(key);
    if (!flight) {
      flight = runContextBootstrapAutopilot({
        scope: ctx.scope,
        author: missionIdentity(ctx),
        missionId: ctx.missionId ?? null,
        autoReview: input.autoReview,
        autoCommit: input.autoCommit,
        signal: invocation?.signal,
      }).finally(() => {
        if (contextDoctorFlights.get(key) === flight) {
          contextDoctorFlights.delete(key);
        }
      });
      contextDoctorFlights.set(key, flight);
    }
    const result = await flight;
    assertMcpInvocationCurrent(invocation);
    return Object.freeze({
      ...result.readiness,
      phase: result.phase,
      orientation: result.orientation,
      bootstrapProposals: result.bootstrapProposals,
      proposedDraftIds: result.proposedDraftIds,
      draftOutcomes: result.draftOutcomes,
      appliedDraftIds: result.appliedDraftIds,
      rejectedDraftIds: result.rejectedDraftIds,
      commitSha: result.commitSha,
      blockingError: result.blockingError,
      quorumAvailable: result.quorumAvailable,
      autopilotHint: result.autopilotHint,
    });
  },
};

const systemDoctorTool: McpToolDef = {
  name: 'nexus_system_doctor',
  description:
    'Fail-closed operational readiness for this computer and checkout: Git, project identity, SQLite, context, sensors, sandbox, reviewer quorum, multi-PC backend and filesystem.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => inspectConfiguredNexusReadiness(ctx.scope),
};

const scaffoldTool: McpToolDef = {
  name: 'nexus_context_scaffold',
  description:
    'Create the safe .context directory/config scaffold. It never fabricates business facts or documentation.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    if (ctx.role === 'worker') throw new Error('workers cannot modify context authority');
    return getContextWorkflowService(ctx.scope).scaffold();
  },
};

const contextDraftProposeTool: McpToolDef = {
  name: 'nexus_context_draft_propose',
  description:
    'Propose a source-bound business/technical context document or structured fact. This records a draft only; it cannot write authority before independent review. Nexus computes sourceHash/expectedTargetHash from the workspace when omitted — you never need a hashing tool.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: { type: 'string' },
      targetPath: { type: 'string' },
      content: { type: 'string' },
      expectedTargetHash: {
        type: ['string', 'null'],
        description:
          'Optional CAS: omit to bind to the current target state (Nexus observes it); null asserts the target must not exist; a sha256 asserts the exact expected state.',
      },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['file', 'git', 'test', 'schema', 'connector', 'decision'],
            },
            locator: { type: 'string' },
            sourceHash: {
              type: 'string',
              description:
                'Optional sha256 of the source file. Omit it — Nexus hashes the workspace file itself and re-verifies at review/apply.',
            },
          },
          required: ['type', 'locator'],
        },
      },
    },
    required: ['targetPath', 'content', 'sources'],
  },
  handler: async (args, ctx) => {
    const input = z.object({
      missionId: identifier.optional(),
      targetPath: z.string().trim().min(1).max(4_096),
      content: z.string().min(1).max(1024 * 1024),
      expectedTargetHash: contentHashSchema.nullable().optional(),
      sources: z.array(contextSourceSchema).min(1).max(256),
    }).strict().parse(args);
    const missionId = input.missionId ?? ctx.missionId;
    if (missionId) assertMission(ctx, missionId);
    return getContextKnowledgeService(ctx.scope).propose({
      ...input,
      missionId,
    }, missionIdentity(ctx));
  },
};

const contextDraftGetTool: McpToolDef = {
  name: 'nexus_context_draft_get',
  description: 'Read one source-bound context proposal and its trusted lifecycle state.',
  inputSchema: {
    type: 'object',
    properties: { draftId: { type: 'string' } },
    required: ['draftId'],
  },
  handler: async (args, ctx) => {
    const draftId = identifier.parse(args.draftId);
    const draft = getContextKnowledgeService(ctx.scope).get(draftId);
    if (!draft) throw new Error('context draft not found');
    if (draft.missionId) assertMission(ctx, draft.missionId);
    return draft;
  },
};

const contextDraftListTool: McpToolDef = {
  name: 'nexus_context_draft_list',
  description:
    'List durable context drafts and their IDs/status so an interrupted Doctor run can resume deterministically.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['proposed', 'approved', 'applied', 'rejected'],
      },
    },
  },
  handler: async (args, ctx) => {
    const input = z.object({
      status: z.enum(['proposed', 'approved', 'applied', 'rejected']).optional(),
    }).strict().parse(args ?? {});
    return getContextKnowledgeService(ctx.scope)
      .list(input)
      .filter(
        (draft) =>
          draft.missionId === null ||
          ctx.missionId === undefined ||
          draft.missionId === ctx.missionId,
      )
      .map((draft) => ({
        id: draft.id,
        missionId: draft.missionId,
        targetPath: draft.targetPath,
        status: draft.status,
        authorProvider: draft.author.provider,
        reviewerProvider: draft.reviewer?.provider ?? null,
        updatedAt: draft.updatedAt,
      }));
  },
};

const contextDraftReviewTool: McpToolDef = {
  name: 'nexus_context_draft_review',
  description:
    'Approve or reject a context proposal as an independent reviewer. Nexus re-hashes every source and the target before accepting approval.',
  inputSchema: {
    type: 'object',
    properties: {
      draftId: { type: 'string' },
      decision: { type: 'string', enum: ['approve', 'reject'] },
      rationale: { type: 'string' },
    },
    required: ['draftId', 'decision', 'rationale'],
  },
  handler: async (args, ctx) => {
    const input = z.object({
      draftId: identifier,
      decision: z.enum(['approve', 'reject']),
      rationale: z.string().trim().min(1).max(65_536),
    }).strict().parse(args);
    const service = getContextKnowledgeService(ctx.scope);
    const draft = service.get(input.draftId);
    if (!draft) throw new Error('context draft not found');
    if (draft.missionId) assertMission(ctx, draft.missionId);
    return service.review(input.draftId, {
      decision: input.decision,
      rationale: input.rationale,
      reviewer: missionIdentity(ctx),
    });
  },
};

const contextDraftApplyTool: McpToolDef = {
  name: 'nexus_context_draft_apply',
  description:
    'Atomically materialize an independently approved context proposal and its portable attestation. Executors cannot call this authority transition.',
  inputSchema: {
    type: 'object',
    properties: { draftId: { type: 'string' } },
    required: ['draftId'],
  },
  handler: async (args, ctx) => {
    if (ctx.role === 'worker') throw new Error('only an orchestrator can apply context authority');
    const draftId = identifier.parse(args.draftId);
    const service = getContextKnowledgeService(ctx.scope);
    const draft = service.get(draftId);
    if (!draft) throw new Error('context draft not found');
    if (draft.missionId) assertMission(ctx, draft.missionId);
    return service.apply(draftId);
  },
};

const contextDraftSupersedeTool: McpToolDef = {
  name: 'nexus_context_draft_supersede',
  description:
    'Escape hatch for a wedged context pipeline: when draft_propose reports ' +
    '"an active context draft already exists" but draft_list shows nothing ' +
    '(an orphan draft from another mission holds the target), supersede that ' +
    'active draft by TARGET so a fresh proposal can proceed. Orchestrator-only.',
  inputSchema: {
    type: 'object',
    properties: { targetPath: { type: 'string' } },
    required: ['targetPath'],
  },
  handler: async (args, ctx) => {
    if (ctx.role === 'worker') {
      throw new Error('only an orchestrator can supersede context authority');
    }
    const targetPath = z.string().trim().min(1).max(1024).parse(args.targetPath);
    const service = getContextKnowledgeService(ctx.scope);
    const superseded = service.supersedeActiveForTarget(targetPath);
    if (!superseded) {
      return { superseded: false, targetPath };
    }
    return {
      superseded: true,
      targetPath,
      draftId: superseded.id,
      previousMissionId: superseded.missionId,
    };
  },
};

const contextDraftReviewRunTool: McpToolDef = {
  name: 'nexus_context_draft_review_run',
  description:
    'Autonomously select and launch a read-only identity/session-independent reviewer. Approved drafts are atomically materialized by Nexus; rejected drafts remain rejected.',
  inputSchema: {
    type: 'object',
    properties: { draftId: { type: 'string' } },
    required: ['draftId'],
  },
  handler: async (args, ctx, invocation) => {
    if (ctx.role === 'worker') {
      throw new Error('only an orchestrator can launch autonomous context review');
    }
    if (hasContextDoctorFlightForCheckout(ctx)) {
      return Object.freeze({
        reviewed: null,
        applied: null,
        pending: true,
        reason:
          'A bounded nexus_context_doctor review pass is already active for this checkout. ' +
          'Wait for it and call nexus_context_doctor again if drafts remain; no duplicate review was queued.',
      });
    }
    const draftId = identifier.parse(args.draftId);
    const service = getContextKnowledgeService(ctx.scope);
    const draft = service.get(draftId);
    if (!draft) throw new Error('context draft not found');
    if (draft.missionId) assertMission(ctx, draft.missionId);
    let reviewed;
    try {
      reviewed = await new CliContextDraftReviewer().run({
        scope: ctx.scope,
        draftId,
        invocation,
      });
      assertMcpInvocationCurrent(invocation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/timed out/i.test(message)) throw error;
      assertMcpInvocationCurrent(invocation);
      // O pane revisor sobrevive ao poll inicial (semântica de recuperação de
      // mission-pane) e persiste o veredito via nexus_context_draft_review
      // quando terminar. Timeout aqui é revisão EM ANDAMENTO, não falha —
      // reportar erro fazia o orquestrador desistir de um review saudável.
      const current = service.get(draftId);
      return Object.freeze({
        reviewed: null,
        applied: current?.status === 'approved' ? service.apply(draftId) : null,
        pending: !current || current.status === 'proposed',
        status: current?.status ?? 'proposed',
        reason:
          'Reviewer pane is still working past the initial poll window; it stays ' +
          'alive and will persist its verdict. Poll nexus_context_draft_get and ' +
          'call nexus_context_draft_apply once approved.',
      });
    }
    if (reviewed.status === 'approved') {
      assertMcpInvocationCurrent(invocation);
      return Object.freeze({ reviewed, applied: service.apply(draftId) });
    }
    return Object.freeze({ reviewed, applied: null });
  },
};

const contextCommitTool: McpToolDef = {
  name: 'nexus_context_commit',
  description:
    'Commit the exact complete set of independently reviewed context files and attestations. Fails closed on incomplete context, extra files, uncommitted sources or pre-staged code.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    if (ctx.role === 'worker') throw new Error('only an orchestrator can commit context authority');
    return getContextKnowledgeService(ctx.scope).commitApplied();
  },
};

const freezeTool: McpToolDef = {
  name: 'nexus_mission_freeze_contract',
  description:
    'Compile and freeze the mission contract against the current committed context, Git base, invariants and declarative sensors. Must happen before coding.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: { type: 'string' },
      goal: { type: 'string' },
      nonGoals: { type: 'array', items: { type: 'string' } },
      acceptanceCriteria: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            statement: { type: 'string' },
            description: {
              type: 'string',
              description: 'Legacy alias for statement; prefer statement.',
            },
            requiredSensorIds: { type: 'array', items: { type: 'string' } },
            invariantRefs: { type: 'array', items: { type: 'string' } },
            requiredArtifactIds: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
      },
      businessInvariantRefs: { type: 'array', items: { type: 'string' } },
      impactedDomains: { type: 'array', items: { type: 'string' } },
      impactedSymbols: { type: 'array', items: { type: 'string' } },
      requestedSensors: { type: 'array', items: { type: 'string' } },
      requiredArtifacts: { type: 'array', items: { type: 'string' } },
      riskHints: { type: 'array', items: { type: 'string' } },
    },
    required: ['missionId', 'goal', 'acceptanceCriteria'],
  },
  handler: async (args, ctx, invocation) => {
    if (ctx.role === 'worker') throw new Error('only an orchestrator can freeze a contract');
    const parsed = freezeSchema.parse(args);
    const input = {
      ...parsed,
      acceptanceCriteria: parsed.acceptanceCriteria.map((criterion, index) => ({
        ...criterion,
        id: criterion.id ?? `criterion-${index + 1}`,
      })),
    };
    assertMission(ctx, input.missionId);
    const mission = getProjectDomainStores(ctx.scope).missions.get(input.missionId);
    const authorized = bindFreezeDraftToApprovedIntent(mission, input);
    const service = getContextWorkflowService(ctx.scope);
    const assertCurrentAuthority = invocationAuthority(invocation);
    // Auto-pilot unions caller scope with the main-derived structural radius;
    // an agent may broaden the contract, never narrow the approved mission.
    const enriched = await service.enrichDraftFromOrientation(authorized);
    assertCurrentAuthority();
    const frozen = service.freezeContract(enriched, missionIdentity(ctx));
    await rotateMissionPaneWorkflowAuthority(
      ctx,
      input.missionId,
      assertCurrentAuthority,
    );
    assertCurrentAuthority();
    rotateContextRevisionAuthority(
      ctx,
      undefined,
      frozen.contract.contextRevision,
    );
    const autopilot = await drivePrevcAutopilot({
      scope: ctx.scope,
      missionId: input.missionId,
      allowExecutionExit: false,
      assertCurrentAuthority,
      ...(invocation?.signal ? { signal: invocation.signal } : {}),
    });
    assertCurrentAuthority();
    return {
      ...service.getMissionWorkflow(input.missionId),
      autopilot,
      orientationEnriched: {
        impactedSymbols: frozen.contract.impactedSymbols,
        impactedDomains: frozen.contract.impactedDomains,
      },
    };
  },
};

const refreezeTool: McpToolDef = {
  name: 'nexus_mission_refreeze_contract',
  description:
    'Re-freeze the mission contract after CONTEXT DRIFT (context revision changed post-freeze). Preserves goal/criteria/scope; rebinds to the current context and Git base; the workflow restarts at the route start so pending evidence is revalidated. Only valid when drift actually happened.',
  inputSchema: {
    type: 'object',
    properties: { missionId: { type: 'string' } },
    required: ['missionId'],
  },
  handler: async (args, ctx, invocation) => {
    if (ctx.role === 'worker') {
      throw new Error('only an orchestrator can refreeze a contract');
    }
    const parsed = z.object({ missionId: z.string().min(1) }).parse(args);
    assertMission(ctx, parsed.missionId);
    const service = getContextWorkflowService(ctx.scope);
    const assertCurrentAuthority = invocationAuthority(invocation);
    const previousRevision =
      service.getMissionWorkflow(parsed.missionId).contract?.contract
        .contextRevision;
    assertCurrentAuthority();
    const frozen = service.refreezeContract(parsed.missionId, missionIdentity(ctx));
    await rotateMissionPaneWorkflowAuthority(
      ctx,
      parsed.missionId,
      assertCurrentAuthority,
    );
    assertCurrentAuthority();
    rotateContextRevisionAuthority(
      ctx,
      previousRevision,
      frozen.contract.contextRevision,
    );
    const autopilot = await drivePrevcAutopilot({
      scope: ctx.scope,
      missionId: parsed.missionId,
      allowExecutionExit: false,
      assertCurrentAuthority,
      ...(invocation?.signal ? { signal: invocation.signal } : {}),
    });
    assertCurrentAuthority();
    return { ...service.getMissionWorkflow(parsed.missionId), autopilot };
  },
};

const statusTool: McpToolDef = {
  name: 'nexus_workflow_get',
  description: 'Read the frozen mission contract and current computed PREVC stage.',
  inputSchema: {
    type: 'object', properties: { missionId: { type: 'string' } }, required: ['missionId'],
  },
  handler: async (args, ctx) => {
    const missionId = identifier.parse(args.missionId);
    assertMission(ctx, missionId);
    return getContextWorkflowService(ctx.scope).getMissionWorkflow(missionId);
  },
};

const reviewTool: McpToolDef = {
  name: 'nexus_review_submit',
  description:
    'Submit structured review findings bound to the exact contract/context/base/head/diff. Author/self-session review is rejected.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: { type: 'string' },
      findings: { type: 'array', items: { type: 'object' } },
    },
    required: ['missionId', 'findings'],
  },
  handler: async (args, ctx) => {
    const input = z.object({
      missionId: identifier,
      findings: z.array(findingSchema).max(4_096),
    }).strict().parse(args);
    assertMission(ctx, input.missionId);
    return getContextWorkflowService(ctx.scope).submitReview({
      missionId: input.missionId,
      reviewer: missionIdentity(ctx),
      findings: input.findings,
    });
  },
};

const sensorTool: McpToolDef = {
  name: 'nexus_sensor_run',
  description:
    'Run one configured sensor in the Nexus sandbox and persist trusted evidence bound to the exact integrated diff.',
  inputSchema: {
    type: 'object',
    properties: { missionId: { type: 'string' }, sensorId: { type: 'string' } },
    required: ['missionId', 'sensorId'],
  },
  handler: async (args, ctx, invocation) => {
    const input = z.object({ missionId: identifier, sensorId: identifier }).strict().parse(args);
    assertOrchestratorMission(ctx, input.missionId);
    const assertCurrentAuthority = invocationAuthority(invocation);
    const result = await getContextWorkflowService(ctx.scope).runSensor(
      input.missionId,
      input.sensorId,
      {
        ...(invocation?.signal ? { signal: invocation.signal } : {}),
        assertCurrentAuthority,
      },
    );
    assertCurrentAuthority();
    return result;
  },
};

const advanceTool: McpToolDef = {
  name: 'nexus_workflow_advance',
  description:
    'Ask Nexus to advance exactly one non-final PREVC stage. Nexus derives reviews, sensor evidence, context revision and integrated Git state; callers cannot declare done or advance to complete (owned by the atomic mission-step receipt).',
  inputSchema: {
    type: 'object',
    properties: { missionId: { type: 'string' }, next: { type: 'string' } },
    required: ['missionId', 'next'],
  },
  handler: async (args, ctx) => {
    if (ctx.role === 'worker') throw new Error('only an orchestrator can advance workflow');
    const input = z.object({ missionId: identifier, next: workflowStageSchema }).strict().parse(args);
    assertMission(ctx, input.missionId);
    if (input.next === 'complete') {
      throw new Error(
        'final PREVC complete transition is owned by the atomic mission-step receipt path',
      );
    }
    return getContextWorkflowService(ctx.scope).advance(input.missionId, input.next);
  },
};

const prepareExecutionTool: McpToolDef = {
  name: 'nexus_workflow_prepare_execution',
  description:
    'Advance a Main-frozen guided PREVC workflow through deterministic planning and required independent reviews, stopping at execution. Never freezes or refreezes a contract.',
  inputSchema: {
    type: 'object',
    properties: { missionId: { type: 'string' } },
    required: ['missionId'],
  },
  handler: async (args, ctx, invocation) => {
    if (ctx.role === 'worker') {
      throw new Error('only an orchestrator can prepare workflow execution');
    }
    const missionId = identifier.parse(args.missionId);
    assertMission(ctx, missionId);
    const service = getContextWorkflowService(ctx.scope);
    const before = service.getMissionWorkflow(missionId);
    if (!before.contract || !before.workflow) {
      throw new Error(
        'guided_prevc_required: Main did not freeze the mission contract',
      );
    }
    if (before.workflow.stage === 'execution') {
      return Object.freeze({
        state: 'execution',
        transitions: Object.freeze([]),
      });
    }
    const assertCurrentAuthority = invocationAuthority(invocation);
    const result = await drivePrevcAutopilot({
      scope: ctx.scope,
      missionId,
      allowExecutionExit: false,
      assertCurrentAuthority,
      ...(invocation?.signal ? { signal: invocation.signal } : {}),
    });
    assertCurrentAuthority();
    const after = service.getMissionWorkflow(missionId);
    if (after.workflow?.stage !== 'execution') {
      throw new Error(
        `guided_prevc_not_at_execution: workflow terminou em ${after.workflow?.stage ?? 'missing'}`,
      );
    }
    return result;
  },
};

const worktreeCreateTool: McpToolDef = {
  name: 'nexus_worktree_create',
  description:
    'Reserve an isolated Git worktree for one mission task with explicit file/symbol/domain ownership and dependencies.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: { type: 'string' },
      taskId: { type: 'string' },
      workerId: { type: 'string' },
      ownership: { type: 'object' },
      dependsOn: { type: 'array', items: { type: 'object' } },
    },
    required: ['missionId', 'taskId', 'workerId', 'ownership'],
  },
  handler: async (args, ctx, invocation) => {
    if (ctx.role === 'worker') throw new Error('only an orchestrator can allocate worktrees');
    const input = z.object({
      missionId: identifier,
      taskId: identifier,
      workerId: identifier,
      ownership: z.object({
        files: z.array(z.string().trim().min(1).max(4_096)).min(1).max(2_048),
        symbols: z.array(z.string().trim().min(1).max(512)).max(2_048).default([]),
        domains: z.array(identifier).max(2_048).default([]),
      }).strict(),
      dependsOn: z.array(z.object({
        missionId: identifier,
        taskId: identifier,
      }).strict()).max(256).default([]),
    }).strict().parse(args);
    assertMission(ctx, input.missionId);
    assertMainTaskDispatcherAuthority(
      getProjectDomainStores(ctx.scope),
      input.missionId,
      'nexus_worktree_create',
    );
    const protectedFile = input.ownership.files.find((file) => {
      const normalized = file.replaceAll('\\', '/');
      return normalized === '.nexus/project.json' ||
        normalized === '.context' ||
        normalized.startsWith('.context/');
    });
    if (protectedFile) {
      throw new Error(`executor ownership cannot include protected context: ${protectedFile}`);
    }
    getContextWorkflowService(ctx.scope).assertMutationAllowed(
      input.missionId,
      'nexus_worktree_create',
      {},
    );
    const tasks = getProjectDomainStores(ctx.scope).tasks;
    const planned = tasks.list(input.missionId).find((task) => task.id === input.taskId);
    if (!planned) {
      throw new Error('worktree task is outside the sealed Nexus mission plan');
    }
    // P4 auto-pilot: expand ownership with structural blast radius (still no .context).
    let ownership = input.ownership;
    let ownershipExpanded = false;
    const assertCurrentAuthority = invocationAuthority(invocation);
    try {
      const { tryGetProjectOrientationService } = await import(
        '../context/orientation/orientation-service'
      );
      assertCurrentAuthority();
      const { expandOwnershipWithBlastRadius } = await import(
        '../context/orientation/orientation-blast-radius'
      );
      assertCurrentAuthority();
      const map =
        tryGetProjectOrientationService()?.get(ctx.scope) ??
        (await tryGetProjectOrientationService()?.ensure(ctx.scope, {
          reason: 'mcp',
          waitMs: 3_000,
        }));
      assertCurrentAuthority();
      if (map) {
        const expanded = expandOwnershipWithBlastRadius(ownership, map);
        ownership = {
          files: [...expanded.files],
          symbols: [...expanded.symbols],
          domains: [...expanded.domains],
        };
        ownershipExpanded = expanded.expanded;
      }
    } catch {
      // ownership expansion is advisory
    }
    assertCurrentAuthority();
    const created = await requireWorktreeRuntimeRegistry().create({
      scope: ctx.scope,
      missionId: input.missionId,
      taskId: input.taskId,
      workerId: input.workerId,
      ownership,
      dependsOn: input.dependsOn,
    });
    tasks.update(input.taskId, { status: 'running' });
    return Object.freeze({ ...created, ownershipExpanded });
  },
};

const worktreeGetTool: McpToolDef = {
  name: 'nexus_worktree_get',
  description: 'Read the trusted worktree record for one mission task.',
  inputSchema: {
    type: 'object',
    properties: { missionId: { type: 'string' }, taskId: { type: 'string' } },
    required: ['missionId', 'taskId'],
  },
  handler: async (args, ctx) => {
    const input = z.object({ missionId: identifier, taskId: identifier }).strict().parse(args);
    assertMission(ctx, input.missionId);
    const record = requireWorktreeRuntimeRegistry().get(
      ctx.scope,
      input.missionId,
      input.taskId,
    );
    if (!record) throw new Error('worktree not found');
    return record;
  },
};

const mergeReviewSubmitTool: McpToolDef = {
  name: 'nexus_merge_review_submit',
  description:
    'Submit the structured result of an active Nexus merge review. The opaque review session, reviewer PTY and candidate checkout must all match.',
  inputSchema: {
    type: 'object',
    properties: {
      reviewSessionId: { type: 'string' },
      findings: { type: 'array', items: { type: 'object' } },
    },
    required: ['reviewSessionId', 'findings'],
  },
  handler: async (args, ctx) => {
    if (!ctx.missionId || !ctx.sessionId) {
      throw new Error('merge review requires a mission-bound reviewer session');
    }
    const input = z.object({
      reviewSessionId: z.string().uuid(),
      findings: z.array(findingSchema).max(4_096),
    }).strict().parse(args);
    const reviewer = normalizeWorkflowIdentity(missionIdentity(ctx));
    return automatedReviewSessions.submit(
      input.reviewSessionId,
      {
        id: reviewer.id,
        sessionId: reviewer.sessionId,
        provider: reviewer.provider,
        missionId: ctx.missionId,
        checkoutPath: executionScopeFor(ctx).rootRealPath,
      },
      input.findings,
    );
  },
};

const mergeTaskTool: McpToolDef = {
  name: 'nexus_merge_task',
  description:
    'Queue one completed task worktree for exact-CAS integration. Nexus runs configured sensors and independent AI review on both detached candidate and materialized checkout.',
  inputSchema: {
    type: 'object',
    properties: { missionId: { type: 'string' }, taskId: { type: 'string' } },
    required: ['missionId', 'taskId'],
  },
  handler: async (args, ctx, invocation) => {
    const input = z.object({ missionId: identifier, taskId: identifier }).strict().parse(args);
    const assertManualAuthority = captureManualMergeAuthority(
      ctx,
      input.missionId,
      'nexus_merge_task',
    );
    const assertCurrentAuthority = () => {
      assertMcpInvocationCurrent(invocation);
      assertManualAuthority();
    };
    await ensurePrevcMergeReady(ctx.scope, input.missionId, {
      ...(invocation?.signal ? { signal: invocation.signal } : {}),
      assertCurrentAuthority,
    });
    assertCurrentAuthority();
    const service = getContextWorkflowService(ctx.scope);
    service.assertMutationAllowed(input.missionId, 'nexus_merge_task', {});
    const validator = new MergeValidationCoordinator(service);
    const integrated = await requireWorktreeRuntimeRegistry().enqueue({
      scope: ctx.scope,
      missionId: input.missionId,
      taskId: input.taskId,
      ...(invocation?.signal ? { signal: invocation.signal } : {}),
      assertCurrentAuthority,
      validate: (validationContext) => validator.validate(validationContext),
      finalize: () => {
        assertCurrentAuthority();
        markMergedTaskDone(ctx, input.taskId);
        assertCurrentAuthority();
      },
    });
    // Git integration + task completion are now the linearization point. PREVC
    // advancement runs afterwards under the same fence; a later block stops
    // the autopilot but never creates Git-rollback/task-done disagreement.
    assertCurrentAuthority();
    const autopilot = await drivePrevcAutopilot({
      scope: ctx.scope,
      missionId: input.missionId,
      allowExecutionExit: true,
      assertCurrentAuthority,
      ...(invocation?.signal ? { signal: invocation.signal } : {}),
    });
    assertCurrentAuthority();
    return Object.freeze({ ...integrated, autopilot });
  },
};

const mergeStatusTool: McpToolDef = {
  name: 'nexus_merge_status',
  description:
    'Read the durable merge queue revision, task states and recovery events for the current mission. The revision is required for CAS-safe retry.',
  inputSchema: {
    type: 'object',
    properties: { missionId: { type: 'string' } },
    required: ['missionId'],
  },
  handler: async (args, ctx) => {
    const missionId = identifier.parse(args.missionId);
    assertMission(ctx, missionId);
    const snapshot = requireWorktreeRuntimeRegistry().mergeSnapshot(ctx.scope);
    const entries = snapshot.entries.filter((entry) => entry.missionId === missionId);
    const taskKeys = new Set(entries.map((entry) => entry.taskKey));
    return Object.freeze({
      revision: snapshot.revision,
      activeTaskKey: snapshot.activeTaskKey && taskKeys.has(snapshot.activeTaskKey)
        ? snapshot.activeTaskKey
        : null,
      hasOtherActiveMission: snapshot.activeTaskKey !== null && !taskKeys.has(snapshot.activeTaskKey),
      blocked: snapshot.blocked && taskKeys.has(snapshot.blocked.taskKey)
        ? snapshot.blocked
        : null,
      entries: Object.freeze(entries),
      events: Object.freeze(snapshot.events.filter((event) => taskKeys.has(event.taskKey))),
    });
  },
};

const mergeRetryTool: McpToolDef = {
  name: 'nexus_merge_retry',
  description:
    'Retry one blocked merge with exact queue CAS. Nexus derives persisted trusted evidence itself; callers cannot fabricate acknowledgement IDs.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: { type: 'string' },
      taskId: { type: 'string' },
      expectedStateRevision: { type: 'number' },
    },
    required: ['missionId', 'taskId', 'expectedStateRevision'],
  },
  handler: async (args, ctx, invocation) => {
    const input = z.object({
      missionId: identifier,
      taskId: identifier,
      expectedStateRevision: z.number().int().nonnegative(),
    }).strict().parse(args);
    const assertManualAuthority = captureManualMergeAuthority(
      ctx,
      input.missionId,
      'nexus_merge_retry',
    );
    const assertCurrentAuthority = () => {
      assertMcpInvocationCurrent(invocation);
      assertManualAuthority();
    };
    await ensurePrevcMergeReady(ctx.scope, input.missionId, {
      ...(invocation?.signal ? { signal: invocation.signal } : {}),
      assertCurrentAuthority,
    });
    assertCurrentAuthority();
    const service = getContextWorkflowService(ctx.scope);
    // Retry owns a narrower gate than ordinary workflow mutation: the durable
    // queue CAS below proves the exact blocked task/attempt. This must remain
    // available after a crash where finalization already advanced PREVC.
    const validator = new MergeValidationCoordinator(service);
    const integrated = await requireWorktreeRuntimeRegistry().retry({
      scope: ctx.scope,
      missionId: input.missionId,
      taskId: input.taskId,
      expectedStateRevision: input.expectedStateRevision,
      ...(invocation?.signal ? { signal: invocation.signal } : {}),
      assertCurrentAuthority,
      acknowledgement: {
        evidenceIds: service.listPersistedEvidenceIds(input.missionId),
      },
      validate: (validationContext) => validator.validate(validationContext),
      finalize: () => {
        assertCurrentAuthority();
        markMergedTaskDone(ctx, input.taskId);
        assertCurrentAuthority();
      },
    });
    assertCurrentAuthority();
    const autopilot = await drivePrevcAutopilot({
      scope: ctx.scope,
      missionId: input.missionId,
      allowExecutionExit: true,
      assertCurrentAuthority,
      ...(invocation?.signal ? { signal: invocation.signal } : {}),
    });
    assertCurrentAuthority();
    return Object.freeze({ ...integrated, autopilot });
  },
};

const validationRunTool: McpToolDef = {
  name: 'nexus_validation_run',
  description:
    'Run the full final validation for the integrated mission diff: mandatory Nexus sensors plus independent AI Review Council. No agent-authored pass claim is accepted.',
  inputSchema: {
    type: 'object',
    properties: { missionId: { type: 'string' } },
    required: ['missionId'],
  },
  handler: async (args, ctx, invocation) => {
    if (ctx.role === 'worker') throw new Error('only an orchestrator can run final validation');
    const missionId = identifier.parse(args.missionId);
    assertMission(ctx, missionId);
    const service = getContextWorkflowService(ctx.scope);
    const assertCurrentAuthority = invocationAuthority(invocation);
    const mission = service.getMissionWorkflow(missionId);
    if (!mission.contract || !mission.workflow) {
      throw new Error('mission has no frozen workflow');
    }
    if (!mission.workflow.stage.startsWith('validation')) {
      throw new Error('final validation is not allowed in the current workflow stage');
    }
    return runPrevcFinalValidation({
      scope: ctx.scope,
      missionId,
      assertCurrentAuthority,
      ...(invocation?.signal ? { signal: invocation.signal } : {}),
    });
  },
};

const planReviewRunTool: McpToolDef = {
  name: 'nexus_plan_review_run',
  description:
    'Autonomously run the independent Review Council for the frozen plan/contract before high-risk execution. Reviewers are read-only and bound to distinct main-owned identities and physical sessions.',
  inputSchema: {
    type: 'object',
    properties: { missionId: { type: 'string' } },
    required: ['missionId'],
  },
  handler: async (args, ctx, invocation) => {
    if (ctx.role === 'worker') throw new Error('only an orchestrator can launch plan review');
    const missionId = identifier.parse(args.missionId);
    assertMission(ctx, missionId);
    const service = getContextWorkflowService(ctx.scope);
    const assertCurrentAuthority = invocationAuthority(invocation);
    const mission = service.getMissionWorkflow(missionId);
    if (!mission.contract || !mission.workflow) {
      throw new Error('mission has no frozen workflow');
    }
    if (
      mission.workflow.stage !== 'review-primary' &&
      mission.workflow.stage !== 'review-secondary'
    ) {
      throw new Error('plan review is not allowed in the current workflow stage');
    }
    const review = await runPrevcCouncilReview({
      scope: ctx.scope,
      missionId,
      assertCurrentAuthority,
      ...(invocation?.signal ? { signal: invocation.signal } : {}),
    });
    assertCurrentAuthority();
    return { ready: review.ready, reason: review.gate.reason, review };
  },
};

export function buildContextTools(): McpToolDef[] {
  return [
    doctorTool,
    systemDoctorTool,
    scaffoldTool,
    contextDraftProposeTool,
    contextDraftListTool,
    contextDraftGetTool,
    contextDraftReviewTool,
    contextDraftApplyTool,
    contextDraftSupersedeTool,
    contextDraftReviewRunTool,
    contextCommitTool,
    freezeTool,
    refreezeTool,
    statusTool,
    reviewTool,
    sensorTool,
    advanceTool,
    prepareExecutionTool,
    worktreeCreateTool,
    worktreeGetTool,
    mergeReviewSubmitTool,
    mergeTaskTool,
    mergeStatusTool,
    mergeRetryTool,
    validationRunTool,
    planReviewRunTool,
  ];
}
