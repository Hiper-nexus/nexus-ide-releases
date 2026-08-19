/**
 * Compila stories listadas no objetivo civil num plano selado da Via Rápida.
 *
 * O Maestro tendia a colapsar 20 stories em ~5 workers de papel; o board
 * ficava 0/7. Aqui o Main sela N tasks das linhas do objetivo no start
 * (ou no primeiro turno, se o selo ainda não existir). Progresso N/M
 * avança no handoff SUCCESS (MCP/PTY) **ou** quando o worker termina
 * com files-modified no cwd e sem recibo SUCCESS. Zero arquivos sem
 * handoff SUCCESS não conta.
 * Título/detalhe das tasks seladas continuam imutáveis.
 */
import type { Mission, Squad, SquadAgent, TaskStatus } from '../../shared/orch-types';
import {
  countMissionItems,
  extractListedMissionItems,
  listedItemsLookLikeRoleCollapse,
} from '../../shared/mission-item-count';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';

export {
  countMissionItems,
  extractListedMissionItems,
  listedItemsLookLikeRoleCollapse,
};

/** Plano selado com papéis do squad enquanto o objetivo pede N stories. */
export function shouldRejectRoleCollapsedPlan(input: {
  readonly objective: string;
  readonly planTitles: readonly string[];
}): boolean {
  const wanted = countMissionItems(input.objective);
  return (
    wanted > input.planTitles.length &&
    listedItemsLookLikeRoleCollapse(input.planTitles)
  );
}

export type StoryPlanRow = {
  readonly plannerId: string;
  readonly title: string;
  readonly detail: string;
  readonly agentRef: string;
  readonly agentCategory: Exclude<SquadAgent['category'], 'orchestrator'>;
};

function writableRosterAgents(
  agents: readonly SquadAgent[],
): SquadAgent[] {
  const writers = agents.filter(
    (agent) => agent.category === 'executor' || agent.category === 'scout',
  );
  if (writers.length > 0) return writers;
  return agents.filter((agent) => agent.category !== 'orchestrator');
}

export function fastLaneObjectiveText(mission: Pick<
  Mission,
  'description' | 'title' | 'intentContract'
>): string {
  return (
    mission.intentContract?.goal?.trim() ||
    mission.description?.trim() ||
    mission.title?.trim() ||
    ''
  );
}

/**
 * Uma row selada por item listado. Escritores do roster ciclam — 20 stories
 * com 1 executor ainda viram 20 tasks, não 1 papel.
 */
export function compileListedStoriesToPlanRows(
  objective: string,
  agents: readonly SquadAgent[],
): readonly StoryPlanRow[] {
  const items = extractListedMissionItems(objective);
  const writers = writableRosterAgents(agents);
  if (items.length === 0 || writers.length === 0) return Object.freeze([]);
  return Object.freeze(
    items.map((title, index) => {
      const writer = writers[index % writers.length]!;
      const category = writer.category;
      if (category === 'orchestrator') {
        throw new Error('plano listado não atribui task ao orquestrador');
      }
      return Object.freeze({
        plannerId: `story-${index + 1}`,
        title,
        detail: title,
        agentRef: writer.id,
        agentCategory: category,
      });
    }),
  );
}

const GENERIC_IDENTITY_TOKENS = new Set([
  'worker',
  'writer',
  'escritor',
  'agent',
  'nexus',
  'pane',
  'cli',
  'the',
  'and',
]);

export function normalizeWorkerIdentity(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/^nexus[-_]+/u, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

export function writerOrdinalFromLabel(value: string): number | null {
  const match = value.match(
    /\b(?:writer|escritor|worker)\s*#?\s*(\d+)\b/iu,
  );
  if (!match) return null;
  const ordinal = Number(match[1]);
  return Number.isInteger(ordinal) && ordinal > 0 ? ordinal : null;
}

function identityTokens(value: string): string[] {
  return normalizeWorkerIdentity(value)
    .split(' ')
    .filter((token) => token.length >= 3 && !GENERIC_IDENTITY_TOKENS.has(token));
}

export function workerIdentitiesMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = normalizeWorkerIdentity(left ?? '');
  const b = normalizeWorkerIdentity(right ?? '');
  if (!a || !b) return false;
  if (a === b) return true;
  const tokensA = new Set(identityTokens(a));
  const tokensB = new Set(identityTokens(b));
  for (const token of tokensA) {
    if (tokensB.has(token)) return true;
  }
  return false;
}

function haystackIncludesTitle(
  haystack: string,
  title: string,
): boolean {
  const needle = title.trim().toLocaleLowerCase('en-US');
  if (!needle) return false;
  if (haystack.includes(needle)) return true;
  const normalizedNeedle = normalizeWorkerIdentity(title);
  return Boolean(normalizedNeedle) && haystack.includes(normalizedNeedle);
}

export function matchSealedTaskForHandoff(input: {
  readonly tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly agentRef?: string | null;
    readonly agentName?: string | null;
    readonly agentCli?: string | null;
    readonly plannerId?: string | null;
  }[];
  readonly fromAgent?: string | null;
  readonly adapterId?: string | null;
  readonly summary?: string | null;
  readonly preferredTaskId?: string | null;
  readonly filesModified?: readonly string[] | null;
}): string | null {
  const open = input.tasks.filter(
    (task) => task.status === 'pending' || task.status === 'running',
  );
  if (open.length === 0) return null;
  if (input.preferredTaskId) {
    const preferred = open.find((task) => task.id === input.preferredTaskId);
    if (preferred) return preferred.id;
  }
  const summary = input.summary?.trim().toLocaleLowerCase('en-US') ?? '';
  const filesHaystack = (input.filesModified ?? [])
    .join('\n')
    .toLocaleLowerCase('en-US');
  if (summary) {
    const byTitle = open.find((task) => haystackIncludesTitle(summary, task.title));
    if (byTitle) return byTitle.id;
  }
  if (filesHaystack) {
    const byFile = open.find((task) =>
      haystackIncludesTitle(filesHaystack, task.title),
    );
    if (byFile) return byFile.id;
  }
  const writerSource = [input.fromAgent, input.summary]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' ');
  const writerOrdinal = writerOrdinalFromLabel(writerSource);
  if (writerOrdinal !== null) {
    const byPlanner = open.find(
      (task) =>
        task.plannerId === `story-${writerOrdinal}` ||
        task.plannerId === String(writerOrdinal),
    );
    if (byPlanner) return byPlanner.id;
    const byIndex = open[writerOrdinal - 1];
    if (byIndex) return byIndex.id;
  }
  const fromAgent = input.fromAgent?.trim() ?? '';
  const adapterId = input.adapterId?.trim() ?? '';
  if (fromAgent || adapterId) {
    const byAgent = open.find((task) => {
      const identities = [task.agentRef, task.agentName, task.agentCli];
      return identities.some(
        (identity) =>
          workerIdentitiesMatch(fromAgent, identity) ||
          workerIdentitiesMatch(adapterId, identity),
      );
    });
    if (byAgent) return byAgent.id;
  }
  return open[0]?.id ?? null;
}

const TITLE_GENERIC_TOKENS = new Set([
  ...GENERIC_IDENTITY_TOKENS,
  'story',
  'tarefa',
  'task',
  'item',
  'page',
  'com',
  'para',
  'uma',
  'das',
  'dos',
  'por',
]);

export function distinctiveTitleTokens(title: string): readonly string[] {
  return Object.freeze(
    normalizeWorkerIdentity(title)
      .split(' ')
      .filter(
        (token) =>
          token.length >= 4 &&
          !TITLE_GENERIC_TOKENS.has(token) &&
          !/^\d+$/u.test(token),
      ),
  );
}

/**
 * Casa arquivos a tasks abertas só quando o token do título é único.
 * "waitlist" em 12 stories iguais não fecha as 12. Arquivos sem casa
 * única ficam para o fallback (próxima aberta — nunca inventa).
 */
export function distinctiveFileTokens(file: string): readonly string[] {
  const haystack = file.toLocaleLowerCase('en-US').replace(/\\/g, '/');
  return Object.freeze(
    haystack
      .split('/')
      .flatMap((segment) =>
        segment.replace(/\.[a-z0-9]+$/u, '').split(/[^a-z0-9]+/u),
      )
      .filter(
        (token) =>
          token.length >= 4 &&
          !TITLE_GENERIC_TOKENS.has(token) &&
          !/^\d+$/u.test(token),
      ),
  );
}

const TITLE_FILE_STEM_ALIASES: Readonly<Record<string, string>> = {
  contador: 'count',
  counter: 'count',
  count: 'count',
  fila: 'queue',
  queue: 'queue',
  subscribe: 'subscribe',
  inscricao: 'subscribe',
  grava: 'save',
  save: 'save',
};

export function normalizeTitleFileStem(token: string): string {
  return TITLE_FILE_STEM_ALIASES[token] ?? token;
}

/** count.js ↔ "Contador da fila": stem/alias, sem inventar story. */
export function titleTokenAlignsFile(
  titleToken: string,
  fileHaystack: string,
  fileTokens: readonly string[],
): boolean {
  if (titleToken.length >= 4 && fileHaystack.includes(titleToken)) return true;
  const titleStem = normalizeTitleFileStem(titleToken);
  return fileTokens.some((fileToken) => {
    if (fileToken === titleToken) return true;
    if (normalizeTitleFileStem(fileToken) === titleStem) return true;
    if (fileToken.length >= 4 && titleToken.includes(fileToken)) return true;
    if (titleToken.length >= 4 && fileToken.includes(titleToken)) return true;
    const shared = Math.min(titleToken.length, fileToken.length);
    return shared >= 4 && titleToken.slice(0, 4) === fileToken.slice(0, 4);
  });
}

function plannerIdFromStoryFile(file: string): string | null {
  const haystack = file.toLocaleLowerCase('en-US').replace(/\\/g, '/');
  const match = haystack.match(/(?:^|\/)(?:stories\/)?0*(\d{1,3})[-_]/u);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? `story-${n}` : null;
}

export function matchOpenSealedTasksForFiles(input: {
  readonly tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly plannerId?: string | null;
  }[];
  readonly filesModified: readonly string[];
}): {
  readonly uniqueTaskIds: readonly string[];
  readonly unmatchedFiles: readonly string[];
} {
  const open = input.tasks.filter(
    (task) => task.status === 'pending' || task.status === 'running',
  );
  const uniqueTaskIds: string[] = [];
  const unmatchedFiles: string[] = [];
  const seenTasks = new Set<string>();
  for (const file of input.filesModified) {
    const haystack = file.toLocaleLowerCase('en-US').replace(/\\/g, '/');
    const fileTokens = distinctiveFileTokens(file);
    const plannerId = plannerIdFromStoryFile(file);
    const hits = open.filter((task) => {
      if (
        plannerId &&
        (task.plannerId === plannerId || task.plannerId === String(plannerId.slice(6)))
      ) {
        return true;
      }
      return distinctiveTitleTokens(task.title).some((token) =>
        titleTokenAlignsFile(token, haystack, fileTokens),
      );
    });
    if (hits.length === 1) {
      const id = hits[0]!.id;
      if (!seenTasks.has(id)) {
        seenTasks.add(id);
        uniqueTaskIds.push(id);
      }
    } else {
      unmatchedFiles.push(file);
    }
  }
  return Object.freeze({
    uniqueTaskIds: Object.freeze(uniqueTaskIds),
    unmatchedFiles: Object.freeze(unmatchedFiles),
  });
}

/**
 * Evidência no disco (watcher / idle, sem PTY death): fecha matches
 * únicos e, se ainda houver arquivo sem casa, a próxima task aberta.
 */
export function advanceSealedTasksFromFilesOnDisk(
  stores: ProjectDomainStoreSuite,
  input: {
    readonly missionId: string;
    readonly filesModified: readonly string[];
    readonly fromAgent?: string | null;
    readonly adapterId?: string | null;
    /** Após recibo SUCCESS: só fecha matches únicos. Leftover 060/061 fica leftover. */
    readonly uniqueMatchesOnly?: boolean;
  },
): readonly string[] {
  if (input.filesModified.length === 0) return Object.freeze([]);
  const mission = stores.missions.get(input.missionId);
  if (!mission) return Object.freeze([]);
  const tasks = listSealedTasksForMatch(
    stores,
    mission.id,
    mission.intentVersion ?? 0,
  );
  if (!tasks) return Object.freeze([]);
  const matched = matchOpenSealedTasksForFiles({
    tasks,
    filesModified: input.filesModified,
  });
  const advanced: string[] = [];
  for (const taskId of matched.uniqueTaskIds) {
    const current = stores.tasks.list(mission.id).find((row) => row.id === taskId);
    if (!current || current.status === 'done' || current.status === 'failed') {
      continue;
    }
    stores.tasks.advanceSealedTaskStatus(taskId, 'done');
    advanced.push(taskId);
  }
  if (!input.uniqueMatchesOnly && matched.unmatchedFiles.length > 0) {
    const fallback = advanceFastLaneStoryTaskFromWorkerDone(stores, {
      missionId: mission.id,
      fromAgent: input.fromAgent,
      adapterId: input.adapterId,
      filesModified: matched.unmatchedFiles,
    });
    if (fallback && !advanced.includes(fallback)) advanced.push(fallback);
  }
  return Object.freeze(advanced);
}

export function sealFastLaneListedStoryPlan(
  stores: ProjectDomainStoreSuite,
  mission: Mission,
  squad: Squad,
): readonly { readonly id: string; readonly title: string }[] {
  if (mission.status !== 'running') return Object.freeze([]);
  const intentVersion = mission.intentVersion ?? 0;
  if (stores.tasks.hasPlan(mission.id, intentVersion)) {
    const existing = Object.freeze(
      stores.tasks.listPlannedTasks(mission.id, intentVersion).map((planned) => ({
        id: planned.taskId,
        title: planned.task.title,
      })),
    );
    if (
      shouldRejectRoleCollapsedPlan({
        objective: fastLaneObjectiveText(mission),
        planTitles: existing.map((task) => task.title),
      })
    ) {
      console.warn(
        `[fast-lane] plano selado colapsou em ${existing.length} papéis; ` +
          `o objetivo pede ${countMissionItems(fastLaneObjectiveText(mission))} stories`,
      );
    }
    return existing;
  }
  const rows = compileListedStoriesToPlanRows(
    fastLaneObjectiveText(mission),
    squad.agents,
  );
  if (rows.length === 0) return Object.freeze([]);
  const sealed = stores.tasks.createPlanAtomically({
    missionId: mission.id,
    intentVersion,
    squad: { id: squad.id, agents: squad.agents },
    rows,
  });
  return Object.freeze(
    sealed.map((task) => ({ id: task.id, title: task.title })),
  );
}

function handoffToTaskStatus(
  handoffStatus: string,
): Extract<TaskStatus, 'done' | 'failed'> {
  return handoffStatus === 'success' || handoffStatus === 'partial'
    ? 'done'
    : 'failed';
}

/**
 * Via Rápida não tem dispatcher: o handoff do worker avança a task selada.
 * Título/detalhe continuam imutáveis.
 */
function listSealedTasksForMatch(
  stores: ProjectDomainStoreSuite,
  missionId: string,
  intentVersion: number,
): {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly agentRef: string | null;
  readonly agentName: string | null;
  readonly agentCli: string | null;
  readonly plannerId: string | null;
}[] | null {
  if (
    typeof stores.tasks?.list !== 'function' ||
    typeof stores.tasks?.listPlannedTasks !== 'function' ||
    typeof stores.tasks?.advanceSealedTaskStatus !== 'function'
  ) {
    return null;
  }
  const planned = stores.tasks.listPlannedTasks(missionId, intentVersion);
  return stores.tasks.list(missionId).map((task) => {
    const row = planned.find((candidate) => candidate.taskId === task.id);
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      agentRef: row?.agentRef ?? null,
      agentName: row?.agent.agentName ?? null,
      agentCli: row?.agent.cli ?? null,
      plannerId: row?.plannerId ?? null,
    };
  });
}

export function advanceFastLaneStoryTaskFromHandoff(
  stores: ProjectDomainStoreSuite,
  input: {
    readonly missionId: string;
    readonly fromAgent?: string | null;
    readonly adapterId?: string | null;
    readonly summary?: string | null;
    readonly preferredTaskId?: string | null;
    readonly filesModified?: readonly string[] | null;
    readonly handoffStatus: string;
  },
): string | null {
  const mission = stores.missions.get(input.missionId);
  if (!mission) return null;
  const tasks = listSealedTasksForMatch(
    stores,
    mission.id,
    mission.intentVersion ?? 0,
  );
  if (!tasks) return null;
  const taskId = matchSealedTaskForHandoff({
    tasks,
    fromAgent: input.fromAgent,
    adapterId: input.adapterId,
    summary: input.summary,
    preferredTaskId: input.preferredTaskId,
    filesModified: input.filesModified,
  });
  if (!taskId) return null;
  const next = handoffToTaskStatus(input.handoffStatus);
  stores.tasks.advanceSealedTaskStatus(taskId, next);
  return taskId;
}

/**
 * Conclusão física do writer (PTY/turn-end): só avança o board se
 * files-modified for não-vazio. Não inventa stories — casa ou pega a
 * próxima task selada aberta.
 */
export function advanceFastLaneStoryTaskFromWorkerDone(
  stores: ProjectDomainStoreSuite,
  input: {
    readonly missionId: string;
    readonly fromAgent?: string | null;
    readonly adapterId?: string | null;
    readonly summary?: string | null;
    readonly preferredTaskId?: string | null;
    readonly filesModified: readonly string[];
  },
): string | null {
  if (input.filesModified.length === 0) return null;
  return advanceFastLaneStoryTaskFromHandoff(stores, {
    missionId: input.missionId,
    fromAgent: input.fromAgent,
    adapterId: input.adapterId,
    summary: input.summary,
    preferredTaskId: input.preferredTaskId,
    filesModified: input.filesModified,
    handoffStatus: 'success',
  });
}

/** Progresso N/M que o board mostra — tasks seladas, não papéis do roster. */
export function boardProgressFromSealedTasks(
  tasks: readonly { readonly status: string }[],
): { readonly completed: number; readonly total: number } {
  const completed = tasks.filter((task) => task.status === 'done').length;
  return { completed, total: tasks.length };
}
