import { randomBytes } from "node:crypto";
import type { WebContents } from "electron";
import type {
  MissionPaneAuthoritySeal,
  MissionPaneSpec,
  Squad,
} from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import type { PendingSpawnMeta } from "./pane-registry";
import { snapshotSquadAuthority } from "./squad-authority-snapshot";
import { resolveCwdForScope } from "./workspace-path";

export type SpawnAuthority = Omit<PendingSpawnMeta, "scope"> & {
  scope?: PendingSpawnMeta["scope"];
  squadId?: string;
  authoritySeal?: MissionPaneAuthoritySeal;
  immediateMissionTitle?: string;
  immediateMissionGoal?: string;
};

export type SpawnAuthoritySource =
  // Historical internal label retained for session/promotion compatibility;
  // it is now reachable only through an opaque immediate-squad grant.
  "pending" | "persisted-pane" | "legacy-squad" | "direct-user";

/**
 * Main-process proof carried from the IPC trust boundary to the PTY and MCP
 * layers. `cwd` is canonical and already checked against `scope`; renderer
 * input is never accepted as project identity.
 */
export interface BoundSpawnAuthority {
  readonly source: SpawnAuthoritySource;
  readonly context: SpawnAuthority | null;
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly coordinationScope?: Readonly<ProjectExecutionScope>;
  readonly cwd: string;
}

export interface BindSpawnAuthorityInput {
  requestId: string | undefined;
  pending: PendingSpawnMeta | null;
  /** One-shot proof minted and consumed inside the main process. */
  immediateGrant?: SpawnAuthority | null;
  squads: readonly Squad[];
  persistedPane: MissionPaneSpec | null;
  /** Scope resolved from main-owned workspace state after an explicit user open. */
  trustedUserScope: Readonly<ProjectExecutionScope> | null;
  requestedCwd?: string;
}

function immediateSquadAuthority(
  squad: Squad,
  scope?: Readonly<ProjectExecutionScope>,
): SpawnAuthority | null {
  const agent =
    squad.agents.find((candidate) => candidate.category === "orchestrator") ??
    squad.agents[0];
  if (!agent) return null;
  return {
    squadId: squad.id,
    agentName: agent.agentName,
    allowedTools: agent.allowedTools ?? null,
    allowedSkills: agent.allowedSkills ?? null,
    role: "orchestrator",
    ...(scope
      ? {
          scope: Object.freeze({ ...scope }),
          // Immediate launch starts at the canonical workspace root captured
          // by main. Renderer cwd bytes cannot narrow or redirect this grant.
          requestedCwd: scope.rootRealPath,
        }
      : {}),
  };
}

const IMMEDIATE_SQUAD_GRANT_TTL_MS = 30_000;
const MAX_IMMEDIATE_SQUAD_GRANT_TTL_MS = 120_000;

interface ImmediateSquadSpawnGrant {
  readonly owner: WebContents;
  readonly scopeKey: string;
  readonly squadId: string;
  readonly squadAuthorityHash: string;
  readonly authority: SpawnAuthority;
  readonly runtime: ImmediateSquadSpawnRuntime;
  readonly runtimeKey: string;
  readonly expiresAt: number;
}

const immediateSquadSpawnGrants = new Map<
  string,
  ImmediateSquadSpawnGrant
>();

function scopeKey(scope: Readonly<ProjectExecutionScope>): string {
  return JSON.stringify([
    scope.version,
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
    scope.identitySource,
  ]);
}

function authorityKey(authority: SpawnAuthority): string {
  return JSON.stringify([
    authority.squadId,
    authority.agentName,
    authority.role,
    authority.allowedTools,
    authority.allowedSkills,
    authority.requestedCwd,
  ]);
}

/**
 * Exact process and pane identity reviewed by native main UI before an
 * immediate squad launch. Optional provider fields are normalized to null so
 * `undefined` cannot create a second spelling of the same authority.
 */
export interface ImmediateSquadSpawnRuntime {
  readonly adapterId: string;
  readonly model: string | null;
  readonly accountId: string | null;
  readonly effort: string | null;
  readonly paneId: string;
  readonly title: string;
  readonly missionTitle: string;
  readonly missionGoal: string;
  readonly missionId: string | null;
}

export type ImmediateSquadSpawnRuntimeInput = Omit<
  ImmediateSquadSpawnRuntime,
  "model" | "accountId" | "effort" | "missionId"
> & {
  readonly model?: string | null;
  readonly accountId?: string | null;
  readonly effort?: string | null;
  readonly missionId?: string | null;
};

function canonicalImmediateRuntime(
  runtime: ImmediateSquadSpawnRuntimeInput,
): ImmediateSquadSpawnRuntime {
  const adapterId = runtime.adapterId.trim();
  const paneId = runtime.paneId.trim();
  const title = runtime.title.trim();
  const missionTitle = runtime.missionTitle.trim();
  const missionGoal = runtime.missionGoal.trim();
  if (!adapterId || !paneId || !title || !missionTitle || !missionGoal) {
    throw new Error("immediate squad spawn runtime is incomplete");
  }
  return Object.freeze({
    adapterId,
    model: runtime.model?.trim() || null,
    accountId: runtime.accountId?.trim() || null,
    effort: runtime.effort?.trim() || null,
    paneId,
    title,
    missionTitle,
    missionGoal,
    missionId: runtime.missionId?.trim() || null,
  });
}

export type ImmediateSquadSpawnRuntimeRequest = Omit<
  ImmediateSquadSpawnRuntimeInput,
  "title" | "missionTitle" | "missionGoal"
>;

function immediateRuntimeKey(runtime: ImmediateSquadSpawnRuntime): string {
  return JSON.stringify([
    runtime.adapterId,
    runtime.model,
    runtime.accountId,
    runtime.effort,
    runtime.paneId,
    runtime.title,
    runtime.missionTitle,
    runtime.missionGoal,
    runtime.missionId,
  ]);
}

function pruneImmediateSquadSpawnGrants(now: number): void {
  for (const [token, grant] of immediateSquadSpawnGrants) {
    if (grant.expiresAt <= now || grant.owner.isDestroyed()) {
      immediateSquadSpawnGrants.delete(token);
    }
  }
}

export interface IssueImmediateSquadSpawnGrantInput {
  /** Exact renderer selected by trusted main policy. */
  owner: WebContents;
  /** Live, canonical scope captured by main at grant time. */
  scope: Readonly<ProjectExecutionScope>;
  /** Exact saved/builtin squad resolved in main, never renderer metadata. */
  squad: Squad;
  /** Exact adapter/provider/pane material displayed by native confirmation. */
  runtime: ImmediateSquadSpawnRuntimeInput;
  now?: number;
  ttlMs?: number;
}

/**
 * Mint a short-lived, unguessable, one-shot grant for the two intentional
 * immediate-launch policies (Pet Studio and intentFirst=false). Policy decides
 * whether to call this API; this registry only binds and transports authority.
 *
 * SECURITY: this is a main-internal post-confirmation primitive, never an IPC
 * handler. Its caller must show a native, deny-by-default confirmation built
 * from the same canonical `scope`/`squad`, then revalidate renderer scope and
 * the saved roster before calling. Token consumption repeats both fences.
 */
export function issueImmediateSquadSpawnGrant(
  input: IssueImmediateSquadSpawnGrantInput,
): string {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? IMMEDIATE_SQUAD_GRANT_TTL_MS;
  if (
    !Number.isFinite(now) ||
    !Number.isInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > MAX_IMMEDIATE_SQUAD_GRANT_TTL_MS
  ) {
    throw new Error("invalid immediate squad spawn grant lifetime");
  }
  if (input.owner.isDestroyed()) {
    throw new Error("cannot grant a destroyed renderer");
  }
  const authority = immediateSquadAuthority(input.squad, input.scope);
  if (!authority) {
    throw new Error("cannot grant a squad without an orchestrator");
  }
  const runtime = canonicalImmediateRuntime(input.runtime);
  const squadSnapshot = snapshotSquadAuthority(input.squad);
  const orchestrator =
    input.squad.agents.find(
      (candidate) => candidate.category === "orchestrator",
    ) ?? input.squad.agents[0];
  if (
    !orchestrator ||
    runtime.adapterId !== orchestrator.cli ||
    runtime.title !== orchestrator.agentName
  ) {
    throw new Error(
      "immediate squad spawn runtime does not match the canonical orchestrator",
    );
  }

  pruneImmediateSquadSpawnGrants(now);
  // One live immediate grant per renderer bounds memory and invalidates an
  // abandoned click before a later launch can be confused with it.
  for (const [token, grant] of immediateSquadSpawnGrants) {
    if (grant.owner === input.owner) immediateSquadSpawnGrants.delete(token);
  }

  let token: string;
  do {
    token = `squadgrant_${randomBytes(32).toString("base64url")}`;
  } while (immediateSquadSpawnGrants.has(token));
  immediateSquadSpawnGrants.set(token, {
    owner: input.owner,
    scopeKey: scopeKey(input.scope),
    squadId: input.squad.id,
    squadAuthorityHash: squadSnapshot.hash,
    authority: Object.freeze({
      ...authority,
      immediateMissionTitle: runtime.missionTitle,
      immediateMissionGoal: runtime.missionGoal,
      allowedTools:
        authority.allowedTools === null || authority.allowedTools === undefined
          ? authority.allowedTools
          : Object.freeze([...authority.allowedTools]),
      allowedSkills:
        authority.allowedSkills === null ||
        authority.allowedSkills === undefined
          ? authority.allowedSkills
          : Object.freeze([...authority.allowedSkills]),
    }) as SpawnAuthority,
    runtime,
    runtimeKey: immediateRuntimeKey(runtime),
    expiresAt: now + ttlMs,
  });
  return token;
}

export interface ConsumeImmediateSquadSpawnGrantInput {
  requestId: string;
  owner: WebContents;
  /** Current live scope; an intervening workspace switch burns the token. */
  scope: Readonly<ProjectExecutionScope>;
  /** Current main registry, used to reject deletion or roster mutation. */
  squads: readonly Squad[];
  /**
   * Current request material at the IPC boundary. Consumption compares this
   * before adapter/provider preparation; any drift burns the one-shot grant.
   */
  runtime: ImmediateSquadSpawnRuntimeRequest;
  now?: number;
}

export interface ConsumedImmediateSquadSpawnGrant {
  readonly authority: SpawnAuthority;
  readonly runtime: ImmediateSquadSpawnRuntime;
}

/**
 * Consume before any provider process is prepared. Lookup deletion happens
 * first so attacker, scope, squad, or expiry mismatch cannot be retried.
 */
export function consumeImmediateSquadSpawnGrant(
  input: ConsumeImmediateSquadSpawnGrantInput,
): ConsumedImmediateSquadSpawnGrant | null {
  const grant = immediateSquadSpawnGrants.get(input.requestId);
  if (!grant) return null;
  immediateSquadSpawnGrants.delete(input.requestId);

  const now = input.now ?? Date.now();
  if (
    !Number.isFinite(now) ||
    grant.owner !== input.owner ||
    input.owner.isDestroyed() ||
    grant.expiresAt <= now ||
    grant.scopeKey !== scopeKey(input.scope)
  ) {
    return null;
  }
  const matches = input.squads.filter(
    (candidate) => candidate.id === grant.squadId,
  );
  if (matches.length !== 1) return null;
  const currentAuthority = immediateSquadAuthority(matches[0], input.scope);
  const currentOrchestrator =
    matches[0].agents.find(
      (candidate) => candidate.category === "orchestrator",
    ) ?? matches[0].agents[0];
  let runtime: ImmediateSquadSpawnRuntime;
  try {
    runtime = canonicalImmediateRuntime({
      ...input.runtime,
      title: currentOrchestrator?.agentName ?? "",
      missionTitle: grant.runtime.missionTitle,
      missionGoal: grant.runtime.missionGoal,
    });
  } catch {
    return null;
  }
  if (
    !currentAuthority ||
    authorityKey(currentAuthority) !== authorityKey(grant.authority) ||
    snapshotSquadAuthority(matches[0]).hash !== grant.squadAuthorityHash ||
    immediateRuntimeKey(runtime) !== grant.runtimeKey
  ) {
    return null;
  }
  return Object.freeze({
    authority: grant.authority,
    runtime: grant.runtime,
  });
}

/**
 * Resolve only main-side spawn authority. A renderer may carry an opaque
 * request id, but it never gets to invent a role or allowlist. Immediate
 * squad launches require a separately consumed main-owned grant; every
 * missing/expired orchestration request fails closed.
 */
export function resolveSpawnAuthority(
  requestId: string | undefined,
  pending: PendingSpawnMeta | null,
  _squads: readonly Squad[],
  persistedPane: MissionPaneSpec | null = null,
  immediateGrant: SpawnAuthority | null = null,
): SpawnAuthority | null {
  if (pending) return pending;
  // Resume may still carry the pane's historical orchRequestId. The persisted
  // main-owned pane record is stronger authority and, crucially, carries the
  // original project scope. Treating the old id as a fresh legacy squad spawn
  // discarded that scope and made safe resume fail closed.
  if (persistedPane) {
    return {
      missionId: persistedPane.missionId,
      agentName: persistedPane.agentName,
      workerIncarnationId: persistedPane.workerIncarnationId,
      role: persistedPane.role,
      allowedTools:
        persistedPane.allowedTools !== undefined
          ? persistedPane.allowedTools === null
            ? null
            : [...persistedPane.allowedTools]
          : persistedPane.role === "worker"
            ? []
            : null,
      allowedSkills:
        persistedPane.allowedSkills !== undefined
          ? persistedPane.allowedSkills === null
            ? null
            : [...persistedPane.allowedSkills]
          : null,
      ...(persistedPane.readOnly === true ? { readOnly: true } : {}),
      ...(persistedPane.authoritySeal
        ? { contextRevision: persistedPane.authoritySeal.contextRevision }
        : {}),
      ...(persistedPane.authoritySeal
        ? { authoritySeal: { ...persistedPane.authoritySeal } }
        : {}),
      scope: persistedPane.scope,
      executionScope: persistedPane.executionScope,
    };
  }
  if (immediateGrant) return immediateGrant;
  if (!requestId) return null;
  throw new Error(
    `unknown or expired orchestration spawn grant: ${requestId}`,
  );
}

/**
 * Bind role/capabilities and filesystem scope into one immutable spawn proof.
 * Pending orchestration and persisted mission panes must carry their original
 * scope. Immediate squad grants also carry their captured scope; only a
 * direct-user spawn may inherit the main-owned active workspace scope.
 */
export function bindSpawnAuthority(
  input: BindSpawnAuthorityInput,
): BoundSpawnAuthority {
  if (input.pending && input.immediateGrant) {
    throw new Error("spawn request has ambiguous main-owned authority");
  }
  if (input.pending && !input.requestId) {
    throw new Error("pending spawn is missing its orchestration request id");
  }
  if (input.pending && !input.pending.scope) {
    throw new Error("pending spawn is missing its trusted project scope");
  }
  if (input.persistedPane && !input.requestId && !input.persistedPane.scope) {
    throw new Error("persisted pane is missing its trusted project scope");
  }
  if (input.immediateGrant && !input.requestId) {
    throw new Error("immediate spawn grant is missing its opaque request id");
  }
  if (input.immediateGrant && !input.immediateGrant.scope) {
    throw new Error("immediate spawn grant is missing its trusted project scope");
  }

  const context = resolveSpawnAuthority(
    input.requestId,
    input.pending,
    input.squads,
    input.persistedPane,
    input.immediateGrant,
  );
  const source: SpawnAuthoritySource = input.pending
    ? "pending"
    : input.persistedPane
      ? "persisted-pane"
      : input.immediateGrant
        ? "legacy-squad"
        : "direct-user";
  const coordinationScope = context?.scope ?? input.trustedUserScope;
  if (!coordinationScope) {
    throw new Error("cli-agent spawn requires an authorized project scope");
  }
  const scope = context?.executionScope ?? coordinationScope;
  if (
    scope.installationId !== coordinationScope.installationId ||
    scope.projectId !== coordinationScope.projectId ||
    scope.checkoutId !== coordinationScope.checkoutId
  ) {
    throw new Error("execution scope differs from mission coordination scope");
  }
  const trustedCwd = input.pending
    ? input.pending.requestedCwd
    : input.persistedPane
      ? input.persistedPane.cwd
      : input.immediateGrant
        ? input.immediateGrant.requestedCwd
        : input.requestedCwd;
  const cwd = resolveCwdForScope(scope, trustedCwd);

  return Object.freeze({ source, context, scope, coordinationScope, cwd });
}
