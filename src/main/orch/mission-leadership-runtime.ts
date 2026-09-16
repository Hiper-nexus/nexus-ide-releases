/**
 * Production adapter only; no callers are rewired here.
 *
 * A+C share the runtime SQLite transaction (including rebind's handoff queue).
 * D is compensated by the engine using only the fields this adapter changes.
 * Limits for the serial wiring step:
 * - ScopedStoreBinding emits immediately: legacy listeners can observe the
 *   intermediate transaction. They cannot be deferred through today's public
 *   API. The dedicated leadership event is emitted only after commit.
 * - B has a read accessor, fastLaneOrchestratorPaneSummary, but no writer. Its
 *   scoped observations participate in detection; a stale B blocks commit.
 *   The accessor also falls back to pane snapshots and ignores its scope arg,
 *   so ownership is checked here. Convert that cache to a derived reader later.
 * - E supplies physical identity/inventory, not a second writable authority.
 *   PTY metadata, pane-registry metadata and the physical spawn fence are not
 *   mutated here. Their existing synchronization remains a wiring concern.
 * - Gate has no enumerable context accessor. D covers all physical sessions
 *   plus A/B/C references; an orphan context absent from ALL of those cannot be
 *   discovered until gate exposes a scoped inventory.
 * - F reuses orch-ipc's broadcastToProject. Existing missionChanged channels
 *   carry arrays, so the discriminated event uses a dedicated channel below;
 *   preload/renderer consumption is intentionally left to the serial wiring.
 * - The runtime manager locator and domain registry must share the manager,
 *   as configured in main.ts. Missing initialization fails closed.
 */
import { webContents } from 'electron';
import { hasCurrentDispatchAuthority } from '../../shared/mission-intent';
import { projectExecutionScopeSchema, type ProjectExecutionScope } from '../../shared/project-identity-types';
import { getRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import {
  getAgentSessionInfo,
  getSessionState,
  listAgentSessions,
  registeredOrchestratorSessionsForMission,
} from '../pty/pty-manager';
import { getContextBySession, promoteMissionSessionAuthority, type AgentGateContext } from './gate';
import {
  MissionLeadership,
  type LeaderIdentity,
  type LeadershipClaim,
  type MissionLeadershipPorts,
} from './mission-leadership';
import { fastLaneOrchestratorPaneSummary } from './mission-fast-lane';
import { getMissionEventRuntimeManager } from './mission-event-emit';
import { getProjectDomainStores, sameProjectExecutionScope } from './project-domain-store-registry';
import { broadcastToProject } from './project-scoped-broadcast';

export const MISSION_LEADERSHIP_CHANGED_CHANNEL = 'orch:mission.leadershipChanged';

// No bearer, scope, provider, readOnly, or context revision is copied/mutated.
const GATE_FIELDS = [
  'role', 'missionId', 'allowedTools', 'allowedSkills',
  'handoffSubmitted', 'workerIncarnationId',
] as const;
type GateFields = Pick<AgentGateContext, typeof GATE_FIELDS[number]>;
interface GateSnapshot {
  readonly sessionId: string;
  readonly fields: Partial<GateFields>;
}
type RuntimeSnapshot = readonly GateSnapshot[];

function snapshotGate(sessionId: string, ctx: AgentGateContext): GateSnapshot {
  const fields: Partial<GateFields> = {};
  for (const key of GATE_FIELDS) {
    if (Object.hasOwn(ctx, key)) {
      const value = ctx[key];
      Object.assign(fields, { [key]: Array.isArray(value) ? [...value] : value });
    }
  }
  return { sessionId, fields };
}

export function createMissionLeadershipPorts(
  rawScope: ProjectExecutionScope,
): MissionLeadershipPorts<RuntimeSnapshot> {
  const scope = Object.freeze(projectExecutionScopeSchema.parse(rawScope));
  const suite = getProjectDomainStores(scope);
  let inTransaction = false;
  let captured: RuntimeSnapshot = [];

  function requireGate(sessionId: string, missionId: string): AgentGateContext {
    const ctx = getContextBySession(sessionId);
    if (!ctx || !sameProjectExecutionScope(ctx.scope, scope) ||
        (ctx.missionId !== undefined && ctx.missionId !== missionId)) {
      throw new Error('leadership_runtime_scope_mismatch');
    }
    return ctx;
  }

  function requireTarget(missionId: string, leader: LeaderIdentity) {
    const info = getAgentSessionInfo(leader.sessionId);
    if (!info || info.paneId !== leader.paneId ||
        !sameProjectExecutionScope(info.scope, scope) ||
        (info.missionId !== undefined && info.missionId !== missionId)) {
      throw new Error('leadership_runtime_scope_mismatch');
    }
    const ctx = requireGate(leader.sessionId, missionId);
    // user→mission_create has a separate authority contract, not this adapter.
    if (ctx.role === 'user' || info.role === 'user') {
      throw new Error('leadership_runtime_user_requires_authorization');
    }
    return { info, ctx };
  }

  function observations(missionId: string) {
    const agents = listAgentSessions().filter((s) => sameProjectExecutionScope(s.scope, scope));
    const candidates = new Set(agents.map((s) => s.sessionId));
    const claims: LeadershipClaim[] = [];
    const durable = suite.missions.get(missionId)?.orchestratorSessionId;
    if (durable) candidates.add(durable);
    for (const registered of registeredOrchestratorSessionsForMission(missionId)) {
      const info = getAgentSessionInfo(registered.sessionId);
      if (info && sameProjectExecutionScope(info.scope, scope)) candidates.add(registered.sessionId);
    }
    const specs = suite.missionPanes.list(missionId);
    for (const spec of specs.filter((p) => p.role === 'orchestrator')) {
      const matches = agents.filter((s) => s.paneId === spec.paneId && spec.paneId !== undefined);
      if (!matches.length) {
        claims.push({ source: 'mission-panes', sessionId: null, paneId: spec.paneId ?? null });
      }
      for (const info of matches) {
        claims.push({ source: 'mission-panes', sessionId: info.sessionId, paneId: spec.paneId ?? null });
      }
    }
    const fast = fastLaneOrchestratorPaneSummary(scope, missionId);
    if (fast) {
      const info = getAgentSessionInfo(fast.sessionId);
      const ctx = getContextBySession(fast.sessionId);
      const ownerScope = info?.scope ?? ctx?.scope;
      const belongs = ownerScope
        ? sameProjectExecutionScope(ownerScope, scope)
        : specs.some((spec) => spec.paneId === fast.paneId);
      if (belongs) {
        candidates.add(fast.sessionId);
        claims.push({ source: 'fast-lane', sessionId: fast.sessionId, paneId: fast.paneId });
      }
    }
    for (const sessionId of candidates) {
      const ctx = getContextBySession(sessionId);
      if (ctx?.missionId !== missionId || ctx.role !== 'orchestrator' ||
          !sameProjectExecutionScope(ctx.scope, scope)) continue;
      claims.push({ source: 'gate', sessionId, paneId: getAgentSessionInfo(sessionId)?.paneId ?? null });
    }
    return { claims, candidates };
  }

  function requireTransaction(): void {
    if (!inTransaction) throw new Error('leadership_runtime_transaction_required');
  }

  return {
    readMission: (missionId) => suite.missions.get(missionId),
    readClaims: (missionId) => observations(missionId).claims,
    readSession: (sessionId) => {
      const info = getAgentSessionInfo(sessionId);
      if (!info) return null;
      // Registered but lacking a pane is not physical proof of absence.
      if (!info.paneId) throw new Error('leadership_runtime_pane_missing');
      return {
        sessionId: info.sessionId, paneId: info.paneId, scope: info.scope,
        missionId: info.missionId, state: getSessionState(sessionId),
        // MissionLeadership uses classifySessionLiveness on this raw state.
      };
    },
    transaction: (commit) => {
      if (inTransaction) throw new Error('leadership_runtime_transaction_nested');
      const manager = getMissionEventRuntimeManager();
      if (!manager) throw new Error('leadership_runtime_not_initialized');
      const lease = manager.acquire(scope);
      try {
        lease.runtime.assertWritable();
        // Prevent F from being emitted before an unknown outer commit.
        if (lease.runtime.db.inTransaction) throw new Error('leadership_runtime_transaction_nested');
        inTransaction = true;
        lease.runtime.db.transaction(commit).immediate();
      } finally {
        inTransaction = false;
        lease.release();
      }
    },
    setDurableLeader: (missionId, leader) => {
      requireTransaction();
      requireTarget(missionId, leader);
      const mission = suite.missions.get(missionId);
      if (!mission || !hasCurrentDispatchAuthority(mission)) {
        throw new Error('leadership_dispatch_unavailable');
      }
      // Even when teardown cleared A, accepted deliveries for an older session
      // can remain. Rebind handles that queue and is also valid for first bind.
      return Boolean(suite.missions.rebindOrchestratorSession(missionId, leader.sessionId));
    },
    replacePaneLeader: (missionId, leader) => {
      requireTransaction();
      const { info, ctx } = requireTarget(missionId, leader);
      const spec = suite.missionPanes.findByPaneId(leader.paneId);
      if (spec && spec.missionId !== missionId) throw new Error('leadership_runtime_pane_mismatch');
      if (!spec) {
        // Record a worker first so promotion always demotes every previous C.
        suite.missionPanes.record({
          missionId, paneId: leader.paneId, adapterId: info.adapterId,
          role: 'worker', model: info.model, accountId: info.accountId,
          effort: info.effort, cwd: info.cwd, agentName: info.agentName,
          title: info.agentName ?? info.adapterId,
          workerIncarnationId: info.workerIncarnationId,
          allowedTools: ctx.allowedTools, allowedSkills: ctx.allowedSkills,
          readOnly: info.readOnly || ctx.readOnly === true,
          executionScope: ctx.executionScope, authoritySeal: info.authoritySeal,
        });
      }
      return Boolean(suite.missionPanes.promotePaneToOrchestrator(missionId, leader.paneId));
    },
    captureRuntime: (missionId, leader) => {
      requireTarget(missionId, leader);
      const { candidates } = observations(missionId);
      candidates.add(leader.sessionId);
      captured = [...candidates].flatMap((sessionId): GateSnapshot[] => {
        const ctx = getContextBySession(sessionId);
        if (!ctx || !sameProjectExecutionScope(ctx.scope, scope) ||
            (sessionId !== leader.sessionId && (ctx.missionId !== missionId || ctx.role !== 'orchestrator'))) return [];
        return [snapshotGate(sessionId, ctx)];
      });
      return captured;
    },
    replaceRuntimeLeader: (missionId, leader) => {
      requireTransaction();
      const { ctx } = requireTarget(missionId, leader);
      ctx.missionId = missionId;
      const previous = captured.filter((s) => s.sessionId !== leader.sessionId && s.fields.role === 'orchestrator');
      // Also run once when there is no previous leader. The primitive resets
      // only the exact promotion fields; unrelated authority stays untouched.
      return (previous.length ? previous.map((s) => s.sessionId) : [undefined])
        .every((previousSessionId) => promoteMissionSessionAuthority({
          missionId, promotedSessionId: leader.sessionId, previousSessionId,
        }));
    },
    restoreRuntime: (missionId, snapshot) => {
      const failures: unknown[] = [];
      for (const entry of snapshot) {
        try {
          const ctx = requireGate(entry.sessionId, missionId);
          for (const key of GATE_FIELDS) Reflect.deleteProperty(ctx, key);
          Object.assign(ctx, structuredClone(entry.fields));
        } catch (error) {
          // An old context disappearing must not leave the new one promoted.
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'leadership_runtime_restore_failed');
    },
    emitLeadershipChanged: (event) => {
      if (!sameProjectExecutionScope(event.scope, scope)) throw new Error('leadership_runtime_scope_mismatch');
      const targets = webContents.getAllWebContents().filter((wc) => {
        const ownerScope = getRendererWorkspaceScope(wc);
        return ownerScope && sameProjectExecutionScope(ownerScope, scope);
      });
      broadcastToProject(targets, scope, MISSION_LEADERSHIP_CHANGED_CHANNEL, event);
    },
  };
}

let leadership: MissionLeadership<RuntimeSnapshot> | undefined;

/** Does not resolve stores, open a database or register listeners until used. */
export function getMissionLeadership(): MissionLeadership<RuntimeSnapshot> {
  return leadership ??= new MissionLeadership({ forScope: createMissionLeadershipPorts });
}
