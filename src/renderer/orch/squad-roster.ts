import type { AdapterInfo } from '../../shared/types';
import type { SquadAgent } from '../../shared/orch-types';

const ORCHESTRATOR_CLI = 'claude';

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

export function workerCliPool(adapters: RosterAdapter[]): string[] {
  const candidates = adapters.filter(
    (adapter) => adapter.id !== ORCHESTRATOR_CLI && adapter.enabled !== false,
  );
  const installed = candidates.filter((adapter) => adapter.installed);
  const source = installed.length > 0 ? installed : candidates;
  return sortWorkerCliIds(unique(source.map((adapter) => adapter.id)));
}

export function balanceSquadRosterCli(
  agents: SquadAgent[],
  adapters: RosterAdapter[],
): SquadAgent[] {
  const pool = workerCliPool(adapters);
  let workerIndex = 0;

  return agents.map((agent) => {
    if (agent.category === 'orchestrator') {
      return agent.cli === ORCHESTRATOR_CLI
        ? { ...agent }
        : { ...agent, cli: ORCHESTRATOR_CLI, model: undefined };
    }

    const nextCli = pool[workerIndex % pool.length] ?? agent.cli;
    workerIndex += 1;

    return nextCli === agent.cli
      ? { ...agent }
      : { ...agent, cli: nextCli, model: undefined };
  });
}
