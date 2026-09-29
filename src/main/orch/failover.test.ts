import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { ProjectExecutionScope } from '../../shared/types';
import { ACCOUNT_CHANNELS, type Account } from '../../shared/account-types';
import { testProjectScope } from './__tests__/scope-fixture';
import { pickAvailableForFailover } from '../persistence/account-store';

const ptyMocks = vi.hoisted(() => ({
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
  agentSessions: new Map<string, unknown>(),
  sessionStates: new Map<string, string>(),
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
}));

vi.mock('./pane-registry', () => ({
  stripAnsi: (data: string) => data,
  getOwnedPaneAuthzInfoBySession: vi.fn(
    (ref: string) => paneMocks.authorities.get(ref) ?? null,
  ),
  getPaneRuntimeAuthorityBySession: vi.fn(
    (ref: string) => paneMocks.runtimeAuthorities.get(ref) ?? null,
  ),
  findPaneBySessionOwnedBy: vi.fn(
    (_owner: WebContents, ref: string) => paneMocks.panes.get(ref) ?? null,
  ),
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
  initFailover,
  registerFailoverListener,
  requestSessionRecovery,
  resetInstantAuthDeaths,
  shutdownFailover,
  unregisterFailoverListener,
} from './failover';

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
}): void {
  const pane = {
    paneId: options.paneId,
    sessionId: options.sessionId,
    kind: 'cli-agent',
    adapterId: 'claude',
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
  paneMocks.authorities.clear();
  paneMocks.panes.clear();
  paneMocks.runtimeAuthorities.clear();
  accountMocks.setCooldown.mockClear();
  toolMocks.injectPrompt.mockClear();
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

  it('sonda sem resposta: a quarentena cai para 15 min, mas o pane ainda troca de conta', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const owner = await limitWithProbe(721, null, 0);
      expect(accountMocks.setCooldown).toHaveBeenCalledWith(
        'account-a',
        100_000 + 15 * 60 * 1000,
        "You've hit your session limit",
        undefined,
      );
      expect(owner.send).toHaveBeenCalledWith(
        ACCOUNT_CHANNELS.failover,
        expect.objectContaining({ paneId: 'pane-721', switched: true, toAccountId: 'account-b' }),
      );
      expect(log).toHaveBeenCalledWith(
        '[failover]',
        expect.stringContaining('long-cooldown-capped-without-provider-api'),
      );
    } finally {
      log.mockRestore();
    }
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

  it('reports the real rescheduled time and clears the promise when retries are exhausted', async () => {
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
    await vi.advanceTimersByTimeAsync(7 * 30_000);
    await settleFailover();
    expect(events().at(-1)?.switched).toBe(false);
    expect(events().at(-1)?.scheduledRetryAtMs).toBeUndefined();
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
