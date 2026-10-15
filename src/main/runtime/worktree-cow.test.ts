import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cloneHeavyDir,
  copyBuildCaches,
  cowCopyHeavyDirs,
  cowCopyHeavyDirsSync,
  cowWorktreeAvailable,
  discoverNestedCowDirs,
  discoverTsbuildinfoFiles,
  findLockfile,
  linkHeavyDirs,
  lockfilesMatch,
  materializeGitWorktree,
  tryClonefileCopy,
  tryClonefileCopySync,
  type ClonefileExecSync,
} from './worktree-cow';

const darwin = process.platform === 'darwin';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cow-'));
}

/** src/<rel>/arquivo com conteúdo — árvore pequena para clone real. */
function makeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/** cp -cR injetado que materializa o dest como o cp real faria. */
function cpExecImpl(
  calls: string[][],
): (cmd: string, args: readonly string[]) => Promise<{ status: number }> {
  return async (_cmd, args) => {
    calls.push([...args]);
    fs.cpSync(args[args.length - 2], args[args.length - 1], {
      recursive: true,
    });
    return { status: 0 };
  };
}

/** osascript injetado que materializa o dest como o clonefile real faria. */
function osaExecImpl(
  calls: string[][],
  stdout = '0\n',
  status: number | null = 0,
): (cmd: string, args: readonly string[]) => Promise<{
  status: number | null;
  stdout: string;
}> {
  return async (_cmd, args) => {
    calls.push([...args]);
    if (stdout.trim() === '0' && status === 0) {
      fs.cpSync(args[args.length - 2], args[args.length - 1], {
        recursive: true,
      });
    }
    return { status, stdout };
  };
}

describe('worktree-cow', () => {
  it('reports cow availability on darwin unless disabled', () => {
    const prev = process.env.NEXUS_COW_WORKTREE;
    delete process.env.NEXUS_COW_WORKTREE;
    expect(cowWorktreeAvailable('darwin')).toBe(true);
    expect(cowWorktreeAvailable('linux')).toBe(false);
    process.env.NEXUS_COW_WORKTREE = '0';
    expect(cowWorktreeAvailable('darwin')).toBe(false);
    if (prev === undefined) delete process.env.NEXUS_COW_WORKTREE;
    else process.env.NEXUS_COW_WORKTREE = prev;
  });

  it('tryClonefileCopy returns false on non-darwin without running cp', async () => {
    if (process.platform === 'darwin') {
      expect(typeof tryClonefileCopy).toBe('function');
      return;
    }
    expect(await tryClonefileCopy('/tmp/a', '/tmp/b')).toBe(false);
  });

  it('materializeGitWorktree uses git worktree add then reports method', async () => {
    const run = vi.fn().mockReturnValue({ status: 0, stdout: fs.realpathSync(os.tmpdir()), stderr: '' });
    const result = await materializeGitWorktree({
      repositoryRoot: '/repo',
      worktreePath: `/tmp/nexus-cow-test-${Date.now()}-missing`,
      branchRef: 'refs/heads/nexus/task-1',
      headSha: 'abc123',
      git: { run } as never,
      cowDirs: [], // skip clonefile side effects in unit test
    });
    expect(run).toHaveBeenCalledWith('/repo', [
      'worktree',
      'add',
      '-b',
      'nexus/task-1',
      expect.stringContaining('nexus-cow-test'),
      'abc123',
    ]);
    expect(result.method).toBe('git-worktree');
    expect(result.cowCopied).toEqual([]);
    // F-215: tempos por etapa — ids/números apenas.
    expect(typeof result.gitWorktreeMs).toBe('number');
    expect(result.gitWorktreeMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.cowMs).toBe('number');
    expect(result.cowMs).toBeGreaterThanOrEqual(0);
  });

  it('cowCopyHeavyDirs returns empty when CoW disabled', async () => {
    const prev = process.env.NEXUS_COW_WORKTREE;
    process.env.NEXUS_COW_WORKTREE = '0';
    expect(await cowCopyHeavyDirs('/a', '/b')).toEqual([]);
    if (prev === undefined) delete process.env.NEXUS_COW_WORKTREE;
    else process.env.NEXUS_COW_WORKTREE = prev;
  });

  it('tryClonefileCopy accepts an async exec injectable', async () => {
    if (process.platform !== 'darwin') return;
    const exec = vi.fn(async () => ({ status: 1 }));
    expect(
      await tryClonefileCopy(
        '/tmp/nexus-cow-missing-src',
        '/tmp/nexus-cow-missing-dest',
        exec,
      ),
    ).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe.skipIf(!darwin)('F-215 — clonefile direto via osascript', () => {
  it('fast path vence: chama /usr/bin/osascript e nunca cp', async () => {
    const root = tmpRoot();
    const src = path.join(root, 'repo', 'node_modules');
    const dest = path.join(root, 'wt', 'node_modules');
    makeTree(src, { 'pkg/index.js': 'x' });
    const cpCalls: string[][] = [];
    const osaCalls: string[][] = [];
    const ok = await tryClonefileCopy(
      src,
      dest,
      cpExecImpl(cpCalls),
      osaExecImpl(osaCalls),
    );
    expect(ok).toBe(true);
    expect(cpCalls).toEqual([]);
    expect(osaCalls).toHaveLength(1);
    const argv = osaCalls[0];
    expect(argv[0]).toBe('-l');
    expect(argv[1]).toBe('JavaScript');
    expect(argv[2]).toBe('-e');
    expect(argv[3]).toContain('clonefile');
    // src/dest vão como argv separado — nunca interpolados no script.
    expect(argv[4]).toBe(src);
    expect(argv[5]).toBe(dest);
    expect(fs.existsSync(path.join(dest, 'pkg', 'index.js'))).toBe(true);
  });

  it.each([
    ['stdout "-1" (dest já existe)', '-1\n', 0],
    ['exit não-zero', '0\n', 1],
    ['timeout (status null)', '', null],
  ])(
    'falha do fast path (%s) remove dest parcial e cai no cp -cR',
    async (_label, stdout, status) => {
      const root = tmpRoot();
      const src = path.join(root, 'repo', 'node_modules');
      const dest = path.join(root, 'wt', 'node_modules');
      makeTree(src, { 'pkg/index.js': 'x' });
      const cpCalls: string[][] = [];
      const osaCalls: string[][] = [];
      const osa = osaExecImpl(osaCalls, stdout, status);
      // Simula resto parcial que o clonefile podia ter deixado.
      const osaWithPartial = async (cmd: string, args: readonly string[]) => {
        fs.mkdirSync(path.join(args[args.length - 1], 'partial'), {
          recursive: true,
        });
        return osa(cmd, args);
      };
      const ok = await tryClonefileCopy(
        src,
        dest,
        cpExecImpl(cpCalls),
        osaWithPartial,
      );
      expect(ok).toBe(true);
      expect(osaCalls).toHaveLength(1);
      expect(cpCalls).toEqual([['-cR', src, dest]]);
      // O dest final é o do cp, sem o 'partial' do fast path falho.
      expect(fs.existsSync(path.join(dest, 'pkg', 'index.js'))).toBe(true);
      expect(fs.existsSync(path.join(dest, 'partial'))).toBe(false);
    },
  );

  it('argv com espaços e aspas passa verbatim como args separados', async () => {
    const root = tmpRoot();
    const src = path.join(root, `repo dir's`, 'node_modules');
    const dest = path.join(root, 'wt dir "quoted"', 'node_modules');
    makeTree(src, { 'pkg/index.js': 'x' });
    const osaCalls: string[][] = [];
    const ok = await tryClonefileCopy(
      src,
      dest,
      cpExecImpl([]),
      osaExecImpl(osaCalls),
    );
    expect(ok).toBe(true);
    // Sem re-quoting: exatamente dois args distintos com os caminhos.
    expect(osaCalls[0][4]).toBe(src);
    expect(osaCalls[0][5]).toBe(dest);
    expect(fs.existsSync(path.join(dest, 'pkg', 'index.js'))).toBe(true);
  });

  it('NEXUS_COW_DIRECTORY_CLONE=0 força o caminho antigo do cp -cR', async () => {
    const root = tmpRoot();
    const src = path.join(root, 'repo', 'node_modules');
    const dest = path.join(root, 'wt', 'node_modules');
    makeTree(src, { 'pkg/index.js': 'x' });
    const prev = process.env.NEXUS_COW_DIRECTORY_CLONE;
    process.env.NEXUS_COW_DIRECTORY_CLONE = '0';
    try {
      const cpCalls: string[][] = [];
      const osaCalls: string[][] = [];
      const ok = await tryClonefileCopy(
        src,
        dest,
        cpExecImpl(cpCalls),
        osaExecImpl(osaCalls),
      );
      expect(ok).toBe(true);
      expect(osaCalls).toEqual([]);
      expect(cpCalls).toEqual([['-cR', src, dest]]);
    } finally {
      if (prev === undefined) delete process.env.NEXUS_COW_DIRECTORY_CLONE;
      else process.env.NEXUS_COW_DIRECTORY_CLONE = prev;
    }
  });

  it('NEXUS_COW_WORKTREE=0 desliga tudo: nenhum exec roda', async () => {
    const root = tmpRoot();
    const src = path.join(root, 'repo', 'node_modules');
    makeTree(src, { 'pkg/index.js': 'x' });
    const prev = process.env.NEXUS_COW_WORKTREE;
    process.env.NEXUS_COW_WORKTREE = '0';
    try {
      const cpCalls: string[][] = [];
      const osaCalls: string[][] = [];
      const copied = await cowCopyHeavyDirs(
        path.join(root, 'repo'),
        path.join(root, 'wt'),
        undefined,
        cpExecImpl(cpCalls),
        osaExecImpl(osaCalls),
      );
      expect(copied).toEqual([]);
      expect(cpCalls).toEqual([]);
      expect(osaCalls).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.NEXUS_COW_WORKTREE;
      else process.env.NEXUS_COW_WORKTREE = prev;
    }
  });

  it('origem symlink pula o osascript e vai direto ao cp -cR', async () => {
    const root = tmpRoot();
    const real = path.join(root, 'repo', 'real_modules');
    makeTree(real, { 'pkg/index.js': 'x' });
    const src = path.join(root, 'repo', 'node_modules');
    fs.symlinkSync(real, src, 'dir');
    const dest = path.join(root, 'wt', 'node_modules');
    const cpCalls: string[][] = [];
    const osaCalls: string[][] = [];
    const ok = await tryClonefileCopy(
      src,
      dest,
      cpExecImpl(cpCalls),
      osaExecImpl(osaCalls),
    );
    // clonefile(2) com flags 0 segue o link; cp -cR copia o link — certo é o cp.
    expect(ok).toBe(true);
    expect(osaCalls).toEqual([]);
    expect(cpCalls).toEqual([['-cR', src, dest]]);
  });

  it('sync twin: origem symlink também pula o osascript', () => {
    const root = tmpRoot();
    const real = path.join(root, 'repo', 'real_modules');
    makeTree(real, { 'pkg/index.js': 'x' });
    const src = path.join(root, 'repo', 'node_modules');
    fs.symlinkSync(real, src, 'dir');
    const dest = path.join(root, 'wt', 'node_modules');
    const cpSync = vi.fn(() => ({ status: 0, stdout: '' }));
    const osaSync = vi.fn(() => ({ status: 0, stdout: '0\n' }));
    tryClonefileCopySync(
      src,
      dest,
      cpSync as unknown as ClonefileExecSync,
      osaSync,
    );
    expect(osaSync).not.toHaveBeenCalled();
    expect(cpSync).toHaveBeenCalledOnce();
  });

  it('materializeGitWorktree só clona aninhado que o git ignora', async () => {
    const root = tmpRoot();
    const repo = path.join(root, 'repo');
    const wt = path.join(root, 'wt');
    makeTree(path.join(repo, 'node_modules'), { 'a/index.js': 'x' });
    makeTree(path.join(repo, 'pkg1'), {
      'package.json': '{}',
      'node_modules/dep/index.js': 'x',
    });
    makeTree(path.join(repo, 'pkg2'), {
      'package.json': '{}',
      'node_modules/dep/index.js': 'x',
    });
    const checked: string[] = [];
    const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: repo, stderr: '' };
      if (args[0] === 'check-ignore') {
        checked.push(args[args.length - 1]);
        return {
          status: args[args.length - 1] === 'pkg2/node_modules' ? 1 : 0,
          stdout: '',
          stderr: '',
        };
      }
      fs.mkdirSync(wt, { recursive: true }); // simula o git worktree add real
      return { status: 0, stdout: '', stderr: '' };
    });
    const result = await materializeGitWorktree({
      repositoryRoot: repo,
      worktreePath: wt,
      branchRef: 'refs/heads/nexus/t',
      headSha: 'abc',
      git: { run } as never,
    });
    expect(run).toHaveBeenCalledWith(
      repo,
      ['check-ignore', '--quiet', 'pkg1/node_modules'],
      { allowFailure: true },
    );
    expect(checked).toEqual(['pkg1/node_modules', 'pkg2/node_modules']);
    expect(result.cowCopied).toEqual(['node_modules', 'pkg1/node_modules']);
    expect(fs.existsSync(path.join(wt, 'pkg2'))).toBe(false);
  });

  it('sync twin usa o mesmo fast path e cai no cp quando ele falha', () => {
    const root = tmpRoot();
    const src = path.join(root, 'repo', 'node_modules');
    const dest = path.join(root, 'wt', 'node_modules');
    makeTree(src, { 'pkg/index.js': 'x' });
    const cpCalls: string[][] = [];
    const osaCalls: string[][] = [];
    const cpSync = vi.fn((_cmd: string, args: readonly string[]) => {
      cpCalls.push([...args]);
      fs.cpSync(args[args.length - 2], args[args.length - 1], {
        recursive: true,
      });
      return { status: 0, stdout: '' };
    });
    const osaSync = vi.fn((_cmd: string, args: readonly string[]) => {
      osaCalls.push([...args]);
      return { status: 1, stdout: '' };
    });
    const ok = tryClonefileCopySync(
      src,
      dest,
      cpSync as unknown as ClonefileExecSync,
      osaSync,
    );
    expect(ok).toBe(true);
    expect(osaCalls).toHaveLength(1);
    expect(osaCalls[0][0]).toBe('-l');
    expect(cpCalls).toEqual([['-cR', src, dest]]);
  });

  it('sync twin vence no fast path sem chamar cp', () => {
    const root = tmpRoot();
    const src = path.join(root, 'repo', 'node_modules');
    const dest = path.join(root, 'wt', 'node_modules');
    makeTree(src, { 'pkg/index.js': 'x' });
    const cpSync = vi.fn(() => ({ status: 0, stdout: '' }));
    const osaSync = vi.fn((_cmd: string, args: readonly string[]) => {
      fs.cpSync(args[args.length - 2], args[args.length - 1], {
        recursive: true,
      });
      return { status: 0, stdout: '0\n' };
    });
    expect(
      tryClonefileCopySync(
        src,
        dest,
        cpSync as unknown as ClonefileExecSync,
        osaSync,
      ),
    ).toBe(true);
    expect(cpSync).not.toHaveBeenCalled();
    expect(osaSync).toHaveBeenCalledOnce();
  });
});

describe.skipIf(!darwin)('F-908 — sem clone APFS, node_modules não é copiado byte a byte', () => {
  // O pai do dest mora noutro volume; a origem, no primeiro.
  const otherVolume = (dest: string) => async (target: string) => (target === path.dirname(dest) ? 2 : 1);

  it('fast path falho em outro volume: pula sem cp e sem dest', async () => {
    const root = tmpRoot();
    const src = path.join(root, 'repo', 'node_modules');
    const dest = path.join(root, 'wt', 'node_modules');
    makeTree(src, { 'pkg/index.js': 'x' });
    const cpCalls: string[][] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await cloneHeavyDir(src, dest, cpExecImpl(cpCalls), osaExecImpl([], '-1\n'), otherVolume(dest)))
        .toEqual({ skipped: 'cross-volume' });
      expect(cpCalls).toEqual([]);
      expect(fs.existsSync(dest)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('outro volume'));
    } finally {
      warn.mockRestore();
    }
  });

  it('NEXUS_COW_DIRECTORY_CLONE=0 em outro volume também pula o cp -cR', async () => {
    const root = tmpRoot();
    const src = path.join(root, 'repo', 'node_modules');
    const dest = path.join(root, 'wt', 'node_modules');
    makeTree(src, { 'pkg/index.js': 'x' });
    const prev = process.env.NEXUS_COW_DIRECTORY_CLONE;
    process.env.NEXUS_COW_DIRECTORY_CLONE = '0';
    const cpCalls: string[][] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await tryClonefileCopy(src, dest, cpExecImpl(cpCalls), osaExecImpl([]), otherVolume(dest))).toBe(false);
      expect(cpCalls).toEqual([]);
    } finally {
      warn.mockRestore();
      if (prev === undefined) delete process.env.NEXUS_COW_DIRECTORY_CLONE;
      else process.env.NEXUS_COW_DIRECTORY_CLONE = prev;
    }
  });

  it('reporta o método efetivo: clonefile no fast path, cp-clone no fallback do mesmo volume', async () => {
    const root = tmpRoot();
    makeTree(path.join(root, 'repo', 'node_modules'), { 'pkg/index.js': 'x' });
    expect(await cloneHeavyDir(path.join(root, 'repo', 'node_modules'), path.join(root, 'wt1', 'node_modules'),
      cpExecImpl([]), osaExecImpl([]))).toEqual({ method: 'clonefile' });
    expect(await cloneHeavyDir(path.join(root, 'repo', 'node_modules'), path.join(root, 'wt2', 'node_modules'),
      cpExecImpl([]), osaExecImpl([], '-1\n'))).toEqual({ method: 'cp-clone' });
  });
});

describe.skipIf(!darwin)('F-215 — descoberta de node_modules aninhados', () => {
  function seedRepo(): { repo: string; wt: string } {
    const root = tmpRoot();
    const repo = path.join(root, 'repo');
    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    makeTree(path.join(repo, 'node_modules'), { 'a/index.js': 'x' });
    return { repo, wt };
  }

  it('descobre pacotes aninhados em profundidade 1 e 2, não 3', () => {
    const { repo, wt } = seedRepo();
    // profundidade 1
    makeTree(path.join(repo, 'pkg1'), {
      'package.json': '{}',
      'node_modules/dep/index.js': 'x',
    });
    // profundidade 2
    makeTree(path.join(repo, 'apps', 'mobile'), {
      'package.json': '{}',
      'node_modules/dep/index.js': 'x',
    });
    // profundidade 3 — fora
    makeTree(path.join(repo, 'a', 'b', 'c'), {
      'package.json': '{}',
      'node_modules/dep/index.js': 'x',
    });
    // sem package.json — não é pacote
    makeTree(path.join(repo, 'docs'), { 'node_modules/x.js': 'x' });
    expect(discoverNestedCowDirs(repo, wt, () => true)).toEqual([
      'apps/mobile/node_modules',
      'pkg1/node_modules',
    ]);
  });

  it('sem predicado isIgnored a descoberta não roda (só a raiz)', async () => {
    const { repo, wt } = seedRepo();
    makeTree(path.join(repo, 'pkg1'), {
      'package.json': '{}',
      'node_modules/dep/index.js': 'x',
    });
    expect(discoverNestedCowDirs(repo, wt)).toEqual([]);
    const copied = await cowCopyHeavyDirs(
      repo,
      wt,
      undefined,
      cpExecImpl([]),
      osaExecImpl([]),
    );
    // Sem prova de "ignorado pelo git" só entra o DEFAULT_COW_DIRS da raiz —
    // clonar um node_modules rastreável sujaria a worktree de untracked.
    expect(copied).toEqual(['node_modules']);
  });

  it('aninhado não ignorado pelo git não é clonado', async () => {
    const { repo, wt } = seedRepo();
    makeTree(path.join(repo, 'pkg1'), {
      'package.json': '{}',
      'node_modules/dep/index.js': 'x',
    });
    const queried: string[] = [];
    const copied = await cowCopyHeavyDirs(
      repo,
      wt,
      undefined,
      cpExecImpl([]),
      osaExecImpl([]),
      (rel) => {
        queried.push(rel);
        return false;
      },
    );
    expect(queried).toEqual(['pkg1/node_modules']);
    expect(copied).toEqual(['node_modules']);
    expect(fs.existsSync(path.join(wt, 'pkg1'))).toBe(false);
  });

  it('aninhado ignorado é clonado e o predicado recebe o rel', async () => {
    const { repo, wt } = seedRepo();
    makeTree(path.join(repo, 'pkg1'), {
      'package.json': '{}',
      'node_modules/dep/index.js': 'x',
    });
    const queried: string[] = [];
    const copied = await cowCopyHeavyDirs(
      repo,
      wt,
      undefined,
      cpExecImpl([]),
      osaExecImpl([]),
      (rel) => {
        queried.push(rel);
        return true;
      },
    );
    expect(queried).toEqual(['pkg1/node_modules']);
    expect(copied).toEqual(['node_modules', 'pkg1/node_modules']);
  });

  it('node_modules aninhado que é symlink não entra na descoberta', () => {
    const { repo, wt } = seedRepo();
    makeTree(path.join(repo, 'real-nm'), { 'dep/index.js': 'x' });
    makeTree(path.join(repo, 'pkg1'), { 'package.json': '{}' });
    fs.symlinkSync(
      path.join(repo, 'real-nm'),
      path.join(repo, 'pkg1', 'node_modules'),
      'dir',
    );
    expect(discoverNestedCowDirs(repo, wt, () => true)).toEqual([]);
  });

  it('pula dot-dirs, árvores node_modules, .worktrees e symlinks', () => {
    const { repo, wt } = seedRepo();
    makeTree(path.join(repo, '.hidden', 'pkg'), {
      'package.json': '{}',
      'node_modules/x.js': 'x',
    });
    makeTree(path.join(repo, '.worktrees', 'wt1'), {
      'package.json': '{}',
      'node_modules/x.js': 'x',
    });
    // node_modules dentro de outra árvore node_modules não conta.
    makeTree(path.join(repo, 'node_modules', 'vendored'), {
      'package.json': '{}',
      'node_modules/x.js': 'x',
    });
    // symlink para pacote real não conta.
    makeTree(path.join(rootOf(repo), 'real-pkg'), {
      'package.json': '{}',
      'node_modules/x.js': 'x',
    });
    fs.symlinkSync(
      path.join(rootOf(repo), 'real-pkg'),
      path.join(repo, 'linked-pkg'),
    );
    expect(discoverNestedCowDirs(repo, wt, () => true)).toEqual([]);
    function rootOf(p: string): string {
      return path.dirname(p);
    }
  });

  it('limita a 8 diretórios descobertos', () => {
    const { repo, wt } = seedRepo();
    for (let i = 0; i < 10; i++) {
      makeTree(path.join(repo, `pkg${String(i).padStart(2, '0')}`), {
        'package.json': '{}',
        'node_modules/x.js': 'x',
      });
    }
    expect(discoverNestedCowDirs(repo, wt, () => true)).toHaveLength(8);
  });

  it('ignora dest que já existe na worktree', () => {
    const { repo, wt } = seedRepo();
    makeTree(path.join(repo, 'pkg1'), {
      'package.json': '{}',
      'node_modules/x.js': 'x',
    });
    makeTree(path.join(wt, 'pkg1', 'node_modules'), { 'x.js': 'y' });
    expect(discoverNestedCowDirs(repo, wt, () => true)).toEqual([]);
  });

  it('cowCopyHeavyDirs copia raiz + aninhados quando dirs omitido', async () => {
    const { repo, wt } = seedRepo();
    makeTree(path.join(repo, 'apps', 'mobile'), {
      'package.json': '{}',
      'node_modules/dep/index.js': 'x',
    });
    const osaCalls: string[][] = [];
    const copied = await cowCopyHeavyDirs(
      repo,
      wt,
      undefined,
      cpExecImpl([]),
      osaExecImpl(osaCalls),
      () => true,
    );
    expect(copied).toEqual(['node_modules', 'apps/mobile/node_modules']);
    expect(
      fs.existsSync(path.join(wt, 'apps/mobile/node_modules/dep/index.js')),
    ).toBe(true);
  });

  it('cowCopyHeavyDirsSync descobre os mesmos aninhados', () => {
    const { repo, wt } = seedRepo();
    makeTree(path.join(repo, 'pkg1'), {
      'package.json': '{}',
      'node_modules/x.js': 'x',
    });
    const osaSync = vi.fn((_cmd: string, args: readonly string[]) => {
      fs.cpSync(args[args.length - 2], args[args.length - 1], {
        recursive: true,
      });
      return { status: 0, stdout: '0\n' };
    });
    const copied = cowCopyHeavyDirsSync(
      repo,
      wt,
      undefined,
      vi.fn(() => ({ status: 0, stdout: '' })) as unknown as ClonefileExecSync,
      osaSync,
      () => true,
    );
    expect(copied).toEqual(['node_modules', 'pkg1/node_modules']);
  });
});

it.skipIf(!darwin)(
  'F-215 real — osascript clonefile numa árvore pequena (mede o tempo)',
  async () => {
    const root = tmpRoot();
    const src = path.join(root, 'repo', 'node_modules');
    const dest = path.join(root, 'wt', 'node_modules');
    makeTree(src, {
      'a/index.js': 'x'.repeat(1024),
      'b/c/deep.txt': 'y',
      'bin/tool': '#!/bin/sh\n',
    });
    const start = performance.now();
    const ok = await tryClonefileCopy(src, dest);
    const elapsed = performance.now() - start;
    console.info(
      `[F-215] clonefile via osascript em árvore pequena: ${elapsed.toFixed(0)} ms`,
    );
    expect(ok).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'a/index.js'), 'utf8')).toBe(
      'x'.repeat(1024),
    );
    expect(fs.existsSync(path.join(dest, 'b/c/deep.txt'))).toBe(true);
  },
);

describe('worktree-cow', () => {
  it('reports cow availability on darwin unless disabled', () => {
    const prev = process.env.NEXUS_COW_WORKTREE;
    delete process.env.NEXUS_COW_WORKTREE;
    expect(cowWorktreeAvailable('darwin')).toBe(true);
    expect(cowWorktreeAvailable('linux')).toBe(false);
    process.env.NEXUS_COW_WORKTREE = '0';
    expect(cowWorktreeAvailable('darwin')).toBe(false);
    if (prev === undefined) delete process.env.NEXUS_COW_WORKTREE;
    else process.env.NEXUS_COW_WORKTREE = prev;
  });

  it('tryClonefileCopy returns false on non-darwin without running cp', async () => {
    if (process.platform === 'darwin') {
      expect(typeof tryClonefileCopy).toBe('function');
      return;
    }
    expect(await tryClonefileCopy('/tmp/a', '/tmp/b')).toBe(false);
  });

  it('materializeGitWorktree uses git worktree add then reports method', async () => {
    const run = vi.fn().mockReturnValue({ status: 0, stdout: fs.realpathSync(os.tmpdir()), stderr: '' });
    const result = await materializeGitWorktree({
      repositoryRoot: '/repo',
      worktreePath: `/tmp/nexus-cow-test-${Date.now()}-missing`,
      branchRef: 'refs/heads/nexus/task-1',
      headSha: 'abc123',
      git: { run } as never,
      cowDirs: [], // skip clonefile side effects in unit test
    });
    expect(run).toHaveBeenCalledWith('/repo', [
      'worktree',
      'add',
      '-b',
      'nexus/task-1',
      expect.stringContaining('nexus-cow-test'),
      'abc123',
    ]);
    expect(result.method).toBe('git-worktree');
    expect(result.cowCopied).toEqual([]);
  });

  it('cowCopyHeavyDirs returns empty when CoW disabled', async () => {
    const prev = process.env.NEXUS_COW_WORKTREE;
    process.env.NEXUS_COW_WORKTREE = '0';
    expect(await cowCopyHeavyDirs('/a', '/b')).toEqual([]);
    if (prev === undefined) delete process.env.NEXUS_COW_WORKTREE;
    else process.env.NEXUS_COW_WORKTREE = prev;
  });

  it('tryClonefileCopy accepts an async exec injectable', async () => {
    if (process.platform !== 'darwin') return;
    const exec = vi.fn(async () => ({ status: 1 }));
    expect(
      await tryClonefileCopy(
        '/tmp/nexus-cow-missing-src',
        '/tmp/nexus-cow-missing-dest',
        exec,
      ),
    ).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

it.each([false, true])('F-255: serializes linked-checkout adds and releases after failure=%s', async (firstFails) => {
  const root = tmpRoot();
  let registering = false;
  const git = { run: async (_cwd: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: root, stderr: '' };
    if (registering) throw new Error('incomplete sibling commondir');
    registering = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (firstFails && args[3] === 'first') throw new Error('first add failed');
      fs.mkdirSync(args[4], { recursive: true });
      return { status: 0, stdout: '', stderr: '' };
    } finally { registering = false; }
  } };
  try {
    const results = await Promise.allSettled(['first', 'linked'].map((name) => materializeGitWorktree({
      repositoryRoot: path.join(root, name), worktreePath: path.join(root, 'wt-' + name),
      branchRef: 'refs/heads/' + name, headSha: 'a'.repeat(40), git, cowDirs: [],
    })));
    expect(results.map((r) => r.status)).toEqual([firstFails ? 'rejected' : 'fulfilled', 'fulfilled']);
    expect(fs.existsSync(path.join(root, 'wt-first'))).toBe(!firstFails);
    expect(fs.existsSync(path.join(root, 'wt-linked'))).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('F-255: another repository does not wait for an unrelated worktree registration', async () => {
  const root = tmpRoot();
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const git = { run: async (cwd: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: cwd, stderr: '' };
    if (cwd === a) { started(); await hold; }
    fs.mkdirSync(args[4]);
    return { status: 0, stdout: '', stderr: '' };
  } };
  const make = (repo: string) => materializeGitWorktree({ repositoryRoot: repo, worktreePath: path.join(repo, 'wt'), branchRef: 'refs/heads/work', headSha: 'a'.repeat(40), git, cowDirs: [] });
  const first = make(a);
  try {
    await firstStarted;
    await make(b);
    expect(fs.existsSync(path.join(b, 'wt'))).toBe(true);
    expect(fs.existsSync(path.join(a, 'wt'))).toBe(false);
  } finally { release(); await first; fs.rmSync(root, { recursive: true, force: true }); }
});

describe('F-1386 — lockfile gating e caches de build', () => {
  it('findLockfile: precedência npm > pnpm > yarn, null sem nenhum', () => {
    const root = tmpRoot();
    makeTree(root, { 'pnpm-lock.yaml': 'x', 'yarn.lock': 'y' });
    expect(findLockfile(root)).toBe('pnpm-lock.yaml');
    const npm = tmpRoot();
    makeTree(npm, { 'package-lock.json': '{}' });
    expect(findLockfile(npm)).toBe('package-lock.json');
    expect(findLockfile(tmpRoot())).toBeNull();
  });

  it('lockfilesMatch: idênticos casam, diferentes não, só-origem fail-closed', () => {
    const source = tmpRoot();
    const wt = tmpRoot();
    makeTree(source, { 'package-lock.json': '{"lockfileVersion":3}' });
    makeTree(wt, { 'package-lock.json': '{"lockfileVersion":3}' });
    expect(lockfilesMatch(source, wt)).toEqual({
      lockfile: 'package-lock.json', matched: true, reason: 'match',
    });

    const wtDiff = tmpRoot();
    makeTree(wtDiff, { 'package-lock.json': '{"lockfileVersion":2}' });
    expect(lockfilesMatch(source, wtDiff)).toEqual({
      lockfile: 'package-lock.json', matched: false, reason: 'mismatch',
    });

    const wtMissing = tmpRoot();
    expect(lockfilesMatch(source, wtMissing)).toEqual({
      lockfile: 'package-lock.json', matched: false, reason: 'only-source',
    });

    expect(lockfilesMatch(tmpRoot(), tmpRoot())).toEqual({
      lockfile: null, matched: false, reason: 'none',
    });
  });

  it('discoverTsbuildinfoFiles: padrão + tsBuildInfoFile do tsconfig', () => {
    const root = tmpRoot();
    makeTree(root, {
      'tsconfig.tsbuildinfo': '{}',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { tsBuildInfoFile: 'build/cache.tsbuildinfo' },
      }),
      'build/cache.tsbuildinfo': '{}',
    });
    const found = discoverTsbuildinfoFiles(root).sort();
    expect(found).toEqual(['build/cache.tsbuildinfo', 'tsconfig.tsbuildinfo']);
  });

  it('copyBuildCaches copia o que existe e pula dest presente', async () => {
    const source = tmpRoot();
    const wt = tmpRoot();
    makeTree(source, {
      'tsconfig.tsbuildinfo': 'version 5.0',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { tsBuildInfoFile: 'build/cache.tsbuildinfo' },
      }),
      'build/cache.tsbuildinfo': 'version 5.0',
    });
    // dest já presente não é recopiado.
    makeTree(wt, { 'tsconfig.tsbuildinfo': 'antigo' });
    const result = await copyBuildCaches(source, wt);
    expect(result.copied).toEqual(['build/cache.tsbuildinfo']);
    expect(fs.readFileSync(path.join(wt, 'build/cache.tsbuildinfo'), 'utf8'))
      .toBe('version 5.0');
    // o dest presente manteve o conteúdo antigo.
    expect(fs.readFileSync(path.join(wt, 'tsconfig.tsbuildinfo'), 'utf8'))
      .toBe('antigo');
  });

  it('copyBuildCaches semeia o cache fs do vitest; dest presente não é recopiado', async () => {
    const source = tmpRoot();
    const wt = tmpRoot();
    makeTree(source, {
      '.nexus-cache/vitest/mod/deadbeef.js': 'transformado',
    });
    const result = await copyBuildCaches(source, wt);
    expect(result.copied).toEqual(['.nexus-cache/vitest']);
    expect(fs.readFileSync(
      path.join(wt, '.nexus-cache/vitest/mod/deadbeef.js'), 'utf8',
    )).toBe('transformado');

    const wtWarm = tmpRoot();
    makeTree(wtWarm, { '.nexus-cache/vitest/mod/local.js': 'da worktree' });
    const second = await copyBuildCaches(source, wtWarm);
    expect(second.copied).toEqual([]);
    expect(fs.readFileSync(
      path.join(wtWarm, '.nexus-cache/vitest/mod/local.js'), 'utf8',
    )).toBe('da worktree');
  });

  it('copyBuildCaches: cópia do diretório é assíncrona — nada é copiado antes do await', async () => {
    const source = tmpRoot();
    const wt = tmpRoot();
    makeTree(source, { '.nexus-cache/vitest/mod/a.js': 'x' });
    let copied = false;
    const pending = copyBuildCaches(source, wt, {
      copyDir: async (src, dest) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        fs.cpSync(src, dest, { recursive: true });
        copied = true;
      },
    });
    // Se a cópia fosse síncrona (bloqueando o Main), `copied` já seria true.
    expect(copied).toBe(false);
    const result = await pending;
    expect(copied).toBe(true);
    expect(result.copied).toEqual(['.nexus-cache/vitest']);
    expect(fs.readFileSync(path.join(wt, '.nexus-cache/vitest/mod/a.js'), 'utf8'))
      .toBe('x');
  });

  it('copyBuildCaches: falha na cópia do cache do vitest é fail-open', async () => {
    const source = tmpRoot();
    const wt = tmpRoot();
    makeTree(source, { '.nexus-cache/vitest/mod/a.js': 'x' });
    const result = await copyBuildCaches(source, wt, {
      copyDir: async () => {
        throw new Error('sem espaço');
      },
    });
    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([
      { rel: '.nexus-cache/vitest', reason: 'copy-failed' },
    ]);
  });

  it('copyBuildCaches pula arquivo acima do teto', async () => {
    const source = tmpRoot();
    const wt = tmpRoot();
    makeTree(source, { 'tsconfig.tsbuildinfo': '{}' });
    const result = await copyBuildCaches(source, wt, {
      statSize: () => 300 * 1024 * 1024, // acima de MAX_BUILD_CACHE_BYTES
    });
    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual([{ rel: 'tsconfig.tsbuildinfo', reason: 'too-large' }]);
  });

  it('materializeGitWorktree reutiliza node_modules com lockfile idêntico', async () => {
    if (!darwin) return;
    const root = tmpRoot();
    const repo = path.join(root, 'repo');
    const wt = path.join(root, 'wt');
    const lockfile = '{"lockfileVersion":3}';
    makeTree(repo, {
      'package-lock.json': lockfile,
      'node_modules/a/index.js': 'x',
    });
    const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: repo, stderr: '' };
      if (args[0] === 'check-ignore') return { status: 1, stdout: '', stderr: '' };
      // simula o git worktree add real: materializa o lockfile no dest.
      fs.mkdirSync(wt, { recursive: true });
      fs.copyFileSync(path.join(repo, 'package-lock.json'), path.join(wt, 'package-lock.json'));
      return { status: 0, stdout: '', stderr: '' };
    });
    const result = await materializeGitWorktree({
      repositoryRoot: repo, worktreePath: wt, branchRef: 'refs/heads/nexus/t',
      headSha: 'abc', git: { run } as never,
    });
    expect(result.cowCopied).toEqual(['node_modules']);
    expect(result.cowSkipped).toEqual([]);
  });

  it('materializeGitWorktree pula node_modules com lockfile diferente', async () => {
    if (!darwin) return;
    const root = tmpRoot();
    const repo = path.join(root, 'repo');
    const wt = path.join(root, 'wt');
    makeTree(repo, {
      'package-lock.json': '{"lockfileVersion":3}',
      'node_modules/a/index.js': 'x',
    });
    const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: repo, stderr: '' };
      if (args[0] === 'check-ignore') return { status: 1, stdout: '', stderr: '' };
      fs.mkdirSync(wt, { recursive: true });
      // lockfile do HEAD é diferente do da origem.
      fs.writeFileSync(path.join(wt, 'package-lock.json'), '{"lockfileVersion":2}');
      return { status: 0, stdout: '', stderr: '' };
    });
    const result = await materializeGitWorktree({
      repositoryRoot: repo, worktreePath: wt, branchRef: 'refs/heads/nexus/t',
      headSha: 'abc', git: { run } as never,
    });
    expect(result.cowCopied).toEqual([]);
    expect(result.cowSkipped).toEqual([
      { dir: 'node_modules', reason: 'lockfile-mismatch' },
    ]);
    expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false);
  });
});

// F-1535: fora do macOS não há clonefile, então a worktree nascia sem
// node_modules e o worker criava o link à mão (ou o `npx` baixava um runner
// alheio). O link é o substituto do clone; os caches de build seguem copiados.
describe('linkHeavyDirs (F-1535)', () => {
  it('linka node_modules da origem e o conteúdo fica legível na worktree', () => {
    const root = tmpRoot();
    try {
      const repo = path.join(root, 'repo');
      const wt = path.join(root, 'wt');
      makeTree(repo, { 'node_modules/vitest/index.js': 'module.exports = 1;\n' });
      fs.mkdirSync(wt, { recursive: true });

      expect(linkHeavyDirs(repo, wt, ['node_modules'])).toEqual(['node_modules']);
      const linked = path.join(wt, 'node_modules');
      expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(linked, 'vitest', 'index.js'), 'utf8'))
        .toContain('module.exports');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('o link não aparece como não rastreado nem com `node_modules/` (barra) no .gitignore', () => {
    const root = tmpRoot();
    try {
      const repo = path.join(root, 'repo');
      makeTree(repo, {
        '.gitignore': 'node_modules/\n',
        'a.txt': 'a\n',
        'node_modules/dep/index.js': 'x\n',
      });
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
          cwd,
          encoding: 'utf8',
        });
      git(repo, 'init', '-q');
      git(repo, 'add', '.gitignore', 'a.txt');
      git(repo, 'commit', '-q', '-m', 'init');
      const wt = path.join(root, 'wt');
      git(repo, 'worktree', 'add', '-q', '--detach', wt);

      expect(linkHeavyDirs(repo, wt, ['node_modules'])).toEqual(['node_modules']);
      expect(git(wt, 'status', '--porcelain')).not.toContain('node_modules');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('não sobrepõe um node_modules que já existe na worktree', () => {
    const root = tmpRoot();
    try {
      const repo = path.join(root, 'repo');
      const wt = path.join(root, 'wt');
      makeTree(repo, { 'node_modules/a/index.js': 'from repo\n' });
      makeTree(wt, { 'node_modules/a/index.js': 'from worktree\n' });

      expect(linkHeavyDirs(repo, wt, ['node_modules'])).toEqual([]);
      expect(fs.readFileSync(path.join(wt, 'node_modules', 'a', 'index.js'), 'utf8'))
        .toBe('from worktree\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('origem ausente é pulada em silêncio (writer segue sem ela)', () => {
    const root = tmpRoot();
    try {
      const repo = path.join(root, 'repo');
      const wt = path.join(root, 'wt');
      fs.mkdirSync(repo, { recursive: true });
      fs.mkdirSync(wt, { recursive: true });

      expect(linkHeavyDirs(repo, wt, ['node_modules'])).toEqual([]);
      expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('origem que já é link resolve para o alvo real, sem encadear links', () => {
    const root = tmpRoot();
    try {
      const real = path.join(root, 'real-modules');
      makeTree(root, { 'real-modules/pkg/index.js': 'real\n' });
      const repo = path.join(root, 'repo');
      const wt = path.join(root, 'wt');
      fs.mkdirSync(repo, { recursive: true });
      fs.mkdirSync(wt, { recursive: true });
      fs.symlinkSync(real, path.join(repo, 'node_modules'), 'junction');

      expect(linkHeavyDirs(repo, wt, ['node_modules'])).toEqual(['node_modules']);
      expect(fs.realpathSync(path.join(wt, 'node_modules'))).toBe(fs.realpathSync(real));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(darwin)('materializeGitWorktree nasce com node_modules linkado', async () => {
    const root = tmpRoot();
    try {
      const repo = path.join(root, 'repo');
      const wt = path.join(root, 'wt');
      makeTree(repo, { 'node_modules/vitest/index.js': 'x\n' });
      const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
        if (args[0] === 'rev-parse') return { status: 0, stdout: repo, stderr: '' };
        if (args[0] === 'check-ignore') return { status: 1, stdout: '', stderr: '' };
        fs.mkdirSync(wt, { recursive: true });
        return { status: 0, stdout: '', stderr: '' };
      });

      const result = await materializeGitWorktree({
        repositoryRoot: repo, worktreePath: wt, branchRef: 'refs/heads/nexus/t',
        headSha: 'abc', git: { run } as never,
      });

      expect(result.linkedDirs).toEqual(['node_modules']);
      expect(result.cowMethods['node_modules']).toBe('link');
      expect(fs.existsSync(path.join(wt, 'node_modules', 'vitest', 'index.js'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(darwin)('lockfile diferente continua barrando o node_modules linkado', async () => {
    const root = tmpRoot();
    try {
      const repo = path.join(root, 'repo');
      const wt = path.join(root, 'wt');
      makeTree(repo, {
        'node_modules/vitest/index.js': 'x\n',
        'package-lock.json': '{"lockfileVersion":3}',
      });
      const run = vi.fn(async (_cwd: string, args: readonly string[]) => {
        if (args[0] === 'rev-parse') return { status: 0, stdout: repo, stderr: '' };
        if (args[0] === 'check-ignore') return { status: 1, stdout: '', stderr: '' };
        fs.mkdirSync(wt, { recursive: true });
        fs.writeFileSync(path.join(wt, 'package-lock.json'), '{"lockfileVersion":2}');
        return { status: 0, stdout: '', stderr: '' };
      });

      const result = await materializeGitWorktree({
        repositoryRoot: repo, worktreePath: wt, branchRef: 'refs/heads/nexus/t',
        headSha: 'abc', git: { run } as never,
      });

      expect(result.linkedDirs).toEqual([]);
      expect(result.cowSkipped).toEqual([{ dir: 'node_modules', reason: 'lockfile-mismatch' }]);
      expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
