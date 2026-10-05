import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listProcessCwds, type ProcessCwdExec } from './process-cwds';

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
  it.skipIf(!posix)('porta real enxerga o cwd de um processo vivo e esquece depois que ele sai', async () => {
    const dir = tmp();
    const child = spawn('sleep', ['30'], { cwd: dir, stdio: 'ignore' });
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      expect(await listProcessCwds({ privateAncestors: [dir] })).toContain(dir);
    } finally {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    const after = await listProcessCwds({ privateAncestors: [dir] });
    expect(after).not.toBeNull();
    expect(after).not.toContain(dir);
  });

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
});
