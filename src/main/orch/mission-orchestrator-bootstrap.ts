import type { WebContents } from 'electron';
import { z } from 'zod';
import { buildIntentDispatchKickoffPrompt } from '../../shared/mission-dispatch-kickoff';
import {
  hasCurrentApprovedDispatchContract,
  hasCurrentDispatchAuthority,
  missionBlockPatch,
  type MissionAttachmentSnapshot,
  type MissionOrchestratorRuntimeSnapshot,
} from '../../shared/mission-intent';
import type {
  Mission,
  MissionOrchestratorBootstrapResult,
  MissionOrchestratorPane,
  MissionPaneSpec,
  MissionPatch,
  Squad,
  SquadAgent,
} from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import {
  snapshotDroppedAttachmentPaths,
  validateDroppedAttachmentPaths,
} from '../persistence/dropped-files';
import {
  getAgentSessionInfo,
  getSessionState,
  type OwnedAgentSessionInfo,
} from '../pty/pty-manager';
import type {
  RebindOrchestratorAuthorityInput,
  RecordMissionPaneInput,
} from './mission-pane-store';
import {
  submitMissionKickoffFromMain,
  type MissionKickoffResult,
} from './mission-kickoff';
import { emitMissionIntentEvent } from './mission-intent-events';
import {
  getPaneRuntimeAuthorityBySession,
  requestPaneClose,
  spawnMainOwnedMissionPane,
  type PaneRuntimeAuthority,
  type PaneSpawnOptions,
} from './pane-registry';
import {
  getProjectDomainStores,
  requireProjectDomainStoreRegistry,
} from './project-domain-store-registry';
import { getSquad } from './squad-store';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import {
  canonicalMissionOrchestratorRuntime,
  resolveProductionMissionOrchestratorRuntime,
  sameMissionOrchestratorRuntime,
  type ResolvedMissionOrchestratorRuntime,
} from './mission-orchestrator-runtime';

export {
  preferredMissionOrchestratorAdapterId,
  type ResolvedMissionOrchestratorRuntime,
} from './mission-orchestrator-runtime';
import {
  resolveMissionPaneAuthoritySeal,
  sameMissionPaneApprovalSeal,
  sameMissionPaneAuthoritySeal,
} from './mission-pane-authority';

const BOOTSTRAP_BLOCK_MARKER = '<!-- nexus:orchestrator-bootstrap-blocked -->';
const BOOTSTRAP_TERMINATION_PENDING_MARKER =
  '<!-- nexus:orchestrator-termination-pending -->';
const BOOTSTRAP_CTA = 'Retomar missão';

function bootstrapFlightKey(
  scope: Readonly<ProjectExecutionScope>,
  missionId: string,
): string {
  return [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
    missionId,
  ].join('\0');
}

function bootstrapMissionSnapshot(mission: Mission): string {
  return JSON.stringify({
    id: mission.id,
    title: mission.title,
    description: mission.description,
    status: mission.status,
    squadId: mission.squadId ?? null,
    orchestratorSessionId: mission.orchestratorSessionId ?? null,
    intentState: mission.intentState ?? null,
    intentVersion: mission.intentVersion ?? 0,
    intentContract: mission.intentContract ?? null,
  });
}

function bootstrapMissionApprovalSnapshot(mission: Mission): string {
  return JSON.stringify({
    id: mission.id,
    title: mission.title,
    description: mission.description,
    status: mission.status,
    squadId: mission.squadId ?? null,
    intentState: mission.intentState ?? null,
    intentVersion: mission.intentVersion ?? 0,
    intentContract: mission.intentContract ?? null,
  });
}

function sameAttachmentSnapshots(
  expected: readonly MissionAttachmentSnapshot[] | undefined,
  actual: readonly MissionAttachmentSnapshot[] | undefined,
): boolean {
  const left = expected ?? [];
  const right = actual ?? [];
  return left.length === right.length && left.every((snapshot, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      snapshot.path === candidate.path &&
      snapshot.sha256 === candidate.sha256 &&
      snapshot.size === candidate.size;
  });
}

export const missionOrchestratorBootstrapRequestSchema = z
  .object({
    missionId: z.string().min(1).max(128),
  })
  .strict();

export interface MissionOrchestratorBootstrapDeps {
  getMission(scope: ProjectExecutionScope, missionId: string): Mission | null;
  updateMission(
    scope: ProjectExecutionScope,
    missionId: string,
    patch: MissionPatch,
  ): Mission | null;
  setOrchestratorSession(
    scope: ProjectExecutionScope,
    missionId: string,
    sessionId: string | null,
  ): Mission | null;
  hasCurrentKickoffAcceptance(
    scope: ProjectExecutionScope,
    missionId: string,
  ): boolean;
  listMissionPanes(
    scope: ProjectExecutionScope,
    missionId: string,
  ): MissionPaneSpec[];
  recordMissionPane(
    scope: ProjectExecutionScope,
    input: RecordMissionPaneInput,
  ): MissionPaneSpec;
  rebindMissionPaneAuthority?(
    scope: ProjectExecutionScope,
    input: RebindOrchestratorAuthorityInput,
  ): MissionPaneSpec;
  removeMissionPane(scope: ProjectExecutionScope, paneRowId: string): boolean;
  getSquad(squadId: string): Squad | null;
  resolveRuntime(
    squad: Squad,
    orchestrator: SquadAgent,
  ): ResolvedMissionOrchestratorRuntime;
  spawnMainOwnedPane(
    input: PaneSpawnOptions & {
      missionId: string;
      role: 'orchestrator';
    },
  ): ReturnType<typeof spawnMainOwnedMissionPane>;
  closePane(paneId: string): boolean | Promise<boolean>;
  getSessionState: typeof getSessionState;
  getAgentSessionInfo(sessionId: string): OwnedAgentSessionInfo | null;
  getRuntimeAuthority(sessionId: string): PaneRuntimeAuthority | null;
  submitKickoff(
    scope: Readonly<ProjectExecutionScope>,
    input: { missionId: string; sessionId: string; prompt: string },
  ): Promise<MissionKickoffResult>;
  emitDispatched(mission: Mission): void;
  validateAttachmentPaths(
    paths: readonly string[] | undefined,
  ): string[] | undefined;
  snapshotAttachmentPaths(
    paths: readonly string[] | undefined,
  ): MissionAttachmentSnapshot[] | undefined;
}

export interface MissionOrchestratorBootstrapRecoveryDeps {
  listScopes(): readonly ProjectExecutionScope[];
  listBootstrapCandidates(scope: ProjectExecutionScope): readonly Mission[];
  bootstrap(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionOrchestratorBootstrapResult>;
  warn?(message: string, error: unknown): void;
}

export const MISSION_ORCHESTRATOR_BOOTSTRAP_RECONCILE_MS = 5_000;

export function needsMissionOrchestratorBootstrapRecovery(
  mission: Pick<Mission, 'orchestratorSessionId'>,
  panes: readonly Pick<MissionPaneSpec, 'role'>[],
  hasCurrentKickoffAcceptance: boolean,
): boolean {
  const hasPersistedOrchestrator = panes.some(
    (pane) => pane.role === 'orchestrator',
  );
  return (
    !mission.orchestratorSessionId ||
    !hasPersistedOrchestrator ||
    !hasCurrentKickoffAcceptance
  );
}

function sameScope(
  left: Readonly<ProjectExecutionScope>,
  right: Readonly<ProjectExecutionScope>,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath
  );
}

function chooseOrchestrator(squad: Squad): SquadAgent | null {
  return squad.agents.find((agent) => agent.category === 'orchestrator') ?? null;
}

/** Bounded printable value for mismatch diagnostics (ids/models/paths only). */
function mismatchValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.slice(0, 96) || "''";
  return String(value);
}

/**
 * Every failing check of the exact-authority seal, by name and with both
 * sides' values. The seal compares ~20 fields across four sources (live agent
 * session, persisted pane row, approved runtime snapshot, runtime authority);
 * a boolean-only verdict made real field drifts (model alias, null-vs-undefined
 * accountId/effort, confinement flags) undiagnosable in the field — the
 * operator only ever saw "did not retain exact mission authority" with no
 * cause. Never weakens the check: callers still fail on any entry.
 */
export function runtimeAuthorityMismatches(
  scope: ProjectExecutionScope,
  mission: Mission,
  pane: MissionPaneSpec,
  agent: OwnedAgentSessionInfo | null,
  authority: PaneRuntimeAuthority | null,
  approvedRuntime: MissionOrchestratorRuntimeSnapshot,
): string[] {
  if (!mission.orchestratorSessionId) return ['mission.orchestratorSessionId ausente'];
  if (!agent) return ['agent session info ausente'];
  if (!authority) return ['runtime authority ausente'];
  // Canonical authority, not representation: "unspecified" arrives as
  // undefined from the durable pane row but as null from the PTY session
  // (pty-manager coalesces undefined→null). Both grant the same thing, so the
  // seal must not fail on the spelling — architect-designed squads omit the
  // field entirely and hit exactly this (field: agent.allowedSkills×pane).
  // An explicit [] stays distinct: it blocks everything.
  const sameCapabilities = (
    rawLeft: readonly string[] | null | undefined,
    rawRight: readonly string[] | null | undefined,
  ) => {
    const left = rawLeft ?? null;
    const right = rawRight ?? null;
    return (
      left === right ||
      (Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((value, index) => value === right[index]))
    );
  };
  const mismatches: string[] = [];
  const check = (name: string, left: unknown, right: unknown) => {
    if (left !== right) {
      mismatches.push(
        `${name}[${mismatchValue(left)} != ${mismatchValue(right)}]`,
      );
    }
  };
  check('agent.sessionId×mission', agent.sessionId, mission.orchestratorSessionId);
  check('agent.paneId×pane', agent.paneId, pane.paneId);
  check('agent.adapterId×pane', agent.adapterId, pane.adapterId);
  // Compare the REQUESTED model (0.19.27 fix): providers normalize the
  // model alias in agent.model; the seal validates what was requested and
  // approved, never the provider's normalized spelling.
  check('agent.requestedModel×pane', agent.requestedModel, pane.model);
  check('agent.accountId×pane', agent.accountId, pane.accountId);
  check('agent.effort×pane', agent.effort, pane.effort);
  check('agent.cwd×pane', agent.cwd, pane.cwd);
  check('agent.missionId', agent.missionId, mission.id);
  check('agent.role', agent.role, 'orchestrator');
  check('agent.readOnly×pane', agent.readOnly, pane.readOnly === true);
  check('pane.adapterId×runtime', pane.adapterId, approvedRuntime.adapterId);
  check('pane.model×runtime', pane.model, approvedRuntime.model);
  check('pane.accountId×runtime', pane.accountId, approvedRuntime.accountId);
  check('pane.effort×runtime', pane.effort, approvedRuntime.effort);
  check('pane.readOnly×runtime', pane.readOnly === true, approvedRuntime.readOnly);
  check('agent.readOnly×runtime', agent.readOnly, approvedRuntime.readOnly);
  check(
    'agent.nativeReadOnly×runtime',
    agent.nativeReadOnly,
    approvedRuntime.nativeReadOnly,
  );
  if (
    !sameMissionPaneAuthoritySeal(agent.authoritySeal, pane.authoritySeal)
  ) {
    mismatches.push('agent.authoritySeal×pane');
  }
  if (!sameCapabilities(agent.allowedTools, pane.allowedTools)) {
    mismatches.push('agent.allowedTools×pane');
  }
  if (!sameCapabilities(agent.allowedSkills, pane.allowedSkills)) {
    mismatches.push('agent.allowedSkills×pane');
  }
  if (!sameScope(agent.scope, scope)) mismatches.push('agent.scope');
  check('authority.sessionId×agent', authority.sessionId, agent.sessionId);
  check('authority.paneId×pane', authority.paneId, pane.paneId);
  check('authority.kind', authority.kind, 'cli-agent');
  check('authority.missionId', authority.missionId, mission.id);
  check('authority.role', authority.role, 'orchestrator');
  if (!authority.scope || !sameScope(authority.scope, scope)) {
    mismatches.push('authority.scope');
  }
  return mismatches;
}


function paneResult(
  pane: MissionPaneSpec,
  sessionId: string,
): MissionOrchestratorPane {
  if (!pane.paneId || !pane.cwd || !pane.agentName) {
    throw new Error('persisted orchestrator pane identity is incomplete');
  }
  return {
    paneId: pane.paneId,
    sessionId,
    adapterId: pane.adapterId,
    model: pane.model,
    accountId: pane.accountId,
    effort: pane.effort,
    cwd: pane.cwd,
    title: pane.title,
    agentName: pane.agentName,
    role: 'orchestrator',
  };
}

function failureDetail(reason: string, cause?: unknown): string {
  const suffix =
    cause instanceof Error && cause.message.trim()
      ? ` ${cause.message.trim()}`
      : '';
  return `${reason}${suffix}`.slice(0, 4_096);
}

const productionDeps: MissionOrchestratorBootstrapDeps = {
  getMission: (scope, missionId) =>
    getProjectDomainStores(scope).missions.get(missionId),
  updateMission: (scope, missionId, patch) =>
    getProjectDomainStores(scope).missions.update(missionId, patch),
  setOrchestratorSession: (scope, missionId, sessionId) =>
    getProjectDomainStores(scope).missions.setOrchestratorSession(
      missionId,
      sessionId,
    ),
  hasCurrentKickoffAcceptance: (scope, missionId) =>
    getProjectDomainStores(scope).missions.hasCurrentKickoffAcceptance(
      missionId,
    ),
  listMissionPanes: (scope, missionId) =>
    getProjectDomainStores(scope).missionPanes.list(missionId),
  recordMissionPane: (scope, input) =>
    getProjectDomainStores(scope).missionPanes.record(input),
  rebindMissionPaneAuthority: (scope, input) =>
    getProjectDomainStores(scope).missionPanes
      .rebindOrchestratorAuthority(input),
  removeMissionPane: (scope, paneRowId) =>
    getProjectDomainStores(scope).missionPanes.remove(paneRowId),
  getSquad: (squadId) => getSquad(squadId),
  resolveRuntime: (squad, orchestrator) =>
    resolveProductionMissionOrchestratorRuntime(squad, orchestrator),
  spawnMainOwnedPane: (input) => spawnMainOwnedMissionPane(input),
  closePane: (paneId) => requestPaneClose(paneId),
  getSessionState: (sessionId) => getSessionState(sessionId),
  getAgentSessionInfo: (sessionId) => getAgentSessionInfo(sessionId),
  getRuntimeAuthority: (sessionId) =>
    getPaneRuntimeAuthorityBySession(sessionId),
  submitKickoff: (scope, input) =>
    submitMissionKickoffFromMain(scope, input),
  emitDispatched: (mission) => {
    emitMissionIntentEvent({
      name: 'task_dispatched',
      missionId: mission.id,
      squadId: mission.squadId,
      intentState: mission.intentState,
      intentVersion: mission.intentVersion,
      reason: 'main_orchestrator_bootstrap',
    });
  },
  validateAttachmentPaths: (paths) => validateDroppedAttachmentPaths(paths),
  snapshotAttachmentPaths: (paths) => snapshotDroppedAttachmentPaths(paths),
};

/**
 * The only initial-orchestrator materializer. The public input is scope +
 * mission id; provider, account, model, cwd, roster and grants are derived
 * from trusted main stores immediately before each external effect.
 */
export class MissionOrchestratorBootstrapService {
  readonly #deps: MissionOrchestratorBootstrapDeps;
  readonly #flights = new Map<string, Promise<MissionOrchestratorBootstrapResult>>();
  readonly #authorizedSnapshots = new Map<string, string>();
  readonly #authorizedApprovalSnapshots = new Map<string, string>();

  constructor(deps: MissionOrchestratorBootstrapDeps = productionDeps) {
    this.#deps = deps;
  }

  bootstrap(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionOrchestratorBootstrapResult> {
    const key = bootstrapFlightKey(scope, missionId);
    const existing = this.#flights.get(key);
    if (existing) return existing;
    const flight = this.#bootstrap(scope, missionId)
      .catch((error) =>
        this.#failure(
          scope,
          missionId,
          'materialization_failed',
          failureDetail(
            'O bootstrap main-owned falhou inesperadamente.',
            error,
          ),
        ),
      )
      .finally(() => {
        if (this.#flights.get(key) === flight) this.#flights.delete(key);
        this.#authorizedSnapshots.delete(key);
        this.#authorizedApprovalSnapshots.delete(key);
      });
    this.#flights.set(key, flight);
    return flight;
  }

  async #bootstrap(
    scope: ProjectExecutionScope,
    missionId: string,
  ): Promise<MissionOrchestratorBootstrapResult> {
    const initial = this.#deps.getMission(scope, missionId);
    if (
      !initial ||
      initial.status !== 'running' ||
      !hasCurrentDispatchAuthority(initial)
    ) {
      return this.#failure(
        scope,
        missionId,
        'not_authorized',
        'O bootstrap exige uma missão running com intenção aprovada.',
      );
    }
    this.#authorizedSnapshots.set(
      bootstrapFlightKey(scope, missionId),
      bootstrapMissionSnapshot(initial),
    );
    this.#authorizedApprovalSnapshots.set(
      bootstrapFlightKey(scope, missionId),
      bootstrapMissionApprovalSnapshot(initial),
    );

    const squad = initial.squadId
      ? this.#deps.getSquad(initial.squadId)
      : null;
    const orchestrator = squad ? chooseOrchestrator(squad) : null;
    if (!squad || !orchestrator) {
      return this.#failure(
        scope,
        missionId,
        'squad_missing',
        'O squad salvo ou seu orquestrador não está disponível.',
      );
    }
    const squadSnapshot = snapshotSquadAuthority(squad);
    if (
      initial.intentContract?.squadRevisionHash !== squadSnapshot.hash
    ) {
      return this.#failure(
        scope,
        missionId,
        'preflight_failed',
        'O squad salvo mudou depois da aprovação. Revise a intenção e aprove ' +
        'novamente antes de iniciar qualquer provider.',
      );
    }
    const authoritySeal = resolveMissionPaneAuthoritySeal(
      scope,
      initial,
      squad,
    );
    if (!authoritySeal) {
      return this.#failure(
        scope,
        missionId,
        'preflight_failed',
        'A revisão aprovada não pôde ser selada para o pane. Replaneje e aprove novamente.',
      );
    }

    const approvedRuntime = initial.intentContract?.orchestratorRuntime;
    if (!approvedRuntime) {
      return this.#failure(
        scope,
        missionId,
        'preflight_failed',
        'O contrato aprovado não contém o snapshot do runtime inicial. ' +
          'Revise a intenção e reaprove antes de iniciar qualquer provider.',
      );
    }

    let resolvedRuntime: MissionOrchestratorRuntimeSnapshot;
    try {
      resolvedRuntime = canonicalMissionOrchestratorRuntime(
        this.#deps.resolveRuntime(squad, orchestrator),
      );
    } catch (error) {
      return this.#failure(
        scope,
        missionId,
        'preflight_failed',
        failureDetail('O preflight do runtime do orquestrador falhou.', error),
      );
    }
    if (!sameMissionOrchestratorRuntime(approvedRuntime, resolvedRuntime)) {
      return this.#failure(
        scope,
        missionId,
        'preflight_failed',
        'O runtime do orquestrador mudou desde a aprovação (provider, modelo, ' +
          'conta, esforço ou confinamento). Revise e reaprove antes de iniciar.',
      );
    }
    // External effects consume the persisted approval, never a mutable
    // settings object. Equality above proves that it remains currently valid.
    const runtime = approvedRuntime;

    let persistedOrchestrator = this.#deps
      .listMissionPanes(scope, missionId)
      .find((pane) => pane.role === 'orchestrator');
    if (
      persistedOrchestrator &&
      !sameMissionPaneAuthoritySeal(
        persistedOrchestrator.authoritySeal,
        authoritySeal,
      )
    ) {
      if (
        persistedOrchestrator.paneId &&
        persistedOrchestrator.authoritySeal &&
        sameMissionPaneApprovalSeal(
          persistedOrchestrator.authoritySeal,
          authoritySeal,
        ) &&
        this.#deps.rebindMissionPaneAuthority
      ) {
        try {
          persistedOrchestrator =
            this.#deps.rebindMissionPaneAuthority(scope, {
              missionId,
              paneId: persistedOrchestrator.paneId,
              expectedAuthoritySeal:
                persistedOrchestrator.authoritySeal,
              authoritySeal,
            });
        } catch (error) {
          return this.#failure(
            scope,
            missionId,
            'preflight_failed',
            failureDetail(
              'O reseal do orquestrador após freeze/refreeze falhou.',
              error,
            ),
          );
        }
      } else {
        return this.#failure(
          scope,
          missionId,
          'preflight_failed',
          'O pane persistido pertence a outra revisão de intenção, contexto, ' +
            'contrato ou squad. Replaneje e aprove antes de retomar.',
        );
      }
    }
    if (initial.orchestratorSessionId || persistedOrchestrator) {
      const sessionId = initial.orchestratorSessionId;
      const agent = sessionId
        ? this.#deps.getAgentSessionInfo(sessionId)
        : null;
      const authority = sessionId
        ? this.#deps.getRuntimeAuthority(sessionId)
        : null;
      if (
        sessionId &&
        persistedOrchestrator &&
        this.#deps.getSessionState(sessionId) !== null &&
        runtimeAuthorityMismatches(
          scope,
          initial,
          persistedOrchestrator,
          agent,
          authority,
          runtime,
        ).length === 0
      ) {
        if (!this.#deps.hasCurrentKickoffAcceptance(scope, missionId)) {
          return this.#failure(
            scope,
            missionId,
            'materialization_failed',
            'A sessão existe, mas não há recibo durável do aceite idle→busy ' +
              'para esta revisão. O Nexus não repetiu o kickoff para evitar ' +
              'execução duplicada.',
          );
        }
        return {
          ok: true,
          missionId,
          pane: paneResult(persistedOrchestrator, sessionId),
          kickoff: { accepted: true },
          reused: true,
        };
      }
      return this.#failure(
        scope,
        missionId,
        'provider_exited',
        'O provider do orquestrador encerrou. O Nexus preservou a missão e ' +
          'não repetiu o kickoff automaticamente; clique em “Retomar missão” ' +
          'para revisar e iniciar uma nova sessão.',
      );
    }

    let attachmentPaths: string[] | undefined;
    let attachmentSnapshots: MissionAttachmentSnapshot[] | undefined;
    try {
      attachmentPaths = this.#deps.validateAttachmentPaths(
        initial.intentContract?.attachmentPaths,
      );
      attachmentSnapshots = this.#deps.snapshotAttachmentPaths(attachmentPaths);
      if (
        !sameAttachmentSnapshots(
          initial.intentContract?.attachmentSnapshots,
          attachmentSnapshots,
        )
      ) {
        throw new Error(
          'o conteúdo dos anexos mudou desde a aprovação; nova aprovação é obrigatória',
        );
      }
    } catch (error) {
      return this.#failure(
        scope,
        missionId,
        'preflight_failed',
        failureDetail('A validação dos anexos da missão falhou.', error),
      );
    }

    const title = `${squad.name} · orq`;
    const spawn = this.#deps.spawnMainOwnedPane({
      adapterId: runtime.adapterId,
      model: runtime.model,
      accountId: runtime.accountId,
      effort: runtime.effort,
      cwd: scope.rootRealPath,
      title,
      missionId,
      agentName: orchestrator.agentName,
      allowedTools: orchestrator.allowedTools,
      allowedSkills: orchestrator.allowedSkills,
      role: 'orchestrator',
      scope,
      executionScope: scope,
      // MCP remains delegation-capable. Native Bash/Edit/git is independently
      // denied by the provider confinement selected above.
      readOnly: runtime.readOnly,
      nativeReadOnly: runtime.nativeReadOnly,
      authoritySeal,
    });
    if (!spawn.ok || !spawn.paneId || !spawn.sessionId) {
      return this.#failure(
        scope,
        missionId,
        'spawn_failed',
        `O provider do orquestrador não iniciou. ${
          spawn.error ?? 'Falha física sem detalhe.'
        }`,
      );
    }

    let paneRow: MissionPaneSpec | null = null;
    let sessionBound = false;
    try {
      paneRow = this.#deps.recordMissionPane(scope, {
        missionId,
        paneId: spawn.paneId,
        adapterId: runtime.adapterId,
        model: runtime.model,
        accountId: runtime.accountId,
        effort: runtime.effort,
        cwd: scope.rootRealPath,
        title,
        agentName: orchestrator.agentName,
        role: 'orchestrator',
        allowedTools: orchestrator.allowedTools,
        allowedSkills: orchestrator.allowedSkills,
        readOnly: runtime.readOnly,
        executionScope: scope,
        authoritySeal,
      });
      const bound = this.#deps.setOrchestratorSession(
        scope,
        missionId,
        spawn.sessionId,
      );
      if (!bound) throw new Error('mission disappeared during bootstrap');
      sessionBound = true;
      const current = this.#deps.getMission(scope, missionId);
      const agent = this.#deps.getAgentSessionInfo(spawn.sessionId);
      const authority = this.#deps.getRuntimeAuthority(spawn.sessionId);
      if (!current) {
        throw new Error('mission disappeared before authority seal');
      }
      const mismatches = runtimeAuthorityMismatches(
        scope,
        current,
        paneRow,
        agent,
        authority,
        runtime,
      );
      if (mismatches.length > 0) {
        throw new Error(
          'spawned PTY did not retain exact mission authority — divergências: ' +
            mismatches.slice(0, 8).join('; '),
        );
      }

      this.#deps.emitDispatched(current);
      const prompt = buildIntentDispatchKickoffPrompt({
        squad,
        missionId,
        missionTitle: current.title,
        goal: current.intentContract!.goal,
        acceptanceCriteria: current.intentContract!.acceptanceCriteria,
        risk: current.intentContract!.risk,
        maxWorkers: current.intentContract!.budgets.maxWorkers,
        lane: current.intentContract!.lane ?? 'standard',
        attachmentPaths,
      });
      const kickoff = await this.#deps.submitKickoff(scope, {
        missionId,
        sessionId: spawn.sessionId,
        prompt,
      });
      return {
        ok: true,
        missionId,
        pane: paneResult(paneRow, spawn.sessionId),
        kickoff,
      };
    } catch (error) {
      const detail = failureDetail(
        'O bootstrap não pôde selar a autoridade da sessão.',
        error,
      );
      const currentBeforeTeardown = this.#deps.getMission(scope, missionId);
      const failure = this.#failure(
        scope,
        missionId,
        'materialization_failed',
        detail,
        currentBeforeTeardown
          ? bootstrapMissionSnapshot(currentBeforeTeardown)
          : undefined,
      );

      // Revoke durable mission authority before waiting for the physical
      // process. The binding remains the source of truth until closePane
      // returns an affirmative exit proof.
      let physicallyClosed = false;
      try {
        physicallyClosed = await this.#deps.closePane(spawn.paneId);
      } catch {
        physicallyClosed = false;
      }
      if (physicallyClosed) {
        const current = this.#deps.getMission(scope, missionId);
        if (
          sessionBound &&
          current?.orchestratorSessionId === spawn.sessionId
        ) {
          this.#deps.setOrchestratorSession(scope, missionId, null);
        }
        if (paneRow) this.#deps.removeMissionPane(scope, paneRow.id);
      } else {
        this.#markTerminationPending(
          scope,
          missionId,
          spawn.sessionId,
          detail,
        );
      }
      return failure;
    }
  }

  #markTerminationPending(
    scope: ProjectExecutionScope,
    missionId: string,
    sessionId: string,
    detail: string,
  ): void {
    const current = this.#deps.getMission(scope, missionId);
    if (
      !current ||
      current.orchestratorSessionId !== sessionId ||
      current.status === 'done' ||
      current.status === 'failed'
    ) {
      return;
    }
    const note =
      `${BOOTSTRAP_TERMINATION_PENDING_MARKER}\n` +
      `## Encerramento físico pendente\n${detail} O Nexus preservou o vínculo ` +
      `do pane até obter prova de saída. CTA: ${BOOTSTRAP_CTA}.`;
    const description = current.description.includes(
      BOOTSTRAP_TERMINATION_PENDING_MARKER,
    )
      ? current.description
      : [current.description.trim(), note]
          .filter(Boolean)
          .join('\n\n')
          .slice(0, 65_536);
    this.#deps.updateMission(scope, missionId, {
      ...missionBlockPatch('technical'),
      description,
    });
  }

  #failure(
    scope: ProjectExecutionScope,
    missionId: string,
    reason: Extract<MissionOrchestratorBootstrapResult, { ok: false }>['reason'],
    detail: string,
    expectedCurrentSnapshot?: string,
  ): MissionOrchestratorBootstrapResult {
    const current = this.#deps.getMission(scope, missionId);
    const key = bootstrapFlightKey(scope, missionId);
    const authorizedSnapshot = this.#authorizedSnapshots.get(key);
    const authorizedApprovalSnapshot =
      this.#authorizedApprovalSnapshots.get(key);
    const exactSnapshot = expectedCurrentSnapshot ?? authorizedSnapshot;
    if (
      reason !== 'not_authorized' &&
      exactSnapshot !== undefined &&
      authorizedApprovalSnapshot !== undefined &&
      current &&
      bootstrapMissionSnapshot(current) === exactSnapshot &&
      bootstrapMissionApprovalSnapshot(current) ===
        authorizedApprovalSnapshot &&
      current.status !== 'done' &&
      current.status !== 'failed'
    ) {
      const note =
        `${BOOTSTRAP_BLOCK_MARKER}\n## Orquestrador não iniciado\n${detail} ` +
        `CTA: ${BOOTSTRAP_CTA}.`;
      const description = current.description.includes(BOOTSTRAP_BLOCK_MARKER)
        ? current.description
        : [current.description.trim(), note]
            .filter(Boolean)
            .join('\n\n')
            .slice(0, 65_536);
      this.#deps.updateMission(scope, missionId, {
        ...missionBlockPatch('technical'),
        description,
      });
    }
    return {
      ok: false,
      missionId,
      reason,
      error: detail,
      cta: BOOTSTRAP_CTA,
    };
  }
}

/**
 * Restart/event recovery for the durable approval → initial-orchestrator edge.
 *
 * Calls are coalesced into one promise. The bootstrap service remains the
 * authority for per-mission singleflight, live-session reuse and fail-closed
 * blocking, so recovery cannot create a second PTY. The coordinator cadence
 * provides the bounded follow-up pass for a scope discovered mid-flight.
 */
export class MissionOrchestratorBootstrapRecovery {
  readonly #deps: MissionOrchestratorBootstrapRecoveryDeps;
  #flight: Promise<void> | null = null;

  constructor(deps: MissionOrchestratorBootstrapRecoveryDeps) {
    this.#deps = deps;
  }

  reconcile(): Promise<void> {
    if (this.#flight) return this.#flight;
    const flight = this.#pass()
      .catch((error) => {
        this.#warn(
          '[mission-orchestrator-bootstrap] recovery pass failed:',
          error,
        );
      })
      .finally(() => {
        if (this.#flight === flight) this.#flight = null;
      });
    this.#flight = flight;
    return flight;
  }

  waitForIdle(): Promise<void> {
    return this.#flight ?? Promise.resolve();
  }

  async #pass(): Promise<void> {
    const pending: Array<Promise<void>> = [];
    for (const scope of this.#deps.listScopes()) {
      let missions: readonly Mission[];
      try {
        missions = this.#deps.listBootstrapCandidates(scope);
      } catch (error) {
        this.#warn(
          `[mission-orchestrator-bootstrap] could not list scope ${scope.projectId}:`,
          error,
        );
        continue;
      }
      for (const mission of missions) {
        if (
          mission.status !== 'running' ||
          !hasCurrentDispatchAuthority(mission)
        ) {
          continue;
        }
        pending.push(
          this.#deps.bootstrap(scope, mission.id).then(
            () => undefined,
            (error) => {
              this.#warn(
                `[mission-orchestrator-bootstrap] recovery failed for ${mission.id}:`,
                error,
              );
            },
          ),
        );
      }
    }
    await Promise.all(pending);
  }

  #warn(message: string, error: unknown): void {
    (this.#deps.warn ?? console.warn)(message, error);
  }
}

const productionService = new MissionOrchestratorBootstrapService();
const productionScopes = new Map<string, ProjectExecutionScope>();
const productionRecovery = new MissionOrchestratorBootstrapRecovery({
  listScopes: () => [...productionScopes.values()],
  listBootstrapCandidates: (scope) => {
    const stores = getProjectDomainStores(scope);
    return stores.missions.list('running').filter((mission) => {
      // A complete durable binding already has its own lifecycle/rebind
      // supervision. Recovery owns the missing or torn approval→bootstrap
      // edge only; a half-binding is sent through the service so it blocks
      // with a CTA instead of spawning blindly.
      return needsMissionOrchestratorBootstrapRecovery(
        mission,
        stores.missionPanes.list(mission.id),
        stores.missions.hasCurrentKickoffAcceptance(mission.id),
      );
    });
  },
  bootstrap: (scope, missionId) =>
    productionService.bootstrap(scope, missionId),
});
let disposeProductionScopeListener: (() => void) | null = null;

function productionScopeKey(scope: Readonly<ProjectExecutionScope>): string {
  return [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
  ].join('\0');
}

/** Main-process boundary used by approval and recovery, sharing one singleflight. */
export function bootstrapMissionOrchestratorForScope(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<MissionOrchestratorBootstrapResult> {
  return productionService.bootstrap(scope, missionId);
}

/**
 * Whether — and how — a bootstrap-blocked mission may be re-armed for another
 * bootstrap attempt. Pure so the exact recovery precondition is testable: only
 * a mission the BOOTSTRAP failure itself blocked (marker in description,
 * blocked/blocked_technical, approved dispatch authority intact) qualifies.
 * Field wedge this exits: bootstrap failure → blocked_technical with zero
 * panes → wizard retry hits "invalid transition", rail reopen finds no pane
 * composition, removal preserves the mission — no recovery path at all.
 */
export function blockedBootstrapResumePatch(
  mission: Mission,
): {
  ok: true;
  patch: {
    status: 'running';
    intentState: 'executing';
    description: string;
  };
} | {
  ok: false;
  error: string;
} {
  // Qualquer blocked_technical com contrato aprovado vigente é resumível
  // pelo bootstrap: os re-bloqueios do próprio ciclo (kickoff sem recibo,
  // provider_exited) NÃO anexam o marker, e exigi-lo aqui devolvia a missão
  // ao restore de panes — que recria a identidade morta que o bootstrap
  // recusa (beco circular). O bootstrap revalida squad/contrato/runtime de
  // qualquer forma. blocked_user segue no caminho de re-arme com panes.
  if (
    mission.status !== 'blocked' ||
    (
      mission.intentState !== 'blocked_technical' &&
      mission.intentState !== 'blocked_user'
    )
  ) {
    return {
      ok: false,
      error:
        'Só uma missão bloqueada pode ser retomada por aqui.',
    };
  }
  // The approved contract must still be current; everything else (squad hash,
  // runtime, seal) is re-validated by the bootstrap itself after re-arm.
  if (!hasCurrentApprovedDispatchContract(mission)) {
    return {
      ok: false,
      error:
        'A aprovação da missão não está mais vigente. Revise a intenção e aprove novamente.',
    };
  }
  const description = mission.description
    .split(BOOTSTRAP_BLOCK_MARKER)[0]!
    .trim();
  // begin_execution is the state machine's sanctioned exit from
  // blocked_technical; canDispatchWorkers excludes blocked states, so the
  // bootstrap would refuse a re-armed mission that kept the blocked intent.
  return {
    ok: true,
    patch: { status: 'running', intentState: 'executing', description },
  };
}

/**
 * Re-arm (only) a blocked mission that still has persisted pane composition:
 * pane respawn resolves the current authority seal from the LIVE mission, and
 * createMissionPaneAuthoritySeal is null while status != running — so panes
 * must never respawn before the mission is re-armed. Uses the state machine's
 * sanctioned exits (user_resume / begin_execution → executing). Pure for
 * testability; the IPC boundary applies the patch and the renderer then
 * restores the composition.
 */
export function blockedMissionRearmPatch(
  mission: Mission,
): {
  ok: true;
  patch: {
    status: 'running';
    intentState: 'executing';
    description: string;
  };
} | {
  ok: false;
  error: string;
} {
  if (
    mission.status !== 'blocked' ||
    (mission.intentState !== 'blocked_technical' &&
      mission.intentState !== 'blocked_user')
  ) {
    return {
      ok: false,
      error: 'Só uma missão bloqueada pode ser re-armada para retomada.',
    };
  }
  if (!hasCurrentApprovedDispatchContract(mission)) {
    return {
      ok: false,
      error:
        'A aprovação da missão não está mais vigente. Revise a intenção e aprove novamente.',
    };
  }
  const description = mission.description
    .split(BOOTSTRAP_BLOCK_MARKER)[0]!
    .trim();
  return {
    ok: true,
    patch: { status: 'running', intentState: 'executing', description },
  };
}

/** Main boundary: re-arm a blocked mission before the renderer restores panes. */
export function rearmBlockedMissionForScope(
  scope: ProjectExecutionScope,
  missionId: string,
): { ok: true } | { ok: false; error: string } {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) {
    return { ok: false, error: 'Missão não encontrada neste workspace.' };
  }
  const rearm = blockedMissionRearmPatch(mission);
  if (!rearm.ok) return rearm;
  const updated = stores.missions.update(missionId, rearm.patch);
  if (!updated) {
    return { ok: false, error: 'A missão mudou durante a retomada. Tente novamente.' };
  }
  return { ok: true };
}

/** Renderer boundary for the pane-preserving re-arm. */
export function rearmBlockedMissionFromRenderer(
  owner: WebContents,
  raw: unknown,
): { ok: true } | { ok: false; error: string } {
  const input = missionOrchestratorBootstrapRequestSchema.parse(raw);
  const scope = requireRendererWorkspaceScope(owner);
  return rearmBlockedMissionForScope(scope, input.missionId);
}

/**
 * Re-arm a bootstrap-blocked mission and retry the orchestrator bootstrap.
 * The bootstrap re-validates every authority (squad hash, contract, runtime)
 * and re-blocks with an actionable marker if the retry fails again.
 */
export async function resumeBlockedMissionBootstrapForScope(
  scope: ProjectExecutionScope,
  missionId: string,
): Promise<MissionOrchestratorBootstrapResult> {
  const stores = getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) {
    return {
      ok: false,
      missionId,
      reason: 'not_authorized',
      error: 'Missão não encontrada neste workspace.',
      cta: BOOTSTRAP_CTA,
    };
  }
  const resume = blockedBootstrapResumePatch(mission);
  if (!resume.ok) {
    return {
      ok: false,
      missionId,
      reason: 'not_authorized',
      error: resume.error,
      cta: BOOTSTRAP_CTA,
    };
  }
  // Bootstrap re-entry refuses while a stale orchestrator identity persists
  // (dead session + pane row): it #failures with the SAME "Retomar missão"
  // CTA this resume implements — a circular dead end. A PROVEN-dead session
  // (no PTY state) holds no execution; clear the durable identity so the
  // bootstrap takes its fresh spawn+kickoff path. A live session is left
  // untouched — its duplicate-kickoff guard stands.
  const staleSessionId = mission.orchestratorSessionId;
  if (!staleSessionId || getSessionState(staleSessionId) === null) {
    if (staleSessionId) {
      stores.missions.setOrchestratorSession(missionId, null);
    }
    for (const row of stores.missionPanes.list(missionId)) {
      if (row.role === 'orchestrator') stores.missionPanes.remove(row.id);
    }
  }
  const updated = stores.missions.update(missionId, resume.patch);
  if (!updated) {
    return {
      ok: false,
      missionId,
      reason: 'not_authorized',
      error: 'A missão mudou durante a retomada. Tente novamente.',
      cta: BOOTSTRAP_CTA,
    };
  }
  return bootstrapMissionOrchestratorForScope(scope, missionId);
}

/** Starts durable-scope discovery before the coordinator's first pass. */
export function prepareMissionOrchestratorBootstrapRecovery(): void {
  if (disposeProductionScopeListener) return;
  disposeProductionScopeListener = requireProjectDomainStoreRegistry().onScope(
    (scope) => {
      productionScopes.set(productionScopeKey(scope), scope);
      // onScope runs after the durable suite is registered. Starting the
      // singleflight here closes restart recovery even before the renderer
      // reopens, while the coordinator supplies the periodic safety net.
      void productionRecovery.reconcile();
    },
  );
}

export function reconcileMissionOrchestratorBootstrap(): Promise<void> {
  return productionRecovery.reconcile();
}

export async function shutdownMissionOrchestratorBootstrapRecovery(): Promise<void> {
  disposeProductionScopeListener?.();
  disposeProductionScopeListener = null;
  productionScopes.clear();
  await productionRecovery.waitForIdle();
}

/** Renderer boundary: the only accepted input is the opaque mission id. */
export function bootstrapMissionOrchestratorFromRenderer(
  owner: WebContents,
  raw: unknown,
): Promise<MissionOrchestratorBootstrapResult> {
  const input = missionOrchestratorBootstrapRequestSchema.parse(raw);
  const scope = requireRendererWorkspaceScope(owner);
  return bootstrapMissionOrchestratorForScope(scope, input.missionId);
}

/** Renderer boundary for retrying a bootstrap-blocked mission. */
export function resumeBlockedMissionBootstrapFromRenderer(
  owner: WebContents,
  raw: unknown,
): Promise<MissionOrchestratorBootstrapResult> {
  const input = missionOrchestratorBootstrapRequestSchema.parse(raw);
  const scope = requireRendererWorkspaceScope(owner);
  return resumeBlockedMissionBootstrapForScope(scope, input.missionId);
}
