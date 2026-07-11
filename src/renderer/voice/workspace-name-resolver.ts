import type { WorkspaceInfo } from '../../shared/workspace-types';

const GENERIC_WORDS = new Set([
  'abrir', 'abre', 'abra', 'iniciar', 'inicia', 'entrar', 'entre',
  'no', 'na', 'o', 'a', 'do', 'da', 'pro', 'para',
  'workspace', 'workspaces', 'projeto', 'projetos', 'pasta', 'pastas',
]);

export function normalizeWorkspaceVoiceName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !GENERIC_WORDS.has(token))
    .join(' ');
}

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
}

function score(query: string, candidate: string): number {
  if (!query || !candidate) return 0;
  if (query === candidate) return 100;
  if (candidate.startsWith(query) || query.startsWith(candidate)) return 82;
  if (candidate.includes(query) || query.includes(candidate)) return 72;
  const q = new Set(query.split(' '));
  const c = new Set(candidate.split(' '));
  const overlap = [...q].filter((token) => c.has(token)).length;
  return overlap ? Math.round((overlap / Math.max(q.size, c.size)) * 65) : 0;
}

export type WorkspaceResolution =
  | { kind: 'match'; workspace: WorkspaceInfo }
  | { kind: 'ambiguous'; candidates: WorkspaceInfo[] }
  | { kind: 'not-found' };

export function resolveWorkspaceByVoiceName(
  spokenName: string,
  workspaces: WorkspaceInfo[],
): WorkspaceResolution {
  const query = normalizeWorkspaceVoiceName(spokenName);
  if (!query) return { kind: 'not-found' };

  const ranked = workspaces
    .map((workspace) => ({
      workspace,
      score: Math.max(
        score(query, normalizeWorkspaceVoiceName(workspace.name)),
        score(query, normalizeWorkspaceVoiceName(basename(workspace.path))),
      ),
    }))
    .filter((item) => item.score >= 65)
    .sort((a, b) => b.score - a.score || b.workspace.lastOpenedAt - a.workspace.lastOpenedAt);

  if (!ranked.length) return { kind: 'not-found' };
  const best = ranked[0];
  const tied = ranked.filter((item) => item.score === best.score);
  if (tied.length > 1) return { kind: 'ambiguous', candidates: tied.map((item) => item.workspace) };
  return { kind: 'match', workspace: best.workspace };
}
