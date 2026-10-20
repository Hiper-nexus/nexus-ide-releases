import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeDirectoryUnusedByRename, restoreStrandedProbe } from './directory-in-use-probe';

const noSleep = async () => undefined;

describe('sonda de uso por renomeação (Windows)', () => {
  it('renomeia e desfaz: pasta livre fica no mesmo lugar, com o conteúdo', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-probe-')));
    try {
      const target = path.join(dir, 'worktree');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'a.txt'), 'a');
      expect(await probeDirectoryUnusedByRename(target)).toBe(true);
      expect(fs.readFileSync(path.join(target, 'a.txt'), 'utf8')).toBe('a');
      expect(fs.readdirSync(dir)).toEqual(['worktree']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recusa da renomeação (EBUSY/EPERM do NTFS) = em uso', async () => {
    const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    await expect(probeDirectoryUnusedByRename('C:\\wt', {
      rename: async () => { throw busy; },
    })).resolves.toBe(false);
  });

  it('desfazer tenta de novo (antivírus no meio) e só então dá a pasta como livre', async () => {
    const calls: Array<[string, string]> = [];
    let failures = 2;
    const free = await probeDirectoryUnusedByRename('C:\\wt', {
      suffix: () => 's',
      sleep: noSleep,
      rename: async (from, to) => {
        calls.push([from, to]);
        if (from.endsWith('-s') && failures-- > 0) throw new Error('EPERM');
      },
    });
    expect(free).toBe(true);
    expect(calls[0]).toEqual(['C:\\wt', 'C:\\wt.nexus-gc-probe-s']);
    expect(calls.at(-1)).toEqual(['C:\\wt.nexus-gc-probe-s', 'C:\\wt']);
    expect(calls).toHaveLength(4);
  });

  it('sem conseguir desfazer, lança com os dois caminhos (nunca dá como livre)', async () => {
    await expect(probeDirectoryUnusedByRename('C:\\wt', {
      suffix: () => 's',
      sleep: noSleep,
      rename: async (from) => { if (from.endsWith('-s')) throw new Error('EPERM'); },
    })).rejects.toThrow(/C:\\wt\.nexus-gc-probe-s.*C:\\wt/);
  });
});

describe('pasta presa no nome da sonda', () => {
  it('devolve a pasta ao lugar quando só existe a sobra', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-probe-strand-')));
    try {
      const target = path.join(dir, 'wt');
      fs.mkdirSync(`${target}.nexus-gc-probe-1-a`);
      fs.writeFileSync(path.join(`${target}.nexus-gc-probe-1-a`, 'a.txt'), 'trabalho');
      expect(await restoreStrandedProbe(target)).toBe('restored');
      expect(fs.readFileSync(path.join(target, 'a.txt'), 'utf8')).toBe('trabalho');
      expect(await restoreStrandedProbe(target)).toBe('none');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pasta original de volta E sobra, ou várias sobras: presa (nada é coletado)', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-probe-strand-')));
    try {
      const target = path.join(dir, 'wt');
      fs.mkdirSync(target);
      fs.mkdirSync(`${target}.nexus-gc-probe-1-a`);
      expect(await restoreStrandedProbe(target)).toBe('stranded');
      fs.rmdirSync(target);
      fs.mkdirSync(`${target}.nexus-gc-probe-2-b`);
      expect(await restoreStrandedProbe(target)).toBe('stranded');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
