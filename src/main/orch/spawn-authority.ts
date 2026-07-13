import type { MissionPaneSpec, Squad } from "../../shared/orch-types";
import type { ProjectExecutionScope } from "../../shared/types";
import type { PendingSpawnMeta } from "./pane-registry";
import { resolveCwdForScope } from "./workspace-path";

export type SpawnAuthority = Omit<PendingSpawnMeta, "scope"> & {
  scope?: PendingSpawnMeta["scope"];
  squadId?: string;
};

export type SpawnAuthoritySource =
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
  squads: readonly Squad[];
  persistedPane: MissionPaneSpec | null;
  /** Scope resolved from main-owned workspace state after an explicit user open. */
  trustedUserScope: Readonly<ProjectExecutionScope> | null;
  requestedCwd?: string;
}

function legacySquadAuthority(
  requestId: string,
  squads: readonly Squad[],
): SpawnAuthority | null {
  const matches = squads
    .filter((squad) => {
      const prefix = `squad-${squad.id}-`;
      return (
        requestId.startsWith(prefix) &&
        /^[a-z0-9]+$/i.test(requestId.slice(prefix.length))
      );
    })
    .sort((left, right) => right.id.length - left.id.length);
  if (matches.length !== 1) return null;

  const squad = matches[0];
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
  };
}

/** Mantém apenas ids legados que o main consegue ligar a um squad real. */
export function isKnownLegacySquadSpawnRequest(
  requestId: string,
  squads: readonly Squad[],
): boolean {
  return legacySquadAuthority(requestId, squads) !== null;
}

/**
 * Resolve only main-side spawn authority. A renderer may carry an opaque
 * request id, but it never gets to invent a role or allowlist. Legacy squad
 * launches are reconstructed from the trusted squad registry; every other
 * missing/expired orchestration request fails closed.
 */
export function resolveSpawnAuthority(
  requestId: string | undefined,
  pending: PendingSpawnMeta | null,
  squads: readonly Squad[],
  persistedPane: MissionPaneSpec | null = null,
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
      scope: persistedPane.scope,
      executionScope: persistedPane.executionScope,
    };
  }
  if (!requestId) return null;
  const legacy = legacySquadAuthority(requestId, squads);
  if (legacy) return legacy;
  throw new Error(
    `unknown or expired orchestration spawn request: ${requestId}`,
  );
}

/**
 * Bind role/capabilities and filesystem scope into one immutable spawn proof.
 * Pending orchestration and persisted mission panes must carry their original
 * scope. Only direct user and legacy initial-squad launches may inherit the
 * main-owned active workspace scope.
 */
export function bindSpawnAuthority(
  input: BindSpawnAuthorityInput,
): BoundSpawnAuthority {
  if (input.pending && !input.requestId) {
    throw new Error("pending spawn is missing its orchestration request id");
  }
  if (input.pending && !input.pending.scope) {
    throw new Error("pending spawn is missing its trusted project scope");
  }
  if (input.persistedPane && !input.requestId && !input.persistedPane.scope) {
    throw new Error("persisted pane is missing its trusted project scope");
  }

  const context = resolveSpawnAuthority(
    input.requestId,
    input.pending,
    input.squads,
    input.persistedPane,
  );
  const source: SpawnAuthoritySource = input.pending
    ? "pending"
    : input.persistedPane
      ? "persisted-pane"
      : input.requestId
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
      : input.requestedCwd;
  const cwd = resolveCwdForScope(scope, trustedCwd);

  return Object.freeze({ source, context, scope, coordinationScope, cwd });
}
