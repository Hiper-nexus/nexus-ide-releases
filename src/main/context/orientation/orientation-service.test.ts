import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../../shared/types';
import type { AsyncGitRunner } from '../../runtime/worktree-manager';
import {
  ProjectOrientationService,
  __resetProjectOrientationServiceForTests,
  configureProjectOrientationService,
  scheduleProjectOrientationAfterMerge,
} from './orientation-service';
import { readOrientationCache } from './orientation-cache';
import { readOrientationStructuralIndex } from './orientation-structural-index-cache';

const roots: string[] = [];

function scopeFor(root: string): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'install-orientation',
    projectId: 'project-orientation',
    checkoutId: 'checkout-orientation',
    rootRealPath: root,
    identitySource: 'provisional' as const,
  });
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode: 0o600 });
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

afterEach(() => {
  __resetProjectOrientationServiceForTests();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ProjectOrientationService P0', () => {
  it('builds inventory, hubs, markdown and persists cache by checkout', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-cache-'));
    roots.push(root, cacheRoot);

    write(
      root,
      'package.json',
      JSON.stringify({
        name: 'demo-app',
        scripts: { test: 'vitest', typecheck: 'tsc -p .' },
      }),
    );
    write(root, 'README.md', '# Demo\n');
    write(
      root,
      'src/main.ts',
      'export class AuthService {}\nexport function createSession() { return 1; }\n',
    );
    write(root, 'src/util.ts', 'export const helper = () => 1;\n');
    write(root, '.env', 'SECRET=do-not-read\n');

    const service = new ProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
    });
    const scope = scopeFor(root);
    const map = await service.ensure(scope, { reason: 'workspace-open' });

    expect(map.status === 'ready' || map.status === 'partial').toBe(true);
    expect(map.inventory.projectName).toBe('demo-app');
    expect(map.inventory.scripts.test).toBe('vitest');
    expect(map.inventory.languages.some((lang) => lang.id === 'ts')).toBe(true);
    expect(map.symbols.symbolCount).toBeGreaterThan(0);
    expect(map.symbols.hubs.some((hub) => hub.name === 'AuthService')).toBe(true);
    expect(map.orientationMarkdown).toContain('Project orientation');
    expect(map.orientationMarkdown).toContain('demo-app');
    expect(map.orientationMarkdown).not.toContain('SECRET=do-not-read');
    expect(map.contextSummary.ready).toBe(false);
    expect(map.mapHash).toMatch(/^[a-f0-9]{64}$/);

    const cached = readOrientationCache(cacheRoot, scope);
    expect(cached?.mapHash).toBe(map.mapHash);
    expect(readOrientationStructuralIndex(cacheRoot, scope)?.files.length).toBe(
      map.inventory.fileCount,
    );

    const second = await service.ensure(scope, { reason: 'workspace-open' });
    expect(second.mapHash).toBe(map.mapHash);
    expect(second.buildDurationMs).toBe(map.buildDurationMs);
  });

  it('does not treat orientation as curing missing business context', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-cache-'));
    roots.push(root, cacheRoot);
    write(root, 'src/a.ts', 'export const a = 1;\n');

    const service = configureProjectOrientationService({
      cacheRoot,
      includeContextSummary: true,
    });
    const map = await service.ensure(scopeFor(root), { reason: 'mcp' });
    expect(map.status === 'ready' || map.status === 'partial').toBe(true);
    expect(map.contextSummary.ready).toBe(false);
    expect(map.docs.contextDocsMissing.length).toBeGreaterThan(0);
    expect(map.orientationMarkdown).toContain('Ready: false');
  });

  it('returns a snapshot without absolute paths', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-cache-'));
    roots.push(root, cacheRoot);
    write(root, 'src/index.ts', 'export function boot() {}\n');

    const service = new ProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
    });
    const map = await service.refresh(scopeFor(root));
    const snapshot = service.toSnapshot(map);
    expect(snapshot.orientationMarkdown).not.toContain(root);
    expect(JSON.stringify(snapshot)).not.toContain(root);
  });

  it('rehydrates hub symbols from disk cache (no empty knownSymbols)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-cache-'));
    roots.push(root, cacheRoot);
    write(root, 'src/AuthService.ts', 'export class AuthService {}\n');

    const writer = new ProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
    });
    const first = await writer.ensure(scopeFor(root), { reason: 'workspace-open' });
    expect(first.symbols.hubs.some((h) => h.name === 'AuthService')).toBe(true);

    // New service instance forces disk-cache rehydrate path.
    const reader = new ProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
    });
    const cached = reader.get(scopeFor(root));
    expect(cached).not.toBeNull();
    expect(cached!.symbols.symbols.size).toBeGreaterThan(0);
    expect(cached!.symbols.symbols.has('AuthService')).toBe(true);
  });

  it('fails fast on cancellation without publishing a failed map or cache', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-cache-'));
    roots.push(root, cacheRoot);
    write(root, 'src/index.ts', 'export const boot = true;\n');
    const service = new ProjectOrientationService({ cacheRoot, includeContextSummary: false });
    const scope = scopeFor(root);
    const controller = new AbortController();
    controller.abort();
    await expect(service.ensure(scope, {
      reason: 'pre-kickoff', signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.get(scope)).toBeNull();
    expect(readOrientationCache(cacheRoot, scope)).toBeNull();
  });

  it('force rebuild proceeds after waitMs when the previous build never settles', async () => {
    // Fake only setTimeout: sleep() is controllable while the build's real
    // setImmediate yields stay pending (the test never leaves its macrotask
    // before the second ensure is queued), so the first build never settles.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-')));
      const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-cache-'));
      roots.push(root, cacheRoot);
      write(root, 'src/index.ts', 'export const boot = true;\n');
      const service = new ProjectOrientationService({ cacheRoot, includeContextSummary: false });
      const scope = scopeFor(root);

      const first = await service.ensure(scope, {
        reason: 'workspace-open', force: true, waitMs: 0,
      });
      expect(first.status).toBe('building');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const second = service.ensure(scope, {
        reason: 'pre-kickoff', force: true, waitMs: 1_000,
      });

      // waitMs expires before the stuck build: warn and keep going.
      vi.advanceTimersByTime(1_000);
      // Flush the promise chain (race -> awaitWithSignal -> warn) fully.
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('previous build still in flight'),
      );

      // The forced rebuild is itself bounded by waitMs and resolves.
      vi.advanceTimersByTime(1_000);
      await expect(second).resolves.toMatchObject({
        status: expect.stringMatching(/building|ready|partial/),
      });
      warnSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates the native structural map from merged files without walking the tree again', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-delta-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-delta-cache-'));
    roots.push(root, cacheRoot);
    git(root, ['init', '--quiet']);
    git(root, ['config', 'user.name', 'Nexus Test']);
    git(root, ['config', 'user.email', 'nexus@example.invalid']);

    write(root, 'src/a.ts', "import { oldService } from './old';\nexport const a = oldService;\n");
    write(root, 'src/old.ts', 'export const oldService = 1;\n');
    write(root, 'node_modules/noise/index.ts', 'export const dependencyNoise = true;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '--quiet', '-m', 'base']);
    const baseHeadSha = git(root, ['rev-parse', 'HEAD']);

    const service = new ProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
    });
    const scope = scopeFor(root);
    const initial = await service.ensure(scope, { reason: 'workspace-open' });
    expect(initial.graph.adjacency?.['src/a.ts']).toContain('src/old.ts');
    expect(initial.symbols.symbols.has('oldService')).toBe(true);

    fs.rmSync(path.join(root, 'src/old.ts'));
    write(root, 'src/a.ts', "import { NewService } from './new';\nexport const a = NewService;\n");
    write(root, 'src/new.ts', 'export class NewService {}\n');
    write(root, '.dev-user-data/cache/generated.ts', 'export class DevNoise {}\n');
    write(root, 'dist/generated.ts', 'export class DistNoise {}\n');
    write(root, 'out/generated.ts', 'export class OutNoise {}\n');
    write(root, 'worktrees/stale/generated.ts', 'export class WorktreeNoise {}\n');
    git(root, ['add', '--all']);
    git(root, ['commit', '--quiet', '-m', 'incremental']);
    const integratedSha = git(root, ['rev-parse', 'HEAD']);

    const readdir = vi.spyOn(fs.promises, 'readdir').mockRejectedValue(
      new Error('incremental orientation must not recurse through the workspace'),
    );
    try {
      const updated = await service.refreshAfterMerge(scope, {
        integrationBaseSha: baseHeadSha,
        integratedSha,
        changedFiles: [
          'src/a.ts',
          'src/old.ts',
          'src/new.ts',
          '.dev-user-data/cache/generated.ts',
          'dist/generated.ts',
          'out/generated.ts',
          'worktrees/stale/generated.ts',
        ],
      });

      expect(updated.headSha).toBe(integratedSha);
      expect(updated.graph.adjacency?.['src/a.ts']).toEqual(['src/new.ts']);
      expect(updated.graph.adjacency?.['src/a.ts']).not.toContain('src/old.ts');
      expect(updated.symbols.symbols.has('NewService')).toBe(true);
      expect(updated.symbols.symbols.has('oldService')).toBe(false);
      expect(updated.symbols.symbols.has('DevNoise')).toBe(false);
      expect(updated.symbols.symbols.has('DistNoise')).toBe(false);
      expect(updated.symbols.symbols.has('OutNoise')).toBe(false);
      expect(updated.symbols.symbols.has('WorktreeNoise')).toBe(false);
      expect(updated.inventory.fileCount).toBe(2);
    } finally {
      readdir.mockRestore();
    }
  });

  it('schedules post-merge orientation without blocking the merge caller', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-hook-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-hook-cache-'));
    roots.push(root, cacheRoot);
    write(root, 'src/index.ts', 'export const boot = true;\n');
    const service = configureProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
    });
    const map = await service.ensure(scopeFor(root), { reason: 'workspace-open' });
    const refresh = vi.spyOn(service, 'refreshAfterMerge').mockResolvedValue(map);

    scheduleProjectOrientationAfterMerge(scopeFor(root), {
      integrationBaseSha: 'a'.repeat(40),
      integratedSha: 'b'.repeat(40),
      changedFiles: ['src/index.ts'],
    });
    expect(refresh).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('returns from the post-merge hook before slow scan and async Git settle', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-hook-')));
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-orient-hook-cache-'));
    roots.push(root, cacheRoot);

    let releaseGit!: () => void;
    const gitGate = new Promise<void>((resolve) => {
      releaseGit = resolve;
    });
    const asyncGitRunner: AsyncGitRunner = {
      run: vi.fn(async () => {
        await gitGate;
        return {
          status: 0,
          stdout: `${'c'.repeat(40)}\n`,
          stderr: '',
        };
      }),
    };
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const treeWalker = vi.fn(async () => {
      await scanGate;
      return Object.freeze({
        files: Object.freeze([]),
        truncated: false,
        treeFingerprintParts: Object.freeze([]),
      });
    });
    const service = configureProjectOrientationService({
      cacheRoot,
      includeContextSummary: false,
      asyncGitRunner,
      treeWalker,
    });
    const refresh = vi.spyOn(service, 'refreshAfterMerge');

    scheduleProjectOrientationAfterMerge(scopeFor(root), {
      integrationBaseSha: 'a'.repeat(40),
      integratedSha: 'b'.repeat(40),
      changedFiles: ['src/index.ts'],
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(treeWalker).not.toHaveBeenCalled();
    expect(asyncGitRunner.run).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledOnce();
      expect(treeWalker).toHaveBeenCalledOnce();
      expect(asyncGitRunner.run).toHaveBeenCalledOnce();
    });

    let settled = false;
    const refreshPromise = refresh.mock.results[0].value.finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseScan();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseGit();
    await expect(refreshPromise).resolves.toMatchObject({
      status: 'ready',
      headSha: 'c'.repeat(40),
    });
  });
});
