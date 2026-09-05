import { getMissionRoutingHints } from '../../shared/mission-routing-advice';
import { isPaneMetaTask } from '../../shared/pane-meta-task';
import type { Handoff, Mission, MissionPaneSpec, Squad, SquadAgent } from '../../shared/orch-types';
import { hashMissionIntentAuthority } from './mission-pane-authority';
import { snapshotSquadAuthority } from './squad-authority-snapshot';

export type TeamQuestionPaneRuntime = {
  readonly paneId?: string;
  readonly missionId?: string | null;
  readonly sessionId?: string | null;
  readonly role?: string;
  readonly state?: string | null;
};

const CLOSED_PANE_STATES = new Set(['exited', 'hibernated', 'parou', 'tombstoned']);

export type TeamQuestionCompletion = {
  readonly applicable: boolean;
  readonly ready: boolean;
  readonly reason: string;
  readonly missingTargets: readonly string[];
  readonly responses: readonly { readonly agentName: string; readonly handoff: Handoff }[];
};

export function isTeamQuestionMission(mission: Mission): boolean {
  return getMissionRoutingHints(mission.intentContract).paneQuestion !== null ||
    [mission.intentContract?.goal, mission.title, mission.description]
      .some((text) => typeof text === 'string' && isPaneMetaTask(text));
}

function identifiesAgent(name: string | null | undefined, agent: SquadAgent): boolean {
  return name === agent.id || name === agent.agentName;
}

function responseForTarget(input: {
  readonly mission: Mission;
  readonly agent: SquadAgent;
  readonly panes: readonly MissionPaneSpec[];
  readonly runtimePanes: readonly TeamQuestionPaneRuntime[];
  readonly handoffs: readonly Handoff[];
}): Handoff | undefined {
  const { mission, agent } = input;
  const contract = mission.intentContract!;
  const candidates = input.panes.filter((pane) => pane.missionId === mission.id &&
    pane.role === 'worker' && identifiesAgent(pane.agentName, agent));
  const newestAt = Math.max(...candidates.map((pane) => pane.createdAt));
  const latest = candidates.filter((pane) => pane.createdAt === newestAt);
  if (latest.length !== 1) return undefined;
  const pane = latest[0]!;
  if (!pane.paneId || !pane.workerIncarnationId ||
    pane.authoritySeal?.intentVersion !== mission.intentVersion ||
    pane.authoritySeal?.squadRevisionHash !== contract.squadRevisionHash ||
    pane.authoritySeal?.intentContractHash !== hashMissionIntentAuthority(contract)) return undefined;
  const runtimes = input.runtimePanes.filter((runtime) => runtime.paneId === pane.paneId);
  if (runtimes.length > 1 || runtimes.some((runtime) => runtime.missionId !== mission.id ||
    runtime.role !== 'worker' || (!runtime.sessionId && !CLOSED_PANE_STATES.has(runtime.state ?? '')))) return undefined;
  return input.handoffs.find((handoff) => {
    const receipt = handoff.mcpProvenance;
    return handoff.missionId === mission.id && handoff.authorityOrigin === 'agent' &&
      handoff.status === 'success' && handoff.evidenceTrust !== 'stale' && Boolean(handoff.summary.trim()) &&
      identifiesAgent(handoff.fromAgent, agent) && Boolean(handoff.sessionId) &&
      (!runtimes[0]?.sessionId || handoff.sessionId === runtimes[0].sessionId) &&
      handoff.workerIncarnationId === pane.workerIncarnationId &&
      handoff.createdAt >= (contract.dispatchedAt ?? contract.approvedAt ?? 0) &&
      Boolean(receipt && receipt.source !== 'omp-rpc-stdio' && receipt.receiptId &&
        receipt.receiptId === receipt.toolCallId && receipt.toolName === 'nexus_handoff_submit' &&
        /^[a-f0-9]{64}$/u.test(receipt.authoritySha256) && receipt.missionId === mission.id &&
        receipt.sessionId === handoff.sessionId && receipt.workerIncarnationId === pane.workerIncarnationId &&
        receipt.issuedAt >= (contract.dispatchedAt ?? contract.approvedAt ?? 0) &&
        receipt.issuedAt <= handoff.createdAt);
  });
}

/** The approved roster is the denominator, even before its first panes launch. */
export function inspectTeamQuestionCompletion(input: {
  readonly mission: Mission;
  readonly squad: Squad | null | undefined;
  readonly panes: readonly MissionPaneSpec[];
  readonly runtimePanes: readonly TeamQuestionPaneRuntime[];
  readonly handoffs: readonly Handoff[];
  readonly operatorOverride?: boolean;
}): TeamQuestionCompletion {
  if (input.operatorOverride === true || !isTeamQuestionMission(input.mission)) {
    return { applicable: false, ready: true, reason: '', missingTargets: [], responses: [] };
  }
  const { mission, squad } = input;
  const targets = squad?.agents.filter((agent) => agent.category !== 'orchestrator') ?? [];
  if (!squad || squad.id !== mission.squadId || targets.length === 0 ||
    !mission.intentContract?.squadRevisionHash ||
    snapshotSquadAuthority(squad).hash !== mission.intentContract.squadRevisionHash) {
    return {
      applicable: true, ready: false, missingTargets: targets.map((agent) => agent.agentName), responses: [],
      reason: 'team-question-roster-unavailable: restaure a equipe aprovada antes de consolidar as respostas.',
    };
  }
  const responses: Array<{ agentName: string; handoff: Handoff }> = [];
  const missingTargets: string[] = [];
  for (const agent of targets) {
    const handoff = responseForTarget({ ...input, agent });
    if (!handoff || responses.some((response) => response.handoff.sessionId === handoff.sessionId ||
      response.handoff.mcpProvenance?.receiptId === handoff.mcpProvenance?.receiptId)) {
      missingTargets.push(agent.agentName);
    } else responses.push({ agentName: agent.agentName, handoff });
  }
  return {
    applicable: true, ready: missingTargets.length === 0, missingTargets, responses,
    reason: missingTargets.length > 0
      ? `team-question-responses-pending (${responses.length}/${targets.length}): aguarde respostas físicas de ${missingTargets.join(', ')}.`
      : '',
  };
}

export function assertTeamQuestionCompletion(input: Parameters<typeof inspectTeamQuestionCompletion>[0]): TeamQuestionCompletion {
  const inspected = inspectTeamQuestionCompletion(input);
  if (!inspected.ready) throw new Error(inspected.reason);
  return inspected;
}

export function teamQuestionResponseSummary(completion: TeamQuestionCompletion): string {
  return `Respostas da equipe:\n${completion.responses.map(({ agentName, handoff }) => `- ${agentName}: ${handoff.summary.trim()}`).join('\n')}`.slice(0, 65_536);
}
