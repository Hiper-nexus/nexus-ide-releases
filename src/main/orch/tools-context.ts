import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  getContextKnowledgeService,
  getContextWorkflowService,
} from '../context/context-workflow-registry';
import { workflowStageSchema } from '../context/contract-compiler';
import type { McpToolDef } from './mcp-protocol';
import type { AgentGateContext } from './gate';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { automatedReviewSessions } from '../context/automated-review-session';
import {
  normalizeWorkflowIdentity,
  type WorkflowIdentity,
} from '../context/context-workflow-service';
import {
  assertOrchestratorMission,
  bindContextRevision,
  executionScopeFor,
} from './gate';
import { MergeValidationCoordinator } from '../context/merge-validation-coordinator';
import { CliAutomatedReviewer } from '../context/cli-automated-reviewer';
import { getProjectDomainStores } from './project-domain-store-registry';
import { CliContextDraftReviewer } from '../context/cli-context-draft-reviewer';
import { inspectConfiguredNexusReadiness } from '../runtime/nexus-doctor';
import {
  autopilotActionFor,
  canAutopilotAdvanceTo,
  missionPlanIntegrated,
} from '../context/prevc-autopilot-policy';
import {
  runContextBootstrapAutopilot,
  type ContextBootstrapAutopilotResult,
} from '../context/context-bootstrap-autopilot';
import { publishFinalValidationHandoff } from './final-validation-handoff';
import { finalizeIntegratedTask } from './merge-task-finalizer';
import type { MergeQueueResult } from '../runtime/merge-queue';

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

function nextWorkflowStage(route: readonly string[], stage: string): string {
  const index = route.indexOf(stage);
  if (index < 0) throw new Error('workflow stage is outside its frozen route');
  return route[index + 1] ?? 'complete';
}

async function runCouncilReview(ctx: AgentGateContext, missionId: string) {
  const service = getContextWorkflowService(ctx.scope);
  const mission = service.getMissionWorkflow(missionId);
  if (!mission.contract || !mission.workflow) throw new Error('mission has no frozen workflow');
  const reviewer = new CliAutomatedReviewer();
  return reviewer.run({
    scope: ctx.scope,
    checkoutPath: ctx.scope.rootRealPath,
    contract: mission.contract.contract,
    binding: mission.workflow.binding,
    author: mission.contract.author,
    contextMarkdown: service.compileMissionSnapshot(missionId).markdown,
    persist: (report) => service.recordMergeReviewReport(report),
  });
}

async function runFinalValidation(ctx: AgentGateContext, missionId: string) {
  const service = getContextWorkflowService(ctx.scope);
  const mission = service.getMissionWorkflow(missionId);
  if (!mission.contract || !mission.workflow) throw new Error('mission has no frozen workflow');
  const sensorEvidence = [];
  for (const sensorId of mission.contract.contract.requiredSensors) {
    const evidence = await service.runSensor(missionId, sensorId);
    sensorEvidence.push(evidence);
    if (evidence.exitCode !== 0 || evidence.timedOut) {
      return { ready: false, reason: `sensor failed: ${sensorId}`, sensorEvidence, review: null };
    }
  }
  const worktrees = requireWorktreeRuntimeRegistry().listMission(ctx.scope, missionId);
  const panes = getProjectDomainStores(ctx.scope).missionPanes.list(missionId);
  const authors: WorkflowIdentity[] = worktrees.map((worktree) => {
    const pane = panes.find((candidate) =>
      candidate.role === 'worker' &&
      candidate.agentName === worktree.workerId &&
      candidate.cwd === worktree.worktreePath);
    if (!pane) throw new Error(`code author identity missing for task ${worktree.taskId}`);
    return normalizeWorkflowIdentity({
      id: worktree.workerId,
      sessionId: pane.paneId ?? pane.id,
      provider: pane.adapterId,
    });
  });
  if (authors.length === 0) throw new Error('final validation has no integrated code author');
  const reviewer = new CliAutomatedReviewer();
  const review = await reviewer.run({
    scope: ctx.scope,
    checkoutPath: ctx.scope.rootRealPath,
    contract: mission.contract.contract,
    binding: mission.workflow.binding,
    author: authors[0],
    additionalAuthors: authors.slice(1),
    contextMarkdown: service.compileMissionSnapshot(missionId).markdown,
    persist: (report) => service.recordMergeReviewReport(report),
  });
  return { ready: review.ready, reason: review.gate.reason, sensorEvidence, review };
}

async function drivePrevcAutopilot(
  ctx: AgentGateContext,
  missionId: string,
  allowExecutionExit: boolean,
) {
  const service = getContextWorkflowService(ctx.scope);
  const transitions: string[] = [];
  let validatedEvidenceIds: readonly string[] = [];
  for (let guard = 0; guard < 8; guard += 1) {
    const mission = service.getMissionWorkflow(missionId);
    if (!mission.contract || !mission.workflow) throw new Error('mission has no frozen workflow');
    const { stage, route } = mission.workflow;
    const workflowRevision = mission.workflow.revision;
    const tasks = getProjectDomainStores(ctx.scope).tasks.list(missionId);
    const worktrees = requireWorktreeRuntimeRegistry().listMission(ctx.scope, missionId);
    const planIntegrated = missionPlanIntegrated(tasks.map((task) => task.id), worktrees);
    const action = autopilotActionFor(stage, allowExecutionExit, planIntegrated);
    if (action === 'complete') return { state: 'complete', transitions };
    if (action === 'wait-execution') {
      return { state: 'execution', transitions, reason: 'planned tasks are not all integrated' };
    }
    const advanceCurrentStage = () => {
      const next = workflowStageSchema.parse(nextWorkflowStage(route, stage));
      if (!canAutopilotAdvanceTo(next)) return null;
      service.advance(missionId, next);
      transitions.push(`${stage}->${next}`);
      return next;
    };
    const awaitingFinalReceipt = () => ({
      state: stage,
      transitions,
      reason: 'final PREVC transition awaits the atomic mission-step receipt',
    });
    const publishFinalReceiptEvidence = () => {
      const currentEvidenceIds = service.listCurrentPersistedEvidenceIds(missionId);
      const recoveredAttestations = currentEvidenceIds.filter((id) =>
        id.startsWith('milestone:'));
      const evidenceIds = validatedEvidenceIds.length > 0
        ? validatedEvidenceIds
        : recoveredAttestations.length > 0
          ? recoveredAttestations
          : currentEvidenceIds;
      publishFinalValidationHandoff(
        {
          missionId,
          workflowRevision,
          evidenceIds,
        },
        getProjectDomainStores(ctx.scope).handoffs,
      );
    };
    if (stage === 'execution') {
      if (!advanceCurrentStage()) return awaitingFinalReceipt();
      continue;
    }
    if (stage === 'planning') {
      if (!advanceCurrentStage()) return awaitingFinalReceipt();
      continue;
    }
    if (action === 'review') {
      const review = await runCouncilReview(ctx, missionId);
      if (!review.ready) return { state: stage, transitions, reason: review.gate.reason };
      if (!advanceCurrentStage()) return awaitingFinalReceipt();
      continue;
    }
    if (action === 'validate') {
      const validation = await runFinalValidation(ctx, missionId);
      if (!validation.ready) return { state: stage, transitions, reason: validation.reason };
      validatedEvidenceIds = [
        ...validation.sensorEvidence.map((evidence) => evidence.id),
        ...(validation.review?.evidenceIds ?? []),
      ];
      validatedEvidenceIds = service.recordMilestoneValidationEvidence(
        missionId,
        validatedEvidenceIds,
      );
      if (!advanceCurrentStage()) {
        publishFinalReceiptEvidence();
        return awaitingFinalReceipt();
      }
      continue;
    }
    if (stage === 'confirmation') {
      if (!advanceCurrentStage()) {
        publishFinalReceiptEvidence();
        return awaitingFinalReceipt();
      }
      continue;
    }
    return { state: stage, transitions, reason: 'stage requires explicit operator action' };
  }
  throw new Error('PREVC autopilot transition guard exceeded');
}

function finalizeMergeResult(
  ctx: AgentGateContext,
  missionId: string,
  taskId: string,
  result: MergeQueueResult,
) {
  return finalizeIntegratedTask(missionId, taskId, result, {
    markTaskDone: (_missionId, integratedTaskId) => {
      const updated = getProjectDomainStores(ctx.scope).tasks.update(
        integratedTaskId,
        { status: 'done' },
      );
      if (!updated) {
        throw new Error(`integrated task ${integratedTaskId} disappeared`);
      }
    },
    driveMission: (integratedMissionId) =>
      drivePrevcAutopilot(ctx, integratedMissionId, true),
  });
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

const contextDraftReviewRunTool: McpToolDef = {
  name: 'nexus_context_draft_review_run',
  description:
    'Autonomously select and launch a read-only provider-independent reviewer. Approved drafts are atomically materialized by Nexus; rejected drafts remain rejected.',
  inputSchema: {
    type: 'object',
    properties: { draftId: { type: 'string' } },
    required: ['draftId'],
  },
  handler: async (args, ctx) => {
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/timed out/i.test(message)) throw error;
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
  handler: async (args, ctx) => {
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
    const service = getContextWorkflowService(ctx.scope);
    // Auto-pilot: fill empty impact lists from structural blast radius.
    const enriched = await service.enrichDraftFromOrientation(input);
    const frozen = service.freezeContract(enriched, missionIdentity(ctx));
    bindContextRevision(ctx, frozen.contract.contextRevision);
    const autopilot = await drivePrevcAutopilot(ctx, input.missionId, false);
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
  handler: async (args, ctx) => {
    if (ctx.role === 'worker') {
      throw new Error('only an orchestrator can refreeze a contract');
    }
    const parsed = z.object({ missionId: z.string().min(1) }).parse(args);
    assertMission(ctx, parsed.missionId);
    const service = getContextWorkflowService(ctx.scope);
    const frozen = service.refreezeContract(parsed.missionId, missionIdentity(ctx));
    bindContextRevision(ctx, frozen.contract.contextRevision);
    const autopilot = await drivePrevcAutopilot(ctx, parsed.missionId, false);
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
  handler: async (args, ctx) => {
    const input = z.object({ missionId: identifier, sensorId: identifier }).strict().parse(args);
    assertOrchestratorMission(ctx, input.missionId);
    return getContextWorkflowService(ctx.scope).runSensor(input.missionId, input.sensorId);
  },
};

const advanceTool: McpToolDef = {
  name: 'nexus_workflow_advance',
  description:
    'Ask Nexus to advance exactly one PREVC stage. Nexus derives reviews, sensor evidence, context revision and integrated Git state; callers cannot declare done.',
  inputSchema: {
    type: 'object',
    properties: { missionId: { type: 'string' }, next: { type: 'string' } },
    required: ['missionId', 'next'],
  },
  handler: async (args, ctx) => {
    if (ctx.role === 'worker') throw new Error('only an orchestrator can advance workflow');
    const input = z.object({ missionId: identifier, next: workflowStageSchema }).strict().parse(args);
    assertMission(ctx, input.missionId);
    return getContextWorkflowService(ctx.scope).advance(input.missionId, input.next);
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
  handler: async (args, ctx) => {
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
    try {
      const { tryGetProjectOrientationService } = await import(
        '../context/orientation/orientation-service'
      );
      const { expandOwnershipWithBlastRadius } = await import(
        '../context/orientation/orientation-blast-radius'
      );
      const map =
        tryGetProjectOrientationService()?.get(ctx.scope) ??
        (await tryGetProjectOrientationService()?.ensure(ctx.scope, {
          reason: 'mcp',
          waitMs: 3_000,
        }));
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
    const created = requireWorktreeRuntimeRegistry().create({
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
  handler: async (args, ctx) => {
    if (ctx.role === 'worker') throw new Error('only an orchestrator can enqueue merge');
    const input = z.object({ missionId: identifier, taskId: identifier }).strict().parse(args);
    assertMission(ctx, input.missionId);
    const service = getContextWorkflowService(ctx.scope);
    service.assertMutationAllowed(input.missionId, 'nexus_merge_task', {});
    const validator = new MergeValidationCoordinator(service);
    let finalized: Awaited<ReturnType<typeof finalizeMergeResult>> | null = null;
    await requireWorktreeRuntimeRegistry().enqueue({
      scope: ctx.scope,
      missionId: input.missionId,
      taskId: input.taskId,
      validate: (validationContext) => validator.validate(validationContext),
      finalize: async (result) => {
        finalized = await finalizeMergeResult(
          ctx,
          input.missionId,
          input.taskId,
          result,
        );
      },
    });
    if (!finalized) throw new Error('merge finalizer did not produce a result');
    return finalized;
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
  handler: async (args, ctx) => {
    if (ctx.role === 'worker') throw new Error('only an orchestrator can retry merge');
    const input = z.object({
      missionId: identifier,
      taskId: identifier,
      expectedStateRevision: z.number().int().nonnegative(),
    }).strict().parse(args);
    assertMission(ctx, input.missionId);
    const service = getContextWorkflowService(ctx.scope);
    // Retry owns a narrower gate than ordinary workflow mutation: the durable
    // queue CAS below proves the exact blocked task/attempt. This must remain
    // available after a crash where finalization already advanced PREVC.
    const validator = new MergeValidationCoordinator(service);
    let finalized: Awaited<ReturnType<typeof finalizeMergeResult>> | null = null;
    await requireWorktreeRuntimeRegistry().retry({
      scope: ctx.scope,
      missionId: input.missionId,
      taskId: input.taskId,
      expectedStateRevision: input.expectedStateRevision,
      acknowledgement: {
        evidenceIds: service.listPersistedEvidenceIds(input.missionId),
      },
      validate: (validationContext) => validator.validate(validationContext),
      finalize: async (result) => {
        finalized = await finalizeMergeResult(
          ctx,
          input.missionId,
          input.taskId,
          result,
        );
      },
    });
    if (!finalized) throw new Error('merge finalizer did not produce a result');
    return finalized;
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
  handler: async (args, ctx) => {
    if (ctx.role === 'worker') throw new Error('only an orchestrator can run final validation');
    const missionId = identifier.parse(args.missionId);
    assertMission(ctx, missionId);
    const service = getContextWorkflowService(ctx.scope);
    const mission = service.getMissionWorkflow(missionId);
    if (!mission.contract || !mission.workflow) {
      throw new Error('mission has no frozen workflow');
    }
    if (!mission.workflow.stage.startsWith('validation')) {
      throw new Error('final validation is not allowed in the current workflow stage');
    }
    const sensorEvidence = [];
    for (const sensorId of mission.contract.contract.requiredSensors) {
      const evidence = await service.runSensor(missionId, sensorId);
      sensorEvidence.push(evidence);
      if (evidence.exitCode !== 0 || evidence.timedOut) {
        return {
          ready: false,
          reason: `sensor failed: ${sensorId}`,
          sensorEvidence,
          review: null,
        };
      }
    }
    const reviewer = new CliAutomatedReviewer();
    const worktrees = requireWorktreeRuntimeRegistry().listMission(ctx.scope, missionId);
    const panes = getProjectDomainStores(ctx.scope).missionPanes.list(missionId);
    const authors: WorkflowIdentity[] = worktrees.map((worktree) => {
      const pane = panes.find(
        (candidate) =>
          candidate.role === 'worker' &&
          candidate.agentName === worktree.workerId &&
          candidate.cwd === worktree.worktreePath,
      );
      if (!pane) throw new Error(`code author identity missing for task ${worktree.taskId}`);
      return normalizeWorkflowIdentity({
        id: worktree.workerId,
        sessionId: pane.paneId ?? pane.id,
        provider: pane.adapterId,
      });
    });
    if (authors.length === 0) throw new Error('final validation has no integrated code author');
    const review = await reviewer.run({
      scope: ctx.scope,
      checkoutPath: ctx.scope.rootRealPath,
      contract: mission.contract.contract,
      binding: mission.workflow.binding,
      author: authors[0],
      additionalAuthors: authors.slice(1),
      contextMarkdown: service.compileMissionSnapshot(missionId).markdown,
      persist: (report) => {
        service.recordMergeReviewReport(report);
      },
    });
    return {
      ready: review.ready,
      reason: review.gate.reason,
      sensorEvidence,
      review,
    };
  },
};

const planReviewRunTool: McpToolDef = {
  name: 'nexus_plan_review_run',
  description:
    'Autonomously run the independent Review Council for the frozen plan/contract before high-risk execution. Reviewers are read-only and provider-independent.',
  inputSchema: {
    type: 'object',
    properties: { missionId: { type: 'string' } },
    required: ['missionId'],
  },
  handler: async (args, ctx) => {
    if (ctx.role === 'worker') throw new Error('only an orchestrator can launch plan review');
    const missionId = identifier.parse(args.missionId);
    assertMission(ctx, missionId);
    const service = getContextWorkflowService(ctx.scope);
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
    const reviewer = new CliAutomatedReviewer();
    const review = await reviewer.run({
      scope: ctx.scope,
      checkoutPath: ctx.scope.rootRealPath,
      contract: mission.contract.contract,
      binding: mission.workflow.binding,
      author: mission.contract.author,
      contextMarkdown: service.compileMissionSnapshot(missionId).markdown,
      persist: (report) => {
        service.recordMergeReviewReport(report);
      },
    });
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
    contextDraftReviewRunTool,
    contextCommitTool,
    freezeTool,
    refreezeTool,
    statusTool,
    reviewTool,
    sensorTool,
    advanceTool,
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
