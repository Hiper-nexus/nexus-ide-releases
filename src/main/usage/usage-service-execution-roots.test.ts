import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';

const mocks = vi.hoisted(() => ({
  dictationHook: null as null | ((info: unknown) => void),
  resumeLookup: null as null | ((...args: unknown[]) => unknown),
  watcherOptions: [] as Array<{
    workspacePath: string;
    workspacePaths?: () => Iterable<string>;
  }>,
}));

vi.mock('../pty/pty-manager', () => ({
  setSessionDictationHook: (
    hook: null | ((info: unknown) => void),
  ) => {
    mocks.dictationHook = hook;
  },
  setResumeSessionLookup: (
    lookup: null | ((...args: unknown[]) => unknown),
  ) => {
    mocks.resumeLookup = lookup;
  },
}));

vi.mock('../orch/pane-registry', () => ({
  getPaneAuthzInfo: vi.fn(() => null),
}));

vi.mock('../gamification/gamification-service', () => ({
  requireGamificationService: vi.fn(() => {
    throw new Error('gamification is not configured in this unit test');
  }),
}));

vi.mock('../persistence/provider-session-store', () => ({
  getProviderPaneSession: vi.fn(() => null),
  saveProviderPaneSession: vi.fn(),
}));

vi.mock('./claude-transcript-watcher', () => ({
  ClaudeTranscriptWatcher: class {
    constructor(options: {
      workspacePath: string;
      workspacePaths?: () => Iterable<string>;
    }) {
      mocks.watcherOptions.push(options);
    }

    start(): void {}

    stop(): void {}
  },
}));

import {
  bindTokenToSession,
  mintToken,
  resetGateForTests,
} from '../orch/gate';
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

const tempRoots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function scopeFixture(
  parent: string,
  checkoutId: string,
): ProjectExecutionScope {
  const checkout = path.join(parent, checkoutId);
  fs.mkdirSync(checkout, { recursive: true });
  return Object.freeze({
    version: 1,
    installationId: 'install-a',
    projectId: 'project-a',
    checkoutId,
    rootRealPath: fs.realpathSync(checkout),
    identitySource: 'manifest',
  });
}

function executionScope(
  scope: ProjectExecutionScope,
  root: string,
): ProjectExecutionScope {
  fs.mkdirSync(root, { recursive: true });
  return Object.freeze({
    ...scope,
    rootRealPath: fs.realpathSync(root),
  });
}

function dictateClaude(
  ptySessionId: string,
  cwd: string,
): void {
  if (!mocks.dictationHook) {
    throw new Error('usage service did not install its dictation hook');
  }
  mocks.dictationHook({
    providerSessionId: null,
    ptySessionId,
    adapterId: 'claude',
    cwd,
  });
}

afterEach(() => {
  resetGateForTests();
  mocks.dictationHook = null;
  mocks.resumeLookup = null;
  mocks.watcherOptions.length = 0;
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!sqliteAvailable)(
  'UsageTelemetryService Claude execution roots',
  () => {
    it('keeps each checkout watcher bound to its own authorized worktrees', () => {
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'usage-claude-roots-'),
      );
      tempRoots.push(parent);
      const scopeA = scopeFixture(parent, 'checkout-a');
      const scopeB = scopeFixture(parent, 'checkout-b');
      const worktreeA = executionScope(
        scopeA,
        path.join(parent, 'worktrees', 'a-task'),
      );
      const worktreeB = executionScope(
        scopeB,
        path.join(parent, 'worktrees', 'b-task'),
      );
      fs.mkdirSync(path.join(worktreeA.rootRealPath, 'src'));
      const manager = new ProjectRuntimeManager({
        baseDir: path.join(parent, 'runtime'),
        appVersion: 'usage-service-test',
      });
      managers.push(manager);
      const service = new UsageTelemetryService(
        new ProjectUsageStoreRegistry(manager),
      );
      service.start();

      const tokenA = mintToken({
        label: 'worker-a',
        role: 'worker',
        scope: scopeA,
        executionScope: worktreeA,
      });
      bindTokenToSession(tokenA.token, 'pty-a');
      dictateClaude('pty-a', path.join(worktreeA.rootRealPath, 'src'));

      const tokenB = mintToken({
        label: 'worker-b',
        role: 'worker',
        scope: scopeB,
        executionScope: worktreeB,
      });
      bindTokenToSession(tokenB.token, 'pty-b');
      dictateClaude('pty-b', worktreeB.rootRealPath);

      expect(mocks.watcherOptions).toHaveLength(2);
      expect(mocks.watcherOptions[0].workspacePath).toBe(
        scopeA.rootRealPath,
      );
      expect([
        ...(mocks.watcherOptions[0].workspacePaths?.() ?? []),
      ]).toEqual([scopeA.rootRealPath, worktreeA.rootRealPath]);
      expect([
        ...(mocks.watcherOptions[1].workspacePaths?.() ?? []),
      ]).toEqual([scopeB.rootRealPath, worktreeB.rootRealPath]);
      expect([
        ...(mocks.watcherOptions[0].workspacePaths?.() ?? []),
      ]).not.toContain(worktreeB.rootRealPath);
      expect([
        ...(mocks.watcherOptions[1].workspacePaths?.() ?? []),
      ]).not.toContain(worktreeA.rootRealPath);

      service.stop();
    });

    it('rejects one physical execution root claimed by another checkout', () => {
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'usage-claude-collision-'),
      );
      tempRoots.push(parent);
      const scopeA = scopeFixture(parent, 'checkout-a');
      const scopeB = scopeFixture(parent, 'checkout-b');
      const sharedRoot = path.join(parent, 'worktrees', 'shared-task');
      const executionA = executionScope(scopeA, sharedRoot);
      const executionB = Object.freeze({
        ...scopeB,
        rootRealPath: executionA.rootRealPath,
      });
      const manager = new ProjectRuntimeManager({
        baseDir: path.join(parent, 'runtime'),
        appVersion: 'usage-service-test',
      });
      managers.push(manager);
      const service = new UsageTelemetryService(
        new ProjectUsageStoreRegistry(manager),
      );
      service.start();

      const tokenA = mintToken({
        label: 'worker-a',
        role: 'worker',
        scope: scopeA,
        executionScope: executionA,
      });
      bindTokenToSession(tokenA.token, 'pty-a');
      dictateClaude('pty-a', executionA.rootRealPath);

      const tokenB = mintToken({
        label: 'worker-b',
        role: 'worker',
        scope: scopeB,
        executionScope: executionB,
      });
      bindTokenToSession(tokenB.token, 'pty-b');

      expect(() =>
        dictateClaude('pty-b', executionB.rootRealPath),
      ).toThrow(/execution root.*multiple project scopes/i);

      service.stop();
    });
  },
);
