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

  it('sem teto diário: 10 digests no dia não impedem o próximo', async () => {
    const store = getWorkspaceMemoryStore(scope);
    for (let i = 0; i < 10; i++) {
      store.retain({
        content: `# Session digest\n\ncap filler ${i}`,
        kind: 'fact',
        scope: 'workspace',
        source: 'trusted:session-digest',
      });
    }
    const distill = vi.fn<typeof distillHandoffSummary>(approve);
    const outcome = await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope }) },
      {
        getStores: () => stores([handoff('h-1', 'Shipped slice 2 end to end.')]),
        distill,
      },
    );
    expect(outcome).toMatchObject({ retained: true, reason: 'ok' });
    expect(distill).toHaveBeenCalledTimes(1);
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

  it('saídas simultâneas: conteúdo distinto grava tudo; o mesmo digest vai ao Jev uma vez só', async () => {
    const store = getWorkspaceMemoryStore(scope);
    const exit = (sessionId: string, summary: string, distill: typeof distillHandoffSummary) =>
      distillSessionExitMemory(
        { sessionId, agent: agent({ scope }) },
        { getStores: () => stores([handoff(`h-${sessionId}`, summary, sessionId)]), distill },
      );
    const distinct = await Promise.all(['alpha parser', 'beta router', 'gamma cache'].map((topic, index) =>
      exit(`pty-session-${index}`, `Shipped the ${topic} rewrite.`, approve)));
    expect(distinct.every((outcome) => outcome.retained)).toBe(true);
    expect(store.stats().workspace.total).toBe(3);

    const distill = vi.fn<typeof distillHandoffSummary>(approve);
    const storm = await Promise.all([1, 2, 3, 4].map((index) =>
      exit(`pty-storm-${index}`, 'Rebuilt the delta indexer.', distill)));
    expect(distill).toHaveBeenCalledTimes(1);
    expect(storm.filter((outcome) => outcome.retained)).toHaveLength(1);
    expect(storm.filter((outcome) => outcome.reason === 'dedupe')).toHaveLength(3);
  });

  it('substituições do dia não bloqueiam o próximo digest da missão', async () => {
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
    const outcome = await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope, missionId: 'mission-7' }) },
      { getStores: () => stores([handoff('h-1', 'Eleventh write of the day.')]), distill: approve },
    );
    expect(outcome).toMatchObject({ retained: true, supersededId: previous.id });
  });

  it('não substitui o digest de outra missão com id de prefixo igual', async () => {
    const store = getWorkspaceMemoryStore(scope);
    const other = store.retain({
      content:
        '# Session digest\n\nSession digest:\nMission: mission-10\nSummary: Windows paths normalized.',
      kind: 'fact',
      scope: 'workspace',
      source: 'trusted:session-digest',
    });
    const outcome = await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope, missionId: 'mission-1' }) },
      { getStores: () => stores([handoff('h-1', 'Windows paths normalized again.')]), distill: approve },
    );
    expect(outcome).toMatchObject({ retained: true });
    expect(outcome.supersededId).toBeUndefined();
    expect(store.activeWorkspaceSource(other.id)).toBe('trusted:session-digest');
  });

  it('o digest fica com os resumos mais recentes da sessão', async () => {
    const outcome = await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope }) },
      {
        getStores: () =>
          stores([
            handoff('h-1', 'Rascunho inicial do parser.'),
            handoff('h-2', 'Parser cobre fuso horário.'),
            handoff('h-3', 'Parser cobre ano bissexto.'),
            handoff('h-4', 'Parser publicado no pacote shared.'),
          ]),
        distill: approve,
      },
    );
    expect(outcome).toMatchObject({ retained: true });
    const [hit] = getWorkspaceMemoryStore(scope).recall({
      query: 'parser pacote shared',
      includeGlobal: false,
      trustedOnly: true,
    });
    expect(hit.content).toContain('publicado no pacote shared');
    expect(hit.content).not.toContain('Rascunho inicial');
  });
});
