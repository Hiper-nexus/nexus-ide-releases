import {
  authReadyModelsForProvider,
  isCredentiallessOpenCodeModel,
} from "../adapters/model-auth-readiness";
import { supportsReadOnlyParticipationCli } from "../../shared/mission-advisory";

/**
 * Main-owned squad readiness policy.
 *
 * A discovered binary is not enough for autonomous work: the provider must
 * also be enabled, authenticated and backed by an account that can be used
 * now. Keep this pure so squad construction, reuse and focused tests consume
 * the same decision without importing renderer state.
 */

export interface SquadRuntimeProviderSnapshot {
  readonly adapterId: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  /**
   * The adapter must exist in the main-owned registry at this exact boundary.
   * Provider rows alone are persisted configuration, not spawn authority.
   */
  readonly adapterLoaded: boolean;
  /**
   * True only when this adapter has a Nexus MCP/OMP path able to return the
   * physical handoff receipts required by the guided scheduler.
   */
  readonly guidedHandoffCapable: boolean;
  /**
   * True only for a trusted builtin whose native process sandbox has passed
   * the Nexus workspace-write qualification. A Git worktree alone is not a
   * filesystem boundary.
   */
  readonly autonomousWorkspaceWriteCapable?: boolean;
  readonly authStrategy: string;
  readonly defaultModel?: string;
  readonly models?: readonly string[];
  readonly authReadyModels?: readonly string[];
}

export interface SquadRuntimeCliPolicy {
  readonly routableCliIds: ReadonlySet<string>;
  /** Routable AND able to return a physical Nexus MCP/OMP handoff receipt. */
  readonly handoffCapableCliIds: ReadonlySet<string>;
  readonly routableWorkerCliIds: ReadonlySet<string>;
  readonly credentiallessOnlyCliIds: ReadonlySet<string>;
  readonly credentiallessDefaultModelByCliId: Readonly<Record<string, string>>;
  /** Exact auth-ready catalog for multi-provider CLIs such as OMP. */
  readonly authReadyModelsByCliId: Readonly<
    Record<string, readonly string[]>
  >;
  /** Default used when a saved agent omits its model. */
  readonly authReadyDefaultModelByCliId: Readonly<Record<string, string>>;
}

export interface SquadRuntimeAgentLike {
  readonly category?: unknown;
  readonly cli?: unknown;
  readonly model?: unknown;
}

/**
 * Current-release id backstop for unattended mission workers under the
 * `governed` squad CLI policy.
 *
 * Capability metadata remains necessary, but it is not sufficient on its own:
 * the physical task planner/dispatcher only implements provider-native
 * confined read/write for the builtin Codex path. Under `operator-choice`
 * (see orch.squadCliPolicy) any handoff-capable CLI may write — confined by
 * the Nexus kernel Seatbelt instead of a brand allowlist. Manual panes and
 * direct routing remain available either way.
 */
const RELEASE_QUALIFIED_MISSION_WORKER_CLIS = new Set(["codex"]);

export function isReleaseQualifiedMissionWorkerCli(
  adapterId: string,
): boolean {
  return RELEASE_QUALIFIED_MISSION_WORKER_CLIS.has(adapterId);
}

/**
 * Whether a CLI may act as an autonomous mission writer right now.
 * `operatorChoice` opens the lane to any non-empty adapter id; the physical
 * spawn path still fails closed without a constructible Seatbelt boundary.
 */
export function isMissionWorkerWriteEligibleCli(
  adapterId: string,
  operatorChoice = false,
): boolean {
  if (operatorChoice) return adapterId.trim().length > 0;
  return isReleaseQualifiedMissionWorkerCli(adapterId);
}

export type StandardSquadReadiness =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code:
        | "maestro-count"
        | "maestro-unavailable"
        | "maestro-unverified"
        | "claude-worker"
        | "executor-unavailable"
        | "reviewer-unavailable"
        | "worker-unavailable";
      detail: string;
    }>;

export function squadRuntimeCliPolicyFromRoutableIds(
  routableIds: ReadonlySet<string>,
): SquadRuntimeCliPolicy {
  const routableCliIds = new Set(routableIds);
  return Object.freeze({
    routableCliIds,
    // Compatibility helper for pure callers/tests that already supply a
    // pre-vetted route set. Production inventory must use
    // buildSquadRuntimeCliPolicy with explicit adapter capabilities.
    handoffCapableCliIds: new Set(routableCliIds),
    routableWorkerCliIds: new Set(
      [...routableCliIds].filter((adapterId) => adapterId !== "claude"),
    ),
    credentiallessOnlyCliIds: new Set<string>(),
    credentiallessDefaultModelByCliId: Object.freeze({}),
    authReadyModelsByCliId: Object.freeze({}),
    authReadyDefaultModelByCliId: Object.freeze({}),
  });
}

export function isSquadRuntimeAgentRoutable(
  agent: SquadRuntimeAgentLike,
  policy: SquadRuntimeCliPolicy,
  worker = false,
): boolean {
  if (typeof agent.cli !== "string") return false;
  const routableIds = worker
    ? policy.routableWorkerCliIds
    : policy.routableCliIds;
  if (!routableIds.has(agent.cli)) return false;
  const scopedModels = policy.authReadyModelsByCliId[agent.cli];
  if (scopedModels) {
    const selected =
      typeof agent.model === "string" && agent.model.trim().length > 0
        ? agent.model.trim()
        : policy.authReadyDefaultModelByCliId[agent.cli];
    if (!selected || !scopedModels.includes(selected)) return false;
  }
  if (!policy.credentiallessOnlyCliIds.has(agent.cli)) return true;
  const credentiallessDefault =
    policy.credentiallessDefaultModelByCliId[agent.cli];
  const selectedModel =
    agent.model === undefined ||
    agent.model === null ||
    agent.model === ""
      ? (credentiallessDefault ?? null)
      : typeof agent.model === "string"
        ? agent.model
        : null;
  return isCredentiallessOpenCodeModel(agent.cli, selectedModel);
}

/** Catalog projected to what this exact runtime auth state may execute. */
export function squadRuntimeModelsForCli(
  policy: SquadRuntimeCliPolicy,
  adapterId: string,
  models: readonly string[],
): readonly string[] {
  const scopedModels = policy.authReadyModelsByCliId[adapterId];
  if (scopedModels) {
    const ready = new Set(scopedModels);
    return Object.freeze(models.filter((model) => ready.has(model)));
  }
  if (!policy.credentiallessOnlyCliIds.has(adapterId)) return models;
  return authReadyModelsForProvider(
    { adapterId, authStrategy: "login-needed" },
    models,
  );
}

/**
 * Build the exact route inventory used for autonomous squad construction.
 * Claude can coordinate, but its OAuth session remains globally reserved and
 * therefore never enters the worker subset.
 */
export function buildSquadRuntimeCliPolicy(
  providers: readonly SquadRuntimeProviderSnapshot[],
  hasAvailableAccount: (adapterId: string) => boolean,
  /**
   * When true, any handoff-capable non-Claude CLI may be a mission worker.
   * Default false keeps the release-qualified Codex writer lane.
   */
  operatorChoice = false,
): SquadRuntimeCliPolicy {
  const routableCliIds = new Set<string>();
  const credentiallessOnlyCliIds = new Set<string>();
  const credentiallessDefaultModelByCliId: Record<string, string> = {};
  const authReadyModelsByCliId: Record<string, readonly string[]> = {};
  const authReadyDefaultModelByCliId: Record<string, string> = {};
  for (const provider of providers) {
    if (
      provider.adapterId === "shell" ||
      // `omp-rpc` is the presentation twin of the canonical `omp` worker.
      // Keeping both would schedule the same broker twice under two ids.
      provider.adapterId === "omp-rpc" ||
      !provider.enabled ||
      !provider.installed ||
      !provider.adapterLoaded
    ) {
      continue;
    }
    const candidateModels = [
      ...(provider.models ?? []),
      ...(provider.defaultModel ? [provider.defaultModel] : []),
    ];
    const authReadyModels = authReadyModelsForProvider(
      provider,
      candidateModels,
    );
    const credentiallessModels = candidateModels.filter((model) =>
      isCredentiallessOpenCodeModel(provider.adapterId, model),
    );
    const modelAuthReady = authReadyModels.length > 0;
    if (!modelAuthReady) {
      continue;
    }
    const accountAvailable = hasAvailableAccount(provider.adapterId);
    if (!accountAvailable && credentiallessModels.length === 0) {
      continue;
    }
    routableCliIds.add(provider.adapterId);
    if (
      provider.adapterId === "omp" ||
      provider.adapterId === "omp-rpc"
    ) {
      authReadyModelsByCliId[provider.adapterId] =
        Object.freeze([...authReadyModels]);
      if (
        provider.defaultModel &&
        authReadyModels.includes(provider.defaultModel)
      ) {
        authReadyDefaultModelByCliId[provider.adapterId] =
          provider.defaultModel;
      }
    }
    if (
      provider.adapterId === "opencode" &&
      (provider.authStrategy === "login-needed" || !accountAvailable)
    ) {
      credentiallessOnlyCliIds.add(provider.adapterId);
      if (
        provider.defaultModel &&
        isCredentiallessOpenCodeModel(
          provider.adapterId,
          provider.defaultModel,
        )
      ) {
        credentiallessDefaultModelByCliId[provider.adapterId] =
          provider.defaultModel;
      }
    }
  }
  return Object.freeze({
    routableCliIds,
    // A mission participant of ANY tier must be able to return a physical
    // Nexus MCP/OMP handoff receipt; without that route it can talk but never
    // prove it did anything, so it is not a participant at all. Advisors need
    // exactly this and nothing more — no autonomous write.
    handoffCapableCliIds: new Set(
      [...routableCliIds].filter(
        (adapterId) =>
          providers.find((candidate) => candidate.adapterId === adapterId)
            ?.guidedHandoffCapable === true,
      ),
    ),
    routableWorkerCliIds: new Set(
      [...routableCliIds].filter((adapterId) => {
        const provider = providers.find(
          (candidate) => candidate.adapterId === adapterId,
        );
        if (!provider?.guidedHandoffCapable) return false;
        if (operatorChoice) {
          return (
            adapterId !== "claude" &&
            adapterId !== "shell" &&
            adapterId !== "omp-rpc"
          );
        }
        // Governed: Codex-class writers only (release-qualified + write capable).
        if (!isReleaseQualifiedMissionWorkerCli(adapterId)) return false;
        return provider.autonomousWorkspaceWriteCapable === true;
      }),
    ),
    credentiallessOnlyCliIds,
    credentiallessDefaultModelByCliId: Object.freeze({
      ...credentiallessDefaultModelByCliId,
    }),
    authReadyModelsByCliId: Object.freeze({
      ...authReadyModelsByCliId,
    }),
    authReadyDefaultModelByCliId: Object.freeze({
      ...authReadyDefaultModelByCliId,
    }),
  });
}

/**
 * The only roster categories that can hold a read_only lane. Executor and
 * architect are excluded on purpose: both write to the workspace, so they
 * always owe the autonomous write confinement demanded of a mission worker.
 */
const READ_ONLY_PARTICIPATION_CATEGORIES: ReadonlySet<unknown> = new Set([
  "reviewer",
  "scout",
]);

/**
 * Advisory participation lane: a reviewer/scout on a CLI that can hold a
 * read_only lane joins the mission through the Nexus MCP read-only authority
 * (or its own mechanical confinement) and therefore never needs autonomous
 * workspace write. It still must be routable as an adapter — advisory is a
 * narrower authority, not an exemption from having an active route.
 */
function isReadOnlyParticipant(
  agent: SquadRuntimeAgentLike,
  policy: SquadRuntimeCliPolicy,
): boolean {
  return (
    READ_ONLY_PARTICIPATION_CATEGORIES.has(agent.category) &&
    typeof agent.cli === "string" &&
    supportsReadOnlyParticipationCli(agent.cli) &&
    // No physical handoff route means it can never prove participation.
    policy.handoffCapableCliIds.has(agent.cli) &&
    isSquadRuntimeAgentRoutable(agent, policy)
  );
}

/**
 * Standard beginner delivery requires one explicit verified Maestro plus
 * independently addressable executor and reviewer identities. Executor and
 * reviewer may share a non-Claude CLI; their distinct roster identities are
 * what the sealed task plan binds.
 */
export function assessStandardSquadReadiness(
  agents: readonly SquadRuntimeAgentLike[],
  policy: SquadRuntimeCliPolicy,
  verifiedOrchestratorCliIds: ReadonlySet<string>,
  /**
   * When true (`orch.squadCliPolicy === 'operator-choice'`), any routable
   * Maestro is enough — the release-qualified verified-Maestro gate is skipped.
   */
  operatorChoice = false,
): StandardSquadReadiness {
  const orchestrators = agents.filter(
    (agent) => agent.category === "orchestrator",
  );
  if (orchestrators.length !== 1) {
    return Object.freeze({
      ok: false,
      code: "maestro-count",
      detail: "o squad precisa de exatamente um Maestro explícito",
    });
  }

  const orchestratorCli = orchestrators[0]?.cli;
  if (
    typeof orchestratorCli !== "string" ||
    !isSquadRuntimeAgentRoutable(orchestrators[0]!, policy)
  ) {
    return Object.freeze({
      ok: false,
      code: "maestro-unavailable",
      detail: "o Maestro aprovado não possui rota ativa",
    });
  }
  if (
    !operatorChoice &&
    !verifiedOrchestratorCliIds.has(orchestratorCli)
  ) {
    return Object.freeze({
      ok: false,
      code: "maestro-unverified",
      detail: "o Maestro aprovado não possui orquestração verificada",
    });
  }

  // reserveClaude keeps exactly one Claude OAuth session per mission. A Claude
  // advisor confined to a read-only lane is admissible when the Maestro is NOT
  // Claude — the sealed task plan already applies that same rule (see
  // mission-task-plan-authority).
  const claudeNonOrchestrators = agents.filter(
    (agent) => agent.category !== "orchestrator" && agent.cli === "claude",
  );
  if (
    claudeNonOrchestrators.length > 0 &&
    (orchestratorCli === "claude" ||
      claudeNonOrchestrators.some(
        (agent) => !READ_ONLY_PARTICIPATION_CATEGORIES.has(agent.category),
      ))
  ) {
    return Object.freeze({
      ok: false,
      code: "claude-worker",
      detail: "Claude permanece reservado ao Maestro e não pode ser worker",
    });
  }

  const hasExecutor = agents.some(
    (agent) =>
      agent.category === "executor" &&
      isSquadRuntimeAgentRoutable(agent, policy, true),
  );
  if (!hasExecutor) {
    return Object.freeze({
      ok: false,
      code: "executor-unavailable",
      detail: "o squad precisa de um executor não-Claude com rota ativa",
    });
  }

  const hasReviewer = agents.some(
    (agent) =>
      agent.category === "reviewer" &&
      isSquadRuntimeAgentRoutable(agent, policy, true),
  );
  if (!hasReviewer) {
    return Object.freeze({
      ok: false,
      code: "reviewer-unavailable",
      detail: "o squad precisa de um QA/reviewer não-Claude com rota ativa",
    });
  }

  const unroutableWorker = agents.find(
    (agent) =>
      agent.category !== "orchestrator" &&
      !isReadOnlyParticipant(agent, policy) &&
      !isSquadRuntimeAgentRoutable(agent, policy, true),
  );
  if (unroutableWorker) {
    const cli =
      typeof unroutableWorker.cli === "string"
        ? unroutableWorker.cli
        : "não identificada";
    return Object.freeze({
      ok: false,
      code: "worker-unavailable",
      detail:
        `o worker em ${cli} não possui adapter ativo com handoff físico e ` +
        "confinamento autônomo qualificado pelo Nexus",
    });
  }

  return Object.freeze({ ok: true });
}
