import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';

const mocks = vi.hoisted(() => ({
  dictationHook: null as null | ((info: unknown) => void),
  resumeLookup: null as null | ((...args: unknown[]) => unknown),
  userDataDir: '' as string,
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
  forgetProviderSessionById: vi.fn(() => 0),
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
  setResumeSessionForget: () => {},
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
  forgetProviderSessionById: vi.fn(() => 0),
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
    start(): void {}

    stop(): void {}
  },
}));

// NOTA: './codex-scanner' NÃO é mockado aqui — o R4/F-211 exige o scanner real
// lendo um rollout no formato do Codex 0.158 sob a raiz provider-state.

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
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- sonda: o better-sqlite3 pode estar compilado para o ABI do Electron; o require no try decide se a suíte roda
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

function dayDirectory(root: string): string {
  const now = new Date();
  return path.join(
    root,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
}

afterEach(() => {
  resetGateForTests();
  vi.restoreAllMocks();
  mocks.dictationHook = null;
  mocks.resumeLookup = null;
  mocks.userDataDir = '';
  mocks.panes.clear();
  mocks.providerPaneSession = null;
  mocks.savedPaneSessions.clear();
  mocks.recordAgentTurn.mockReset();
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!sqliteAvailable)(
  'UsageTelemetryService Codex scanner real (e2e)',
  () => {
    it('R4/F-211: rollout Codex 0.158 sob provider-state vincula o launch e persiste o pane com a conta', async () => {
      const parent = fs.mkdtempSync(
        path.join(os.tmpdir(), 'usage-codex-e2e-'),
      );
      tempRoots.push(parent);
      const scope = scopeFixture(parent, 'checkout-a');
      const workerRoot = executionScope(
        scope,
        path.join(parent, 'worktrees', 'codex-task'),
      );
      // A raiz nativa (~/.codex/sessions) é isolada num HOME falso — o scanner
      // real só pode enxergar a raiz provider-state do checkout.
      const fakeHome = path.join(parent, 'home');
      fs.mkdirSync(fakeHome, { recursive: true });
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
      mocks.userDataDir = path.join(parent, 'userData');

      const threadId = randomUUID();
      const sessionStart = new Date();
      const iso = (ms: number) => new Date(ms).toISOString();
      // O Codex grava o arquivo de forma lazy no primeiro turn — o timestamp da
      // linha fica ~60s à frente do timestamp de início no payload.
      const sessionMeta = {
        timestamp: iso(sessionStart.getTime() + 62_000),
        ordinal: 0,
        type: 'session_meta',
        payload: {
          session_id: threadId,
          id: threadId,
          timestamp: iso(sessionStart.getTime()),
          cwd: workerRoot.rootRealPath,
          originator: 'codex-tui',
          cli_version: '0.158.0',
          source: 'cli',
          thread_source: 'user',
          model_provider: 'openai',
        },
      };
      const turnContext = {
        timestamp: iso(sessionStart.getTime() + 63_000),
        type: 'turn_context',
        payload: {
          cwd: workerRoot.rootRealPath,
          model: 'gpt-5.6-codex',
          approval_policy: 'never',
        },
      };
      const taskStarted = {
        timestamp: iso(sessionStart.getTime() + 64_000),
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      };
      const tokenCount = {
        timestamp: iso(sessionStart.getTime() + 65_000),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 4_200,
              cached_input_tokens: 1_024,
              cache_write_input_tokens: 0,
              output_tokens: 256,
              reasoning_output_tokens: 64,
              total_tokens: 4_520,
            },
            last_token_usage: {
              input_tokens: 4_200,
              cached_input_tokens: 1_024,
              cache_write_input_tokens: 0,
              output_tokens: 256,
              reasoning_output_tokens: 64,
              total_tokens: 4_520,
            },
          },
        },
      };
      const sessionsRoot = path.join(
        mocks.userDataDir,
        'provider-state',
        'codex',
        'checkout-a',
        'sessions',
      );
      const dayDir = dayDirectory(sessionsRoot);
      fs.mkdirSync(dayDir, { recursive: true });
      fs.writeFileSync(
        path.join(
          dayDir,
          `rollout-2026-09-28T19-54-52-${threadId}.jsonl`,
        ),
        [sessionMeta, turnContext, taskStarted, tokenCount]
          .map((line) => JSON.stringify(line))
          .join('\n') + '\n',
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
      // Launch pendente com a conta pinada — o rollout já está no disco e a
      // primeira varredura do scanner real (no start) fecha o vínculo.
      dictateCodex(
        pane.sessionId,
        pane.paneId,
        workerRoot.rootRealPath,
        null,
        'acct-codex',
      );

      await vi.waitFor(
        () => {
          expect(mocks.saveProviderPaneSession).toHaveBeenCalledWith(
            scope,
            'pane-codex',
            'codex',
            { key: 'session_id', id: threadId },
            'acct-codex',
          );
        },
        { timeout: 5_000, interval: 25 },
      );

      expect(
        mocks.resumeLookup?.(scope, 'pane-codex', 'codex', 'acct-codex'),
      ).toBe(threadId);
      expect(
        mocks.resumeLookup?.(scope, 'pane-codex', 'codex', 'acct-outra'),
      ).toBeNull();
      // input_tokens do Codex já inclui os cached — o parser subtrai.
      expect(registry.forScope(scope).usage.totals()).toMatchObject({
        turns: 1,
        inputTokens: 3_176,
        outputTokens: 256,
      });
      expect(mocks.recordAgentTurn).toHaveBeenCalledTimes(1);
      service.stop();
    });
  },
);
