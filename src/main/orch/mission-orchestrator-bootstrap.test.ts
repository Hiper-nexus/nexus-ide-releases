import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Handoff,
  Mission,
  MissionPaneSpec,
  PaneSnapshot,
  Squad,
} from '../../shared/orch-types';
import { TEAM_READ_ONLY_FANOUT_DOMAIN } from '../../shared/mission-topology';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  runMissionKickoffAcceptance,
  type MissionKickoffResult,
} from './mission-kickoff';
import {
  blockedBootstrapResumePatch,
  blockedMissionRearmPatch,
  blockedPlanPromotionResumePatch,
  MissionOrchestratorBootstrapRecovery,
  MissionOrchestratorBootstrapService,
  needsMissionOrchestratorBootstrapRecovery,
  prepareDeadGraphReapprovalForScope,
  preferredMissionOrchestratorAdapterId,
  resumeAutomaticallyBlockedMissionBootstrapForScope,
  restartMissionOrchestratorAfterPlanPromotionForScope,
  runtimeAuthorityMismatches,
  stopMissionOrchestratorBeforePlanPromotionForScope,
  TECHNICAL_RECOVERY_MAX_ATTEMPTS,
  type MissionOrchestratorBootstrapDeps,
  type DeadGraphReapprovalDeps,
  type PlanPromotionRestartDeps,
} from './mission-orchestrator-bootstrap';
import { withMissionLifecycleLock } from './mission-lifecycle-lock';
import { snapshotSquadAuthority } from './squad-authority-snapshot';
import { createMissionPaneAuthoritySeal } from './mission-pane-authority';
import { NEXUS_STORY_IMPLEMENTATION_SQUAD_ID } from '../../shared/builtin-squad-ids';
import { selectPhysicalPlanHandoff } from './plan-promotion-authority';
import type { TaskDispatchRecord } from './task-dispatch-store';
import { TERMINAL_OPERATIONAL_FAILURE_MARKER } from '../runtime/operational-failure-policy';
import { RETIRED_ROSTER_ROUTE_MARKER } from '../../shared/retired-adapter-policy';
import { RetiredRosterRouteError } from '../../shared/retired-adapter-policy';
import {
  decodeTaskScheduleDetail,
  encodeTaskScheduleDetail,
} from './mission-scheduler-meta';
import { ensureGuidedMissionPlan } from './guided-mission-planner';
import {
  harness as guidedPlannerHarness,
  mission as guidedMission,
  sealedGuidedV2Receipt,
} from './guided-mission-planner-test-harness';

const scope = Object.freeze({
  version: 1 as const,
  installationId: 'installation-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest' as const,
});

const squad: Squad = {
  id: 'mission-runtime-123e4567-e89b-42d3-a456-426614174000',
  name: 'Squad salvo',
  createdAt: '1',
  builtin: false,
  runtimeSourceSquadId: 'saved-squad-source',
  runtimeSourceSquadRevisionHash: 'a'.repeat(64),
  orchestratorInstructions: '# Missão antiga\nCoordene pelo Nexus.',
  agents: [
    {
      id: 'orch',
      agentName: 'Maestro',
      category: 'orchestrator',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      allowedTools: ['nexus_task'],
      allowedSkills: ['check-work'],
    },
    {
      id: 'worker',
      agentName: 'Implementador',
      category: 'executor',
      cli: 'codex',
      model: 'gpt-5.6-sol',
      allowedTools: ['Read', 'Edit'],
      allowedSkills: null,
    },
  ],
};
const approvedRuntime = Object.freeze({
  adapterId: 'codex',
  model: 'gpt-5.6-sol',
  accountId: 'account-codex',
  effort: 'high',
  readOnly: false as const,
  nativeReadOnly: true as const,
});
const approvedAttachment = Object.freeze({
  path: '/validated/proof.png',
  sha256: 'e'.repeat(64),
  size: 321,
});

function approvedMission(): Mission {
  return {
    id: 'mission-approved',
    title: 'Fechar bootstrap main-owned',
    description: 'Fechar bootstrap main-owned',
    status: 'running',
    squadId: squad.id,
    milestones: [],
    learnings: '',
    intentState: 'dispatched',
    intentVersion: 1,
    intentContract: {
      version: 1,
      source: 'typed',
      goal: 'Fechar bootstrap main-owned sem renderer',
      acceptanceCriteria: ['Kickoff produz idle para busy'],
      risk: 'normal',
      executionMode: 'assisted',
      contextPolicy: 'on-demand',
      intentVersion: 1,
      approvedAt: 100,
      dispatchedAt: 100,
      budgets: {
        planningTokens: 1_200,
        executionTokens: 8_000,
        maxWorkers: 2,
      },
      attachmentPaths: ['/validated/proof.png'],
      attachmentSnapshots: [approvedAttachment],
      squadRevisionHash: snapshotSquadAuthority(squad).hash,
      orchestratorRuntime: approvedRuntime,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function authoritySealFor(mission: Mission = approvedMission()) {
  const seal = createMissionPaneAuthoritySeal({ mission, squad });
  if (!seal) throw new Error('test mission authority seal was not created');
  return seal;
}

interface Harness {
  mission: Mission;
  recorded: Array<Record<string, unknown>>;
  removedPaneRows: string[];
  closedPanes: string[];
  spawned: Array<Record<string, unknown>>;
  kickoffPrompts: string[];
  kickoffAccepted: boolean;
  kickoffFlightPending: boolean;
  deps: MissionOrchestratorBootstrapDeps;
}

function harness(): Harness {
  const value = {} as Harness;
  value.mission = approvedMission();
  value.recorded = [];
  value.removedPaneRows = [];
  value.closedPanes = [];
  value.spawned = [];
  value.kickoffPrompts = [];
  value.kickoffAccepted = false;
  value.kickoffFlightPending = false;
  value.deps = {
    getMission: (_scope, missionId) =>
      missionId === value.mission.id ? value.mission : null,
    updateMission: (_scope, missionId, patch) => {
      if (missionId !== value.mission.id) return null;
      const nextIntentContract =
        patch.intentContract === null
          ? undefined
          : patch.intentContract ?? value.mission.intentContract;
      value.mission = {
        ...value.mission,
        ...patch,
        // No bootstrap failure patch mutates milestones. Keep the normalized
        // durable shape instead of widening it to MissionPatch input.
        milestones: value.mission.milestones,
        intentContract: nextIntentContract,
        updatedAt: Date.now(),
      };
      return value.mission;
    },
    setOrchestratorSession: (_scope, missionId, sessionId) => {
      if (missionId !== value.mission.id) return null;
      value.mission = {
        ...value.mission,
        orchestratorSessionId: sessionId ?? undefined,
        updatedAt: Date.now(),
      };
      return value.mission;
    },
    clearOrchestratorSessionIfMatches: (
      _scope,
      missionId,
      expectedSessionId,
    ) => {
      if (
        missionId !== value.mission.id ||
        value.mission.orchestratorSessionId !== expectedSessionId
      ) {
        return null;
      }
      value.mission = {
        ...value.mission,
        orchestratorSessionId: undefined,
        updatedAt: Date.now(),
      };
      return value.mission;
    },
    retireOrchestratorSessionForReplacement: (
      _scope,
      missionId,
      expectedSessionId,
    ) => {
      if (
        missionId !== value.mission.id ||
        value.mission.orchestratorSessionId !== expectedSessionId
      ) {
        return null;
      }
      value.mission = {
        ...value.mission,
        orchestratorSessionId: undefined,
        updatedAt: Date.now(),
      };
      return value.mission;
    },
    hasCurrentKickoffAcceptance: () => value.kickoffAccepted,
    hasPendingKickoffFlight: () => value.kickoffFlightPending,
    listMissionPanes: () => [],
    recordMissionPane: (_scope, input) => {
      value.recorded.push(input as unknown as Record<string, unknown>);
      return {
        id: 'mpane-orch',
        createdAt: 1,
        scope,
        executionScope: scope,
        ...input,
        title: input.title ?? input.agentName ?? input.adapterId,
        role: input.role ?? 'worker',
      };
    },
    removeMissionPane: (_scope, id) => {
      value.removedPaneRows.push(id);
      return true;
    },
    getSquad: (id) => (id === squad.id ? squad : null),
    resolveRuntime: () => approvedRuntime,
    spawnMainOwnedPane: async (input) => {
      value.spawned.push(input as unknown as Record<string, unknown>);
      return {
        requestId: 'bootstrap-1',
        ok: true,
        paneId: 'pane-main-orch',
        sessionId: 'pty-main-orch',
      };
    },
    closePane: (paneId) => {
      value.closedPanes.push(paneId);
      return true;
    },
    suppressIntentionalExit: () => () => {},
    listRuntimePanes: () => [],
    getSessionState: () => 'idle',
    getAgentSessionInfo: (sessionId) =>
      sessionId === 'pty-main-orch'
        ? {
            sessionId,
            paneId: 'pane-main-orch',
            adapterId: 'codex',
            model: 'gpt-5.6-sol',
            requestedModel: 'gpt-5.6-sol',
            accountId: 'account-codex',
            effort: 'high',
            cwd: scope.rootRealPath,
            scope,
            source: 'pending',
            role: 'orchestrator',
            missionId: value.mission.id,
            agentName: 'Maestro',
            readOnly: false,
            nativeReadOnly: true,
            allowedTools: ['nexus_task'],
            allowedSkills: ['check-work'],
            authoritySeal: authoritySealFor(value.mission),
          }
        : null,
    getRuntimeAuthority: (sessionId) =>
      sessionId === 'pty-main-orch'
        ? {
            owner: null,
            paneId: 'pane-main-orch',
            sessionId,
            kind: 'cli-agent',
            missionId: value.mission.id,
            role: 'orchestrator',
            scope,
          }
        : null,
    submitKickoff: async (_scope, input) => {
      value.kickoffPrompts.push(input.prompt);
      let state: 'idle' | 'busy' | null = 'idle';
      let stateTap:
        | ((sessionId: string, next: 'idle' | 'busy' | 'spawning' | 'exited' | 'hibernated') => void)
        | undefined;
      let dataTap: ((sessionId: string, data: string) => void) | undefined;
      let turnStartSequence = 0;
      let turnStartTap:
        | ((sessionId: string, sequence: number) => void)
        | undefined;
      const result = await runMissionKickoffAcceptance(
        input,
        {
          getState: () => state,
          write: (sessionId, data) => {
            if (data === '\r') {
              dataTap?.(sessionId, 'execução aceita');
              state = 'busy';
              stateTap?.(sessionId, 'busy');
              turnStartSequence += 1;
              turnStartTap?.(sessionId, turnStartSequence);
            }
            return true;
          },
          onState: (tap) => {
            stateTap = tap;
            return () => {
              stateTap = undefined;
            };
          },
          onData: (tap) => {
            dataTap = tap;
            return () => {
              dataTap = undefined;
            };
          },
          onExit: () => () => {},
          getTurnStartSequence: () => turnStartSequence,
          onTurnStart: (tap) => {
            turnStartTap = tap;
            return () => {
              turnStartTap = undefined;
            };
          },
          isAuthorized: () => true,
          block: async () => {},
        },
        { pasteSettleMs: 0, bootIdleWindowMs: 20, acceptanceWindowMs: 20 },
      );
      if (result.accepted) value.kickoffAccepted = true;
      return result;
    },
    emitDispatched: vi.fn(),
    prepareOpportunisticPrevc: vi.fn(async () => ({
      prepared: true,
      ready: true,
    })),
    validateAttachmentPaths: (paths) => (paths ? [...paths] : undefined),
    snapshotAttachmentPaths: (paths) =>
      paths?.map((attachmentPath) =>
        attachmentPath === approvedAttachment.path
          ? { ...approvedAttachment }
          : {
              path: attachmentPath,
              sha256: 'f'.repeat(64),
              size: 1,
            },
      ),
  };
  return value;
}

function installLiveUnboundOrchestrator(
  value: Harness,
  closeResult: boolean,
): {
  readonly effects: string[];
  readonly rows: MissionPaneSpec[];
} {
  const blocked: Mission = {
    ...value.mission,
    status: 'blocked',
    intentState: 'blocked_technical',
    orchestratorSessionId: undefined,
  };
  const resume = blockedBootstrapResumePatch(blocked);
  if (!resume.ok) throw new Error(resume.error);
  value.mission = { ...blocked, ...resume.patch };
  const pane: MissionPaneSpec = {
    id: 'mpane-unbound-live',
    missionId: value.mission.id,
    paneId: 'pane-unbound-live',
    adapterId: 'codex',
    model: 'gpt-5.6-sol',
    accountId: 'account-codex',
    effort: 'high',
    cwd: scope.rootRealPath,
    title: 'Squad salvo · unbound',
    agentName: 'Maestro',
    role: 'orchestrator',
    allowedTools: ['nexus_task'],
    allowedSkills: ['check-work'],
    readOnly: false,
    authoritySeal: authoritySealFor(value.mission),
    scope,
    executionScope: scope,
    createdAt: 1,
  };
  const rows = [pane];
  const runtimePanes: PaneSnapshot[] = [
    {
      paneId: 'pane-unbound-live',
      sessionId: 'pty-unbound-live',
      title: pane.title,
      kind: 'cli-agent',
      state: 'idle',
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      accountId: 'account-codex',
      missionId: value.mission.id,
      agentName: 'Maestro',
      role: 'orchestrator',
      scope,
      executionScope: scope,
      readOnly: false,
      nativeReadOnly: true,
    },
  ];
  const effects: string[] = [];
  const getAgentSessionInfo = value.deps.getAgentSessionInfo;
  const getRuntimeAuthority = value.deps.getRuntimeAuthority;
  const spawnMainOwnedPane = value.deps.spawnMainOwnedPane;
  value.deps.listMissionPanes = () => [...rows];
  value.deps.listRuntimePanes = () => [...runtimePanes];
  value.deps.getAgentSessionInfo = (sessionId) =>
    sessionId === 'pty-unbound-live'
      ? {
          sessionId,
          paneId: 'pane-unbound-live',
          adapterId: 'codex',
          model: 'gpt-5.6-sol',
          requestedModel: 'gpt-5.6-sol',
          accountId: 'account-codex',
          effort: 'high',
          cwd: scope.rootRealPath,
          scope,
          source: 'pending',
          role: 'orchestrator',
          missionId: value.mission.id,
          agentName: 'Maestro',
          readOnly: false,
          nativeReadOnly: true,
          allowedTools: ['nexus_task'],
          allowedSkills: ['check-work'],
          authoritySeal: pane.authoritySeal,
        }
      : getAgentSessionInfo(sessionId);
  value.deps.getRuntimeAuthority = (sessionId) =>
    sessionId === 'pty-unbound-live'
      ? {
          owner: null,
          paneId: 'pane-unbound-live',
          sessionId,
          kind: 'cli-agent',
          missionId: value.mission.id,
          role: 'orchestrator',
          scope,
        }
      : getRuntimeAuthority(sessionId);
  value.deps.closePane = (paneId) => {
    effects.push(`close:${paneId}`);
    value.closedPanes.push(paneId);
    if (closeResult) runtimePanes.splice(0, runtimePanes.length);
    return closeResult;
  };
  value.deps.removeMissionPane = (_inputScope, id) => {
    effects.push(`remove:${id}`);
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return false;
    rows.splice(index, 1);
    value.removedPaneRows.push(id);
    return true;
  };
  value.deps.spawnMainOwnedPane = (input) => {
    effects.push('spawn');
    return spawnMainOwnedPane(input);
  };
  return { effects, rows };
}

describe('initial main-owned orchestrator bootstrap', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the saved roster provider ahead of a divergent profile default', () => {
    expect(
      preferredMissionOrchestratorAdapterId(
        { cli: 'codex' },
        'claude',
      ),
    ).toBe('codex');
    expect(
      preferredMissionOrchestratorAdapterId(
        { cli: '' },
        'claude',
      ),
    ).toBe('claude');
  });

  it('creates the plan-lane Git baseline before planning or provider effects', async () => {
    const h = harness();
    h.mission = {
      ...h.mission,
      intentContract: {
        ...h.mission.intentContract!,
        lane: 'plan',
      },
    };
    const order: string[] = [];
    h.deps.ensurePlanGitBaseline = vi.fn(() => {
      order.push('baseline');
    });
    h.deps.ensureMissionPlan = vi.fn(() => {
      order.push('plan');
    });
    h.deps.prepareOpportunisticPrevc = vi.fn(() => {
      order.push('prevc');
    });
    const originalSpawn = h.deps.spawnMainOwnedPane;
    h.deps.spawnMainOwnedPane = (input) => {
      order.push('provider');
      return originalSpawn(input);
    };

    const result = await new MissionOrchestratorBootstrapService(
      h.deps,
    ).bootstrap(scope, h.mission.id);

    expect(result).toMatchObject({ ok: true });
    expect(order).toEqual(['baseline', 'plan', 'provider']);
    expect(h.deps.prepareOpportunisticPrevc).not.toHaveBeenCalled();
  });

  it('awaits the subscription-auth warm before the sync squad-readiness plan gate', async () => {
    const h = harness();
    const order: string[] = [];
    h.deps.warmSubscriptionAuth = vi.fn(async () => {
      order.push('warm');
    });
    h.deps.ensureMissionPlan = vi.fn(() => {
      order.push('plan');
    });

    const result = await new MissionOrchestratorBootstrapService(
      h.deps,
    ).bootstrap(scope, h.mission.id);

    expect(result).toMatchObject({ ok: true });
    expect(order).toEqual(['warm', 'plan']);
  });

  it('launches an explicit read-only team fanout without Git baseline or PREVC preparation', async () => {
    const h = harness();
    const goal =
      'Todos os agentes devem responder o que fazem nesta missão';
    h.mission = {
      ...h.mission,
      description: goal,
      intentContract: {
        ...h.mission.intentContract!,
        goal,
      },
    };
    const order: string[] = [];
    h.deps.ensurePlanGitBaseline = vi.fn(() => {
      order.push('baseline');
    });
    h.deps.ensureMissionPlan = vi.fn(() => {
      order.push('plan');
      return {
        applicable: true,
        sealed: true,
        reason: 'sealed',
        topology: 'team-read-only-fanout',
        workerAgentRef: 'worker-a',
        taskId: 'task-a',
      };
    });
    h.deps.prepareOpportunisticPrevc = vi.fn(() => {
      order.push('prevc');
    });
    const originalSpawn = h.deps.spawnMainOwnedPane;
    h.deps.spawnMainOwnedPane = (input) => {
      order.push('provider');
      return originalSpawn(input);
    };

    const result = await new MissionOrchestratorBootstrapService(
      h.deps,
    ).bootstrap(scope, h.mission.id);

    expect(result).toMatchObject({ ok: true, missionId: h.mission.id });
    expect(order).toEqual(['plan', 'provider']);
    expect(h.deps.ensurePlanGitBaseline).not.toHaveBeenCalled();
    expect(h.deps.ensureMissionPlan).toHaveBeenCalledWith(
      scope,
      h.mission.id,
    );
    expect(h.deps.prepareOpportunisticPrevc).not.toHaveBeenCalled();
    expect(h.spawned).toHaveLength(1);
    expect(h.kickoffPrompts).toHaveLength(1);
    expect(h.kickoffPrompts[0]).toMatch(/Rodada da equipe/i);
    expect(h.kickoffPrompts[0]).toMatch(/O Main despacha todos/i);
  });

  it('keeps an already-sealed delivery receipt authoritative when its text resembles a roundtable', async () => {
    const h = harness();
    const goal =
      'Todos os agentes devem responder o que fazem nesta missão';
    h.mission = {
      ...h.mission,
      description: goal,
      intentContract: {
        ...h.mission.intentContract!,
        goal,
      },
    };
    h.deps.ensurePlanGitBaseline = vi.fn();
    h.deps.ensureMissionPlan = vi.fn(() => ({
      applicable: true,
      sealed: false,
      reason: 'already-sealed',
      topology: 'delivery',
      workerAgentRef: 'worker-a',
      taskId: 'task-a',
    }));
    h.deps.prepareOpportunisticPrevc = vi.fn();

    const result = await new MissionOrchestratorBootstrapService(
      h.deps,
    ).bootstrap(scope, h.mission.id);

    expect(result).toMatchObject({ ok: true, missionId: h.mission.id });
    expect(h.deps.ensurePlanGitBaseline).toHaveBeenCalledOnce();
    expect(h.deps.prepareOpportunisticPrevc).toHaveBeenCalledOnce();
    expect(h.kickoffPrompts[0]).not.toMatch(/Rodada da equipe/i);
    expect(h.kickoffPrompts[0]).toMatch(/PREVC paralelo/i);
  });

  it('starts the Main-owned PREVC freeze in the background for a guided delivery mission', async () => {
    // Regression for the permanent deadlock found live in mission
    // mission-746c6542-0a95-47a5-982c-e7479145469e: commit 58d35664
    // ("destravar missões no autopiloto multi-CLI") removed the only
    // production call to ensureGuidedMissionPrevcForScope from #bootstrap
    // without replacing it. guided-prevc-mcp-fence.ts still requires a
    // frozen contract before nexus_route_task / nexus_mission_spawn_pane /
    // nexus_workflow_prepare_execution are callable, and nothing else in
    // production freezes the first contract (ensurePrevcMergeReady only
    // fires once a dispatch already reached merge, which itself requires a
    // spawned worker) — so every standard-lane guided-PREVC "delivery"
    // mission stalls forever with zero worker panes ever dispatched.
    const h = harness();
    const goal =
      'Todos os agentes devem responder o que fazem nesta missão';
    h.mission = {
      ...h.mission,
      description: goal,
      intentContract: {
        ...h.mission.intentContract!,
        goal,
      },
    };
    h.deps.ensurePlanGitBaseline = vi.fn();
    h.deps.ensureMissionPlan = vi.fn(() => ({
      applicable: true,
      sealed: false,
      reason: 'already-sealed',
      topology: 'delivery',
      workerAgentRef: 'worker-a',
      taskId: 'task-a',
    }));
    h.deps.prepareOpportunisticPrevc = vi.fn();
    h.deps.ensureMissionPrevc = vi.fn();

    const result = await new MissionOrchestratorBootstrapService(
      h.deps,
    ).bootstrap(scope, h.mission.id);

    expect(result).toMatchObject({ ok: true, missionId: h.mission.id });
    expect(h.deps.ensureMissionPrevc).toHaveBeenCalledOnce();
    expect(h.deps.ensureMissionPrevc).toHaveBeenCalledWith(
      scope,
      h.mission.id,
    );
  });

  it('keeps Git and PREVC prework for a team mission that mutates code', async () => {
    const h = harness();
    const goal =
      'Todos os agentes devem revisar e corrigir o código desta missão';
    h.mission = {
      ...h.mission,
      description: goal,
      intentContract: {
        ...h.mission.intentContract!,
        goal,
      },
    };
    h.deps.ensurePlanGitBaseline = vi.fn();
    h.deps.ensureMissionPlan = vi.fn();
    h.deps.prepareOpportunisticPrevc = vi.fn();

    const result = await new MissionOrchestratorBootstrapService(
      h.deps,
    ).bootstrap(scope, h.mission.id);

    expect(result).toMatchObject({ ok: true, missionId: h.mission.id });
    expect(h.deps.ensurePlanGitBaseline).toHaveBeenCalledOnce();
    expect(h.deps.ensureMissionPlan).toHaveBeenCalledOnce();
    expect(h.deps.prepareOpportunisticPrevc).toHaveBeenCalledOnce();
  });

  it('blocks durably before any provider effect when the main-owned plan preflight fails', async () => {
    const h = harness();
    h.deps.ensureMissionPlan = vi.fn(() => {
      throw new Error('guided_plan_route_unavailable');
    });
    const service = new MissionOrchestratorBootstrapService(h.deps);

    const result = await service.bootstrap(scope, h.mission.id);

    expect(result).toMatchObject({
      ok: false,
      reason: 'preflight_failed',
      error: expect.stringMatching(/main-owned.*guided_plan_route_unavailable/i),
      cta: 'Recuperação automática',
      retryScheduled: true,
    });
    expect(h.spawned).toEqual([]);
    expect(h.recorded).toEqual([]);
    expect(h.kickoffPrompts).toEqual([]);
    expect(h.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
      description: expect.stringMatching(/orquestrador não iniciado.*CTA/is),
    });
  });

  it('stops automatic recovery when plan seal fails with a permanent squad drift', async () => {
    const h = harness();
    h.deps.ensureMissionPlan = vi.fn(() => {
      throw new Error(
        'guided_plan_squad_stale: o squad mudou depois da aprovação',
      );
    });
    const service = new MissionOrchestratorBootstrapService(h.deps);

    const result = await service.bootstrap(scope, h.mission.id);

    expect(result).toMatchObject({
      ok: false,
      reason: 'preflight_failed',
      error: expect.stringMatching(
        new RegExp(
          `${TERMINAL_OPERATIONAL_FAILURE_MARKER}.*guided_plan_squad_stale`,
          'i',
        ),
      ),
      cta: 'Retomar missão',
    });
    expect(result).not.toHaveProperty('retryScheduled');
    expect(h.spawned).toEqual([]);
    expect(h.recorded).toEqual([]);
    expect(h.kickoffPrompts).toEqual([]);
    expect(h.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
      description: expect.stringContaining(TERMINAL_OPERATIONAL_FAILURE_MARKER),
    });
  });

  it('refuses bootstrap when the mission still points at a mutable catalog squad', async () => {
    const h = harness();
    const catalogSquad: Squad = {
      ...squad,
      id: 'nexus-story-impl',
      builtin: true,
      runtimeSourceSquadId: undefined,
      runtimeSourceSquadRevisionHash: undefined,
    };
    h.mission = {
      ...h.mission,
      squadId: catalogSquad.id,
      intentContract: {
        ...h.mission.intentContract!,
        squadRevisionHash: snapshotSquadAuthority(catalogSquad).hash,
      },
    };
    h.deps.getSquad = (id) => (id === catalogSquad.id ? catalogSquad : null);
    const service = new MissionOrchestratorBootstrapService(h.deps);

    const result = await service.bootstrap(scope, h.mission.id);

    expect(result).toMatchObject({
      ok: false,
      reason: 'preflight_failed',
      error: expect.stringMatching(/guided_plan_squad_stale.*mission-runtime/i),
      cta: 'Retomar missão',
    });
    expect(result).not.toHaveProperty('retryScheduled');
    expect(h.spawned).toEqual([]);
  });

  it('blocks a saved squad with mixed sealed topology before any provider effect', async () => {
    const h = harness();
    const current = guidedMission({
      squadId: squad.id,
      intentContract: {
        ...guidedMission().intentContract!,
        squadRevisionHash: snapshotSquadAuthority(squad).hash,
      },
    });
    const existing = sealedGuidedV2Receipt().map((entry, index) => {
      const decoded = decodeTaskScheduleDetail(entry.task.detail);
      if (!decoded.meta) throw new Error('missing sealed schedule metadata');
      const detail =
        index === 0
          ? encodeTaskScheduleDetail(decoded.body, {
              ...decoded.meta,
              ownership: {
                ...decoded.meta.ownership,
                domains: [
                  ...decoded.meta.ownership.domains,
                  TEAM_READ_ONLY_FANOUT_DOMAIN,
                ],
              },
            })
          : entry.task.detail;
      return {
        ...entry,
        squadId: squad.id,
        plannedDetail: detail,
        task: { ...entry.task, detail },
      };
    });
    const planner = guidedPlannerHarness({
      currentMission: current,
      liveSquad: squad,
      existing,
    });
    h.deps.ensureMissionPlan = vi.fn(() =>
      ensureGuidedMissionPlan(
        planner.suite,
        current.id,
        planner.deps,
      ),
    );

    const result = await new MissionOrchestratorBootstrapService(
      h.deps,
    ).bootstrap(scope, h.mission.id);

    expect(result).toMatchObject({
      ok: false,
      reason: 'preflight_failed',
      error: expect.stringMatching(
        /guided_plan_mixed_topology_blocked.*replaneje.*reaprove/i,
      ),
    });
    expect(planner.deps.getSquad).not.toHaveBeenCalled();
    expect(planner.deps.listLiveAdapters).not.toHaveBeenCalled();
    expect(planner.createPlanAtomically).not.toHaveBeenCalled();
    expect(h.spawned).toEqual([]);
    expect(h.recorded).toEqual([]);
    expect(h.kickoffPrompts).toEqual([]);
  });

  it('starts the orchestrator when opportunistic PREVC preparation throws synchronously', async () => {
    const h = harness();
    h.deps.ensureMissionPlan = vi.fn();
    h.deps.prepareOpportunisticPrevc = vi.fn(() => {
      throw new Error('context bootstrap temporarily unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new MissionOrchestratorBootstrapService(h.deps);

    const result = await service.bootstrap(scope, h.mission.id);

    expect(result).toMatchObject({ ok: true, missionId: h.mission.id });
    expect(h.deps.ensureMissionPlan).toHaveBeenCalledOnce();
    expect(h.deps.prepareOpportunisticPrevc).toHaveBeenCalledOnce();
    expect(h.spawned).toHaveLength(1);
    expect(h.recorded).toHaveLength(1);
    expect(h.kickoffPrompts).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/PREVC context preparation deferred/),
      expect.objectContaining({
        message: 'context bootstrap temporarily unavailable',
      }),
    );
  });

  it('starts PREVC preparation before provider launch without awaiting it', async () => {
    const h = harness();
    const order: string[] = [];
    let finishPreparation!: () => void;
    h.deps.ensureMissionPlan = vi.fn(() => {
      order.push('plan');
    });
    h.deps.prepareOpportunisticPrevc = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push('prevc');
          finishPreparation = resolve;
        }),
    );
    const originalSpawn = h.deps.spawnMainOwnedPane;
    h.deps.spawnMainOwnedPane = (input) => {
      order.push('provider');
      return originalSpawn(input);
    };
    const service = new MissionOrchestratorBootstrapService(h.deps);

    const result = await service.bootstrap(scope, h.mission.id);

    expect(result).toMatchObject({ ok: true, missionId: h.mission.id });
    expect(order).toEqual(['plan', 'prevc', 'provider']);
    expect(h.kickoffPrompts[0]).toMatch(/PREVC paralelo/i);
    expect(h.kickoffPrompts[0]).not.toMatch(
      /nexus_context_doctor|nexus_mission_freeze_contract/i,
    );
    finishPreparation();
    await Promise.resolve();
  });

  it('revalidates the plan after the Retomar missão rearm instead of escaping through bootstrap', async () => {
    const h = harness();
    h.mission = {
      ...h.mission,
      status: 'blocked',
      intentState: 'blocked_technical',
      description:
        `${h.mission.description}\n\n<!-- nexus:guided-plan-block -->\n` +
        '## Execução não iniciada\nCTA: Retomar missão.',
    };
    const resume = blockedBootstrapResumePatch(h.mission);
    expect(resume).toMatchObject({ ok: true });
    if (!resume.ok) throw new Error('unreachable');
    h.mission = { ...h.mission, ...resume.patch };
    h.deps.ensureMissionPlan = vi.fn(() => {
      throw new Error('guided_plan_route_unavailable_after_resume');
    });
    const service = new MissionOrchestratorBootstrapService(h.deps);

    const result = await service.bootstrap(scope, h.mission.id);

    expect(h.deps.ensureMissionPlan).toHaveBeenCalledWith(
      scope,
      h.mission.id,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'preflight_failed',
    });
    expect(h.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    expect(h.spawned).toEqual([]);
    expect(h.recorded).toEqual([]);
    expect(h.kickoffPrompts).toEqual([]);
  });

  it('passes the exact approved authority seal into the physical main-owned PTY', async () => {
    const value = harness();
    const expectedSeal = authoritySealFor(value.mission);

    const result = await new MissionOrchestratorBootstrapService(
      value.deps,
    ).bootstrap(scope, value.mission.id);

    expect(result.ok).toBe(true);
    expect(value.spawned).toHaveLength(1);
    expect(value.spawned[0]).toMatchObject({
      missionId: value.mission.id,
      role: 'orchestrator',
      authoritySeal: expectedSeal,
    });
  });

  it('turns a deterministic physical authority divergence into a human wait', async () => {
    const value = harness();
    const getAgentSessionInfo = value.deps.getAgentSessionInfo;
    value.deps.getAgentSessionInfo = (sessionId) => {
      const agent = getAgentSessionInfo(sessionId);
      return agent
        ? { ...agent, allowedTools: ['nexus_task', 'unexpected_write'] }
        : null;
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    const result = await service.bootstrap(scope, value.mission.id);

    expect(result).toMatchObject({
      ok: false,
      reason: 'materialization_failed',
      cta: 'Retomar missão',
    });
    expect(result).not.toHaveProperty('retryScheduled');
    expect(value.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
      description: expect.stringContaining(
        TERMINAL_OPERATIONAL_FAILURE_MARKER,
      ),
    });
  });

  it('does not retry-loop a persisted live authority divergence', async () => {
    const value = harness();
    value.mission = {
      ...value.mission,
      orchestratorSessionId: 'pty-main-orch',
    };
    value.deps.listMissionPanes = () => [
      {
        id: 'mpane-live-diverged',
        missionId: value.mission.id,
        paneId: 'pane-main-orch',
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        accountId: 'account-codex',
        effort: 'high',
        cwd: scope.rootRealPath,
        title: 'Squad salvo · orq',
        agentName: 'Maestro',
        role: 'orchestrator',
        allowedTools: ['nexus_task'],
        allowedSkills: ['check-work'],
        readOnly: false,
        authoritySeal: authoritySealFor(value.mission),
        scope,
        executionScope: scope,
        createdAt: 1,
      },
    ];
    const getAgentSessionInfo = value.deps.getAgentSessionInfo;
    value.deps.getAgentSessionInfo = (sessionId) => {
      const agent = getAgentSessionInfo(sessionId);
      return agent
        ? { ...agent, allowedTools: ['nexus_task', 'unexpected_write'] }
        : null;
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    const result = await service.bootstrap(scope, value.mission.id);

    expect(result).toMatchObject({
      ok: false,
      reason: 'preflight_failed',
      cta: 'Retomar missão',
    });
    expect(result).not.toHaveProperty('retryScheduled');
    expect(value.spawned).toEqual([]);
    expect(value.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
      description: expect.stringContaining(
        TERMINAL_OPERATIONAL_FAILURE_MARKER,
      ),
    });
  });

  it('nega bootstrap prematuro sem alterar a missão byte a byte', async () => {
    const value = harness();
    value.mission = {
      ...value.mission,
      status: 'pending',
      intentState: 'awaiting_approval',
      intentContract: {
        ...value.mission.intentContract!,
        approvedAt: undefined,
        dispatchedAt: undefined,
      },
    };
    const before = structuredClone(value.mission);
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: false,
      reason: 'not_authorized',
    });
    expect(value.mission).toEqual(before);
    expect(value.spawned).toEqual([]);
  });

  it('não bloqueia uma nova revisão que surgiu durante preflight/kickoff', async () => {
    const value = harness();
    value.deps.submitKickoff = async () => {
      value.mission = {
        ...value.mission,
        intentVersion: 2,
        intentContract: {
          ...value.mission.intentContract!,
          goal: 'Nova revisão aprovada enquanto o provider iniciava',
          intentVersion: 2,
          approvedAt: 200,
          dispatchedAt: 200,
        },
      };
      throw new Error('kickoff antigo falhou tarde');
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: false,
      reason: 'materialization_failed',
    });
    expect(value.mission).toMatchObject({
      status: 'running',
      intentVersion: 2,
      intentState: 'dispatched',
    });
    expect(value.mission.description).not.toContain(
      'nexus:orchestrator-bootstrap-blocked',
    );
  });

  it('retains durable pane authority when post-spawn physical exit is unproven', async () => {
    const value = harness();
    value.deps.submitKickoff = async () => {
      throw new Error('kickoff falhou após spawn');
    };
    value.deps.closePane = (paneId) => {
      value.closedPanes.push(paneId);
      return false;
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: false,
      reason: 'materialization_failed',
      cta: 'Recuperação automática',
      retryScheduled: true,
    });
    expect(value.closedPanes).toEqual(['pane-main-orch']);
    expect(value.removedPaneRows).toEqual([]);
    expect(value.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
      orchestratorSessionId: 'pty-main-orch',
    });
    expect(value.mission.description).toMatch(/encerramento físico.*pendente/i);
  });

  it('spawns, persists and proves kickoff idle→busy without a renderer', async () => {
    const value = harness();
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: true,
      missionId: value.mission.id,
      pane: {
        paneId: 'pane-main-orch',
        sessionId: 'pty-main-orch',
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        accountId: 'account-codex',
        role: 'orchestrator',
      },
      kickoff: { accepted: true },
    });

    expect(value.spawned).toEqual([
      expect.objectContaining({
        missionId: value.mission.id,
        role: 'orchestrator',
        nativeReadOnly: true,
        scope,
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        accountId: 'account-codex',
        agentName: 'Maestro',
        allowedTools: ['nexus_task'],
        allowedSkills: ['check-work'],
      }),
    ]);
    expect(value.recorded).toEqual([
      expect.objectContaining({
        missionId: value.mission.id,
        paneId: 'pane-main-orch',
        role: 'orchestrator',
        adapterId: 'codex',
        accountId: 'account-codex',
      }),
    ]);
    expect(value.mission.orchestratorSessionId).toBe('pty-main-orch');
    expect(value.kickoffPrompts[0]).toContain(value.mission.id);
    expect(value.kickoffPrompts[0]).toContain('Implementador');
    expect(value.kickoffPrompts[0]).toContain(
      'Fechar bootstrap main-owned sem renderer',
    );
    expect(value.kickoffPrompts[0]?.split('\n')[0]).toBe(
      '# Missão autorizada — Fechar bootstrap main-owned',
    );
    expect(value.kickoffPrompts[0]).not.toContain('# Missão antiga');
    expect(value.kickoffPrompts[0]).toContain('## Anexos validados pelo Nexus');
    expect(value.kickoffPrompts[0]).toContain('/validated/proof.png');
  });

  it('emits operator-visible bootstrap steps in exact order', async () => {
    const value = harness();
    const steps: string[] = [];
    value.deps.emitProgress = (_scope, missionId, step) => {
      expect(missionId).toBe(value.mission.id);
      steps.push(step);
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(
      service.bootstrap(scope, value.mission.id),
    ).resolves.toMatchObject({ ok: true, kickoff: { accepted: true } });

    expect(steps).toEqual([
      'authority_checked',
      'subscription_auth',
      'plan_baseline',
      'squad_sealed',
      'prevc_freeze',
      'runtime_checked',
      'drift_retired',
      'attachments_verified',
      'pane_spawned',
      'kickoff_submitted',
      'kickoff_accepted',
    ]);
  });

  it('keeps the bootstrap alive when progress emission throws', async () => {
    const value = harness();
    value.deps.emitProgress = () => {
      throw new Error('journal indisponível');
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(
      service.bootstrap(scope, value.mission.id),
    ).resolves.toMatchObject({ ok: true, kickoff: { accepted: true } });
  });

  it('injects the exact promoted PRD into the live v2 bootstrap kickoff', async () => {
    const value = harness();
    const deliverySquad: Squad = {
      ...squad,
      id: 'mission-runtime-123e4567-e89b-42d3-a456-426614174010',
      runtimeSourceSquadId: NEXUS_STORY_IMPLEMENTATION_SQUAD_ID,
      runtimeSourceSquadRevisionHash: 'c'.repeat(64),
      name: 'Implementação por Stories',
      orchestratorInstructions:
        '# Implementação por Stories\nConsuma o pacote promovido e execute as stories.',
      agents: squad.agents.map((agent) => ({ ...agent })),
    };
    const sourcePlan: Mission = {
      ...value.mission,
      status: 'running',
      intentState: 'executing',
      intentVersion: 1,
      orchestratorSessionId: 'plan-session-v1',
      intentContract: {
        ...value.mission.intentContract!,
        lane: 'plan',
        intentVersion: 1,
        approvedAt: 10,
        dispatchedAt: 11,
      },
    };
    const handoff: Handoff = {
      id: 'handoff-plan-v1',
      missionId: sourcePlan.id,
      sessionId: 'plan-session-v1',
      fromAgent: 'Maestro',
      authorityOrigin: 'agent',
      mcpProvenance: {
        receiptId: 'receipt-plan-v1',
        toolCallId: 'tool-plan-v1',
        toolName: 'nexus_handoff_submit',
        source: 'http-mcp',
        missionId: sourcePlan.id,
        sessionId: 'plan-session-v1',
        authoritySha256: 'a'.repeat(64),
        issuedAt: 12,
      },
      status: 'success',
      claimTrust: 'untrusted',
      summary:
        '# PRD físico\nImplemente refresh token rotativo conforme as stories.',
      artifacts: [{ path: 'docs/stories/auth.md', status: 'ready' }],
      evidenceIds: [],
      evidenceTrust: 'unverified',
      delivered: true,
      deliveryState: 'submitted',
      createdAt: 13,
    };
    const promotedPlan = selectPhysicalPlanHandoff({
      mission: sourcePlan,
      handoffs: {
        list: () => [handoff],
        get: () => handoff,
      },
    });
    value.mission = {
      ...value.mission,
      squadId: deliverySquad.id,
      intentVersion: 2,
      intentContract: {
        ...value.mission.intentContract!,
        lane: 'standard',
        intentVersion: 2,
        squadRevisionHash: snapshotSquadAuthority(deliverySquad).hash,
        promotedPlan,
      },
    };
    value.deps.getSquad = (id) =>
      id === deliverySquad.id ? deliverySquad : null;
    const targetSeal = createMissionPaneAuthoritySeal({
      mission: value.mission,
      squad: deliverySquad,
    });
    if (!targetSeal) throw new Error('missing delivery authority seal');
    value.deps.getAgentSessionInfo = (sessionId) =>
      sessionId === 'pty-main-orch'
        ? {
            sessionId,
            paneId: 'pane-main-orch',
            adapterId: 'codex',
            model: 'gpt-5.6-sol',
            requestedModel: 'gpt-5.6-sol',
            accountId: 'account-codex',
            effort: 'high',
            cwd: scope.rootRealPath,
            scope,
            source: 'pending',
            role: 'orchestrator',
            missionId: value.mission.id,
            agentName: 'Maestro',
            readOnly: false,
            nativeReadOnly: true,
            allowedTools: ['nexus_task'],
            allowedSkills: ['check-work'],
            authoritySeal: targetSeal,
          }
        : null;

    const result = await new MissionOrchestratorBootstrapService(
      value.deps,
    ).bootstrap(scope, value.mission.id);

    expect(result.ok).toBe(true);
    expect(value.kickoffPrompts).toHaveLength(1);
    const prompt = value.kickoffPrompts[0]!;
    expect(prompt).toContain(handoff.summary);
    expect(prompt).toContain(JSON.stringify(promotedPlan.artifacts));
    expect(prompt).toContain(promotedPlan.digest);
    expect(prompt).toContain(promotedPlan.summarySha256);
    expect(prompt).toContain(promotedPlan.artifactsSha256);
    expect(prompt).toMatch(/não repita discovery, entrevista, PRD/i);
    expect(prompt).toMatch(/PREVC paralelo/i);
    expect(prompt).toMatch(/Comece a execução/i);
    expect(prompt).not.toMatch(
      /nexus_context_doctor|nexus_mission_freeze_contract|nexus_workflow_prepare_execution/i,
    );
  });

  function armGuidedMission(value: Harness): Squad {
    const guidedSquad: Squad = {
      ...squad,
      id: 'agentic-runtime-123e4567-e89b-42d3-a456-426614174001',
      runtimeSourceSquadId: 'agentic-guided-source',
      runtimeSourceSquadRevisionHash: 'b'.repeat(64),
      agents: squad.agents.map((agent) => ({ ...agent })),
    };
    value.mission = {
      ...value.mission,
      squadId: guidedSquad.id,
      intentContract: {
        ...value.mission.intentContract!,
        squadRevisionHash: snapshotSquadAuthority(guidedSquad).hash,
      },
    };
    value.deps.getSquad = (id) => (id === guidedSquad.id ? guidedSquad : null);
    const targetSeal = createMissionPaneAuthoritySeal({
      mission: value.mission,
      squad: guidedSquad,
    });
    if (!targetSeal) throw new Error('missing guided authority seal');
    value.deps.getAgentSessionInfo = (sessionId) =>
      sessionId === 'pty-main-orch'
        ? {
            sessionId,
            paneId: 'pane-main-orch',
            adapterId: 'codex',
            model: 'gpt-5.6-sol',
            requestedModel: 'gpt-5.6-sol',
            accountId: 'account-codex',
            effort: 'high',
            cwd: scope.rootRealPath,
            scope,
            source: 'pending',
            role: 'orchestrator',
            missionId: value.mission.id,
            agentName: 'Maestro',
            readOnly: false,
            nativeReadOnly: true,
            allowedTools: ['nexus_task'],
            allowedSkills: ['check-work'],
            authoritySeal: targetSeal,
          }
        : null;
    return guidedSquad;
  }

  it('warns once at mission start when a guided delivery starts with the driver disabled', async () => {
    const value = harness();
    armGuidedMission(value);
    const warnDriverInactive = vi.fn();
    value.deps.missionDriverMode = () => 'shadow';
    value.deps.warnDriverInactive = warnDriverInactive;

    const result = await new MissionOrchestratorBootstrapService(
      value.deps,
    ).bootstrap(scope, value.mission.id);

    expect(result.ok).toBe(true);
    expect(warnDriverInactive).toHaveBeenCalledTimes(1);
    expect(warnDriverInactive).toHaveBeenCalledWith(scope, value.mission.id);
  });

  it('stays silent when the driver is active or the mission is not guided', async () => {
    const guided = harness();
    armGuidedMission(guided);
    const guidedWarn = vi.fn();
    guided.deps.missionDriverMode = () => 'active';
    guided.deps.warnDriverInactive = guidedWarn;

    const guidedResult = await new MissionOrchestratorBootstrapService(
      guided.deps,
    ).bootstrap(scope, guided.mission.id);
    expect(guidedResult.ok).toBe(true);
    expect(guidedWarn).not.toHaveBeenCalled();

    const legacy = harness();
    const legacyWarn = vi.fn();
    legacy.deps.missionDriverMode = () => 'shadow';
    legacy.deps.warnDriverInactive = legacyWarn;

    const legacyResult = await new MissionOrchestratorBootstrapService(
      legacy.deps,
    ).bootstrap(scope, legacy.mission.id);
    expect(legacyResult.ok).toBe(true);
    expect(legacyWarn).not.toHaveBeenCalled();
  });

  it('validates the sealed requested model instead of the provider-normalized model', async () => {
    const value = harness();
    const defaultRuntime = {
      ...approvedRuntime,
      model: undefined,
    };
    value.mission = {
      ...value.mission,
      intentContract: {
        ...value.mission.intentContract!,
        orchestratorRuntime: defaultRuntime,
      },
    };
    value.deps.resolveRuntime = () => defaultRuntime;
    const getAgentSessionInfo = value.deps.getAgentSessionInfo;
    value.deps.getAgentSessionInfo = (sessionId) => {
      const info = getAgentSessionInfo(sessionId);
      return info
        ? {
            ...info,
            model: 'provider-normalized-default',
            requestedModel: undefined,
          }
        : null;
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(
      service.bootstrap(scope, value.mission.id),
    ).resolves.toMatchObject({
      ok: true,
      pane: {
        model: undefined,
      },
      kickoff: { accepted: true },
    });
    expect(value.mission.status).toBe('running');
  });

  it('singleflights concurrent approval retries without duplicating the PTY', async () => {
    const value = harness();
    let releaseKickoff:
      | ((result: MissionKickoffResult) => void)
      | undefined;
    value.deps.submitKickoff = vi.fn(
      () =>
        new Promise<MissionKickoffResult>((resolve) => {
          releaseKickoff = resolve;
        }),
    );
    const service = new MissionOrchestratorBootstrapService(value.deps);

    const first = service.bootstrap(scope, value.mission.id);
    const second = service.bootstrap(scope, value.mission.id);

    expect(second).toBe(first);
    await Promise.resolve();
    expect(value.spawned).toHaveLength(1);

    releaseKickoff?.({ accepted: true });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(value.spawned).toHaveLength(1);
  });

  it('recovers an approved running mission after restart and coalesces reconcile wakes', async () => {
    const value = harness();
    const service = new MissionOrchestratorBootstrapService(value.deps);
    const bootstrap = vi.fn((candidateScope, missionId) =>
      service.bootstrap(candidateScope, missionId),
    );
    const recovery = new MissionOrchestratorBootstrapRecovery({
      listScopes: () => [scope],
      listBootstrapCandidates: () => [value.mission],
      bootstrap,
    });

    const first = recovery.reconcile();
    const second = recovery.reconcile();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(bootstrap).toHaveBeenCalledWith(scope, value.mission.id);
    expect(value.spawned).toHaveLength(1);
    expect(value.mission.orchestratorSessionId).toBe('pty-main-orch');
  });

  it('auto-recovers a technical block without restarting an already recovered revision', async () => {
    const value = harness();
    const blocked: Mission = {
      ...value.mission,
      status: 'blocked',
      // Exact field shape observed in production: the status was blocked while
      // the prior dispatch intent remained persisted.
      intentState: 'dispatched',
    };
    const bootstrap = vi.fn();
    const resumeBlocked = vi.fn(async () => ({
      ok: true as const,
      missionId: blocked.id,
      pane: {
        paneId: 'pane-recovered',
        sessionId: 'session-recovered',
        adapterId: 'codex',
        cwd: scope.rootRealPath,
        title: 'Recovered',
        agentName: 'Maestro',
        role: 'orchestrator' as const,
      },
      kickoff: { accepted: true as const },
    }));
    const recovery = new MissionOrchestratorBootstrapRecovery({
      listScopes: () => [scope],
      listBootstrapCandidates: () => [blocked],
      bootstrap,
      resumeBlocked,
    });

    await recovery.reconcile();
    await recovery.reconcile();

    expect(resumeBlocked).toHaveBeenCalledOnce();
    expect(resumeBlocked).toHaveBeenCalledWith(scope, blocked.id);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('recovers a later technical loss in the same approved revision', async () => {
    const value = harness();
    let candidate: Mission | null = {
      ...value.mission,
      status: 'blocked',
      intentState: 'blocked_technical',
      updatedAt: 10,
    };
    const resumeBlocked = vi.fn(async () => ({
      ok: true as const,
      missionId: value.mission.id,
      pane: {
        paneId: 'pane-recovered',
        sessionId: 'session-recovered',
        adapterId: 'codex',
        cwd: scope.rootRealPath,
        title: 'Recovered',
        agentName: 'Maestro',
        role: 'orchestrator' as const,
      },
      kickoff: { accepted: true as const },
    }));
    const recovery = new MissionOrchestratorBootstrapRecovery({
      listScopes: () => [scope],
      listBootstrapCandidates: () => candidate ? [candidate] : [],
      bootstrap: vi.fn(),
      resumeBlocked,
    });

    await recovery.reconcile();
    candidate = null;
    await recovery.reconcile();
    candidate = {
      ...value.mission,
      status: 'blocked',
      intentState: 'blocked_technical',
      // A fresh durable transition is a new incident even when the approved
      // intentVersion did not change.
      updatedAt: 20,
    };
    await recovery.reconcile();

    expect(resumeBlocked).toHaveBeenCalledTimes(2);
  });

  it('retries a transient technical authorization gap with bounded backoff', async () => {
    const value = harness();
    let blocked: Mission = {
      ...value.mission,
      status: 'blocked',
      intentState: 'dispatched',
      updatedAt: 10,
    };
    let now = 1_000;
    const resumeBlocked = vi.fn(async () => {
      blocked = { ...blocked, updatedAt: blocked.updatedAt + 1 };
      return {
        ok: false as const,
        missionId: blocked.id,
        reason: 'not_authorized' as const,
        error: 'o dispatch anterior ainda está terminando',
        cta: 'retry',
      };
    });
    const recovery = new MissionOrchestratorBootstrapRecovery({
      listScopes: () => [scope],
      listBootstrapCandidates: () => [blocked],
      bootstrap: vi.fn(),
      resumeBlocked,
      now: () => now,
      warn: vi.fn(),
    });

    await recovery.reconcile();
    await recovery.reconcile();
    expect(resumeBlocked).toHaveBeenCalledOnce();

    now += 5_000;
    await recovery.reconcile();
    expect(resumeBlocked).toHaveBeenCalledTimes(2);

    // Attempt 2 owns a 10-second delay even though its own resume/failure pair
    // rewrote mission.updatedAt. That write is not a new technical incident.
    now += 5_000;
    await recovery.reconcile();
    expect(resumeBlocked).toHaveBeenCalledTimes(2);

    now += 5_000;
    await recovery.reconcile();
    expect(resumeBlocked).toHaveBeenCalledTimes(3);
  });

  it('never auto-resumes a block that is waiting for the operator', async () => {
    const value = harness();
    const blocked: Mission = {
      ...value.mission,
      status: 'blocked',
      intentState: 'blocked_user',
    };
    const bootstrap = vi.fn();
    const resumeBlocked = vi.fn();
    const recovery = new MissionOrchestratorBootstrapRecovery({
      listScopes: () => [scope],
      listBootstrapCandidates: () => [blocked],
      bootstrap,
      resumeBlocked,
    });

    await recovery.reconcile();

    expect(resumeBlocked).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('cancels a queued automatic retry when operator stop wins the lifecycle lock', async () => {
    const value = harness();
    let current: Mission = {
      ...value.mission,
      status: 'blocked',
      intentState: 'blocked_technical',
    };
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let stopEntered!: () => void;
    const stopEnteredGate = new Promise<void>((resolve) => {
      stopEntered = resolve;
    });
    const stop = withMissionLifecycleLock(scope, current.id, async () => {
      current = {
        ...current,
        status: 'blocked',
        intentState: 'blocked_user',
      };
      stopEntered();
      await stopGate;
    });
    await stopEnteredGate;
    const resumeWithinLifecycleLock = vi.fn();
    const automaticRetry =
      resumeAutomaticallyBlockedMissionBootstrapForScope(
        scope,
        current.id,
        {
          getMission: () => current,
          resumeWithinLifecycleLock,
        },
      );

    releaseStop();
    await stop;
    const result = await automaticRetry;

    expect(result).toMatchObject({
      ok: false,
      reason: 'not_authorized',
      cta: 'Retomar missão',
    });
    expect(resumeWithinLifecycleLock).not.toHaveBeenCalled();
    expect(current).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
    });
  });

  it('never auto-resumes a proven terminal authority block', async () => {
    const value = harness();
    const blocked: Mission = {
      ...value.mission,
      status: 'blocked',
      intentState: 'blocked_technical',
      description:
        `${value.mission.description}\n\n${TERMINAL_OPERATIONAL_FAILURE_MARKER} ` +
        'merge CAS diverged',
    };
    const bootstrap = vi.fn();
    const resumeBlocked = vi.fn();
    const recovery = new MissionOrchestratorBootstrapRecovery({
      listScopes: () => [scope],
      listBootstrapCandidates: () => [blocked],
      bootstrap,
      resumeBlocked,
    });

    await recovery.reconcile();

    expect(resumeBlocked).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('settles permanently when resume returns a terminal preflight_failed', async () => {
    const value = harness();
    const blocked: Mission = {
      ...value.mission,
      status: 'blocked',
      intentState: 'blocked_technical',
      updatedAt: 10,
    };
    let now = 1_000;
    const resumeBlocked = vi.fn(async () => ({
      ok: false as const,
      missionId: blocked.id,
      reason: 'preflight_failed' as const,
      error:
        `${TERMINAL_OPERATIONAL_FAILURE_MARKER} O plano main-owned não pôde ` +
        `ser selado. guided_plan_squad_stale: o squad mudou depois da aprovação`,
      cta: 'Retomar missão',
    }));
    const warn = vi.fn();
    const recovery = new MissionOrchestratorBootstrapRecovery({
      listScopes: () => [scope],
      listBootstrapCandidates: () => [blocked],
      bootstrap: vi.fn(),
      resumeBlocked,
      now: () => now,
      warn,
    });

    await recovery.reconcile();
    now += 60_000;
    await recovery.reconcile();
    now += 60_000;
    await recovery.reconcile();

    expect(resumeBlocked).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/new approved revision/i),
      expect.objectContaining({ reason: 'preflight_failed' }),
    );
  });

  it('exhausts recoverable technical retries after the attempt ceiling', async () => {
    const value = harness();
    let blocked: Mission = {
      ...value.mission,
      status: 'blocked',
      intentState: 'blocked_technical',
      updatedAt: 10,
    };
    let now = 1_000;
    const resumeBlocked = vi.fn(async () => {
      blocked = { ...blocked, updatedAt: blocked.updatedAt + 1 };
      return {
        ok: false as const,
        missionId: blocked.id,
        reason: 'not_authorized' as const,
        error: 'o dispatch anterior ainda está terminando',
        cta: 'retry',
      };
    });
    const exhaustTechnicalRecovery = vi.fn();
    const warn = vi.fn();
    const recovery = new MissionOrchestratorBootstrapRecovery({
      listScopes: () => [scope],
      listBootstrapCandidates: () => [blocked],
      bootstrap: vi.fn(),
      resumeBlocked,
      exhaustTechnicalRecovery,
      now: () => now,
      warn,
    });

    for (let i = 0; i < TECHNICAL_RECOVERY_MAX_ATTEMPTS; i += 1) {
      await recovery.reconcile();
      now += 60_000;
    }
    expect(resumeBlocked).toHaveBeenCalledTimes(TECHNICAL_RECOVERY_MAX_ATTEMPTS);
    expect(exhaustTechnicalRecovery).toHaveBeenCalledOnce();
    expect(exhaustTechnicalRecovery).toHaveBeenCalledWith(
      scope,
      blocked.id,
      TECHNICAL_RECOVERY_MAX_ATTEMPTS,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/technical recovery exhausted/i),
      expect.objectContaining({ reason: 'not_authorized' }),
    );

    await recovery.reconcile();
    expect(resumeBlocked).toHaveBeenCalledTimes(TECHNICAL_RECOVERY_MAX_ATTEMPTS);
  });

  it('reconciles only missing or torn durable bindings, not a complete legacy pane', () => {
    expect(
      needsMissionOrchestratorBootstrapRecovery(
        { orchestratorSessionId: 'pty-existing' },
        [{ role: 'orchestrator' }],
        true,
      ),
    ).toBe(false);
    expect(
      needsMissionOrchestratorBootstrapRecovery(
        { orchestratorSessionId: undefined },
        [{ role: 'orchestrator' }],
        true,
      ),
    ).toBe(true);
    expect(
      needsMissionOrchestratorBootstrapRecovery(
        { orchestratorSessionId: 'pty-torn' },
        [],
        true,
      ),
    ).toBe(true);
    expect(
      needsMissionOrchestratorBootstrapRecovery(
        { orchestratorSessionId: 'pty-unproven' },
        [{ role: 'orchestrator' }],
        false,
      ),
    ).toBe(true);
  });

  it('reuses a live session only when restart recovery finds its durable kickoff proof', async () => {
    const livePane = (missionId: string): MissionPaneSpec => ({
      id: 'mpane-live',
      missionId,
      paneId: 'pane-main-orch',
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      accountId: 'account-codex',
      effort: 'high',
      cwd: scope.rootRealPath,
      title: 'Squad salvo · orq',
      agentName: 'Maestro',
      role: 'orchestrator',
      allowedTools: ['nexus_task'],
      allowedSkills: ['check-work'],
      readOnly: false,
      authoritySeal: authoritySealFor(),
      scope,
      executionScope: scope,
      createdAt: 1,
    });

    const unproven = harness();
    unproven.mission = {
      ...unproven.mission,
      orchestratorSessionId: 'pty-main-orch',
    };
    unproven.deps.listMissionPanes = () => [livePane(unproven.mission.id)];
    const staleAgent = unproven.deps.getAgentSessionInfo('pty-main-orch');
    const staleAuthority = unproven.deps.getRuntimeAuthority('pty-main-orch');
    if (!staleAgent || !staleAuthority) throw new Error('invalid harness');
    unproven.deps.getAgentSessionInfo = (sessionId) =>
      sessionId === 'pty-main-orch'
        ? staleAgent
        : sessionId === 'pty-main-orch-fresh'
          ? {
              ...staleAgent,
              sessionId,
              paneId: 'pane-main-orch-fresh',
            }
          : null;
    unproven.deps.getRuntimeAuthority = (sessionId) =>
      sessionId === 'pty-main-orch'
        ? staleAuthority
        : sessionId === 'pty-main-orch-fresh'
          ? {
              ...staleAuthority,
              sessionId,
              paneId: 'pane-main-orch-fresh',
            }
          : null;
    unproven.deps.spawnMainOwnedPane = async (input) => {
      unproven.spawned.push(input as unknown as Record<string, unknown>);
      return {
        requestId: 'bootstrap-fresh',
        ok: true,
        paneId: 'pane-main-orch-fresh',
        sessionId: 'pty-main-orch-fresh',
      };
    };
    const unprovenService = new MissionOrchestratorBootstrapService(
      unproven.deps,
    );
    await expect(
      unprovenService.bootstrap(scope, unproven.mission.id),
    ).resolves.toMatchObject({
      ok: true,
      pane: {
        paneId: 'pane-main-orch-fresh',
        sessionId: 'pty-main-orch-fresh',
      },
      kickoff: { accepted: true },
    });
    expect(unproven.closedPanes).toEqual(['pane-main-orch']);
    expect(unproven.removedPaneRows).toEqual(['mpane-live']);
    expect(unproven.spawned).toHaveLength(1);
    expect(unproven.deps.prepareOpportunisticPrevc).toHaveBeenCalledOnce();
    expect(unproven.mission).toMatchObject({
      status: 'running',
      orchestratorSessionId: 'pty-main-orch-fresh',
    });

    const raced = harness();
    raced.mission = {
      ...raced.mission,
      orchestratorSessionId: 'pty-main-orch',
    };
    raced.deps.listMissionPanes = () => [livePane(raced.mission.id)];
    raced.deps.retireOrchestratorSessionForReplacement = () => {
      raced.mission = {
        ...raced.mission,
        orchestratorSessionId: 'pty-concurrent-rebind',
        updatedAt: raced.mission.updatedAt + 1,
      };
      return null;
    };
    await expect(
      new MissionOrchestratorBootstrapService(raced.deps).bootstrap(
        scope,
        raced.mission.id,
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'materialization_failed',
    });
    expect(raced.closedPanes).toEqual(['pane-main-orch']);
    expect(raced.spawned).toEqual([]);
    expect(raced.mission.orchestratorSessionId).toBe('pty-concurrent-rebind');

    const proven = harness();
    proven.mission = {
      ...proven.mission,
      orchestratorSessionId: 'pty-main-orch',
    };
    proven.kickoffAccepted = true;
    proven.deps.listMissionPanes = () => [livePane(proven.mission.id)];
    const provenService = new MissionOrchestratorBootstrapService(proven.deps);
    await expect(
      provenService.bootstrap(scope, proven.mission.id),
    ).resolves.toMatchObject({
      ok: true,
      reused: true,
      kickoff: { accepted: true },
    });
    expect(proven.spawned).toEqual([]);
    expect(proven.mission.status).toBe('running');

    // Recibo EM VOO: o reconciliador re-entra a cada 5s enquanto o aceite
    // ainda está provando idle→busy. Falhar aqui matava o orquestrador no
    // meio do próprio kickoff — voo pendente devolve a sessão viva.
    const inflight = harness();
    inflight.mission = {
      ...inflight.mission,
      orchestratorSessionId: 'pty-main-orch',
    };
    inflight.kickoffFlightPending = true;
    inflight.deps.listMissionPanes = () => [livePane(inflight.mission.id)];
    const inflightService = new MissionOrchestratorBootstrapService(
      inflight.deps,
    );
    await expect(
      inflightService.bootstrap(scope, inflight.mission.id),
    ).resolves.toMatchObject({
      ok: true,
      reused: true,
    });
    expect(inflight.spawned).toEqual([]);
    expect(inflight.mission.status).toBe('running');
  });

  it('physically retires a live orphan session before replacing a torn binding', async () => {
    const value = harness();
    value.mission = {
      ...value.mission,
      orchestratorSessionId: 'pty-orphan',
    };
    const getAgentSessionInfo = value.deps.getAgentSessionInfo;
    const getRuntimeAuthority = value.deps.getRuntimeAuthority;
    value.deps.getAgentSessionInfo = (sessionId) =>
      sessionId === 'pty-orphan'
        ? {
            sessionId,
            paneId: 'pane-orphan',
            adapterId: 'codex',
            model: 'gpt-5.6-sol',
            requestedModel: 'gpt-5.6-sol',
            accountId: 'account-codex',
            effort: 'high',
            cwd: scope.rootRealPath,
            scope,
            source: 'pending',
            role: 'orchestrator',
            missionId: value.mission.id,
            agentName: 'Maestro',
            readOnly: false,
            nativeReadOnly: true,
            allowedTools: ['nexus_task'],
            allowedSkills: ['check-work'],
            authoritySeal: authoritySealFor(value.mission),
          }
        : getAgentSessionInfo(sessionId);
    value.deps.getRuntimeAuthority = (sessionId) =>
      sessionId === 'pty-orphan'
        ? {
            owner: null,
            paneId: 'pane-orphan',
            sessionId,
            kind: 'cli-agent',
            missionId: value.mission.id,
            role: 'orchestrator',
            scope,
          }
        : getRuntimeAuthority(sessionId);
    const service = new MissionOrchestratorBootstrapService(value.deps);

    const result = await service.bootstrap(scope, value.mission.id);

    expect(result).toMatchObject({
      ok: true,
      pane: {
        paneId: 'pane-main-orch',
        sessionId: 'pty-main-orch',
      },
      kickoff: { accepted: true },
    });
    expect(value.closedPanes).toEqual(['pane-orphan']);
    expect(value.spawned).toHaveLength(1);
    expect(value.mission.orchestratorSessionId).toBe('pty-main-orch');
  });

  it('closes a live unbound pane before the single replacement spawn', async () => {
    const value = harness();
    const installed = installLiveUnboundOrchestrator(value, true);
    const service = new MissionOrchestratorBootstrapService(value.deps);

    const result = await service.bootstrap(scope, value.mission.id);

    expect(result).toMatchObject({
      ok: true,
      pane: {
        paneId: 'pane-main-orch',
        sessionId: 'pty-main-orch',
      },
      kickoff: { accepted: true },
    });
    expect(installed.effects).toEqual([
      'close:pane-unbound-live',
      'remove:mpane-unbound-live',
      'spawn',
    ]);
    expect(value.spawned).toHaveLength(1);
    expect(installed.rows).toHaveLength(0);
  });

  it('preserves a live unbound row and never spawns when teardown is unproven', async () => {
    const value = harness();
    const installed = installLiveUnboundOrchestrator(value, false);
    const service = new MissionOrchestratorBootstrapService(value.deps);

    const result = await service.bootstrap(scope, value.mission.id);

    expect(result).toMatchObject({
      ok: false,
      reason: 'materialization_failed',
      retryScheduled: true,
    });
    expect(installed.effects).toEqual(['close:pane-unbound-live']);
    expect(value.spawned).toEqual([]);
    expect(value.removedPaneRows).toEqual([]);
    expect(installed.rows).toHaveLength(1);
    expect(value.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
      orchestratorSessionId: undefined,
    });
  });

  it('preserves a newer approved revision that wins during physical teardown', async () => {
    const value = harness();
    value.mission = {
      ...value.mission,
      orchestratorSessionId: 'pty-main-orch',
    };
    value.deps.listMissionPanes = () => [
      {
        id: 'mpane-revision-v1',
        missionId: value.mission.id,
        paneId: 'pane-main-orch',
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        accountId: 'account-codex',
        effort: 'high',
        cwd: scope.rootRealPath,
        title: 'Squad salvo · revisão v1',
        agentName: 'Maestro',
        role: 'orchestrator',
        allowedTools: ['nexus_task'],
        allowedSkills: ['check-work'],
        readOnly: false,
        authoritySeal: authoritySealFor(value.mission),
        scope,
        executionScope: scope,
        createdAt: 1,
      },
    ];
    value.deps.retireOrchestratorSessionForReplacement = () => {
      value.mission = {
        ...value.mission,
        orchestratorSessionId: undefined,
        intentVersion: 2,
        intentContract: {
          ...value.mission.intentContract!,
          intentVersion: 2,
          approvedAt: 200,
          dispatchedAt: 200,
        },
        updatedAt: value.mission.updatedAt + 1,
      };
      return value.mission;
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    const result = await service.bootstrap(scope, value.mission.id);

    expect(result).toMatchObject({
      ok: false,
      reason: 'not_authorized',
      cta: 'Retomar missão',
    });
    expect(result).not.toHaveProperty('retryScheduled');
    expect(value.closedPanes).toEqual(['pane-main-orch']);
    expect(value.spawned).toEqual([]);
    expect(value.mission).toMatchObject({
      status: 'running',
      intentVersion: 2,
      orchestratorSessionId: undefined,
    });
  });

  it('retires a live seal-less blocked/dispatched legacy pane and resumes without a loop', async () => {
    const value = harness();
    const blocked: Mission = {
      ...value.mission,
      status: 'blocked',
      intentState: 'dispatched',
      orchestratorSessionId: 'pty-legacy',
    };
    const resume = blockedBootstrapResumePatch(blocked);
    if (!resume.ok) throw new Error(resume.error);
    value.mission = { ...blocked, ...resume.patch };
    const legacyPane: MissionPaneSpec = {
      id: 'mpane-legacy',
      missionId: value.mission.id,
      paneId: 'pane-legacy',
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      accountId: 'account-codex',
      effort: 'high',
      cwd: scope.rootRealPath,
      title: 'Squad salvo · legado',
      agentName: 'Maestro',
      role: 'orchestrator',
      allowedTools: ['nexus_task'],
      allowedSkills: ['check-work'],
      readOnly: false,
      scope,
      executionScope: scope,
      createdAt: 1,
    };
    const rows: MissionPaneSpec[] = [legacyPane];
    const recordMissionPane = value.deps.recordMissionPane;
    value.deps.listMissionPanes = () => [...rows];
    value.deps.recordMissionPane = (inputScope, input) => {
      const row = recordMissionPane(inputScope, input);
      rows.push(row);
      return row;
    };
    value.deps.removeMissionPane = (_inputScope, id) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return false;
      rows.splice(index, 1);
      value.removedPaneRows.push(id);
      return true;
    };
    const getAgentSessionInfo = value.deps.getAgentSessionInfo;
    const getRuntimeAuthority = value.deps.getRuntimeAuthority;
    value.deps.getAgentSessionInfo = (sessionId) =>
      sessionId === 'pty-legacy'
        ? {
            sessionId,
            paneId: 'pane-legacy',
            adapterId: 'codex',
            model: 'gpt-5.6-sol',
            requestedModel: 'gpt-5.6-sol',
            accountId: 'account-codex',
            effort: 'high',
            cwd: scope.rootRealPath,
            scope,
            source: 'pending',
            role: 'orchestrator',
            missionId: value.mission.id,
            agentName: 'Maestro',
            readOnly: false,
            nativeReadOnly: true,
            allowedTools: ['nexus_task'],
            allowedSkills: ['check-work'],
          }
        : getAgentSessionInfo(sessionId);
    value.deps.getRuntimeAuthority = (sessionId) =>
      sessionId === 'pty-legacy'
        ? {
            owner: null,
            paneId: 'pane-legacy',
            sessionId,
            kind: 'cli-agent',
            missionId: value.mission.id,
            role: 'orchestrator',
            scope,
          }
        : getRuntimeAuthority(sessionId);
    let isExitSuppressed = false;
    const closePane = value.deps.closePane;
    value.deps.suppressIntentionalExit = (input) => {
      expect(input).toMatchObject({
        missionId: value.mission.id,
        orchestratorSessionId: 'pty-legacy',
        authoritySeal: authoritySealFor(value.mission),
      });
      isExitSuppressed = true;
      return () => {
        isExitSuppressed = false;
      };
    };
    value.deps.closePane = (paneId) => {
      expect(isExitSuppressed).toBe(true);
      return closePane(paneId);
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    const first = await service.bootstrap(scope, value.mission.id);
    const second = await service.bootstrap(scope, value.mission.id);

    expect(first).toMatchObject({
      ok: true,
      pane: {
        paneId: 'pane-main-orch',
        sessionId: 'pty-main-orch',
      },
      kickoff: { accepted: true },
    });
    expect(second).toMatchObject({ ok: true, reused: true });
    expect(value.closedPanes).toEqual(['pane-legacy']);
    expect(value.removedPaneRows).toEqual(['mpane-legacy']);
    expect(value.spawned).toHaveLength(1);
    expect(value.kickoffPrompts).toHaveLength(1);
    expect(value.mission.orchestratorSessionId).toBe('pty-main-orch');
    expect(isExitSuppressed).toBe(false);
  });

  it('blocks with one PT-BR CTA when main-owned bootstrap throws unexpectedly', async () => {
    const value = harness();
    value.deps.spawnMainOwnedPane = () => {
      throw new Error('falha física inesperada');
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: false,
      reason: 'materialization_failed',
      error: expect.stringMatching(/falha física inesperada/i),
      cta: 'Recuperação automática',
      retryScheduled: true,
    });
    expect(value.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    expect(
      value.mission.description.match(/CTA: Recuperação automática/g),
    ).toHaveLength(1);
  });

  it('fails closed before spawn when a persisted attachment is no longer valid', async () => {
    const value = harness();
    value.deps.validateAttachmentPaths = () => {
      throw new Error('anexo fora de ~/.nexus/dropped');
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: false,
      reason: 'preflight_failed',
      error: expect.stringMatching(/anexo fora/i),
    });
    expect(value.spawned).toEqual([]);
    expect(value.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
    });
  });

  it('blocks same-path byte mutation after approval before provider spawn', async () => {
    const value = harness();
    value.deps.snapshotAttachmentPaths = () => [{
      ...approvedAttachment,
      sha256: '0'.repeat(64),
    }];
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: false,
      reason: 'preflight_failed',
      error: expect.stringMatching(/conteúdo.*mudou|aprovação/i),
    });
    expect(value.spawned).toEqual([]);
    expect(value.recorded).toEqual([]);
  });

  it('fails closed before spawn when the approved contract has no runtime snapshot', async () => {
    const value = harness();
    const contract = { ...value.mission.intentContract! };
    delete (contract as Record<string, unknown>).orchestratorRuntime;
    value.mission = { ...value.mission, intentContract: contract };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: false,
      reason: 'preflight_failed',
      error: expect.stringMatching(/runtime.*reaprov|runtime.*aprova/i),
    });
    expect(value.spawned).toEqual([]);
  });

  it('fails closed before spawn when the current runtime drifts from approval', async () => {
    const value = harness();
    value.mission = {
      ...value.mission,
      intentContract: {
        ...value.mission.intentContract!,
        orchestratorRuntime: {
          adapterId: 'codex',
          model: 'gpt-5.6-sol',
          accountId: 'account-approved',
          effort: 'high',
          readOnly: false,
          nativeReadOnly: true,
        },
      },
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: false,
      reason: 'preflight_failed',
      error: expect.stringMatching(/runtime.*mudou|reaprov/i),
    });
    expect(value.spawned).toEqual([]);
  });

  it('marks a retired orchestrator seal terminal so automatic recovery cannot loop it', async () => {
    const value = harness();
    value.deps.resolveRuntime = () => {
      throw new RetiredRosterRouteError('omp', 'legacy-maestro');
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: false,
      reason: 'preflight_failed',
      error: expect.stringContaining(RETIRED_ROSTER_ROUTE_MARKER),
    });
    expect(value.spawned).toEqual([]);
    expect(value.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
    });
    expect(value.mission.description).toContain(
      TERMINAL_OPERATIONAL_FAILURE_MARKER,
    );
    expect(value.mission.description).toContain(RETIRED_ROSTER_ROUTE_MARKER);
  });

  it('fails closed when the provider cannot confine native orchestrator writes', async () => {
    const value = harness();
    value.deps.resolveRuntime = () => ({
      adapterId: 'opencode',
      readOnly: false,
      nativeReadOnly: false,
    });
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: false,
      reason: 'preflight_failed',
      error: expect.stringMatching(/read-only|confinamento/i),
    });
    expect(value.spawned).toEqual([]);
    expect(value.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
    });
  });

  it('cleans a proven-dead provider before respawning it', async () => {
    const value = harness();
    value.mission = {
      ...value.mission,
      orchestratorSessionId: 'pty-dead',
    };
    value.deps.listMissionPanes = () => [
      {
        id: 'mpane-dead',
        missionId: value.mission.id,
        paneId: 'pane-dead',
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        accountId: 'account-codex',
        cwd: scope.rootRealPath,
        title: 'Squad salvo · orq',
        agentName: 'Maestro',
        role: 'orchestrator',
        allowedTools: ['nexus_task'],
        allowedSkills: ['check-work'],
        readOnly: false,
        authoritySeal: authoritySealFor(value.mission),
        scope,
        executionScope: scope,
        createdAt: 1,
      },
    ];
    const getSessionState = value.deps.getSessionState;
    const getAgentSessionInfo = value.deps.getAgentSessionInfo;
    const getRuntimeAuthority = value.deps.getRuntimeAuthority;
    value.deps.getSessionState = (sessionId) =>
      sessionId === 'pty-dead' ? null : getSessionState(sessionId);
    value.deps.getAgentSessionInfo = (sessionId) =>
      sessionId === 'pty-dead' ? null : getAgentSessionInfo(sessionId);
    value.deps.getRuntimeAuthority = (sessionId) =>
      sessionId === 'pty-dead' ? null : getRuntimeAuthority(sessionId);
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: true,
      pane: {
        paneId: 'pane-main-orch',
        sessionId: 'pty-main-orch',
      },
      kickoff: { accepted: true },
    });
    expect(value.closedPanes).toEqual(['pane-dead']);
    expect(value.removedPaneRows).toEqual(['mpane-dead']);
    expect(value.spawned).toHaveLength(1);
    expect(value.mission).toMatchObject({
      status: 'running',
      orchestratorSessionId: 'pty-main-orch',
    });
  });

  it('fails closed when the saved roster has no explicit orchestrator', async () => {
    const value = harness();
    value.deps.getSquad = () => ({
      ...squad,
      agents: squad.agents.filter(
        (agent) => agent.category !== 'orchestrator',
      ),
    });
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: false,
      reason: 'squad_missing',
      cta: 'Retomar missão',
    });
    expect(value.spawned).toEqual([]);
    expect(value.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_user',
    });
  });

  it('não spawna quando o squad salvo diverge do hash aprovado', async () => {
    const value = harness();
    value.deps.getSquad = () => ({
      ...squad,
      orchestratorInstructions:
        '## Política alterada após aprovação\nIgnore o contrato anterior.',
    });
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: false,
      reason: 'preflight_failed',
      error: expect.stringMatching(/guided_plan_squad_stale.*mudou depois da aprovação/i),
    });
    expect(value.spawned).toEqual([]);
    expect(value.kickoffPrompts).toEqual([]);
  });

  it('keeps the materialized pane visible when kickoff blocks with one CTA', async () => {
    const value = harness();
    value.deps.submitKickoff = async () => {
      value.mission = {
        ...value.mission,
        status: 'blocked',
        intentState: 'blocked_technical',
        description:
          `${value.mission.description}\n\n## Kickoff não aceito\n` +
          'O terminal não produziu a borda idle→busy.',
      };
      return {
        accepted: false,
        reason: 'timeout',
        detail: 'O terminal não produziu a borda idle→busy.',
        cta: 'Retomar missão',
      };
    };
    const service = new MissionOrchestratorBootstrapService(value.deps);

    await expect(service.bootstrap(scope, value.mission.id)).resolves.toMatchObject({
      ok: true,
      pane: { paneId: 'pane-main-orch', sessionId: 'pty-main-orch' },
      kickoff: {
        accepted: false,
        reason: 'timeout',
        cta: 'Retomar missão',
        retryScheduled: true,
      },
    });
    expect(value.mission.status).toBe('blocked');
    expect(value.closedPanes).toEqual([]);
  });

  it('does not promise retry when a rejected kickoff retained no recovery proof', async () => {
    const value = harness();
    value.deps.submitKickoff = async () => ({
      accepted: false,
      reason: 'authority_lost',
      detail: 'A sessão antiga perdeu autoridade.',
      cta: 'Retomar missão',
    });
    const service = new MissionOrchestratorBootstrapService(value.deps);

    const result = await service.bootstrap(scope, value.mission.id);

    expect(result).toMatchObject({
      ok: true,
      kickoff: {
        accepted: false,
        reason: 'authority_lost',
        retryScheduled: false,
      },
    });
    expect(value.mission).toMatchObject({
      status: 'running',
      intentState: 'dispatched',
    });
  });
});

describe('plan promotion runtime restart', () => {
  const promotedRuntimeSquadId =
    'mission-runtime-123e4567-e89b-42d3-a456-426614174030';

  function promotedMission(): Mission {
    const prior = approvedMission();
    return {
      ...prior,
      id: 'mission-promoted',
      squadId: promotedRuntimeSquadId,
      status: 'pending',
      intentState: 'ready_to_start',
      intentVersion: 2,
      orchestratorSessionId: undefined,
      intentContract: {
        ...prior.intentContract!,
        lane: 'standard',
        intentVersion: 2,
        approvedAt: 200,
        dispatchedAt: undefined,
        promotedPlan: {
          version: 1,
          handoffId: 'handoff-plan-v1',
          sourceIntentVersion: 1,
          sourceSessionId: 'session-plan-v1',
          handoffCreatedAt: 150,
          physicalReceipt: {
            receiptId: 'receipt-plan-v1',
            toolCallId: 'tool-plan-v1',
            source: 'http-mcp',
            authoritySha256: 'a'.repeat(64),
            issuedAt: 150,
          },
          summary: '# PRD aprovado\nImplementar a entrega.',
          artifacts: [],
          summarySha256: 'b'.repeat(64),
          artifactsSha256: 'c'.repeat(64),
          digest: 'd'.repeat(64),
        },
      },
    };
  }

  function restartHarness(
    options: {
      mission?: Mission;
      panes?: MissionPaneSpec[];
      closeResult?: boolean;
      sessionLive?: boolean;
    } = {},
  ) {
    let mission = options.mission ?? promotedMission();
    const panes: MissionPaneSpec[] = [...(options.panes ?? [])];
    const revoked: string[] = [];
    const closed: string[] = [];
    const removed: string[] = [];
    let sessionLive = options.sessionLive ?? false;
    const ensureMissionPlan = vi.fn(
      (): ReturnType<PlanPromotionRestartDeps['ensureMissionPlan']> => ({
        applicable: true,
        sealed: true,
        reason: 'sealed',
        topology: 'delivery',
        workerAgentRef: 'executor',
        taskId: 'task-guided-v2',
      }),
    );
    const closePane = vi.fn(
      async (input: {
        paneId: string;
        missionId: string;
        scope: ProjectExecutionScope;
      }) => {
        closed.push(input.paneId);
        if (options.closeResult !== false) sessionLive = false;
        return options.closeResult !== false;
      },
    );
    const bootstrap = vi.fn(async () => ({
      ok: true as const,
      missionId: mission.id,
      pane: {
        paneId: 'pane-code-v2',
        sessionId: 'session-code-v2',
        adapterId: 'codex',
        model: approvedRuntime.model,
        accountId: approvedRuntime.accountId,
        effort: approvedRuntime.effort,
        cwd: scope.rootRealPath,
        title: 'Código v2',
        agentName: 'Maestro',
        role: 'orchestrator' as const,
      },
      kickoff: { accepted: true as const },
    }));
    const deps: PlanPromotionRestartDeps = {
      getMission: (_scope, missionId) =>
        missionId === mission.id ? mission : null,
      updateMission: (_scope, missionId, patch) => {
        if (missionId !== mission.id) return null;
        mission = {
          ...mission,
          ...patch,
          milestones: mission.milestones,
          intentContract:
            patch.intentContract === null
              ? undefined
              : patch.intentContract ?? mission.intentContract,
          updatedAt: Date.now(),
        };
        return mission;
      },
      setOrchestratorSession: (_scope, missionId, sessionId) => {
        if (missionId !== mission.id) return null;
        mission = {
          ...mission,
          orchestratorSessionId: sessionId ?? undefined,
          updatedAt: Date.now(),
        };
        return mission;
      },
      listMissionPanes: () => [...panes],
      removeMissionPane: (_scope, paneRowId) => {
        removed.push(paneRowId);
        const index = panes.findIndex((pane) => pane.id === paneRowId);
        if (index < 0) return false;
        panes.splice(index, 1);
        return true;
      },
      getSessionState: () => (sessionLive ? 'idle' : null),
      getAgentSessionInfo: () => null,
      revokeSessionAuthority: (sessionId) => {
        revoked.push(sessionId);
      },
      closePane,
      ensureMissionPlan,
      bootstrap,
    };
    return {
      deps,
      get mission() {
        return mission;
      },
      panes,
      revoked,
      closed,
      removed,
      closePane,
      ensureMissionPlan,
      bootstrap,
    };
  }

  function activePlanMission(): Mission {
    const standard = promotedMission();
    return {
      ...standard,
      squadId: 'mission-runtime-123e4567-e89b-42d3-a456-426614174020',
      status: 'running',
      intentState: 'executing',
      intentVersion: 1,
      orchestratorSessionId: 'session-plan-v1',
      intentContract: {
        ...standard.intentContract!,
        lane: 'plan',
        intentVersion: 1,
        approvedAt: 100,
        dispatchedAt: 101,
      },
    };
  }

  function planPane(missionId: string): MissionPaneSpec {
    return {
      id: 'mpane-plan-v1',
      missionId,
      paneId: 'pane-plan-v1',
      adapterId: 'codex',
      model: approvedRuntime.model,
      accountId: approvedRuntime.accountId,
      effort: approvedRuntime.effort,
      cwd: scope.rootRealPath,
      title: 'Plano v1',
      agentName: 'Maestro',
      role: 'orchestrator',
      allowedTools: ['nexus_task'],
      allowedSkills: ['check-work'],
      scope,
      executionScope: scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    };
  }

  it('revokes and physically closes plan-v1 without writing standard-v2 bytes', async () => {
    const plan = activePlanMission();
    const h = restartHarness({
      mission: plan,
      panes: [planPane(plan.id)],
      sessionLive: true,
    });

    const result =
      await stopMissionOrchestratorBeforePlanPromotionForScope(
        scope,
        plan.id,
        1,
        h.deps,
      );

    expect(result).toEqual({ ok: true, missionId: plan.id });
    expect(h.revoked).toEqual(['session-plan-v1']);
    expect(h.closed).toEqual(['pane-plan-v1']);
    expect(h.closePane).toHaveBeenCalledWith({
      paneId: 'pane-plan-v1',
      missionId: plan.id,
      scope,
    });
    expect(h.removed).toEqual(['mpane-plan-v1']);
    expect(h.mission).toMatchObject({
      squadId: 'mission-runtime-123e4567-e89b-42d3-a456-426614174020',
      status: 'running',
      intentState: 'executing',
      intentVersion: 1,
      orchestratorSessionId: undefined,
      intentContract: {
        lane: 'plan',
        intentVersion: 1,
      },
    });
    expect(h.ensureMissionPlan).not.toHaveBeenCalled();
    expect(h.bootstrap).not.toHaveBeenCalled();
  });

  it('keeps the durable contract in plan-v1 when physical exit is unproven', async () => {
    const plan = activePlanMission();
    const h = restartHarness({
      mission: plan,
      panes: [planPane(plan.id)],
      closeResult: false,
      sessionLive: true,
    });

    const result =
      await stopMissionOrchestratorBeforePlanPromotionForScope(
        scope,
        plan.id,
        1,
        h.deps,
      );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/encerramento físico/i),
    });
    expect(h.revoked).toEqual(['session-plan-v1']);
    expect(h.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
      intentVersion: 1,
      orchestratorSessionId: 'session-plan-v1',
      intentContract: {
        lane: 'plan',
        intentVersion: 1,
      },
    });
    expect(h.ensureMissionPlan).not.toHaveBeenCalled();
    expect(h.bootstrap).not.toHaveBeenCalled();
  });

  it('seals and bootstraps v2 only after the v1 runtime is absent', async () => {
    const h = restartHarness();
    const result =
      await restartMissionOrchestratorAfterPlanPromotionForScope(
        scope,
        'mission-promoted',
        2,
        h.deps,
      );

    expect(result.ok).toBe(true);
    expect(h.revoked).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(h.removed).toEqual([]);
    expect(h.panes).toEqual([]);
    expect(h.mission).toMatchObject({
      squadId: promotedRuntimeSquadId,
      status: 'running',
      intentState: 'dispatched',
      intentVersion: 2,
      orchestratorSessionId: undefined,
      intentContract: {
        lane: 'standard',
        intentVersion: 2,
        dispatchedAt: expect.any(Number),
      },
    });
    expect(h.ensureMissionPlan).toHaveBeenCalledWith(
      scope,
      'mission-promoted',
    );
    expect(h.bootstrap).toHaveBeenCalledWith(scope, 'mission-promoted');
    expect(h.ensureMissionPlan).toHaveBeenCalledBefore(h.bootstrap);
  });

  it('never reaches provider bootstrap when promotion has no Guided v2 receipt', async () => {
    const h = restartHarness();
    h.ensureMissionPlan.mockReturnValueOnce({
      applicable: false,
      sealed: false,
      reason: 'squad-not-engine-generated',
    });

    const result =
      await restartMissionOrchestratorAfterPlanPromotionForScope(
        scope,
        'mission-promoted',
        2,
        h.deps,
      );

    expect(result).toMatchObject({
      ok: false,
      reason: 'materialization_failed',
      error: expect.stringMatching(/guided v2|receipt/i),
    });
    expect(h.bootstrap).not.toHaveBeenCalled();
    expect(h.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
      squadId: promotedRuntimeSquadId,
      intentContract: {
        promotedPlan: expect.objectContaining({
          handoffId: 'handoff-plan-v1',
        }),
      },
    });
  });

  it('never grants v2 when a pane reappears after physical teardown', async () => {
    const h = restartHarness();
    h.panes.push({
      id: 'mpane-reappeared',
      missionId: 'mission-promoted',
      paneId: 'pane-reappeared',
      adapterId: 'codex',
      cwd: scope.rootRealPath,
      title: 'Pane reaparecido',
      agentName: 'Maestro',
      role: 'orchestrator',
      allowedTools: ['nexus_task'],
      allowedSkills: ['check-work'],
      scope,
      executionScope: scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    });
    const result =
      await restartMissionOrchestratorAfterPlanPromotionForScope(
        scope,
        'mission-promoted',
        2,
        h.deps,
      );

    expect(result).toMatchObject({
      ok: false,
      reason: 'materialization_failed',
    });
    expect(h.revoked).toEqual([]);
    expect(h.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    expect(h.mission.intentContract?.dispatchedAt).toBeUndefined();
    expect(blockedMissionRearmPatch(h.mission)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/encerrar fisicamente.*Retomar missão/i),
    });
    expect(h.ensureMissionPlan).not.toHaveBeenCalled();
    expect(h.bootstrap).not.toHaveBeenCalled();
  });

  it('re-arms the same v2 revision for an explicit restart retry', async () => {
    const h = restartHarness();
    h.panes.push({
      id: 'mpane-reappeared',
      missionId: 'mission-promoted',
      paneId: 'pane-reappeared',
      adapterId: 'codex',
      cwd: scope.rootRealPath,
      title: 'Pane reaparecido',
      agentName: 'Maestro',
      role: 'orchestrator',
      allowedTools: ['nexus_task'],
      allowedSkills: ['check-work'],
      scope,
      executionScope: scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    });
    await restartMissionOrchestratorAfterPlanPromotionForScope(
      scope,
      'mission-promoted',
      2,
      h.deps,
    );

    const retry = blockedPlanPromotionResumePatch(h.mission);

    expect(retry).toMatchObject({
      ok: true,
      intentVersion: 2,
      patch: {
        status: 'pending',
        intentState: 'ready_to_start',
        description: expect.not.stringContaining(
          'nexus:plan-promotion-restart-blocked',
        ),
        intentContract: {
          lane: 'standard',
          intentVersion: 2,
        },
      },
    });
    if (!retry.ok) throw new Error('unreachable');
    expect(retry.patch.intentContract).toMatchObject({
      dispatchedAt: undefined,
    });
  });

  it('blocks when a worker pane appears after teardown', async () => {
    const h = restartHarness();
    h.panes.push({
      id: 'mpane-plan-worker',
      missionId: 'mission-promoted',
      paneId: 'pane-plan-worker',
      adapterId: 'codex',
      cwd: scope.rootRealPath,
      title: 'Worker inesperado',
      role: 'worker',
      agentName: 'Worker inesperado',
      allowedTools: [],
      allowedSkills: ['check-work'],
      scope,
      executionScope: scope,
      authoritySeal: authoritySealFor(),
      createdAt: 1,
    });

    const result =
      await restartMissionOrchestratorAfterPlanPromotionForScope(
        scope,
        'mission-promoted',
        2,
        h.deps,
      );

    expect(result).toMatchObject({
      ok: false,
      reason: 'materialization_failed',
    });
    expect(h.revoked).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(h.mission).toMatchObject({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    expect(h.ensureMissionPlan).not.toHaveBeenCalled();
    expect(h.bootstrap).not.toHaveBeenCalled();
  });
});

interface DeadGraphHarness {
  mission: Mission;
  panes: MissionPaneSpec[];
  runtimePanes: PaneSnapshot[];
  dispatches: TaskDispatchRecord[];
  sessionStates: Map<string, 'idle' | null>;
  revoked: string[];
  closed: Array<{
    paneId: string;
    sessionId?: string;
    role?: 'orchestrator' | 'worker';
    workerIncarnationId?: string;
  }>;
  removed: string[];
  publishedExpected: Mission[];
  closeFailsFor?: string;
  publishFails?: boolean;
  deps: DeadGraphReapprovalDeps;
}

function deadGraphHarness(): DeadGraphHarness {
  const approved = approvedMission();
  const mission: Mission = {
    ...approved,
    status: 'blocked',
    intentState: 'blocked_technical',
    intentVersion: 2,
    orchestratorSessionId: 'session-orch-v2',
    intentContract: {
      ...approved.intentContract!,
      intentVersion: 2,
      approvedAt: 200,
      dispatchedAt: 210,
    },
    updatedAt: 220,
  };
  const value = {} as DeadGraphHarness;
  value.mission = mission;
  value.panes = [
    {
      id: 'pane-row-orch-v2',
      missionId: mission.id,
      paneId: 'pane-orch-v2',
      adapterId: 'codex',
      title: 'Maestro v2',
      agentName: 'Maestro',
      role: 'orchestrator',
      scope,
      executionScope: scope,
      createdAt: 200,
    },
    {
      id: 'pane-row-worker-v2',
      missionId: mission.id,
      paneId: 'pane-worker-v2',
      adapterId: 'codex',
      title: 'Worker v2',
      agentName: 'Implementador',
      workerIncarnationId: 'incarnation-worker-v2',
      role: 'worker',
      scope,
      executionScope: scope,
      createdAt: 205,
    },
  ];
  value.runtimePanes = [
    {
      paneId: 'pane-orch-v2',
      sessionId: 'session-orch-v2',
      title: 'Maestro v2',
      kind: 'cli-agent',
      state: 'idle',
      missionId: mission.id,
      role: 'orchestrator',
      scope,
      executionScope: scope,
    },
    {
      paneId: 'pane-worker-v2',
      sessionId: 'session-worker-v2',
      title: 'Worker v2',
      kind: 'cli-agent',
      state: 'idle',
      missionId: mission.id,
      workerIncarnationId: 'incarnation-worker-v2',
      role: 'worker',
      scope,
      executionScope: scope,
    },
  ];
  value.dispatches = [
    {
      id: 'dispatch-worker-v2',
      taskId: 'task-worker-v2',
      missionId: mission.id,
      intentVersion: 2,
      revision: 4,
      attempt: 1,
      state: 'superseded',
      leaseOwner: 'main',
      leaseExpiresAt: 1_000,
      workerId: 'worker-v2',
      workerIncarnationId: 'incarnation-worker-v2',
      ownership: { files: ['src/**'], symbols: [], domains: [] },
      executionMode: 'isolated_worktree',
      paneId: 'pane-worker-v2',
      sessionId: 'session-worker-v2',
      createdAt: 200,
      updatedAt: 220,
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
    },
  ];
  value.sessionStates = new Map([
    ['session-orch-v2', 'idle'],
    ['session-worker-v2', 'idle'],
  ]);
  value.revoked = [];
  value.closed = [];
  value.removed = [];
  value.publishedExpected = [];
  value.deps = {
    getMission: (_scope, missionId) =>
      missionId === value.mission.id ? value.mission : null,
    listMissionPanes: () => [...value.panes],
    removeMissionPane: (_scope, paneRowId) => {
      const index = value.panes.findIndex((pane) => pane.id === paneRowId);
      if (index < 0) return false;
      value.panes.splice(index, 1);
      value.removed.push(paneRowId);
      return true;
    },
    listTaskDispatches: () => [...value.dispatches],
    listRuntimePanes: () => [...value.runtimePanes],
    getSessionState: (sessionId) =>
      value.sessionStates.get(sessionId) ?? null,
    revokeSessionAuthority: (sessionId) => {
      value.revoked.push(sessionId);
    },
    closePane: async (input) => {
      value.closed.push(input);
      if (value.closeFailsFor === input.paneId) return false;
      if (input.sessionId) value.sessionStates.set(input.sessionId, null);
      const runtime = value.runtimePanes.find(
        (pane) => pane.paneId === input.paneId,
      );
      if (runtime) runtime.state = 'exited';
      return true;
    },
    publishReapprovalRevision: (_scope, missionId, expected) => {
      if (value.publishFails) {
        throw new Error('dead graph reapproval mission CAS changed');
      }
      expect(missionId).toBe(value.mission.id);
      value.publishedExpected.push(expected);
      const contract = expected.intentContract!;
      const {
        approvedAt: _approvedAt,
        approvalReviewSha256: _approvalReviewSha256,
        dispatchedAt: _dispatchedAt,
        squadRevisionHash: _squadRevisionHash,
        orchestratorRuntime: _orchestratorRuntime,
        spentSteps: _spentSteps,
        spentTokens: _spentTokens,
        ...copy
      } = contract;
      value.mission = {
        ...expected,
        status: 'pending',
        intentState: 'awaiting_approval',
        intentVersion: 3,
        orchestratorSessionId: undefined,
        intentContract: { ...copy, intentVersion: 3 },
        milestones: contract.acceptanceCriteria.map((label, index) => ({
          id: `step-${index + 1}`,
          label,
          status: 'pending',
          evidenceIds: [],
        })),
        updatedAt: expected.updatedAt + 1,
      };
      return value.mission;
    },
  };
  return value;
}

describe('dead task graph reapproval', () => {
  it('retires exact v2 identities and returns review-required without spawning or reusing', async () => {
    const h = deadGraphHarness();

    const result = await prepareDeadGraphReapprovalForScope(
      scope,
      h.mission.id,
      h.deps,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'review_required',
      intentVersion: 3,
      cta: 'Revisar e aprovar',
    });
    expect(h.revoked).toEqual([
      'session-orch-v2',
      'session-worker-v2',
    ]);
    expect(h.closed).toEqual([
      expect.objectContaining({
        paneId: 'pane-orch-v2',
        sessionId: 'session-orch-v2',
        role: 'orchestrator',
      }),
      expect.objectContaining({
        paneId: 'pane-worker-v2',
        sessionId: 'session-worker-v2',
        role: 'worker',
        workerIncarnationId: 'incarnation-worker-v2',
      }),
    ]);
    expect(h.removed).toEqual([
      'pane-row-orch-v2',
      'pane-row-worker-v2',
    ]);
    expect(h.publishedExpected).toHaveLength(1);
    expect(h.publishedExpected[0]).toMatchObject({
      status: 'blocked',
      intentVersion: 2,
      orchestratorSessionId: 'session-orch-v2',
    });
    expect(h.mission).toMatchObject({
      status: 'pending',
      intentState: 'awaiting_approval',
      intentVersion: 3,
      orchestratorSessionId: undefined,
    });
    expect(h.sessionStates.get('session-worker-v2')).toBeNull();
  });

  it('keeps the mission blocked when one exact physical teardown fails', async () => {
    const h = deadGraphHarness();
    h.closeFailsFor = 'pane-worker-v2';

    const result = await prepareDeadGraphReapprovalForScope(
      scope,
      h.mission.id,
      h.deps,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'not_authorized',
      error: expect.stringMatching(/prova de encerramento físico/i),
    });
    expect(h.mission).toMatchObject({
      status: 'blocked',
      intentVersion: 2,
    });
    expect(h.publishedExpected).toEqual([]);
    expect(h.removed).toEqual([]);
  });

  it('fails closed on a stale publication CAS after physical teardown', async () => {
    const h = deadGraphHarness();
    h.publishFails = true;

    const result = await prepareDeadGraphReapprovalForScope(
      scope,
      h.mission.id,
      h.deps,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'not_authorized',
      error: expect.stringMatching(/CAS.*permaneceu bloqueada/i),
    });
    expect(h.mission).toMatchObject({
      status: 'blocked',
      intentVersion: 2,
    });
    expect(h.sessionStates.get('session-orch-v2')).toBeNull();
    expect(h.sessionStates.get('session-worker-v2')).toBeNull();
  });

  it('leaves bootstrap-only blocks on the ordinary resume path', async () => {
    const h = deadGraphHarness();
    h.dispatches = [];

    const result = await prepareDeadGraphReapprovalForScope(
      scope,
      h.mission.id,
      h.deps,
    );

    expect(result).toBeNull();
    expect(h.revoked).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(h.removed).toEqual([]);
    expect(h.publishedExpected).toEqual([]);
    expect(h.mission.status).toBe('blocked');
  });

  it('routes a retired sealed provider to one teardown plus native reapproval even without a dispatch row', async () => {
    const h = deadGraphHarness();
    h.dispatches = [];
    h.panes = h.panes.filter((pane) => pane.role === 'orchestrator');
    h.runtimePanes = h.runtimePanes.filter(
      (pane) => pane.role === 'orchestrator',
    );
    h.sessionStates.delete('session-worker-v2');
    h.mission = {
      ...h.mission,
      description:
        `${h.mission.description}\n\n${TERMINAL_OPERATIONAL_FAILURE_MARKER} ` +
        `${RETIRED_ROSTER_ROUTE_MARKER} O provider do seal foi aposentado; ` +
        'revise o squad e replaneje.',
    };

    const result = await prepareDeadGraphReapprovalForScope(
      scope,
      h.mission.id,
      h.deps,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'review_required',
      intentVersion: 3,
      cta: 'Revisar e aprovar',
    });
    expect(h.revoked).toEqual(['session-orch-v2']);
    expect(h.closed).toEqual([
      expect.objectContaining({
        paneId: 'pane-orch-v2',
        sessionId: 'session-orch-v2',
        role: 'orchestrator',
      }),
    ]);
    expect(h.publishedExpected).toHaveLength(1);
  });

  it('does not tear down a live current-revision dispatch merely because a retired-route marker is present', async () => {
    const h = deadGraphHarness();
    h.dispatches = h.dispatches.map((dispatch) => ({
      ...dispatch,
      state: 'running',
    }));
    h.mission = {
      ...h.mission,
      description:
        `${h.mission.description}\n\n${TERMINAL_OPERATIONAL_FAILURE_MARKER} ` +
        `${RETIRED_ROSTER_ROUTE_MARKER} revisão necessária.`,
    };

    const result = await prepareDeadGraphReapprovalForScope(
      scope,
      h.mission.id,
      h.deps,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'not_authorized',
      error: expect.stringMatching(/dispatch.*não terminal/i),
    });
    expect(h.revoked).toEqual([]);
    expect(h.closed).toEqual([]);
    expect(h.removed).toEqual([]);
    expect(h.publishedExpected).toEqual([]);
  });
});

describe('blockedBootstrapResumePatch', () => {
  const marker = '<!-- nexus:orchestrator-bootstrap-blocked -->';

  function bootstrapBlockedMission(): Mission {
    const mission = approvedMission();
    return {
      ...mission,
      status: 'blocked',
      intentState: 'blocked_technical',
      description:
        `${mission.description}\n\n${marker}\n## Orquestrador não iniciado\n` +
        'O bootstrap não pôde selar a autoridade da sessão. CTA: Retomar missão.',
    };
  }

  it('re-arms a bootstrap-blocked mission and strips the block note', () => {
    const result = blockedBootstrapResumePatch(bootstrapBlockedMission());
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect(result.patch.status).toBe('running');
    expect(result.patch.description).toBe('Fechar bootstrap main-owned');
    expect(result.patch.description).not.toContain(marker);
  });

  it('strips the guided-plan block note before a successful retry', () => {
    const blocked: Mission = {
      ...approvedMission(),
      status: 'blocked',
      intentState: 'blocked_technical',
      description:
        'Fechar bootstrap main-owned\n\n' +
        '<!-- nexus:guided-plan-block -->\n' +
        '## Execução não iniciada\nCTA: Retomar missão.',
    };

    const result = blockedBootstrapResumePatch(blocked);

    expect(result).toMatchObject({
      ok: true,
      patch: {
        status: 'running',
        intentState: 'executing',
        description: 'Fechar bootstrap main-owned',
      },
    });
  });

  it('repairs a persisted blocked/dispatched pair instead of requiring reapproval', () => {
    const blocked: Mission = {
      ...approvedMission(),
      status: 'blocked',
      intentState: 'dispatched',
      description: 'Falha técnica transitória durante o início.',
    };

    expect(blockedBootstrapResumePatch(blocked)).toMatchObject({
      ok: true,
      patch: {
        status: 'running',
        intentState: 'executing',
        description: 'Falha técnica transitória durante o início.',
      },
    });
  });

  it('refuses missions the bootstrap did not block', () => {
    const running = approvedMission();
    expect(blockedBootstrapResumePatch(running)).toMatchObject({ ok: false });

    const blockedByDriver: Mission = {
      ...approvedMission(),
      status: 'blocked',
      intentState: 'blocked_user',
      description: 'sem marker de bootstrap',
    };
    expect(blockedBootstrapResumePatch(blockedByDriver)).toMatchObject({
      ok: true,
      patch: { status: 'running', intentState: 'executing' },
    });

    // Re-bloqueios do ciclo (kickoff sem recibo, provider_exited) não anexam
    // o marker — blocked_technical sem marker TAMBÉM é resumível.
    const blockedWithoutMarker: Mission = {
      ...approvedMission(),
      status: 'blocked',
      intentState: 'blocked_technical',
      description: 'bloqueada por outra causa',
    };
    expect(blockedBootstrapResumePatch(blockedWithoutMarker)).toMatchObject({
      ok: true,
      patch: { status: 'running', intentState: 'executing' },
    });
  });

  it('refuses when the approved dispatch authority is gone', () => {
    const stale = bootstrapBlockedMission();
    expect(
      blockedBootstrapResumePatch({ ...stale, intentContract: undefined }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/aprova/i) });
  });
});

describe('runtimeAuthorityMismatches diagnostics', () => {
  it('names each diverging field with both values', () => {
    const mission = approvedMission();
    const mismatches = runtimeAuthorityMismatches(
      scope,
      { ...mission, orchestratorSessionId: 'session-1' },
      {
        id: 'row-1',
        missionId: mission.id,
        paneId: 'pane-1',
        adapterId: 'codex',
        model: 'gpt-5.5',
        title: 'orq',
        role: 'orchestrator',
        createdAt: 1,
      },
      null,
      null,
      mission.intentContract!.orchestratorRuntime!,
    );
    expect(mismatches).toEqual(['agent session info ausente']);
  });
});

describe('seal capability canonicalization (field: agent.allowedSkills×pane)', () => {
  function sealInputs(overrides: {
    agentSkills: readonly string[] | null | undefined;
    paneSkills: readonly string[] | null | undefined;
  }) {
    const mission: Mission = {
      ...approvedMission(),
      orchestratorSessionId: 'pty-1',
    };
    const pane: MissionPaneSpec = {
      id: 'row-1',
      missionId: mission.id,
      paneId: 'pane-1',
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      accountId: 'account-codex',
      effort: 'high',
      cwd: scope.rootRealPath,
      title: 'orq',
      agentName: 'Maestro',
      role: 'orchestrator',
      readOnly: false,
      allowedTools: ['nexus_task'],
      authoritySeal: authoritySealFor(mission),
      ...(overrides.paneSkills !== undefined
        ? { allowedSkills: overrides.paneSkills as string[] | null }
        : {}),
      createdAt: 1,
    };
    const agent = {
      sessionId: 'pty-1',
      paneId: 'pane-1',
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      requestedModel: 'gpt-5.6-sol',
      accountId: 'account-codex',
      effort: 'high',
      cwd: scope.rootRealPath,
      scope,
      source: 'pending',
      role: 'orchestrator',
      missionId: mission.id,
      readOnly: false,
      nativeReadOnly: true,
      allowedTools: ['nexus_task'],
      allowedSkills: overrides.agentSkills,
      authoritySeal: authoritySealFor(mission),
    } as never;
    const authority = {
      owner: null,
      paneId: 'pane-1',
      sessionId: 'pty-1',
      kind: 'cli-agent',
      missionId: mission.id,
      role: 'orchestrator',
      scope,
    } as never;
    return { mission, pane, agent, authority };
  }

  it('treats null (PTY) and undefined (pane row) skills as the same unspecified authority', () => {
    // Field regression: architect-designed squads omit allowedSkills; the PTY
    // layer coalesces undefined→null while the durable pane row preserves
    // undefined. The seal must compare authority, not spelling.
    const { mission, pane, agent, authority } = sealInputs({
      agentSkills: null,
      paneSkills: undefined,
    });
    expect(
      runtimeAuthorityMismatches(
        scope,
        mission,
        pane,
        agent,
        authority,
        approvedRuntime,
      ),
    ).toEqual([]);
  });

  it('treats equivalent cwd spellings as the same authority', () => {
    const { mission, pane, agent, authority } = sealInputs({
      agentSkills: null,
      paneSkills: undefined,
    });
    const withSlash = {
      ...pane,
      cwd: `${scope.rootRealPath}/`,
    };
    expect(
      runtimeAuthorityMismatches(
        scope,
        mission,
        withSlash,
        agent,
        authority,
        approvedRuntime,
      ),
    ).toEqual([]);
  });

  it('still rejects a real capability divergence (explicit [] blocks everything)', () => {
    const { mission, pane, agent, authority } = sealInputs({
      agentSkills: [],
      paneSkills: null,
    });
    expect(
      runtimeAuthorityMismatches(
        scope,
        mission,
        pane,
        agent,
        authority,
        approvedRuntime,
      ),
    ).toContain('agent.allowedSkills×pane');
  });

  it('rejects a physical PTY whose authority seal differs from the persisted pane', () => {
    const { mission, pane, agent, authority } = sealInputs({
      agentSkills: null,
      paneSkills: undefined,
    });
    pane.authoritySeal = authoritySealFor(mission);
    const divergentAgent = {
      ...(agent as unknown as Record<string, unknown>),
      authoritySeal: {
        ...pane.authoritySeal,
        contextRevision: 'f'.repeat(64),
      },
    } as never;

    expect(
      runtimeAuthorityMismatches(
        scope,
        mission,
        pane,
        divergentAgent,
        authority,
        approvedRuntime,
      ),
    ).toContain('agent.authoritySeal×pane');
  });
});
