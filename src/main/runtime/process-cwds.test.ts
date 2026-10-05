import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listProcessCwds } from './process-cwds';

const temps: string[] = [];
function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-process-cwds-')));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('F-908: cwd atual dos processos', () => {
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'porta real enxerga o cwd de um processo vivo e esquece depois que ele sai',
    async () => {
      const dir = tmp();
      const child = spawn('sleep', ['30'], { cwd: dir, stdio: 'ignore' });
      try {
        await new Promise((resolve) => child.once('spawn', resolve));
        expect(await listProcessCwds()).toContain(dir);
      } finally {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      expect(await listProcessCwds()).not.toContain(dir);
    },
  );

  it('lsof falso: lê só as linhas n/, aceita saída parcial e sem prova devolve null', async () => {
    const lsof = (status: number | null, stdout: string) => async () => ({ status, stdout });
    expect(await listProcessCwds({ platform: 'darwin', exec: lsof(1, 'p1\nfcwd\nn/a b\np2\nfcwd\nn/c\n') }))
      .toEqual(['/a b', '/c']);
    expect(await listProcessCwds({ platform: 'darwin', exec: lsof(null, 'n/a\n') })).toBeNull();
    expect(await listProcessCwds({ platform: 'darwin', exec: lsof(1, '') })).toBeNull();
    expect(await listProcessCwds({ platform: 'darwin', exec: async () => { throw new Error('spawn'); } }))
      .toBeNull();
  });

  it('procfs falso no linux; win32 nunca tem prova', async () => {
    const proc = tmp();
    fs.mkdirSync(path.join(proc, '42'));
    fs.symlinkSync('/srv/work', path.join(proc, '42', 'cwd'));
    fs.mkdirSync(path.join(proc, '43'));
    fs.mkdirSync(path.join(proc, 'self'));
    expect(await listProcessCwds({ platform: 'linux', procRoot: proc })).toEqual(['/srv/work']);
    expect(await listProcessCwds({ platform: 'linux', procRoot: path.join(proc, 'ausente') })).toBeNull();
    expect(await listProcessCwds({ platform: 'win32' })).toBeNull();
  });
});
