import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECKPOINT_REF_PATTERN,
  captureHiddenCheckpoint,
  checkpointRefForScopeOrdinal,
  checkpointScopeKey,
  hiddenCheckpointIdle,
  listHiddenCheckpoints,
  restoreHiddenCheckpoint,
} from './hidden-checkpoint';
import { AsyncProcessGitRunner, type AsyncGitRunner } from '../runtime/git-command';

const SCOPE = 'nexus-mission:mission-a\n/árvore/do/writer';
let temp: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Operador',
      GIT_AUTHOR_EMAIL: 'operador@example.test',
      GIT_COMMITTER_NAME: 'Operador',
      GIT_COMMITTER_EMAIL: 'operador@example.test',
    },
  }).trim();
}

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function read(root: string, file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function indexHash(cwd: string): string {
  return createHash('sha256').update(fs.readFileSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-path', 'index'))).digest('hex');
}

function checkpointRefs(cwd: string): string[] {
  const out = git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/nexus-checkpoint');
  return out ? out.split('\n') : [];
}

/**
 * Estado que a captura não pode mexer: HEAD, branch e status. O índice real é
 * comparado byte a byte em volta da operação, sem `git status` no meio (o
 * status pode reescrever o índice por conta própria).
 */
function observable(cwd: string): { head: string; branches: string; status: string } {
  return {
    head: git(cwd, 'rev-parse', 'HEAD'),
    branches: git(cwd, 'branch', '-a', '--list'),
    status: git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'),
  };
}

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-checkpoint-')));
  repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'base.txt', 'base\n');
  write(repo, '.gitignore', 'ignored.log\n');
  git(repo, 'add', 'base.txt', '.gitignore');
  git(repo, 'commit', '-qm', 'base');
});

afterEach(async () => {
  await hiddenCheckpointIdle();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('captureHiddenCheckpoint', () => {
  it('fotografa untracked e edição staged sem mexer em HEAD, branch, status nem índice real', async () => {
    write(repo, 'base.txt', 'base\nstaged\n');
    git(repo, 'add', 'base.txt');
    write(repo, 'base.txt', 'base\nstaged\nsó no disco\n');
    write(repo, 'novo/arquivo.txt', 'untracked\n');
    write(repo, 'ignored.log', 'ruído\n');
    const before = observable(repo);
    const index = indexHash(repo);

    const result = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE, note: ['Missão: mission-a'] });

    expect(indexHash(repo)).toBe(index);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(observable(repo)).toEqual(before);
    expect(result.ref).toMatch(CHECKPOINT_REF_PATTERN);
    expect(result.ref).toBe(`refs/nexus-checkpoint/${checkpointScopeKey(SCOPE)}/ordinal/1`);
    expect(checkpointScopeKey(SCOPE)).toMatch(/^[0-9a-f]{32}$/);
    expect(result.baseSha).toBe(before.head);
    expect(git(repo, 'rev-parse', `${result.commit}^`)).toBe(before.head);
    expect(git(repo, 'log', '-1', '--format=%an <%ae>', result.commit)).toBe('Nexus (checkpoint) <checkpoint@nexus.invalid>');
    const files = git(repo, 'ls-tree', '-r', '--name-only', result.commit).split('\n');
    expect(files).toEqual(expect.arrayContaining(['base.txt', '.gitignore', 'novo/arquivo.txt']));
    expect(files).not.toContain('ignored.log');
    expect(git(repo, 'show', `${result.commit}:base.txt`)).toBe('base\nstaged\nsó no disco');
    expect(git(repo, 'branch', '-a', '--list')).not.toContain('checkpoint');
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/main');
  });

  it('segundo capture no mesmo ordinal é idempotente; o próximo só avança com árvore nova', async () => {
    write(repo, 'novo.txt', 'v1\n');
    const first = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE, ordinal: 3 });
    const second = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE, ordinal: 3 });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second).toEqual({ ...first, reused: true });
    expect(first.reused).toBe(false);
    expect(checkpointRefs(repo)).toEqual([checkpointRefForScopeOrdinal(SCOPE, 3)]);

    const unchanged = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE });
    expect(unchanged).toMatchObject({ ok: true, ordinal: 3, commit: first.commit, reused: true });
    write(repo, 'novo.txt', 'v2\n');
    const next = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE });
    expect(next).toMatchObject({ ok: true, ordinal: 4, reused: false });
    expect(checkpointRefs(repo)).toHaveLength(2);
  });

  it('funciona dentro de git worktree e a ref fica no repositório comum', async () => {
    const worktree = path.join(temp, 'writer');
    git(repo, 'worktree', 'add', '-q', '-b', 'nexus/writer', worktree);
    write(worktree, 'feito.txt', 'trabalho do writer\n');
    const mainBefore = observable(repo);
    const wtBefore = observable(worktree);
    const indexes = [indexHash(repo), indexHash(worktree)];

    const result = await captureHiddenCheckpoint({ cwd: worktree, scopeId: SCOPE });

    expect([indexHash(repo), indexHash(worktree)]).toEqual(indexes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(observable(worktree)).toEqual(wtBefore);
    expect(observable(repo)).toEqual(mainBefore);
    expect(checkpointRefs(repo)).toEqual([result.ref]);
    expect(git(repo, 'show', `${result.ref}:feito.txt`)).toBe('trabalho do writer');

    write(worktree, 'feito.txt', 'quebrado\n');
    const restored = await restoreHiddenCheckpoint({ cwd: worktree, scopeId: SCOPE, ref: result.ref, apply: true });
    expect(restored).toMatchObject({ ok: true, applied: true, overwrite: ['feito.txt'] });
    expect(read(worktree, 'feito.txt')).toBe('trabalho do writer\n');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(wtBefore.head);
  });

  it('recusa sparse checkout com erro visível e não grava ref', async () => {
    git(repo, 'config', 'core.sparseCheckout', 'true');
    write(repo, 'novo.txt', 'x\n');

    const result = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE });

    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toMatch(/^sparse-checkout-unsupported/);
    expect(checkpointRefs(repo)).toEqual([]);
  });

  it('nunca publica oid vazio', async () => {
    const real = new AsyncProcessGitRunner();
    const emptyCommitTree: AsyncGitRunner = {
      run: async (cwd, args, options) => {
        const result = await real.run(cwd, args, options);
        return args.includes('commit-tree') ? { ...result, stdout: '\n' } : result;
      },
    };
    write(repo, 'novo.txt', 'x\n');

    const result = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE }, { git: emptyCommitTree });

    expect(!result.ok && result.reason).toMatch(/^empty-commit-oid/);
    expect(checkpointRefs(repo)).toEqual([]);
  });

  it('deixa de fora repositório aninhado sem commit em vez de falhar', async () => {
    fs.mkdirSync(path.join(repo, 'aninhado'));
    git(path.join(repo, 'aninhado'), 'init', '-q');
    write(repo, 'aninhado/x.txt', 'x\n');
    write(repo, 'novo.txt', 'novo\n');

    const result = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const files = git(repo, 'ls-tree', '-r', '--name-only', result.commit).split('\n');
    expect(files).toContain('novo.txt');
    expect(files.some((file) => file.startsWith('aninhado'))).toBe(false);
  });
});

describe('ref de 0 byte', () => {
  function emptyRef(ordinal: number): string {
    const ref = checkpointRefForScopeOrdinal(SCOPE, ordinal);
    const file = path.join(repo, '.git', ref);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  }

  it('restauração de ref vazia é recusada e a ref sai', async () => {
    const file = emptyRef(7);

    const result = await restoreHiddenCheckpoint({
      cwd: repo, scopeId: SCOPE, ref: checkpointRefForScopeOrdinal(SCOPE, 7), apply: true,
    });

    expect(!result.ok && result.reason).toMatch(/^checkpoint-ref-empty/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('listagem ignora e apaga a ref vazia; a captura segue depois dela', async () => {
    write(repo, 'novo.txt', 'v1\n');
    const saved = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE });
    const file = emptyRef(8);

    const listed = await listHiddenCheckpoints({ cwd: repo, scopeId: SCOPE });

    expect(listed).toMatchObject({ ok: true, removedEmptyRefs: [checkpointRefForScopeOrdinal(SCOPE, 8)] });
    expect(listed.ok && listed.checkpoints.map((entry) => entry.ref)).toEqual([saved.ok && saved.ref]);
    expect(listed.ok && listed.checkpoints[0].subject).toBe(`nexus checkpoint ref=${saved.ok && saved.ref}`);
    expect(fs.existsSync(file)).toBe(false);

    emptyRef(2);
    write(repo, 'novo.txt', 'v2\n');
    const next = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE });
    expect(next).toMatchObject({ ok: true, ordinal: 2, reused: false });
    expect(git(repo, 'show', `${checkpointRefForScopeOrdinal(SCOPE, 2)}:novo.txt`)).toBe('v2');
  });
});

describe('restoreHiddenCheckpoint', () => {
  it('só restaura por comando explícito: a prévia avisa e não escreve', async () => {
    write(repo, 'novo.txt', 'bom\n');
    const saved = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE });
    if (!saved.ok) throw new Error(saved.reason);
    write(repo, 'novo.txt', 'quebrado\n');
    fs.rmSync(path.join(repo, 'base.txt'));
    write(repo, 'extra.txt', 'criado depois\n');
    const before = observable(repo);
    const index = indexHash(repo);

    const preview = await restoreHiddenCheckpoint({ cwd: repo, scopeId: SCOPE, ref: saved.ref, apply: false });

    expect(indexHash(repo)).toBe(index);

    expect(preview).toMatchObject({
      ok: true, applied: false, backup: null,
      overwrite: ['novo.txt'], create: ['base.txt'], keptExtra: ['extra.txt'], conflicts: [],
    });
    expect(read(repo, 'novo.txt')).toBe('quebrado\n');
    expect(fs.existsSync(path.join(repo, 'base.txt'))).toBe(false);
    expect(checkpointRefs(repo)).toEqual([saved.ref]);
    expect(observable(repo)).toEqual(before);
  });

  it('restore explícito devolve os arquivos, guarda o estado anterior e não apaga nada', async () => {
    write(repo, 'novo.txt', 'bom\n');
    const saved = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE });
    if (!saved.ok) throw new Error(saved.reason);
    write(repo, 'novo.txt', 'quebrado\n');
    fs.rmSync(path.join(repo, 'base.txt'));
    write(repo, 'extra.txt', 'criado depois\n');
    const head = git(repo, 'rev-parse', 'HEAD');
    const index = indexHash(repo);

    const result = await restoreHiddenCheckpoint({ cwd: repo, scopeId: SCOPE, ref: saved.ref, apply: true });

    expect(result).toMatchObject({ ok: true, applied: true, overwrite: ['novo.txt'], create: ['base.txt'] });
    if (!result.ok || !result.backup) throw new Error('sem backup');
    expect(read(repo, 'novo.txt')).toBe('bom\n');
    expect(read(repo, 'base.txt')).toBe('base\n');
    expect(read(repo, 'extra.txt')).toBe('criado depois\n');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(indexHash(repo)).toBe(index);
    expect(result.backup.ordinal).toBe(2);
    expect(git(repo, 'show', `${result.backup.ref}:novo.txt`)).toBe('quebrado');
    expect(git(repo, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(
      ['?? extra.txt', '?? novo.txt'].join('\n'),
    );
  });

  it('caminho bloqueado vira conflito e nada é apagado', async () => {
    write(repo, 'x', 'arquivo\n');
    const saved = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE });
    if (!saved.ok) throw new Error(saved.reason);
    fs.rmSync(path.join(repo, 'x'));
    write(repo, 'x/dentro.txt', 'diretório no lugar\n');

    const result = await restoreHiddenCheckpoint({ cwd: repo, scopeId: SCOPE, ref: saved.ref, apply: true });

    expect(result).toMatchObject({ ok: true, applied: false, conflicts: ['x'], keptExtra: ['x/dentro.txt'] });
    expect(read(repo, 'x/dentro.txt')).toBe('diretório no lugar\n');
  });

  it('recusa ref de outro escopo', async () => {
    const result = await restoreHiddenCheckpoint({
      cwd: repo, scopeId: SCOPE, ref: checkpointRefForScopeOrdinal('outro-escopo', 1), apply: false,
    });
    expect(result).toEqual({ ok: false, reason: 'checkpoint-outside-scope' });
  });
});

describe('raiz selada e autoridade por mutação (revisão a368b0ace)', () => {
  let worktree: string;

  /** Worktree do writer com um checkpoint (feito.txt = bom) e a árvore quebrada depois. */
  async function brokenWriter(): Promise<string> {
    worktree = path.join(temp, 'writer');
    git(repo, 'worktree', 'add', '-q', '-b', 'nexus/writer', worktree);
    write(worktree, 'feito.txt', 'bom\n');
    const saved = await captureHiddenCheckpoint({ cwd: worktree, scopeId: SCOPE });
    if (!saved.ok) throw new Error(saved.reason);
    write(worktree, 'feito.txt', 'quebrado\n');
    return saved.ref;
  }

  it('recusa raiz trocada por symlink para a coordenação e não escreve nela', async () => {
    const ref = await brokenWriter();
    fs.renameSync(worktree, `${worktree}-movido`);
    fs.symlinkSync(repo, worktree);

    const result = await restoreHiddenCheckpoint({ cwd: worktree, scopeId: SCOPE, ref, apply: true });

    expect(!result.ok && result.reason).toMatch(/^checkpoint-root-not-sealed/);
    expect(fs.existsSync(path.join(repo, 'feito.txt'))).toBe(false);
  });

  it('recusa a raiz proibida (coordenação) mesmo pelo caminho real', async () => {
    write(repo, 'novo.txt', 'v1\n');
    const saved = await captureHiddenCheckpoint({ cwd: repo, scopeId: SCOPE });
    if (!saved.ok) throw new Error(saved.reason);
    write(repo, 'novo.txt', 'v2\n');

    const result = await restoreHiddenCheckpoint({
      cwd: repo, scopeId: SCOPE, ref: saved.ref, apply: true, forbiddenRoot: repo,
    });

    expect(!result.ok && result.reason).toMatch(/^checkpoint-forbidden-root/);
    expect(read(repo, 'novo.txt')).toBe('v2\n');
  });

  it('revalida a identidade da raiz logo antes de escrever (troca no meio da restauração)', async () => {
    const ref = await brokenWriter();

    const result = restoreHiddenCheckpoint({
      cwd: worktree, scopeId: SCOPE, ref, apply: true, forbiddenRoot: repo,
      assertTargets: () => {
        fs.renameSync(worktree, `${worktree}-movido`);
        fs.symlinkSync(repo, worktree);
      },
    });

    await expect(result).rejects.toThrow(/checkpoint-root-identity-changed/);
    expect(fs.existsSync(path.join(repo, 'feito.txt'))).toBe(false);
    expect(read(`${worktree}-movido`, 'feito.txt')).toBe('quebrado\n');
  });

  it('revalida a autoridade depois de publicar o backup: revogação ali não escreve nada', async () => {
    const ref = await brokenWriter();
    let calls = 0;

    const result = restoreHiddenCheckpoint({
      cwd: worktree, scopeId: SCOPE, ref, apply: true,
      assertCanWrite: () => {
        calls += 1;
        if (calls === 2) throw new Error('session_authority_revoked');
      },
    });

    await expect(result).rejects.toThrow('session_authority_revoked');
    expect(calls).toBe(2);
    expect(read(worktree, 'feito.txt')).toBe('quebrado\n');
  });

  it('autoridade é conferida antes do backup, depois dele e antes de cada checkout-index', async () => {
    const ref = await brokenWriter();
    let calls = 0;

    const result = await restoreHiddenCheckpoint({
      cwd: worktree, scopeId: SCOPE, ref, apply: true, assertCanWrite: () => { calls += 1; },
    });

    expect(result).toMatchObject({ ok: true, applied: true });
    expect(calls).toBe(3);
    expect(read(worktree, 'feito.txt')).toBe('bom\n');
  });

  it('destinos passam pela checagem do chamador antes de qualquer escrita', async () => {
    const ref = await brokenWriter();
    const seen: string[][] = [];

    const result = restoreHiddenCheckpoint({
      cwd: worktree, scopeId: SCOPE, ref, apply: true,
      assertTargets: (targets) => {
        seen.push([...targets]);
        throw new Error('namespace protegido');
      },
    });

    await expect(result).rejects.toThrow('namespace protegido');
    expect(seen).toEqual([['feito.txt']]);
    expect(read(worktree, 'feito.txt')).toBe('quebrado\n');
    expect(checkpointRefs(repo)).toHaveLength(1);
  });

  it('captura respeita prazo global: estoura em timeout e não publica ref', async () => {
    write(repo, 'novo.txt', 'x\n');
    const real = new AsyncProcessGitRunner();
    const slow: AsyncGitRunner = {
      run: async (cwd, args, options) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return real.run(cwd, args, options);
      },
    };

    const result = await captureHiddenCheckpoint(
      { cwd: repo, scopeId: SCOPE, deadlineAt: Date.now() + 400 },
      { git: slow },
    );

    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(checkpointRefs(repo)).toEqual([]);
  });
});
