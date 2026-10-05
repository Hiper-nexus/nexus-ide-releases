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
      // App aberto pelo Finder não tem LANG; sem localidade o lsof escapa
      // byte não ASCII (`\xNN`). A decodificação abaixo cobre os dois casos.
      env: { ...process.env, LC_ALL: 'en_US.UTF-8' },
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

/**
 * Nome como o lsof imprime: `\xNN` é um byte e `\\` uma barra invertida.
 * Os bytes voltam a UTF-8, senão `/Users/joão` nunca casaria com a worktree
 * e o processo vivo contaria como ausente.
 */
export function decodeLsofName(name: string): string {
  if (!name.includes('\\')) return name;
  const bytes: number[] = [];
  // Por code point (não por unidade UTF-16): caractere fora do plano básico
  // no mesmo nome não se parte ao virar bytes.
  const chars = [...name];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (char === '\\' && chars[index + 1] === '\\') {
      bytes.push(0x5c);
      index += 1;
    } else if (char === '\\' && chars[index + 1] === 'x' && /^[0-9a-f]{2}$/i.test(chars.slice(index + 2, index + 4).join(''))) {
      bytes.push(parseInt(chars.slice(index + 2, index + 4).join(''), 16));
      index += 3;
    } else {
      bytes.push(...Buffer.from(char, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
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
        else if (line.startsWith('n')) cwdByPid.set(pid, decodeLsofName(line.slice(1)));
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
