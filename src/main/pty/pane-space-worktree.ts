import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { requireIsolatedWriterPool } from '../orch/isolated-writer-pool';
import { AsyncProcessGitRunner, ProcessGitRunner } from '../runtime/git-command';
import { smallFileToken, statToken } from '../git/proof-fingerprint';
import { isInsidePath, resolveCwdForScope } from '../orch/workspace-path';

// Only in-flight creation is cached: every resume rechecks the durable record
// and Git identity. Closing a tab never deletes unmerged commits or WIP.
const pending = new Map<string, Promise<string>>();

// F-980: a verificação de identidade da aba custava 4 spawns síncronos de git
// em cada "+pane"/resume. A descoberta (common/admin/toplevel) agora é cacheada
// por fingerprint das DUAS pontas da cadeia de ponteiros (.git da worktree ↔
// gitdir/commondir do admin) + stat das raízes. Fail-closed: as checagens puras
// de fs (incluindo reler admin/gitdir) rodam a cada chamada, e ponteiro trocado
// por fora muda o fingerprint → recompute via git → recusa.
const TAB_PROOF_TTL_MS = 5 * 60_000;

interface TabGitProof {
  readonly common: string;
  readonly admin: string;
  readonly toplevel: string;
  readonly commonFromRoot: string;
}

const tabProofCache = new Map<
  string,
  { fingerprint: string; proof: TabGitProof; at: number }
>();
const tabProofStatsState = { gitRuns: 0, hits: 0 };

export function tabGitProofStats(): { readonly gitRuns: number; readonly hits: number } {
  return { ...tabProofStatsState };
}

export function clearTabGitProofCache(): void {
  tabProofCache.clear();
}

function tabProofFingerprint(scopeRoot: string, root: string): string | null {
  const rootToken = statToken(root);
  const scopeToken = statToken(scopeRoot);
  if (rootToken === null || scopeToken === null) return null;
  const dotGit = path.join(root, '.git');
  const dotGitToken = smallFileToken(dotGit);
  if (dotGitToken === null) return null;
  let admin: string;
  try {
    const content = fs.readFileSync(dotGit, 'utf8').trim();
    if (!content.startsWith('gitdir:')) return null;
    const target = content.slice('gitdir:'.length).trim();
    if (!target) return null;
    admin = fs.realpathSync.native(
      path.isAbsolute(target) ? target : path.resolve(root, target),
    );
  } catch {
    return null;
  }
  return [
    rootToken,
    scopeToken,
    dotGitToken,
    statToken(path.join(scopeRoot, '.git')) ?? 'absent',
    statToken(admin) ?? 'absent',
    smallFileToken(path.join(admin, 'gitdir')) ?? 'absent',
    smallFileToken(path.join(admin, 'commondir')) ?? 'absent',
  ].join('|');
}

function gitPath(cwd: string, arg: string): string {
  tabProofStatsState.gitRuns += 1;
  const result = new ProcessGitRunner().run(cwd, ['rev-parse', '--path-format=absolute', arg]);
  if (result.status !== 0) throw new Error('Não foi possível verificar a pasta Git da aba.');
  return fs.realpathSync(result.stdout.trim());
}

function assertTabGitIdentity(scope: ProjectExecutionScope, root: string): void {
  const dotGit = path.join(root, '.git');
  const key = `${scope.rootRealPath}\0${root}`;
  const fingerprint = tabProofFingerprint(scope.rootRealPath, root);
  let proof: TabGitProof | undefined;
  if (fingerprint !== null) {
    const hit = tabProofCache.get(key);
    if (
      hit &&
      hit.fingerprint === fingerprint &&
      Date.now() - hit.at < TAB_PROOF_TTL_MS
    ) {
      tabProofStatsState.hits += 1;
      proof = hit.proof;
    }
  }
  if (!proof) {
    proof = {
      common: gitPath(scope.rootRealPath, '--git-common-dir'),
      admin: gitPath(root, '--absolute-git-dir'),
      toplevel: gitPath(root, '--show-toplevel'),
      commonFromRoot: gitPath(root, '--git-common-dir'),
    };
    if (fingerprint !== null) {
      tabProofCache.set(key, { fingerprint, proof, at: Date.now() });
    }
  }
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root ||
      !fs.lstatSync(dotGit).isFile() || root === scope.rootRealPath ||
      proof.toplevel !== root || proof.commonFromRoot !== proof.common ||
      path.dirname(proof.admin) !== path.join(proof.common, 'worktrees') ||
      fs.realpathSync(path.resolve(proof.admin, fs.readFileSync(path.join(proof.admin, 'gitdir'), 'utf8').trim())) !== dotGit) {
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

/**
 * Pane restaurado depois do reinício pode chegar só com o cwd da worktree da
 * aba (layout sem `worktreeSpaceId`, ou missão órfã descartada pelo Main).
 * Só um registro de aba do Main responde com o espaço — inclusive com a pasta
 * removida, para a recusa dizer "aba" e nunca cair no checkout principal. A
 * prova de identidade continua em `preparePaneSpaceWorktree`.
 */
export function findPaneSpaceIdByWorktreeCwd(scope: ProjectExecutionScope, cwd: string | undefined): string | undefined {
  if (!cwd || !path.isAbsolute(cwd)) return undefined;
  let registry: ReturnType<typeof requireWorktreeRuntimeRegistry>;
  try { registry = requireWorktreeRuntimeRegistry(); }
  catch (error) {
    if (error instanceof Error && error.message === 'worktree runtime registry is not initialized') return undefined;
    throw error;
  }
  if (isInsidePath(scope.rootRealPath, cwd)) return undefined;
  const candidates = [path.resolve(cwd)];
  try { candidates.push(fs.realpathSync(cwd)); } catch { /* pasta removida: vale o caminho gravado */ }
  const runtime = registry.forScope(scope);
  const records = runtime.worktreeState.read(runtime.worktrees.scopeKey(scope)).records
    .filter(record => record.taskId === 'tab' && record.ownerKind === 'pane' && record.workerId === record.missionId &&
      candidates.some(candidate => isInsidePath(record.worktreePath, candidate)));
  const spaceId = records.length === 1 ? records[0]!.missionId : undefined;
  return spaceId && /^space-[a-z0-9-]{1,120}$/.test(spaceId) ? spaceId : undefined;
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
      const poolRequest = {};
      try {
        const pooled = await requireIsolatedWriterPool().tryAdopt(scope, spaceId, poolRequest, {
          workerId: spaceId,
          taskId: 'tab',
          ownership: { files: [], symbols: [], domains: [spaceId] },
        });
        if (pooled) {
          requireIsolatedWriterPool().scheduleReplenish(scope, poolRequest);
          return pooled.record.worktreePath;
        }
      } catch (error) {
        console.warn('[pane-space-worktree] falha ao adotar do pool, caindo para create:', error);
      }
      const record = await registry.create({
        scope, missionId: spaceId, taskId: 'tab', workerId: spaceId,
        ownerKind: 'pane',
        ownership: { files: [], symbols: [], domains: [spaceId] },
      });
      requireIsolatedWriterPool().scheduleReplenish(scope, poolRequest);
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
