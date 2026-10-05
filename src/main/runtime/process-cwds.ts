import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * F-908: diretório ATUAL de cada processo da máquina — prova de "fora de uso"
 * da coleta de worktrees paradas. O cwd de spawn das sessões não basta: um
 * shell que fez `cd` para dentro da worktree, um editor ou um dev server
 * continuam vivos lá. `null` = sem prova (erro, timeout, plataforma sem
 * suporte) e quem chama mantém a worktree.
 */
export type ProcessCwdExec = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ readonly status: number | null; readonly stdout: string }>;

export interface ProcessCwdDeps {
  readonly platform?: NodeJS.Platform;
  readonly exec?: ProcessCwdExec;
  /** Linux: raiz do procfs (testes usam uma árvore falsa). */
  readonly procRoot?: string;
}

const LSOF_BIN = '/usr/sbin/lsof';
const LSOF_TIMEOUT_MS = 20_000;

const defaultExec: ProcessCwdExec = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(command, [...args], {
      encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout) => {
      const code = (error as (Error & { code?: unknown; killed?: boolean }) | null)?.code;
      const status = !error ? 0 : typeof code === 'number' && !(error as { killed?: boolean }).killed ? code : null;
      resolve({ status, stdout: stdout ?? '' });
    });
  });

export async function listProcessCwds(deps: ProcessCwdDeps = {}): Promise<readonly string[] | null> {
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === 'darwin') {
      const result = await (deps.exec ?? defaultExec)(LSOF_BIN, ['-a', '-d', 'cwd', '-Fn'], LSOF_TIMEOUT_MS);
      // lsof sai com 1 quando não lê processos de outro usuário, mas lista os
      // demais; sem status (timeout/spawn) ou sem nenhuma linha, não há prova.
      if (result.status === null) return null;
      const cwds = result.stdout.split('\n').filter((line) => line.startsWith('n/')).map((line) => line.slice(1));
      return cwds.length > 0 ? cwds : null;
    }
    if (platform === 'linux') {
      const procRoot = deps.procRoot ?? '/proc';
      const pids = (await fs.promises.readdir(procRoot)).filter((name) => /^\d+$/.test(name));
      const cwds = await Promise.all(pids.map((pid) =>
        fs.promises.readlink(path.join(procRoot, pid, 'cwd')).catch(() => null)));
      const found = cwds.filter((cwd): cwd is string => cwd !== null);
      return found.length > 0 ? found : null;
    }
  } catch {
    return null;
  }
  return null;
}
