/**
 * Local UI prefs for the Activity Rail: pinned mission ids (per workspace) +
 * collapsed sections. Pure module — storage injected for tests.
 */

export type RailSectionId =
  | 'pinned'
  | 'active'
  | 'queue'
  | 'stopped'
  | 'done'
  | 'archived';

/** @deprecated legacy flat list — migrated away; kept only for read fallback skip */
const PINS_KEY_LEGACY = 'nexus.activityRail.pins';
const PINS_BY_WORKSPACE_KEY = 'nexus.activityRail.pinsByWorkspace';
// v2: a seção "Encerradas" nasceu depois. Preferência antiga não sabe dela e,
// mantida, devolveria ao rail exatamente as missões que o operador encerrou.
const COLLAPSED_KEY = 'nexus.activityRail.collapsed.v2';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> & {
  removeItem?(key: string): void;
};

function storage(): StorageLike | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

// Arquivar é preferência de VISTA, não estado durável: a linha da missão e
// todos os receipts continuam intactos no SQLite do projeto. O main recusa
// (corretamente) apagar missão com atividade durável — sem uma forma de tirar
// da vista, o operador encerrava tudo e continuava olhando a lista cheia.
const ARCHIVED_BY_WORKSPACE_KEY = 'nexus.activityRail.archivedByWorkspace';

function readIdMap(
  key: string,
  store: StorageLike | null,
): Record<string, string[]> {
  if (!store) return {};
  try {
    const raw = store.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [path, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof path !== 'string' || path.length === 0) continue;
      if (!Array.isArray(value)) continue;
      out[path] = value
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .slice(0, MAX_IDS_PER_WORKSPACE);
    }
    return out;
  } catch {
    return {};
  }
}

const MAX_IDS_PER_WORKSPACE = 512;

function readPinsMap(store: StorageLike | null): Record<string, string[]> {
  return readIdMap(PINS_BY_WORKSPACE_KEY, store);
}

function writeIdMap(
  key: string,
  map: Record<string, string[]>,
  store: StorageLike | null,
): void {
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(map));
  } catch {
    // ignore quota
  }
}

function writePinsMap(
  map: Record<string, string[]>,
  store: StorageLike | null,
): void {
  writeIdMap(PINS_BY_WORKSPACE_KEY, map, store);
}

/** Missões escondidas do rail/board deste workspace (histórico intacto). */
export function loadArchivedMissionIds(
  workspacePath: string | null | undefined,
  store: StorageLike | null = storage(),
): string[] {
  if (!workspacePath) return [];
  return readIdMap(ARCHIVED_BY_WORKSPACE_KEY, store)[workspacePath] ?? [];
}

export function setMissionArchived(
  workspacePath: string | null | undefined,
  id: string,
  archived: boolean,
  store: StorageLike | null = storage(),
): string[] {
  if (!workspacePath || !id) return [];
  const map = readIdMap(ARCHIVED_BY_WORKSPACE_KEY, store);
  const current = map[workspacePath] ?? [];
  const next = archived
    ? current.includes(id)
      ? current
      : [id, ...current].slice(0, MAX_IDS_PER_WORKSPACE)
    : current.filter((entry) => entry !== id);
  if (next.length === 0) {
    delete map[workspacePath];
  } else {
    map[workspacePath] = next;
  }
  writeIdMap(ARCHIVED_BY_WORKSPACE_KEY, map, store);
  return next;
}

/**
 * Pins are scoped to the open workspace path so switching folders never
 * mixes another project's starred missions into the list.
 */
export function loadPinnedMissionIds(
  workspacePath: string | null | undefined,
  store: StorageLike | null = storage(),
): string[] {
  if (!workspacePath) return [];
  const map = readPinsMap(store);
  return map[workspacePath] ?? [];
}

export function savePinnedMissionIds(
  workspacePath: string | null | undefined,
  ids: string[],
  store: StorageLike | null = storage(),
): void {
  if (!workspacePath || !store) return;
  const map = readPinsMap(store);
  const next = ids
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .slice(0, 64);
  if (next.length === 0) {
    delete map[workspacePath];
  } else {
    map[workspacePath] = next;
  }
  writePinsMap(map, store);
  // Drop legacy global pin list so it cannot re-leak across workspaces.
  try {
    store.removeItem?.(PINS_KEY_LEGACY);
  } catch {
    // ignore
  }
}

export function togglePinnedMissionId(
  workspacePath: string | null | undefined,
  id: string,
  store: StorageLike | null = storage(),
): string[] {
  if (!workspacePath) return [];
  const current = loadPinnedMissionIds(workspacePath, store);
  const next = current.includes(id)
    ? current.filter((x) => x !== id)
    : [id, ...current].slice(0, 64);
  savePinnedMissionIds(workspacePath, next, store);
  return next;
}

/** Seções sem trabalho vivo nascem fechadas: o rail é a fila do agora. */
const DEFAULT_COLLAPSED: RailSectionId[] = ['stopped', 'done', 'archived'];

export function loadCollapsedSections(
  store: StorageLike | null = storage(),
): RailSectionId[] {
  if (!store) return [...DEFAULT_COLLAPSED];
  try {
    const raw = store.getItem(COLLAPSED_KEY);
    if (!raw) return [...DEFAULT_COLLAPSED];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_COLLAPSED];
    const allowed: RailSectionId[] = [
      'pinned',
      'active',
      'queue',
      'stopped',
      'done',
      'archived',
    ];
    // Preferência gravada manda: quem abriu "Encerradas" mantém aberta.
    return parsed.filter((s): s is RailSectionId =>
      allowed.includes(s as RailSectionId),
    );
  } catch {
    return [...DEFAULT_COLLAPSED];
  }
}

export function saveCollapsedSections(
  sections: RailSectionId[],
  store: StorageLike | null = storage(),
): void {
  if (!store) return;
  try {
    store.setItem(COLLAPSED_KEY, JSON.stringify(sections));
  } catch {
    // ignore
  }
}

// Projetos recolhidos no rail (árvore de spaces). Default = todos abertos, o
// comportamento de sempre; a preferência gravada só recolhe o que a pessoa
// recolheu. Chave por caminho do workspace, como pins/arquivados.
const COLLAPSED_WORKSPACES_KEY = 'nexus.activityRail.collapsedWorkspaces';

export function loadCollapsedWorkspacePaths(
  store: StorageLike | null = storage(),
): string[] {
  if (!store) return [];
  try {
    const raw = store.getItem(COLLAPSED_WORKSPACES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .slice(0, 256);
  } catch {
    return [];
  }
}

export function saveCollapsedWorkspacePaths(
  paths: readonly string[],
  store: StorageLike | null = storage(),
): void {
  if (!store) return;
  try {
    store.setItem(COLLAPSED_WORKSPACES_KEY, JSON.stringify([...new Set(paths)]));
  } catch {
    // ignore
  }
}

// "Recentes" no rail nasce recolhido: o rail é a fila do agora e o histórico
// abre por escolha. Tri-state de propósito: `null` = a pessoa nunca escolheu e
// quem desenha decide o padrão (abre quando não há projeto em andamento acima,
// senão o rail ficaria só com um título e nenhum projeto para abrir).
const RECENT_WORKSPACES_OPEN_KEY = 'nexus.activityRail.recentWorkspacesOpen';

export function loadRecentWorkspacesOpen(
  store: StorageLike | null = storage(),
): boolean | null {
  if (!store) return null;
  try {
    const raw = store.getItem(RECENT_WORKSPACES_OPEN_KEY);
    return raw === 'open' ? true : raw === 'closed' ? false : null;
  } catch {
    return null;
  }
}

export function saveRecentWorkspacesOpen(
  open: boolean,
  store: StorageLike | null = storage(),
): void {
  if (!store) return;
  try {
    store.setItem(RECENT_WORKSPACES_OPEN_KEY, open ? 'open' : 'closed');
  } catch {
    // ignore quota
  }
}
