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

/**
 * Main-observed pane→session binding (`observer.session_spawned` journal).
 * Used only to attribute answers of panes that were never sealed
 * (legacy/manual composition rows) — sealed panes keep the strict path.
 */
export type TeamQuestionObserverBinding = {
  readonly paneId: string;
  readonly sessionId: string;
};

export type TeamQuestionCompletion = {
  readonly applicable: boolean;
  readonly ready: boolean;
  readonly reason: string;
  readonly missingTargets: readonly string[];
  readonly responses: readonly { readonly agentName: string; readonly handoff: Handoff }[];
  /** Targets whose answer matched via the observer fallback (unsealed pane). */
  readonly fallbackAgents: readonly string[];
};

export function isTeamQuestionMission(mission: Mission): boolean {
  return getMissionRoutingHints(mission.intentContract).paneQuestion !== null ||
    [mission.intentContract?.goal, mission.title, mission.description]
      .some((text) => typeof text === 'string' && isPaneMetaTask(text));
}

function identifiesAgent(name: string | null | undefined, agent: SquadAgent): boolean {
  return name === agent.id || name === agent.agentName;
}

type TeamQuestionTargetResponse = {
  readonly handoff: Handoff;
  readonly viaObserverFallback: boolean;
};

function isSealedTeamQuestionReceipt(input: {
  readonly receipt: Handoff['mcpProvenance'];
  readonly missionId: string;
  readonly sessionId: string;
  readonly workerIncarnationId: string;
  readonly dispatchedAt: number;
  readonly handoffCreatedAt: number;
}): boolean {
  const { receipt } = input;
  return Boolean(receipt && receipt.source !== 'omp-rpc-stdio' && receipt.receiptId &&
    receipt.receiptId === receipt.toolCallId && receipt.toolName === 'nexus_handoff_submit' &&
    /^[a-f0-9]{64}$/u.test(receipt.authoritySha256) && receipt.missionId === input.missionId &&
    receipt.sessionId === input.sessionId && receipt.workerIncarnationId === input.workerIncarnationId &&
    receipt.issuedAt >= input.dispatchedAt && receipt.issuedAt <= input.handoffCreatedAt);
}

/**
 * Latest Main-observed session bound to a pane. Rebinds append, so the tail
 * is current; null when the pane never ran under observation.
 */
export function selectObserverPaneSession(
  bindings: readonly TeamQuestionObserverBinding[] | undefined,
  paneId: string,
): string | null {
  let found: string | null = null;
  for (const binding of bindings ?? []) {
    if (binding.paneId === paneId && binding.sessionId) found = binding.sessionId;
  }
  return found;
}

function responseRuntimesAreSane(input: {
  readonly mission: Mission;
  readonly paneId: string;
  readonly runtimePanes: readonly TeamQuestionPaneRuntime[];
}): TeamQuestionPaneRuntime[] | undefined {
  const runtimes = input.runtimePanes.filter((runtime) => runtime.paneId === input.paneId);
  if (runtimes.length > 1 || runtimes.some((runtime) => runtime.missionId !== input.mission.id ||
    runtime.role !== 'worker' || (!runtime.sessionId && !CLOSED_PANE_STATES.has(runtime.state ?? '')))) {
    return undefined;
  }
  return runtimes;
}

/**
 * F-143 fallback: attributes the answer of a pane that was never sealed
 * (no workerIncarnationId/authoritySeal on the spec — legacy/manual rows).
 * The session binding is Main-observed (live runtime first, journal second),
 * and the handoff still needs the full strict receipt — with incarnation
 * self-consistency (handoff ≡ receipt) replacing the missing pane-side seal.
 * A forged fromAgent from any other session matches nothing, because the
 * receipt's session must equal the victim pane's own bound session.
 */
function responseForUnsealedTarget(input: {
  readonly mission: Mission;
  readonly agent: SquadAgent;
  readonly paneId: string;
  readonly runtimePanes: readonly TeamQuestionPaneRuntime[];
  readonly observerPaneSessions: readonly TeamQuestionObserverBinding[];
  readonly handoffs: readonly Handoff[];
}): TeamQuestionTargetResponse | undefined {
  const { mission, agent } = input;
  const contract = mission.intentContract!;
  const runtimes = responseRuntimesAreSane({ mission, paneId: input.paneId, runtimePanes: input.runtimePanes });
  if (!runtimes) return undefined;
  const boundSession = runtimes[0]?.sessionId ??
    selectObserverPaneSession(input.observerPaneSessions, input.paneId);
  if (!boundSession) return undefined;
  const dispatchedAt = contract.dispatchedAt ?? contract.approvedAt ?? 0;
  const handoff = input.handoffs.find((candidate) => {
    const sessionId = candidate.sessionId;
    const workerIncarnationId = candidate.workerIncarnationId;
    return candidate.missionId === mission.id && candidate.authorityOrigin === 'agent' &&
      candidate.status === 'success' && candidate.evidenceTrust !== 'stale' &&
      Boolean(candidate.summary.trim()) && identifiesAgent(candidate.fromAgent, agent) &&
      typeof sessionId === 'string' && sessionId === boundSession &&
      typeof workerIncarnationId === 'string' && Boolean(workerIncarnationId) &&
      candidate.createdAt >= dispatchedAt &&
      isSealedTeamQuestionReceipt({
        receipt: candidate.mcpProvenance, missionId: mission.id, sessionId,
        workerIncarnationId, dispatchedAt, handoffCreatedAt: candidate.createdAt,
      });
  });
  return handoff ? { handoff, viaObserverFallback: true } : undefined;
}

function responseForTarget(input: {
  readonly mission: Mission;
  readonly agent: SquadAgent;
  readonly panes: readonly MissionPaneSpec[];
  readonly runtimePanes: readonly TeamQuestionPaneRuntime[];
  readonly observerPaneSessions: readonly TeamQuestionObserverBinding[];
  readonly handoffs: readonly Handoff[];
}): TeamQuestionTargetResponse | undefined {
  const { mission, agent } = input;
  const contract = mission.intentContract!;
  const candidates = input.panes.filter((pane) => pane.missionId === mission.id &&
    pane.role === 'worker' && identifiesAgent(pane.agentName, agent));
  const newestAt = Math.max(...candidates.map((pane) => pane.createdAt));
  const latest = candidates.filter((pane) => pane.createdAt === newestAt);
  if (latest.length !== 1) return undefined;
  const pane = latest[0]!;
  if (!pane.paneId) return undefined;
  const seal = pane.authoritySeal;
  const sealed = Boolean(pane.workerIncarnationId) &&
    seal?.intentVersion === mission.intentVersion &&
    seal?.squadRevisionHash === contract.squadRevisionHash &&
    seal?.intentContractHash === hashMissionIntentAuthority(contract);
  if (!sealed) {
    // A seal mismatch on a sealed pane stays fail-closed; only a pane that
    // was never sealed may use the observer fallback.
    if (pane.workerIncarnationId || seal) return undefined;
    return responseForUnsealedTarget({
      mission, agent, paneId: pane.paneId, runtimePanes: input.runtimePanes,
      observerPaneSessions: input.observerPaneSessions, handoffs: input.handoffs,
    });
  }
  const runtimes = responseRuntimesAreSane({ mission, paneId: pane.paneId, runtimePanes: input.runtimePanes });
  if (!runtimes) return undefined;
  const dispatchedAt = contract.dispatchedAt ?? contract.approvedAt ?? 0;
  const workerIncarnationId = pane.workerIncarnationId!;
  const handoff = input.handoffs.find((candidate) => {
    const sessionId = candidate.sessionId;
    return candidate.missionId === mission.id && candidate.authorityOrigin === 'agent' &&
      candidate.status === 'success' && candidate.evidenceTrust !== 'stale' &&
      Boolean(candidate.summary.trim()) && identifiesAgent(candidate.fromAgent, agent) &&
      typeof sessionId === 'string' &&
      (!runtimes[0]?.sessionId || sessionId === runtimes[0].sessionId) &&
      candidate.workerIncarnationId === workerIncarnationId &&
      candidate.createdAt >= dispatchedAt &&
      isSealedTeamQuestionReceipt({
        receipt: candidate.mcpProvenance, missionId: mission.id, sessionId,
        workerIncarnationId, dispatchedAt, handoffCreatedAt: candidate.createdAt,
      });
  });
  return handoff ? { handoff, viaObserverFallback: false } : undefined;
}

/** The approved roster is the denominator, even before its first panes launch. */
export function inspectTeamQuestionCompletion(input: {
  readonly mission: Mission;
  readonly squad: Squad | null | undefined;
  readonly panes: readonly MissionPaneSpec[];
  readonly runtimePanes: readonly TeamQuestionPaneRuntime[];
  readonly observerPaneSessions?: readonly TeamQuestionObserverBinding[];
  readonly handoffs: readonly Handoff[];
  readonly operatorOverride?: boolean;
}): TeamQuestionCompletion {
  if (input.operatorOverride === true || !isTeamQuestionMission(input.mission)) {
    return { applicable: false, ready: true, reason: '', missingTargets: [], responses: [], fallbackAgents: [] };
  }
  const { mission, squad } = input;
  const targets = squad?.agents.filter((agent) => agent.category !== 'orchestrator') ?? [];
  if (!squad || squad.id !== mission.squadId || targets.length === 0 ||
    !mission.intentContract?.squadRevisionHash ||
    snapshotSquadAuthority(squad).hash !== mission.intentContract.squadRevisionHash) {
    return {
      applicable: true, ready: false, missingTargets: targets.map((agent) => agent.agentName), responses: [],
      fallbackAgents: [],
      reason: 'team-question-roster-unavailable: restaure a equipe aprovada antes de consolidar as respostas.',
    };
  }
  const observerPaneSessions = input.observerPaneSessions ?? [];
  const responses: Array<{ agentName: string; handoff: Handoff }> = [];
  const fallbackAgents: string[] = [];
  const missingTargets: string[] = [];
  for (const agent of targets) {
    const response = responseForTarget({ ...input, agent, observerPaneSessions });
    const handoff = response?.handoff;
    if (!handoff || responses.some((previous) => previous.handoff.sessionId === handoff.sessionId ||
      previous.handoff.mcpProvenance?.receiptId === handoff.mcpProvenance?.receiptId)) {
      missingTargets.push(agent.agentName);
    } else {
      responses.push({ agentName: agent.agentName, handoff });
      if (response.viaObserverFallback) fallbackAgents.push(agent.agentName);
    }
  }
  return {
    applicable: true, ready: missingTargets.length === 0, missingTargets, responses, fallbackAgents,
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
