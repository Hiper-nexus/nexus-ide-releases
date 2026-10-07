import fs from 'node:fs';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import { AsyncProcessGitRunner, type AsyncGitRunner } from '../runtime/git-command';
import { isInsidePath } from './workspace-path';

/**
 * F-955: o guard "um escritor por checkout" olha a worktree Git REAL em que o
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
  const stat = fs.statSync(topLevel, { bigint: true });
  return {
    scope: Object.freeze({
      ...execution,
      rootRealPath: topLevel,
      workspaceRootDevice: stat.dev.toString(),
      workspaceRootInode: stat.ino.toString(),
    }),
    cwd,
  };
}

/**
 * F-955: o worker de missão no checkout descartava o `cwd` pedido em silêncio
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
