/**
 * F-723: o Nexus confere se o pane que soltou começou a tarefa. Decisão pura
 * (`decideStartAction`), texto do aviso e a ficha em memória.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  START_GRACE_MS,
  decideStartAction,
  getPaneStartWatch,
  notePaneSessionEnded,
  notePaneStartAccepted,
  notePaneStartFailure,
  notStartedCause,
  paneStartNoticeSummary,
  resetPaneStartWatchdogForTests,
  setPaneStartKick,
  shortStartError,
  trackPaneStart,
  type StartCheckInput,
} from './pane-start-watchdog';

const NOW = 50_000_000;

function input(overrides: Partial<StartCheckInput> = {}): StartCheckInput {
  return {
    role: 'worker',
    operatorOpened: false,
    started: false,
    failed: false,
    session: 'idle',
    canJudgeLiveSession: true,
    spawnedAt: NOW - START_GRACE_MS - 1_000,
    redeliveredAt: null,
    rerouted: false,
    pinnedRuntime: false,
    hasAlternative: true,
    now: NOW,
    ...overrides,
  };
}

describe('decideStartAction (F-723)', () => {
  it('pane que começou a tarefa: nada a fazer', () => {
    expect(decideStartAction(input({ started: true }))).toBe('none');
    expect(decideStartAction(input({ started: true, failed: true }))).toBe('none');
  });

  it('sessão viva, ociosa e sem turno depois da graça: reenvia o brief uma vez', () => {
    expect(decideStartAction(input())).toBe('redeliver');
    // Dentro da graça ainda é boot.
    expect(decideStartAction(input({ spawnedAt: NOW - 10_000 }))).toBe('none');
  });

  it('ainda sem turno uma graça depois do reenvio: manda para outra CLI', () => {
    expect(
      decideStartAction(input({ redeliveredAt: NOW - START_GRACE_MS })),
    ).toBe('reroute');
    // Reenvio recente: espera a nova graça, não reenvia de novo.
    expect(decideStartAction(input({ redeliveredAt: NOW - 30_000 }))).toBe('none');
  });

  it('nenhuma sessão nasceu na graça: manda para outra CLI', () => {
    expect(decideStartAction(input({ session: 'none' }))).toBe('reroute');
    expect(
      decideStartAction(input({ session: 'none', spawnedAt: NOW - 20_000 })),
    ).toBe('none');
  });

  it('falha física provada (spawn recusado, saída no boot) não espera a graça', () => {
    expect(
      decideStartAction(input({ failed: true, session: 'none', spawnedAt: NOW - 2_000 })),
    ).toBe('reroute');
  });

  it('PTY ocupado ou CLI sem prova de turno: sessão viva não é julgada', () => {
    expect(decideStartAction(input({ session: 'busy' }))).toBe('none');
    expect(decideStartAction(input({ canJudgeLiveSession: false }))).toBe('none');
    // Mas falha provada vale para qualquer CLI.
    expect(
      decideStartAction(input({ canJudgeLiveSession: false, failed: true })),
    ).toBe('reroute');
  });

  it('pane aberto pelo operador (F-231): só avisa, nunca reenvia nem fecha', () => {
    expect(decideStartAction(input({ operatorOpened: true }))).toBe('notify-only');
    expect(
      decideStartAction(input({ operatorOpened: true, failed: true })),
    ).toBe('notify-only');
  });

  it('orquestrador e o pane do próprio operador nunca são vigiados', () => {
    for (const role of ['orchestrator', 'operator'] as const) {
      expect(decideStartAction(input({ role }))).toBe('none');
      expect(decideStartAction(input({ role, failed: true }))).toBe('none');
      expect(decideStartAction(input({ role, session: 'none' }))).toBe('none');
    }
  });

  it('já é o reenvio automático de outro pedido: só avisa (sem laço)', () => {
    expect(decideStartAction(input({ rerouted: true, failed: true }))).toBe('notify-only');
    expect(
      decideStartAction(input({ rerouted: true, redeliveredAt: NOW - START_GRACE_MS })),
    ).toBe('notify-only');
    // O reenvio do brief ("corrigir ali") ainda vale para ele.
    expect(decideStartAction(input({ rerouted: true }))).toBe('redeliver');
  });

  it('nenhuma outra CLI disponível: só avisa', () => {
    expect(
      decideStartAction(input({ hasAlternative: false, failed: true })),
    ).toBe('notify-only');
  });

  it('CLI pedida pelo operador ou retomada de conversa: não troca sozinho', () => {
    expect(
      decideStartAction(input({ pinnedRuntime: true, session: 'none' })),
    ).toBe('notify-only');
  });
});

describe('aviso a quem pediu (F-723)', () => {
  it('reroteado: ids, adapter, motivo e o pane novo', () => {
    expect(
      paneStartNoticeSummary({
        paneId: 'pane-qwen',
        adapterId: 'qwen',
        cause: 'spawn-refused',
        outcome: { kind: 'rerouted', paneId: 'pane-novo', adapterId: 'codex' },
      }),
    ).toBe(
      '[nao-iniciou:pane-qwen] O pane pane-qwen (qwen) não começou a tarefa: ' +
        'o CLI não subiu (o spawn foi recusado). Reenviada para codex (pane pane-novo).',
    );
  });

  it('sem alternativa: pede a decisão', () => {
    const summary = paneStartNoticeSummary({
      paneId: 'pane-1',
      adapterId: 'kimi',
      cause: notStartedCause({ failure: null, hasSession: false }),
      outcome: { kind: 'not-rerouted', why: 'no-alternative' },
    });
    expect(summary).toContain('nenhuma sessão nasceu em 90 s');
    expect(summary).toContain('Nenhuma outra CLI está disponível — decida.');
  });

  it('motivo curto do erro: 1ª linha, sem segredo, com teto', () => {
    const error = new Error(
      'falhou com Bearer abcdefghijklmnopqrstuvwxyz token sk-proj-ABCDEFGHIJKLMNOP\nlinha 2',
    );
    const short = shortStartError(error);
    expect(short).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(short).not.toContain('sk-proj-ABCDEFGHIJKLMNOP');
    expect(short).not.toContain('linha 2');
    expect(shortStartError('x'.repeat(400)).length).toBeLessThanOrEqual(160);
  });
});

describe('ficha do spawn pendente (F-723)', () => {
  afterEach(() => {
    resetPaneStartWatchdogForTests();
    vi.useRealTimers();
  });

  const base = () => ({
    paneId: 'pane-a',
    requestId: 'orchspawn-a',
    adapterId: 'claude',
    scope: testProjectScope(),
    missionId: 'mission-a',
    role: 'worker' as const,
    callerSessionId: 'session-maestro',
    turnProof: true,
    pinnedRuntime: false,
    rerouted: false,
    createdAt: NOW,
  });

  it('falha que chega antes da ficha (corrida com a resposta da tool) não se perde', () => {
    const at = Date.now();
    notePaneStartFailure('pane-a', 'spawn-refused', at);
    const watch = trackPaneStart(base());
    expect(watch.failure).toEqual({ cause: 'spawn-refused', at });
  });

  it('entrega comprovada do brief dá o pane por iniciado; falha depois não reverte', () => {
    const watch = trackPaneStart(base());
    notePaneStartAccepted('pane-a');
    notePaneStartFailure('pane-a', 'brief-rejected');
    expect(watch.accepted).toBe(true);
    expect(watch.failure).toBeNull();
  });

  it('falha provada pede a varredura imediata (não espera os 15 s)', () => {
    vi.useFakeTimers();
    const kick = vi.fn();
    setPaneStartKick(kick);
    trackPaneStart(base());
    notePaneStartFailure('pane-a', 'spawn-refused');
    expect(kick).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it('processo que saiu sozinho no boot, sem turno, não começou', () => {
    const watch = trackPaneStart(base());
    notePaneSessionEnded(watch, {
      sessionId: 'session-a',
      requested: false,
      oneShot: false,
      spawnedAt: NOW,
      started: false,
      now: NOW + 5_000,
    });
    expect(watch.sessionId).toBe('session-a');
    expect(watch.failure).toEqual({ cause: 'boot-exit', at: NOW + 5_000 });
  });

  it('encerramento pedido, one-shot que terminou e morte tardia não são falha de início', () => {
    const cases = [
      { requested: true, oneShot: false, now: NOW + 5_000 },
      { requested: false, oneShot: true, now: NOW + 5_000 },
      { requested: false, oneShot: false, now: NOW + START_GRACE_MS + 1 },
    ];
    for (const end of cases) {
      resetPaneStartWatchdogForTests();
      const watch = trackPaneStart(base());
      notePaneSessionEnded(watch, {
        sessionId: 'session-a',
        spawnedAt: NOW,
        started: false,
        ...end,
      });
      expect(watch.failure).toBeNull();
      expect(watch.sessionEnded).toBe(true);
    }
  });

  it('a ficha nunca guarda o texto do brief, só a closure de entrega', () => {
    const watch = trackPaneStart({ ...base(), redeliver: async () => true });
    expect(JSON.stringify(watch)).not.toMatch(/brief|prompt/i);
    expect(getPaneStartWatch('pane-a')).toBe(watch);
  });
});
