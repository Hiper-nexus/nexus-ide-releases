import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import {
  UsageTelemetryService,
  isUsageCwdAuthorized,
} from './usage-service';
import { ProjectUsageStoreRegistry } from './usage-store-registry';

let sqliteAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- sonda: o better-sqlite3 pode estar compilado para o ABI do Electron; o require no try decide se a suíte roda
  const Database = require('better-sqlite3') as new (file: string) => {
    close(): void;
  };
  new Database(':memory:').close();
} catch {
  sqliteAvailable = false;
}

const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function scopeFixture(
  parent: string,
  projectId: string,
  checkoutId: string,
): ProjectExecutionScope {
  const checkout = path.join(parent, checkoutId);
  fs.mkdirSync(checkout);
  return Object.freeze({
    version: 1,
    installationId: 'install-a',
    projectId,
    checkoutId,
    rootRealPath: fs.realpathSync(checkout),
    identitySource: 'manifest',
  });
}

afterEach(() => {
  for (const runtimeManager of managers.splice(0)) runtimeManager.closeAll();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!sqliteAvailable)('UsageTelemetryService snapshots', () => {
  it('rebuilds every pane/global snapshot from the requested checkout database', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-service-'));
    roots.push(parent);
    const scopeA = scopeFixture(parent, 'project-a', 'checkout-a');
    const scopeB = scopeFixture(parent, 'project-a', 'checkout-b');
    const runtimeManager = new ProjectRuntimeManager({
      baseDir: path.join(parent, 'runtime'),
      appVersion: 'usage-service-test',
    });
    managers.push(runtimeManager);
    const registry = new ProjectUsageStoreRegistry(runtimeManager);
    registry.forScope(scopeA).usage.record('claude', {
      sessionId: 'same-session',
      messageId: 'a',
      model: 'claude-sonnet-4-5',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      timestamp: 100,
      paneId: 'pane-a',
      accountId: 'acct-a',
    });
    registry.forScope(scopeB).usage.record('codex', {
      sessionId: 'same-session',
      messageId: 'b',
      model: 'gpt-5',
      inputTokens: 99,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      timestamp: 200,
      paneId: 'pane-b',
    });
    const service = new UsageTelemetryService(registry);

    expect(service.snapshot(scopeA)).toMatchObject({
      byPane: { 'pane-a': { inputTokens: 10, turns: 1 } },
      byAccount: {
        'acct-a': {
          accountId: 'acct-a',
          provider: 'claude',
          inputTokens: 10,
          turns: 1,
        },
      },
      global: { inputTokens: 10, outputTokens: 2, turns: 1 },
    });
    expect(service.snapshot(scopeB)).toMatchObject({
      byPane: { 'pane-b': { inputTokens: 99, turns: 1 } },
      global: { inputTokens: 99, outputTokens: 7, turns: 1 },
    });
    expect(service.snapshot(scopeA)?.byPane).not.toHaveProperty('pane-b');
    service.stop();
  });

  it('carries the cost panel rollup and recomputes it at most once a minute', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-analytics-'));
    roots.push(parent);
    const scope = scopeFixture(parent, 'project-a', 'checkout-a');
    const runtimeManager = new ProjectRuntimeManager({
      baseDir: path.join(parent, 'runtime'),
      appVersion: 'usage-service-test',
    });
    managers.push(runtimeManager);
    const registry = new ProjectUsageStoreRegistry(runtimeManager);
    const usage = registry.forScope(scope).usage;
    const record = (messageId: string, outputTokens: number) =>
      usage.record('claude', {
        sessionId: 'session-a',
        messageId,
        model: 'claude-sonnet-4-5',
        inputTokens: 10,
        outputTokens,
        cacheReadTokens: 100,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        timestamp: Date.now(),
      });
    record('a', 2);
    const rollup = vi.spyOn(usage, 'analytics');
    const clock = vi.spyOn(Date, 'now');
    const start = Date.now();
    clock.mockReturnValue(start);
    const service = new UsageTelemetryService(registry);

    const first = service.snapshot(scope)?.analytics;
    expect(first?.windows[30].totals).toMatchObject({
      cachedInputTokens: 100,
      uncachedInputTokens: 10,
      outputTokens: 2,
      sessions: 1,
    });
    expect(first?.windows[30].byProvider.map((row) => row.provider)).toEqual(['claude']);

    // O broadcast de 1 s reaproveita o rollup dentro do minuto.
    record('b', 5);
    clock.mockReturnValue(start + 30_000);
    expect(service.snapshot(scope)?.global.outputTokens).toBe(7);
    expect(service.snapshot(scope)?.analytics?.windows[30].totals.outputTokens).toBe(2);
    expect(rollup).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(start + 61_000);
    expect(service.snapshot(scope)?.analytics?.windows[30].totals.outputTokens).toBe(7);
    expect(rollup).toHaveBeenCalledTimes(2);

    // Falha no rollup não derruba o snapshot: segue com o último resumo.
    rollup.mockImplementation(() => {
      throw new Error('rollup indisponível');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clock.mockReturnValue(start + 125_000);
    const degraded = service.snapshot(scope);
    expect(degraded?.global.outputTokens).toBe(7);
    expect(degraded?.analytics?.windows[30].totals.outputTokens).toBe(7);
    warn.mockRestore();
    clock.mockRestore();
    service.stop();
  });

  it('rejects two identities claiming the same physical checkout', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-collision-'));
    roots.push(parent);
    const scopeA = scopeFixture(parent, 'project-a', 'checkout-a');
    const conflicting: ProjectExecutionScope = Object.freeze({
      ...scopeA,
      projectId: 'project-b',
      checkoutId: 'checkout-b',
    });
    const runtimeManager = new ProjectRuntimeManager({
      baseDir: path.join(parent, 'runtime'),
      appVersion: 'usage-service-test',
    });
    managers.push(runtimeManager);
    const service = new UsageTelemetryService(
      new ProjectUsageStoreRegistry(runtimeManager),
    );
    service.snapshot(scopeA);
    expect(service.snapshot(conflicting)).toBeNull();
    service.stop();
  });

  it('keeps equal project/checkout ids isolated across physical roots', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-scope-key-'));
    roots.push(parent);
    const rootA = path.join(parent, 'root-a');
    const rootB = path.join(parent, 'root-b');
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);
    const scopeA: ProjectExecutionScope = Object.freeze({
      version: 1,
      installationId: 'install-a',
      projectId: 'project-shared',
      checkoutId: 'checkout-shared',
      rootRealPath: fs.realpathSync(rootA),
      identitySource: 'manifest',
    });
    const scopeB: ProjectExecutionScope = Object.freeze({
      ...scopeA,
      rootRealPath: fs.realpathSync(rootB),
    });
    const runtimeManager = new ProjectRuntimeManager({
      baseDir: path.join(parent, 'runtime'),
      appVersion: 'usage-service-test',
    });
    managers.push(runtimeManager);
    const registry = new ProjectUsageStoreRegistry(runtimeManager);
    const service = new UsageTelemetryService(registry);

    expect(() => service.snapshot(scopeA)).not.toThrow();
    expect(() => service.snapshot(scopeB)).not.toThrow();
    expect(service.snapshot(scopeA)?.global.inputTokens).toBe(0);
    expect(service.snapshot(scopeB)?.global.inputTokens).toBe(0);
    expect(service.snapshot(scopeA)?.byPane).not.toHaveProperty('pane-b');
    expect(service.snapshot(scopeB)?.byPane).not.toHaveProperty('pane-a');
    service.stop();
  });
});

describe('usage cwd authority', () => {
  it('accepts an isolated worktree only through the execution scope', () => {
    const coordination = Object.freeze({
      version: 1 as const,
      installationId: 'install-a',
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: '/workspace/project',
      identitySource: 'manifest' as const,
    });
    const execution = Object.freeze({
      ...coordination,
      rootRealPath: '/private/worktrees/task-1',
    });

    expect(
      isUsageCwdAuthorized(
        { scope: coordination, executionScope: execution },
        '/private/worktrees/task-1',
      ),
    ).toBe(true);
    expect(
      isUsageCwdAuthorized(
        { scope: coordination, executionScope: execution },
        '/private/worktrees/task-1/src',
      ),
    ).toBe(true);
    expect(
      isUsageCwdAuthorized(
        { scope: coordination, executionScope: execution },
        '/workspace/project',
      ),
    ).toBe(false);
    expect(
      isUsageCwdAuthorized(
        { scope: coordination, executionScope: execution },
        '/private/worktrees/task-10',
      ),
    ).toBe(false);
  });
});
