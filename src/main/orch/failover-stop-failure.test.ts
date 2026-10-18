/**
 * F-1484: o StopFailure `rate_limit` do Claude chega ao failover como limite
 * CONFIRMADO — hook real (agent-status) → barramento real (observer-bus) →
 * redutor real (failover-analysis-fixture) → failover real. Cobre a ordem
 * real (o texto do PTY chega ANTES do hook), leitura de cota em cache que não
 * pode refutar o provedor, o reset real da janela e o escopo. Texto citado num
 * turno ativo continua sem trocar (F-249). Pane do renderer fora de missão (a
 * troca de pane de missão viva é a reabertura do F-1471). Harness enxuto do failover.test.ts,
 * com o limit-detector e o agent-status reais.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { CanonicalHookEvent } from '../../vendor/emdash/hooks/hooks-types';
import type { QuotaFleetSnapshot } from '../../shared/quota-types';
import { ACCOUNT_CHANNELS, type Account } from '../../shared/account-types';
import { testProjectScope } from './__tests__/scope-fixture';

const ptyMocks = vi.hoisted(() => ({
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
}));
const paneMocks = vi.hoisted(() => ({
  authorities: new Map<string, unknown>(),
  panes: new Map<string, unknown>(),
}));
const accountMocks = vi.hoisted(() => {
  /** Cooldown GLOBAL vigente por conta, last-write-wins como o account-store. */
  const cooldowns = new Map<string, number>();
  return {
  cooldowns,
  /** false = nenhuma irmã livre agora (performSwitch agenda a espera). */
  siblingFree: true,
  setCooldown: vi.fn((id: string, until: number, _reason: string, scope?: string) => {
    if (!scope) cooldowns.set(id, until);
  }),
  /** F-1489: a sonda velha nunca pode apagar o cooldown confirmado. */
  clearCooldown: vi.fn((id: string) => {
    cooldowns.delete(id);
  }),
  current: {
    id: 'account-a', adapterId: 'claude', label: 'Account A', mode: 'subscription' as const,
    upstream: 'anthropic', createdAt: 0,
  },
  next: {
    id: 'account-b', adapterId: 'claude', label: 'Account B', mode: 'subscription' as const,
    upstream: 'anthropic', createdAt: 1,
  } as Account,
  };
});
/** Serviço de cota: sem leitura por padrão; cada teste troca o comportamento. */
const quotaMocks = vi.hoisted(() => ({
  service: null as null | {
    lastSnapshot: () => QuotaFleetSnapshot | null;
    refreshForLimitHit: (hitAt: number) => Promise<QuotaFleetSnapshot>;
  },
}));
const traceMocks = vi.hoisted(() => ({ trace: vi.fn() }));

vi.mock('./tool-util', () => ({ injectPrompt: vi.fn(async () => undefined) }));
vi.mock('../pty/pty-analysis-runtime', async () => {
  const { failoverAnalysisFixture } = await import('../pty/__tests__/failover-analysis-fixture');
  return failoverAnalysisFixture(ptyMocks.dataTaps);
});
vi.mock('../pty/pty-manager', () => ({
  tapSessionData: vi.fn((tap: (sessionId: string, data: string) => void) => {
    ptyMocks.dataTaps.push(tap);
    return () => ptyMocks.dataTaps.splice(ptyMocks.dataTaps.indexOf(tap), 1);
  }),
  tapSessionExit: vi.fn((tap: (sessionId: string) => void) => {
    ptyMocks.exitTaps.push(tap);
    return () => ptyMocks.exitTaps.splice(ptyMocks.exitTaps.indexOf(tap), 1);
  }),
  getAgentSessionInfo: vi.fn((sessionId: string) =>
    sessionId === 'session-a' ? { sessionId, adapterId: 'claude', accountId: 'account-a' } : null),
  getSessionState: vi.fn(() => 'idle'),
  isOneShotSessionRunning: vi.fn(() => false),
  publishSessionActivityState: vi.fn(() => true),
  isPtySessionAdmissionSealedForShutdown: vi.fn(() => false),
}));
vi.mock('./failover-orchestrator-respawn', () => ({
  switchRendererOrchestratorAccount: vi.fn(async () => ({ handled: false })),
}));
vi.mock('./pane-registry', () => ({
  stripAnsi: (data: string) => data,
  readSessionOutput: vi.fn(() => ''),
  listPaneSnapshots: vi.fn(() => []),
  getOwnedPaneAuthzInfoBySession: vi.fn((ref: string) => paneMocks.authorities.get(ref) ?? null),
  getPaneRuntimeAuthorityBySession: vi.fn(() => null),
  findPaneBySessionOwnedBy: vi.fn((_owner: WebContents, ref: string) => paneMocks.panes.get(ref) ?? null),
}));
vi.mock('../observability/main-trace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../observability/main-trace')>()),
  trace: traceMocks.trace,
}));
vi.mock('../persistence/account-store', () => ({
  getAccount: vi.fn((id: string) => {
    const account = id === accountMocks.current.id ? accountMocks.current : id === accountMocks.next.id ? accountMocks.next : null;
    return account ? { ...account, cooldownUntil: accountMocks.cooldowns.get(id) } : null;
  }),
  getActiveAccount: vi.fn(() => accountMocks.current),
  pickAvailable: vi.fn(() => accountMocks.next),
  pickAvailableForFailover: vi.fn((_adapterId: string, excludeId: string | null) => ({
    account: accountMocks.siblingFree && accountMocks.next.id !== excludeId ? accountMocks.next : null,
    probe: false,
  })),
  adoptNativeAccountForFailover: vi.fn(() => null),
  ensureFreshClaudeSubscription: vi.fn(async () => false),
  isAccountBlockedForScope: vi.fn(() => false),
  setCooldown: accountMocks.setCooldown,
  clearCooldown: accountMocks.clearCooldown,
  prepareAccountForSpawn: vi.fn((_adapterId: string, id: string) => ({
    ok: true as const,
    account: id === accountMocks.next.id ? accountMocks.next : accountMocks.current,
    apiKey: null,
    authEnv: {},
  })),
  verifyManagedClaudeAccountForSpawn: vi.fn(async (_id: string, onVerified?: (blob: string) => void) => {
    onVerified?.('verified-claude-blob');
    return 'match';
  }),
}));
vi.mock('../quota/quota-service', () => ({
  noteQuotaLimitHit: vi.fn(),
  requireQuotaService: vi.fn(() => {
    if (!quotaMocks.service) throw new Error('quota optional in test');
    return quotaMocks.service;
  }),
}));

import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import {
  initFailover,
  registerFailoverListener,
  resetInstantAuthDeaths,
  shutdownFailover,
  unregisterFailoverListener,
} from './failover';
import {
  __resetAgentStatusForTests,
  applyCanonicalHookEvent,
  STOP_FAILURE_AUTH_COOLDOWN_MS,
  STOP_FAILURE_AUTH_REASON,
  STOP_FAILURE_RATE_LIMIT_COOLDOWN_MS,
} from './agent-status';
import { switchRendererOrchestratorAccount } from './failover-orchestrator-respawn';
import { __resetObserverBusForTests } from './observer-bus';

type Renderer = WebContents & EventEmitter & { send: ReturnType<typeof vi.fn> };

const T0 = 100_000;
let owner: Renderer;

function renderer(): Renderer {
  const events = new EventEmitter() as Renderer;
  Object.assign(events, { id: 1484, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() });
  return events;
}

async function settleFailover(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

function hook(event: CanonicalHookEvent): void {
  applyCanonicalHookEvent({ sessionId: 'session-a', event, now: Date.now() });
}

const stopFailure = () => hook({ kind: 'status', type: 'stop', stopFailure: 'rate_limit' });

/** O Claude imprime o limite no PTY; o hook só posta depois. */
function ptyLimitText(): void {
  for (const tap of [...ptyMocks.dataTaps]) tap('session-a', "\nYou've hit your usage limit\nusage limit reached\n");
}

function failoverEvents(): Array<Record<string, unknown>> {
  return owner.send.mock.calls
    .filter(([channel]) => channel === ACCOUNT_CHANNELS.failover)
    .map(([, payload]) => payload as Record<string, unknown>);
}

function cooldownReasons(): string[] {
  return accountMocks.setCooldown.mock.calls.map((call) => String(call[2]));
}

function snapshot(updatedAt: number, windows: QuotaFleetSnapshot['entries'][number]['windows']): QuotaFleetSnapshot {
  return {
    updatedAt,
    worstUsedRatio: null,
    highUsageCount: 0,
    unknownCount: 0,
    entries: [{
      id: 'claude:account-a', adapterId: 'claude', accountId: 'account-a', label: 'Claude · A',
      installed: true, onCooldown: false, updatedAt, windows,
    }],
  } as QuotaFleetSnapshot;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  __resetAgentStatusForTests();
  __resetObserverBusForTests();
  ptyMocks.dataTaps.length = 0;
  ptyMocks.exitTaps.length = 0;
  paneMocks.authorities.clear();
  paneMocks.panes.clear();
  accountMocks.setCooldown.mockClear();
  accountMocks.clearCooldown.mockClear();
  accountMocks.cooldowns.clear();
  accountMocks.siblingFree = true;
  traceMocks.trace.mockClear();
  quotaMocks.service = null;
  const scope = testProjectScope();
  owner = renderer();
  bindResolvedRendererWorkspaceScope(owner, scope);
  registerFailoverListener(owner);
  const pane = { paneId: 'pane-a', sessionId: 'session-a', kind: 'cli-agent', adapterId: 'claude', accountId: 'account-a' };
  paneMocks.panes.set('session-a', pane);
  paneMocks.authorities.set('session-a', { owner, ...pane, scope });
  initFailover();
  hook({ kind: 'status', type: 'start', promptSubmitted: true, clearsAwaitingInput: true });
});

afterEach(() => {
  unregisterFailoverListener(owner);
  clearRendererWorkspaceScope(owner);
  shutdownFailover();
  vi.useRealTimers();
});

describe('F-1484: StopFailure rate_limit troca de conta na hora', () => {
  it('o limite dito pelo próprio provedor troca sem sonda e sem a pausa de 15 min', async () => {
    stopFailure();
    await settleFailover();
    expect(failoverEvents()).toEqual([
      expect.objectContaining({ paneId: 'pane-a', switched: true, toAccountId: 'account-b' }),
    ]);
    // Sem leitura de cota: a conta exausta sai do pool pelo teto curto (anticascata).
    expect(accountMocks.setCooldown).toHaveBeenCalledWith(
      'account-a', T0 + STOP_FAILURE_RATE_LIMIT_COOLDOWN_MS, expect.any(String), undefined,
    );
    expect(cooldownReasons().join(' ')).not.toContain('não confirmado');
    // StopFailure não traz modelo/tier: bloqueio da conta inteira, registrado.
    expect(traceMocks.trace).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider-stop-failure-limit', sessionId: 'session-a', adapterId: 'claude', scope: 'account',
    }));
  });

  it.each([50, 200, 500])('ordem real: texto do PTY primeiro, StopFailure %i ms depois → troca já', async (delayMs) => {
    ptyLimitText();
    await settleFailover();
    // Sem leitura de cota, o texto sozinho pausa 15 min sem trocar (F-249).
    expect(failoverEvents()).toEqual([expect.objectContaining({ switched: false })]);
    expect(cooldownReasons()).toEqual([expect.stringContaining('não confirmado')]);

    vi.setSystemTime(T0 + delayMs);
    stopFailure();
    await settleFailover();

    expect(failoverEvents().at(-1)).toEqual(
      expect.objectContaining({ paneId: 'pane-a', switched: true, toAccountId: 'account-b' }),
    );
    expect(accountMocks.setCooldown).toHaveBeenLastCalledWith(
      'account-a', T0 + delayMs + STOP_FAILURE_RATE_LIMIT_COOLDOWN_MS, expect.any(String), undefined,
    );
    // A re-sondagem da pausa foi cancelada: nada mais acontece em 20 min.
    const events = failoverEvents().length;
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(failoverEvents()).toHaveLength(events);
  });

  it.each([
    ['200 ms depois', 200, false],
    ['no mesmo ms', 0, false],
    ['200 ms depois, com a sessão já encerrada pela troca', 200, true],
  ])('sonda do texto em voo, confirmação %s: a sonda velha não pausa, não agenda nem troca', async (_label, delayMs, exited) => {
    let release!: (snap: QuotaFleetSnapshot) => void;
    const probe = new Promise<QuotaFleetSnapshot>((resolve) => { release = resolve; });
    quotaMocks.service = { lastSnapshot: () => null, refreshForLimitHit: () => probe };
    ptyLimitText();
    await settleFailover();
    expect(failoverEvents()).toEqual([]);

    vi.setSystemTime(T0 + delayMs);
    stopFailure();
    await settleFailover();
    expect(failoverEvents()).toEqual([expect.objectContaining({ switched: true, toAccountId: 'account-b' })]);
    const cooldownsAfterSwitch = accountMocks.setCooldown.mock.calls.length;
    if (exited) for (const tap of [...ptyMocks.exitTaps]) tap('session-a');

    // A sonda do texto termina sem dados: nada de pausa, retry ou 2ª troca.
    release(snapshot(T0 + 300, []));
    await settleFailover();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(failoverEvents()).toHaveLength(1);
    expect(accountMocks.setCooldown.mock.calls.length).toBe(cooldownsAfterSwitch);
    expect(cooldownReasons().join(' ')).not.toContain('não confirmado');
  });

  /** Fins de cooldown GLOBAL gravados na conta exausta, em ordem. */
  function accountACooldowns(): number[] {
    return accountMocks.setCooldown.mock.calls
      .filter((call) => call[0] === 'account-a' && call[3] === undefined)
      .map((call) => Number(call[1]));
  }
  function expectNeverShrinks(): void {
    const ends = accountACooldowns();
    for (let i = 1; i < ends.length; i += 1) expect(ends[i]).toBeGreaterThanOrEqual(ends[i - 1]!);
  }

  it.each([
    ['(a) leitura fresca da API ≥ 0,8 confirma o texto', 'fresh'],
    ['(b) reset no texto < 60 min dispensa a sonda', 'short'],
    ['(c) a sonda confirma antes do POST do hook', 'probe'],
  ])('texto já comitou %s: o StopFailure não troca de novo nem encurta o cooldown', async (_label, mode) => {
    const exhausted = (at: number) => snapshot(at, [
      { kind: 'hours', label: '5 Horas', usedRatio: mode === 'fresh' ? 0.9 : 1, resetsAt: T0 + 2 * 60 * 60_000,
        source: 'provider-api', confidence: 'high' },
    ]);
    if (mode === 'fresh') {
      quotaMocks.service = { lastSnapshot: () => exhausted(T0 - 60_000), refreshForLimitHit: async () => exhausted(T0 + 100) };
    } else if (mode === 'probe') {
      let last: QuotaFleetSnapshot | null = null;
      quotaMocks.service = {
        lastSnapshot: () => last,
        refreshForLimitHit: async (hitAt) => { last = exhausted(hitAt); return last; },
      };
    }
    if (mode === 'short') {
      for (const tap of [...ptyMocks.dataTaps]) tap('session-a', '\nusage limit reached — try again in 12 minutes\n');
    } else {
      ptyLimitText();
    }
    await settleFailover();
    // O texto comitou na hora: uma troca.
    expect(failoverEvents()).toEqual([expect.objectContaining({ switched: true, toAccountId: 'account-b' })]);
    const committedUntil = accountMocks.cooldowns.get('account-a')!;
    expect(committedUntil).toBeGreaterThan(T0);

    vi.setSystemTime(T0 + 300);
    stopFailure();
    await settleFailover();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(failoverEvents()).toHaveLength(1);
    expect(accountMocks.cooldowns.get('account-a')!).toBeGreaterThanOrEqual(committedUntil);
    // Teto curto confirmado vale só se for maior que o do texto.
    expect(accountMocks.cooldowns.get('account-a')!).toBeGreaterThanOrEqual(T0 + 300 + STOP_FAILURE_RATE_LIMIT_COOLDOWN_MS);
    expectNeverShrinks();
  });

  it('leitura de cota em cache (sadia, de antes do hit) não refuta o provedor', async () => {
    // Sessão a 20% e semanal a 95% lidas 5 min antes; o turno estourou agora.
    const cached = snapshot(T0 - 5 * 60_000, [
      { kind: 'session', label: 'Sessão', usedRatio: 0.2, source: 'provider-api', confidence: 'high' },
      { kind: 'weekly', label: 'Semanal', usedRatio: 0.95, source: 'provider-api', confidence: 'high' },
    ]);
    quotaMocks.service = { lastSnapshot: () => cached, refreshForLimitHit: async () => cached };
    stopFailure();
    await settleFailover();
    expect(failoverEvents()).toEqual([expect.objectContaining({ switched: true, toAccountId: 'account-b' })]);
  });

  it('com a API acessível, o cooldown vai até o reset real da janela que estourou (não 15 min)', async () => {
    const resetsAt = T0 + 3 * 60 * 60_000;
    quotaMocks.service = {
      lastSnapshot: () => null,
      refreshForLimitHit: async () => snapshot(T0 + 1_000, [
        { kind: 'hours', label: '5 Horas', usedRatio: 1, resetsAt, source: 'provider-api', confidence: 'high' },
        { kind: 'weekly', label: 'Semanal', usedRatio: 0.4, resetsAt: T0 + 4 * 86_400_000, source: 'provider-api', confidence: 'high' },
      ]),
    };
    stopFailure();
    await settleFailover();
    expect(failoverEvents()).toEqual([expect.objectContaining({ switched: true, toAccountId: 'account-b' })]);
    expect(accountMocks.setCooldown).toHaveBeenLastCalledWith('account-a', resetsAt, expect.any(String), undefined);
  });

  it('limite citado em turno ativo (sem StopFailure) continua sem trocar', async () => {
    const quoted = "o worker leu no log: You've hit your session limit · resets 8pm (rate_limit)";
    hook({ kind: 'status', type: 'start', message: quoted });
    hook({ kind: 'status', type: 'notification', notificationType: 'idle_prompt', message: quoted });
    hook({ kind: 'status', type: 'stop', lastAssistantMessage: quoted });
    await settleFailover();

    expect(failoverEvents()).toEqual([]);
    expect(accountMocks.setCooldown).not.toHaveBeenCalled();
  });

  it('StopFailure de outra categoria não é limite de uso: nada troca', async () => {
    hook({ kind: 'status', type: 'stop', stopFailure: 'other' });
    await settleFailover();

    expect(failoverEvents()).toEqual([]);
    expect(accountMocks.setCooldown).not.toHaveBeenCalled();
  });

  it('commit antigo não engole o limite de um TURNO NOVO: sem irmã agenda espera; 11 min depois troca', async () => {
    accountMocks.siblingFree = false;
    stopFailure();
    await settleFailover();
    expect(failoverEvents().filter((event) => event.switched === true)).toEqual([]);

    vi.setSystemTime(T0 + 11 * 60_000);
    accountMocks.siblingFree = true;
    hook({ kind: 'status', type: 'start', promptSubmitted: true, clearsAwaitingInput: true });
    stopFailure();
    await settleFailover();
    expect(failoverEvents().filter((event) => event.switched === true)).toEqual([
      expect.objectContaining({ paneId: 'pane-a', toAccountId: 'account-b' }),
    ]);
  });

  it('pausa NÃO confirmada nunca grava cooldown menor que o vigente', async () => {
    accountMocks.cooldowns.set('account-a', T0 + 5 * 60 * 60_000);
    ptyLimitText();
    await settleFailover();
    expect(cooldownReasons()).toEqual([expect.stringContaining('não confirmado')]);
    expect(accountMocks.cooldowns.get('account-a')).toBe(T0 + 5 * 60 * 60_000);
  });

  it('sonda pendente: a poda do marcador (outra sessão comita 11 min depois) não reabre a corrida', async () => {
    let release!: (snap: QuotaFleetSnapshot) => void;
    const probe = new Promise<QuotaFleetSnapshot>((resolve) => { release = resolve; });
    quotaMocks.service = { lastSnapshot: () => null, refreshForLimitHit: () => probe };
    ptyLimitText();
    await settleFailover();
    // Confirmação no mesmo ms do texto: só o marcador de commit separa os dois.
    stopFailure();
    await settleFailover();
    const paneAEvents = () => failoverEvents().filter((event) => event.paneId === 'pane-a');
    expect(paneAEvents()).toEqual([expect.objectContaining({ switched: true, toAccountId: 'account-b' })]);
    const cooldownAfterSwitch = accountMocks.cooldowns.get('account-a')!;

    // Outra sessão comita um limite 11 min depois (o marcador de A seria podado).
    const scope = testProjectScope();
    const paneB = { paneId: 'pane-b', sessionId: 'session-b', kind: 'cli-agent', adapterId: 'claude', accountId: 'account-b' };
    paneMocks.panes.set('session-b', paneB);
    paneMocks.authorities.set('session-b', { owner, ...paneB, scope });
    vi.setSystemTime(T0 + 11 * 60_000);
    applyCanonicalHookEvent({ sessionId: 'session-b', event: { kind: 'status', type: 'stop', stopFailure: 'rate_limit' },
      now: Date.now() });
    await settleFailover();

    // A sonda antiga de A volta sem dados: não pausa, não agenda, não troca, não encolhe.
    release(snapshot(T0 + 11 * 60_000, []));
    await settleFailover();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(paneAEvents()).toHaveLength(1);
    expect(cooldownReasons().join(' ')).not.toContain('não confirmado');
    expect(accountMocks.cooldowns.get('account-a')).toBeGreaterThanOrEqual(cooldownAfterSwitch);
  });
  it.each([
    ['a sonda volta sadia: não apaga o cooldown confirmado', 'healthy'],
    ['a sonda volta sem dados: não troca de novo', 'empty'],
  ] as const)('F-1489: retry da pausa em voo quando o StopFailure assume — %s', async (_label, outcome) => {
    ptyLimitText();
    await settleFailover();
    expect(failoverEvents()).toEqual([expect.objectContaining({ switched: false })]);

    // Fim da pausa de 15 min: o retry re-sonda, e a sonda fica em voo.
    let release!: (snap: QuotaFleetSnapshot) => void;
    let latest: QuotaFleetSnapshot | null = null;
    const probe = new Promise<QuotaFleetSnapshot>((resolve) => { release = resolve; }).then((snap) => {
      latest = snap;
      return snap;
    });
    quotaMocks.service = { lastSnapshot: () => latest, refreshForLimitHit: () => probe };
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
    await settleFailover();

    // O provedor confirma o limite enquanto a sonda velha não volta.
    stopFailure();
    await settleFailover();
    const switched = () => failoverEvents().filter((event) => event.switched === true);
    expect(switched()).toEqual([expect.objectContaining({ paneId: 'pane-a', toAccountId: 'account-b' })]);
    const confirmedUntil = accountMocks.cooldowns.get('account-a')!;
    expect(confirmedUntil).toBeGreaterThan(Date.now());

    release(outcome === 'healthy'
      ? snapshot(Date.now() + 1, [
          { kind: 'session', label: 'Sessão', usedRatio: 0.1, source: 'provider-api', confidence: 'high' },
          { kind: 'hours', label: '5 Horas', usedRatio: 0.1, source: 'provider-api', confidence: 'high' },
          { kind: 'weekly', label: 'Semanal', usedRatio: 0.1, source: 'provider-api', confidence: 'high' },
        ])
      : snapshot(Date.now() + 1, []));
    await settleFailover();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(switched()).toHaveLength(1);
    expect(accountMocks.clearCooldown).not.toHaveBeenCalled();
    expect(accountMocks.cooldowns.get('account-a')).toBeGreaterThanOrEqual(confirmedUntil);
  });
});

/**
 * F-1569: Maestro em conta Claude gerenciada, 18/10 18:32 — a CLI 2.1.302
 * imprimiu "● Login expired · Please run /login" e disparou StopFailure
 * `authentication_failed`. Nenhum dos dois sinais chegava ao failover: o pane
 * parou e o operador rodou /login à mão. Com outra conta pronta, o Main religa
 * o MESMO pane na conta irmã (F-995) levando a conversa (resume nativo).
 */
describe('F-1569: login expirado do Claude no Maestro', () => {
  const orchestratorSwitch = vi.mocked(switchRendererOrchestratorAccount);

  beforeEach(() => {
    resetInstantAuthDeaths('claude');
    orchestratorSwitch.mockReset();
    orchestratorSwitch.mockImplementation(async () => ({ handled: true, ok: true, sessionId: 'session-a2' }));
    const pane = { paneId: 'pane-a', sessionId: 'session-a', kind: 'cli-agent', adapterId: 'claude', accountId: 'account-a' };
    paneMocks.authorities.set('session-a', { owner, ...pane, missionId: 'mission-maestro', scope: testProjectScope() });
  });

  afterEach(() => {
    orchestratorSwitch.mockReset();
    orchestratorSwitch.mockImplementation(async () => ({ handled: false }));
  });

  function expectMaestroSwitchedWithResume(): void {
    expect(orchestratorSwitch).toHaveBeenCalledOnce();
    const input = orchestratorSwitch.mock.calls[0]![0];
    expect(input).toMatchObject({
      missionId: 'mission-maestro', paneId: 'pane-a', sessionId: 'session-a', toAccountId: 'account-b',
    });
    expect(input.buildResumeNote).toBeTypeOf('function');
    expect(failoverEvents()).toEqual([
      expect.objectContaining({
        paneId: 'pane-a', kind: 'auth', switched: true, toAccountId: 'account-b', respawnedByMain: true,
      }),
    ]);
  }

  it('StopFailure auth troca a conta do Maestro na hora; leitura de cota em cache não refuta a CLI', async () => {
    const cached = snapshot(T0 - 60_000, [
      { kind: 'session', label: 'Sessão', usedRatio: 0.1, source: 'provider-api', confidence: 'high' },
    ]);
    quotaMocks.service = { lastSnapshot: () => cached, refreshForLimitHit: async () => cached };
    hook({ kind: 'status', type: 'stop', stopFailure: 'auth' });
    await settleFailover();

    expectMaestroSwitchedWithResume();
    expect(accountMocks.setCooldown).toHaveBeenCalledWith(
      'account-a', T0 + STOP_FAILURE_AUTH_COOLDOWN_MS, STOP_FAILURE_AUTH_REASON, undefined,
    );
    expect(traceMocks.trace).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'suppressed' }));
  });

  it('o texto "● Login expired · Please run /login" no PTY do Maestro também troca', async () => {
    for (const tap of [...ptyMocks.dataTaps]) tap('session-a', '\n● Login expired · Please run /login\n');
    await settleFailover();

    expectMaestroSwitchedWithResume();
  });

  it('sem conta pronta: aviso claro de auth, sem troca e sem religar o pane', async () => {
    accountMocks.siblingFree = false;
    hook({ kind: 'status', type: 'stop', stopFailure: 'auth' });
    await settleFailover();

    expect(orchestratorSwitch).not.toHaveBeenCalled();
    expect(failoverEvents()).toEqual([
      expect.objectContaining({
        paneId: 'pane-a', kind: 'auth', switched: false, reason: expect.stringContaining(STOP_FAILURE_AUTH_REASON),
      }),
    ]);
  });
});
