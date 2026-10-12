import { assertTabSupportsOperation } from './mission-execution-scope';
import { z } from 'zod';
import {
  getContextKnowledgeService,
  getContextWorkflowService,
} from '../context/context-workflow-registry';
import {
  workflowStageSchema,
  type WorkflowStage,
} from '../context/contract-compiler';
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
  refuseBeforeEffect,
} from './gate';
import { getProjectDomainStores } from './project-domain-store-registry';
import { CliContextDraftReviewer } from '../context/cli-context-draft-reviewer';
import { inspectConfiguredNexusReadiness } from '../runtime/nexus-doctor';
import {
  runContextBootstrapAutopilot,
  type ContextBootstrapAutopilotResult,
} from '../context/context-bootstrap-autopilot';
import { ensureBusinessModel } from '../context/business-model/business-model-ensure';

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

function missionIdentity(ctx: AgentGateContext) {
  if (!ctx.sessionId) throw new Error('workflow action requires a bound agent session');
  return {
    id: ctx.agentName ?? ctx.label,
    sessionId: ctx.sessionId,
    provider: ctx.providerId ?? ctx.label,
  };
}

function mainOwnedPreExecutionPlanBinding(
  ctx: AgentGateContext,
  missionId: string,
  stage: WorkflowStage | null | undefined,
):
  | {
      readonly intentVersion: number;
      readonly planHash: string;
    }
  | undefined {
  if (stage !== 'review-primary' && stage !== 'review-secondary') {
    return undefined;
  }
  const stores = getProjectDomainStores(ctx.scope);
  const mission = stores.missions.get(missionId);
  const intentVersion = mission?.intentContract?.intentVersion;
  const receipt =
    intentVersion === undefined
      ? null
      : stores.tasks.getPlanReceipt(missionId, intentVersion);
  if (!receipt) {
    throw new Error(
      'pre-execution authority requires the current Main-owned sealed task plan',
    );
  }
  return Object.freeze({
    intentVersion: receipt.intentVersion,
    planHash: receipt.planHash,
  });
}

function assertMission(ctx: AgentGateContext, requested: string): void {
  if (ctx.missionId && ctx.missionId !== requested) {
    throw new Error('not authorized: workflow mission differs from session mission');
  }
  if (!ctx.missionId && ctx.role !== 'user') {
    throw new Error('not authorized: agent session is not bound to a mission');
  }
}




function invocationAuthority(
  invocation?: McpToolInvocation,
): () => void {
  return () => assertMcpInvocationCurrent(invocation);
}


const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const REVIEW_CATEGORIES = [
  'correctness',
  'business',
  'security',
  'data',
  'performance',
  'ux',
] as const;
const findingSchema = z
  .object({
    severity: z.enum(REVIEW_SEVERITIES),
    category: z.enum(REVIEW_CATEGORIES),
    file: z.string().trim().min(1).max(4_096),
    line: z.number().int().positive().optional(),
    criterionRefs: z.array(identifier).max(256).default([]),
    invariantRefs: z.array(identifier).max(256).default([]),
    evidence: z.string().trim().min(1).max(65_536),
    recommendation: z.string().trim().min(1).max(65_536),
  })
  .strict();
const findingInputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    severity: { type: 'string', enum: [...REVIEW_SEVERITIES] },
    category: { type: 'string', enum: [...REVIEW_CATEGORIES] },
    file: { type: 'string', minLength: 1, maxLength: 4_096 },
    line: {
      type: 'integer',
      minimum: 1,
      maximum: 100_000_000,
    },
    criterionRefs: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 256,
      default: [],
    },
    invariantRefs: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 256,
      default: [],
    },
    evidence: { type: 'string', minLength: 1, maxLength: 65_536 },
    recommendation: {
      type: 'string',
      minLength: 1,
      maxLength: 65_536,
    },
  },
  required: [
    'severity',
    'category',
    'file',
    'evidence',
    'recommendation',
  ],
} as const;
const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
// sourceHash opcional: agentes hospedados não têm tool de hash — o Nexus
// computa o sha256 do arquivo no propose e re-verifica em review/apply.
// Hash fornecido é afirmação de conteúdo exato (divergência rejeita).
const contextSourceSchema = z.object({
  type: z.enum(['file', 'git', 'test', 'schema', 'connector', 'decision']),
  locator: z.string().trim().min(1).max(4_096),
  sourceHash: contentHashSchema.optional(),
}).strict();

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
    // Store do modelo extraído do HEAD: o doctor garante que ele existe para
    // o commit atual (seleção por tarefa e risco do portão leem de lá, sem
    // depender do doc revisado). Fail-open como o resto do doctor.
    const ensured = await ensureBusinessModel(ctx.scope).catch(() => null);
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
      // How the design contract stands for this scope: materialized, waiting,
      // or deliberately skipped (with the reason). A UI mission must not have
      // to guess whether it has an authority to build against.
      designContract: result.designContract,
      // Modelo de negócio extraído das fontes: aplicado, em dia, adiado,
      // rejeitado ou falho (com a mensagem) — nunca engolido.
      businessModel: result.businessModel,
      // Store extraído (HEAD): pronto para a seleção por tarefa ou ausente.
      businessModelStore: ensured
        ? {
            status: 'ready' as const,
            headSha: ensured.headSha,
            flows: ensured.document.flows.length,
            invariants: ensured.document.invariants.length,
            hurdles: ensured.hurdles.length,
          }
        : {
            status: 'unavailable' as const,
            headSha: null,
            flows: 0,
            invariants: 0,
            hurdles: 0,
          },
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
    additionalProperties: false,
    properties: {
      missionId: { type: 'string' },
      findings: {
        type: 'array',
        items: findingInputJsonSchema,
        maxItems: 4_096,
      },
    },
    required: ['missionId', 'findings'],
  },
  handler: async (args, ctx) => {
    const input = z.object({
      missionId: identifier,
      findings: z.array(findingSchema).max(4_096),
    }).strict().parse(args);
    assertMission(ctx, input.missionId);
    const service = getContextWorkflowService(ctx.scope);
    const workflow = service.getMissionWorkflow(input.missionId).workflow;
    const preExecutionPlanBinding = mainOwnedPreExecutionPlanBinding(
      ctx,
      input.missionId,
      workflow?.stage,
    );
    return service.submitReview({
      missionId: input.missionId,
      reviewer: missionIdentity(ctx),
      findings: input.findings,
      ...(preExecutionPlanBinding
        ? { preExecutionPlanBinding }
        : {}),
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
    // F-1334: recusa de papel antes de resolver o serviço e de rodar o sensor.
    refuseBeforeEffect(() => assertOrchestratorMission(ctx, input.missionId));
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
    const service = getContextWorkflowService(ctx.scope);
    const workflow = service.getMissionWorkflow(input.missionId).workflow;
    const preExecutionPlanBinding = mainOwnedPreExecutionPlanBinding(
      ctx,
      input.missionId,
      workflow?.stage,
    );
    return service.advance(input.missionId, input.next, {
      ...(preExecutionPlanBinding
        ? { preExecutionPlanBinding }
        : {}),
    });
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
    if (planned.status === 'done') {
      throw new Error('worktree task is already done');
    }
    const taskRevision = tasks.readMutationRevision(input.taskId);
    if (taskRevision === null) throw new Error('worktree task mutation identity is missing');
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
    const assertCreateAuthority = () => {
      assertCurrentAuthority();
      assertMission(ctx, input.missionId);
      const stores = getProjectDomainStores(ctx.scope);
      assertMainTaskDispatcherAuthority(stores, input.missionId, 'nexus_worktree_create');
      getContextWorkflowService(ctx.scope).assertMutationAllowed(input.missionId, 'nexus_worktree_create', {});
      const currentTask = stores.tasks.list(input.missionId).find((task) => task.id === input.taskId);
      if (!currentTask) throw new Error('worktree task is outside the sealed Nexus mission plan');
      if (currentTask.status !== planned.status || currentTask.updatedAt !== planned.updatedAt ||
          stores.tasks.readMutationRevision(input.taskId) !== taskRevision) {
        throw new Error('worktree task changed during creation; retry against its current state');
      }
    };
    assertCreateAuthority();
    const created = await requireWorktreeRuntimeRegistry().create({
      scope: ctx.scope,
      missionId: input.missionId,
      taskId: input.taskId,
      workerId: input.workerId,
      ownership,
      dependsOn: input.dependsOn,
      assertCurrentAuthority: assertCreateAuthority,
      signal: invocation?.signal,
    });
    assertCreateAuthority();
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
    additionalProperties: false,
    properties: {
      reviewSessionId: { type: 'string', format: 'uuid' },
      findings: {
        type: 'array',
        items: findingInputJsonSchema,
        maxItems: 4_096,
      },
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
    statusTool,
    reviewTool,
    sensorTool,
    advanceTool,
    worktreeCreateTool,
    worktreeGetTool,
    mergeReviewSubmitTool,
    mergeStatusTool,
  ].map(tool => ({ ...tool, handler: async (args, ctx, invocation) => {
    if (![doctorTool, systemDoctorTool, contextDraftListTool, contextDraftGetTool, statusTool, worktreeGetTool, mergeStatusTool].includes(tool)) {
      assertTabSupportsOperation(ctx.scope, executionScopeFor(ctx), tool.name, ctx.sharedTabWorktree);
    }
    return tool.handler(args, ctx, invocation);
  } }));
}
