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
  gitProofStats,
  processGitRunner,
  warmGitRepositoryContext,
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
});
