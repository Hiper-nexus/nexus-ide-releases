import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { ProjectExecutionScope } from '../../shared/types';
import { ACCOUNT_CHANNELS, type Account } from '../../shared/account-types';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  getAccount,
  getActiveAccount,
  pickAvailableForFailover,
} from '../persistence/account-store';

const ptyMocks = vi.hoisted(() => ({
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
  agentSessions: new Map<string, unknown>(),
  sessionStates: new Map<string, string>(),
  shuttingDown: false,
}));

const toolMocks = vi.hoisted(() => ({
  injectPrompt: vi.fn(async (_sessionId: string, _prompt: string) => undefined),
}));

vi.mock('./tool-util', () => ({ injectPrompt: toolMocks.injectPrompt }));

const paneMocks = vi.hoisted(() => ({
  authorities: new Map<string, unknown>(),
  panes: new Map<string, unknown>(),
  runtimeAuthorities: new Map<string, unknown>(),
}));

const accountMocks = vi.hoisted(() => ({
  setCooldown: vi.fn(),
  verifyClaude: vi.fn(async (_id: string, onVerified?: (blob: string) => void) => {
    onVerified?.('verified-claude-blob');
    return 'match' as 'match' | 'mismatch' | 'auth-expired' | 'unavailable';
  }),
  current: {
    id: 'account-a',
    adapterId: 'claude',
    label: 'Account A',
    mode: 'subscription' as const,
    upstream: 'anthropic',
    createdAt: 0,
  },
  next: {
    id: 'account-b',
    adapterId: 'claude',
    label: 'Account B',
    mode: 'subscription' as const,
    upstream: 'anthropic',
    createdAt: 1,
  } as Account | null,
}));

vi.mock('../pty/pty-analysis-runtime', async () => {
  const { failoverAnalysisFixture } = await import('../pty/__tests__/failover-analysis-fixture');
  return failoverAnalysisFixture(ptyMocks.dataTaps);
});

vi.mock('../pty/pty-manager', () => ({
  tapSessionData: vi.fn((tap: (sessionId: string, data: string) => void) => {
    ptyMocks.dataTaps.push(tap);
    return () => {
      const index = ptyMocks.dataTaps.indexOf(tap);
      if (index >= 0) ptyMocks.dataTaps.splice(index, 1);
    };
  }),
  tapSessionExit: vi.fn((tap: (sessionId: string) => void) => {
    ptyMocks.exitTaps.push(tap);
    return () => {
      const index = ptyMocks.exitTaps.indexOf(tap);
      if (index >= 0) ptyMocks.exitTaps.splice(index, 1);
    };
  }),
  getAgentSessionInfo: vi.fn(
    (sessionId: string) => ptyMocks.agentSessions.get(sessionId) ?? null,
  ),
  getSessionState: vi.fn(
    (sessionId: string) => ptyMocks.sessionStates.get(sessionId) ?? null,
  ),
  // F-1483: saída de sessão no meio do shutdown do app não apaga a espera persistida.
  isPtySessionAdmissionSealedForShutdown: vi.fn(() => ptyMocks.shuttingDown),
}));

// F-995: a troca do ORQUESTRADOR num pane do renderer é do Main. Padrão:
// "não é orquestrador selado" (handled:false) — os testes antigos seguem o
// caminho de sempre; os do F-995 trocam o retorno.
const orchestratorSwitch = vi.hoisted(() => ({
  switch: vi.fn(async (_input: {
    missionId: string; paneId: string; sessionId: string; toAccountId: string;
    buildRecap: () => string;
  }) => ({ handled: false }) as
    | { handled: false }
    | { handled: true; ok: true; sessionId: string }
    | { handled: true; ok: false; error: string }),
}));
vi.mock('./failover-orchestrator-respawn', () => ({
  switchRendererOrchestratorAccount: orchestratorSwitch.switch,
}));

// F-1486: o store responde e a missão dos panes de teste não está nele (não é
// dona do pane) — o caminho de sempre. Sem leitura nenhuma o failover recusa.
// F-1483: os testes da espera podem pôr a missão em `running`, ler os avisos
// ao Maestro e anunciar escopos no boot (onScope).
const storeMocks = vi.hoisted(() => ({
  missionStatus: undefined as string | undefined,
  submit: vi.fn((_input: Record<string, unknown>): unknown => {
    throw new Error('handoffs fora do teste');
  }),
  scopes: [] as unknown[],
  scopeListeners: new Set<(scope: unknown, suite: unknown) => void>(),
}));
vi.mock('./project-domain-store-registry', async (importOriginal) => {
  const suite = () => ({
    missions: {
      get: (id: string) => storeMocks.missionStatus
        ? { id, status: storeMocks.missionStatus, description: '' }
        : undefined,
    },
    handoffs: { submit: storeMocks.submit },
  });
  return {
    ...(await importOriginal<typeof import('./project-domain-store-registry')>()),
    getProjectDomainStores: suite,
    requireProjectDomainStoreRegistry: () => ({
      onScope: (listener: (scope: unknown, value: unknown) => void) => {
        storeMocks.scopeListeners.add(listener);
        for (const scope of storeMocks.scopes) listener(scope, suite());
        return () => storeMocks.scopeListeners.delete(listener);
      },
    }),
  };
});

vi.mock('./pane-registry', () => ({
  stripAnsi: (data: string) => data,
  readSessionOutput: vi.fn(() => 'Maestro: integrando o harvest T3\nYou\'ve hit your session limit'),
  getOwnedPaneAuthzInfoBySession: vi.fn(
    (ref: string) => paneMocks.authorities.get(ref) ?? null,
  ),
  getPaneRuntimeAuthorityBySession: vi.fn(
    (ref: string) => paneMocks.runtimeAuthorities.get(ref) ?? null,
  ),
  findPaneBySessionOwnedBy: vi.fn(
    (_owner: WebContents, ref: string) => paneMocks.panes.get(ref) ?? null,
  ),
  requestPaneClose: vi.fn(async () => true),
  listPaneSnapshots: vi.fn(() => []),
}));

const traceMocks = vi.hoisted(() => ({ trace: vi.fn() }));

vi.mock('../observability/main-trace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../observability/main-trace')>()),
  trace: traceMocks.trace,
}));

vi.mock('./limit-detector', () => ({
  detectLimit: vi.fn((buffer: string) =>
    buffer.includes('LIMIT')
      ? { reason: 'rate limit', cooldownMs: 60_000 }
      : null,
  ),
  // Panes de teste não têm model — escopo indefinido = comportamento global.
  tierScopeFromModelId: vi.fn(() => undefined),
}));

vi.mock('../persistence/account-store', () => ({
  getAccount: vi.fn((id: string) => {
    if (id === accountMocks.current.id) return accountMocks.current;
    if (accountMocks.next && id === accountMocks.next.id) return accountMocks.next;
    return null;
  }),
  getActiveAccount: vi.fn(() => accountMocks.current),
  pickAvailable: vi.fn(() => accountMocks.next),
  pickAvailableForFailover: vi.fn(() => ({
    account: accountMocks.next,
    probe: false,
  })),
  adoptNativeAccountForFailover: vi.fn(() => null),
  ensureFreshClaudeSubscription: vi.fn(async () => false),
  isAccountBlockedForScope: vi.fn(() => false),
  setCooldown: accountMocks.setCooldown,
  prepareAccountForSpawn: vi.fn((adapterId: string, id: string) => {
    const acct =
      id === accountMocks.current.id
        ? accountMocks.current
        : accountMocks.next && id === accountMocks.next.id
          ? accountMocks.next
          : null;
    if (!acct || acct.adapterId !== adapterId) {
      return { ok: false as const, error: 'missing' };
    }
    return {
      ok: true as const,
      account: acct,
      apiKey: null,
      authEnv: {},
    };
  }),
  verifyManagedClaudeAccountForSpawn: accountMocks.verifyClaude,
}));

vi.mock('../quota/quota-service', () => ({
  noteQuotaLimitHit: vi.fn(),
  requireQuotaService: vi.fn(() => {
    throw new Error('quota optional in test');
  }),
}));

import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import {
  listConfirmedPaneLimits,
  resetPaneStartWatchdogForTests,
} from './pane-start-watchdog';
import {
  initFailover,
  registerFailoverListener,
  requestSessionRecovery,
  resetInstantAuthDeaths,
  shutdownFailover,
  TRANSIENT_CONTINUE_PROMPT,
  unregisterFailoverListener,
} from './failover';
import { recordPaneSessionData } from './pane-session-output';
import { initFailoverWaits, listFailoverWaits } from '../persistence/failover-waits';
import {
  registerPaneTaskReroute,
  resetPaneTaskReroutesForTests,
  type PaneTaskRerouteHandle,
} from './pane-task-reroute';

type Renderer = WebContents & EventEmitter & { send: ReturnType<typeof vi.fn> };

function renderer(id: number): Renderer {
  const events = new EventEmitter() as Renderer;
  Object.assign(events, {
    id,
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  });
  return events;
}

function addPane(options: {
  owner: Renderer;
  paneId: string;
  sessionId: string;
  missionId?: string;
  scope: ProjectExecutionScope;
  accountId?: string;
  adapterId?: string;
}): void {
  const pane = {
    paneId: options.paneId,
    sessionId: options.sessionId,
    kind: 'cli-agent',
    adapterId: options.adapterId ?? 'claude',
    accountId: options.accountId ?? 'account-a',
  };
  paneMocks.panes.set(options.sessionId, pane);
  paneMocks.authorities.set(options.sessionId, {
    owner: options.owner,
    ...pane,
    role: options.missionId ? 'worker' : undefined,
    missionId: options.missionId,
    scope: options.scope,
  });
}

const renderers: Renderer[] = [];

/**
 * F-511: performSwitch é async (heal-before-pin da secundária Claude com
 * corrida de 15s contra o refresh de rede). Os efeitos do switch assentam em
 * microtasks — este flush drena a cadeia sem avançar os fake timers.
 */
async function settleFailover(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  // Como o pick real: nunca devolve a conta excluída nem as já tentadas.
  vi.mocked(pickAvailableForFailover).mockReset().mockImplementation(
    (_adapterId, excludeId, _now, _scores, options) => ({
      account:
        accountMocks.next &&
        accountMocks.next.id !== excludeId &&
        !options?.excludeIds?.has(accountMocks.next.id)
          ? accountMocks.next
          : null,
      probe: false,
    }),
  );
  ptyMocks.dataTaps.length = 0;
  ptyMocks.exitTaps.length = 0;
  ptyMocks.agentSessions.clear();
  ptyMocks.sessionStates.clear();
  ptyMocks.shuttingDown = false;
  storeMocks.missionStatus = undefined;
  storeMocks.submit.mockClear();
  storeMocks.scopes.length = 0;
  paneMocks.authorities.clear();
  paneMocks.panes.clear();
  paneMocks.runtimeAuthorities.clear();
  accountMocks.setCooldown.mockClear();
  toolMocks.injectPrompt.mockClear();
  orchestratorSwitch.switch.mockReset();
  orchestratorSwitch.switch.mockImplementation(async () => ({ handled: false }));
  accountMocks.verifyClaude.mockReset();
  accountMocks.verifyClaude.mockImplementation(async (_id, onVerified) => {
    onVerified?.('verified-claude-blob');
    return 'match';
  });
  accountMocks.next = {
    id: 'account-b',
    adapterId: 'claude',
    label: 'Account B',
    mode: 'subscription',
    upstream: 'anthropic',
    createdAt: 1,
  };
  initFailover();
});

afterEach(() => {
  for (const value of renderers.splice(0)) {
    unregisterFailoverListener(value);
    clearRendererWorkspaceScope(value);
  }
  shutdownFailover();
  vi.useRealTimers();
});

describe('account failover authority and lifecycle', () => {
  it('requests a same-account resume without mutating account cooldown', () => {
    const scope = testProjectScope();
    const owner = renderer(77);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({ owner, paneId: 'pane-recover', sessionId: 'session-recover', missionId: 'mission-r', scope });

    expect(requestSessionRecovery('session-recover', 'stall recovery')).toBe(true);
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'pane-recover',
        switched: true,
        fromAccountLabel: 'Account A',
        toAccountLabel: 'Account A',
        reason: 'stall recovery',
      }),
    );
    expect(accountMocks.setCooldown).not.toHaveBeenCalled();
  });
  it('emits only to the exact pane owner across projects with colliding pane ids', async () => {
    const scopeA = testProjectScope();
    const scopeB = testProjectScope({
      installationId: 'installation-b',
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    const windowA = renderer(101);
    const windowB = renderer(202);
    renderers.push(windowA, windowB);
    bindResolvedRendererWorkspaceScope(windowA, scopeA);
    bindResolvedRendererWorkspaceScope(windowB, scopeB);
    registerFailoverListener(windowA);
    registerFailoverListener(windowB);
    addPane({
      owner: windowA,
      paneId: 'shared-pane',
      sessionId: 'session-a',
      missionId: 'mission-a',
      scope: scopeA,
    });
    addPane({
      owner: windowB,
      paneId: 'shared-pane',
      sessionId: 'session-b',
      missionId: 'mission-b',
      scope: scopeB,
    });

    ptyMocks.dataTaps[0]('session-a', 'LIMIT');
    await settleFailover();

    expect(windowA.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'shared-pane',
        switched: true,
        toAccountId: 'account-b',
        crossAccount: true,
      }),
    );
    expect(windowB.send).not.toHaveBeenCalled();
    expect(accountMocks.setCooldown).toHaveBeenCalledOnce();
  });

  it('suppresses a PTY limit when a fresh provider-api reading refutes it', async () => {
    const { detectLimit } = await import('./limit-detector');
    vi.mocked(detectLimit).mockImplementationOnce((buffer: string) =>
      buffer.includes('LIMIT')
        ? { kind: 'rate-limit', reason: 'rate limit', cooldownMs: 60_000 }
        : null,
    );
    const { requireQuotaService } = await import('../quota/quota-service');
    vi.mocked(requireQuotaService).mockReturnValueOnce({
      lastSnapshot: () => ({
        updatedAt: 100_000,
        worstUsedRatio: 0.07,
        highUsageCount: 0,
        unknownCount: 0,
        entries: [
          {
            id: 'claude:account-a',
            adapterId: 'claude',
            accountId: 'account-a',
            label: 'Account A',
            installed: true,
            onCooldown: false,
            updatedAt: 100_000,
            windows: [
              {
                kind: 'hours' as const,
                label: '5 Horas',
                usedRatio: 0.07,
                source: 'provider-api' as const,
                confidence: 'high' as const,
              },
            ],
          },
        ],
      }),
    } as unknown as ReturnType<typeof requireQuotaService>);

    const scope = testProjectScope();
    const owner = renderer(717);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: 'pane-717',
      sessionId: 'session-717',
      missionId: 'mission-717',
      scope,
    });

    ptyMocks.dataTaps[0]('session-717', 'LIMIT');

    // Healthy provider-api → no cooldown, no switch event.
    expect(accountMocks.setCooldown).not.toHaveBeenCalled();
    expect(owner.send).not.toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.anything(),
    );
  });

  // Sem leitura provider-api fresca, o texto do PTY não decide sozinho: o
  // failover sonda a cota ao vivo (Astra P1: `cat erro.log` com a frase certa
  // não pode trocar uma conta sadia) antes de quarentenar/trocar.
  const sessionLimitHit = {
    kind: 'rate-limit' as const,
    reason: "You've hit your session limit",
    cooldownMs: 77 * 60 * 1000,
  };
  const probedEntry = (usedRatio: number) => ({
    id: 'claude:account-a',
    adapterId: 'claude',
    accountId: 'account-a',
    label: 'Account A',
    installed: true,
    onCooldown: false,
    updatedAt: 100_000,
    windows: [
      {
        kind: 'hours' as const,
        label: '5 Horas',
        usedRatio,
        source: 'provider-api' as const,
        confidence: 'high' as const,
      },
    ],
  });
  async function limitWithProbe(paneNo: number, probe: (() => Promise<unknown>) | null, usedRatio: number) {
    const { detectLimit } = await import('./limit-detector');
    vi.mocked(detectLimit).mockImplementationOnce((buffer: string) =>
      buffer.includes('LIMIT') ? sessionLimitHit : null,
    );
    const { requireQuotaService } = await import('../quota/quota-service');
    const snapshot = {
      updatedAt: 100_000,
      worstUsedRatio: usedRatio,
      highUsageCount: usedRatio >= 0.8 ? 1 : 0,
      unknownCount: 0,
      entries: [probedEntry(usedRatio)],
    };
    // Antes da sonda: nenhuma leitura; depois: a leitura sondada.
    let probed = false;
    vi.mocked(requireQuotaService).mockImplementation(() => {
      if (!probe) throw new Error('quota indisponível');
      return {
        refreshForLimitHit: async () => {
          await probe();
          probed = true;
          return snapshot;
        },
        lastSnapshot: () => (probed ? snapshot : undefined),
      } as unknown as ReturnType<typeof requireQuotaService>;
    });
    const scope = testProjectScope();
    const owner = renderer(paneNo);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: `pane-${paneNo}`,
      sessionId: `session-${paneNo}`,
      missionId: `mission-${paneNo}`,
      scope,
    });
    ptyMocks.dataTaps[0](`session-${paneNo}`, 'LIMIT');
    await settleFailover();
    return owner;
  }
  afterEach(async () => {
    const { requireQuotaService } = await import('../quota/quota-service');
    vi.mocked(requireQuotaService).mockImplementation(() => {
      throw new Error('quota optional in test');
    });
  });

  it('sem leitura fresca, a sonda ao vivo CONFIRMA o limite: cooldown inteiro e troca de conta', async () => {
    const owner = await limitWithProbe(718, async () => undefined, 1);
    expect(accountMocks.setCooldown).toHaveBeenCalledWith(
      'account-a',
      100_000 + 77 * 60 * 1000,
      "You've hit your session limit",
      undefined,
    );
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ paneId: 'pane-718', switched: true, toAccountId: 'account-b' }),
    );
  });

  it('sem leitura fresca, a sonda ao vivo REFUTA (conta com folga): texto emoldurado de ferramenta não troca conta', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const owner = await limitWithProbe(720, async () => undefined, 0.3);
      expect(accountMocks.setCooldown).not.toHaveBeenCalled();
      expect(owner.send).not.toHaveBeenCalledWith(ACCOUNT_CHANNELS.failover, expect.anything());
      expect(log).toHaveBeenCalledWith(
        '[failover]',
        expect.stringContaining('provider-api-healthy-after-probe'),
      );
    } finally {
      log.mockRestore();
    }
  });

  it('sonda sem resposta: cooldown capado de 15 min na conta, pane NÃO troca, retry agendado', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const owner = await limitWithProbe(721, null, 0);
      // Conta protegida do pool por 15 min com motivo honesto…
      expect(accountMocks.setCooldown).toHaveBeenCalledWith(
        'account-a',
        100_000 + 15 * 60 * 1000,
        "You've hit your session limit (limite não confirmado pela API do provider)",
        undefined,
      );
      // …mas o pane NÃO troca nem respawna num limite não confirmado (F-249):
      // texto de PTY/narração sozinho não destrói uma sessão sadia.
      expect(owner.send).toHaveBeenCalledWith(
        ACCOUNT_CHANNELS.failover,
        expect.objectContaining({
          paneId: 'pane-721',
          switched: false,
          scheduledRetryAtMs: expect.any(Number),
        }),
      );
      expect(owner.send).not.toHaveBeenCalledWith(
        ACCOUNT_CHANNELS.failover,
        expect.objectContaining({ paneId: 'pane-721', switched: true }),
      );
      expect(log).toHaveBeenCalledWith(
        '[failover]',
        expect.stringContaining('long-cooldown-capped-without-provider-api'),
      );
    } finally {
      log.mockRestore();
    }
  });

  /** F-1483: a sonda não traz a conta do pane, mas traz a irmã medida agora. */
  async function limitWithFreshSibling(paneNo: number, siblingUsedRatio: number, probe: () => void = () => undefined) {
    const { detectLimit } = await import('./limit-detector');
    vi.mocked(detectLimit).mockImplementationOnce((buffer: string) =>
      buffer.includes('LIMIT') ? sessionLimitHit : null,
    );
    const { requireQuotaService } = await import('../quota/quota-service');
    let probed = false;
    vi.mocked(requireQuotaService).mockImplementation(() => ({
      refreshForLimitHit: async () => {
        probe();
        probed = true;
      },
      lastSnapshot: () => (probed
        ? {
            updatedAt: Date.now(),
            worstUsedRatio: siblingUsedRatio,
            highUsageCount: 0,
            unknownCount: 0,
            entries: [{
              ...probedEntry(siblingUsedRatio),
              id: 'claude:account-b', accountId: 'account-b', label: 'Account B', updatedAt: Date.now(),
            }],
          }
        : undefined),
    }) as unknown as ReturnType<typeof requireQuotaService>);
    const scope = testProjectScope();
    const owner = renderer(paneNo);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({ owner, paneId: `pane-${paneNo}`, sessionId: `session-${paneNo}`, missionId: `mission-${paneNo}`, scope });
    ptyMocks.sessionStates.set(`session-${paneNo}`, 'idle');
    ptyMocks.dataTaps[0](`session-${paneNo}`, 'LIMIT');
    await settleFailover();
    return owner;
  }

  it('F-1483: sonda sem resposta + irmã com folga medida e fresca + turno encerrado → troca já para a irmã; A só 15 min', async () => {
    const owner = await limitWithFreshSibling(722, 0.3);
    expect(accountMocks.setCooldown).toHaveBeenCalledWith(
      'account-a',
      100_000 + 15 * 60 * 1000,
      "You've hit your session limit (limite não confirmado pela API do provider)",
      undefined,
    );
    expect(accountMocks.setCooldown).not.toHaveBeenCalledWith('account-a', 100_000 + 77 * 60 * 1000, expect.anything(), undefined);
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ paneId: 'pane-722', switched: true, toAccountId: 'account-b' }),
    );
    expect(owner.send).not.toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ paneId: 'pane-722', scheduledRetryAtMs: expect.any(Number) }),
    );
  });

  it('F-1483: irmã medida acima de 80% não encadeia — pausa curta de sempre', async () => {
    const owner = await limitWithFreshSibling(724, 0.85);
    expect(owner.send).not.toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ paneId: 'pane-724', switched: true }),
    );
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ paneId: 'pane-724', switched: false, scheduledRetryAtMs: expect.any(Number) }),
    );
  });

  it('F-1483: saída nova depois do limite (turno ainda andando) não troca — F-249 preservado', async () => {
    const owner = await limitWithFreshSibling(723, 0.3, () => {
      vi.setSystemTime(Date.now() + 11_000);
      recordPaneSessionData('session-723', 'a CLI seguiu respondendo depois da frase citada');
    });
    expect(owner.send).not.toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ paneId: 'pane-723', switched: true }),
    );
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ paneId: 'pane-723', switched: false, scheduledRetryAtMs: expect.any(Number) }),
    );
  });

  // Incidente agy (2026-10-13): "401 authentication_error" lido no PTY virou
  // limite confirmado — cooldown, troca de conta e missão movida a outra CLI —
  // com a conta operacional. Auth NÃO passava pela sonda F-249 (só cooldowns
  // longos de uso passavam), então texto nenhum era refutado/confirmado.
  it('auth no PTY com a conta operacional na sonda: NÃO põe cooldown nem troca (F-249)', async () => {
    const { detectLimit } = await import('./limit-detector');
    vi.mocked(detectLimit).mockImplementationOnce((buffer: string) =>
      buffer.includes('LIMIT')
        ? {
            kind: 'auth' as const,
            reason: '401 authentication_error',
            cooldownMs: 15 * 60 * 1000,
          }
        : null,
    );
    const { requireQuotaService } = await import('../quota/quota-service');
    const snapshot = {
      updatedAt: 100_000,
      worstUsedRatio: 0.3,
      highUsageCount: 0,
      unknownCount: 0,
      entries: [probedEntry(0.3)],
    };
    let probed = false;
    vi.mocked(requireQuotaService).mockImplementation(
      () =>
        ({
          refreshForLimitHit: async () => {
            probed = true;
            return snapshot;
          },
          lastSnapshot: () => (probed ? snapshot : undefined),
        }) as unknown as ReturnType<typeof requireQuotaService>,
    );
    const scope = testProjectScope();
    const owner = renderer(723);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: 'pane-723',
      sessionId: 'session-723',
      missionId: 'mission-723',
      scope,
    });

    ptyMocks.dataTaps[0]('session-723', 'LIMIT');
    await settleFailover();

    // A sonda rodou e a leitura provider-api fresca prova a credencial aceita:
    // o sinal de auth é refutado — sem cooldown, sem troca, missão intacta.
    expect(probed).toBe(true);
    expect(accountMocks.setCooldown).not.toHaveBeenCalled();
    expect(owner.send).not.toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.anything(),
    );
  });

  // Bug 9 (2026-10-13): toast «Sessão expirada em "muse" — Authentication_error»
  // com a credencial Muse viva. O pane muse usa login NATIVO (sem conta
  // gerenciada): a sonda F-249 nunca lia a linha nativa de cota
  // (`fresh = current ? … : undefined`), e o ramo sem-conta commitava o texto
  // do PTY como expiração definitiva — «desconhecido» (ex.: Keychain negado,
  // F-1447 → `quota-key-required` a sessão inteira) virava «expirado» no toast.
  async function nativeMuseAuthHit(paneNo: number, nativeEntry: Record<string, unknown>) {
    resetInstantAuthDeaths('muse');
    vi.mocked(getActiveAccount).mockImplementation(() => null as never);
    accountMocks.next = null;
    const { detectLimit } = await import('./limit-detector');
    vi.mocked(detectLimit).mockImplementationOnce((buffer: string) =>
      buffer.includes('LIMIT')
        ? {
            kind: 'auth' as const,
            reason: 'Authentication_error',
            cooldownMs: 15 * 60 * 1000,
          }
        : null,
    );
    const { requireQuotaService } = await import('../quota/quota-service');
    const snapshot = {
      updatedAt: 100_000,
      worstUsedRatio: null,
      highUsageCount: 0,
      unknownCount: 1,
      entries: [{
        id: 'muse',
        adapterId: 'muse',
        label: 'Muse',
        installed: true,
        onCooldown: false,
        updatedAt: 100_000,
        windows: [],
        ...nativeEntry,
      }],
    };
    let probed = false;
    vi.mocked(requireQuotaService).mockImplementation(
      () =>
        ({
          refreshForLimitHit: async () => {
            probed = true;
            return snapshot;
          },
          lastSnapshot: () => (probed ? snapshot : undefined),
        }) as unknown as ReturnType<typeof requireQuotaService>,
    );
    const scope = testProjectScope();
    const owner = renderer(paneNo);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: `pane-${paneNo}`,
      sessionId: `session-${paneNo}`,
      scope,
      adapterId: 'muse',
      accountId: '',
    });
    ptyMocks.dataTaps[0](`session-${paneNo}`, 'LIMIT');
    await settleFailover();
    return owner;
  }
  afterEach(() => {
    vi.mocked(getActiveAccount).mockImplementation(() => accountMocks.current as never);
  });

  it('muse nativo: sonda com janela medida REFUTA o auth do PTY — sem toast de sessão expirada', async () => {
    const owner = await nativeMuseAuthHit(724, {
      windows: [{
        kind: 'hours',
        label: '5 Horas',
        usedRatio: 0.3,
        source: 'provider-api',
        confidence: 'high',
      }],
    });
    expect(accountMocks.setCooldown).not.toHaveBeenCalled();
    expect(owner.send).not.toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.anything(),
    );
  });

  it('muse nativo: sonda desconhecida (Keychain negado) NÃO vira «sessão expirada» na 1ª batida', async () => {
    const owner = await nativeMuseAuthHit(725, { readHint: 'quota-key-required' });
    // Sem confirmação, nada de toast definitivo: a re-sondagem decide no retry.
    expect(owner.send).not.toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ kind: 'auth', switched: false }),
    );
  });

  it('muse nativo: sonda auth-expired CONFIRMA — o aviso de expiração sai (UX legítima)', async () => {
    const owner = await nativeMuseAuthHit(726, { readHint: 'auth-expired' });
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'pane-726',
        kind: 'auth',
        switched: false,
        fromAccountLabel: 'muse',
      }),
    );
  });

  it('allows a long cooldown when a fresh matching provider-api window exists', async () => {
    const { detectLimit } = await import('./limit-detector');
    vi.mocked(detectLimit).mockImplementationOnce((buffer: string) =>
      buffer.includes('LIMIT')
        ? {
            kind: 'rate-limit',
            reason: '5-hour usage limit reached',
            cooldownMs: 5 * 60 * 60 * 1000,
          }
        : null,
    );
    const { requireQuotaService } = await import('../quota/quota-service');
    vi.mocked(requireQuotaService).mockReturnValueOnce({
      lastSnapshot: () => ({
        updatedAt: 100_000,
        worstUsedRatio: 0.92,
        highUsageCount: 1,
        unknownCount: 0,
        entries: [
          {
            id: 'claude:account-a',
            adapterId: 'claude',
            accountId: 'account-a',
            label: 'Account A',
            installed: true,
            onCooldown: false,
            updatedAt: 100_000,
            windows: [
              {
                kind: 'hours' as const,
                label: '5 Horas',
                usedRatio: 0.92,
                source: 'provider-api' as const,
                confidence: 'high' as const,
              },
            ],
          },
        ],
      }),
    } as unknown as ReturnType<typeof requireQuotaService>);

    const scope = testProjectScope();
    const owner = renderer(719);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: 'pane-719',
      sessionId: 'session-719',
      missionId: 'mission-719',
      scope,
    });

    ptyMocks.dataTaps[0]('session-719', 'LIMIT');
    await settleFailover();

    expect(accountMocks.setCooldown).toHaveBeenCalledWith(
      'account-a',
      100_000 + 5 * 60 * 60 * 1000,
      '5-hour usage limit reached',
      undefined,
    );
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'pane-719',
        switched: true,
        toAccountId: 'account-b',
      }),
    );
  });

  it('coalesces multi-pane bursts on the same exhausted account to one target', async () => {
    const scope = testProjectScope();
    const owner = renderer(606);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: 'pane-1',
      sessionId: 'sess-1',
      missionId: 'm1',
      scope,
    });
    addPane({
      owner,
      paneId: 'pane-2',
      sessionId: 'sess-2',
      missionId: 'm2',
      scope,
    });

    ptyMocks.dataTaps[0]!('sess-1', 'LIMIT');
    ptyMocks.dataTaps[0]!('sess-2', 'LIMIT');
    await settleFailover();

    const sends = owner.send.mock.calls.filter(
      (c) => c[0] === ACCOUNT_CHANNELS.failover,
    );
    expect(sends).toHaveLength(2);
    expect(sends[0]![1]).toEqual(
      expect.objectContaining({
        toAccountId: 'account-b',
        coalesced: false,
        crossAccount: true,
        missionId: 'm1',
      }),
    );
    expect(sends[1]![1]).toEqual(
      expect.objectContaining({
        toAccountId: 'account-b',
        coalesced: true,
        missionId: 'm2',
      }),
    );
    // Cooldown once per pane path still marks exhausted account; target not re-picked.
    expect(accountMocks.setCooldown).toHaveBeenCalled();
  });

  it('does not poison coalesce when prepare fails; retries alternate account', async () => {
    const { prepareAccountForSpawn, pickAvailableForFailover } = await import(
      '../persistence/account-store'
    );
    const scope = testProjectScope();
    const owner = renderer(707);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: 'pane-prep',
      sessionId: 'sess-prep',
      missionId: 'm-prep',
      scope,
    });

    accountMocks.next = {
      id: 'account-b',
      adapterId: 'claude',
      label: 'Account B',
      mode: 'subscription',
      upstream: 'anthropic',
      createdAt: 1,
    };
    const accountC = {
      id: 'account-c',
      adapterId: 'claude',
      label: 'Account C',
      mode: 'subscription' as const,
      upstream: 'anthropic',
      createdAt: 2,
    };
    vi.mocked(prepareAccountForSpawn)
      .mockImplementationOnce(() => ({ ok: false as const, error: 'no key' }))
      .mockImplementationOnce(() => ({
        ok: true as const,
        account: accountC,
        apiKey: null,
        authEnv: {},
      }));
    vi.mocked(pickAvailableForFailover)
      .mockImplementationOnce(() => ({ account: accountMocks.next, probe: false }))
      .mockImplementationOnce(() => ({ account: accountC, probe: false }));

    ptyMocks.dataTaps[0]!('sess-prep', 'LIMIT');
    await settleFailover();

    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        switched: true,
        toAccountId: 'account-c',
        coalesced: false,
      }),
    );
  });

  it('percorre a frota até uma conta preparar e tira as quebradas da frente (F-676)', async () => {
    const { prepareAccountForSpawn, pickAvailableForFailover } = await import(
      '../persistence/account-store'
    );
    const scope = testProjectScope();
    const owner = renderer(711);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({ owner, paneId: 'pane-fleet', sessionId: 'sess-fleet', missionId: 'm-fleet', scope });

    // Frota: b, c e d sem credencial utilizável; e está saudável.
    const fleet = ['account-b', 'account-c', 'account-d', 'account-e'].map((id, index) => ({
      id,
      adapterId: 'claude',
      label: `Conta ${index}`,
      mode: 'api-key' as const,
      upstream: 'anthropic',
      createdAt: index + 1,
    }));
    vi.mocked(pickAvailableForFailover).mockImplementation(
      (_adapterId, excludeId, _now, _scores, options) => ({
        account:
          fleet.find((acct) => acct.id !== excludeId && !options?.excludeIds?.has(acct.id)) ?? null,
        probe: false,
      }),
    );
    const prepareFleet = (_adapterId: string, id: string) => {
      const acct = fleet.find((candidate) => candidate.id === id);
      return acct && id === 'account-e'
        ? { ok: true as const, account: acct, apiKey: null, authEnv: {} }
        : { ok: false as const, error: 'sem credencial' };
    };
    // Once por conta tentada: o mock do módulo volta ao padrão nos testes seguintes.
    for (let i = 0; i < fleet.length; i += 1) {
      vi.mocked(prepareAccountForSpawn).mockImplementationOnce(prepareFleet);
    }
    accountMocks.setCooldown.mockClear();

    ptyMocks.dataTaps[0]!('sess-fleet', 'LIMIT');
    for (let i = 0; i < 4; i += 1) await settleFailover();

    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ switched: true, toAccountId: 'account-e' }),
    );
    for (const broken of ['account-b', 'account-c', 'account-d']) {
      expect(accountMocks.setCooldown).toHaveBeenCalledWith(
        broken,
        expect.any(Number),
        expect.stringContaining('troca indisponível'),
        undefined,
      );
    }
  });

  it('does not materialize a Claude failover credential that proves another identity', async () => {
    const { prepareAccountForSpawn } = await import('../persistence/account-store');
    const scope = testProjectScope();
    const owner = renderer(709);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({ owner, paneId: 'pane-mismatch', sessionId: 'sess-mismatch', missionId: 'm-mismatch', scope });
    accountMocks.verifyClaude.mockResolvedValue('mismatch');
    vi.mocked(prepareAccountForSpawn).mockClear();

    ptyMocks.dataTaps[0]!('sess-mismatch', 'LIMIT');
    await settleFailover();

    expect(accountMocks.verifyClaude).toHaveBeenCalledWith('account-b', expect.any(Function));
    expect(prepareAccountForSpawn).not.toHaveBeenCalled();
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ switched: false }),
    );
  });

  it('keeps Claude API key failover independent of OAuth identity probing', async () => {
    const scope = testProjectScope();
    const owner = renderer(710);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({ owner, paneId: 'pane-api', sessionId: 'sess-api', missionId: 'm-api', scope });
    accountMocks.next = {
      id: 'account-b', adapterId: 'claude', label: 'API B', mode: 'api-key',
      upstream: 'anthropic', createdAt: 1,
    };

    ptyMocks.dataTaps[0]!('sess-api', 'LIMIT');
    await settleFailover();

    expect(accountMocks.verifyClaude).not.toHaveBeenCalled();
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ switched: true, toAccountId: 'account-b' }),
    );
  });

  it('fails closed before account mutation for ambiguous, unscoped or ownerless panes', () => {
    const scope = testProjectScope();
    const owner = renderer(303);
    const unregistered = renderer(404);
    renderers.push(owner, unregistered);
    bindResolvedRendererWorkspaceScope(owner, scope);
    bindResolvedRendererWorkspaceScope(unregistered, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: 'ambiguous-pane',
      sessionId: 'ambiguous-session',
      scope,
    });
    paneMocks.authorities.set('ambiguous-session', null);
    addPane({
      owner,
      paneId: 'unscoped-pane',
      sessionId: 'unscoped-session',
      scope,
    });
    paneMocks.authorities.set('unscoped-session', {
      ...(paneMocks.authorities.get('unscoped-session') as object),
      scope: undefined,
    });
    addPane({
      owner: unregistered,
      paneId: 'ownerless-pane',
      sessionId: 'ownerless-session',
      scope,
    });

    ptyMocks.dataTaps[0]('ambiguous-session', 'LIMIT');
    ptyMocks.dataTaps[0]('unscoped-session', 'LIMIT');
    ptyMocks.dataTaps[0]('ownerless-session', 'LIMIT');

    expect(accountMocks.setCooldown).not.toHaveBeenCalled();
    expect(owner.send).not.toHaveBeenCalled();
    expect(unregistered.send).not.toHaveBeenCalled();
  });

  it('clears partial detector buffers on scope change, session exit and destroy', () => {
    const scopeA = testProjectScope();
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    const owner = renderer(505);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scopeA);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: 'pane-a',
      sessionId: 'session-a',
      missionId: 'mission-a',
      scope: scopeA,
    });

    ptyMocks.dataTaps[0]('session-a', 'LIM');
    bindResolvedRendererWorkspaceScope(owner, scopeB);
    bindResolvedRendererWorkspaceScope(owner, scopeA);
    ptyMocks.dataTaps[0]('session-a', 'IT');
    ptyMocks.dataTaps[0]('session-a', 'LIM');
    ptyMocks.exitTaps[0]('session-a');
    ptyMocks.dataTaps[0]('session-a', 'IT');
    ptyMocks.dataTaps[0]('session-a', 'LIM');
    owner.emit('destroyed');
    ptyMocks.dataTaps[0]('session-a', 'IT');

    expect(accountMocks.setCooldown).not.toHaveBeenCalled();
    expect(owner.send).not.toHaveBeenCalled();
  });
});

describe('espera-pela-irmã + cooldown escopado (C1, derivado do oh-my-pi)', () => {
  function armPane(id: number): Renderer {
    const scope = testProjectScope();
    const owner = renderer(id);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: `pane-${id}`,
      sessionId: `sess-${id}`,
      missionId: `m-${id}`,
      scope,
    });
    return owner;
  }

  it('todas bloqueadas: evento carrega nextUnblockAtMs e agenda retry que troca quando a irmã libera', async () => {
    const { pickAvailableForFailover } = await import(
      '../persistence/account-store'
    );
    const owner = armPane(808);
    // Primeira decisão: nada livre; irmã mais próxima libera em 130s.
    vi.mocked(pickAvailableForFailover).mockImplementationOnce(() => ({
      account: null,
      probe: false,
      nextUnblockAtMs: 130_000,
    }));

    ptyMocks.dataTaps[0]!('sess-808', 'LIMIT');
    await settleFailover();

    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'pane-808',
        switched: false,
        nextUnblockAtMs: 130_000,
        // min(própria conta 100k+60k, irmã 130k) + 1s de folga.
        scheduledRetryAtMs: 131_000,
      }),
    );

    // Dispara a espera-pela-irmã: o pick default volta a devolver account-b.
    vi.advanceTimersByTime(31_000);
    await settleFailover();

    const sends = owner.send.mock.calls.filter(
      (c) => c[0] === ACCOUNT_CHANNELS.failover,
    );
    expect(sends).toHaveLength(2);
    expect(sends[1]![1]).toEqual(
      expect.objectContaining({
        switched: true,
        toAccountId: 'account-b',
        crossAccount: true,
        reason: expect.stringContaining('retry automático'),
      }),
    );
  });

  it('espera o fim do PRÓPRIO cooldown quando é o menor (sem irmã mais cedo)', async () => {
    const { pickAvailableForFailover } = await import(
      '../persistence/account-store'
    );
    const owner = armPane(809);
    // Irmãs só liberam bem depois do cooldown da própria conta (60s).
    vi.mocked(pickAvailableForFailover).mockImplementationOnce(() => ({
      account: null,
      probe: false,
      nextUnblockAtMs: 500_000,
    }));

    ptyMocks.dataTaps[0]!('sess-809', 'LIMIT');

    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        switched: false,
        nextUnblockAtMs: 500_000,
        // min(100k+60k própria, 500k irmã) + 1s.
        scheduledRetryAtMs: 161_000,
      }),
    );
  });

  it('F-1483: a espera não morre em ~4 min — backoff até 15 min e só desiste depois de 24 h, avisando o Maestro', async () => {
    const { pickAvailableForFailover } = await import('../persistence/account-store');
    const owner = armPane(819);
    vi.mocked(pickAvailableForFailover).mockReturnValue({ account: null, probe: false, nextUnblockAtMs: 101_000 });
    ptyMocks.dataTaps[0]!('sess-819', 'LIMIT');
    await settleFailover();
    const events = () => owner.send.mock.calls.filter(([channel]) => channel === ACCOUNT_CHANNELS.failover).map(([, event]) => event as { scheduledRetryAtMs?: number; switched: boolean });
    expect(events().at(-1)?.scheduledRetryAtMs).toBe(102_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await settleFailover();
    expect(events()).toHaveLength(2);
    expect(events().at(-1)?.scheduledRetryAtMs).toBe(132_000);
    // O teto antigo (8 tentativas a cada 30 s) parava aqui; a espera segue.
    await vi.advanceTimersByTimeAsync(8 * 30_000);
    await settleFailover();
    expect(events().at(-1)?.scheduledRetryAtMs).toBeGreaterThan(Date.now());
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    await settleFailover();
    const next = events().at(-1)!.scheduledRetryAtMs!;
    expect(next).toBeGreaterThan(Date.now());
    expect(next - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(storeMocks.submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await settleFailover();
    expect(events().at(-1)?.switched).toBe(false);
    expect(events().at(-1)?.scheduledRetryAtMs).toBeUndefined();
    expect(storeMocks.submit).toHaveBeenCalledTimes(1);
    expect(String(storeMocks.submit.mock.calls[0]![0].summary)).toContain('24 h');
  });

  it('F-1483: retry volta à própria conta com a sessão viva — "continue" na mesma sessão, nenhum switched:true', async () => {
    const { pickAvailableForFailover } = await import('../persistence/account-store');
    const owner = armPane(830);
    ptyMocks.sessionStates.set('sess-830', 'idle');
    vi.mocked(pickAvailableForFailover)
      .mockImplementationOnce(() => ({ account: null, probe: false, nextUnblockAtMs: 500_000 }))
      .mockImplementationOnce(() => ({ account: accountMocks.current as Account, probe: false }));
    ptyMocks.dataTaps[0]!('sess-830', 'LIMIT');
    await settleFailover();
    await vi.advanceTimersByTimeAsync(61_000);
    await settleFailover();
    expect(toolMocks.injectPrompt).toHaveBeenCalledWith('sess-830', TRANSIENT_CONTINUE_PROMPT, undefined, 'failover');
    const sends = owner.send.mock.calls
      .filter(([channel]) => channel === ACCOUNT_CHANNELS.failover)
      .map(([, event]) => event as { switched: boolean; transientPhase?: string });
    expect(sends.some((event) => event.switched)).toBe(false);
    expect(sends.at(-1)).toMatchObject({ switched: false, transientPhase: 'nudged' });
  });

  function taskHandle(paneId: string, reroute: PaneTaskRerouteHandle['reroute']): PaneTaskRerouteHandle {
    return {
      paneId, adapterId: 'claude', missionId: `m-${paneId}`, role: 'worker', callerSessionId: 'session-maestro',
      routeTask: 'implementar o login', lineageId: paneId, operatorOpened: false, pinnedRuntime: false,
      generation: 0, reroute, hasAlternative: () => true,
    };
  }

  it('F-1483: a espera sobrevive ao reinício e religa a missão viva na hora calculada pelos cooldowns persistidos', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    initFailoverWaits(db as never);
    try {
      storeMocks.missionStatus = 'running';
      vi.mocked(getAccount).mockImplementation((id: string) =>
        id === 'account-a' ? { ...accountMocks.current, cooldownUntil: 160_000 } as Account
          : id === 'account-b' ? accountMocks.next : null);
      const owner = armPane(840);
      const reroute = vi.fn<PaneTaskRerouteHandle['reroute']>(async () => ({ paneId: 'pane-840-b', adapterId: 'claude' }));
      registerPaneTaskReroute(taskHandle('pane-840', reroute));
      vi.mocked(pickAvailableForFailover).mockImplementationOnce(() => ({
        account: null, probe: false, nextUnblockAtMs: 130_000,
      }));
      ptyMocks.dataTaps[0]!('sess-840', 'LIMIT');
      await settleFailover();
      expect(listFailoverWaits()).toEqual([
        expect.objectContaining({ paneId: 'pane-840', missionId: 'm-840', retryAt: 131_000, waitKind: 'account' }),
      ]);

      // Reinício: o app fecha no meio da espera (a saída de sessão é do shutdown).
      ptyMocks.shuttingDown = true;
      ptyMocks.exitTaps.forEach((tap) => tap('sess-840'));
      shutdownFailover();
      ptyMocks.shuttingDown = false;
      expect(listFailoverWaits()).toHaveLength(1);
      expect(reroute).not.toHaveBeenCalled();

      storeMocks.scopes.push(testProjectScope());
      initFailover();
      registerFailoverListener(owner);
      await vi.advanceTimersByTimeAsync(130_999 - Date.now());
      await settleFailover();
      expect(reroute).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await settleFailover();
      await settleFailover();
      expect(reroute).toHaveBeenCalledTimes(1);
      expect(vi.mocked(reroute).mock.calls[0]![0]).toMatchObject({
        sameAdapter: { adapterId: 'claude', accountId: 'account-b' },
      });
      expect(owner.send).toHaveBeenCalledWith(
        ACCOUNT_CHANNELS.failover,
        expect.objectContaining({ paneId: 'pane-840', switched: true, toPaneId: 'pane-840-b' }),
      );
      expect(listFailoverWaits()).toEqual([]);
    } finally {
      vi.mocked(getAccount).mockImplementation((id: string) => {
        if (id === accountMocks.current.id) return accountMocks.current as Account;
        if (accountMocks.next && id === accountMocks.next.id) return accountMocks.next;
        return null;
      });
      resetPaneTaskReroutesForTests();
      initFailoverWaits(null);
      db.close();
    }
  });

  it('F-1483: depois do reinício, missão que não está mais rodando não remonta sozinha — o fato vai ao Maestro', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    initFailoverWaits(db as never);
    try {
      armPane(841);
      vi.mocked(pickAvailableForFailover).mockImplementationOnce(() => ({
        account: null, probe: false, nextUnblockAtMs: 130_000,
      }));
      ptyMocks.dataTaps[0]!('sess-841', 'LIMIT');
      await settleFailover();
      expect(listFailoverWaits()).toHaveLength(1);
      shutdownFailover();
      storeMocks.missionStatus = 'blocked';
      storeMocks.scopes.push(testProjectScope());
      initFailover();
      await vi.advanceTimersByTimeAsync(60_000);
      await settleFailover();
      expect(listFailoverWaits()).toEqual([]);
      expect(storeMocks.submit).toHaveBeenCalledTimes(1);
      const summary = String(storeMocks.submit.mock.calls[0]![0].summary);
      expect(summary).toContain('pane-841');
      expect(summary).toContain('reinício');
      expect(vi.mocked(pickAvailableForFailover).mock.calls).toHaveLength(1);
    } finally {
      initFailoverWaits(null);
      db.close();
    }
  });

  it('sondagem last-resort: evento marca probe e não grava coalesce', async () => {
    const { pickAvailableForFailover, prepareAccountForSpawn } = await import(
      '../persistence/account-store'
    );
    const owner = armPane(810);
    vi.mocked(pickAvailableForFailover).mockImplementationOnce(() => ({
      account: accountMocks.next,
      probe: true,
      nextUnblockAtMs: 900_000,
    }));
    const prepareCallsBefore =
      vi.mocked(prepareAccountForSpawn).mock.calls.length;

    ptyMocks.dataTaps[0]!('sess-810', 'LIMIT');
    await settleFailover();

    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        switched: true,
        toAccountId: 'account-b',
        probe: true,
      }),
    );
    // Prepare recebeu a permissão explícita de sondagem em conta fria.
    const probeCall = vi
      .mocked(prepareAccountForSpawn)
      .mock.calls.slice(prepareCallsBefore)
      .find((call) => call[1] === 'account-b');
    expect(probeCall?.[3]).toEqual({ allowCoolingProbe: true, expectedClaudeBlob: 'verified-claude-blob' });

    // Segundo pane no mesmo from-account NÃO reusa a sondagem via coalesce:
    // a decisão de probe nunca é coalescida (uma request de teste por vez).
    const owner2Scope = testProjectScope();
    addPane({
      owner,
      paneId: 'pane-810b',
      sessionId: 'sess-810b',
      missionId: 'm-810b',
      scope: owner2Scope,
    });
    vi.mocked(pickAvailableForFailover).mockImplementationOnce(() => ({
      account: null,
      probe: false,
    }));
    ptyMocks.dataTaps[0]!('sess-810b', 'LIMIT');
    const sends = owner.send.mock.calls.filter(
      (c) => c[0] === ACCOUNT_CHANNELS.failover,
    );
    const second = sends.find(
      (c) => (c[1] as { paneId?: string }).paneId === 'pane-810b',
    );
    expect(second?.[1]).toEqual(expect.objectContaining({ switched: false }));
  });

  it('F-1401: credencial Claude girada entre verify e prepare refaz as duas etapas', async () => {
    const { prepareAccountForSpawn, verifyManagedClaudeAccountForSpawn } = await import(
      '../persistence/account-store'
    );
    const owner = armPane(821);
    const preparesBefore = vi.mocked(prepareAccountForSpawn).mock.calls.length;
    const verifiesBefore = vi.mocked(verifyManagedClaudeAccountForSpawn).mock.calls.length;
    vi.mocked(prepareAccountForSpawn).mockReturnValueOnce({
      ok: false,
      error: 'managed Claude credential changed after verified profile; retry spawn',
    });

    ptyMocks.dataTaps[0]!('sess-821', 'LIMIT');
    await settleFailover();
    await vi.advanceTimersByTimeAsync(200);
    await settleFailover();

    // verify+prepare refeitos na retentativa (a impl padrão volta a devolver ok).
    const preparesForB = vi
      .mocked(prepareAccountForSpawn)
      .mock.calls.slice(preparesBefore)
      .filter((call) => call[1] === 'account-b');
    expect(preparesForB).toHaveLength(2);
    expect(
      vi.mocked(verifyManagedClaudeAccountForSpawn).mock.calls.length - verifiesBefore,
    ).toBeGreaterThanOrEqual(2);
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ switched: true, toAccountId: 'account-b' }),
    );
  });

  it('saída da sessão cancela a espera-pela-irmã pendente', async () => {
    const { pickAvailableForFailover } = await import(
      '../persistence/account-store'
    );
    const owner = armPane(811);
    vi.mocked(pickAvailableForFailover).mockImplementationOnce(() => ({
      account: null,
      probe: false,
      nextUnblockAtMs: 130_000,
    }));

    ptyMocks.dataTaps[0]!('sess-811', 'LIMIT');
    await settleFailover();
    ptyMocks.exitTaps[0]!('sess-811');
    vi.advanceTimersByTime(120_000);
    await settleFailover();

    const sends = owner.send.mock.calls.filter(
      (c) => c[0] === ACCOUNT_CHANNELS.failover,
    );
    // Só o evento switched:false original; nenhum retry após o exit.
    expect(sends).toHaveLength(1);
  });

  it('propaga o escopo do hit para o cooldown da conta exausta', async () => {
    const { detectLimit } = await import('./limit-detector');
    const owner = armPane(812);
    vi.mocked(detectLimit).mockImplementationOnce((buffer: string) =>
      buffer.includes('LIMIT')
        ? {
            kind: 'rate-limit' as const,
            reason: 'opus limit',
            cooldownMs: 60_000,
            scope: 'tier:opus',
          }
        : null,
    );

    ptyMocks.dataTaps[0]!('sess-812', 'LIMIT');
    await settleFailover();

    expect(accountMocks.setCooldown).toHaveBeenCalledWith(
      'account-a',
      160_000,
      'opus limit',
      'tier:opus',
    );
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ switched: true, toAccountId: 'account-b' }),
    );
  });

  it('auth com irmã spawnable roteia para a conta 2 (não fica no toast de vazio)', async () => {
    const { detectLimit } = await import('./limit-detector');
    const owner = armPane(812);
    vi.mocked(detectLimit).mockImplementationOnce((buffer: string) =>
      buffer.includes('LIMIT')
        ? {
            kind: 'auth' as const,
            reason: '401 OAuth access token has expired',
            cooldownMs: 15 * 60 * 1000,
          }
        : null,
    );

    ptyMocks.dataTaps[0]!('sess-812', 'LIMIT');
    await settleFailover();

    expect(accountMocks.setCooldown).toHaveBeenCalledWith(
      'account-a',
      expect.any(Number),
      '401 OAuth access token has expired',
      undefined,
    );
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'pane-812',
        switched: true,
        kind: 'auth',
        crossAccount: true,
        toAccountId: 'account-b',
        fromAccountId: 'account-a',
      }),
    );
  });

  it('auth sem irmã no vault adota a sessão nativa de outro e-mail', async () => {
    const { detectLimit } = await import('./limit-detector');
    const { pickAvailableForFailover, adoptNativeAccountForFailover } =
      await import('../persistence/account-store');
    const owner = armPane(814);
    vi.mocked(detectLimit).mockImplementationOnce((buffer: string) =>
      buffer.includes('LIMIT')
        ? {
            kind: 'auth' as const,
            reason: '401 OAuth access token has expired',
            cooldownMs: 15 * 60 * 1000,
          }
        : null,
    );
    vi.mocked(pickAvailableForFailover).mockImplementationOnce(() => ({
      account: null,
      probe: false,
    }));
    vi.mocked(adoptNativeAccountForFailover).mockImplementationOnce(() => ({
      id: 'account-b',
      adapterId: 'claude',
      label: 'pessoal@example.test',
      mode: 'subscription' as const,
      upstream: 'anthropic',
      email: 'pessoal@example.test',
      createdAt: 2,
    }));

    ptyMocks.dataTaps[0]!('sess-814', 'LIMIT');
    await settleFailover();

    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'pane-814',
        switched: true,
        kind: 'auth',
        crossAccount: true,
        toAccountId: 'account-b',
      }),
    );
  });

  it('auth sem irmã não agenda retry same-account (não finge recuperação)', async () => {
    const { detectLimit } = await import('./limit-detector');
    const { pickAvailableForFailover } = await import(
      '../persistence/account-store'
    );
    const owner = armPane(813);
    vi.mocked(detectLimit).mockImplementationOnce((buffer: string) =>
      buffer.includes('LIMIT')
        ? {
            kind: 'auth' as const,
            reason: '401 OAuth access token has expired',
            cooldownMs: 15 * 60 * 1000,
          }
        : null,
    );
    vi.mocked(pickAvailableForFailover).mockImplementationOnce(() => ({
      account: null,
      probe: false,
    }));

    ptyMocks.dataTaps[0]!('sess-813', 'LIMIT');

    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'pane-813',
        switched: false,
        kind: 'auth',
      }),
    );
    const first = owner.send.mock.calls.find(
      (c) => c[0] === ACCOUNT_CHANNELS.failover,
    );
    expect(
      (first?.[1] as { scheduledRetryAtMs?: number }).scheduledRetryAtMs,
    ).toBeUndefined();

    vi.advanceTimersByTime(60_000);
    const sends = owner.send.mock.calls.filter(
      (c) => c[0] === ACCOUNT_CHANNELS.failover,
    );
    expect(sends).toHaveLength(1);
  });
});

/**
 * As provas da política de WAIVER saíram com o motor cerimonial:
 * `provider-failure-waiver.ts` foi removido junto com o dispatch/claim das
 * tasks advisory que ele dispensava, e `failover.ts` não consulta mais
 * política nenhuma nesse caminho. Sem task advisory para dispensar, o worker
 * main-owned sem rota agora sempre preserva a espera-pela-irmã — o ramo
 * estritamente mais seguro, que não consegue marcar como done um trabalho que
 * nunca rodou. A espera-pela-irmã em si continua coberta no bloco C1 acima.
 */

describe('disjuntor de morte instantânea (401-loop multi-conta)', () => {
  it('troca na 1ª morte instantânea de auth e trava na 2ª seguida com motivo acionável', async () => {
    const { detectLimit } = await import('./limit-detector');
    const { ensureFreshClaudeSubscription } = await import(
      '../persistence/account-store'
    );
    vi.mocked(ensureFreshClaudeSubscription).mockRejectedValueOnce(
      new Error('vault indisponível'),
    );
    const authHit = (buffer: string) =>
      buffer.includes('LIMIT')
        ? {
            kind: 'auth' as const,
            reason: 'invalid x-api-key',
            cooldownMs: 60_000,
          }
        : null;
    vi.mocked(detectLimit)
      .mockImplementationOnce(authHit)
      .mockImplementationOnce(authHit);
    const scope = testProjectScope();
    const owner = renderer(901);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: 'pane-instant-1',
      sessionId: 'sess-instant-1',
      scope,
    });

    // 1ª morte instantânea: legítima (pane aberto em conta morta cai na irmã).
    ptyMocks.dataTaps[0]!('sess-instant-1', 'LIMIT 401');
    await settleFailover();
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'pane-instant-1',
        switched: true,
        toAccountId: 'account-b',
      }),
    );
    expect(ensureFreshClaudeSubscription).toHaveBeenCalledWith(
      'account-a',
      100_000,
      undefined,
      { force: true },
    );

    // 2ª sessão morre de auth com segundos de vida: o disjuntor trava em vez
    // de queimar outro pane — sem nova troca, com motivo acionável.
    addPane({
      owner,
      paneId: 'pane-instant-2',
      sessionId: 'sess-instant-2',
      scope,
    });
    owner.send.mockClear();
    ptyMocks.dataTaps[0]!('sess-instant-2', 'LIMIT 401');
    await settleFailover();
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'pane-instant-2',
        switched: false,
        kind: 'auth',
        // O ponteiro "Entre novamente em Providers" entra no toast
        // (blockedFailoverToastCopy); o evento carrega só o diagnóstico.
        reason: expect.stringContaining('segundos de vida'),
      }),
    );
    const switchedTrue = owner.send.mock.calls.filter(
      (c) =>
        c[0] === ACCOUNT_CHANNELS.failover &&
        (c[1] as { switched?: boolean }).switched === true,
    );
    expect(switchedTrue).toHaveLength(0);
  });

  it('contas diferentes mortas seguidas continuam girando a frota (F-676)', async () => {
    // Frota de 10–100 contas: duas expiradas não podem travar a rotação das
    // outras. Só a MESMA conta morta duas vezes (ou 5 contas distintas) trava.
    const { detectLimit } = await import('./limit-detector');
    const authHit = (buffer: string) =>
      buffer.includes('LIMIT')
        ? { kind: 'auth' as const, reason: 'invalid x-api-key', cooldownMs: 60_000 }
        : null;
    vi.mocked(detectLimit)
      .mockImplementationOnce(authHit)
      .mockImplementationOnce(authHit);
    const scope = testProjectScope();
    const owner = renderer(903);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    const originalCurrent = accountMocks.current;
    try {
      addPane({ owner, paneId: 'pane-fleet-1', sessionId: 'sess-fleet-1', scope });
      ptyMocks.dataTaps[0]!('sess-fleet-1', 'LIMIT 401');
      await settleFailover();

      // O pane novo nasceu na account-b, que também estava morta.
      accountMocks.current = { ...originalCurrent, id: 'account-b', label: 'Account B', createdAt: 1 };
      accountMocks.next = { ...originalCurrent, id: 'account-c', label: 'Account C', createdAt: 2 };
      addPane({ owner, paneId: 'pane-fleet-2', sessionId: 'sess-fleet-2', scope, accountId: 'account-b' });
      owner.send.mockClear();
      ptyMocks.dataTaps[0]!('sess-fleet-2', 'LIMIT 401');
      await settleFailover();
      expect(owner.send).toHaveBeenCalledWith(
        ACCOUNT_CHANNELS.failover,
        expect.objectContaining({ paneId: 'pane-fleet-2', switched: true, toAccountId: 'account-c' }),
      );
    } finally {
      accountMocks.current = originalCurrent;
    }
  });

  it('trip repetido sempre emite e re-login zera a contagem', async () => {
    const { detectLimit } = await import('./limit-detector');
    const authHit = (buffer: string) =>
      buffer.includes('LIMIT')
        ? {
            kind: 'auth' as const,
            reason: 'invalid x-api-key',
            cooldownMs: 60_000,
          }
        : null;
    vi.mocked(detectLimit)
      .mockImplementationOnce(authHit)
      .mockImplementationOnce(authHit)
      .mockImplementationOnce(authHit)
      .mockImplementationOnce(authHit);
    const scope = testProjectScope();
    const owner = renderer(902);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    const fire = async (n: number) => {
      addPane({
        owner,
        paneId: `pane-trip-${n}`,
        sessionId: `sess-trip-${n}`,
        scope,
      });
      ptyMocks.dataTaps[0]!(`sess-trip-${n}`, 'LIMIT 401');
      await settleFailover();
    };
    await fire(1);
    await fire(2);
    // 3ª morte seguida: trava de novo E emite de novo (sem janela muda —
    // o toast deduplica no lugar, mas o pane nunca morre em silêncio).
    await fire(3);
    const trips = owner.send.mock.calls.filter(
      (c) =>
        c[0] === ACCOUNT_CHANNELS.failover &&
        (c[1] as { switched?: boolean }).switched === false,
    );
    expect(trips).toHaveLength(2);
    // Re-login: a contagem antiga não vale contra a credencial nova.
    resetInstantAuthDeaths('claude');
    owner.send.mockClear();
    await fire(4);
    await settleFailover();
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'pane-trip-4',
        switched: true,
        toAccountId: 'account-b',
      }),
    );
  });
});

describe('erro do provider (5xx) — episódio sem troca de conta', () => {
  const E503 = 'API Error (status:503): Service Unavailable';

  async function setupTransient(options: { missionId?: string } = { missionId: 'mission-503' }) {
    const { detectLimit } = await import('./limit-detector');
    vi.mocked(detectLimit).mockImplementation((buffer: string) => {
      if (buffer.includes('LIMIT')) {
        return { kind: 'rate-limit', reason: 'rate limit', cooldownMs: 60_000 };
      }
      if (buffer.includes('status:503')) {
        return { kind: 'transient', reason: 'status:503', cooldownMs: 20_000 };
      }
      return null;
    });
    const scope = testProjectScope();
    const owner = renderer(503);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: 'pane-503',
      sessionId: 'session-503',
      ...(options.missionId ? { missionId: options.missionId } : {}),
      scope,
    });
    ptyMocks.sessionStates.set('session-503', 'busy');
    return owner;
  }

  function failoverEvents(owner: Renderer): Array<Record<string, unknown>> {
    return owner.send.mock.calls
      .filter(([channel]) => channel === ACCOUNT_CHANNELS.failover)
      .map(([, event]) => event as Record<string, unknown>);
  }

  afterEach(async () => {
    const { detectLimit } = await import('./limit-detector');
    vi.mocked(detectLimit).mockImplementation((buffer: string) =>
      buffer.includes('LIMIT')
        ? ({ reason: 'rate limit', cooldownMs: 60_000 } as ReturnType<typeof detectLimit>)
        : null,
    );
  });

  it('não troca, não põe cooldown e avisa uma vez por episódio (ping-pong A↔B, 23/09)', async () => {
    const owner = await setupTransient();
    ptyMocks.dataTaps[0]('session-503', E503);
    // A CLI reimprime o erro a cada retry interno.
    ptyMocks.dataTaps[0]('session-503', `${E503} · Retrying in 2 seconds (attempt 2/10)`);
    await settleFailover();

    expect(accountMocks.setCooldown).not.toHaveBeenCalled();
    const events = failoverEvents(owner);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'transient', switched: false, fromAccountId: 'account-a' });
  });

  it('CLI parada no erro: a MESMA sessão recebe "continue" — sem respawn, sem trocar conta', async () => {
    const owner = await setupTransient();
    ptyMocks.dataTaps[0]('session-503', E503);
    ptyMocks.sessionStates.set('session-503', 'idle');
    await vi.advanceTimersByTimeAsync(21_000);
    await settleFailover();

    expect(toolMocks.injectPrompt).toHaveBeenCalledOnce();
    const [sessionId, prompt] = toolMocks.injectPrompt.mock.calls[0]!;
    expect(sessionId).toBe('session-503');
    // O pedido não ecoa o erro: o detector não pode relê-lo no próprio pane.
    expect(prompt).not.toMatch(/503|overload|unavailable|limit/i);
    const events = failoverEvents(owner);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: 'transient', switched: false, transientPhase: 'nudged' });
    expect(events.some((event) => event.switched === true)).toBe(false);
    expect(accountMocks.setCooldown).not.toHaveBeenCalled();
  });

  // F-1427: o MiniMax parou no erro do provedor, ficou idle_prompt e ninguém
  // reabriu a tarefa — o "continue" era a única saída e o supervisor nem sabia.
  it('F-1427: a parada no erro vai à rede do supervisor; a 2ª parada pula o retry', async () => {
    resetPaneStartWatchdogForTests();
    try {
      const owner = await setupTransient();
      ptyMocks.dataTaps[0]('session-503', E503);
      ptyMocks.sessionStates.set('session-503', 'idle');
      await vi.advanceTimersByTimeAsync(21_000);
      await settleFailover();

      // 1ª parada: um retry ("continue") e a ficha no prazo normal do supervisor.
      expect(toolMocks.injectPrompt).toHaveBeenCalledOnce();
      const first = listConfirmedPaneLimits();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        paneId: 'pane-503',
        sessionId: 'session-503',
        kind: 'provider-error',
        reason: 'status:503',
      });
      expect(first[0]!.readyAt).toBeUndefined();

      // O retry falhou igual: erro novo, CLI parada de novo.
      ptyMocks.sessionStates.set('session-503', 'busy');
      ptyMocks.dataTaps[0]('session-503', `${E503} (attempt 2)`);
      await settleFailover();
      ptyMocks.sessionStates.set('session-503', 'idle');
      await vi.advanceTimersByTimeAsync(21_000);
      await settleFailover();

      // Sem 2º retry: a ficha fica pronta para o supervisor agir já.
      expect(toolMocks.injectPrompt).toHaveBeenCalledOnce();
      const second = listConfirmedPaneLimits();
      expect(second).toHaveLength(1);
      expect(second[0]).toMatchObject({ kind: 'provider-error' });
      expect(second[0]!.readyAt).toBe(second[0]!.at);
      expect(failoverEvents(owner).at(-1)).toMatchObject({
        kind: 'transient',
        switched: false,
        transientPhase: 'stopped',
      });
      expect(accountMocks.setCooldown).not.toHaveBeenCalled();
    } finally {
      resetPaneStartWatchdogForTests();
    }
  });

  it('F-1427: pane do operador (sem missão) nunca entra na rede de reabertura', async () => {
    resetPaneStartWatchdogForTests();
    await setupTransient({});
    ptyMocks.dataTaps[0]('session-503', E503);
    ptyMocks.sessionStates.set('session-503', 'idle');
    await vi.advanceTimersByTimeAsync(21_000);
    expect(listConfirmedPaneLimits()).toHaveLength(0);
  });

  it('CLI voltou a responder: não retoma nem mexe no pane', async () => {
    const owner = await setupTransient();
    ptyMocks.dataTaps[0]('session-503', E503);
    const answer = Array.from(
      { length: 12 },
      (_, i) => `Linha ${i} da resposta do modelo depois da recuperação do provider.`,
    ).join('\n');
    ptyMocks.dataTaps[0]('session-503', answer);
    ptyMocks.sessionStates.set('session-503', 'idle');
    await vi.advanceTimersByTimeAsync(21_000);

    expect(failoverEvents(owner)).toHaveLength(1);
  });

  it('repaint do prompt não conta como resposta: retoma mesmo com a moldura redesenhada', async () => {
    const owner = await setupTransient();
    ptyMocks.dataTaps[0]('session-503', E503);
    const prompt = '╭────────────────────────────╮\n│ > Try "fix the failing tests" │\n╰────────────────────────────╯';
    for (let i = 0; i < 20; i += 1) ptyMocks.dataTaps[0]('session-503', prompt);
    ptyMocks.sessionStates.set('session-503', 'idle');
    await vi.advanceTimersByTimeAsync(21_000);
    await settleFailover();

    expect(toolMocks.injectPrompt).toHaveBeenCalledOnce();
    expect(failoverEvents(owner).at(-1)).toMatchObject({ transientPhase: 'nudged' });
  });

  it('repaint do transcript ANTIGO depois do erro não conta como resposta (semeado)', async () => {
    await setupTransient();
    const oldTranscript = Array.from(
      { length: 30 },
      (_, i) => `Linha antiga ${i} do transcript que já estava na tela antes do erro.`,
    ).join('\n');
    ptyMocks.dataTaps[0]('session-503', `${oldTranscript}
${E503}`);
    // Resize/foco: a tela inteira volta, sem nada novo.
    ptyMocks.dataTaps[0]('session-503', oldTranscript);
    ptyMocks.sessionStates.set('session-503', 'idle');
    await vi.advanceTimersByTimeAsync(21_000);
    await settleFailover();

    expect(toolMocks.injectPrompt).toHaveBeenCalledOnce();
  });

  it('repaint do MESMO erro não apaga a resposta que já chegou', async () => {
    const owner = await setupTransient();
    ptyMocks.dataTaps[0]('session-503', E503);
    const answer = Array.from(
      { length: 12 },
      (_, i) => `Linha ${i} da resposta do modelo depois da recuperação do provider.`,
    ).join('\n');
    ptyMocks.dataTaps[0]('session-503', answer);
    // A região dinâmica da TUI redesenha o erro antigo junto.
    ptyMocks.dataTaps[0]('session-503', E503);
    ptyMocks.sessionStates.set('session-503', 'idle');
    await vi.advanceTimersByTimeAsync(21_000);
    await settleFailover();

    expect(toolMocks.injectPrompt).not.toHaveBeenCalled();
    expect(failoverEvents(owner)).toHaveLength(1);
  });

  it('CLI ainda ocupada nos próprios retries: confere de novo em vez de interromper', async () => {
    const owner = await setupTransient();
    ptyMocks.dataTaps[0]('session-503', E503);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(failoverEvents(owner)).toHaveLength(1);
    expect(toolMocks.injectPrompt).not.toHaveBeenCalled();

    ptyMocks.sessionStates.set('session-503', 'idle');
    await vi.advanceTimersByTimeAsync(31_000);
    await settleFailover();
    expect(toolMocks.injectPrompt).toHaveBeenCalledOnce();
  });

  it('CLI ocupada ~3 min sem resposta: emite "stalled" uma vez e encerra a vigília', async () => {
    const owner = await setupTransient();
    ptyMocks.dataTaps[0]('session-503', E503);
    await vi.advanceTimersByTimeAsync(21_000); // 1ª conferência: ainda ocupada
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(31_000); // 2ª…6ª
    await settleFailover();

    const events = failoverEvents(owner);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      kind: 'transient',
      switched: false,
      transientPhase: 'stalled',
    });
    expect(String(events[1].reason)).toMatch(/sem resposta/);
    expect(toolMocks.injectPrompt).not.toHaveBeenCalled();
    // Episódio encerrado: um erro novo abre episódio novo.
    ptyMocks.dataTaps[0]('session-503', E503);
    await settleFailover();
    expect(failoverEvents(owner)).toHaveLength(3);
  });

  it('limite de verdade esperando a conta: o 503 não abre episódio nem pede continue', async () => {
    const owner = await setupTransient();
    accountMocks.next = null; // sem irmã: o limite real agenda a espera
    ptyMocks.dataTaps[0]('session-503', 'LIMIT');
    await settleFailover();
    const before = failoverEvents(owner).length;
    await vi.advanceTimersByTimeAsync(31_000); // passa o rearm do limite
    ptyMocks.dataTaps[0]('session-503', E503);
    ptyMocks.sessionStates.set('session-503', 'idle');
    await vi.advanceTimersByTimeAsync(21_000);
    await settleFailover();

    expect(toolMocks.injectPrompt).not.toHaveBeenCalled();
    expect(
      failoverEvents(owner)
        .slice(before)
        .filter((event) => event.kind === 'transient'),
    ).toHaveLength(0);
  });

  it('limite de VERDADE logo depois do 503 ainda troca de conta (sem rearm)', async () => {
    const owner = await setupTransient();
    ptyMocks.dataTaps[0]('session-503', E503);
    await settleFailover();
    await vi.advanceTimersByTimeAsync(5_000);
    ptyMocks.dataTaps[0]('session-503', 'LIMIT');
    await settleFailover();

    expect(accountMocks.setCooldown).toHaveBeenCalledOnce();
    expect(failoverEvents(owner).at(-1)).toMatchObject({ switched: true, toAccountId: 'account-b' });
    // O limite real encerra o episódio: nenhuma retomada tardia na conta A.
    ptyMocks.sessionStates.set('session-503', 'idle');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      failoverEvents(owner).filter((event) => event.toAccountId === 'account-a'),
    ).toHaveLength(0);
  });

  it('pane do operador sem missão: só avisa que a CLI parou, sem matar e reabrir', async () => {
    const owner = await setupTransient({});
    ptyMocks.dataTaps[0]('session-503', E503);
    ptyMocks.sessionStates.set('session-503', 'idle');
    await vi.advanceTimersByTimeAsync(21_000);

    const events = failoverEvents(owner);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: 'transient', switched: false });
    expect(String(events[1].reason)).toContain('continue');
  });

  it('sessão que saiu encerra o episódio sem retomada', async () => {
    const owner = await setupTransient();
    ptyMocks.dataTaps[0]('session-503', E503);
    ptyMocks.exitTaps[0]('session-503');
    ptyMocks.sessionStates.set('session-503', 'exited');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(failoverEvents(owner)).toHaveLength(1);
  });
});

describe('varredura de limite sob saída contínua de PTY', () => {
  function armPane(id: number): Renderer {
    const scope = testProjectScope();
    const owner = renderer(id);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: `pane-${id}`,
      sessionId: `sess-${id}`,
      missionId: `m-${id}`,
      scope,
    });
    return owner;
  }

  it('não revarre a janela a cada chunk de uma rajada', async () => {
    const { detectLimit } = await import('./limit-detector');
    armPane(900);
    vi.mocked(detectLimit).mockClear();

    for (let i = 0; i < 40; i += 1) ptyMocks.dataTaps[0]!('sess-900', 'thinking…');

    expect(vi.mocked(detectLimit).mock.calls.length).toBeLessThanOrEqual(1);
    vi.advanceTimersByTime(250);
    expect(vi.mocked(detectLimit).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('um limite que chega logo depois de outra saída é pego pela varredura final', async () => {
    armPane(901);
    ptyMocks.dataTaps[0]!('sess-901', 'working on it');
    ptyMocks.dataTaps[0]!('sess-901', 'LIMIT');
    await settleFailover();

    vi.advanceTimersByTime(250);
    await settleFailover();

    expect(accountMocks.setCooldown).toHaveBeenCalled();
  });

  it('rajada longa é varrida pelo menos a cada meia janela', async () => {
    const { detectLimit } = await import('./limit-detector');
    armPane(902);
    ptyMocks.dataTaps[0]!('sess-902', 'start');
    vi.mocked(detectLimit).mockClear();

    for (let i = 0; i < 10; i += 1) ptyMocks.dataTaps[0]!('sess-902', 'x'.repeat(500));
    ptyMocks.dataTaps[0]!('sess-902', 'LIMIT');

    // 5 000 chars no mesmo instante: varredura a cada 2 000, sem esperar timer.
    expect(vi.mocked(detectLimit).mock.calls.length).toBeGreaterThanOrEqual(2);
    vi.advanceTimersByTime(250);
    await settleFailover();
    expect(accountMocks.setCooldown).toHaveBeenCalled();
  });
});

describe('F-764: orçamento da varredura de limite', () => {
  it('varredura acima do orçamento põe a sessão em backoff, registra no trace e cobre o texto depois', async () => {
    const { detectLimit } = await import('./limit-detector');
    const scope = testProjectScope();
    const owner = renderer(9764);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({ owner, paneId: 'pane-slow', sessionId: 'sess-slow', missionId: 'm-slow', scope });
    vi.mocked(detectLimit).mockClear();
    traceMocks.trace.mockClear();
    // Varredura lenta: o relógio (fake) anda 40 ms dentro da chamada.
    vi.mocked(detectLimit).mockImplementationOnce(() => {
      vi.advanceTimersByTime(40);
      return null;
    });

    ptyMocks.dataTaps[0]!('sess-slow', 'tela'.repeat(4));
    expect(detectLimit).toHaveBeenCalledTimes(1);
    expect(traceMocks.trace).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'failover-detect-slow', sessionId: 'sess-slow', paneId: 'pane-slow' }),
    );

    // Dentro do backoff nenhum chunk varre de novo, mesmo com o intervalo mínimo vencido.
    vi.advanceTimersByTime(1_000);
    ptyMocks.dataTaps[0]!('sess-slow', 'LIMIT');
    expect(detectLimit).toHaveBeenCalledTimes(1);

    // Vencido o backoff, a varredura final pega o limite que chegou no meio.
    vi.advanceTimersByTime(5_000);
    expect(detectLimit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(detectLimit).mock.calls[1]![0]).toContain('LIMIT');
    await settleFailover();
    expect(accountMocks.setCooldown).toHaveBeenCalled();
  });
});

describe('F-995: orquestrador / pane do operador bate o limite', () => {
  const sessionLimit = {
    kind: 'rate-limit' as const,
    reason: "You've hit your session limit",
    cooldownMs: 77 * 60 * 1000,
  };
  const exhaustedEntry = (usedRatio: number) => ({
    id: 'claude:account-a',
    adapterId: 'claude',
    accountId: 'account-a',
    label: 'Account A',
    installed: true,
    onCooldown: false,
    updatedAt: 100_000,
    windows: [
      {
        kind: 'hours' as const,
        label: '5 Horas',
        usedRatio,
        source: 'provider-api' as const,
        confidence: 'high' as const,
      },
    ],
  });

  /** Pane do operador adotado como orquestrador da missão da aba. */
  async function orchestratorLimit(
    paneNo: number,
    probe: { usedRatio: number } | null,
  ) {
    const { detectLimit } = await import('./limit-detector');
    vi.mocked(detectLimit).mockImplementationOnce((buffer: string) =>
      buffer.includes('LIMIT') ? sessionLimit : null,
    );
    const { requireQuotaService } = await import('../quota/quota-service');
    let probed = false;
    const snapshot = probe
      ? {
          updatedAt: 100_000,
          worstUsedRatio: probe.usedRatio,
          highUsageCount: 1,
          unknownCount: 0,
          entries: [exhaustedEntry(probe.usedRatio)],
        }
      : undefined;
    vi.mocked(requireQuotaService).mockImplementation(() => {
      if (!snapshot) throw new Error('quota indisponível');
      return {
        refreshForLimitHit: async () => {
          probed = true;
          return snapshot;
        },
        lastSnapshot: () => (probed ? snapshot : undefined),
      } as unknown as ReturnType<typeof requireQuotaService>;
    });
    const scope = testProjectScope();
    const owner = renderer(paneNo);
    renderers.push(owner);
    bindResolvedRendererWorkspaceScope(owner, scope);
    registerFailoverListener(owner);
    addPane({
      owner,
      paneId: 'pane-12502a80',
      sessionId: `pty-muyltibz-${paneNo}`,
      missionId: 'mission-23eee6e5',
      scope,
    });
    traceMocks.trace.mockClear();
    ptyMocks.dataTaps[0](`pty-muyltibz-${paneNo}`, 'LIMIT');
    await settleFailover();
    return owner;
  }

  afterEach(async () => {
    const { requireQuotaService } = await import('../quota/quota-service');
    vi.mocked(requireQuotaService).mockImplementation(() => {
      throw new Error('quota optional in test');
    });
  });

  it('limite CONFIRMADO: o Main religa o mesmo pane na outra conta, com pacote de continuidade, e só então emite o recibo', async () => {
    orchestratorSwitch.switch.mockImplementation(async () => ({
      handled: true,
      ok: true,
      sessionId: 'pty-religado',
    }));
    const owner = await orchestratorLimit(9690, { usedRatio: 1 });

    expect(orchestratorSwitch.switch).toHaveBeenCalledOnce();
    const input = orchestratorSwitch.switch.mock.calls[0]![0];
    expect(input).toMatchObject({
      missionId: 'mission-23eee6e5',
      paneId: 'pane-12502a80',
      sessionId: 'pty-muyltibz-9690',
      toAccountId: 'account-b',
    });
    const recap = input.buildRecap();
    expect(recap).toContain('[NEXUS FAILOVER HANDOFF]');
    expect(recap).toContain('mission-23eee6e5');
    expect(recap).toContain('integrando o harvest T3');
    expect(accountMocks.setCooldown).toHaveBeenCalledWith(
      'account-a',
      100_000 + 77 * 60 * 1000,
      "You've hit your session limit",
      undefined,
    );
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'pane-12502a80',
        switched: true,
        toAccountId: 'account-b',
        respawnedByMain: true,
      }),
    );
    expect(traceMocks.trace).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'account-failover',
        outcome: 'switched',
        respawn: 'main-orchestrator-recovery',
        toAccountId: 'account-b',
      }),
    );
    // Recibo da sessão nova: troca automática, não um pin qualquer.
    const { recordAccountChoiceReceipt, getAccountChoiceReceipt } = await import(
      '../persistence/account-choice-receipts'
    );
    recordAccountChoiceReceipt('pty-religado', {
      adapterId: 'claude', source: 'pinned', account: { label: 'r•••no', mode: 'subscription' },
      headroom: null, alternatives: [], decidedAt: 100_000,
    }, 'pane-12502a80');
    expect(getAccountChoiceReceipt('pty-religado')?.note).toContain('troca automática por limite confirmado');
  });

  it('religamento recusado: nada de "trocou" — o recibo diz que não se aplicou', async () => {
    orchestratorSwitch.switch.mockImplementation(async () => ({
      handled: true,
      ok: false,
      error: 'mission pane renderer is unavailable',
    }));
    const owner = await orchestratorLimit(9691, { usedRatio: 1 });

    expect(owner.send).not.toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({ switched: true }),
    );
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'pane-12502a80',
        switched: false,
        reason: expect.stringContaining('não se aplicou'),
      }),
    );
    expect(traceMocks.trace).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'account-failover', outcome: 'switch-respawn-failed' }),
    );
  });

  it('F-249 intacto: texto de limite sem confirmação do provider (citado) NÃO troca o orquestrador', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      orchestratorSwitch.switch.mockImplementation(async () => ({
        handled: true,
        ok: true,
        sessionId: 'pty-nao-deveria',
      }));
      const owner = await orchestratorLimit(9692, null);

      expect(orchestratorSwitch.switch).not.toHaveBeenCalled();
      expect(owner.send).not.toHaveBeenCalledWith(
        ACCOUNT_CHANNELS.failover,
        expect.objectContaining({ switched: true }),
      );
    } finally {
      log.mockRestore();
    }
  });
});
