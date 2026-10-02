import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';

const mocks = vi.hoisted(() => ({
  dictationHook: null as null | ((info: unknown) => void),
  resumeLookup: null as null | ((...args: unknown[]) => unknown),
  userDataDir: '' as string,
  watcherOptions: [] as Array<{
    workspacePath: string;
    workspacePaths?: () => Iterable<string>;
  }>,
  codexScannerOptions: null as null | {
    isWatched: (cwd: string) => boolean;
    sessionsDirs?: () => readonly string[];
    onEvent: (event: {
      sessionId: string;
      messageId: string | null;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWrite5mTokens: number;
      cacheWrite1hTokens: number;
      timestamp: number | null;
    }, cwd: string, source: {
      providerSessionId: string;
      threadId: string;
      rolloutSessionId: string | null;
      sessionStartedAt: number | null;
      parentThreadId?: string;
    }) => void;
  },
  panes: new Map<string, {
    paneId: string;
    sessionId: string;
    kind: 'cli-agent';
    scope: ProjectExecutionScope;
    executionScope: ProjectExecutionScope;
  }>(),
  providerPaneSession: null as null | {
    key: 'session_id';
    id: string;
    transcriptPath?: string;
    accountId?: string;
  },
  savedPaneSessions: new Map<
    string,
    { sessionId: string; accountId: string | null }
  >(),
  saveProviderPaneSession: vi.fn(
    (
      _scope: ProjectExecutionScope,
      paneId: string,
      adapterId: string,
      session: { key: string; id: string },
      accountId?: string,
    ) => {
      mocks.savedPaneSessions.set(`${paneId}|${adapterId}`, {
        sessionId: session.id,
        accountId: accountId?.trim() || null,
      });
      return true;
    },
  ),
  recordAgentTurn: vi.fn(),
}));

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataDir },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => {}, handle: () => {} },
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
  getPaneAuthzInfo: vi.fn((paneRef: string) => mocks.panes.get(paneRef) ?? null),
}));

vi.mock('../gamification/gamification-service', () => ({
  requireGamificationService: vi.fn(() => ({
    recordAgentTurn: mocks.recordAgentTurn,
  })),
}));

vi.mock('../persistence/provider-session-store', () => ({
  getProviderPaneSession: vi.fn(
    (
      _scope: ProjectExecutionScope,
      paneId: string,
      adapterId: string,
      accountId?: string,
    ) => {
      if (mocks.providerPaneSession) return mocks.providerPaneSession;
      const row = mocks.savedPaneSessions.get(`${paneId}|${adapterId}`);
      if (!row) return null;
      const want = accountId?.trim() || null;
      if (want && row.accountId !== want) return null;
      return { key: 'session_id' as const, id: row.sessionId };
    },
  ),
  saveProviderPaneSession: mocks.saveProviderPaneSession,
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

vi.mock('./codex-scanner', () => ({
  CodexUsageScanner: class {
    constructor(options: typeof mocks.codexScannerOptions) {
      mocks.codexScannerOptions = options;
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
import { createScopedMissionPaneStore } from '../orch/mission-pane-store';
import { createScopedMissionStore } from '../orch/mission-store';
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

function dictateCodex(
  ptySessionId: string,
  paneId: string,
  cwd: string,
  providerSessionId: string | null = null,
  accountId?: string,
): void {
  if (!mocks.dictationHook) {
    throw new Error('usage service did not install its dictation hook');
  }
  mocks.dictationHook({
    providerSessionId,
    ptySessionId,
    paneId,
    adapterId: 'codex',
    cwd,
    ...(accountId ? { accountId } : {}),
  });
}

function codexUsage(
  sessionId: string,
  messageId: string,
  timestamp = Date.now(),
) {
  return {
    sessionId,
    messageId,
    model: 'gpt-5.6-luna',
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    timestamp,
  };
}

function codexSource(
  providerSessionId: string,
  options: {
    threadId?: string;
    rolloutSessionId?: string | null;
    sessionStartedAt?: number | null;
    parentThreadId?: string;
  } = {},
) {
  const threadId = options.threadId ?? providerSessionId;
  return {
    providerSessionId,
    threadId,
    rolloutSessionId: options.rolloutSessionId ?? threadId,
    sessionStartedAt: options.sessionStartedAt ?? Date.now(),
    ...(options.parentThreadId
      ? { parentThreadId: options.parentThreadId }
      : {}),
  };
}

afterEach(() => {
  resetGateForTests();
  mocks.dictationHook = null;
  mocks.resumeLookup = null;
  mocks.userDataDir = '';
  mocks.watcherOptions.length = 0;
  mocks.codexScannerOptions = null;
  mocks.panes.clear();
  mocks.providerPaneSession = null;
  mocks.savedPaneSessions.clear();
  mocks.saveProviderPaneSession.mockClear();
  mocks.recordAgentTurn.mockReset();
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

    it('never binds an external Codex session from the coordination checkout to a pending worktree launch', () => {
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'usage-codex-attribution-'),
      );
      tempRoots.push(parent);
      const scope = scopeFixture(parent, 'checkout-a');
      const workerRoot = executionScope(
        scope,
        path.join(parent, 'worktrees', 'task-a'),
      );
      const runtimeManager = new ProjectRuntimeManager({
        baseDir: path.join(parent, 'runtime'),
        appVersion: 'usage-service-test',
      });
      managers.push(runtimeManager);
      const registry = new ProjectUsageStoreRegistry(runtimeManager);
      const service = new UsageTelemetryService(registry);
      service.start();

      const token = mintToken({
        label: 'worker-a',
        role: 'worker',
        scope,
        executionScope: workerRoot,
      });
      bindTokenToSession(token.token, 'pty-worker-a');
      const pane = {
        paneId: 'pane-worker-a',
        sessionId: 'pty-worker-a',
        kind: 'cli-agent' as const,
        scope,
        executionScope: workerRoot,
      };
      mocks.panes.set('pty-worker-a', pane);
      mocks.panes.set('pane-worker-a', pane);
      dictateCodex(
        'pty-worker-a',
        pane.paneId,
        workerRoot.rootRealPath,
        'worker-session',
      );

      const onEvent = mocks.codexScannerOptions?.onEvent;
      expect(onEvent).toBeTypeOf('function');
      onEvent?.(
        codexUsage('external-session', 'external-current-event'),
        scope.rootRealPath,
        codexSource('external-session', {
          sessionStartedAt: Date.now() - 60_000,
        }),
      );
      expect(registry.forScope(scope).usage.totals().turns).toBe(0);

      const legitimate = codexUsage('worker-session', 'worker-event');
      const legitimateSource = codexSource('worker-session');
      onEvent?.(legitimate, workerRoot.rootRealPath, legitimateSource);
      onEvent?.(legitimate, workerRoot.rootRealPath, legitimateSource);
      onEvent?.(
        codexUsage('worker-session', 'wrong-dictated-root'),
        scope.rootRealPath,
        legitimateSource,
      );

      expect(registry.forScope(scope).usage.totals()).toMatchObject({
        turns: 1,
        inputTokens: 10,
        outputTokens: 2,
      });
      expect(mocks.recordAgentTurn).toHaveBeenCalledTimes(1);
      service.stop();
    });

    it('binds root/root only to a fresh physical root rollout, never an old root or child thread', () => {
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'usage-codex-root-identity-'),
      );
      tempRoots.push(parent);
      const scope = scopeFixture(parent, 'checkout-a');
      const runtimeManager = new ProjectRuntimeManager({
        baseDir: path.join(parent, 'runtime'),
        appVersion: 'usage-service-test',
      });
      managers.push(runtimeManager);
      const registry = new ProjectUsageStoreRegistry(runtimeManager);
      const service = new UsageTelemetryService(registry);
      service.start();
      const token = mintToken({
        label: 'root-worker',
        role: 'worker',
        scope,
        executionScope: scope,
      });
      bindTokenToSession(token.token, 'pty-root-worker');
      const pane = {
        paneId: 'pane-root-worker',
        sessionId: 'pty-root-worker',
        kind: 'cli-agent' as const,
        scope,
        executionScope: scope,
      };
      mocks.panes.set('pty-root-worker', pane);
      mocks.panes.set(pane.paneId, pane);
      dictateCodex('pty-root-worker', pane.paneId, scope.rootRealPath);
      const onEvent = mocks.codexScannerOptions?.onEvent;

      onEvent?.(
        codexUsage('external-root', 'external-old'),
        scope.rootRealPath,
        codexSource('external-root', {
          sessionStartedAt: Date.now() - 60 * 60_000,
        }),
      );
      onEvent?.(
        codexUsage('external-parent', 'external-child'),
        scope.rootRealPath,
        codexSource('external-parent', {
          threadId: 'external-child-thread',
          rolloutSessionId: 'external-child-thread',
          parentThreadId: 'external-parent',
        }),
      );
      expect(registry.forScope(scope).usage.totals().turns).toBe(0);

      const legitimate = codexUsage('fresh-root', 'fresh-event');
      onEvent?.(
        legitimate,
        scope.rootRealPath,
        codexSource('fresh-root'),
      );
      expect(registry.forScope(scope).usage.totals()).toMatchObject({
        turns: 1,
        inputTokens: 10,
      });
      service.stop();
    });

    it('accepts only the exact provider-bound Codex resume at its pane root', () => {
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'usage-codex-resume-identity-'),
      );
      tempRoots.push(parent);
      const scope = scopeFixture(parent, 'checkout-a');
      const workerRoot = executionScope(
        scope,
        path.join(parent, 'worktrees', 'resume-task'),
      );
      const runtimeManager = new ProjectRuntimeManager({
        baseDir: path.join(parent, 'runtime'),
        appVersion: 'usage-service-test',
      });
      managers.push(runtimeManager);
      const registry = new ProjectUsageStoreRegistry(runtimeManager);
      const service = new UsageTelemetryService(registry);
      service.start();
      const pane = {
        paneId: 'pane-resume',
        sessionId: 'pty-resume',
        kind: 'cli-agent' as const,
        scope,
        executionScope: workerRoot,
      };
      mocks.panes.set(pane.paneId, pane);
      mocks.panes.set(pane.sessionId, pane);
      mocks.providerPaneSession = {
        key: 'session_id',
        id: 'exact-resume-session',
      };

      expect(
        mocks.resumeLookup?.(scope, pane.paneId, 'codex'),
      ).toBe('exact-resume-session');
      expect(
        mocks.codexScannerOptions?.isWatched(workerRoot.rootRealPath),
      ).toBe(true);
      const onEvent = mocks.codexScannerOptions?.onEvent;
      onEvent?.(
        codexUsage('unknown-session', 'unknown-event'),
        workerRoot.rootRealPath,
        codexSource('unknown-session'),
      );
      expect(registry.forScope(scope).usage.totals().turns).toBe(0);

      onEvent?.(
        codexUsage('exact-resume-session', 'wrong-root-event'),
        scope.rootRealPath,
        codexSource('exact-resume-session', {
          sessionStartedAt: Date.now() - 24 * 60 * 60_000,
        }),
      );
      expect(registry.forScope(scope).usage.totals().turns).toBe(0);

      onEvent?.(
        codexUsage('exact-resume-session', 'wrong-rollout-event'),
        workerRoot.rootRealPath,
        codexSource('exact-resume-session', {
          threadId: 'physical-thread',
          rolloutSessionId: 'different-file-thread',
        }),
      );
      expect(registry.forScope(scope).usage.totals().turns).toBe(0);

      onEvent?.(
        codexUsage('exact-resume-session', 'resumed-event'),
        workerRoot.rootRealPath,
        codexSource('exact-resume-session', {
          sessionStartedAt: Date.now() - 24 * 60 * 60_000,
        }),
      );
      expect(registry.forScope(scope).usage.totals().turns).toBe(1);
      service.stop();
    });

    it('F-721: resume exato no primeiro spawn do pane usa a raiz da autoridade do spawn', () => {
      // Depois de reiniciar o app (ou no pane novo da retomada da aba) o
      // registro ainda não tem meta nem sessão do pane. O lookup devolvia
      // null e o Maestro nascia com `--session-id` novo, sem a conversa.
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'usage-resume-first-spawn-'),
      );
      tempRoots.push(parent);
      const scope = scopeFixture(parent, 'checkout-a');
      const tabRoot = executionScope(scope, path.join(parent, 'wt', 'tab-a'));
      const runtimeManager = new ProjectRuntimeManager({
        baseDir: path.join(parent, 'runtime'),
        appVersion: 'usage-service-test',
      });
      managers.push(runtimeManager);
      const service = new UsageTelemetryService(
        new ProjectUsageStoreRegistry(runtimeManager),
      );
      service.start();
      // Espelho do renderer: o pane existe, sem sessão e sem meta do Main.
      mocks.panes.set('pane-lider', {
        paneId: 'pane-lider',
        sessionId: null as unknown as string,
        kind: 'cli-agent',
      } as never);
      mocks.providerPaneSession = { key: 'session_id', id: 'conversa-real' };

      expect(
        mocks.resumeLookup?.(scope, 'pane-lider', 'claude', 'acct-a'),
      ).toBeNull();
      expect(
        mocks.resumeLookup?.(scope, 'pane-lider', 'claude', 'acct-a', {
          executionScope: tabRoot,
        }),
      ).toBe('conversa-real');
      expect([...(mocks.watcherOptions.at(-1)?.workspacePaths?.() ?? [])]).toContain(
        tabRoot.rootRealPath,
      );
      // A autoridade de outro checkout nunca empresta a raiz.
      expect(
        mocks.resumeLookup?.(scope, 'pane-lider', 'claude', 'acct-a', {
          executionScope: { ...tabRoot, checkoutId: 'checkout-b' },
        }),
      ).toBeNull();
      service.stop();
    });

    it('rejects a new event from outside the persisted Codex session root', () => {
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'usage-codex-persisted-root-'),
      );
      tempRoots.push(parent);
      const scope = scopeFixture(parent, 'checkout-a');
      const workerRoot = executionScope(
        scope,
        path.join(parent, 'worktrees', 'task-a'),
      );
      const runtimeManager = new ProjectRuntimeManager({
        baseDir: path.join(parent, 'runtime'),
        appVersion: 'usage-service-test',
      });
      managers.push(runtimeManager);
      const registry = new ProjectUsageStoreRegistry(runtimeManager);
      const mission = createScopedMissionStore(runtimeManager, scope).create({
        title: 'Persisted mission',
      });
      createScopedMissionPaneStore(runtimeManager, scope).record({
        missionId: mission.id,
        adapterId: 'codex',
        title: 'Worker',
        paneId: 'pane-worker',
        cwd: workerRoot.rootRealPath,
        executionScope: workerRoot,
      });
      const existing = codexUsage(
        'persisted-session',
        'existing-event',
        Date.now() - 60_000,
      );
      registry.forScope(scope).usage.record('codex', {
        ...existing,
        paneId: 'pane-worker',
        missionId: mission.id,
      });
      const service = new UsageTelemetryService(registry);
      service.start();
      const token = mintToken({
        label: 'worker',
        role: 'worker',
        scope,
        executionScope: workerRoot,
      });
      bindTokenToSession(token.token, 'pty-worker');
      const pane = {
        paneId: 'pane-worker',
        sessionId: 'pty-worker',
        kind: 'cli-agent' as const,
        scope,
        executionScope: workerRoot,
      };
      mocks.panes.set(pane.paneId, pane);
      mocks.panes.set(pane.sessionId, pane);
      dictateCodex(pane.sessionId, pane.paneId, workerRoot.rootRealPath);

      mocks.codexScannerOptions?.onEvent(
        codexUsage('persisted-session', 'wrong-root-event'),
        scope.rootRealPath,
        codexSource('persisted-session', {
          sessionStartedAt: Date.now() - 60 * 60_000,
        }),
      );
      expect(registry.forScope(scope).usage.totals().turns).toBe(1);
      expect(mocks.recordAgentTurn).not.toHaveBeenCalled();

      mocks.codexScannerOptions?.onEvent(
        codexUsage('persisted-session', 'authorized-root-event'),
        workerRoot.rootRealPath,
        codexSource('persisted-session', {
          sessionStartedAt: Date.now() - 60 * 60_000,
        }),
      );

      expect(registry.forScope(scope).usage.totals().turns).toBe(2);
      expect(mocks.recordAgentTurn).toHaveBeenCalledTimes(1);
      service.stop();
    });

    it('F-211: rollout Codex fresco ligado a um launch salva provider_pane_session com a conta', () => {
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'usage-codex-pane-session-'),
      );
      tempRoots.push(parent);
      const scope = scopeFixture(parent, 'checkout-a');
      const workerRoot = executionScope(
        scope,
        path.join(parent, 'worktrees', 'codex-task'),
      );
      const runtimeManager = new ProjectRuntimeManager({
        baseDir: path.join(parent, 'runtime'),
        appVersion: 'usage-service-test',
      });
      managers.push(runtimeManager);
      const registry = new ProjectUsageStoreRegistry(runtimeManager);
      const service = new UsageTelemetryService(registry);
      service.start();
      const token = mintToken({
        label: 'codex-worker',
        role: 'worker',
        scope,
        executionScope: workerRoot,
      });
      bindTokenToSession(token.token, 'pty-codex');
      const pane = {
        paneId: 'pane-codex',
        sessionId: 'pty-codex',
        kind: 'cli-agent' as const,
        scope,
        executionScope: workerRoot,
      };
      mocks.panes.set(pane.paneId, pane);
      mocks.panes.set(pane.sessionId, pane);
      // Launch ditado pelo spawn SEM providerSessionId — o Codex escolhe o
      // próprio id; o vínculo chega quando o scanner vê o rollout fresco.
      dictateCodex(
        pane.sessionId,
        pane.paneId,
        workerRoot.rootRealPath,
        null,
        'acct-codex',
      );

      const onEvent = mocks.codexScannerOptions?.onEvent;
      onEvent?.(
        codexUsage('codex-session-1', 'first-event'),
        workerRoot.rootRealPath,
        codexSource('codex-session-1'),
      );

      expect(mocks.saveProviderPaneSession).toHaveBeenCalledWith(
        scope,
        'pane-codex',
        'codex',
        { key: 'session_id', id: 'codex-session-1' },
        'acct-codex',
      );
      // A linha persistida fecha o resume exato do pane pinado na conta —
      // antes disto todo relive/respawn Codex nascia com conversa nova.
      expect(
        mocks.resumeLookup?.(scope, 'pane-codex', 'codex', 'acct-codex'),
      ).toBe('codex-session-1');
      expect(
        mocks.resumeLookup?.(scope, 'pane-codex', 'codex', 'acct-outra'),
      ).toBeNull();
      expect(registry.forScope(scope).usage.totals().turns).toBe(1);
      service.stop();
    });

    it('F-211: launches ambíguos não salvam provider_pane_session', () => {
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'usage-codex-ambiguous-'),
      );
      tempRoots.push(parent);
      const scope = scopeFixture(parent, 'checkout-a');
      const workerRoot = executionScope(
        scope,
        path.join(parent, 'worktrees', 'codex-ambiguous'),
      );
      const runtimeManager = new ProjectRuntimeManager({
        baseDir: path.join(parent, 'runtime'),
        appVersion: 'usage-service-test',
      });
      managers.push(runtimeManager);
      const registry = new ProjectUsageStoreRegistry(runtimeManager);
      const service = new UsageTelemetryService(registry);
      service.start();
      for (const index of [1, 2]) {
        const token = mintToken({
          label: `codex-worker-${index}`,
          role: 'worker',
          scope,
          executionScope: workerRoot,
        });
        bindTokenToSession(token.token, `pty-codex-${index}`);
        const pane = {
          paneId: `pane-codex-${index}`,
          sessionId: `pty-codex-${index}`,
          kind: 'cli-agent' as const,
          scope,
          executionScope: workerRoot,
        };
        mocks.panes.set(pane.paneId, pane);
        mocks.panes.set(pane.sessionId, pane);
        dictateCodex(
          pane.sessionId,
          pane.paneId,
          workerRoot.rootRealPath,
          null,
          'acct-codex',
        );
      }

      mocks.codexScannerOptions?.onEvent(
        codexUsage('codex-shared-session', 'ambiguous-event'),
        workerRoot.rootRealPath,
        codexSource('codex-shared-session'),
      );

      expect(mocks.saveProviderPaneSession).not.toHaveBeenCalled();
      expect(registry.forScope(scope).usage.totals().turns).toBe(0);
      service.stop();
    });

    it('F-211: o scanner observa a raiz provider-state do checkout em uso', () => {
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'usage-codex-roots-'),
      );
      tempRoots.push(parent);
      const scope = scopeFixture(parent, 'checkout-a');
      mocks.userDataDir = path.join(parent, 'userData');
      const runtimeManager = new ProjectRuntimeManager({
        baseDir: path.join(parent, 'runtime'),
        appVersion: 'usage-service-test',
      });
      managers.push(runtimeManager);
      const service = new UsageTelemetryService(
        new ProjectUsageStoreRegistry(runtimeManager),
      );
      service.start();
      const token = mintToken({
        label: 'codex-worker',
        role: 'worker',
        scope,
        executionScope: scope,
      });
      bindTokenToSession(token.token, 'pty-codex');
      dictateCodex('pty-codex', 'pane-codex', scope.rootRealPath);

      expect(mocks.codexScannerOptions?.sessionsDirs?.()).toEqual([
        path.join(
          mocks.userDataDir,
          'provider-state',
          'codex',
          'checkout-a',
          'sessions',
        ),
      ]);
      service.stop();
    });
  },
);
