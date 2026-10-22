import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeLsofName, listProcessCwds, type ProcessCwdExec } from './process-cwds';
import { skipIfCwdProbeDeniedBySandbox } from '../../test/cwd-probe-sandbox';

const temps: string[] = [];
/** mkdtemp cria 0700 do próprio usuário: serve de ancestral privado. */
function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-process-cwds-')));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.chmodSync(dir, 0o700);
    for (const entry of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, entry), 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const posix = process.platform === 'darwin' || process.platform === 'linux';

describe('F-908: cwd atual dos processos', () => {
  /**
   * Primeira PROVA da porta real. `null` é "sem prova" pelo contrato: sob
   * carga, um processo do mesmo uid nasce entre o `ps` e o `lsof` e a amostra
   * não vale. Re-amostra só nesse caso; a asserção é sobre a prova obtida.
   */
  const firstProof = (dir: string) => vi.waitFor(async () => {
    const cwds = await listProcessCwds({ privateAncestors: [dir] });
    if (cwds === null) throw new Error('sem prova nesta amostra (processo nascendo/saindo entre ps e lsof)');
    return cwds;
  }, { timeout: 45_000, interval: 50 });

  it.skipIf(!posix)('porta real enxerga o cwd de um processo vivo e esquece depois que ele sai', async (context) => {
    skipIfCwdProbeDeniedBySandbox(context);
    const dir = tmp();
    // Vive mais que a espera pela prova; a saída é observada desde o spawn.
    const child = spawn('sleep', ['600'], { cwd: dir, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      expect(await firstProof(dir)).toContain(dir);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    expect(await firstProof(dir)).not.toContain(dir);
  }, 120_000);

  describe('darwin com ps/lsof falsos', () => {
    const fake = (ps: string, lsof: string, status: { ps?: number | null; lsof?: number | null } = {}) => {
      const exec: ProcessCwdExec = async (command) => command.endsWith('/ps')
        ? { status: 'ps' in status ? status.ps ?? null : 0, stdout: ps }
        : { status: 'lsof' in status ? status.lsof ?? null : 1, stdout: lsof };
      return exec;
    };
    const base = { platform: 'darwin' as const, uid: 501, isAlive: () => true };

    it('lê os cwds quando todo processo do uid tem cwd conhecido', async () => {
      const dir = tmp();
      expect(await listProcessCwds({ ...base, uid: process.getuid!(), privateAncestors: [dir],
        exec: fake(`1 ${process.getuid!()}\n2 ${process.getuid!()}\n9 0\n`, 'p1\nn/a b\np2\nn/c\n') })).toEqual(['/a b', '/c']);
    });

    it('processo vivo do mesmo uid sem cwd invalida a prova; morto entre as leituras, não', async () => {
      const dir = tmp();
      const opts = { ...base, uid: process.getuid!(), privateAncestors: [dir], exec: fake(`1 ${process.getuid!()}\n7 ${process.getuid!()}\n`, 'p1\nn/a\n') };
      expect(await listProcessCwds(opts)).toBeNull();
      expect(await listProcessCwds({ ...opts, isAlive: (pid) => pid !== 7 })).toEqual(['/a']);
      // Zumbi do mesmo uid (filho que saiu e não foi colhido) não invalida.
      expect(await listProcessCwds({ ...opts,
        exec: fake(`1 ${process.getuid!()} S\n7 ${process.getuid!()} Z\n`, 'p1\nn/a\n') })).toEqual(['/a']);
      expect(await listProcessCwds({ ...opts, exec: fake(`1 ${process.getuid!()}\n`, 'p1\nn (readlink: Permission denied)\n') }))
        .toBeNull();
    });

    it('outros uids só são ignorados com ancestral 0700 do próprio usuário', async () => {
      const open = tmp();
      fs.chmodSync(open, 0o755);
      const exec = fake('1\n', 'p1\nn/a\n');
      expect(await listProcessCwds({ ...base, uid: process.getuid!(), privateAncestors: [open], exec })).toBeNull();
      expect(await listProcessCwds({ ...base, uid: process.getuid!(), exec })).toBeNull();
      expect(await listProcessCwds({ ...base, uid: process.getuid!() + 1, privateAncestors: [tmp()], exec }))
        .toBeNull();
    });

    it('caminho não ASCII escapado pelo lsof volta a UTF-8', async () => {
      expect(decodeLsofName('/Users/jo\\xc3\\xa3o/task-a\\xc3\\xa7\\xc3\\xa3o')).toBe('/Users/joão/task-ação');
      expect(decodeLsofName('/a\\\\b/c')).toBe('/a\\b/c');
      expect(decodeLsofName('/já/utf8')).toBe('/já/utf8');
      expect(decodeLsofName('/\u{1F600}/a\\xc3\\xa7')).toBe('/\u{1F600}/aç');
      const dir = tmp();
      const uid = process.getuid!();
      expect(await listProcessCwds({ ...base, uid, privateAncestors: [dir],
        exec: fake(`1 ${uid} S\n`, 'p1\nn/w/task-a\\xc3\\xa7\\xc3\\xa3o\n') })).toEqual(['/w/task-ação']);
    });

    it('timeout/falha de ps ou lsof é sem prova', async () => {
      const dir = tmp();
      const opts = { ...base, uid: process.getuid!(), privateAncestors: [dir] };
      expect(await listProcessCwds({ ...opts, exec: fake('1\n', 'p1\nn/a\n', { lsof: null }) })).toBeNull();
      expect(await listProcessCwds({ ...opts, exec: fake('', 'p1\nn/a\n', { ps: 1 }) })).toBeNull();
      expect(await listProcessCwds({ ...opts, exec: async () => { throw new Error('spawn'); } })).toBeNull();
    });
  });

  it.skipIf(!posix || process.getuid?.() === 0)('procfs: cwd ilegível do mesmo uid invalida a prova', async () => {
    const proc = tmp();
    fs.mkdirSync(path.join(proc, '42'));
    fs.symlinkSync('/srv/work', path.join(proc, '42', 'cwd'));
    fs.mkdirSync(path.join(proc, 'self'));
    const opts = { platform: 'linux' as const, procRoot: proc, privateAncestors: [proc] };
    expect(await listProcessCwds(opts)).toEqual(['/srv/work']);
    fs.mkdirSync(path.join(proc, '43'));
    fs.chmodSync(path.join(proc, '43'), 0o000);
    expect(await listProcessCwds(opts)).toBeNull();
    expect(await listProcessCwds({ ...opts, procRoot: path.join(proc, 'ausente') })).toBeNull();
    expect(await listProcessCwds({ platform: 'win32' })).toBeNull();
  });

  describe('procfs: o par systemd --user e (sd-pam) do próprio usuário', () => {
    // Medido no runner Linux do GitHub (22/10): os únicos processos do uid
    // com cwd ilegível. Aqui o cwd é um arquivo comum, então o readlink falha
    // (EINVAL) como o EACCES real, enquanto comm, stat e cmdline são legíveis,
    // como no procfs de verdade.
    const procWith = (entries: ReadonlyArray<{ pid: number; comm?: string; ppid?: number; args?: string[]; cwd?: string }>) => {
      const proc = tmp();
      for (const entry of entries) {
        const dir = path.join(proc, String(entry.pid));
        fs.mkdirSync(dir);
        if (entry.cwd) fs.symlinkSync(entry.cwd, path.join(dir, 'cwd'));
        else fs.writeFileSync(path.join(dir, 'cwd'), '');
        if (entry.comm !== undefined) {
          fs.writeFileSync(path.join(dir, 'comm'), `${entry.comm}\n`);
          fs.writeFileSync(path.join(dir, 'stat'), `${entry.pid} (${entry.comm}) S ${entry.ppid ?? 1} ${entry.pid} 0 0 -1`);
          fs.writeFileSync(path.join(dir, 'cmdline'), `${(entry.args ?? []).join('\0')}\0`);
        }
      }
      return proc;
    };
    const probe = (proc: string) => listProcessCwds({ platform: 'linux', procRoot: proc, privateAncestors: [proc] });
    const manager = { pid: 876, comm: 'systemd', ppid: 1, args: ['/usr/lib/systemd/systemd', '--user'] };
    const sdPam = { pid: 889, comm: '(sd-pam)', ppid: 876, args: ['(sd-pam)'] };
    const shell = { pid: 1798, cwd: '/home/runner/work' };

    it.skipIf(!posix || process.getuid?.() === 0)('o par ilegível não derruba a prova dos outros processos', async () => {
      expect(await probe(procWith([manager, sdPam, shell]))).toEqual(['/home/runner/work']);
    });

    it.skipIf(!posix || process.getuid?.() === 0)('qualquer outro cwd ilegível do mesmo uid continua sem prova', async () => {
      // (sd-pam) cujo pai não é o gerenciador: o nome sozinho não basta.
      expect(await probe(procWith([{ ...sdPam, ppid: 1798 }, shell]))).toBeNull();
      // Gerenciador sem `--user` ou fora do PID 1.
      expect(await probe(procWith([{ ...manager, args: ['/usr/lib/systemd/systemd'] }, shell]))).toBeNull();
      expect(await probe(procWith([{ ...manager, ppid: 1798 }, sdPam, shell]))).toBeNull();
      // Um dev server não-dumpable (node com setcap) dentro da worktree.
      expect(await probe(procWith([manager, sdPam, shell, { pid: 2400, comm: 'node', ppid: 1798, args: ['node', 'dev.js'] }]))).toBeNull();
      // Sem comm/stat/cmdline legíveis não há como reconhecer o par.
      expect(await probe(procWith([{ pid: 876 }, shell]))).toBeNull();
    });
  });
});
