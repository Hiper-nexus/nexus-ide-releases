import path from "node:path";
import { digest } from "./worktree-contract";

/**
 * Onde moram as worktrees Git gerenciadas pelo Nexus e os candidatos da fila
 * de merge (F-654).
 *
 * O Git para Windows recusa `git worktree add` quando "<worktree>\.git" passa
 * de PATH_MAX - 40 (260 - 40): "fatal: '$GIT_DIR' too big". `core.longpaths`
 * não levanta esse teto. Só o diretório de runtime do checkout já tem ~219
 * caracteres em %APPDATA%, então no win32 nenhuma worktree gerenciada nascia —
 * escritor isolado, missão planejada e, desde o F-162, toda aba nova.
 *
 * No win32 elas moram em raízes curtas ao lado dos runtimes de projeto, com
 * nomes compactos derivados dos MESMOS ids. macOS e Linux mantêm o layout
 * histórico byte a byte: registros são validados por caminho exato.
 */
export type WorktreeLayoutPlatform = NodeJS.Platform;

/** Maior caminho de worktree que o Git para Windows aceita. */
export const WINDOWS_GIT_WORKTREE_PATH_LIMIT = 215;

export interface ManagedWorktreeLocation {
  /** Diretório de runtime do checkout (`ProjectRuntimeManager.locationFor`). */
  readonly runtimeDirectory: string;
  /** Base de todos os runtimes (`ProjectRuntimeManager.baseDirectory`). */
  readonly baseDirectory: string;
}

function compact(platform: WorktreeLayoutPlatform): boolean {
  return platform === "win32";
}

export function managedWorktreesRoot(
  location: ManagedWorktreeLocation,
  platform: WorktreeLayoutPlatform = process.platform,
): string {
  return compact(platform)
    ? path.join(location.baseDirectory, "wt")
    : path.join(location.runtimeDirectory, "worktrees");
}

export function managedCandidatesRoot(
  location: ManagedWorktreeLocation,
  platform: WorktreeLayoutPlatform = process.platform,
): string {
  return compact(platform)
    ? path.join(location.baseDirectory, "mc")
    : path.join(location.runtimeDirectory, "merge-candidates");
}

/** Caminho da worktree de uma task, relativo a `managedWorktreesRoot`. */
export function managedWorktreeRelativePath(
  projectId: string,
  checkoutId: string,
  taskKey: string,
  platform: WorktreeLayoutPlatform = process.platform,
): string {
  const checkoutKey = digest("worktree-checkout", projectId, checkoutId);
  if (compact(platform)) {
    return path.join(checkoutKey.slice(0, 16), `t-${taskKey.slice(0, 24)}`);
  }
  return path.join(
    `project-${digest("worktree-project", projectId)}`,
    `checkout-${checkoutKey}`,
    `task-${taskKey}`,
  );
}

/**
 * Raiz histórica das worktrees de um checkout. Fora do win32 é a raiz atual;
 * no win32 só guarda registros anteriores ao F-654.
 */
export function legacyWorktreesRoot(runtimeDirectory: string): string {
  return path.join(runtimeDirectory, "worktrees");
}

/**
 * Caminhos absolutos que um registro pode carregar: o layout atual sob a raiz
 * atual e, no win32, o histórico no lugar físico onde ele estava — registros
 * anteriores ao F-654 só falharam, mas continuam válidos e inertes em vez de
 * travar o estado inteiro do checkout.
 */
export function acceptedWorktreePaths(
  roots: { readonly worktreesRoot: string; readonly legacyWorktreesRoot?: string },
  projectId: string,
  checkoutId: string,
  taskKey: string,
  platform: WorktreeLayoutPlatform = process.platform,
): readonly string[] {
  const current = path.join(
    roots.worktreesRoot,
    managedWorktreeRelativePath(projectId, checkoutId, taskKey, platform),
  );
  if (!compact(platform) || !roots.legacyWorktreesRoot) return [current];
  return [
    current,
    path.join(
      roots.legacyWorktreesRoot,
      managedWorktreeRelativePath(projectId, checkoutId, taskKey, "linux"),
    ),
  ];
}

/**
 * Relativos aceitos, para reconhecer um runtime copiado de outro lugar: o
 * layout atual e, no win32, o histórico.
 */
export function acceptedWorktreeRelativePaths(
  projectId: string,
  checkoutId: string,
  taskKey: string,
  platform: WorktreeLayoutPlatform = process.platform,
): readonly string[] {
  const current = managedWorktreeRelativePath(projectId, checkoutId, taskKey, platform);
  if (!compact(platform)) return [current];
  return [current, managedWorktreeRelativePath(projectId, checkoutId, taskKey, "linux")];
}

/** Caminho de um candidato de merge, relativo a `managedCandidatesRoot`. */
export function managedCandidateRelativePath(
  scopeKey: string,
  candidateKey: string,
  platform: WorktreeLayoutPlatform = process.platform,
): string {
  return compact(platform)
    ? path.join(scopeKey.slice(0, 16), `c-${candidateKey.slice(0, 24)}`)
    : path.join(`scope-${scopeKey}`, `candidate-${candidateKey}`);
}
