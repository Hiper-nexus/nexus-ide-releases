import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { ProjectExecutionScope } from '../../shared/types';
import { ACCOUNT_CHANNELS, type Account } from '../../shared/account-types';
import { testProjectScope } from './__tests__/scope-fixture';

const ptyMocks = vi.hoisted(() => ({
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
  agentSessions: new Map<string, unknown>(),
}));

const paneMocks = vi.hoisted(() => ({
  authorities: new Map<string, unknown>(),
  panes: new Map<string, unknown>(),
  runtimeAuthorities: new Map<string, unknown>(),
}));

const accountMocks = vi.hoisted(() => ({
  setCooldown: vi.fn(),
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
}): void {
  const pane = {
    paneId: options.paneId,
    sessionId: options.sessionId,
    kind: 'cli-agent',
    adapterId: 'claude',
    accountId: 'account-a',
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  ptyMocks.dataTaps.length = 0;
  ptyMocks.exitTaps.length = 0;
  ptyMocks.agentSessions.clear();
  paneMocks.authorities.clear();
  paneMocks.panes.clear();
  paneMocks.runtimeAuthorities.clear();
  accountMocks.setCooldown.mockClear();
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
  it('emits only to the exact pane owner across projects with colliding pane ids', () => {
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

  it('does not create a long quarantine from PTY text without fresh provider-api authority', async () => {
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
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const scope = testProjectScope();
      const owner = renderer(718);
      renderers.push(owner);
      bindResolvedRendererWorkspaceScope(owner, scope);
      registerFailoverListener(owner);
      addPane({
        owner,
        paneId: 'pane-718',
        sessionId: 'session-718',
        missionId: 'mission-718',
        scope,
      });

      ptyMocks.dataTaps[0]('session-718', 'LIMIT');

      expect(accountMocks.setCooldown).not.toHaveBeenCalled();
      expect(owner.send).not.toHaveBeenCalledWith(
        ACCOUNT_CHANNELS.failover,
        expect.anything(),
      );
      expect(log).toHaveBeenCalledWith(
        '[failover]',
        expect.stringContaining('provider-api-required-for-long-cooldown'),
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

  it('coalesces multi-pane bursts on the same exhausted account to one target', () => {
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

    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        switched: true,
        toAccountId: 'account-c',
        coalesced: false,
      }),
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
    expect(probeCall?.[3]).toEqual({ allowCoolingProbe: true });

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
    ptyMocks.exitTaps[0]!('sess-811');
    vi.advanceTimersByTime(120_000);

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
    expect(owner.send).toHaveBeenCalledWith(
      ACCOUNT_CHANNELS.failover,
      expect.objectContaining({
        paneId: 'pane-instant-1',
        switched: true,
        toAccountId: 'account-b',
      }),
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
    const fire = (n: number) => {
      addPane({
        owner,
        paneId: `pane-trip-${n}`,
        sessionId: `sess-trip-${n}`,
        scope,
      });
      ptyMocks.dataTaps[0]!(`sess-trip-${n}`, 'LIMIT 401');
    };
    fire(1);
    fire(2);
    // 3ª morte seguida: trava de novo E emite de novo (sem janela muda —
    // o toast deduplica no lugar, mas o pane nunca morre em silêncio).
    fire(3);
    const trips = owner.send.mock.calls.filter(
      (c) =>
        c[0] === ACCOUNT_CHANNELS.failover &&
        (c[1] as { switched?: boolean }).switched === false,
    );
    expect(trips).toHaveLength(2);
    // Re-login: a contagem antiga não vale contra a credencial nova.
    resetInstantAuthDeaths('claude');
    owner.send.mockClear();
    fire(4);
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

