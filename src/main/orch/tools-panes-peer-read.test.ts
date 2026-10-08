import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import type { PaneAuthzInfo } from './pane-authz';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => {
  const panes = new Map<string, PaneAuthzInfo>();
  const outputs = new Map<string, string>();
  return {
    panes,
    outputs,
    getPaneAuthzInfo: vi.fn((ref: string) => panes.get(ref) ?? null),
    readSessionOutput: vi.fn((sessionId: string, _lines?: number) => {
      return outputs.get(sessionId) ?? '';
    }),
    listLivePaneNumbers: vi.fn(() => [] as number[]),
    listPaneSnapshots: vi.fn(() => []),
    listVisiblePaneSnapshots: vi.fn(() => []),
    requestPaneClose: vi.fn(async () => true),
    requestMissionPaneClose: vi.fn(async () => true),
    requestPaneSpawn: vi.fn(),
    waitForIdle: vi.fn(async () => 'idle' as const),
    waitForNextIdle: vi.fn(async () => 'idle' as const),
  };
});

vi.mock('./pane-registry', () => ({
  getPaneAuthzInfo: h.getPaneAuthzInfo,
  listLivePaneNumbers: h.listLivePaneNumbers,
  listPaneSnapshots: h.listPaneSnapshots,
  listVisiblePaneSnapshots: h.listVisiblePaneSnapshots,
  readSessionOutput: h.readSessionOutput,
  requestMissionPaneClose: h.requestMissionPaneClose,
  requestPaneClose: h.requestPaneClose,
  requestPaneSpawn: h.requestPaneSpawn,
  waitForIdle: h.waitForIdle,
  waitForNextIdle: h.waitForNextIdle,
}));

vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: vi.fn(() => true),
  orchTerminateSession: vi.fn(async () => true),
  getAgentSessionInfo: vi.fn(() => null),
  getSessionState: vi.fn(() => 'idle'),
  tapSessionData: vi.fn(() => () => {}),
  tapSessionExit: vi.fn(() => () => {}),
  tapSessionState: vi.fn(() => () => {}),
}));

const digestClassify = vi.hoisted(() => ({
  classifyPaneTailForDigest: vi.fn(async () => null as null | {
    state: string; confidence: number; needsHuman: number;
  }),
}));

vi.mock('../jev/jev-pane-state', async (original) => ({
  ...(await original<typeof import('../jev/jev-pane-state')>()),
  classifyPaneTailForDigest: digestClassify.classifyPaneTailForDigest,
}));

import { isToolAllowed } from './gate';
import { buildPaneTools } from './tools-panes';

const scope = testProjectScope({ projectId: 'project-a', checkoutId: 'checkout-a' });
const otherScope = testProjectScope({
  projectId: 'project-a',
  checkoutId: 'checkout-b',
});

function context(
  overrides: Partial<AgentGateContext> = {},
): AgentGateContext {
  return {
    token: 'peer-read-token',
    label: 'worker-a',
    role: 'worker',
    sessionId: 'session-a',
    missionId: 'mission-a',
    scope,
    allowedTools: [],
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

function registerPane(info: PaneAuthzInfo, output = ''): void {
  h.panes.set(info.paneId, info);
  if (info.sessionId) {
    h.panes.set(info.sessionId, info);
    h.outputs.set(info.sessionId, output);
  }
}

function tool(name: string) {
  const found = buildPaneTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe('in-mission pane observation (Overclock parity)', () => {
  beforeEach(() => {
    h.panes.clear();
    h.outputs.clear();
    vi.clearAllMocks();
    h.getPaneAuthzInfo.mockImplementation((ref: string) => h.panes.get(ref) ?? null);
    h.readSessionOutput.mockImplementation((sessionId: string) => {
      return h.outputs.get(sessionId) ?? '';
    });
  });

  it('keeps pane observation on the empty-allowlist worker gate', () => {
    expect(isToolAllowed([], 'nexus_pane_read')).toBe(true);
    expect(isToolAllowed([], 'nexus_pane_read_many')).toBe(true);
    expect(isToolAllowed([], 'nexus_pane_list')).toBe(true);
    expect(isToolAllowed([], 'nexus_pane_whoami')).toBe(true);
    expect(isToolAllowed([], 'nexus_pane_write')).toBe(false);
    expect(isToolAllowed([], 'nexus_pane_close')).toBe(false);
  });

  it('teaches the spoken "olha o pane X" path in the tool description', () => {
    expect(tool('nexus_pane_read').description).toMatch(/olha o que o pane/i);
    expect(tool('nexus_pane_read').description).toMatch(/orchestrator|orquestrador|senior/i);
    expect(tool('nexus_pane_read').description).toMatch(/pane 7/);
  });

  it('lets worker A read worker B in the same mission', async () => {
    registerPane({
      paneId: 'pane-b',
      sessionId: 'session-b',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope,
    }, 'worker B is compiling tests');

    await expect(
      tool('nexus_pane_read').handler({ paneId: 'pane-b' }, context()),
    ).resolves.toContain('worker B is compiling tests');
    expect(h.readSessionOutput).toHaveBeenCalledWith('session-b', 200);
  });

  it('lets a worker read the orchestrator/senior pane', async () => {
    registerPane({
      paneId: 'pane-orch',
      sessionId: 'session-orch',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'orchestrator',
      scope,
    }, 'Maestro waiting on handoff');

    await expect(
      tool('nexus_pane_read').handler({ paneId: 'pane-orch' }, context()),
    ).resolves.toContain('Maestro waiting on handoff');
  });

  it('lets the orchestrator read a worker pane (digest by default)', async () => {
    registerPane({
      paneId: 'pane-b',
      sessionId: 'session-b',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope,
    }, 'implementing login');

    const result = await tool('nexus_pane_read').handler(
      { paneId: 'pane-b' },
      context({
        role: 'orchestrator',
        sessionId: 'session-orch',
        label: 'maestro',
        allowedTools: null,
      }),
    ) as Record<string, unknown>;
    expect(result.mode).toBe('digest');
    expect(result.text).toBe('implementing login');
    expect(result.hint).toContain("mode:'full'");
    expect(result.state).toBeUndefined();
  });

  it('mode:\'full\' keeps the raw tail for an orchestrator — same string as before', async () => {
    const raw = Array.from({ length: 60 }, (_, i) => `saída ${i}`).join('\n');
    registerPane({
      paneId: 'pane-b',
      sessionId: 'session-b',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope,
    }, raw);

    await expect(
      tool('nexus_pane_read').handler(
        { paneId: 'pane-b', mode: 'full' },
        context({ role: 'orchestrator', sessionId: 'session-orch', allowedTools: null }),
      ),
    ).resolves.toBe(raw);
    expect(digestClassify.classifyPaneTailForDigest).not.toHaveBeenCalled();
  });

  it('digest surfaces the Jev state when the classifier answers', async () => {
    digestClassify.classifyPaneTailForDigest.mockResolvedValueOnce({
      state: 'waiting_for_human', confidence: 0.9, needsHuman: 0.8,
    });
    registerPane({
      paneId: 'pane-b',
      sessionId: 'session-b',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope,
    }, 'Apply changes? [y/n]');

    const result = await tool('nexus_pane_read').handler(
      { paneId: 'pane-b' },
      context({ role: 'orchestrator', sessionId: 'session-orch', allowedTools: null }),
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      mode: 'digest',
      state: 'waiting_for_human',
      stateConfidence: 0.9,
      needsHuman: 0.8,
    });
  });

  it('digest compacts the tail: signal lines + last 30 verbatim + counts', async () => {
    const raw = [
      'error: build quebrou no passo 3',
      ...Array.from({ length: 60 }, (_, i) => `progresso ${i}`),
      ...Array.from({ length: 30 }, (_, i) => `tail ${i}`),
    ].join('\n');
    registerPane({
      paneId: 'pane-b',
      sessionId: 'session-b',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope,
    }, raw);

    const result = await tool('nexus_pane_read').handler(
      { paneId: 'pane-b' },
      context({ role: 'orchestrator', sessionId: 'session-orch', allowedTools: null }),
    ) as Record<string, unknown>;
    const text = String(result.text);
    expect(text).toContain('error: build quebrou no passo 3');
    expect(text).toContain('tail 29');
    expect(text).not.toContain('progresso 30');
    expect(result.keptLines).toBe(31);
    expect(result.omittedLines).toBe(60);
  });

  it('read_many follows the same role default and digest shape', async () => {
    registerPane({
      paneId: 'pane-b',
      sessionId: 'session-b',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope,
    }, 'worker B idle');
    registerPane({
      paneId: 'pane-c',
      sessionId: 'session-c',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope,
    }, 'worker C idle');

    const digestResult = await tool('nexus_pane_read_many').handler(
      { paneIds: ['pane-b', 'pane-c'] },
      context({ role: 'orchestrator', sessionId: 'session-orch', allowedTools: null }),
    ) as Array<Record<string, unknown>>;
    expect(digestResult).toEqual([
      expect.objectContaining({ paneId: 'pane-b', mode: 'digest', text: 'worker B idle' }),
      expect.objectContaining({ paneId: 'pane-c', mode: 'digest', text: 'worker C idle' }),
    ]);

    const fullResult = await tool('nexus_pane_read_many').handler(
      { paneIds: ['pane-b'], mode: 'full' },
      context({ role: 'orchestrator', sessionId: 'session-orch', allowedTools: null }),
    );
    expect(fullResult).toEqual([{ paneId: 'pane-b', output: 'worker B idle' }]);
  });

  it('F-961: read_many digest de 6 panes com redesenho de TUI cabe no teto e mantém o fim útil', async () => {
    const status = (seconds: number) => `Working (2m ${seconds}s • esc to interrupt)`;
    const typed = (text: string) =>
      Array.from({ length: text.length }, (_, i) => text.slice(0, i + 1)).join('');
    const glued = Array.from({ length: 60 }, (_, i) => `✻ ${status(10 + (i % 50))}`).join('');
    const garbage = (pane: number) => [
      ...Array.from({ length: 35 }, (_, i) =>
        i % 2 === 0 ? '✻✶✳✢·'.repeat(40) : typed(status(54)) + glued),
      `⏺ Read(src/pane-${pane}.ts)`,
      `Achado ${pane}: leitura concluída`,
      `> estudo ${pane} em andamento`,
    ].join('\n');
    const paneIds: string[] = [];
    let raw = 0;
    for (let pane = 0; pane < 6; pane += 1) {
      const output = garbage(pane);
      raw += output.length;
      registerPane({
        paneId: `pane-${pane}`,
        sessionId: `session-${pane}`,
        kind: 'cli-agent',
        missionId: 'mission-a',
        role: 'worker',
        scope,
      }, output);
      paneIds.push(`pane-${pane}`);
    }
    expect(raw).toBeGreaterThan(86_402);

    const result = await tool('nexus_pane_read_many').handler(
      { paneIds, lines: 40, mode: 'digest' },
      context({ role: 'orchestrator', sessionId: 'session-orch', allowedTools: null }),
    ) as Array<Record<string, unknown>>;
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(26_000);
    expect(result).toHaveLength(6);
    for (const [pane, item] of result.entries()) {
      expect(item).toMatchObject({ paneId: `pane-${pane}`, mode: 'digest' });
      const text = String(item.text);
      expect(text.endsWith(`> estudo ${pane} em andamento`)).toBe(true);
      expect(text).toContain(`Achado ${pane}: leitura concluída`);
      expect(text).not.toContain('WWoWor');
    }
  });

  it('F-961: read_many lê cada pane uma vez, recusa lista acima do teto e nunca passa do teto total', async () => {
    const orchestrator = context({ role: 'orchestrator', sessionId: 'session-orch', allowedTools: null });
    const useful = (pane: number) => Array.from(
      { length: 40 },
      (_, i) => `pane ${pane} resultado ${i}: ` +
        Array.from({ length: 12 }, (_, j) => `arquivo-${pane}-${i}-${j}.ts`).join(' '),
    ).join('\n');
    for (let pane = 0; pane < 31; pane += 1) {
      registerPane({
        paneId: `pane-${pane}`,
        sessionId: `session-${pane}`,
        kind: 'cli-agent',
        missionId: 'mission-a',
        role: 'worker',
        scope,
      }, useful(pane));
    }

    // 100 referências ao mesmo pane: uma leitura só (o revisor viu 75.100 caracteres).
    const repeated = await tool('nexus_pane_read_many').handler(
      { paneIds: Array.from({ length: 100 }, () => 'pane-0') },
      orchestrator,
    ) as Array<Record<string, unknown>>;
    expect(repeated).toHaveLength(1);
    expect(h.readSessionOutput).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(repeated).length).toBeLessThanOrEqual(24_000);

    // Apelido do mesmo pane (sessionId) não é lido de novo.
    const aliased = await tool('nexus_pane_read_many').handler(
      { paneIds: ['pane-1', 'session-1'] },
      orchestrator,
    ) as Array<Record<string, unknown>>;
    expect(aliased[1]).toEqual({ paneId: 'session-1', sameAs: 'pane-1' });

    // Acima do teto de panes distintos: erro legível, nada lido.
    h.readSessionOutput.mockClear();
    await expect(tool('nexus_pane_read_many').handler(
      { paneIds: Array.from({ length: 31 }, (_, pane) => `pane-${pane}`) },
      orchestrator,
    )).rejects.toThrow(/no máximo 30 panes distintos por chamada \(recebeu 31\)/);
    expect(h.readSessionOutput).not.toHaveBeenCalled();

    // 30 panes com muito conteúdo útil: a resposta inteira cabe no teto.
    const full = await tool('nexus_pane_read_many').handler(
      { paneIds: Array.from({ length: 30 }, (_, pane) => `pane-${pane}`), lines: 40 },
      orchestrator,
    ) as Array<Record<string, unknown>>;
    expect(full).toHaveLength(30);
    expect(JSON.stringify(full).length).toBeLessThanOrEqual(24_000);
    for (const [pane, item] of full.entries()) {
      expect(String(item.text)).toContain(`pane ${pane} resultado 39:`);
      expect(item.truncated).toBe(true);
    }
  });

  it('F-961 (segunda revisão): o teto conta panes distintos resolvidos, não grafias', async () => {
    const orchestrator = context({ role: 'orchestrator', sessionId: 'session-orch', allowedTools: null });
    for (let pane = 0; pane < 8; pane += 1) {
      const info: PaneAuthzInfo = {
        paneId: `pane-${pane}`,
        sessionId: `session-${pane}`,
        kind: 'cli-agent',
        missionId: 'mission-a',
        role: 'worker',
        scope,
      };
      registerPane(info, `saída do pane ${pane}`);
      // Número curto do cabeçalho: "3" e "pane 3".
      h.panes.set(String(pane + 1), info);
      h.panes.set(`pane ${pane + 1}`, info);
    }
    // 8 panes em 4 grafias = 32 referências: antes virava erro de teto (30).
    const refs = Array.from({ length: 8 }, (_, pane) => [
      `pane-${pane}`, `session-${pane}`, String(pane + 1), `pane ${pane + 1}`,
    ]).flat();
    h.readSessionOutput.mockClear();
    const out = await tool('nexus_pane_read_many').handler(
      { paneIds: refs, mode: 'full' },
      orchestrator,
    ) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(32);
    expect(h.readSessionOutput).toHaveBeenCalledTimes(8);
    expect(out.filter((item) => 'output' in item)).toHaveLength(8);
    expect(out.filter((item) => 'sameAs' in item)).toHaveLength(24);
    expect(out[3]).toEqual({ paneId: 'pane 1', sameAs: 'pane-0' });

    // Referências demais (mesmo de poucos panes) continuam barradas antes de resolver.
    h.getPaneAuthzInfo.mockClear();
    await expect(tool('nexus_pane_read_many').handler(
      { paneIds: Array.from({ length: 121 }, (_, i) => `ref-${i}`) },
      orchestrator,
    )).rejects.toThrow(/no máximo 120 referências por chamada \(recebeu 121\)/);
    expect(h.getPaneAuthzInfo).not.toHaveBeenCalled();
  });

  it('fails closed for an unknown pane', async () => {
    await expect(
      tool('nexus_pane_read').handler({ paneId: 'pane-missing' }, context()),
    ).rejects.toThrow(/unknown pane: pane-missing/);
    expect(h.readSessionOutput).not.toHaveBeenCalled();
  });

  it('F-241: unknown paneId lista os panes vivos da missão do chamador', async () => {
    h.listPaneSnapshots.mockReturnValue([
      {
        paneId: 'pane-a',
        sessionId: 'session-a',
        title: 'a',
        kind: 'cli-agent',
        adapterId: 'codex',
        state: 'idle',
        missionId: 'mission-a',
        paneNumber: 3,
      },
      {
        paneId: 'pane-b',
        sessionId: 'session-b',
        title: 'b',
        kind: 'cli-agent',
        adapterId: 'glm',
        state: 'busy',
        missionId: 'mission-a',
        paneNumber: 5,
      },
      // Outra missão e estado morto não entram no inventário.
      {
        paneId: 'pane-foreign',
        sessionId: 'session-f',
        title: 'f',
        kind: 'cli-agent',
        adapterId: 'codex',
        state: 'idle',
        missionId: 'mission-b',
      },
      {
        paneId: 'pane-dead',
        sessionId: null,
        title: 'd',
        kind: 'cli-agent',
        adapterId: 'codex',
        state: 'exited',
        missionId: 'mission-a',
      },
    ] as never);

    await expect(
      tool('nexus_pane_read').handler({ paneId: 'pane-missing' }, context()),
    ).rejects.toThrow(
      'unknown pane: pane-missing (panes vivos desta missão: ' +
        'pane-a #3 codex idle, pane-b #5 glm busy; ' +
        'use nexus_pane_list para o inventário)',
    );
  });

  it('F-241: unknown paneId fora de missão aponta o nexus_pane_list', async () => {
    await expect(
      tool('nexus_pane_read').handler(
        { paneId: 'pane-missing' },
        context({ missionId: undefined }),
      ),
    ).rejects.toThrow(
      'unknown pane: pane-missing ' +
        '(nenhum pane vivo com esse id; use nexus_pane_list)',
    );
  });

  it('tells the agent why a browser pane is gone instead of a bare refusal', async () => {
    // Campo 26/09: sem a pista, o agente concluiu que o Nexus o bloqueou e
    // pediu ao operador para colar um token no chat.
    await expect(
      tool('nexus_pane_read').handler({ paneId: 'browser-gone' }, context()),
    ).rejects.toThrow(
      /unknown pane: browser-gone \(the browser pane was closed; .*nexus_browser_open/,
    );
  });

  it('refuses a pane from another mission', async () => {
    registerPane({
      paneId: 'pane-foreign',
      sessionId: 'session-foreign',
      kind: 'cli-agent',
      missionId: 'mission-b',
      role: 'worker',
      scope,
    }, 'secret from another mission');

    await expect(
      tool('nexus_pane_read').handler({ paneId: 'pane-foreign' }, context()),
    ).rejects.toThrow(/another mission/);
    expect(h.readSessionOutput).not.toHaveBeenCalled();
  });

  it('refuses a pane from another checkout even with a matching mission id', async () => {
    registerPane({
      paneId: 'pane-other-checkout',
      sessionId: 'session-other-checkout',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope: otherScope,
    }, 'other checkout buffer');

    await expect(
      tool('nexus_pane_read').handler(
        { paneId: 'pane-other-checkout' },
        context(),
      ),
    ).rejects.toThrow(/another project checkout/);
  });

  it('still blocks a worker from reading the user shell', async () => {
    registerPane({
      paneId: 'pane-shell',
      sessionId: 'session-shell',
      kind: 'shell',
      missionId: undefined,
      role: undefined,
      scope,
    }, 'user typed a secret');

    await expect(
      tool('nexus_pane_read').handler({ paneId: 'pane-shell' }, context()),
    ).rejects.toThrow(/shell/);
    expect(h.readSessionOutput).not.toHaveBeenCalled();
  });

  it('still blocks a worker from writing the orchestrator pane', async () => {
    registerPane({
      paneId: 'pane-orch',
      sessionId: 'session-orch',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'orchestrator',
      scope,
    }, 'maestro');

    await expect(
      tool('nexus_pane_write').handler(
        { paneId: 'pane-orch', text: 'injected', submit: false },
        context(),
      ),
    ).rejects.toThrow(/cannot write/);
  });

  it('returns per-item errors from pane_read_many without leaking foreign output', async () => {
    registerPane({
      paneId: 'pane-b',
      sessionId: 'session-b',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope,
    }, 'peer ok');
    registerPane({
      paneId: 'pane-foreign',
      sessionId: 'session-foreign',
      kind: 'cli-agent',
      missionId: 'mission-b',
      role: 'worker',
      scope,
    }, 'should not leak');

    const result = await tool('nexus_pane_read_many').handler(
      { paneIds: ['pane-b', 'pane-foreign', 'pane-missing'] },
      context(),
    );

    expect(result).toEqual([
      { paneId: 'pane-b', output: 'peer ok' },
      {
        paneId: 'pane-foreign',
        error: expect.stringMatching(/another mission/),
      },
      {
        paneId: 'pane-missing',
        error: expect.stringMatching(/unknown pane/),
      },
    ]);
  });
});
