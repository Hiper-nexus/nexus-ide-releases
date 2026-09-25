import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

const harness = vi.hoisted(() => ({
  spawnPaneAndMaybePrompt: vi.fn(async (_options: Record<string, unknown>) => ({
    paneId: 'pane-child',
    sessionId: 'pty-child',
  })),
  takePendingPaneSpawnResult: vi.fn((): unknown => null),
  armAutoCloseOnHandoff: vi.fn(),
  settings: {
    squadCliPolicy: 'operator-choice' as 'operator-choice' | 'governed',
  },
  snapshots: [] as Array<Record<string, unknown>>,
  parentBySession: {} as Record<string, string>,
  panesByRef: {} as Record<string, { paneId: string; adapterId?: string }>,
}));

vi.mock('./tool-util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tool-util')>()),
  spawnPaneAndMaybePrompt: harness.spawnPaneAndMaybePrompt,
}));
vi.mock('./pane-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pane-registry')>()),
  takePendingPaneSpawnResult: harness.takePendingPaneSpawnResult,
  listPaneSnapshots: vi.fn(() => harness.snapshots),
  getPaneRuntimeAuthorityBySession: vi.fn((sessionId: string) =>
    harness.parentBySession[sessionId]
      ? { operatorParentSessionId: harness.parentBySession[sessionId] }
      : null,
  ),
  findPane: vi.fn((ref: string) => harness.panesByRef[ref] ?? null),
}));
vi.mock('./pane-close-scopes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pane-close-scopes')>()),
  armAutoCloseOnHandoff: harness.armAutoCloseOnHandoff,
}));
vi.mock('./squad-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./squad-store')>()),
  // Roster selado em outra CLI: prova que a rota vence o selo na mão do operador.
  findAgentInAnySquad: vi.fn((ref: string) =>
    ref === 'Executor'
      ? {
          squad: { id: 'squad-test', name: 'Teste', agents: [] },
          agent: {
            id: 'executor',
            agentName: 'Executor',
            category: 'executor',
            cli: 'agy',
            model: 'gemini-sealed',
          },
        }
      : null,
  ),
}));
vi.mock('../persistence/settings-store', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../persistence/settings-store')
  >()),
  getOrchSettings: vi.fn(() => ({
    squadCliPolicy: harness.settings.squadCliPolicy,
  })),
}));

import { paneSpawnTool, setOperatorRouteResolver } from './tools-panes';
import {
  forgetAccountChoiceReceipt,
  recordAccountChoiceReceipt,
} from '../persistence/account-choice-receipts';
import type { AccountChoiceReceipt } from '../../shared/account-choice';

function userPane(overrides: Partial<AgentGateContext> = {}): AgentGateContext {
  return {
    token: 'token',
    label: 'pane do operador',
    role: 'user',
    sessionId: 'session-user',
    scope: testProjectScope(),
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

function spawnedRole(): unknown {
  const call = harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0] as
    | { role?: unknown }
    | undefined;
  return call?.role;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.settings.squadCliPolicy = 'operator-choice';
  harness.snapshots = [];
  harness.parentBySession = {};
  harness.panesByRef = {};
});

afterEach(() => {
  setOperatorRouteResolver(null);
});

/**
 * Decisão 09/09, opção "panes que você abre herdam a liberdade": o filho do
 * pane do operador sem missão não nasce worker preso — o handler OMITE `role`
 * e o main minta `user` (`mcp-server`: `meta?.role ?? "user"`), então o filho
 * herda o modo vibe e a pane-authz do operador.
 */
describe('nexus_pane_spawn — pane filho da mão do operador', () => {
  it('omite role no spawn ad-hoc (main minta user)', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex' }, userPane());
    expect(harness.spawnPaneAndMaybePrompt).toHaveBeenCalledTimes(1);
    expect(spawnedRole()).toBeUndefined();
    expect(harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0]).toMatchObject({ operatorParentSessionId: 'session-user' });
  });

  it('com missão o caller não é a mão do operador e o role explícito continua', async () => {
    // Orquestrador com missão: a isenção não se aplica (role !== user com
    // missão). O spawn falha antes do PTY por falta de stores reais no teste,
    // mas nunca deve chegar ao mock — prova que a decisão não vazou.
    await expect(
      paneSpawnTool.handler(
        { adapterId: 'codex' },
        userPane({
          role: 'orchestrator',
          label: 'orch',
          sessionId: 'session-orch',
          missionId: 'mission-a',
        }),
      ),
    ).rejects.toBeTruthy();
    expect(harness.spawnPaneAndMaybePrompt).not.toHaveBeenCalled();
  });

  it('expõe o ACK pendente quando a sessão ainda não materializou', async () => {
    harness.spawnPaneAndMaybePrompt.mockRejectedValueOnce(
      new Error('pane spawn pending'),
    );
    harness.takePendingPaneSpawnResult.mockReturnValueOnce({
      requestId: 'orchspawn-pending',
      ok: true,
      paneId: 'pane-pending',
      sessionId: null,
      pending: true,
    });

    const result = await paneSpawnTool.handler(
      { adapterId: 'codex' },
      userPane(),
      { signal: new AbortController().signal },
    );

    expect(result).toMatchObject({
      ok: true,
      paneId: 'pane-pending',
      sessionId: null,
      pending: true,
      // ACK pendente: sem sessionId ainda, o recibo não existe.
      harness: { account: null },
    });
  });

  it('harness.account traz o recibo registrado para a sessão spawnada', async () => {
    const receipt: AccountChoiceReceipt = {
      adapterId: 'codex',
      source: 'headroom-rule',
      account: { label: 'g•••@l•••.com.br', mode: 'subscription' },
      headroom: { usedPct: 12, window: 'Sessão', resetsAt: 9, score: 0.9 },
      alternatives: [],
      decidedAt: 1,
    };
    harness.spawnPaneAndMaybePrompt.mockImplementationOnce(async () => {
      // O registro acontece no spawn real (pty-ipc / main-owned-runtime).
      recordAccountChoiceReceipt('pty-child', receipt);
      return { paneId: 'pane-child', sessionId: 'pty-child' };
    });
    try {
      const result = (await paneSpawnTool.handler(
        { adapterId: 'codex' },
        userPane(),
      )) as Record<string, unknown>;
      expect(result).toMatchObject({
        harness: { account: receipt },
      });
    } finally {
      forgetAccountChoiceReceipt('pty-child');
    }
  });

  it('harness.account é null quando a sessão não tem recibo registrado', async () => {
    const result = (await paneSpawnTool.handler(
      { adapterId: 'codex' },
      userPane(),
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ harness: { account: null } });
  });

  it('em Autopilot o filho ad-hoc herda o allowlist do operador (null)', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex' }, userPane());
    const options = harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0] as {
      allowedTools?: unknown;
      allowedSkills?: unknown;
    };
    expect(options.allowedTools).toBeNull();
    expect(options.allowedSkills).toBeNull();
  });

  it('em Hardened (governed) o filho continua worker atenuado ([])', async () => {
    harness.settings.squadCliPolicy = 'governed';
    await paneSpawnTool.handler({ adapterId: 'codex' }, userPane());
    const options = harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0] as {
      allowedTools?: unknown;
    };
    expect(options.allowedTools).toEqual([]);
  });

  it('sem adapterId roteia task/prompt pelo resolver do operador', async () => {
    const resolver = vi.fn(async () => ({
      adapterId: 'codex',
      model: 'gpt-5.1-codex',
      effort: 'medium',
      tier: 'medium',
      reason: 'r',
      classifierSource: 'jev',
      escalate: 0.2,
    }));
    setOperatorRouteResolver(resolver);

    const ctx = userPane();
    const result = (await paneSpawnTool.handler(
      { prompt: 'implemente X' },
      ctx,
    )) as Record<string, unknown>;

    expect(resolver).toHaveBeenCalledWith(
      'implemente X',
      ctx,
      expect.objectContaining({ tieBreakUseCounts: expect.any(Map) }),
    );
    const options = harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0] as {
      adapterId?: unknown;
      model?: unknown;
      effort?: unknown;
    };
    expect(options.adapterId).toBe('codex');
    expect(options.model).toBe('gpt-5.1-codex');
    expect(options.effort).toBe('medium');
    expect(result).toMatchObject({
      harness: { adapterId: 'codex', model: 'gpt-5.1-codex', effort: 'medium', source: 'auto-route' },
      route: { tier: 'medium', classifierSource: 'jev', reason: 'r', escalate: 0.2 },
    });
  });

  it('adapterId/model/effort do agente são ignorados: o resolver decide e o recibo diz', async () => {
    const resolver = vi.fn(async () => ({
      adapterId: 'kimi', model: 'kimi-code/k3', effort: 'low', classifierSource: 'jev',
    }));
    setOperatorRouteResolver(resolver);
    const result = (await paneSpawnTool.handler(
      { adapterId: 'claude', model: 'claude-opus-5-5', effort: 'high', prompt: 'revise X' },
      userPane(),
    )) as Record<string, unknown>;
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0]).toMatchObject({
      adapterId: 'kimi',
      model: 'kimi-code/k3',
      effort: 'low',
      spawnRoute: { source: 'jev' },
    });
    expect(result).toMatchObject({
      harness: { source: 'auto-route' },
      route: {
        ignored: { adapterId: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      },
    });
  });

  it('Jev fora: rota heurística com o motivo no recibo e nas opções do pane', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({
      adapterId: 'codex', classifierSource: 'heuristic', jevUnavailable: 'no-key',
    })));
    const result = (await paneSpawnTool.handler({ prompt: 'implemente X' }, userPane())) as Record<string, unknown>;
    expect(result).toMatchObject({ route: { jevUnavailable: 'no-key' } });
    expect(harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0]).toMatchObject({
      spawnRoute: { source: 'heuristic', jevUnavailable: 'no-key' },
    });
  });

  it('desempate recebe as CLIs do pai e dos filhos vivos dele', async () => {
    harness.snapshots = [
      { paneId: 'p1', sessionId: 'c1', adapterId: 'codex', state: 'busy', title: 'a', kind: 'cli-agent' },
    ];
    harness.parentBySession = { c1: 'session-user' };
    const resolver = vi.fn(async () => ({ adapterId: 'kimi' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler({ prompt: 'x' }, userPane({ providerId: 'claude' }));
    const internal = (resolver.mock.calls[0] as unknown[])[2] as {
      tieBreakUseCounts: Map<string, number>;
    };
    expect(Object.fromEntries(internal.tieBreakUseCounts)).toEqual({ claude: 1, codex: 1 });
  });

  it('resume mantém a CLI do pane retomado e não roteia', async () => {
    harness.panesByRef = { 'pane-old': { paneId: 'pane-old', adapterId: 'codex' } };
    const resolver = vi.fn(async () => ({ adapterId: 'kimi' }));
    setOperatorRouteResolver(resolver);
    await paneSpawnTool.handler({ resume: 'pane-old', adapterId: 'claude', prompt: 'ajuste' }, userPane());
    expect(resolver).not.toHaveBeenCalled();
    expect(harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0]).toMatchObject({
      adapterId: 'codex',
      resumeFromPaneId: 'pane-old',
    });
  });

  it('sem task, prompt nem title o spawn roteado pede a tarefa', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'kimi' })));
    await expect(paneSpawnTool.handler({ adapterId: 'claude' }, userPane())).rejects.toThrow(/task/);
    expect(harness.spawnPaneAndMaybePrompt).not.toHaveBeenCalled();
  });

  it('writer delegado ativo no checkout recusa outro writer; readOnly passa', async () => {
    harness.snapshots = [
      { paneId: 'pane-w', paneNumber: 4, sessionId: 's-w', adapterId: 'codex', state: 'busy', title: 'w', kind: 'cli-agent', scope: testProjectScope() },
    ];
    harness.parentBySession = { 's-w': 'session-user' };
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'kimi' })));
    await expect(paneSpawnTool.handler({ prompt: 'edite X' }, userPane())).rejects.toThrow(/writer pane 4 ainda ativo/);
    await paneSpawnTool.handler({ prompt: 'revise X', readOnly: true }, userPane());
    expect(harness.spawnPaneAndMaybePrompt).toHaveBeenCalledTimes(1);
  });

  it('helper do operador arma o auto-close por padrão', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex' }, userPane());
    expect(harness.armAutoCloseOnHandoff).toHaveBeenCalledWith('pty-child', 'pane-child');
  });

  it('autoCloseOnHandoff: false explícito é respeitado', async () => {
    await paneSpawnTool.handler({ adapterId: 'codex', autoCloseOnHandoff: false }, userPane());
    expect(harness.armAutoCloseOnHandoff).not.toHaveBeenCalled();
  });

  it('agentName: título e agente do roster, CLI e modelo da rota', async () => {
    setOperatorRouteResolver(vi.fn(async () => ({ adapterId: 'codex', model: 'gpt-5.6-luna' })));
    await paneSpawnTool.handler({ agentName: 'Executor', prompt: 'tela de login' }, userPane());
    expect(harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0]).toMatchObject({
      adapterId: 'codex',
      model: 'gpt-5.6-luna',
      title: 'Executor',
      agentName: 'Executor',
    });
  });

  it('worker de missão sem adapterId segue exigindo adapterId (sem resolver)', async () => {
    const resolver = vi.fn(async () => ({ adapterId: 'codex' }));
    setOperatorRouteResolver(resolver);
    await expect(
      paneSpawnTool.handler(
        { prompt: 'implemente X' },
        userPane({
          role: 'worker',
          label: 'worker',
          missionId: 'mission-a',
          allowedTools: [],
        }),
      ),
    ).rejects.toBeTruthy();
    expect(resolver).not.toHaveBeenCalled();
    expect(harness.spawnPaneAndMaybePrompt).not.toHaveBeenCalled();
  });

  it('auto-route com skill ≥ 0.7 acrescenta a dica ao prompt e expõe route.skill', async () => {
    setOperatorRouteResolver(
      vi.fn(async () => ({
        adapterId: 'codex',
        skill: { name: 'ponytail', confidence: 0.9 },
      })),
    );
    const result = (await paneSpawnTool.handler(
      { prompt: 'implemente X' },
      userPane(),
    )) as Record<string, unknown>;
    const options = harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0] as {
      prompt?: string;
    };
    expect(options.prompt).toBe(
      'implemente X\n\nSkill sugerida pelo Nexus: ponytail — leia a SKILL.md dela antes de começar.',
    );
    expect(result).toMatchObject({
      route: { skill: { name: 'ponytail', confidence: 0.9 } },
    });
  });

  it('skill com confiança < 0.7 não toca o prompt mas sai no recibo', async () => {
    setOperatorRouteResolver(
      vi.fn(async () => ({
        adapterId: 'codex',
        skill: { name: 'ponytail', confidence: 0.65 },
      })),
    );
    const result = (await paneSpawnTool.handler(
      { prompt: 'implemente X' },
      userPane(),
    )) as Record<string, unknown>;
    const options = harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0] as {
      prompt?: string;
    };
    expect(options.prompt).toBe('implemente X');
    expect(result).toMatchObject({
      route: { skill: { name: 'ponytail', confidence: 0.65 } },
    });
  });

  it('grant por pacote: filho com superpowers recebe a dica da sub-skill brainstorming', async () => {
    setOperatorRouteResolver(
      vi.fn(async () => ({
        adapterId: 'codex',
        skill: { name: 'brainstorming', pkg: 'superpowers', confidence: 0.9 },
      })),
    );
    const result = (await paneSpawnTool.handler(
      { prompt: 'implemente X' },
      userPane({ allowedSkills: ['superpowers'] }),
    )) as Record<string, unknown>;
    const options = harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0] as {
      prompt?: string;
    };
    expect(options.prompt).toBe(
      'implemente X\n\nSkill sugerida pelo Nexus: brainstorming — leia a SKILL.md dela antes de começar.',
    );
    expect(result).toMatchObject({
      route: { skill: { name: 'brainstorming', pkg: 'superpowers', confidence: 0.9 } },
    });
  });

  it('skill fora do allowedSkills do filho não ganha a dica no prompt', async () => {
    setOperatorRouteResolver(
      vi.fn(async () => ({
        adapterId: 'codex',
        skill: { name: 'ponytail', confidence: 0.95 },
      })),
    );
    await paneSpawnTool.handler(
      { prompt: 'implemente X' },
      userPane({ allowedSkills: ['impeccable'] }),
    );
    const options = harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0] as {
      prompt?: string;
    };
    expect(options.prompt).toBe('implemente X');
  });

  it('skill sugerida sem prompt não inventa prompt', async () => {
    setOperatorRouteResolver(
      vi.fn(async () => ({
        adapterId: 'codex',
        skill: { name: 'ponytail', confidence: 0.95 },
      })),
    );
    await paneSpawnTool.handler({ task: 'implemente X' }, userPane());
    const options = harness.spawnPaneAndMaybePrompt.mock.calls[0]?.[0] as {
      prompt?: unknown;
    };
    expect(options.prompt).toBeUndefined();
  });

  it('resolver que falha vira erro de roteamento automático', async () => {
    setOperatorRouteResolver(
      vi.fn(async () => {
        throw new Error('sem CLI elegível');
      }),
    );
    await expect(
      paneSpawnTool.handler({ prompt: 'implemente X' }, userPane()),
    ).rejects.toThrow(/roteamento automático falhou/);
    expect(harness.spawnPaneAndMaybePrompt).not.toHaveBeenCalled();
  });
});
