import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertPrivateIndexPath,
  assertSafeLocalGitConfig,
  assertSafeLocalGitConfigAsync,
  AsyncProcessGitRunner,
  createPrivateGitIndex,
  GitCommandError,
  isExecutableGitConfigEntry,
  ProcessGitRunner,
  retryTransientGit,
  type AsyncGitRunner,
  type GitRunner,
} from './git-command';

function runnerWith(stdout: string): GitRunner {
  return {
    run: vi.fn(() => ({ status: stdout.trim() ? 0 : 1, stdout, stderr: '' })),
  } as unknown as GitRunner;
}

describe('isExecutableGitConfigEntry', () => {
  it('treats the built-in fsmonitor daemon as non-executable', () => {
    // Field trap (28/07): `core.fsmonitor=true` selects Git's own daemon and
    // spawns nothing, but the key-only check refused the repository and
    // blocked every worker in it over a pure performance setting.
    expect(isExecutableGitConfigEntry('core.fsmonitor', 'true')).toBe(false);
    expect(isExecutableGitConfigEntry('core.fsmonitor', 'false')).toBe(false);
    expect(isExecutableGitConfigEntry('core.fsmonitor', 'TRUE')).toBe(false);
  });

  it('still refuses an fsmonitor that names a command', () => {
    expect(isExecutableGitConfigEntry('core.fsmonitor', '.git/hooks/fsm')).toBe(
      true,
    );
    expect(isExecutableGitConfigEntry('core.fsmonitor', '/usr/bin/evil')).toBe(
      true,
    );
  });

  it('refuses config that always carries a command', () => {
    expect(isExecutableGitConfigEntry('core.hookspath', '.githooks')).toBe(true);
    expect(isExecutableGitConfigEntry('core.sshcommand', 'ssh -i k')).toBe(true);
    expect(isExecutableGitConfigEntry('filter.lfs.clean', 'git-lfs clean')).toBe(
      true,
    );
    expect(isExecutableGitConfigEntry('diff.x.textconv', 'cat')).toBe(true);
    expect(isExecutableGitConfigEntry('merge.x.driver', 'merge %A')).toBe(true);
    expect(isExecutableGitConfigEntry('credential.helper', 'store')).toBe(true);
  });

  it('distinguishes the submodule update forms', () => {
    // Only `!command` executes; the named strategies do not.
    expect(isExecutableGitConfigEntry('submodule.a.update', 'checkout')).toBe(
      false,
    );
    expect(isExecutableGitConfigEntry('submodule.a.update', 'rebase')).toBe(
      false,
    );
    expect(isExecutableGitConfigEntry('submodule.a.update', '!evil.sh')).toBe(
      true,
    );
  });

  it('treats an empty value as disabled', () => {
    expect(isExecutableGitConfigEntry('core.hookspath', '')).toBe(false);
    expect(isExecutableGitConfigEntry('credential.helper', '   ')).toBe(false);
  });
});

describe('assertSafeLocalGitConfig', () => {
  it('accepts a repository whose only match is the built-in fsmonitor', () => {
    expect(() =>
      assertSafeLocalGitConfig(runnerWith('core.fsmonitor true\n'), '/repo'),
    ).not.toThrow();
  });

  it('refuses and names the offending keys', () => {
    expect(() =>
      assertSafeLocalGitConfig(
        runnerWith('core.fsmonitor true\ncore.hookspath .githooks\n'),
        '/repo',
      ),
    ).toThrow(/core\.hookspath/);
    // The safe entry must not be reported as an offender.
    expect(() =>
      assertSafeLocalGitConfig(
        runnerWith('core.fsmonitor true\ncore.hookspath .githooks\n'),
        '/repo',
      ),
    ).toThrow(/^(?!.*core\.fsmonitor).*core\.hookspath/s);
  });

  it('accepts a repository with no matching config at all', () => {
    expect(() =>
      assertSafeLocalGitConfig(runnerWith(''), '/repo'),
    ).not.toThrow();
  });

  it('supports asynchronous main-process inspection with the same policy', async () => {
    const run = vi.fn(async () => ({
      status: 0,
      stdout: 'core.fsmonitor true\ncore.hookspath .githooks\n',
      stderr: '',
    }));

    await expect(
      assertSafeLocalGitConfigAsync({ run }, '/repo'),
    ).rejects.toThrow(/core\.hookspath/);
  });
});

describe('ProcessGitRunner global/system config (F-580)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('honours the user global git config (credential helpers, user.name/email)', () => {
    // Antes do F-580 o runner impunha GIT_CONFIG_NOSYSTEM=1 e
    // GIT_CONFIG_GLOBAL=/dev/null: todo helper de credencial (gh
    // git-credential, osxkeychain, GCM) e o user.name/email sumiam, e qualquer
    // push/pull HTTPS morria com "could not read Username".
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-git-home-'));
    try {
      fs.writeFileSync(
        path.join(home, '.gitconfig'),
        '[user]\n\temail = runner@example.test\n',
      );
      vi.stubEnv('HOME', home);
      vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));

      const result = new ProcessGitRunner().run(process.cwd(), [
        'config',
        '--global',
        '--get',
        'user.email',
      ]);

      expect(result.stdout.trim()).toBe('runner@example.test');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('AsyncProcessGitRunner', () => {
  it('runs Git without occupying the caller event-loop turn', async () => {
    const pending = new AsyncProcessGitRunner().run(process.cwd(), [
      'rev-parse',
      '--is-inside-work-tree',
    ]);

    await expect(
      new Promise<string>((resolve) => setImmediate(() => resolve('free'))),
    ).resolves.toBe('free');
    await expect(pending).resolves.toMatchObject({
      status: 0,
      stdout: expect.stringMatching(/true/i),
    });
  });
});

describe('F-1384: Git do Nexus não deixa index.lock órfão na worktree', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function slowFilterRepo(): { root: string; repo: string } {
    // Filtro clean lento (config global, como o F-580 honra) segura o Git
    // no meio da operação: o mesmo efeito de uma worktree grande sob swap.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-git-lock-'));
    const home = path.join(root, 'home');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(home);
    fs.mkdirSync(repo);
    fs.writeFileSync(
      path.join(home, '.gitconfig'),
      '[user]\n\tname = t\n\temail = t@example.test\n[filter "slow"]\n\tclean = "sleep 3; cat"\n',
    );
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
    const git = new ProcessGitRunner();
    git.run(repo, ['init', '-q']);
    fs.writeFileSync(path.join(repo, 'f.txt'), 'a\n');
    git.run(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'f.txt filter=slow\n');
    return { root, repo };
  }

  it('Git que estoura o timeout do runner sai limpando o próprio index.lock', async () => {
    // Incidente 12/10: index.lock de 0 byte, sem processo git, em
    // .git/worktrees/<writer>/ — o runner matava no timeout com SIGKILL, que
    // não deixa o Git rodar a limpeza dos lockfiles.
    const { root, repo } = slowFilterRepo();
    try {
      const result = await new AsyncProcessGitRunner()
        .run(repo, ['add', 'f.txt'], { allowFailure: true, timeoutMs: 600 })
        .catch((error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fs.existsSync(path.join(repo, '.git', 'index.lock'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('git status do Nexus não regrava o index da worktree (sem lock opcional)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-git-status-'));
    try {
      const git = new ProcessGitRunner();
      git.run(root, ['init', '-q']);
      fs.writeFileSync(path.join(root, 'f.txt'), 'a\n');
      git.run(root, ['add', 'f.txt']);
      git.run(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'x']);
      const index = path.join(root, '.git', 'index');
      const past = new Date('2020-01-01T00:00:00Z');
      fs.utimesSync(path.join(root, 'f.txt'), past, past);
      const before = fs.statSync(index).ino;
      await new AsyncProcessGitRunner().run(root, ['status', '--porcelain']);
      git.run(root, ['status', '--porcelain']);
      // Regravar = criar index.lock e renomear: a janela que um kill deixa órfã.
      expect(fs.statSync(index).ino).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// F-1442: no Windows o mesmo diretório tem várias grafias legítimas (nome curto
// 8.3, maiúsculas, `/`, prefixo `\\?\`, junction de TEMP redirecionado). A
// validação comparava GRAFIAS e recusava o índice privado legítimo, então todo
// handoff de writer saía sem checkpoint ("unsafe private Git index path").
describe('assertPrivateIndexPath (F-1442)', () => {
  const isWindows = process.platform === 'win32';
  const roots: string[] = [];
  let tmpdirSpy: ReturnType<typeof vi.spyOn> | null = null;

  function track<T extends string>(dir: T): T {
    roots.push(dir);
    return dir;
  }

  /** `nexus-git-index-*` real dentro do tmp, como createPrivateIndex faz. */
  function privateIndexDir(under: string = os.tmpdir()): string {
    return track(fs.mkdtempSync(path.join(under, 'nexus-git-index-')));
  }

  function linkDir(target: string, name: string, under: string = os.tmpdir()): string {
    const link = track(path.join(under, name));
    fs.symlinkSync(target, link, isWindows ? 'junction' : 'dir');
    return link;
  }

  afterEach(() => {
    tmpdirSpy?.mockRestore();
    tmpdirSpy = null;
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) {
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // melhor esforço: tmp do SO
      }
    }
  });

  it('aceita o índice que createPrivateGitIndex produz', () => {
    const index = createPrivateGitIndex();
    try {
      expect(assertPrivateIndexPath(index.path)).toBe(index.path);
    } finally {
      index.dispose();
    }
  });

  it('aceita o tmp alcançado por junction (TEMP redirecionado)', () => {
    const real = track(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tmp-real-')));
    const redirected = linkDir(real, 'nexus-tmp-link');
    const dir = privateIndexDir(redirected);
    tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(redirected);

    expect(assertPrivateIndexPath(path.join(dir, 'index'))).toBe(
      path.join(dir, 'index'),
    );
  });

  it('aceita grafia nativa (nome longo) com tmpdir de nome curto 8.3', (ctx) => {
    if (!isWindows) return ctx.skip();
    const dir = privateIndexDir();
    const native = fs.realpathSync.native(dir);
    const js = fs.realpathSync(dir);
    if (native === js) return ctx.skip(); // máquina sem nome curto no tmp

    expect(assertPrivateIndexPath(path.join(native, 'index'))).toBe(
      path.join(native, 'index'),
    );
  });

  it('aceita tmpdir com outra caixa e separador (NTFS é case-insensitive)', (ctx) => {
    if (!isWindows) return ctx.skip();
    const dir = privateIndexDir();
    tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(os.tmpdir().toUpperCase());

    expect(() => assertPrivateIndexPath(path.join(dir, 'index'))).not.toThrow();
    expect(() =>
      assertPrivateIndexPath(path.join(dir, 'index').replaceAll('\\', '/')),
    ).not.toThrow();
  });

  it('aceita o prefixo de caminho estendido \\\\?\\ do mesmo diretório', (ctx) => {
    if (!isWindows) return ctx.skip();
    const dir = privateIndexDir();
    const extended = `\\\\?\\${fs.realpathSync.native(dir)}`;
    if (!fs.existsSync(path.join(extended, '.'))) return ctx.skip();

    expect(() => assertPrivateIndexPath(path.join(extended, 'index'))).not.toThrow();
  });

  it('continua recusando pai que É um link/junction', () => {
    const real = privateIndexDir();
    const link = linkDir(real, 'nexus-git-index-link');

    expect(() => assertPrivateIndexPath(path.join(link, 'index'))).toThrow(
      'unsafe private Git index path',
    );
  });

  it('continua recusando índice fora do tmp privado', () => {
    const dir = privateIndexDir();
    const otherTmp = track(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tmp-other-')));
    tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(otherTmp);

    expect(() => assertPrivateIndexPath(path.join(dir, 'index'))).toThrow(
      'unsafe private Git index path',
    );
  });

  it('continua recusando UNC', (ctx) => {
    if (!isWindows) return ctx.skip();
    const shareRoot = `\\\\127.0.0.1\\C$\\${os.tmpdir().replace(/^[A-Za-z]:\\/, '')}`;
    if (!fs.existsSync(shareRoot)) return ctx.skip(); // compartilhamento admin off
    const dir = privateIndexDir(shareRoot);

    expect(() => assertPrivateIndexPath(path.join(dir, 'index'))).toThrow(
      'unsafe private Git index path',
    );
  });

  it('continua recusando basename e prefixo errados', () => {
    const dir = privateIndexDir();

    expect(() => assertPrivateIndexPath(path.join(dir, 'not-index'))).toThrow(
      'unsafe private Git index path',
    );
    const foreign = track(fs.mkdtempSync(path.join(os.tmpdir(), 'not-ours-')));
    expect(() => assertPrivateIndexPath(path.join(foreign, 'index'))).toThrow(
      'unsafe private Git index path',
    );
  });
});

describe('Git transitório no spawn do isolatedWriter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('diz o subcomando, o prazo e o stderr sem a credencial', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-fake-git-'));
    try {
      fs.writeFileSync(
        path.join(bin, 'git'),
        '#!/bin/sh\necho "fatal: could not read https://bot:ghp_secret@example.test/r" >&2\nsleep 5\n',
        { mode: 0o755 },
      );
      vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
      for (const run of [
        () => new ProcessGitRunner().run(process.cwd(), ['worktree', 'add', '-b', 'x', '/tmp/x'], { timeoutMs: 1_000 }),
        () => new AsyncProcessGitRunner().run(process.cwd(), ['worktree', 'add', '-b', 'x', '/tmp/x'], { timeoutMs: 1_000 }),
      ]) {
        const error = await Promise.resolve().then(run).then(() => null, (failure: unknown) => failure);
        expect(error).toBeInstanceOf(GitCommandError);
        const message = (error as Error).message;
        expect(message).toMatch(/^Git process could not complete: git worktree add \(timeout de 1s\)/);
        expect(message).toContain('stderr: fatal: could not read https://***@example.test/r');
        expect(message).not.toContain('ghp_secret');
      }
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('repete com backoff um git que falha 1 vez e depois funciona', async () => {
    let calls = 0;
    const git: AsyncGitRunner = {
      run: async (_cwd, args) => {
        calls += 1;
        if (calls === 1) {
          throw new GitCommandError('Git process could not complete: git worktree add (timeout de 30s)', args, { status: 1 });
        }
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    };
    const sleeps: number[] = [];
    const result = await retryTransientGit(() => git.run('/repo', ['worktree', 'add']), {
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(result.stdout).toBe('ok');
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1_000]);
  });

  it('repete lock concorrente e não repete erro definitivo', async () => {
    const lock = new GitCommandError('Git command failed with exit 128', ['worktree', 'add'], {
      status: 128,
      stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    });
    let lockCalls = 0;
    await expect(retryTransientGit(async () => {
      lockCalls += 1;
      throw lock;
    }, { sleep: async () => {} })).rejects.toBe(lock);
    expect(lockCalls).toBe(3);

    let fatalCalls = 0;
    const fatal = new GitCommandError('Git command failed with exit 128', ['worktree', 'add'], {
      status: 128,
      stderr: "fatal: invalid reference: nope",
    });
    await expect(retryTransientGit(async () => {
      fatalCalls += 1;
      throw fatal;
    }, { sleep: async () => {} })).rejects.toBe(fatal);
    expect(fatalCalls).toBe(1);
  });
});
