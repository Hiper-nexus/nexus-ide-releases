import { describe, expect, it } from 'vitest';
import {
  decideZeroDeliveryWatchdog,
  ZERO_DELIVERY_ESCALATE_MS,
  ZERO_DELIVERY_POKE_MS,
  ZERO_DELIVERY_READONLY_ESCALATE_QUIET_MS,
  ZERO_DELIVERY_READONLY_POKE_QUIET_MS,
  ZERO_DELIVERY_SEMANTIC_ACTIVE_MS,
  ZERO_DELIVERY_WRITER_QUIET_ESCALATE_MS,
  zeroDeliveryEscalateSummary,
  zeroDeliveryPokeSummary,
  zeroDeliveryWorkerActivity,
  ZERO_DELIVERY_ONESHOT_ACTIVE_MAX_MS,
} from './zero-delivery-watchdog';

describe('zero-delivery watchdog', () => {
  const base = {
    missionStatus: 'running',
    lane: 'standard' as string | null,
    workerPanes: 1,
    workerHandoffCount: 0,
    orchestratorState: 'idle' as string | null,
    executingSinceMs: 1_000,
    now: 1_000,
    alreadyPoked: false,
  };

  it('não age antes do orçamento de poke', () => {
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        now: base.executingSinceMs! + ZERO_DELIVERY_POKE_MS - 1,
      }),
    ).toEqual({ action: 'none' });
  });

  it('poke quando executing + 0 handoffs + Maestro idle após 3min', () => {
    const decision = decideZeroDeliveryWatchdog({
      ...base,
      now: base.executingSinceMs! + ZERO_DELIVERY_POKE_MS,
    });
    expect(decision.action).toBe('poke');
  });

  it('escalate após poke + 8min sem entrega', () => {
    const decision = decideZeroDeliveryWatchdog({
      ...base,
      alreadyPoked: true,
      now: base.executingSinceMs! + ZERO_DELIVERY_ESCALATE_MS,
    });
    expect(decision.action).toBe('escalate');
  });

  it('não interrompe Maestro busy e ignora plan/consult', () => {
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        orchestratorState: 'busy',
        now: base.executingSinceMs! + ZERO_DELIVERY_ESCALATE_MS,
      }),
    ).toEqual({ action: 'none' });
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        lane: 'plan',
        now: base.executingSinceMs! + ZERO_DELIVERY_ESCALATE_MS,
      }),
    ).toEqual({ action: 'none' });
  });

  it('silencia quando já houve handoff de worker', () => {
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        workerHandoffCount: 1,
        now: base.executingSinceMs! + ZERO_DELIVERY_ESCALATE_MS,
      }),
    ).toEqual({ action: 'none' });
  });
});

// F-986: estudo somente leitura com seis panes vivos e ocupados recebeu
// "[zero-delivery-escalate] Declare o worker anterior morto" após 7 min —
// disco vazio não é sinal para quem não grava, e pane ocupado está vivo.
describe('F-986: vigia de entrega olha atividade real, não o disco', () => {
  const T0 = 10_000_000;
  const base = {
    missionStatus: 'running',
    lane: 'standard' as string | null,
    workerPanes: 6,
    workerHandoffCount: 0,
    orchestratorState: 'idle' as string | null,
    executingSinceMs: T0,
    alreadyPoked: false,
  };
  const busyReadOnly = {
    anyActive: true,
    lastActivityAt: null as number | null,
    allReadOnly: true,
  };

  it('pane readOnly ocupado nunca recebe poke nem escalada, nem após uma hora', () => {
    for (const minutes of [3, 7, 8, 20, 60]) {
      for (const alreadyPoked of [false, true]) {
        expect(
          decideZeroDeliveryWatchdog({
            ...base,
            alreadyPoked,
            now: T0 + minutes * 60_000,
            workerActivity: { ...busyReadOnly, lastActivityAt: T0 + minutes * 60_000 },
          }),
        ).toEqual({ action: 'none' });
      }
    }
  });

  it('escritor ocupado também não é zero entrega (nada de matar trabalho em curso)', () => {
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        alreadyPoked: true,
        now: T0 + ZERO_DELIVERY_ESCALATE_MS * 3,
        workerActivity: { anyActive: true, lastActivityAt: null, allReadOnly: false },
      }),
    ).toEqual({ action: 'none' });
  });

  it('readOnly parado: prazo de estudo longo medido desde a ÚLTIMA atividade', () => {
    const lastActivityAt = T0 + 30 * 60_000;
    const quiet = () => ({
      anyActive: false,
      lastActivityAt,
      allReadOnly: true,
    });
    // 45 min de missão, mas só 9 min de silêncio: nada.
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        now: lastActivityAt + ZERO_DELIVERY_READONLY_POKE_QUIET_MS - 60_000,
        workerActivity: quiet(),
      }),
    ).toEqual({ action: 'none' });
    const poke = decideZeroDeliveryWatchdog({
      ...base,
      now: lastActivityAt + ZERO_DELIVERY_READONLY_POKE_QUIET_MS,
      workerActivity: quiet(),
    });
    expect(poke).toMatchObject({ action: 'poke', readOnly: true });
    // Já cutucado, mas o silêncio ainda é menor que o prazo de escalada.
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        alreadyPoked: true,
        now: lastActivityAt + ZERO_DELIVERY_READONLY_ESCALATE_QUIET_MS - 60_000,
        workerActivity: quiet(),
      }),
    ).toEqual({ action: 'none' });
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        alreadyPoked: true,
        now: lastActivityAt + ZERO_DELIVERY_READONLY_ESCALATE_QUIET_MS,
        workerActivity: quiet(),
      }),
    ).toMatchObject({ action: 'escalate', readOnly: true });
  });

  it('escritor: escalada exige workers quietos pela janela mínima', () => {
    const now = T0 + ZERO_DELIVERY_ESCALATE_MS + 60_000;
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        alreadyPoked: true,
        now,
        workerActivity: {
          anyActive: false,
          lastActivityAt: now - ZERO_DELIVERY_WRITER_QUIET_ESCALATE_MS + 1,
          allReadOnly: false,
        },
      }),
    ).toEqual({ action: 'none' });
    expect(
      decideZeroDeliveryWatchdog({
        ...base,
        alreadyPoked: true,
        now,
        workerActivity: {
          anyActive: false,
          lastActivityAt: now - ZERO_DELIVERY_WRITER_QUIET_ESCALATE_MS,
          allReadOnly: false,
        },
      }),
    ).toMatchObject({ action: 'escalate', readOnly: false });
  });

  it('mensagens: nunca mandam declarar morto/fechar pane ocupado; readOnly não cobra arquivos', () => {
    const escalate = zeroDeliveryEscalateSummary('m1', {
      readOnly: true,
      quietMs: 20 * 60_000,
    });
    expect(escalate).not.toMatch(/Declare o worker anterior morto/);
    expect(escalate).not.toMatch(/disco vazio/);
    expect(escalate).toContain('nunca feche pane busy');
    expect(escalate).toContain('há 20min');
    expect(escalate).toContain('nexus_pane_read');
    const poke = zeroDeliveryPokeSummary('m1', 25 * 60_000, {
      readOnly: true,
      quietMs: 10 * 60_000,
    });
    expect(poke).not.toMatch(/nem arquivos/);
    expect(poke).toContain('disco vazio não é sinal');
    expect(poke).toContain('há 10min');
  });
});

describe('F-986: zeroDeliveryWorkerActivity', () => {
  const now = 50_000_000;
  const none = () => null;
  const zero = () => 0;

  it('PTY busy/spawning conta como atividade agora', () => {
    const activity = zeroDeliveryWorkerActivity({
      workers: [
        { sessionId: 's1', state: 'idle', readOnly: true },
        { sessionId: 's2', state: 'busy', readOnly: true },
      ],
      now,
      semanticStatus: none,
      toolActivityCount: zero,
      previous: () => undefined,
    });
    expect(activity).toMatchObject({ anyActive: true, lastActivityAt: now, allReadOnly: true });
    expect(activity.seen.get('s2')).toEqual({ activeAt: now, toolCount: 0 });
    expect(activity.seen.get('s1')).toEqual({ activeAt: 0, toolCount: 0 });
  });

  it('turno fresco ou ferramenta nova contam mesmo com PTY quieto', () => {
    const fresh = zeroDeliveryWorkerActivity({
      workers: [{ sessionId: 's1', state: 'idle' }],
      now,
      semanticStatus: () => ({ status: 'working', updatedAt: now - 60_000 }),
      toolActivityCount: zero,
      previous: () => undefined,
    });
    expect(fresh.anyActive).toBe(true);
    const tool = zeroDeliveryWorkerActivity({
      workers: [{ sessionId: 's1', state: 'idle' }],
      now,
      semanticStatus: none,
      toolActivityCount: () => 7,
      previous: () => ({ activeAt: now - 15_000, toolCount: 6 }),
    });
    expect(tool.anyActive).toBe(true);
    expect(tool.allReadOnly).toBe(false);
  });

  it('parado: guarda a última evidência (turno velho / varredura anterior) sem marcar ativo', () => {
    const stale = zeroDeliveryWorkerActivity({
      workers: [{ sessionId: 's1', state: 'idle', readOnly: true }],
      now,
      semanticStatus: () => ({
        status: 'working',
        updatedAt: now - ZERO_DELIVERY_SEMANTIC_ACTIVE_MS - 1,
      }),
      toolActivityCount: () => 3,
      previous: () => ({ activeAt: now - 2 * 60_000, toolCount: 3 }),
    });
    expect(stale.anyActive).toBe(false);
    expect(stale.lastActivityAt).toBe(now - 2 * 60_000);
    expect(stale.seen.get('s1')).toEqual({ activeAt: now - 2 * 60_000, toolCount: 3 });
  });

  it('mistura de escritor e leitor não é estudo somente leitura', () => {
    expect(
      zeroDeliveryWorkerActivity({
        workers: [
          { sessionId: 's1', state: 'idle', readOnly: true },
          { sessionId: 's2', state: 'idle', readOnly: false },
        ],
        now,
        semanticStatus: none,
        toolActivityCount: zero,
        previous: () => undefined,
      }).allReadOnly,
    ).toBe(false);
  });
});

describe('F-1272: worker one-shot (agy --print / opencode run) com a raiz viva', () => {
  const now = 50_000_000;

  it('PTY idle + semântico idle + 0 handoffs: ainda é entrega em curso — nem poke nem escalada', () => {
    const activity = zeroDeliveryWorkerActivity({
      workers: [{ sessionId: 's1', state: 'idle', oneShotAlive: true }],
      now,
      // A tela muda do one-shot cai no fallback de idle do avaliador.
      semanticStatus: () => ({ status: 'idle', updatedAt: now - 60_000 }),
      toolActivityCount: () => 0,
      previous: () => undefined,
    });
    expect(activity.anyActive).toBe(true);
    for (const alreadyPoked of [false, true]) {
      const decision = decideZeroDeliveryWatchdog({
        missionStatus: 'running',
        workerPanes: 1,
        workerHandoffCount: 0,
        orchestratorState: 'idle',
        executingSinceMs: now - 10 * 60_000,
        now,
        alreadyPoked,
        workerActivity: activity,
      });
      expect(decision.action).toBe('none');
    }
  });

  it('one-shot preso além do teto volta à regra normal (sem atividade eterna)', () => {
    const since = now - ZERO_DELIVERY_ONESHOT_ACTIVE_MAX_MS - 60_000;
    const activity = zeroDeliveryWorkerActivity({
      workers: [{ sessionId: 's1', state: 'idle', oneShotAlive: true }],
      now,
      semanticStatus: () => ({ status: 'idle', updatedAt: since }),
      toolActivityCount: () => 0,
      previous: () => ({ activeAt: since, toolCount: 0, oneShotSince: since }),
    });
    expect(activity.anyActive).toBe(false);
    // A primeira varredura que vê o one-shot guarda o marco do teto.
    const first = zeroDeliveryWorkerActivity({
      workers: [{ sessionId: 's1', state: 'idle', oneShotAlive: true }],
      now,
      semanticStatus: () => null,
      toolActivityCount: () => 0,
      previous: () => undefined,
    });
    expect(first.seen.get('s1')?.oneShotSince).toBe(now);
  });

  it('one-shot cuja raiz já saiu (oneShotAlive ausente/falso) segue as regras normais de silêncio', () => {
    const activity = zeroDeliveryWorkerActivity({
      workers: [{ sessionId: 's1', state: 'idle' }],
      now,
      semanticStatus: () => null,
      toolActivityCount: () => 0,
      previous: () => undefined,
    });
    expect(activity.anyActive).toBe(false);
    const decision = decideZeroDeliveryWatchdog({
      missionStatus: 'running',
      workerPanes: 1,
      workerHandoffCount: 0,
      orchestratorState: 'idle',
      executingSinceMs: now - 10 * 60_000,
      now,
      alreadyPoked: false,
      workerActivity: activity,
    });
    expect(decision.action).toBe('poke');
  });
});
