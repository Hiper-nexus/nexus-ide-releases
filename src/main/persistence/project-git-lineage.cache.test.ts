/**
 * Cache da prova de linhagem: a resolução de identidade roda 8–10 spawns
 * síncronos de git por chamada; com a prova cacheada por fingerprint do
 * estado do repositório, o caminho quente fica livre de git. Todo o cache é
 * FAIL-CLOSED: fingerprint que não puder ser provado igual recomputa.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGitRepositoryContextCache,
  collectGitRepositoryContext,
  collectGitRepositoryProof,
  gitProofStats,
  processGitRunner,
  warmGitRepositoryContext,
  type GitRepositoryContext,
  type ProjectGitRunner,
} from './project-git-lineage';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

describe('git repository proof cache', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-lineage-cache-')),
    );
    fs.mkdirSync(root, { recursive: true });
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Nexus Test');
    git(root, 'config', 'user.email', 'nexus@example.invalid');
    fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
    git(root, 'add', 'file.txt');
    git(root, 'commit', '-qm', 'base');
    clearGitRepositoryContextCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearGitRepositoryContextCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('segunda coleta serve do cache sem novo git síncrono', () => {
    const first = collectGitRepositoryContext(root);
    const before = gitProofStats();
    const second = collectGitRepositoryContext(root);
    expect(second).toEqual(first);
    const after = gitProofStats();
    expect(after.contextSyncRuns).toBe(before.contextSyncRuns);
    expect(after.contextHits).toBe(before.contextHits + 1);
  });

  it('commit novo (HEAD mudou) invalida e recomputa', () => {
    const first = collectGitRepositoryContext(root);
    fs.writeFileSync(path.join(root, 'file.txt'), 'changed\n');
    git(root, 'commit', '-qam', 'change');
    const before = gitProofStats();
    const second = collectGitRepositoryContext(root);
    expect(second.proof.headCommit).not.toBe(first.proof.headCommit);
    expect(gitProofStats().contextSyncRuns).toBe(before.contextSyncRuns + 1);
    expect(gitProofStats().contextHits).toBe(before.contextHits);
  });

  it('troca de ref preservando o mtime ainda invalida (ctimeNs)', () => {
    git(root, 'branch', 'alias');
    collectGitRepositoryContext(root);
    const head = path.join(root, '.git', 'HEAD');
    const stat = fs.statSync(head);
    fs.writeFileSync(head, 'ref: refs/heads/alias\n');
    // Restaura o mtime (ataque de touch -r): só o ctime denuncia a troca.
    fs.utimesSync(head, stat.atime, stat.mtime);
    const before = gitProofStats();
    collectGitRepositoryContext(root);
    expect(gitProofStats().contextSyncRuns).toBe(before.contextSyncRuns + 1);
    expect(gitProofStats().contextHits).toBe(before.contextHits);
  });

  it('runner customizado nunca usa (nem polui) o cache', () => {
    let calls = 0;
    const counting: ProjectGitRunner = {
      run(cwd, args, options) {
        calls += 1;
        return processGitRunner.run(cwd, args, options);
      },
    };
    const before = gitProofStats();
    collectGitRepositoryContext(root, counting);
    collectGitRepositoryContext(root, counting);
    expect(calls).toBeGreaterThan(0);
    const after = gitProofStats();
    expect(after.contextSyncRuns).toBe(before.contextSyncRuns);
    expect(after.contextHits).toBe(before.contextHits);
  });

  it('TTL vencido recomputa mesmo sem mudança no disco', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    collectGitRepositoryContext(root);
    const before = gitProofStats();
    vi.setSystemTime(new Date('2026-01-01T00:06:00Z'));
    collectGitRepositoryContext(root);
    expect(gitProofStats().contextSyncRuns).toBe(before.contextSyncRuns + 1);
  });

  it('aquecimento assíncrono popula o cache sem rodar git síncrono', async () => {
    await warmGitRepositoryContext(root);
    const before = gitProofStats();
    expect(before.warmRuns).toBeGreaterThan(0);
    const served = collectGitRepositoryContext(root);
    const after = gitProofStats();
    expect(after.contextSyncRuns).toBe(before.contextSyncRuns);
    expect(after.contextHits).toBe(before.contextHits + 1);
    expect(served.gitDirRealPath).toBe(
      fs.realpathSync.native(path.join(root, '.git')),
    );
    expect(served.proof.headCommit).toMatch(/^[a-f0-9]{40}$/);
  });

  it('clear derruba o cache', () => {
    collectGitRepositoryContext(root);
    clearGitRepositoryContextCache();
    const before = gitProofStats();
    collectGitRepositoryContext(root);
    expect(gitProofStats().contextSyncRuns).toBe(before.contextSyncRuns + 1);
  });

  // H1: o store não pode gravar {fingerprint novo, prova antiga} quando o
  // disco muda no meio da coleta — a leitura seguinte serviria o origin
  // velho ao F-107 por até 5 minutos.
  it('origin trocado DURANTE a coleta não vira cache podre (TOCTOU do store)', () => {
    git(root, 'remote', 'add', 'origin', 'https://example.invalid/before.git');
    // Shim na frente do PATH: quando a prova chega ao rev-list (depois de ler
    // o origin), troca a URL no disco e delega ao git real. A prova prependa
    // `--no-replace-objects`, então o subcomando é o $2.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-git-shim-'));
    const shim = path.join(shimDir, 'git');
    fs.writeFileSync(
      shim,
      [
        '#!/bin/sh',
        'if [ "$2" = "rev-list" ]; then',
        '  /usr/bin/git remote set-url origin https://example.invalid/after.git >/dev/null 2>&1 || true',
        'fi',
        'exec /usr/bin/git "$@"',
        '',
      ].join('\n'),
    );
    fs.chmodSync(shim, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;
    let duringRace: GitRepositoryContext | undefined;
    try {
      duringRace = collectGitRepositoryContext(root);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
    const before = gitProofStats();
    const second = collectGitRepositoryContext(root);
    // Sem hit: o store só grava prova casada com o disco que ela leu.
    expect(gitProofStats().contextSyncRuns).toBe(before.contextSyncRuns + 1);
    expect(gitProofStats().contextHits).toBe(before.contextHits);
    const truth = collectGitRepositoryProof(root);
    expect(second.proof.originHashes).toEqual(truth.originHashes);
    expect(duringRace?.proof.originHashes).not.toEqual(truth.originHashes);
  });

  // M1a: stat só do primeiro ref é cego a update-ref no DESTINO de um symref.
  it('update-ref no destino de um symref (HEAD→alias→main) invalida', () => {
    git(root, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main');
    git(root, 'symbolic-ref', 'HEAD', 'refs/heads/alias');
    const first = collectGitRepositoryContext(root);
    // Commit novo sem tocar no worktree: só o ref de destino (main) é
    // reescrito — alias, HEAD e a raiz ficam intocados.
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const next = execFileSync('git', ['-C', root, 'commit-tree', tree, '-m', 'two'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git(root, 'update-ref', 'refs/heads/main', next);
    const before = gitProofStats();
    const second = collectGitRepositoryContext(root);
    expect(second.proof.headCommit).toBe(next);
    expect(first.proof.headCommit).not.toBe(next);
    expect(gitProofStats().contextSyncRuns).toBe(before.contextSyncRuns + 1);
    expect(gitProofStats().contextHits).toBe(before.contextHits);
  });

  // M1b: reftable é outra fonte de refs que o fingerprint não via. Criar o
  // diretório já invalida pelo stat do gitdir; o buraco é a EDIÇÃO do
  // tables.list, que não toca nenhum outro token.
  it('edição de reftable/tables.list invalida o cache', () => {
    fs.mkdirSync(path.join(root, '.git', 'reftable'), { recursive: true });
    const tables = path.join(root, '.git', 'reftable', 'tables.list');
    fs.writeFileSync(tables, '00000001 fake-a\n');
    collectGitRepositoryContext(root);
    fs.writeFileSync(tables, '00000002 fake-b\n');
    const before = gitProofStats();
    collectGitRepositoryContext(root);
    expect(gitProofStats().contextSyncRuns).toBe(before.contextSyncRuns + 1);
    expect(gitProofStats().contextHits).toBe(before.contextHits);
  });

  // M1c: shallow e info/grafts vivem no COMMON dir; numa worktree vinculada
  // o fingerprint estatava o gitdir particular e era cego a edições no common.
  it('shallow e info/grafts do common dir invalidam a worktree vinculada', () => {
    const linkedPath = `${root}-linked`;
    git(root, 'worktree', 'add', '-q', linkedPath, '-b', 'linked-branch');
    const linked = fs.realpathSync.native(linkedPath);
    try {
      collectGitRepositoryContext(linked);
      const common = path.join(root, '.git');
      const before = gitProofStats();
      fs.writeFileSync(
        path.join(common, 'shallow'),
        `${git(root, 'rev-parse', 'HEAD')}\n`,
      );
      const afterShallow = collectGitRepositoryContext(linked);
      expect(gitProofStats().contextSyncRuns).toBe(before.contextSyncRuns + 1);
      expect(gitProofStats().contextHits).toBe(before.contextHits);
      expect(afterShallow.proof.isShallow).toBe(true);
      fs.mkdirSync(path.join(common, 'info'), { recursive: true });
      fs.writeFileSync(path.join(common, 'info', 'grafts'), '\n');
      const mid = gitProofStats();
      collectGitRepositoryContext(linked);
      expect(gitProofStats().contextSyncRuns).toBe(mid.contextSyncRuns + 1);
      expect(gitProofStats().contextHits).toBe(mid.contextHits);
    } finally {
      fs.rmSync(linkedPath, { recursive: true, force: true });
    }
  });
});
