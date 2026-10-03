/**
 * F-765: pane com modelo recusado pelo provedor se recupera sozinho. O Main
 * pede o religamento, prova que ele existiu e só então emite o recibo
 * (`switched:true`); pane de missão — que o renderer não religa — tem a
 * tarefa reaberta pela rota do spawn; sem saída, avisa sem mentir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { ProjectExecutionScope } from '../../shared/types';
import { ACCOUNT_CHANNELS, type FailoverEvent } from '../../shared/account-types';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  sessions: new Map<string, Record<string, unknown>>(),
  states: new Map<string, string>(),
  authorities: new Map<string, unknown>(),
  panes: new Map<string, unknown>(),
  runtime: new Map<string, unknown>(),
  requestPaneClose: vi.fn(async (_paneId: string, _sessionId?: string) => true),
  respawnMainOwned: vi.fn(async (_input: Record<string, unknown>) => true),
  submit: vi.fn((input: Record<string, unknown>) => ({ id: 'handoff-1', ...input })),
  onHandoffSubmitted: vi.fn(),
  trace: vi.fn(),
  binPaths: new Map<string, string>(),
}));

vi.mock('../pty/pty-manager', () => ({
  tapSessionData: vi.fn((tap: (sessionId: string, data: string) => void) => {
    h.dataTaps.push(tap);
    return () => h.dataTaps.splice(h.dataTaps.indexOf(tap), 1);
  }),
  tapSessionExit: vi.fn(() => () => undefined),
  getAgentSessionInfo: vi.fn((sessionId: string) => h.sessions.get(sessionId) ?? null),
  getSessionState: vi.fn((sessionId: string) => h.states.get(sessionId) ?? null),
  listAgentSessionsForPane: vi.fn((paneId: string) =>
    [...h.sessions.values()].filter((session) => session.paneId === paneId),
  ),
}));
vi.mock('./pane-registry', () => ({
  stripAnsi: (data: string) => data,
  getOwnedPaneAuthzInfoBySession: vi.fn((ref: string) => h.authorities.get(ref) ?? null),
  getPaneRuntimeAuthorityBySession: vi.fn((ref: string) => h.runtime.get(ref) ?? null),
  findPaneBySessionOwnedBy: vi.fn((_owner: WebContents, ref: string) => h.panes.get(ref) ?? null),
  requestPaneClose: h.requestPaneClose,
}));
vi.mock('./tool-util', () => ({ injectPrompt: vi.fn() }));
vi.mock('../observability/main-trace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../observability/main-trace')>()),
  trace: h.trace,
}));
const MODEL_HIT = {
  kind: 'model' as const,
  reason: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account",
  cooldownMs: 300_000,
  adapterId: 'codex',
};
vi.mock('./limit-detector', () => ({
  detectLimit: vi.fn((buffer: string) => (buffer.includes('MODEL_REFUSED') ? MODEL_HIT : null)),
  tierScopeFromModelId: vi.fn(() => undefined),
}));
const codexAccount = {
  id: 'codex-a',
  adapterId: 'codex',
  label: 'Conta Codex',
  mode: 'subscription' as const,
  upstream: 'openai',
  createdAt: 0,
};
vi.mock('../persistence/account-store', () => ({
  getAccount: vi.fn((id: string) => (id === codexAccount.id ? codexAccount : null)),
  getActiveAccount: vi.fn((adapterId: string) => (adapterId === 'codex' ? codexAccount : null)),
  pickAvailableForFailover: vi.fn(() => ({ account: null, probe: false })),
  adoptNativeAccountForFailover: vi.fn(() => null),
  ensureFreshClaudeSubscription: vi.fn(async () => false),
  isAccountBlockedForScope: vi.fn(() => false),
  hasAvailableAccount: vi.fn(() => true),
  setCooldown: vi.fn(),
  clearCooldown: vi.fn(),
  prepareAccountForSpawn: vi.fn(() => ({ ok: false, error: 'not in test' })),
  verifyManagedClaudeAccountForSpawn: vi.fn(async () => 'match'),
}));
vi.mock('../quota/quota-service', () => ({
  noteQuotaLimitHit: vi.fn(),
  requireQuotaService: vi.fn(() => {
    throw new Error('quota optional in test');
  }),
}));
vi.mock('./failover-mission-respawn', () => ({
  respawnMainOwnedPaneWithAccount: h.respawnMainOwned,
}));
vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({ handoffs: { submit: h.submit } }),
}));
vi.mock('./idle-delivery', () => ({ onHandoffSubmitted: h.onHandoffSubmitted }));
const CODEX_MODELS = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra'];
vi.mock('../adapters/adapter-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/adapter-registry')>()),
  getAdapter: vi.fn((id: string) =>
    id === 'codex' ? { id: 'codex', models: { default: 'gpt-6.1-sol', list: CODEX_MODELS } } : null,
  ),
  getAdapterResolvedBin: vi.fn((id: string) => h.binPaths.get(id) ?? null),
}));
vi.mock('../adapters/model-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/model-catalog')>()),
  loadModelCatalog: () => ({ adapters: {} }),
}));

import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import {
  initFailover,
  registerFailoverListener,
  shutdownFailover,
  unregisterFailoverListener,
} from './failover';
import {
  modelAccessQuarantine,
  resetModelAccessQuarantineForTests,
} from './model-access-quarantine';
import {
  registerPaneTaskReroute,
  resetPaneTaskReroutesForTests,
  type PaneTaskRerouteHandle,
} from './pane-task-reroute';
import {
  getPaneStartWatch,
  resetPaneStartWatchdogForTests,
  trackPaneStart,
} from './pane-start-watchdog';

type Renderer = WebContents & EventEmitter & { send: ReturnType<typeof vi.fn> };

function renderer(id: number): Renderer {
  const events = new EventEmitter() as Renderer;
  Object.assign(events, { id, isDestroyed: () => false, isCrashed: () => false, send: vi.fn() });
  return events;
}

const SCOPE: ProjectExecutionScope = testProjectScope();
let owner: Renderer;

/** Pane Codex no renderer: sem missão (o renderer religa) ou de missão. */
function codexPane(input: {
  paneId?: string;
  sessionId?: string;
  missionId?: string;
  role?: 'worker' | 'orchestrator' | 'user';
} = {}): void {
  const paneId = input.paneId ?? 'pane-codex';
  const sessionId = input.sessionId ?? 'session-codex';
  const pane = { paneId, sessionId, kind: 'cli-agent', adapterId: 'codex', accountId: 'codex-a' };
  h.panes.set(sessionId, pane);
  h.authorities.set(sessionId, { owner, ...pane, missionId: input.missionId, scope: SCOPE });
  h.sessions.set(sessionId, {
    sessionId,
    paneId,
    adapterId: 'codex',
    model: 'gpt-6.1-sol',
    role: input.role ?? (input.missionId ? 'worker' : 'user'),
    ...(input.missionId ? { missionId: input.missionId } : {}),
  });
  h.states.set(sessionId, 'idle');
}

function events(): FailoverEvent[] {
  return owner.send.mock.calls
    .filter(([channel]) => channel === ACCOUNT_CHANNELS.failover)
    .map(([, event]) => event as FailoverEvent);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await Promise.resolve();
}

function handle(overrides: Partial<PaneTaskRerouteHandle> = {}): PaneTaskRerouteHandle {
  return {
    paneId: 'pane-codex',
    adapterId: 'codex',
    missionId: 'mission-1',
    role: 'worker',
    callerSessionId: 'session-maestro',
    routeTask: 'implementar o login',
    lineageId: 'pane-codex',
    operatorOpened: false,
    pinnedRuntime: false,
    generation: 0,
    reroute: vi.fn(async () => ({ paneId: 'pane-novo', adapterId: 'codex' })),
    hasAlternative: vi.fn(() => true),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  h.dataTaps.length = 0;
  h.sessions.clear();
  h.states.clear();
  h.authorities.clear();
  h.panes.clear();
  h.runtime.clear();
  h.binPaths.clear();
  h.requestPaneClose.mockClear().mockResolvedValue(true);
  h.respawnMainOwned.mockClear().mockResolvedValue(true);
  h.submit.mockClear();
  h.onHandoffSubmitted.mockClear();
  h.trace.mockClear();
  resetModelAccessQuarantineForTests();
  resetPaneTaskReroutesForTests();
  resetPaneStartWatchdogForTests();
  owner = renderer(41);
  bindResolvedRendererWorkspaceScope(owner, SCOPE);
  registerFailoverListener(owner);
  initFailover();
});

afterEach(() => {
  unregisterFailoverListener(owner);
  clearRendererWorkspaceScope(owner);
  shutdownFailover();
  resetPaneStartWatchdogForTests();
  vi.useRealTimers();
});

describe('F-765: pane fora de missão — o renderer religa e o Main prova', () => {
  it('default recusado com outro modelo elegível: pede a troca e só anuncia depois do pane novo', async () => {
    codexPane();
    h.dataTaps[0]('session-codex', 'MODEL_REFUSED');
    await settle();

    // O default (gpt-6.1-sol) foi o recusado: a alternativa vem da rota da CLI.
    expect(events()).toEqual([
      expect.objectContaining({
        paneId: 'pane-codex',
        kind: 'model',
        toModel: 'gpt-6-sol',
        switched: false,
        modelRotationPhase: 'requested',
        crossAccount: false,
      }),
    ]);
    // A recusa sai do roteamento só para esta conta (acesso, não instalação).
    expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', Date.now(), { accountId: 'codex-a' })).not.toBeNull();
    expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', Date.now(), { accountId: 'codex-b' })).toBeNull();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(events()).toHaveLength(1);

    // O renderer religou: sessão nova do MESMO pane, viva, no modelo pedido.
    h.sessions.set('session-codex-2', {
      sessionId: 'session-codex-2', paneId: 'pane-codex', adapterId: 'codex', model: 'gpt-6-sol',
    });
    h.states.set('session-codex-2', 'busy');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({
      paneId: 'pane-codex',
      toModel: 'gpt-6-sol',
      switched: true,
      modelRotationPhase: 'applied',
    });
    expect(h.trace).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'model-rotated', toModel: 'gpt-6-sol' }));
  });

  it('religamento que não acontece nunca emite switched:true', async () => {
    codexPane();
    h.dataTaps[0]('session-codex', 'MODEL_REFUSED');
    await settle();
    await vi.advanceTimersByTimeAsync(45_000);
    await settle();

    const all = events();
    expect(all.some((event) => event.switched)).toBe(false);
    expect(all.at(-1)).toMatchObject({ switched: false, modelRotationPhase: 'applied', toModel: 'gpt-6-sol' });
    expect(all.at(-1)?.reason).toMatch(/não religou em "gpt-6-sol"/);
    expect(h.trace).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'model-rotation-failed' }));
  });

  it('a ficha de início só sai quando o religamento é provado', async () => {
    codexPane();
    trackPaneStart({
      paneId: 'pane-codex', requestId: 'orchspawn-1', adapterId: 'codex', scope: SCOPE,
      role: 'helper', callerSessionId: 'session-parent', turnProof: false,
      pinnedRuntime: false, rerouted: false, createdAt: Date.now(),
    });
    h.dataTaps[0]('session-codex', 'MODEL_REFUSED');
    await settle();
    await vi.advanceTimersByTimeAsync(45_000);
    await settle();
    // Sem prova, a ficha fica: o prazo do watchdog ainda reabre ou avisa.
    expect(getPaneStartWatch('pane-codex')).not.toBeNull();
  });

  it('duas recusas seguidas não criam laço: cada recusada sai e o teto encerra', async () => {
    codexPane();
    h.dataTaps[0]('session-codex', 'MODEL_REFUSED');
    await settle();
    h.sessions.set('session-2', { sessionId: 'session-2', paneId: 'pane-codex', adapterId: 'codex', model: 'gpt-6-sol' });
    h.states.set('session-2', 'busy');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(events().at(-1)).toMatchObject({ switched: true, toModel: 'gpt-6-sol' });

    // O pane novo também é recusado: a próxima elegível pula as duas recusadas.
    codexPane({ sessionId: 'session-2' });
    h.sessions.set('session-2', { ...h.sessions.get('session-2'), model: 'gpt-6-sol' });
    h.dataTaps[0]('session-2', 'MODEL_REFUSED');
    await settle();
    const second = events().at(-1)!;
    expect(second).toMatchObject({ modelRotationPhase: 'requested' });
    expect(second.toModel).not.toBe('gpt-6.1-sol');
    expect(second.toModel).not.toBe('gpt-6-sol');
    expect(second.toModel).not.toBe('gpt-6-astra');
    h.sessions.set('session-3', { sessionId: 'session-3', paneId: 'pane-codex', adapterId: 'codex', model: second.toModel });
    h.states.set('session-3', 'busy');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    // Terceira recusa na janela: o teto para — aviso honesto, sem religar.
    codexPane({ sessionId: 'session-3' });
    h.sessions.set('session-3', { ...h.sessions.get('session-3'), model: second.toModel });
    h.dataTaps[0]('session-3', 'MODEL_REFUSED');
    await settle();
    const last = events().at(-1)!;
    expect(last).toMatchObject({ switched: false });
    expect(last.modelRotationPhase).toBeUndefined();
    expect(last.reason).toMatch(/religamentos seguidos/);
  });

  it('a frase do Codex no pane de OUTRA CLI é citação: nada é trocado nem quarentenado', async () => {
    codexPane();
    h.sessions.set('session-codex', { ...h.sessions.get('session-codex'), adapterId: 'claude', model: 'claude-opus-5-5' });
    h.panes.set('session-codex', { ...(h.panes.get('session-codex') as object), adapterId: 'claude' });
    h.dataTaps[0]('session-codex', 'MODEL_REFUSED');
    await settle();
    expect(events()).toEqual([]);
    expect(modelAccessQuarantine('claude', 'claude-opus-5-5', Date.now(), { accountId: 'codex-a' })).toBeNull();
    expect(h.trace).toHaveBeenCalledWith(expect.objectContaining({ suppressed: 'model-error-of-another-cli' }));
  });
});

describe('F-765: pane de missão — a tarefa é reaberta pela rota do spawn', () => {
  it('worker do renderer: fecha o pane parado, reabre preferindo a mesma CLI e só então anuncia', async () => {
    codexPane({ missionId: 'mission-1' });
    const reroute = handle();
    registerPaneTaskReroute(reroute);
    h.dataTaps[0]('session-codex', 'MODEL_REFUSED');
    await settle();

    // O renderer não religa pane de missão viva: nenhum pedido de respawn.
    expect(events().some((event) => event.modelRotationPhase === 'requested')).toBe(false);
    expect(h.requestPaneClose).toHaveBeenCalledWith('pane-codex', 'session-codex');
    expect(reroute.reroute).toHaveBeenCalledWith({ excludeAdapterIds: [], preferAdapterIds: ['codex'] });
    expect(h.requestPaneClose.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(reroute.reroute).mock.invocationCallOrder[0],
    );
    expect(events()).toEqual([
      expect.objectContaining({
        paneId: 'pane-codex', kind: 'model', switched: true,
        fromAdapterId: 'codex', toAdapterId: 'codex', toPaneId: 'pane-novo',
      }),
    ]);
    // O Maestro sabe, sem o texto cru do provedor (mascarado, F-511).
    expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({
      missionId: 'mission-1', status: 'progress', fromAgent: 'nexus-failover',
    }));
    const summary = String(h.submit.mock.calls[0]![0].summary);
    expect(summary).toContain('[failover:pane-codex]');
    expect(summary).toContain('pane-novo');
    expect(summary).not.toMatch(/model is not supported when using Codex with a ChatGPT account/);
  });

  it('reabertura que falha não anuncia troca e devolve a decisão ao Maestro', async () => {
    codexPane({ missionId: 'mission-1' });
    registerPaneTaskReroute(handle({
      reroute: vi.fn(async () => { throw new Error('mission_worker_route_unavailable: nenhuma CLI'); }),
    }));
    h.dataTaps[0]('session-codex', 'MODEL_REFUSED');
    await settle();
    expect(events().some((event) => event.switched)).toBe(false);
    expect(events().at(-1)?.reason).toMatch(/não foi reaberta/);
    expect(String(h.submit.mock.calls[0]![0].summary)).toContain('Decida');
  });

  it('CLI pedida pelo operador: não troca de CLI sozinho, diz qual modelo ainda serve', async () => {
    codexPane({ missionId: 'mission-1' });
    const pinned = handle({ pinnedRuntime: true });
    registerPaneTaskReroute(pinned);
    h.dataTaps[0]('session-codex', 'MODEL_REFUSED');
    await settle();
    expect(pinned.reroute).not.toHaveBeenCalled();
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    expect(events()).toEqual([expect.objectContaining({ switched: false, kind: 'model' })]);
    expect(events()[0]!.reason).toMatch(/pedida pelo operador/);
    expect(events()[0]!.reason).toContain('"gpt-6-sol" segue elegível');
    expect(String(h.submit.mock.calls[0]![0].summary)).toContain('Decida');
  });

  it('teto de reaberturas encadeadas: a quarta não acontece sozinha', async () => {
    codexPane({ missionId: 'mission-1' });
    const chained = handle({ generation: 3 });
    registerPaneTaskReroute(chained);
    h.dataTaps[0]('session-codex', 'MODEL_REFUSED');
    await settle();
    expect(chained.reroute).not.toHaveBeenCalled();
    expect(events()[0]!.reason).toMatch(/máximo de vezes/);
  });

  it('pane main-owned sem pedido guardado: religa no modelo novo e o recibo segue o desfecho', async () => {
    h.runtime.set('session-headless', {
      owner: null, paneId: 'pane-headless', sessionId: 'session-headless', kind: 'cli-agent',
      missionId: 'mission-1', scope: SCOPE,
    });
    h.sessions.set('session-headless', {
      sessionId: 'session-headless', paneId: 'pane-headless', adapterId: 'codex',
      model: 'gpt-6.1-sol', missionId: 'mission-1', role: 'worker',
    });
    h.respawnMainOwned.mockResolvedValueOnce(false);
    h.dataTaps[0]('session-headless', 'MODEL_REFUSED');
    await settle();
    expect(h.respawnMainOwned).toHaveBeenCalledWith(expect.objectContaining({
      paneId: 'pane-headless', toModel: 'gpt-6-sol', toAccountId: 'codex-a',
    }));
    // Respawn recusado: o recibo diz que não trocou e o Maestro é avisado.
    expect(events().some((event) => event.switched)).toBe(false);
    expect(events().at(-1)).toMatchObject({ modelRotationPhase: 'applied', switched: false });
    expect(String(h.submit.mock.calls[0]![0].summary)).toContain('não pôde ser religado');
  });
});

describe('F-765: incompatibilidade pertence à instalação', () => {
  it('recusa de CLI velha entra na quarentena da instalação; outra instalação não herda', async () => {
    vi.useRealTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f765-'));
    try {
      const bin = path.join(directory, 'codex');
      fs.writeFileSync(bin, 'codex-0.146');
      h.binPaths.set('codex', bin);
      codexPane();
      h.dataTaps[0]('session-codex', 'MODEL_REFUSED');
      await vi.waitFor(() => expect(events().length).toBeGreaterThan(0));
      // A recusa ficou presa à instalação (vale para qualquer conta nela)…
      expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', Date.now(), { accountId: 'codex-b' })).not.toBeNull();
      // …e some quando a instalação muda (CLI atualizada).
      expect(modelAccessQuarantine('codex', 'gpt-6.1-sol', Date.now(), {
        accountId: 'codex-b', installationId: 'outra-instalacao',
      })).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
