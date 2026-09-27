import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type { ProjectExecutionScope } from '../../shared/types';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import type { distillHandoffSummary } from '../jev/jev-memory-distill';
import {
  configureWorkspaceMemory,
  disposeWorkspaceMemoryStores,
  getWorkspaceMemoryStore,
} from './workspace-memory';
import { distillSessionExitMemory } from './session-exit-memory';

const dirs: string[] = [];
let scope: ProjectExecutionScope;

const agent = (overrides: Partial<OwnedAgentSessionInfo> = {}) =>
  ({
    sessionId: 'pty-session-1',
    adapterId: 'claude',
    cwd: '/tmp/project',
    scope: undefined,
    source: 'operator',
    role: 'user',
    readOnly: false,
    allowedTools: null,
    allowedSkills: null,
    ...overrides,
  }) as OwnedAgentSessionInfo;

function handoff(
  id: string,
  summary: string,
  sessionId = 'pty-session-1',
  status = 'success',
) {
  return {
    id,
    sessionId,
    status,
    summary,
    evidenceTrust: 'nexus-trusted',
  } as never;
}

function stores(handoffs: unknown[]) {
  return {
    handoffs: { list: () => handoffs },
  } as never;
}

const approve: typeof distillHandoffSummary = async (input) =>
  input.summary || null;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-exit-root-'));
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-exit-db-'));
  dirs.push(root, baseDir);
  scope = {
    version: 1,
    installationId: 'installation-exit',
    projectId: 'project-exit',
    checkoutId: 'checkout-exit',
    rootRealPath: root,
    identitySource: 'manifest',
  };
  configureWorkspaceMemory({ baseDir });
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, true);
});

afterEach(() => {
  disposeWorkspaceMemoryStores();
  getFeatureFlagRegistry().clearOverride(FEATURE_FLAG_IDS.workspaceMemory);
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('session-exit memory distillation', () => {
  it('skips a trivial session with zero Jev calls', async () => {
    const distill = vi.fn<typeof distillHandoffSummary>();
    const outcome = await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope }) },
      { getStores: () => stores([]), distill },
    );
    expect(outcome).toMatchObject({ retained: false, reason: 'trivial' });
    expect(distill).not.toHaveBeenCalled();
  });

  it('skips when the daily project cap is reached, without Jev', async () => {
    const store = getWorkspaceMemoryStore(scope);
    for (let i = 0; i < 10; i++) {
      store.retain({
        content: `# Session digest\n\ncap filler ${i}`,
        kind: 'fact',
        scope: 'workspace',
        source: 'trusted:session-digest',
      });
    }
    const distill = vi.fn<typeof distillHandoffSummary>();
    const outcome = await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope }) },
      {
        getStores: () => stores([handoff('h-1', 'Shipped slice 2 end to end.')]),
        distill,
      },
    );
    expect(outcome).toMatchObject({ retained: false, reason: 'daily-cap' });
    expect(distill).not.toHaveBeenCalled();
  });

  it('retains one digest line from the session handoff summaries', async () => {
    const outcome = await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope }) },
      {
        getStores: () =>
          stores([
            handoff('h-1', 'Slice 2 shipped: session digests now retained.'),
            handoff('h-2', 'Fixed the pane focus loss regression.'),
            handoff('h-3', 'blocked handoff must be ignored', 'pty-session-1', 'blocked'),
          ]),
        distill: approve,
      },
    );
    expect(outcome).toMatchObject({ retained: true, reason: 'ok' });
    const [hit] = getWorkspaceMemoryStore(scope).recall({
      query: 'session digests retained pane focus',
      includeGlobal: false,
      trustedOnly: true,
    });
    expect(hit).toBeDefined();
    expect(hit.source).toBe('trusted:session-digest');
    expect(hit.content).toContain('session digests now retained');
    expect(hit.content).toContain('pane focus loss regression');
    expect(hit.content).not.toContain('blocked handoff');
  });

  it('dedupes against the top-3 FTS5 hits without calling Jev', async () => {
    getWorkspaceMemoryStore(scope).retain({
      content:
        '# Session digest\n\nSession digest:\nReference: pty-session-1\nSummary: Slice 2 shipped: session digests now retained.',
      kind: 'fact',
      scope: 'workspace',
      source: 'trusted:session-digest',
    });
    const distill = vi.fn<typeof distillHandoffSummary>();
    const outcome = await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope }) },
      {
        getStores: () =>
          stores([handoff('h-1', 'Slice 2 shipped: session digests now retained.')]),
        distill,
      },
    );
    expect(outcome).toMatchObject({ retained: false, reason: 'dedupe' });
    expect(distill).not.toHaveBeenCalled();
  });

  it('skips when Jev does not approve the digest', async () => {
    const outcome = await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope }) },
      {
        getStores: () => stores([handoff('h-1', 'Routine progress, nothing else.')]),
        distill: async () => null,
      },
    );
    expect(outcome).toMatchObject({ retained: false, reason: 'jev-skip' });
    expect(
      getWorkspaceMemoryStore(scope).stats().workspace.total,
    ).toBe(0);
  });

  it('supersedes the previous digest of the same mission', async () => {
    const store = getWorkspaceMemoryStore(scope);
    const first = store.retain({
      content:
        '# Session digest\n\nSession digest:\nMission: mission-9\nReference: pty-session-0\nSummary: Auth token refresh fixed.',
      kind: 'fact',
      scope: 'workspace',
      source: 'trusted:session-digest',
    });
    const outcome = await distillSessionExitMemory(
      {
        sessionId: 'pty-session-1',
        agent: agent({ scope, missionId: 'mission-9' }),
      },
      {
        getStores: () =>
          stores([handoff('h-1', 'Windows paths normalized in the git adapter.')]),
        distill: approve,
      },
    );
    expect(outcome).toMatchObject({ retained: true, supersededId: first.id });
    expect(
      store.recall({ query: 'auth token refresh', includeGlobal: false, trustedOnly: true }),
    ).toEqual([]);
    expect(
      store.recall({ query: 'windows paths git adapter', includeGlobal: false, trustedOnly: true }),
    ).toHaveLength(1);
  });

  it('holds the daily cap under concurrent exits', async () => {
    const store = getWorkspaceMemoryStore(scope);
    for (let i = 0; i < 9; i++) {
      store.retain({
        content: `# Session digest\n\ncap filler ${i}`,
        kind: 'fact',
        scope: 'workspace',
        source: 'trusted:session-digest',
      });
    }
    const outcomes = await Promise.all(
      ['alpha parser', 'beta router', 'gamma cache'].map((topic, index) =>
        distillSessionExitMemory(
          { sessionId: `pty-session-${index}`, agent: agent({ scope }) },
          {
            getStores: () =>
              stores([handoff(`h-${index}`, `Shipped the ${topic} rewrite.`, `pty-session-${index}`)]),
            distill: approve,
          },
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.retained)).toHaveLength(1);
    expect(store.stats().workspace.total).toBe(10);
  });

  it('counts superseded digests against the daily cap', async () => {
    const store = getWorkspaceMemoryStore(scope);
    let previous = store.retain({
      content: '# Session digest\n\nSession digest:\nMission: mission-7\nSummary: first',
      kind: 'fact',
      scope: 'workspace',
      source: 'trusted:session-digest',
    });
    for (let i = 1; i < 10; i++) {
      previous = store.retain({
        content: `# Session digest\n\nSession digest:\nMission: mission-7\nSummary: take ${i}`,
        kind: 'fact',
        scope: 'workspace',
        source: 'trusted:session-digest',
        supersedes: previous.id,
      });
    }
    const distill = vi.fn<typeof distillHandoffSummary>();
    const outcome = await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope, missionId: 'mission-7' }) },
      { getStores: () => stores([handoff('h-1', 'Eleventh write of the day.')]), distill },
    );
    expect(outcome).toMatchObject({ retained: false, reason: 'daily-cap' });
    expect(distill).not.toHaveBeenCalled();
  });
});
