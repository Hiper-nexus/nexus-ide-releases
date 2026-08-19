import { extractOwnershipFilesFromPrompt, normalizeOwnershipFiles } from './same-checkout-fanout';

/**
 * Fail-closed do fan-out: se nexus_task falha no mesmo turno em que o Maestro
 * planejou vários escritores, os papéis sem pane NÃO podem ficar "Na fila"
 * enquanto a missão segue Trabalhando. Toast civil + retry/reroute.
 */

export interface PlannedFanoutRole {
  readonly roleId: string;
  readonly roleName: string;
  readonly category?: string;
  readonly files: readonly string[];
}

export type NexusTaskFailClosedDecision =
  | { readonly action: 'none' }
  | {
      readonly action: 'retry-unspawned';
      readonly unspawned: readonly PlannedFanoutRole[];
      readonly toast: string;
    };

export function extractObjectiveFolder(
  objective: string | undefined | null,
): string | null {
  const text = objective?.trim() ?? '';
  if (!text) return null;
  const pathMatch = text.match(
    /\b((?:[\w.-]+\/)+[\w.-]+)\.(?:html?|css|js|jsx|ts|tsx|md|json)\b/i,
  );
  if (pathMatch?.[1]) {
    const dir = pathMatch[1].split('/').slice(0, -1).join('/');
    if (dir) return dir;
  }
  const slug = text.match(
    /\b([a-z0-9][a-z0-9._-]*(?:-waitlist[-\w]*|[-_][a-z0-9][a-z0-9._-]*)+)\b/i,
  );
  return slug?.[1] ?? null;
}

export function inferRoleOwnershipFiles(input: {
  readonly roleName: string;
  readonly category?: string;
  readonly objective?: string;
  readonly explicitFiles?: readonly string[];
}): string[] {
  const explicit = normalizeOwnershipFiles(input.explicitFiles);
  if (explicit.length > 0) return explicit;
  const folder = extractObjectiveFolder(input.objective);
  const prefix = folder ? `${folder}/` : '';
  const name = input.roleName.toLowerCase();
  const category = (input.category ?? '').toLowerCase();
  if (/ux|design/.test(name) || category === 'designer') {
    return [`${prefix}DESIGN.md`];
  }
  if (/front/.test(name)) {
    return [`${prefix}public/index.html`];
  }
  if (/back/.test(name)) {
    return [`${prefix}server.js`];
  }
  if (/general/.test(name)) {
    return [`${prefix}package.json`];
  }
  return [];
}

function filesFromPlanTask(task: Record<string, unknown>): string[] {
  const ownership = task.ownership;
  if (ownership && typeof ownership === 'object') {
    const files = (ownership as { files?: unknown }).files;
    if (Array.isArray(files)) {
      return normalizeOwnershipFiles(files.map(String));
    }
  }
  if (Array.isArray(task.files)) {
    return normalizeOwnershipFiles(task.files.map(String));
  }
  const detail = typeof task.detail === 'string' ? task.detail : '';
  const title = typeof task.title === 'string' ? task.title : '';
  return extractOwnershipFilesFromPrompt(`${title}\n${detail}`);
}

export function plannedRolesFromNexusTaskArgs(
  args: Record<string, unknown> | undefined | null,
): PlannedFanoutRole[] {
  if (!args) return [];
  const tasks = args.tasks;
  if (!Array.isArray(tasks)) return [];
  const out: PlannedFanoutRole[] = [];
  const seen = new Set<string>();
  for (const raw of tasks) {
    if (typeof raw !== 'object' || raw === null) continue;
    const task = raw as Record<string, unknown>;
    const roleId =
      (typeof task.agentRef === 'string' && task.agentRef.trim()) ||
      (typeof task.id === 'string' && task.id.trim()) ||
      '';
    if (!roleId || seen.has(roleId)) continue;
    const roleName =
      (typeof task.agentName === 'string' && task.agentName.trim()) ||
      (typeof task.title === 'string' && task.title.trim()) ||
      roleId;
    seen.add(roleId);
    out.push({
      roleId,
      roleName,
      ...(typeof task.category === 'string' ? { category: task.category } : {}),
      files: filesFromPlanTask(task),
    });
  }
  return out;
}

export function civilianNexusTaskFailMessage(input: {
  readonly queuedRoleNames: readonly string[];
}): string {
  const names = input.queuedRoleNames
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) {
    return (
      'O plano da equipe falhou. A missão continua em Trabalhando — ' +
      'vamos reabrir os papéis que ficaram na fila.'
    );
  }
  const listed =
    names.length === 1
      ? names[0]!
      : names.length === 2
        ? `${names[0]} e ${names[1]}`
        : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
  return (
    `O plano da equipe falhou. Reabrindo ${listed} agora — ` +
    'a missão não pode ficar em Trabalhando com esses papéis na fila.'
  );
}

function roleMatchesSpawned(
  role: PlannedFanoutRole,
  spawnedIds: ReadonlySet<string>,
  spawnedNames: ReadonlySet<string>,
): boolean {
  const id = role.roleId.trim().toLowerCase();
  const name = role.roleName.trim().toLowerCase();
  if (id && spawnedIds.has(id)) return true;
  if (name && spawnedNames.has(name)) return true;
  return false;
}

/**
 * Uma falha de nexus_task com outros papéis planejados não os deixa na fila
 * sem tentativa de spawn.
 */
export function decideNexusTaskFailClosed(input: {
  readonly missionStatus: string;
  readonly nexusTaskFailed: boolean;
  readonly plannedRoles: readonly PlannedFanoutRole[];
  readonly spawnedRoleIds?: readonly string[];
  readonly spawnedRoleNames?: readonly string[];
}): NexusTaskFailClosedDecision {
  if (!input.nexusTaskFailed) return { action: 'none' };
  if (input.missionStatus !== 'running' && input.missionStatus !== 'pending') {
    return { action: 'none' };
  }
  const spawnedIds = new Set(
    (input.spawnedRoleIds ?? []).map((id) => id.trim().toLowerCase()),
  );
  const spawnedNames = new Set(
    (input.spawnedRoleNames ?? []).map((name) => name.trim().toLowerCase()),
  );
  const unspawned = input.plannedRoles.filter(
    (role) => !roleMatchesSpawned(role, spawnedIds, spawnedNames),
  );
  if (unspawned.length === 0) return { action: 'none' };
  return {
    action: 'retry-unspawned',
    unspawned,
    toast: civilianNexusTaskFailMessage({
      queuedRoleNames: unspawned.map((role) => role.roleName),
    }),
  };
}
