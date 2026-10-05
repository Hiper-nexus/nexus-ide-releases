import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * F-908: diretório ATUAL de cada processo da máquina — prova de "fora de uso"
 * da coleta de worktrees. O cwd de spawn das sessões não basta: um shell que
 * fez `cd` para dentro da worktree, um editor ou um dev server continuam vivos
 * lá. `null` = sem prova (erro, timeout, plataforma sem suporte, cwd
 * desconhecido) e quem chama mantém a worktree.
 *
 * cwd desconhecido de processo do MESMO uid sempre invalida a prova. Os de
 * outro uid (que o lsof nem lista e o procfs não deixa ler) só podem ser
 * ignorados quando um ancestral da worktree é diretório 0700 do próprio
 * usuário: sem root, outro usuário não entra nele.
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
  /** Ancestrais da worktree; basta um ser 0700 do próprio usuário. */
  readonly privateAncestors?: readonly string[];
  readonly uid?: number;
  readonly isAlive?: (pid: number) => boolean;
}

const PS_BIN = '/bin/ps';
const LSOF_BIN = '/usr/sbin/lsof';
const TIMEOUT_MS = 20_000;

const defaultExec: ProcessCwdExec = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(command, [...args], {
      encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout) => {
      const failure = error as (Error & { code?: unknown; killed?: boolean }) | null;
      const status = !failure ? 0 : typeof failure.code === 'number' && !failure.killed ? failure.code : null;
      resolve({ status, stdout: stdout ?? '' });
    });
  });

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function privateDirectory(dir: string, uid: number): Promise<boolean> {
  const stat = await fs.promises.lstat(dir).catch(() => null);
  return !!stat && stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0;
}

export async function listProcessCwds(deps: ProcessCwdDeps = {}): Promise<readonly string[] | null> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') return null;
  const uid = deps.uid ?? process.getuid?.();
  if (uid === undefined) return null;
  try {
    const foreignIgnorable = (await Promise.all(
      (deps.privateAncestors ?? []).map((dir) => privateDirectory(dir, uid)))).some(Boolean);
    if (platform === 'darwin') {
      // Outros uids nunca aparecem no lsof sem root: só com ancestral privado.
      if (!foreignIgnorable) return null;
      const exec = deps.exec ?? defaultExec;
      // uid EFETIVO (o critério do lsof -u): `ps -U` é o real e traria, por
      // exemplo, o /usr/bin/login de cada terminal, que roda como root.
      const ps = await exec(PS_BIN, ['-A', '-o', 'pid=,uid=,stat='], TIMEOUT_MS);
      if (ps.status !== 0) return null;
      const lsof = await exec(LSOF_BIN, ['-a', '-d', 'cwd', '-u', String(uid), '-Fpn'], TIMEOUT_MS);
      // lsof sai com 1 quando algo não foi lido; o cruzamento abaixo decide.
      if (lsof.status === null) return null;
      const cwdByPid = new Map<number, string>();
      let pid = 0;
      for (const line of lsof.stdout.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        else if (line.startsWith('n')) cwdByPid.set(pid, line.slice(1));
      }
      const isAlive = deps.isAlive ?? defaultIsAlive;
      // Processo do mesmo uid, vivo, sem cwd absoluto no lsof: desconhecido.
      // Zumbi (stat Z: o filho `git` que acabou de sair e ainda não foi
      // colhido) não tem cwd nem roda nada: não conta.
      for (const row of ps.stdout.split('\n')) {
        const [pidText, uidText, stat = ''] = row.trim().split(/\s+/);
        const own = Number(pidText);
        if (Number(uidText) !== uid || !(own > 0) || stat.startsWith('Z')) continue;
        if (!cwdByPid.get(own)?.startsWith('/') && isAlive(own)) return null;
      }
      const cwds = [...cwdByPid.values()].filter((cwd) => cwd.startsWith('/'));
      return cwds.length > 0 ? cwds : null;
    }
    const procRoot = deps.procRoot ?? '/proc';
    const pids = (await fs.promises.readdir(procRoot)).filter((name) => /^\d+$/.test(name));
    const cwds: string[] = [];
    for (const pid of pids) {
      const dir = path.join(procRoot, pid);
      try {
        cwds.push(await fs.promises.readlink(path.join(dir, 'cwd')));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ESRCH') continue;
        const owner = await fs.promises.stat(dir).then((stat) => stat.uid, () => undefined);
        if (owner === undefined) continue;
        if (owner === uid || !foreignIgnorable) return null;
      }
    }
    return cwds.length > 0 ? cwds : null;
  } catch {
    return null;
  }
}
