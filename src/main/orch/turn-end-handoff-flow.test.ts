import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fluxo completo de handleTurnEndMechanicalHandoff com o mundo mockado —
// prova a ORQUESTRAÇÃO (recolhe fatos → decide → submete → dedup), não a
// transação durável (coberta por pty-stream-handoff.test.ts) nem as guardas
// puras (cobertas por turn-end-handoff.test.ts).

const mocks = vi.hoisted(() => ({
  getContextBySession: vi.fn(),
  getLastSessionInputOrigin: vi.fn(),
  getStores: vi.fn(),
  submitPtyStreamHandoff: vi.fn(),
  terminateStale: vi.fn(async () => false),
}));

vi.mock('./gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gate')>()),
  getContextBySession: mocks.getContextBySession,
}));

vi.mock('../pty/pty-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pty/pty-manager')>()),
  getLastSessionInputOrigin: mocks.getLastSessionInputOrigin,
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: mocks.getStores,
}));

vi.mock('./pty-stream-handoff', () => ({
  submitPtyStreamHandoff: mocks.submitPtyStreamHandoff,
  terminateStaleReadOnlyPtyStreamSession: mocks.terminateStale,
}));

vi.mock('./worker-delivery-board', () => ({
  recordWorkerDeliveryIfDelivered: vi.fn(),
  markSessionSealedBoardCredited: vi.fn(),
  initWorkerDeliveryBoard: vi.fn(),
  shutdownWorkerDeliveryBoard: vi.fn(),
}));

import {
  __resetTurnEndHandoffForTests,
  handleTurnEndMechanicalHandoff,
} from './turn-end-handoff';

const scope = { rootRealPath: '/proj' } as never;

function workerCtx(overrides: Record<string, unknown> = {}) {
  return {
    role: 'worker',
    missionId: 'm-1',
    workerIncarnationId: 'inc-1',
    sessionId: 'pty-w1',
    scope,
    ...overrides,
  };
}

function storeWith(handoffs: Array<{ sessionId: string; createdAt: number }>) {
  return { handoffs: { list: () => handoffs } };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetTurnEndHandoffForTests();
  mocks.getContextBySession.mockReturnValue(workerCtx());
  mocks.getLastSessionInputOrigin.mockReturnValue('system');
  mocks.getStores.mockReturnValue(storeWith([]));
  mocks.submitPtyStreamHandoff.mockResolvedValue({
    handoffId: 'h-1',
    taskDispatchState: 'completed',
    replayed: false,
  });
});

describe('handleTurnEndMechanicalHandoff (fluxo)', () => {
  it('worker encerra sem tool → submete [auto] com o texto verbatim do payload', async () => {
    await handleTurnEndMechanicalHandoff({
      sessionId: 'pty-w1',
      body: {
        last_assistant_message: 'Validação concluída: 3 testes novos, todos verdes.',
        transcript_path: '/t/transcript.jsonl',
      },
    });

    expect(mocks.submitPtyStreamHandoff).toHaveBeenCalledTimes(1);
    const [sessionId, payload] = mocks.submitPtyStreamHandoff.mock.calls[0];
    expect(sessionId).toBe('pty-w1');
    expect(payload.status).toBe('success');
    expect(payload.summary).toContain('[auto] ');
    expect(payload.summary).toContain('3 testes novos');
    const artifact = payload.artifacts[0] as Record<string, unknown>;
    expect(artifact.closedBy).toBe('turn-end');
    expect(artifact.transcript).toBe('/t/transcript.jsonl');
  });

  it('mesmo Stop disparado 2× submete UMA vez (dedup de re-disparo)', async () => {
    const body = { last_assistant_message: 'mesma resposta do mesmo turno' };
    await handleTurnEndMechanicalHandoff({ sessionId: 'pty-w1', body });
    await handleTurnEndMechanicalHandoff({ sessionId: 'pty-w1', body });
    expect(mocks.submitPtyStreamHandoff).toHaveBeenCalledTimes(1);
  });

  it('worker que JÁ chamou a tool neste turno → não submete (dedup C-194.1)', async () => {
    mocks.getStores.mockReturnValue(
      storeWith([{ sessionId: 'pty-w1', createdAt: Date.now() }]),
    );
    await handleTurnEndMechanicalHandoff({
      sessionId: 'pty-w1',
      body: { last_assistant_message: 'já entreguei pela tool' },
    });
    expect(mocks.submitPtyStreamHandoff).not.toHaveBeenCalled();
  });

  it('turno aberto pelo operador (F-339) → não submete', async () => {
    mocks.getLastSessionInputOrigin.mockReturnValue('human');
    await handleTurnEndMechanicalHandoff({
      sessionId: 'pty-w1',
      body: { last_assistant_message: 'conversa com o humano' },
    });
    expect(mocks.submitPtyStreamHandoff).not.toHaveBeenCalled();
  });

  it('orquestrador nunca fecha mecanicamente (anti-eco colapsa no role)', async () => {
    mocks.getContextBySession.mockReturnValue(workerCtx({ role: 'orchestrator' }));
    await handleTurnEndMechanicalHandoff({
      sessionId: 'pty-o1',
      body: { last_assistant_message: 'reação do chefe à entrega' },
    });
    expect(mocks.submitPtyStreamHandoff).not.toHaveBeenCalled();
  });

  it('sem gate ctx → não submete, não lança', async () => {
    mocks.getContextBySession.mockReturnValue(null);
    await handleTurnEndMechanicalHandoff({
      sessionId: 'pty-x',
      body: { last_assistant_message: 'pane solto' },
    });
    expect(mocks.submitPtyStreamHandoff).not.toHaveBeenCalled();
  });

  it('submissão rejeitada → log, sem lançar; o próximo Stop pode tentar de novo', async () => {
    mocks.submitPtyStreamHandoff.mockRejectedValue(new Error('boom'));
    await expect(
      handleTurnEndMechanicalHandoff({
        sessionId: 'pty-w1',
        body: { last_assistant_message: 'resposta que não vai entrar' },
      }),
    ).resolves.toBeUndefined();
    expect(mocks.submitPtyStreamHandoff).toHaveBeenCalledTimes(1);

    mocks.submitPtyStreamHandoff.mockClear();
    mocks.submitPtyStreamHandoff.mockResolvedValue({
      handoffId: 'h-2',
      taskDispatchState: 'completed',
      replayed: false,
    });
    await handleTurnEndMechanicalHandoff({
      sessionId: 'pty-w1',
      body: { last_assistant_message: 'resposta que não vai entrar' },
    });
    expect(mocks.submitPtyStreamHandoff).toHaveBeenCalledTimes(1);
  });
});
