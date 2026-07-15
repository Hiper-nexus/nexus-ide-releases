import type { AdapterInfo } from '../../shared/types';
import type { SquadAgent } from '../../shared/orch-types';
import { defaultSquadModelForAdapter } from '../../shared/squad-model-defaults';

const LEGACY_ORCHESTRATOR_CLI = 'claude';

const WORKER_CLI_ORDER = [
  'codex',
  'agy',
  'grok',
  'kimi',
  'opencode',
  'aider',
  'glm',
  'longcat',
];

type RosterAdapter = Pick<AdapterInfo, 'id' | 'installed'> & {
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

export function workerCliPool(
  adapters: RosterAdapter[],
  orchestratorAdapterId = LEGACY_ORCHESTRATOR_CLI,
): string[] {
  const candidates = adapters.filter(
    (adapter) =>
      adapter.id !== orchestratorAdapterId && adapter.enabled !== false,
  );
  const installed = candidates.filter((adapter) => adapter.installed);
  const source = installed.length > 0 ? installed : candidates;
  return sortWorkerCliIds(unique(source.map((adapter) => adapter.id)));
}

export function balanceSquadRosterCli(
  agents: SquadAgent[],
  adapters: RosterAdapter[],
  orchestratorAdapterId = LEGACY_ORCHESTRATOR_CLI,
): SquadAgent[] {
  const pool = workerCliPool(adapters, orchestratorAdapterId);
  let workerIndex = 0;

  return agents.map((agent) => {
    if (agent.category === 'orchestrator') {
      return agent.cli === orchestratorAdapterId
        ? {
            ...agent,
            model: agent.model ?? defaultSquadModelForAdapter(agent.cli),
          }
        : {
            ...agent,
            cli: orchestratorAdapterId,
            model: defaultSquadModelForAdapter(orchestratorAdapterId),
          };
    }

    const nextCli = pool[workerIndex % pool.length] ?? agent.cli;
    workerIndex += 1;

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
