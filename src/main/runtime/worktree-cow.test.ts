import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cloneHeavyDir,
  cowCopyHeavyDirs,
  cowCopyHeavyDirsSync,
  cowWorktreeAvailable,
  discoverNestedCowDirs,
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
