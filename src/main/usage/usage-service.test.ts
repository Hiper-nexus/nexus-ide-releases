import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
