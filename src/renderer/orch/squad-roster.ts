import type { AdapterInfo } from "../../shared/types";
import type { SquadAgent } from "../../shared/orch-types";
import { defaultSquadModelForAdapter } from "../../shared/squad-model-defaults";

const LEGACY_ORCHESTRATOR_CLI = "claude";

const WORKER_CLI_ORDER = [
  "codex",
  "omp",
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
  "id" | "installed" | "autonomousWorkspaceWriteCapable"
> & {
  enabled?: boolean;
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

export function workerCliPool(adapters: RosterAdapter[]): string[] {
  const candidates = adapters.filter(
    (adapter) =>
      adapter.id !== LEGACY_ORCHESTRATOR_CLI &&
      adapter.enabled !== false &&
      adapter.installed &&
      adapter.autonomousWorkspaceWriteCapable === true,
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

/**
 * Balance worker CLIs across qualified writers. Preserve an explicit, installed
 * Maestro (and worker) assignment — release fixtures and user-reviewed squads
 * must not be rewritten to the legacy Claude default when that provider is
 * present but unauthenticated.
 */
export function balanceSquadRosterCli(
  agents: SquadAgent[],
  adapters: RosterAdapter[],
  orchestratorAdapterId = LEGACY_ORCHESTRATOR_CLI,
): SquadAgent[] {
  const pool = workerCliPool(adapters);
  let workerIndex = 0;

  return agents.map((agent) => {
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

    const keepWorker =
      adapterInstalledEnabled(adapters, agent.cli) &&
      agent.cli !== LEGACY_ORCHESTRATOR_CLI &&
      adapters.some(
        (adapter) =>
          adapter.id === agent.cli &&
          adapter.autonomousWorkspaceWriteCapable === true,
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
