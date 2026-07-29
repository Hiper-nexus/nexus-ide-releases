import type { AdapterInfo } from "../../shared/types";
import type { SquadAgent } from "../../shared/orch-types";
import { defaultSquadModelForAdapter } from "../../shared/squad-model-defaults";
import type { SquadCliPolicy } from "../../shared/settings-types";
import { isOperatorChoicePolicy } from "../../shared/squad-cli-policy";

const LEGACY_ORCHESTRATOR_CLI = "claude";

const WORKER_CLI_ORDER = [
  "codex",
  "agy",
  "grok",
  "kimi",
  "opencode",
  "aider",
  "glm",
  "longcat",
];

type RosterAdapter = Pick<
  AdapterInfo,
  | "id"
  | "installed"
  | "autonomousWorkspaceWriteCapable"
  | "taskHandoffCapable"
> & {
  enabled?: boolean;
  capabilities?: {
    readonly autonomousReadOnly?: boolean;
  };
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function workerCliRank(id: string): number {
  const index = WORKER_CLI_ORDER.indexOf(id);
  return index === -1 ? WORKER_CLI_ORDER.length : index;
}

function sortWorkerCliIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const byRank = workerCliRank(a) - workerCliRank(b);
    return byRank === 0 ? a.localeCompare(b) : byRank;
  });
}

export function workerCliPool(
  adapters: RosterAdapter[],
  squadCliPolicy: SquadCliPolicy = "governed",
): string[] {
  const operatorChoice = isOperatorChoicePolicy(squadCliPolicy);
  const candidates = adapters.filter(
    (adapter) =>
      adapter.enabled !== false &&
      adapter.installed &&
      (operatorChoice
        ? adapter.taskHandoffCapable === true
        : adapter.id !== LEGACY_ORCHESTRATOR_CLI &&
          adapter.autonomousWorkspaceWriteCapable === true),
  );
  return sortWorkerCliIds(unique(candidates.map((adapter) => adapter.id)));
}

function adapterInstalledEnabled(
  adapters: RosterAdapter[],
  id: string | undefined,
): boolean {
  return Boolean(
    id &&
      adapters.some(
        (adapter) =>
          adapter.id === id &&
          adapter.installed &&
          adapter.enabled !== false,
      ),
  );
}

export interface BalanceSquadRosterCliOptions {
  readonly squadCliPolicy?: SquadCliPolicy;
  /**
   * Release-gate / sealed fixture: never rewrite any CLI (orchestrator,
   * executor or advisor). Only fill missing model defaults. Silent rebalancing
   * broke product-wizard E2E binding (`observer-invalid`) when advisory CLIs were
   * momentarily undetected in the packaged gate.
   */
  readonly preserveExactCliAssignments?: boolean;
}

/**
 * Balance worker CLIs across qualified writers. Preserve an explicit, installed
 * Maestro (and worker) assignment — release fixtures and user-reviewed squads
 * must not be rewritten to the legacy Claude default when that provider is
 * present but unauthenticated.
 *
 * Reviewer/scout CLIs are sealed once chosen: qualification belongs to the
 * review UI / spawn gate, not to silent rebalancing. Claude is rewritten only
 * under reserveClaude (orchestrator already Claude).
 */
export function balanceSquadRosterCli(
  agents: SquadAgent[],
  adapters: RosterAdapter[],
  orchestratorAdapterId = LEGACY_ORCHESTRATOR_CLI,
  options?: BalanceSquadRosterCliOptions,
): SquadAgent[] {
  const operatorChoice = isOperatorChoicePolicy(
    options?.squadCliPolicy ?? "governed",
  );
  const pool = workerCliPool(
    adapters,
    options?.squadCliPolicy ?? "governed",
  );
  const rosterOrchestratorCli = agents.find(
    (agent) => agent.category === "orchestrator",
  )?.cli;
  let workerIndex = 0;

  return agents.map((agent) => {
    if (options?.preserveExactCliAssignments) {
      return {
        ...agent,
        model: agent.model ?? defaultSquadModelForAdapter(agent.cli),
      };
    }

    if (agent.category === "orchestrator") {
      if (adapterInstalledEnabled(adapters, agent.cli)) {
        return {
          ...agent,
          model: agent.model ?? defaultSquadModelForAdapter(agent.cli),
        };
      }
      const target = adapterInstalledEnabled(adapters, orchestratorAdapterId)
        ? orchestratorAdapterId
        : agent.cli || LEGACY_ORCHESTRATOR_CLI;
      return {
        ...agent,
        cli: target,
        model: defaultSquadModelForAdapter(target),
      };
    }

    // Sealed reviewer/scout assignment — including mechanical read-only (grok)
    // and advisory MCP lane (kimi/agy…). Do not rewrite when detection is
    // late/false; the wizard surfaces auth/install blocks instead.
    if (
      (agent.category === "reviewer" || agent.category === "scout") &&
      agent.cli &&
      !(agent.cli === "claude" && rosterOrchestratorCli === "claude")
    ) {
      return {
        ...agent,
        model: agent.model ?? defaultSquadModelForAdapter(agent.cli),
      };
    }

    const keepWorker =
      adapterInstalledEnabled(adapters, agent.cli) &&
      adapters.some(
        (adapter) =>
          adapter.id === agent.cli &&
          (operatorChoice
            ? adapter.taskHandoffCapable === true
            : agent.cli !== LEGACY_ORCHESTRATOR_CLI &&
              adapter.autonomousWorkspaceWriteCapable === true),
      );
    if (keepWorker) {
      return {
        ...agent,
        model: agent.model ?? defaultSquadModelForAdapter(agent.cli),
      };
    }

    const nextCli =
      pool.length > 0 ? pool[workerIndex++ % pool.length]! : agent.cli;

    return nextCli === agent.cli
      ? {
          ...agent,
          model: agent.model ?? defaultSquadModelForAdapter(nextCli),
        }
      : {
          ...agent,
          cli: nextCli,
          model: defaultSquadModelForAdapter(nextCli),
        };
  });
}
