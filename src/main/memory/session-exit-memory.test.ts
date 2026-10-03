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
import * as trustedMemory from './trusted-memory';

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
  vi.restoreAllMocks();
  disposeWorkspaceMemoryStores();
  getFeatureFlagRegistry().clearOverride(FEATURE_FLAG_IDS.workspaceMemory);
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('session-exit memory distillation', () => {
  it('F-768: registra o motivo de cada sessão que pula antes do Jev', async () => {
    const recordSkip = vi.spyOn(trustedMemory, 'recordMemoryRetentionSkip');
    expect(await distillSessionExitMemory({ sessionId: 'missing-scope', agent: null }))
      .toMatchObject({ retained: false, reason: 'no-scope' });
    expect(recordSkip).toHaveBeenCalledWith(undefined, 'no-scope');

    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, false);
    expect(await distillSessionExitMemory({ sessionId: 'pty-session-1', agent: agent({ scope }) }))
      .toMatchObject({ retained: false, reason: 'flag-off' });
    expect(recordSkip).toHaveBeenCalledWith(scope, 'flag-off');
    getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, true);

    expect(await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope }) },
      { getStores: () => { throw new Error('runtime unavailable'); } },
    )).toMatchObject({ retained: false, reason: 'store-unavailable' });
    expect(recordSkip).toHaveBeenCalledWith(scope, 'store-unavailable');

    expect(await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope }) },
      { getStores: () => stores([]) },
    )).toMatchObject({ retained: false, reason: 'trivial' });
    expect(recordSkip).toHaveBeenCalledWith(scope, 'trivial');
    expect(getWorkspaceMemoryStore(scope).stats().retention.skips).toMatchObject({
      'flag-off': 1,
      'store-unavailable': 1,
      trivial: 1,
    });
  });

  it('F-768: retém o resumo aprovado de um handoff não verificado, com procedência explícita', async () => {
    const outcome = await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope }) },
      {
        getStores: () => stores([{ id: 'unverified', sessionId: 'pty-session-1', status: 'success',
          summary: 'Helper afirma que a versão é v2.0.0.', evidenceTrust: 'unverified' }]),
        distill: async () => 'Helper reported a version change; verify the current release version.',
      },
    );
    expect(outcome).toMatchObject({ retained: true, reason: 'ok' });
    const [hit] = getWorkspaceMemoryStore(scope).recall({ query: 'version change', includeGlobal: false });
    expect(hit?.content).toContain('Helper reported a version change; verify the current release version.');
    expect(hit?.content).toContain('Agent report, unverified; Jev approved for retention, not factual verification.');
    expect(hit?.content).not.toContain('v2.0.0');
  });

  it('F-768: envia o digest completo ao Jev antes de limitar o resumo retido', async () => {
    const summary = `${'Parser accepts explicit timezones. '.repeat(20)}The final correction rejects invalid dates.`;
    const distill = vi.fn<typeof distillHandoffSummary>(async () => 'Parser rejects invalid dates.');
    await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope }) },
      { getStores: () => stores([handoff('h-long', summary)]), distill },
    );
    expect(distill.mock.calls[0]?.[0]).toEqual({ summary });
    const [hit] = getWorkspaceMemoryStore(scope).recall({ query: 'invalid dates', includeGlobal: false });
    expect(hit?.content).toContain('Parser rejects invalid dates.');
    expect(hit?.content).not.toContain('explicit timezones');
  });

  it('F-768: três resumos válidos podem ultrapassar o teto de um handoff', async () => {
    const summaries = [
      `${'date parser '.repeat(4_000)}Initial implementation.`,
      `${'date parser '.repeat(4_000)}Timezone support.`,
      `${'date parser '.repeat(4_000)}Final fix rejects invalid dates.`,
    ];
    const distill = vi.fn<typeof distillHandoffSummary>(async () => 'Parser rejects invalid dates.');
    const outcome = await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope }) },
      { getStores: () => stores(summaries.map((summary, index) => handoff(`h-${index}`, summary))), distill },
    );
    expect(outcome).toMatchObject({ retained: true, reason: 'ok' });
    expect(distill.mock.calls[0]?.[0]).toEqual({ summary: summaries.join(' | ') });
  });

  it('F-768: timeout mantém o digest pendente até a redestilação aprovada', async () => {
    const outcome = await distillSessionExitMemory(
      { sessionId: 'pty-session-1', agent: agent({ scope }) },
      {
        getStores: () => stores([handoff('h-retry', 'Unverified raw parser claim.')]),
        distill: async (_input, deps) => { deps?.onSkip?.('timeout'); return null; },
      },
    );
    expect(outcome).toMatchObject({ retained: false, reason: 'jev-skip' });
    const store = getWorkspaceMemoryStore(scope);
    expect(store.stats().retention.pending).toBe(1);
    expect(store.stats().workspace.total).toBe(0);

    await trustedMemory.retryPendingMemoryRetentions(scope, {}, async () => 'Parser behavior needs verification.');
    expect(store.stats().retention.pending).toBe(0);
    const [hit] = store.recall({ query: 'parser behavior', includeGlobal: false });
    expect(hit?.content).toContain('Parser behavior needs verification.');
    expect(hit?.content).not.toContain('Unverified raw parser claim');
    expect(hit?.content).toContain('not factual verification');
  });

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
