import {
  canSubmitMissionHandoff,
  hasCurrentApprovedDispatchContract,
  resolveEffectiveIntentState,
} from '../../shared/mission-intent';
import { handoffStatusSchema } from '../../shared/orch-types';
import { markHandoffSubmitted } from './gate';
import { onHandoffSubmitted } from './idle-delivery';
import type { McpToolDef } from './mcp-protocol';
import { getProjectDomainStores } from './project-domain-store-registry';
import { requireStr, str } from './tool-util';

const handoffSubmitTool: McpToolDef = {
  name: 'nexus_handoff_submit',
  description:
    'Submit your work handoff to the orchestrator: ' +
    '{status: success|partial|blocked|failed, summary, artifacts?, ' +
    'evidenceIds?}. Always allowed regardless of allowlists. Status and ' +
    'artifacts are untrusted delivery metadata and never complete a mission. ' +
    'Only evidenceIds already issued and bound by Nexus can satisfy the ' +
    'worker stop receipt.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['success', 'partial', 'blocked', 'failed'],
      },
      summary: { type: 'string' },
      artifacts: { type: 'array', items: {} },
      evidenceIds: { type: 'array', items: { type: 'string' } },
    },
    required: ['status', 'summary'],
  },
  handler: async (args, ctx) => {
    let suite: ReturnType<typeof getProjectDomainStores>;
    let mission: ReturnType<ReturnType<typeof getProjectDomainStores>['missions']['get']>;
    try {
      suite = getProjectDomainStores(ctx.scope);
      mission = ctx.missionId ? suite.missions.get(ctx.missionId) : null;
    } catch (error) {
      console.warn('[handoff] mission authority lookup failed (deny):', error);
      throw new Error('handoff_origin: mission authority unavailable');
    }
    if (!mission || !hasCurrentApprovedDispatchContract(mission)) {
      throw new Error('handoff_origin: current approved mission unavailable');
    }
    const intentState = resolveEffectiveIntentState({
      mission,
      taskCount: suite.tasks?.list(mission.id).length ?? 0,
      workerPaneCount:
        suite.missionPanes
          ?.list(mission.id)
          .filter((p) => p.role === 'worker').length ?? 0,
    });
    const origin = canSubmitMissionHandoff({
      role: ctx.role,
      missionId: ctx.missionId,
      sessionId: ctx.sessionId,
      intentState,
    });
    if (!origin.ok) {
      throw new Error(origin.error);
    }
    const summary = requireStr(args, 'summary').trim();
    if (summary.length < 20 || /^<.*>$/.test(summary)) {
      throw new Error(
        'summary inválido: descreva de verdade o que foi feito (mínimo 20 ' +
          'caracteres, sem placeholders como "<resumo...>").',
      );
    }
    const rawEvidenceIds = args.evidenceIds;
    if (
      rawEvidenceIds !== undefined &&
      (!Array.isArray(rawEvidenceIds) ||
        rawEvidenceIds.some((id) => typeof id !== 'string'))
    ) {
      throw new Error('evidenceIds must be an array of Nexus evidence IDs');
    }
    const handoff = suite.handoffs.submit({
      status: handoffStatusSchema.parse(args.status),
      summary,
      artifacts: Array.isArray(args.artifacts) ? args.artifacts : [],
      evidenceIds: rawEvidenceIds as string[] | undefined,
      missionId: ctx.missionId,
      sessionId: ctx.sessionId,
      fromAgent: ctx.agentName ?? ctx.label,
    });
    if (handoff.evidenceTrust === 'nexus-trusted') {
      markHandoffSubmitted(ctx);
    }
    const petStudioCompletion = onHandoffSubmitted(handoff, ctx.scope);
    return {
      ok: true,
      handoffId: handoff.id,
      evidenceTrust: handoff.evidenceTrust,
      stopGateSatisfied: handoff.evidenceTrust === 'nexus-trusted',
      ...(petStudioCompletion
        ? { petStudioCompletion }
        : {}),
    };
  },
};

const handoffListTool: McpToolDef = {
  name: 'nexus_handoff_list',
  description:
    'List submitted handoffs (undelivered by default; includeDelivered: true ' +
    'for the full audit trail). Optionally filter by missionId.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: { type: 'string' },
      includeDelivered: { type: 'boolean' },
    },
  },
  handler: async (args, ctx) => {
    // L10: only an orchestrator may enumerate other missions' handoffs. A worker
    // is confined to its own mission, so a prompt-injected worker cannot read
    // another mission's handoff summaries/artifacts by passing a guessed id.
    const requestedMission = str(args, 'missionId');
    const missionId =
      ctx.role === 'orchestrator'
        ? (requestedMission ?? ctx.missionId)
        : ctx.missionId;
    return getProjectDomainStores(ctx.scope).handoffs.list({
      missionId,
      includeDelivered: args.includeDelivered === true,
    });
  },
};

const handoffAcknowledgeTool: McpToolDef = {
  name: 'nexus_handoff_ack',
  description:
    'Mark one delivered handoff as consumed after you actually processed its result. ' +
    'Orchestrator-only; this is a transport receipt and never completes a mission.',
  inputSchema: {
    type: 'object',
    properties: { handoffId: { type: 'string' } },
    required: ['handoffId'],
  },
  handler: async (args, ctx) => {
    if (ctx.role !== 'orchestrator' || !ctx.missionId) {
      throw new Error('handoff acknowledgement requires a mission orchestrator');
    }
    const handoffId = requireStr(args, 'handoffId');
    const consumed = getProjectDomainStores(ctx.scope).handoffs.markConsumed(
      handoffId,
      ctx.missionId,
    );
    if (!consumed) throw new Error('handoff is not awaiting consumption in this mission');
    return { ok: true, handoffId, deliveryState: 'consumed' };
  },
};

export function buildHandoffTools(): McpToolDef[] {
  return [handoffSubmitTool, handoffListTool, handoffAcknowledgeTool];
}
