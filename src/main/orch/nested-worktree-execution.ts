import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import { AsyncProcessGitRunner, type AsyncGitRunner } from '../runtime/git-command';
import { isInsidePath } from './workspace-path';

/**
 * F-981: o guard "um escritor por checkout" olha a worktree Git REAL em que o
 * pane vai rodar. Um `cwd` dentro do workspace cuja raiz Git é OUTRA worktree
 * ligada ao mesmo repositório (ex.: `.harvest/<nome>` criada pelo Maestro)
 * vira um escopo de execução próprio: o pane roda lá e não disputa a vez com
 * os writers do checkout. Submódulo ou repositório aninhado (diretório Git
 * comum diferente) não conta; qualquer dúvida devolve `undefined` e o spawn
 * segue o caminho de sempre.
 */
export interface NestedWorktreeExecution {
  readonly scope: ProjectExecutionScope;
  readonly cwd: string;
}

let sharedGit: AsyncGitRunner | undefined;

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

async function gitPath(git: AsyncGitRunner, cwd: string, args: readonly string[]): Promise<string | null> {
  const result = await git.run(cwd, args, { allowFailure: true });
  return result.status === 0 ? realpathOrNull(result.stdout.trim()) : null;
}

export async function nestedWorktreeExecution(
  execution: ProjectExecutionScope,
  requestedCwd: string | undefined,
  git: AsyncGitRunner = (sharedGit ??= new AsyncProcessGitRunner()),
): Promise<NestedWorktreeExecution | undefined> {
  if (!requestedCwd) return undefined;
  const root = execution.rootRealPath;
  const candidate = path.isAbsolute(requestedCwd) ? path.resolve(requestedCwd) : path.resolve(root, requestedCwd);
  if (!isInsidePath(root, candidate)) return undefined;
  const cwd = realpathOrNull(candidate);
  if (!cwd || cwd === root || !isInsidePath(root, cwd) || !fs.statSync(cwd).isDirectory()) return undefined;
  const topLevel = await gitPath(git, cwd, ['rev-parse', '--show-toplevel']);
  if (!topLevel || topLevel === root || !isInsidePath(root, topLevel)) return undefined;
  const commonArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
  const [ours, theirs] = await Promise.all([gitPath(git, root, commonArgs), gitPath(git, topLevel, commonArgs)]);
  if (!ours || ours !== theirs) return undefined;
  return { scope: rootScope(execution, topLevel), cwd };
}

function rootScope(execution: ProjectExecutionScope, topLevel: string): ProjectExecutionScope {
  const stat = fs.statSync(topLevel, { bigint: true });
  return Object.freeze({
    ...execution,
    rootRealPath: topLevel,
    workspaceRootDevice: stat.dev.toString(),
    workspaceRootInode: stat.ino.toString(),
  });
}

/**
 * F-1229: a fila de comando pesado é a raiz Git REAL onde o job roda — o
 * checkout ou uma worktree ligada, mesmo fora do workspace —, não a raiz do
 * token do pane. Subagentes de um pane, cada um na sua worktree, herdam o
 * mesmo token e caíam todos na fila do checkout até estourar os 300 s (exit
 * 74). Só vale raiz DESTE repositório (git common-dir igual ao da raiz de
 * execução); outro repositório, pasta sem Git ou qualquer dúvida devolve
 * `undefined` e o chamador fica no escopo do token. RAM/CPU continuam sendo
 * limites da máquina: a raiz só decide quem divide saídas e caches.
 */
export async function sameRepositoryExecutionRoot(
  execution: ProjectExecutionScope,
  cwd: string,
  git: AsyncGitRunner = (sharedGit ??= new AsyncProcessGitRunner()),
): Promise<ProjectExecutionScope | undefined> {
  const real = path.isAbsolute(cwd) ? realpathOrNull(cwd) : null;
  const topLevel = real ? await gitPath(git, real, ['rev-parse', '--show-toplevel']) : null;
  if (!topLevel || topLevel === execution.rootRealPath) return undefined;
  const commonArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
  const [ours, theirs] = await Promise.all([gitPath(git, execution.rootRealPath, commonArgs), gitPath(git, topLevel, commonArgs)]);
  return ours && ours === theirs ? rootScope(execution, topLevel) : undefined;
}

/**
 * F-981: o worker de missão no checkout descartava o `cwd` pedido em silêncio
 * (rodava na raiz e editava lá). Pasta real dentro da raiz é honrada; o resto
 * é recusado dizendo que o cwd foi descartado e qual é a saída.
 */
export function requestedCwdInside(root: string, requestedCwd: string | undefined): string | undefined {
  if (!requestedCwd) return undefined;
  const candidate = path.isAbsolute(requestedCwd) ? path.resolve(requestedCwd) : path.resolve(root, requestedCwd);
  if (candidate === root) return root;
  const cwd = isInsidePath(root, candidate) ? realpathOrNull(candidate) : null;
  if (cwd && isInsidePath(root, cwd) && fs.statSync(cwd).isDirectory()) return cwd;
  throw new Error(
    `cwd descartado: ${requestedCwd} não é uma pasta dentro de ${root} nem a raiz de outra worktree Git ` +
      'deste repositório. O worker de missão roda no checkout/worktree da missão; para trabalhar em ' +
      'outra worktree, use isolatedWriter:true (worktree/branch própria criada pelo Nexus) ou passe a raiz ' +
      'de uma worktree ligada a este repositório.',
  );
}
