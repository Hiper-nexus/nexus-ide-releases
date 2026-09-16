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
 * - release clears A by the store CAS; C's demotion-only update is scoped to
 *   the same transaction, because the pane store only exposes promotion.
 *   Create/release preserve the gate's original-user provenance for teardown.
 */
import { webContents, type WebContents } from 'electron';
import type Database from 'better-sqlite3';
import { hasCurrentDispatchAuthority } from '../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../shared/project-identity-types';
import { getRendererWorkspaceScope, requireLiveRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import {
  getAgentSessionInfo,
  getOwnedAgentSessionInfo,
  getSessionState,
  listAgentSessions,
  registeredOrchestratorSessionsForMission,
} from '../pty/pty-manager';
import { getContextBySession, promoteMissionSessionAuthority, rollbackSessionAuthorityMission, type AgentGateContext } from './gate';
import {
  MissionLeadership,
  MissionLeadershipError,
  normalizeLeadershipScope,
  sameLeadershipScope,
  type LeadershipChange,
  type LeadershipRelease,
  type LeadershipTakeoverInput,
  type AppliedLeadership,
  type LeaderIdentity,
  type LeadershipClaim,
  type MissionLeadershipPorts,
} from './mission-leadership';
import { fastLaneOrchestratorPaneSummary } from './mission-fast-lane';
import { getMissionEventRuntimeManager } from './mission-event-emit';
import { getProjectDomainStores, requireProjectDomainStoreRegistry } from './project-domain-store-registry';
import { broadcastToProject } from './project-scoped-broadcast';

export const MISSION_LEADERSHIP_CHANGED_CHANNEL = 'orch:mission.leadershipChanged';

// Only fields changed by promote/create/release; never bearer/scope/provider.
const GATE_FIELDS = [
  'role', 'missionId', 'allowedTools', 'allowedSkills',
  'handoffSubmitted', 'workerIncarnationId', 'promotedFromUserSession', 'contextRevision',
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
  const requested = normalizeLeadershipScope(rawScope);
  // Reuse the canonical complete scope when a legacy caller lacks fs identity.
  // Registry ausente (boot incompleto, fixtures de teste) = engine indisponível
  // para este escopo: erro TIPADO, para leitores degradarem à ligação durável
  // da missão e escritores falharem fechados — nunca um Error cru vazando.
  let existing: { readonly scope: ProjectExecutionScope } | undefined;
  try {
    existing = requireProjectDomainStoreRegistry().listSuites()
      .find((candidate) => sameLeadershipScope(candidate.scope, requested));
  } catch {
    throw new MissionLeadershipError('unavailable', { reason: 'store_registry_not_initialized' });
  }
  const scope = existing?.scope ?? requested;
  let suite: ReturnType<typeof getProjectDomainStores>;
  try {
    suite = getProjectDomainStores(scope);
  } catch {
    throw new MissionLeadershipError('unavailable', { reason: 'store_suite_unavailable' });
  }
  let inTransaction = false;
  let transactionDb: Database.Database | undefined;
  let captured: RuntimeSnapshot = [];

  function requireGate(sessionId: string, missionId: string): AgentGateContext {
    const ctx = getContextBySession(sessionId);
    if (!ctx || !sameLeadershipScope(ctx.scope, scope) ||
        (ctx.missionId !== undefined && ctx.missionId !== missionId)) {
      throw new MissionLeadershipError('scope_mismatch', { reason: 'leadership_runtime_scope_mismatch' });
    }
    return ctx;
  }

  function requireTarget(missionId: string, leader: LeaderIdentity) {
    const info = getAgentSessionInfo(leader.sessionId);
    if (!info || info.paneId !== leader.paneId ||
        !sameLeadershipScope(info.scope, scope) ||
        (info.missionId !== undefined && info.missionId !== missionId)) {
      throw new MissionLeadershipError('scope_mismatch', { reason: 'leadership_runtime_scope_mismatch' });
    }
    const ctx = requireGate(leader.sessionId, missionId);
    if (leader.origin === 'create') {
      const initialCreator = ctx.role === 'user' && info.role === 'user';
      const replayedCreator = ctx.role === 'orchestrator' && ctx.promotedFromUserSession === true && ctx.missionId === missionId;
      if (!initialCreator && !replayedCreator) {
        throw new MissionLeadershipError('scope_mismatch', { missionId, reason: 'create_requires_user_creator' });
      }
    } else if (ctx.role === 'user' || info.role === 'user') {
      throw new MissionLeadershipError('scope_mismatch', { reason: 'leadership_runtime_user_requires_authorization' });
    }
    return { info, ctx };
  }

  function observations(missionId: string) {
    const agents = listAgentSessions().filter((s) => sameLeadershipScope(s.scope, scope));
    const candidates = new Set(agents.map((s) => s.sessionId));
    const claims: LeadershipClaim[] = [];
    const durable = suite.missions.get(missionId)?.orchestratorSessionId;
    if (durable) candidates.add(durable);
    for (const registered of registeredOrchestratorSessionsForMission(missionId)) {
      const info = getAgentSessionInfo(registered.sessionId);
      if (info && sameLeadershipScope(info.scope, scope)) candidates.add(registered.sessionId);
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
        ? sameLeadershipScope(ownerScope, scope)
        : specs.some((spec) => spec.paneId === fast.paneId);
      // After an explicit release, a leftover cache entry cannot elect itself
      // again: it must still have a durable pane/mission or gate attachment.
      const stillAttached = durable || specs.some((spec) => spec.role === 'orchestrator') || ctx?.missionId === missionId;
      if (belongs && stillAttached) {
        candidates.add(fast.sessionId);
        claims.push({ source: 'fast-lane', sessionId: fast.sessionId, paneId: fast.paneId });
      }
    }
    for (const sessionId of candidates) {
      const ctx = getContextBySession(sessionId);
      if (ctx?.missionId !== missionId || ctx.role !== 'orchestrator' ||
          !sameLeadershipScope(ctx.scope, scope)) continue;
      claims.push({ source: 'gate', sessionId, paneId: getAgentSessionInfo(sessionId)?.paneId ?? null });
    }
    return { claims, candidates };
  }

  function requireTransaction(): void {
    if (!inTransaction) throw new MissionLeadershipError('write_incomplete', { reason: 'leadership_runtime_transaction_required' });
  }

  function captureContexts(missionId: string, sessionId: string): RuntimeSnapshot {
    const { candidates } = observations(missionId);
    candidates.add(sessionId);
    captured = [...candidates].flatMap((id): GateSnapshot[] => {
      const ctx = getContextBySession(id);
      if (!ctx || !sameLeadershipScope(ctx.scope, scope) ||
          (id !== sessionId && (ctx.missionId !== missionId || ctx.role !== 'orchestrator'))) return [];
      if (ctx.missionId !== undefined && ctx.missionId !== missionId) {
        throw new MissionLeadershipError('scope_mismatch', { missionId, sessionIds: [id] });
      }
      return [snapshotGate(id, ctx)];
    });
    return captured;
  }

  function emit(event: LeadershipChange | LeadershipRelease): void {
    if (!sameLeadershipScope(event.scope, scope)) throw new MissionLeadershipError('scope_mismatch');
    const targets = webContents.getAllWebContents().filter((wc) => {
      const ownerScope = getRendererWorkspaceScope(wc);
      return ownerScope && sameLeadershipScope(ownerScope, scope);
    });
    broadcastToProject(targets, scope, MISSION_LEADERSHIP_CHANGED_CHANNEL, event);
  }

  return {
    readMission: (missionId) => suite.missions.get(missionId),
    readClaims: (missionId) => observations(missionId).claims,
    readSession: (sessionId) => {
      const info = getAgentSessionInfo(sessionId);
      if (!info) return null;
      // Registered but lacking a pane is not physical proof of absence.
      if (!info.paneId) throw new MissionLeadershipError('scope_mismatch', { reason: 'leadership_runtime_pane_missing' });
      return {
        sessionId: info.sessionId, paneId: info.paneId, scope: info.scope,
        missionId: info.missionId, state: getSessionState(sessionId),
        // MissionLeadership uses classifySessionLiveness on this raw state.
      };
    },
    transaction: (commit) => {
      if (inTransaction) throw new MissionLeadershipError('busy', { reason: 'leadership_runtime_transaction_nested' });
      const manager = getMissionEventRuntimeManager();
      if (!manager) throw new MissionLeadershipError('write_incomplete', { reason: 'leadership_runtime_not_initialized' });
      const lease = manager.acquire(scope);
      try {
        lease.runtime.assertWritable();
        // Prevent F from being emitted before an unknown outer commit.
        if (lease.runtime.db.inTransaction) throw new MissionLeadershipError('busy', { reason: 'leadership_runtime_transaction_nested' });
        inTransaction = true;
        transactionDb = lease.runtime.db;
        transactionDb.transaction(commit).immediate();
      } finally {
        inTransaction = false;
        transactionDb = undefined;
        lease.release();
      }
    },
    setDurableLeader: (missionId, leader) => {
      requireTransaction();
      requireTarget(missionId, leader);
      const mission = suite.missions.get(missionId);
      if (leader.origin === 'create') {
        if (!mission) throw new MissionLeadershipError('mission_missing', { missionId });
        if (mission.status !== 'pending' || (mission.orchestratorSessionId && mission.orchestratorSessionId !== leader.sessionId)) {
          throw new MissionLeadershipError('existing_session', { missionId, reason: 'create_requires_initial_binding' });
        }
        return Boolean(suite.missions.setOrchestratorSession(missionId, leader.sessionId));
      }
      if (!mission || !hasCurrentDispatchAuthority(mission)) {
        throw new MissionLeadershipError('scope_mismatch', { reason: 'leadership_dispatch_unavailable' });
      }
      // Even when teardown cleared A, accepted deliveries for an older session
      // can remain. Rebind handles that queue and is also valid for first bind.
      return Boolean(suite.missions.rebindOrchestratorSession(missionId, leader.sessionId));
    },
    replacePaneLeader: (missionId, leader) => {
      requireTransaction();
      const { info, ctx } = requireTarget(missionId, leader);
      const spec = suite.missionPanes.findByPaneId(leader.paneId);
      if (spec && spec.missionId !== missionId) throw new MissionLeadershipError('scope_mismatch', { reason: 'leadership_runtime_pane_mismatch' });
      if (!spec) {
        // create has no predecessor and preserves the creator's capabilities.
        // Other origins record a worker first, then demote previous C leaders.
        suite.missionPanes.record({
          missionId, paneId: leader.paneId, adapterId: info.adapterId,
          role: leader.origin === 'create' ? 'orchestrator' : 'worker', model: info.model, accountId: info.accountId,
          effort: info.effort, cwd: info.cwd, agentName: info.agentName,
          title: info.agentName ?? info.adapterId,
          workerIncarnationId: leader.origin === 'create' ? undefined : info.workerIncarnationId,
          allowedTools: ctx.allowedTools, allowedSkills: ctx.allowedSkills,
          readOnly: info.readOnly || ctx.readOnly === true,
          executionScope: ctx.executionScope ? normalizeLeadershipScope(ctx.executionScope) : undefined,
          authoritySeal: info.authoritySeal,
        });
      }
      if (leader.origin === 'create') {
        return suite.missionPanes.findByPaneId(leader.paneId)?.role === 'orchestrator';
      }
      return Boolean(suite.missionPanes.promotePaneToOrchestrator(missionId, leader.paneId));
    },
    captureRuntime: (missionId, leader) => {
      requireTarget(missionId, leader);
      return captureContexts(missionId, leader.sessionId);
    },
    replaceRuntimeLeader: (missionId, leader) => {
      requireTransaction();
      const { ctx } = requireTarget(missionId, leader);
      ctx.missionId = missionId;
      if (leader.origin === 'create') {
        // Matches nexus_mission_create: preserve creator capability limits.
        ctx.role = 'orchestrator';
        ctx.promotedFromUserSession = true;
        return true;
      }
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
      if (failures.length) throw new MissionLeadershipError('write_incomplete', { reason: 'leadership_runtime_restore_failed' });
    },
    clearDurableLeaderIfMatches: (missionId, sessionId) => {
      requireTransaction();
      return Boolean(suite.missions.clearOrchestratorSessionIfMatches(missionId, sessionId));
    },
    releasePaneLeader: (missionId) => {
      requireTransaction();
      // No demotion-only store primitive exists. Keep rows/ids/history and
      // scoped authority intact; this narrow update shares A's transaction.
      transactionDb!.prepare(`UPDATE mission_panes
        SET role = 'worker', allowed_tools_json = '[]', allowed_skills_json = 'null'
        WHERE mission_id = ? AND role = 'orchestrator'`).run(missionId);
      return true;
    },
    captureReleaseRuntime: captureContexts,
    releaseRuntimeLeader: (missionId) => {
      requireTransaction();
      for (const entry of captured) {
        const ctx = requireGate(entry.sessionId, missionId);
        if (!rollbackSessionAuthorityMission(entry.sessionId, missionId)) continue;
        if (ctx.role === 'orchestrator') {
          ctx.role = 'worker';
          ctx.allowedTools = [];
          ctx.allowedSkills = null;
          ctx.handoffSubmitted = false;
        }
      }
      return true;
    },
    emitLeadershipChanged: emit,
    emitLeadershipReleased: emit,
  };
}

let leadership: MissionLeadership<RuntimeSnapshot> | undefined;
let operatorTakeover: {
  readonly owner: WebContents;
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly input: LeadershipTakeoverInput;
  consumed: boolean;
} | undefined;

function operatorScope(owner: WebContents, expected?: ProjectExecutionScope): ProjectExecutionScope {
  try {
    return requireLiveRendererWorkspaceScope(owner, expected);
  } catch {
    throw new MissionLeadershipError('scope_mismatch', { reason: 'takeover_renderer_unavailable' });
  }
}

function authorizeOperatorTakeover(
  scope: ProjectExecutionScope,
  missionId: string,
  input: LeadershipTakeoverInput,
): boolean {
  const grant = operatorTakeover;
  if (!grant || grant.consumed || !sameLeadershipScope(grant.scope, scope) ||
      grant.missionId !== missionId || grant.input.sessionId !== input.sessionId ||
      grant.input.paneId !== input.paneId || grant.input.reason !== input.reason) return false;
  grant.consumed = true;
  const liveScope = operatorScope(grant.owner, grant.scope);
  const session = getOwnedAgentSessionInfo(grant.owner, input.sessionId);
  return Boolean(session && session.paneId === input.paneId &&
    sameLeadershipScope(session.scope, liveScope) &&
    (session.missionId === undefined || session.missionId === missionId));
}

/**
 * Main-only entry for RendererMissionAuthority's explicit operator action.
 * Not exposed to MCP or connected to existing callers in this adapter stage.
 * Ownership comes from WebContents/PTY state; the payload cannot grant itself
 * takeover. Authorization is exact, synchronous, one-use and always revoked.
 */
export function takeoverMissionLeadershipFromRenderer(
  owner: WebContents,
  missionId: string,
  input: Omit<LeadershipTakeoverInput, 'origin'>,
): AppliedLeadership {
  if (operatorTakeover) throw new MissionLeadershipError('busy', { missionId });
  const scope = operatorScope(owner);
  const session = getOwnedAgentSessionInfo(owner, input.sessionId);
  if (!session || session.paneId !== input.paneId || !sameLeadershipScope(session.scope, scope) ||
      (session.missionId !== undefined && session.missionId !== missionId)) {
    throw new MissionLeadershipError('scope_mismatch', { missionId, reason: 'takeover_requires_owned_pane' });
  }
  const takeover: LeadershipTakeoverInput = Object.freeze({
    origin: 'takeover', sessionId: input.sessionId, paneId: input.paneId, reason: input.reason,
  });
  operatorTakeover = { owner, scope, missionId, input: takeover, consumed: false };
  try {
    return getMissionLeadership().applyLeadership(scope, missionId, takeover);
  } finally {
    operatorTakeover = undefined;
  }
}

/** Does not resolve stores, open a database or register listeners until used. */
export function getMissionLeadership(): MissionLeadership<RuntimeSnapshot> {
  return leadership ??= new MissionLeadership({
    forScope: createMissionLeadershipPorts,
    authorizeTakeover: authorizeOperatorTakeover,
  });
}
