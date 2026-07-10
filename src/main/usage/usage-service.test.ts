import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { UsageTelemetryService } from './usage-service';
import { ProjectUsageStoreRegistry } from './usage-store-registry';

let sqliteAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
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
      global: { inputTokens: 10, outputTokens: 2, turns: 1 },
    });
    expect(service.snapshot(scopeB)).toMatchObject({
      byPane: { 'pane-b': { inputTokens: 99, turns: 1 } },
      global: { inputTokens: 99, outputTokens: 7, turns: 1 },
    });
    expect(service.snapshot(scopeA).byPane).not.toHaveProperty('pane-b');
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
    expect(() => service.snapshot(conflicting)).toThrow(/multiple project scopes/i);
    service.stop();
  });
});
