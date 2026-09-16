import { z } from 'zod';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/project-identity-types';
import { classifySessionLiveness } from '../pty/session-liveness';

const idSchema = z.string().min(1).max(256).refine((id) => id.trim() === id);
const leadershipInputSchema = z.object({
  sessionId: idSchema,
  paneId: idSchema,
  origin: z.enum(['spawn', 'adopt', 'respawn', 'promote']),
}).strict();
const claimSchema = z.object({
  source: z.enum(['fast-lane', 'mission-panes', 'gate', 'panes', 'renderer']),
  sessionId: idSchema.nullable(),
  paneId: idSchema.nullable(),
});

export type LeadershipInput = z.infer<typeof leadershipInputSchema>;
export interface LeaderIdentity {
  readonly sessionId: string;
  readonly paneId: string;
}

export interface MissionLeader {
  readonly sessionId: string;
  /** A persisted session may have no physical pane after a restart. */
  readonly paneId: string | null;
  readonly source: 'durable' | 'live';
  /** Shared PTY classification, not proof that all descendants have exited. */
  readonly proven: boolean;
}

/** A comes from readMission; B–F are observations, never additional authorities. */
export interface LeadershipClaim {
  readonly source: 'fast-lane' | 'mission-panes' | 'gate' | 'panes' | 'renderer';
  readonly sessionId: string | null;
  readonly paneId: string | null;
}

export interface LeadershipSession extends LeaderIdentity {
  readonly scope: ProjectExecutionScope;
  readonly missionId?: string;
  readonly state: string | null | undefined;
}

export interface LeadershipChange extends LeadershipInput {
  readonly type: 'mission-leadership-changed';
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly previousSessionIds: readonly string[];
  readonly previousPaneIds: readonly string[];
}

/**
 * Main-owned, scope-bound ports. No Electron import and no terminate/spawn port.
 * The adapter must validate mission dispatch authority and session ownership;
 * this engine is NOT an IPC authorization boundary.
 *
 * Wiring contract:
 * - readClaims enumerates ALL B/C/D/E leaders, plus F when acknowledged by the
 *   renderer; map pane-only C rows to sessions when known. Never filter dead
 *   registered sessions or infer authority from an agent's display name.
 * - transaction synchronously rolls back A+C (including rebind side effects),
 *   and defers store notifications until commit. No asynchronous callbacks.
 * - replacePaneLeader records/promotes C and demotes every previous C leader.
 * - replaceRuntimeLeader binds D, revokes every previous D leader and updates
 *   B plus main-owned PTY/pane metadata E. It must preserve processes, readOnly,
 *   scope and unrelated authority fields. No killing, even on rollback.
 * - capture/restoreRuntime include every changed runtime field, also for an
 *   initially unassigned adoption target; restoration must work after a partial
 *   write. Do not put gate tokens in claims, events or logs.
 * - emit delivers the complete identity to F (layout role AND paneMissions).
 *   Replay is safe: the payload sets identity rather than toggling a role.
 */
export interface MissionLeadershipPorts<RuntimeSnapshot> {
  readMission(missionId: string): { readonly orchestratorSessionId?: string | null } | null;
  readClaims(missionId: string): readonly LeadershipClaim[];
  /** null means physically unregistered, not merely exited/hibernated. */
  readSession(sessionId: string): LeadershipSession | null;
  transaction(commit: () => void): void;
  setDurableLeader(missionId: string, leader: LeaderIdentity): boolean;
  replacePaneLeader(missionId: string, leader: LeaderIdentity): boolean;
  captureRuntime(missionId: string, leader: LeaderIdentity): RuntimeSnapshot;
  replaceRuntimeLeader(missionId: string, leader: LeaderIdentity): boolean;
  restoreRuntime(missionId: string, snapshot: RuntimeSnapshot): void;
  emitLeadershipChanged(event: LeadershipChange): void;
}

export interface MissionLeadershipDeps<RuntimeSnapshot> {
  forScope(scope: ProjectExecutionScope): MissionLeadershipPorts<RuntimeSnapshot>;
}

export interface AppliedLeadership {
  readonly leader: MissionLeader;
  readonly event: LeadershipChange;
  /** false is a committed change needing event replay, never a rollback. */
  readonly rendererNotified: boolean;
  readonly notificationError?: unknown;
}

interface Observation {
  readonly durable: string | null;
  readonly claims: readonly LeadershipClaim[];
  readonly sessions: ReadonlyMap<string, LeadershipSession | null>;
}

function scopeKey(scope: ProjectExecutionScope): string {
  return JSON.stringify([
    scope.version, scope.installationId, scope.projectId, scope.checkoutId,
    scope.rootRealPath, scope.workspaceRootDevice, scope.workspaceRootInode,
    scope.identitySource,
  ]);
}

function requireOwnedSession(
  session: LeadershipSession,
  scope: ProjectExecutionScope,
  missionId: string,
): void {
  if (scopeKey(session.scope) !== scopeKey(scope) ||
      (session.missionId !== undefined && session.missionId !== missionId)) {
    throw new Error('leadership_scope_mismatch');
  }
}

function assertAgreement(observation: Observation): void {
  const sessionIds = new Set(observation.sessions.keys());
  const paneIds = new Set(observation.claims.flatMap((c) => c.paneId ? [c.paneId] : []));
  for (const session of observation.sessions.values()) {
    if (session) paneIds.add(session.paneId);
  }
  if (sessionIds.size > 1 || paneIds.size > 1) {
    // Only non-secret provenance is exposed; gate contexts never reach errors.
    const sources = [...new Set(observation.claims.map((c) => c.source))];
    throw new Error(
      `leadership_split_brain: sources=${observation.durable ? 'durable,' : ''}${sources.join(',')}` +
      ` sessions=${JSON.stringify([...sessionIds])} panes=${JSON.stringify([...paneIds])}`,
    );
  }
}

/**
 * Instantiate ONCE in Main and route all leadership reads/writes here.
 * Until callers are rewired, this standalone engine cannot fence legacy writes.
 *
 * ponytail: synchronous ports avoid an async lock/queue. The guard covers
 * reentrant store listeners in this instance; multi-process writers would need
 * a database CAS/lease. Crash atomicity spans A+C only: rebuild D/B/E from A+C
 * on startup, then re-emit F. A renderer acknowledgement is not a DB commit.
 */
export class MissionLeadership<RuntimeSnapshot> {
  readonly #busy = new Set<string>();

  constructor(private readonly deps: MissionLeadershipDeps<RuntimeSnapshot>) {}

  #access(scope: ProjectExecutionScope, missionId: string) {
    const parsedScope = Object.freeze(projectExecutionScopeSchema.parse(scope));
    idSchema.parse(missionId);
    const key = JSON.stringify([scopeKey(parsedScope), missionId]);
    if (this.#busy.has(key)) throw new Error('leadership_busy');
    return { scope: parsedScope, key, ports: this.deps.forScope(parsedScope) };
  }

  #observe(
    ports: MissionLeadershipPorts<RuntimeSnapshot>,
    scope: ProjectExecutionScope,
    missionId: string,
    includeRenderer = true,
  ): Observation | null {
    const mission = ports.readMission(missionId);
    if (!mission) return null;
    const durable = mission.orchestratorSessionId == null
      ? null : idSchema.parse(mission.orchestratorSessionId);
    const claims = ports.readClaims(missionId)
      .filter((claim) => includeRenderer || claim.source !== 'renderer')
      .map((claim) => claimSchema.parse(claim));
    const ids = new Set(claims.flatMap((c) => c.sessionId ? [c.sessionId] : []));
    if (durable) ids.add(durable);
    const sessions = new Map<string, LeadershipSession | null>();
    for (const id of ids) {
      idSchema.parse(id);
      const found = ports.readSession(id);
      if (found) {
        requireOwnedSession(found, scope, missionId);
        idSchema.parse(found.paneId);
        if (found.sessionId !== id) throw new Error('leadership_target_mismatch');
      }
      // Copy primitive identity/state: later runtime writes may mutate their
      // source objects; the pre-commit event and rollback evidence must not.
      sessions.set(id, found ? { ...found, scope: { ...found.scope } } : null);
    }
    return { durable, claims, sessions };
  }

  resolveMissionLeader(scope: ProjectExecutionScope, missionId: string): MissionLeader | null {
    const access = this.#access(scope, missionId);
    const observed = this.#observe(access.ports, access.scope, missionId);
    if (!observed) return null;
    const live = [...observed.sessions.entries()].filter(([, session]) =>
      session && classifySessionLiveness(session.state) === 'live');
    // Never choose a winner by array order when multiple live leaders exist.
    if (live.length > 1) throw new Error('leadership_split_brain: multiple live sessions');
    const sessionId = observed.durable ?? live[0]?.[0];
    if (!sessionId) return null;
    const session = observed.sessions.get(sessionId);
    const panes = new Set(observed.claims
      .filter((c) => c.sessionId === sessionId && c.paneId !== null)
      .map((c) => c.paneId!));
    if (session) panes.add(session.paneId);
    if (panes.size > 1) throw new Error('leadership_split_brain: conflicting pane identity');
    return {
      sessionId,
      paneId: panes.values().next().value ?? null,
      source: observed.durable ? 'durable' : 'live',
      proven: Boolean(session && classifySessionLiveness(session.state) === 'live'),
    };
  }

  /** Detects stale disagreements too; missing observations alone are not claims. */
  assertSingleLeader(scope: ProjectExecutionScope, missionId: string): void {
    const access = this.#access(scope, missionId);
    const observed = this.#observe(access.ports, access.scope, missionId);
    if (observed) assertAgreement(observed);
  }

  applyLeadership(
    scope: ProjectExecutionScope,
    missionId: string,
    input: LeadershipInput,
  ): AppliedLeadership {
    const leader = Object.freeze(leadershipInputSchema.parse(input));
    const access = this.#access(scope, missionId);
    const { ports, key } = access;
    this.#busy.add(key);
    try {
      const before = this.#observe(ports, access.scope, missionId);
      if (!before) throw new Error('leadership_mission_missing');
      const session = ports.readSession(leader.sessionId);
      if (!session || classifySessionLiveness(session.state) !== 'live') {
        throw new Error('leadership_target_not_live');
      }
      requireOwnedSession(session, access.scope, missionId);
      if (session.sessionId !== leader.sessionId || session.paneId !== leader.paneId) {
        throw new Error('leadership_target_mismatch');
      }
      for (const [id, previous] of before.sessions) {
        if (id === leader.sessionId || !previous) continue;
        // Spawn fences count even exited registrations. Adoption/promotion can
        // revoke exited authority without killing the physical session.
        if (leader.origin === 'spawn' || leader.origin === 'respawn' ||
            classifySessionLiveness(previous.state) !== 'exited') {
          throw new Error('leadership_existing_session');
        }
      }
      const runtime = ports.captureRuntime(missionId, leader);
      let runtimeTouched = false;
      try {
        ports.transaction(() => {
          if (!ports.setDurableLeader(missionId, leader) ||
              !ports.replacePaneLeader(missionId, leader)) {
            throw new Error('leadership_write_refused');
          }
          runtimeTouched = true;
          if (!ports.replaceRuntimeLeader(missionId, leader)) {
            throw new Error('leadership_write_refused');
          }
          // F is asynchronous; it must not veto a committed Main authority.
          const after = this.#observe(ports, access.scope, missionId, false);
          if (!after || after.durable !== leader.sessionId ||
              !['mission-panes', 'gate'].every((source) => after.claims.some((c) =>
                c.source === source && c.sessionId === leader.sessionId &&
                c.paneId === leader.paneId))) {
            throw new Error('leadership_write_incomplete');
          }
          assertAgreement(after);
          const current = after.sessions.get(leader.sessionId);
          if (!current || classifySessionLiveness(current.state) !== 'live') {
            throw new Error('leadership_target_not_live');
          }
        });
      } catch (error) {
        if (runtimeTouched) {
          try {
            ports.restoreRuntime(missionId, runtime);
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'leadership_rollback_failed');
          }
        }
        throw error;
      }
      const event: LeadershipChange = Object.freeze({
        type: 'mission-leadership-changed',
        scope: access.scope,
        missionId,
        ...leader,
        previousSessionIds: Object.freeze([...before.sessions.keys()].filter((id) => id !== leader.sessionId)),
        previousPaneIds: Object.freeze([...new Set([
          ...before.claims.map((c) => c.paneId),
          ...[...before.sessions.values()].map((s) => s?.paneId ?? null),
        ].filter((id): id is string => id !== null && id !== leader.paneId))]),
      });
      const resolved: MissionLeader = Object.freeze({
        sessionId: leader.sessionId, paneId: leader.paneId, source: 'durable', proven: true,
      });
      // Readers invoked by the emitter now see the fully committed state.
      this.#busy.delete(key);
      try {
        ports.emitLeadershipChanged(event);
        return { leader: resolved, event, rendererNotified: true };
      } catch (notificationError) {
        return { leader: resolved, event, rendererNotified: false, notificationError };
      }
    } finally {
      this.#busy.delete(key);
    }
  }
}
