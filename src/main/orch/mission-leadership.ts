import { z } from 'zod';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/project-identity-types';
import { classifySessionLiveness } from '../pty/session-liveness';

const idSchema = z.string().min(1).max(256).refine((id) => id.trim() === id);
const leaderIdentitySchema = z.object({
  sessionId: idSchema,
  paneId: idSchema,
});
const leadershipInputSchema = z.discriminatedUnion('origin', [
  leaderIdentitySchema.extend({
    origin: z.enum(['spawn', 'adopt', 'respawn', 'promote', 'create']),
  }).strict(),
  leaderIdentitySchema.extend({
    origin: z.literal('takeover'),
    reason: z.string().min(1).max(2048).refine((reason) => reason.trim().length > 0),
  }).strict(),
]);
const releaseInputSchema = z.object({ sessionId: idSchema, reason: idSchema }).strict();
const claimSchema = z.object({
  source: z.enum(['fast-lane', 'mission-panes', 'gate', 'panes', 'renderer']),
  sessionId: idSchema.nullable(),
  paneId: idSchema.nullable(),
});

export type LeadershipInput = z.infer<typeof leadershipInputSchema>;
export type LeadershipTakeoverInput = Extract<LeadershipInput, { origin: 'takeover' }>;
export type ReleaseLeadershipInput = z.infer<typeof releaseInputSchema>;
export type MissionLeadershipErrorCode = 'split_brain' | 'existing_session' |
  'target_not_live' | 'write_incomplete' | 'scope_mismatch' | 'busy' | 'mission_missing' |
  /** Engine cannot observe this scope (store registry not initialized). Readers
   * degrade to the durable mission binding; writers fail closed. */
  'unavailable';
export interface MissionLeadershipErrorPayload {
  readonly missionId?: string;
  readonly sessionIds?: readonly string[];
  readonly paneIds?: readonly string[];
  readonly sources?: readonly string[];
  /** Fixed diagnostic tag, never an upstream exception or gate context. */
  readonly reason?: string;
}
export class MissionLeadershipError extends Error {
  readonly payload: MissionLeadershipErrorPayload;
  constructor(readonly code: MissionLeadershipErrorCode, payload: MissionLeadershipErrorPayload = {}) {
    const safe = Object.freeze({
      ...(payload.missionId === undefined ? {} : { missionId: payload.missionId }),
      ...(payload.reason === undefined ? {} : { reason: payload.reason }),
      ...(payload.sessionIds ? { sessionIds: Object.freeze([...payload.sessionIds]) } : {}),
      ...(payload.paneIds ? { paneIds: Object.freeze([...payload.paneIds]) } : {}),
      ...(payload.sources ? { sources: Object.freeze([...payload.sources]) } : {}),
    });
    super(`leadership_${code}: ${JSON.stringify(safe)}`);
    this.name = 'MissionLeadershipError';
    this.payload = safe;
  }
}

function parseContract<T>(schema: z.ZodType<T>, input: unknown, reason: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new MissionLeadershipError('write_incomplete', { reason });
  return parsed.data;
}

/** An incomplete legacy filesystem identity conveys no device/inode proof. */
export function normalizeLeadershipScope(scope: ProjectExecutionScope): ProjectExecutionScope {
  const normalized = { ...scope };
  if (normalized.workspaceRootDevice === undefined || normalized.workspaceRootInode === undefined) {
    delete normalized.workspaceRootDevice;
    delete normalized.workspaceRootInode;
  }
  const parsed = projectExecutionScopeSchema.safeParse(normalized);
  if (!parsed.success) throw new MissionLeadershipError('scope_mismatch', { reason: 'invalid_scope' });
  return Object.freeze(parsed.data);
}

export function sameLeadershipScope(left: ProjectExecutionScope, right: ProjectExecutionScope): boolean {
  const a = normalizeLeadershipScope(left);
  const b = normalizeLeadershipScope(right);
  return scopeKey(a) === scopeKey(b) &&
    (a.workspaceRootDevice === undefined || b.workspaceRootDevice === undefined ||
      (a.workspaceRootDevice === b.workspaceRootDevice && a.workspaceRootInode === b.workspaceRootInode));
}
export interface LeaderIdentity {
  readonly sessionId: string;
  readonly paneId: string;
  readonly origin?: LeadershipInput['origin'];
}

export interface MissionLeader {
  readonly sessionId: string;
  /** A persisted session may have no physical pane after a restart. */
  readonly paneId: string | null;
  readonly source: 'durable' | 'live';
  /** Shared PTY classification, not proof that all descendants have exited. */
  readonly proven: boolean;
  /**
   * What the runtime actually observed for the leader session: 'exited' is a
   * known death (a token replayed from it must be denied), 'unregistered' is
   * absence of observation (not death). Optional for legacy/fixture leaders.
   */
  readonly liveness?: 'live' | 'exited' | 'unverifiable' | 'unregistered';
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

export type LeadershipChange = LeadershipInput & {
  readonly type: 'mission-leadership-changed';
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly previousSessionIds: readonly string[];
  readonly previousPaneIds: readonly string[];
};
export interface LeadershipRelease extends ReleaseLeadershipInput {
  readonly type: 'mission-leadership-released';
  readonly scope: ProjectExecutionScope;
  readonly missionId: string;
  readonly paneIds: readonly string[];
}
export type ReleasedLeadership = { readonly released: false } | {
  readonly released: true;
  readonly event: LeadershipRelease;
  readonly rendererNotified: boolean;
  readonly notificationError?: unknown;
};

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
 * - create is initial creator binding only; it must not bypass the adapter's
 *   user-ownership checks or authorize ordinary dispatch on a pending mission.
 * - release CAS failure has no C/D/event effects. On success, revoke all
 *   authoritative claims, compensate D on rollback, emit only after commit.
 * Expected domain/validation failures use MissionLeadershipError. Unexpected
 * I/O exceptions from ports retain their original identity for diagnostics.
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
  /** CAS false must perform no writes; teardown never clears a successor. */
  clearDurableLeaderIfMatches(missionId: string, sessionId: string): boolean;
  releasePaneLeader(missionId: string, sessionId: string): boolean;
  captureReleaseRuntime(missionId: string, sessionId: string): RuntimeSnapshot;
  releaseRuntimeLeader(missionId: string, sessionId: string): boolean;
  emitLeadershipReleased(event: LeadershipRelease): void;
}

export interface MissionLeadershipDeps<RuntimeSnapshot> {
  forScope(scope: ProjectExecutionScope): MissionLeadershipPorts<RuntimeSnapshot>;
  /** Main-owned operator authority, never a boolean/role supplied over MCP.
   * Absent means deny. Production consumes a one-shot renderer-owned grant. */
  authorizeTakeover?(
    scope: ProjectExecutionScope,
    missionId: string,
    input: LeadershipTakeoverInput,
  ): boolean;
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
    // A legacy/complete pair must share the same reentrancy lock. Complete
    // filesystem identities are still compared by sameLeadershipScope.
    scope.rootRealPath, scope.identitySource,
  ]);
}

function requireOwnedSession(
  session: LeadershipSession,
  scope: ProjectExecutionScope,
  missionId: string,
): void {
  if (!sameLeadershipScope(session.scope, scope) ||
      (session.missionId !== undefined && session.missionId !== missionId)) {
    throw new MissionLeadershipError('scope_mismatch', { missionId, sessionIds: [session.sessionId] });
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
    throw new MissionLeadershipError('split_brain', {
      sources: observation.durable ? ['durable', ...sources] : sources,
      sessionIds: [...sessionIds], paneIds: [...paneIds],
    });
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
    const parsedScope = normalizeLeadershipScope(scope);
    parseContract(idSchema, missionId, 'invalid_mission_id');
    const key = JSON.stringify([scopeKey(parsedScope), missionId]);
    if (this.#busy.has(key)) throw new MissionLeadershipError('busy', { missionId });
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
      ? null : parseContract(idSchema, mission.orchestratorSessionId, 'invalid_durable_session');
    const claims = ports.readClaims(missionId)
      .filter((claim) => includeRenderer || claim.source !== 'renderer')
      .map((claim) => parseContract(claimSchema, claim, 'invalid_claim'));
    const ids = new Set(claims.flatMap((c) => c.sessionId ? [c.sessionId] : []));
    if (durable) ids.add(durable);
    const sessions = new Map<string, LeadershipSession | null>();
    for (const id of ids) {
      parseContract(idSchema, id, 'invalid_session_id');
      const found = ports.readSession(id);
      if (found) {
        requireOwnedSession(found, scope, missionId);
        parseContract(idSchema, found.paneId, 'invalid_pane_id');
        if (found.sessionId !== id) throw new MissionLeadershipError('scope_mismatch', { reason: 'leadership_target_mismatch', sessionIds: [id] });
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
    if (live.length > 1) throw new MissionLeadershipError('split_brain', { missionId, sessionIds: live.map(([id]) => id) });
    const sessionId = observed.durable ?? live[0]?.[0];
    if (!sessionId) return null;
    const session = observed.sessions.get(sessionId);
    const panes = new Set(observed.claims
      .filter((c) => c.sessionId === sessionId && c.paneId !== null)
      .map((c) => c.paneId!));
    if (session) panes.add(session.paneId);
    if (panes.size > 1) throw new MissionLeadershipError('split_brain', { missionId, sessionIds: [sessionId], paneIds: [...panes] });
    return {
      sessionId,
      paneId: panes.values().next().value ?? null,
      source: observed.durable ? 'durable' : 'live',
      proven: Boolean(session && classifySessionLiveness(session.state) === 'live'),
      liveness: session ? classifySessionLiveness(session.state) : 'unregistered',
    };
  }

  /** Detects stale disagreements too; missing observations alone are not claims. */
  assertSingleLeader(scope: ProjectExecutionScope, missionId: string): void {
    const access = this.#access(scope, missionId);
    const observed = this.#observe(access.ports, access.scope, missionId);
    if (observed) assertAgreement(observed);
  }

  /** Idempotent teardown: a stale exit callback cannot revoke a successor. */
  releaseLeadership(
    scope: ProjectExecutionScope,
    missionId: string,
    input: ReleaseLeadershipInput,
  ): ReleasedLeadership {
    const release = Object.freeze(parseContract(releaseInputSchema, input, 'invalid_release_input'));
    const access = this.#access(scope, missionId);
    const { ports, key } = access;
    this.#busy.add(key);
    try {
      if (ports.readMission(missionId)?.orchestratorSessionId !== release.sessionId) {
        return { released: false };
      }
      const before = this.#observe(ports, access.scope, missionId, false);
      if (!before) return { released: false };
      // Do not revoke another source's leader under the guise of an old exit.
      assertAgreement(before);
      const runtime = ports.captureReleaseRuntime(missionId, release.sessionId);
      let released = false;
      let runtimeTouched = false;
      try {
        ports.transaction(() => {
          if (!ports.clearDurableLeaderIfMatches(missionId, release.sessionId)) return;
          if (!ports.releasePaneLeader(missionId, release.sessionId)) {
            throw new MissionLeadershipError('write_incomplete', { missionId, reason: 'release_panes' });
          }
          runtimeTouched = true;
          if (!ports.releaseRuntimeLeader(missionId, release.sessionId)) {
            throw new MissionLeadershipError('write_incomplete', { missionId, reason: 'release_runtime' });
          }
          const after = this.#observe(ports, access.scope, missionId, false);
          if (!after || after.durable !== null || after.claims.length > 0) {
            throw new MissionLeadershipError('write_incomplete', { missionId, reason: 'release_postcondition' });
          }
          released = true;
        });
      } catch (error) {
        if (runtimeTouched) {
          try {
            ports.restoreRuntime(missionId, runtime);
          } catch {
            throw new MissionLeadershipError('write_incomplete', { missionId, reason: 'leadership_rollback_failed' });
          }
        }
        throw error;
      }
      if (!released) return { released: false };
      const event: LeadershipRelease = Object.freeze({
        type: 'mission-leadership-released', scope: access.scope, missionId, ...release,
        paneIds: Object.freeze([...new Set([
          ...before.claims.map((claim) => claim.paneId),
          ...[...before.sessions.values()].map((session) => session?.paneId ?? null),
        ].filter((id): id is string => id !== null))]),
      });
      this.#busy.delete(key);
      try {
        ports.emitLeadershipReleased(event);
        return { released: true, event, rendererNotified: true };
      } catch (notificationError) {
        return { released: true, event, rendererNotified: false, notificationError };
      }
    } finally {
      this.#busy.delete(key);
    }
  }

  applyLeadership(
    scope: ProjectExecutionScope,
    missionId: string,
    input: LeadershipInput,
  ): AppliedLeadership {
    const leader = Object.freeze(parseContract(leadershipInputSchema, input, 'invalid_leadership_input'));
    if (leader.origin === 'takeover' &&
        this.deps.authorizeTakeover?.(normalizeLeadershipScope(scope), missionId, leader) !== true) {
      throw new MissionLeadershipError('scope_mismatch', { missionId, reason: 'takeover_requires_operator' });
    }
    const access = this.#access(scope, missionId);
    const { ports, key } = access;
    this.#busy.add(key);
    try {
      const before = this.#observe(ports, access.scope, missionId);
      if (!before) throw new MissionLeadershipError('mission_missing', { missionId });
      if (leader.origin === 'create' && (
        [...before.sessions.keys()].some((id) => id !== leader.sessionId) ||
        before.claims.some((claim) => claim.paneId !== null && claim.paneId !== leader.paneId)
      )) throw new MissionLeadershipError('existing_session', { missionId, reason: 'create_has_previous_leader' });
      const session = ports.readSession(leader.sessionId);
      if (!session || classifySessionLiveness(session.state) !== 'live') {
        throw new MissionLeadershipError('target_not_live', { missionId, sessionIds: [leader.sessionId] });
      }
      requireOwnedSession(session, access.scope, missionId);
      if (session.sessionId !== leader.sessionId || session.paneId !== leader.paneId) {
        throw new MissionLeadershipError('scope_mismatch', { reason: 'leadership_target_mismatch', missionId });
      }
      for (const [id, previous] of before.sessions) {
        if (id === leader.sessionId || !previous) continue;
        // Leadership accepts exited predecessors. Physical spawn/termination
        // proof remains the PTY fence's job; this engine never starts/kills PTYs.
        const liveness = classifySessionLiveness(previous.state);
        if (liveness !== 'exited' && !(leader.origin === 'takeover' && liveness === 'live')) {
          throw new MissionLeadershipError('existing_session', { missionId, sessionIds: [id, leader.sessionId] });
        }
      }
      const runtime = ports.captureRuntime(missionId, leader);
      let runtimeTouched = false;
      try {
        ports.transaction(() => {
          if (!ports.setDurableLeader(missionId, leader) ||
              !ports.replacePaneLeader(missionId, leader)) {
            throw new MissionLeadershipError('write_incomplete', { reason: 'leadership_write_refused', missionId });
          }
          runtimeTouched = true;
          if (!ports.replaceRuntimeLeader(missionId, leader)) {
            throw new MissionLeadershipError('write_incomplete', { reason: 'leadership_write_refused', missionId });
          }
          // F is asynchronous; it must not veto a committed Main authority.
          const after = this.#observe(ports, access.scope, missionId, false);
          if (!after || after.durable !== leader.sessionId ||
              !['mission-panes', 'gate'].every((source) => after.claims.some((c) =>
                c.source === source && c.sessionId === leader.sessionId &&
                c.paneId === leader.paneId))) {
            throw new MissionLeadershipError('write_incomplete', { missionId });
          }
          assertAgreement(after);
          const current = after.sessions.get(leader.sessionId);
          if (!current || classifySessionLiveness(current.state) !== 'live') {
            throw new MissionLeadershipError('target_not_live', { missionId, sessionIds: [leader.sessionId] });
          }
        });
      } catch (error) {
        if (runtimeTouched) {
          try {
            ports.restoreRuntime(missionId, runtime);
          } catch {
            throw new MissionLeadershipError('write_incomplete', { reason: 'leadership_rollback_failed', missionId });
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
        // The target was required live to be applied; resolve reports the same.
        liveness: 'live',
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
