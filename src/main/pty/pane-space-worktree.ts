import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { AsyncProcessGitRunner, ProcessGitRunner } from '../runtime/git-command';
import { isInsidePath, resolveCwdForScope } from '../orch/workspace-path';

// Only in-flight creation is cached: every resume rechecks the durable record
// and Git identity. Closing a tab never deletes unmerged commits or WIP.
const pending = new Map<string, Promise<string>>();

function gitPath(cwd: string, arg: string): string {
  const result = new ProcessGitRunner().run(cwd, ['rev-parse', '--path-format=absolute', arg]);
  if (result.status !== 0) throw new Error('Não foi possível verificar a pasta Git da aba.');
  return fs.realpathSync(result.stdout.trim());
}

function assertTabGitIdentity(scope: ProjectExecutionScope, root: string): void {
  const dotGit = path.join(root, '.git');
  const common = gitPath(scope.rootRealPath, '--git-common-dir');
  const admin = gitPath(root, '--absolute-git-dir');
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root ||
      !fs.lstatSync(dotGit).isFile() || root === scope.rootRealPath ||
      gitPath(root, '--show-toplevel') !== root || gitPath(root, '--git-common-dir') !== common ||
      path.dirname(admin) !== path.join(common, 'worktrees') ||
      fs.realpathSync(path.resolve(admin, fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim())) !== dotGit) {
    throw new Error('A pasta isolada da aba mudou no disco. Abra uma nova aba ou restaure a worktree.');
  }
}

/** Main-only provenance, also checked for helpers and durable mission resumes. */
export function sharedPaneSpaceId(scope: ProjectExecutionScope, execution: ProjectExecutionScope): string | undefined {
  if (scope.rootRealPath === execution.rootRealPath) return undefined;
  let registry: ReturnType<typeof requireWorktreeRuntimeRegistry>;
  try { registry = requireWorktreeRuntimeRegistry(); }
  catch (error) {
    if (error instanceof Error && error.message === 'worktree runtime registry is not initialized') return undefined;
    throw error;
  }
  const runtime = registry.forScope(scope);
  const records = runtime.worktreeState.read(runtime.worktrees.scopeKey(scope)).records
    .filter(record => record.worktreePath === execution.rootRealPath);
  const record = records.length === 1 ? records[0] : undefined;
  if (!record || record.ownerKind !== 'pane' || record.taskId !== 'tab' ||
      record.workerId !== record.missionId || !/^space-[a-z0-9-]{1,120}$/.test(record.missionId) ||
      record.rootRealPath !== scope.rootRealPath || record.projectId !== scope.projectId ||
      record.checkoutId !== scope.checkoutId || execution.installationId !== scope.installationId ||
      execution.projectId !== scope.projectId || execution.checkoutId !== scope.checkoutId) return undefined;
  assertTabGitIdentity(scope, execution.rootRealPath);
  return record.missionId;
}

export function isSharedPaneSpaceWorktree(scope: ProjectExecutionScope, execution: ProjectExecutionScope): boolean {
  return sharedPaneSpaceId(scope, execution) !== undefined;
}

/** Resolve only: recovery must never replace a missing tab with a fresh checkout. */
export function resolvePaneSpaceWorktree(scope: ProjectExecutionScope, spaceId: string): ProjectExecutionScope {
  const record = requireWorktreeRuntimeRegistry().get(scope, spaceId, 'tab');
  if (!record) throw new Error('A pasta da aba não está registrada. Restaure a worktree ou abra uma nova aba.');
  const execution = { ...scope, rootRealPath: record.worktreePath };
  if (sharedPaneSpaceId(scope, execution) !== spaceId) throw new Error('Identidade da pasta da aba inválida.');
  const stat = fs.statSync(record.worktreePath, { bigint: true });
  return Object.freeze({ ...execution, workspaceRootDevice: stat.dev.toString(), workspaceRootInode: stat.ino.toString() });
}

export async function preparePaneSpaceWorktree(
  scope: ProjectExecutionScope,
  spaceId: string,
  requestedCwd?: string,
): Promise<{ scope: ProjectExecutionScope; cwd: string }> {
  if (!/^space-[a-z0-9-]{1,120}$/.test(spaceId)) throw new Error('Identidade da aba inválida.');
  const key = JSON.stringify([scope.installationId, scope.projectId, scope.checkoutId, scope.rootRealPath, spaceId]);
  let allocation = pending.get(key);
  if (!allocation) {
    allocation = (async () => {
      const registry = requireWorktreeRuntimeRegistry();
      const existing = registry.get(scope, spaceId, 'tab');
      if (existing) {
        if (!fs.existsSync(existing.worktreePath)) {
          throw new Error('A criação da pasta desta aba falhou ou ela foi removida. Abra uma nova aba para tentar novamente; restaure a worktree original se já havia trabalho nela.');
        }
        return existing.worktreePath;
      }
      const head = await new AsyncProcessGitRunner().run(scope.rootRealPath, ['rev-parse', '--verify', 'HEAD^{commit}'], { allowFailure: true });
      if (head.status !== 0) throw new Error('Para abrir uma aba isolada, o projeto precisa de um repositório Git com pelo menos um commit. Inicialize e faça o primeiro commit, ou continue na aba existente.');
      const record = await registry.create({
        scope, missionId: spaceId, taskId: 'tab', workerId: spaceId,
        ownerKind: 'pane',
        ownership: { files: [], symbols: [], domains: [spaceId] },
      });
      return record.worktreePath;
    })();
    pending.set(key, allocation);
  }
  let root: string;
  try {
    root = await allocation;
  } finally {
    if (pending.get(key) === allocation) pending.delete(key);
  }
  // An opaque renderer id chooses a Main-owned record, never an arbitrary
  // directory. A removed/tampered worktree must not silently become main.
  assertTabGitIdentity(scope, root);
  const stat = fs.statSync(root, { bigint: true });
  const executionScope = Object.freeze({
    ...scope, rootRealPath: root,
    workspaceRootDevice: stat.dev.toString(), workspaceRootInode: stat.ino.toString(),
  });
  let cwd = requestedCwd ?? root;
  if (isInsidePath(scope.rootRealPath, cwd)) {
    cwd = path.resolve(root, path.relative(scope.rootRealPath, cwd));
  }
  return { scope: executionScope, cwd: resolveCwdForScope(executionScope, cwd) };
}
