import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalHookEvent } from '../../vendor/emdash/hooks/hooks-types';

const harness = vi.hoisted(() => ({
  publish: vi.fn((_sessionId: string, _state: string) => true),
  state: 'idle' as string | null,
  agentInfo: vi.fn(
    (_sessionId: string): { paneId?: string } | null => null,
  ),
  oneShotRunning: vi.fn((_sessionId: string): boolean => false),
}));

vi.mock('../pty/pty-manager', () => ({
  publishSessionActivityState: (sessionId: string, state: string) =>
    harness.publish(sessionId, state),
  getAgentSessionInfo: (sessionId: string) => harness.agentInfo(sessionId),
  getSessionState: () => harness.state,
  isOneShotSessionRunning: (sessionId: string) =>
    harness.oneShotRunning(sessionId),
}));

import {
  __resetAgentStatusForTests,
  applyCanonicalHookEvent,
  getAgentLastTurnEnd,
  getAgentToolActivityCount,
  getAgentTurnStartSequence,
  getAgentSemanticStatus,
  isSessionInjectableIdle,
  isSessionIdleForCleanup,
  isSessionInAbandonedDialog,
  isAgentAwaitingOperator,
  paneStateForStatus,
  resetAgentStatusOnExit,
  semanticStatusForEvent,
  tapAgentSemanticStatus,
  tapAgentTurnEnd,
  tapAgentTurnStart,
  type AgentTurnEndEntry,
} from './agent-status';

const start: CanonicalHookEvent = { kind: 'status', type: 'start' };
const userSubmit: CanonicalHookEvent = {
  kind: 'status',
  type: 'start',
  clearsAwaitingInput: true,
  promptSubmitted: true,
};
const stop: CanonicalHookEvent = { kind: 'status', type: 'stop' };
const failure: CanonicalHookEvent = { kind: 'status', type: 'error' };
const permission: CanonicalHookEvent = {
  kind: 'status',
  type: 'notification',
  notificationType: 'permission_prompt',
  message: 'Claude needs your permission to run Bash',
};
const elicitation: CanonicalHookEvent = {
  kind: 'status',
  type: 'notification',
  notificationType: 'elicitation_dialog',
};
const idlePrompt: CanonicalHookEvent = {
  kind: 'status',
  type: 'notification',
  notificationType: 'idle_prompt',
};
const untypedNotification: CanonicalHookEvent = {
  kind: 'status',
  type: 'notification',
};

beforeEach(() => {
  __resetAgentStatusForTests();
  // mockReset (not mockClear): the "never throws" test replaces the
  // implementation with a throwing one and it must not leak into later tests.
  harness.publish.mockReset().mockImplementation(() => true);
  harness.agentInfo.mockReset().mockReturnValue(null);
  harness.oneShotRunning.mockReset().mockReturnValue(false);
  harness.state = 'idle';
});

describe('isAgentAwaitingOperator (F-660)', () => {
  const apply = (event: CanonicalHookEvent) =>
    applyCanonicalHookEvent({ sessionId: 'pty-maestro', event });

  it('pergunta no meio do turno: o pane fica idle, mas o Maestro espera o operador', () => {
    // Campo 28/09 08:49–08:50: UserPromptSubmit, ferramentas, AskUserQuestion
    // → idle_prompt sem Stop. A conclusão automática leu idle como "terminou".
    apply(userSubmit);
    apply(start);
    apply(idlePrompt);
    expect(getAgentSemanticStatus('pty-maestro')?.status).toBe('idle');
    expect(isAgentAwaitingOperator('pty-maestro')).toBe(true);
    apply(permission);
    expect(isAgentAwaitingOperator('pty-maestro')).toBe(true);
  });

  it('turno fechado por Stop não é espera, mesmo com idle_prompt depois', () => {
    apply(userSubmit);
    apply(stop);
    expect(isAgentAwaitingOperator('pty-maestro')).toBe(false);
    apply(idlePrompt);
    expect(isAgentAwaitingOperator('pty-maestro')).toBe(false);
  });

  it('sem notificação de espera, turno aberto trabalhando não conta', () => {
    apply(userSubmit);
    apply(start);
    expect(isAgentAwaitingOperator('pty-maestro')).toBe(false);
    expect(isAgentAwaitingOperator('pty-sem-hook')).toBe(false);
  });

  it('novo prompt reabre o turno depois de um Stop', () => {
    apply(userSubmit);
    apply(stop);
    apply(userSubmit);
    apply(elicitation);
    expect(isAgentAwaitingOperator('pty-maestro')).toBe(true);
    resetAgentStatusOnExit('pty-maestro');
    expect(isAgentAwaitingOperator('pty-maestro')).toBe(false);
  });
});

describe('semanticStatusForEvent (pure mapping)', () => {
  it('maps the documented transition table', () => {
    expect(semanticStatusForEvent(start)).toBe('working');
    expect(semanticStatusForEvent(stop)).toBe('completed');
    expect(semanticStatusForEvent(failure)).toBe('error');
    expect(semanticStatusForEvent(permission)).toBe('awaiting-input');
    expect(semanticStatusForEvent(elicitation)).toBe('awaiting-input');
    expect(semanticStatusForEvent(idlePrompt)).toBe('idle');
    expect(semanticStatusForEvent(untypedNotification)).toBe('idle');
  });

  it('ignores events without status content', () => {
    expect(
      semanticStatusForEvent({ kind: 'session', providerSessionId: 's1' }),
    ).toBeNull();
    expect(semanticStatusForEvent({ kind: 'ignore' })).toBeNull();
  });
});

describe('paneStateForStatus', () => {
  it('only working pins the pane busy', () => {
    expect(paneStateForStatus('working')).toBe('busy');
    expect(paneStateForStatus('completed')).toBe('idle');
    expect(paneStateForStatus('awaiting-input')).toBe('idle');
    expect(paneStateForStatus('error')).toBe('idle');
    expect(paneStateForStatus('idle')).toBe('idle');
  });
});

describe('applyCanonicalHookEvent', () => {
  it('applies start → working, persists per pane and publishes busy', () => {
    harness.agentInfo.mockReturnValue({ paneId: 'pane-1' });

    const result = applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });

    expect(result).toMatchObject({ applied: true, transitioned: true });
    expect(getAgentSemanticStatus('pane-1')).toMatchObject({
      status: 'working',
      paneId: 'pane-1',
      sessionId: 'pty-1',
    });
    expect(harness.publish).toHaveBeenCalledWith('pty-1', 'busy');
  });

  it('walks the full lifecycle working → awaiting-input → working → completed', () => {
    const transitions: string[] = [];
    tapAgentSemanticStatus((entry) => transitions.push(entry.status));

    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: permission });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });

    expect(transitions).toEqual(['working', 'awaiting-input', 'working', 'completed']);
    expect(getAgentSemanticStatus('pty-1')?.status).toBe('completed');
    expect(harness.publish).toHaveBeenLastCalledWith('pty-1', 'idle');
  });

  it('keeps a permission latch across parallel non-interactive tool starts', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: permission });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });

    expect(getAgentSemanticStatus('pty-1')?.status).toBe('awaiting-input');
    expect(isSessionInjectableIdle('pty-1')).toBe(false);

    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
    expect(getAgentSemanticStatus('pty-1')?.status).toBe('working');
    harness.state = 'busy';
    expect(isSessionInjectableIdle('pty-1')).toBe(false);
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });
    harness.state = 'idle';
    expect(isSessionInjectableIdle('pty-1')).toBe(true);
  });

  it('does not let an unrelated idle notification clear a permission latch', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: permission });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: idlePrompt });

    expect(getAgentSemanticStatus('pty-1')?.status).toBe('awaiting-input');
    expect(isSessionInjectableIdle('pty-1')).toBe(false);
  });

  it('fires transition taps only on CHANGE — hook re-asserts are silent', () => {
    const transitions: string[] = [];
    tapAgentSemanticStatus((entry) => transitions.push(entry.status));

    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });
    const second = applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });
    const third = applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });

    expect(second.transitioned).toBe(false);
    expect(third.transitioned).toBe(false);
    expect(transitions).toEqual(['working']);
    // …but the pane channel is still re-asserted every time (watchdog re-arm).
    expect(harness.publish).toHaveBeenCalledTimes(3);
  });

  it('emits every explicit prompt submission with a monotonic content-free sequence', () => {
    const starts: unknown[] = [];
    tapAgentTurnStart((entry) => starts.push(entry));

    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: userSubmit,
      now: 100,
    });
    // Same semantic state is still a distinct native turn boundary.
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: userSubmit,
      now: 200,
    });
    // A generic start/tool lifecycle assertion is not prompt-submission proof.
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start, now: 300 });

    expect(starts).toEqual([
      {
        sessionId: 'pty-1',
        paneId: 'pty-1',
        sequence: 1,
        observedAt: 100,
      },
      {
        sessionId: 'pty-1',
        paneId: 'pty-1',
        sequence: 2,
        observedAt: 200,
      },
    ]);
    expect(getAgentTurnStartSequence('pty-1')).toBe(2);
    expect(JSON.stringify(starts)).not.toContain('prompt');
  });

  it('maps error to the error status while releasing the pane to idle', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: failure });

    expect(getAgentSemanticStatus('pty-1')?.status).toBe('error');
    expect(harness.publish).toHaveBeenLastCalledWith('pty-1', 'idle');
  });

  it('drops session/ignore events without touching state', () => {
    const result = applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: { kind: 'session', providerSessionId: 'claude-abc' },
    });

    expect(result).toEqual({ applied: false, transitioned: false, entry: null });
    expect(getAgentSemanticStatus('pty-1')).toBeNull();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('never throws — a reducer failure degrades to applied:false', () => {
    harness.publish.mockImplementation(() => {
      throw new Error('pty layer exploded');
    });

    const result = applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });

    expect(result.applied).toBe(false);
  });
});

describe('resetAgentStatusOnExit', () => {
  it('resets a stuck working pane to idle on PTY exit (no stop hook)', () => {
    harness.agentInfo.mockReturnValue({ paneId: 'pane-9' });
    const transitions: string[] = [];
    tapAgentSemanticStatus((entry) => transitions.push(entry.status));

    applyCanonicalHookEvent({ sessionId: 'pty-9', event: start });
    expect(getAgentSemanticStatus('pane-9')?.status).toBe('working');

    resetAgentStatusOnExit('pty-9');

    expect(getAgentSemanticStatus('pane-9')).toBeNull();
    expect(getAgentTurnStartSequence('pty-9')).toBe(0);
    expect(transitions).toEqual(['working', 'idle']);
  });

  it('is a no-op for sessions that never reported a hook status', () => {
    const transitions: string[] = [];
    tapAgentSemanticStatus((entry) => transitions.push(entry.status));

    resetAgentStatusOnExit('pty-unknown');

    expect(transitions).toEqual([]);
    expect(getAgentSemanticStatus('pty-unknown')).toBeNull();
  });

  it('does not re-fire taps when the pane already settled to idle', () => {
    const transitions: string[] = [];
    tapAgentSemanticStatus((entry) => transitions.push(entry.status));

    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });
    resetAgentStatusOnExit('pty-1');

    // stop → completed, exit → idle: both are real transitions.
    expect(transitions).toEqual(['working', 'completed', 'idle']);
    resetAgentStatusOnExit('pty-1');
    expect(transitions).toEqual(['working', 'completed', 'idle']);
  });
});

describe('isSessionIdleForCleanup — silêncio não autoriza encerrar trabalho', () => {
  it('preserva working antigo mesmo quando já pode receber um handoff', () => {
    vi.useFakeTimers();
    try {
      applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });
      vi.advanceTimersByTime(35 * 60_000);
      expect(isSessionInjectableIdle('pty-1')).toBe(true);
      expect(isSessionIdleForCleanup('pty-1')).toBe(false);
      applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });
      expect(isSessionIdleForCleanup('pty-1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserva permissões pendentes e PTYs ocupados; permite idle sem hooks', () => {
    expect(isSessionIdleForCleanup('pty-1')).toBe(true);
    harness.state = 'busy';
    expect(isSessionIdleForCleanup('pty-1')).toBe(false);
    harness.state = 'idle';
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: permission });
    expect(isSessionIdleForCleanup('pty-1')).toBe(false);
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });
    expect(isSessionIdleForCleanup('pty-1')).toBe(true);
  });

  it('diálogo abandonado há 10+ min continua vetado para limpeza e injeção; só é SINALIZADO ao guardian', () => {
    // Worker esperando aprovação ou pane humano com diálogo aberto está em uso
    // mesmo sem resposta há 10 min. O guardian decide quem pode perdê-lo
    // (helper que já entregou) a partir de isSessionInAbandonedDialog.
    vi.useFakeTimers();
    try {
      applyCanonicalHookEvent({ sessionId: 'pty-1', event: permission });
      harness.state = 'idle';
      expect(isSessionInAbandonedDialog('pty-1')).toBe(false);
      vi.advanceTimersByTime(10 * 60_000 + 1_000);
      expect(isSessionIdleForCleanup('pty-1')).toBe(false);
      expect(isSessionInjectableIdle('pty-1')).toBe(false);
      expect(isSessionInAbandonedDialog('pty-1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('F-1272: one-shot (agy --print) com a raiz viva nunca é ocioso para cleanup/park', () => {
    // PTY idle (tela muda) + semântico idle (fallback do avaliador) e mesmo
    // assim o processo segue trabalhando: fechar/estacionar matava o --print.
    harness.oneShotRunning.mockReturnValue(true);
    expect(isSessionIdleForCleanup('pty-agy')).toBe(false);
    applyCanonicalHookEvent({ sessionId: 'pty-agy', event: stop });
    expect(isSessionIdleForCleanup('pty-agy')).toBe(false);
    // Raiz morta: as regras normais voltam.
    harness.oneShotRunning.mockReturnValue(false);
    expect(isSessionIdleForCleanup('pty-agy')).toBe(true);
  });
});

describe('fim de turno sem conteúdo (F-734)', () => {
  const tool: CanonicalHookEvent = { kind: 'status', type: 'start', toolActivity: true };
  const authFailure: CanonicalHookEvent = {
    kind: 'status',
    type: 'stop',
    stopFailure: 'auth',
  };

  it('StopFailure sem ferramenta: turno em erro, sem trabalho, e o pane fica idle/injetável', () => {
    harness.agentInfo.mockReturnValue({ paneId: 'pane-ds' });
    const ends: AgentTurnEndEntry[] = [];
    tapAgentTurnEnd((entry) => ends.push(entry));
    applyCanonicalHookEvent({ sessionId: 'pty-ds', event: userSubmit, now: 1_000 });
    applyCanonicalHookEvent({ sessionId: 'pty-ds', event: authFailure, now: 2_000 });

    const expected: AgentTurnEndEntry = {
      sessionId: 'pty-ds',
      paneId: 'pane-ds',
      sequence: 1,
      outcome: 'error',
      stopFailure: 'auth',
      worked: false,
      observedAt: 2_000,
    };
    expect(ends).toEqual([expected]);
    expect(getAgentLastTurnEnd('pty-ds')).toEqual(expected);
    expect(getAgentToolActivityCount('pty-ds')).toBe(0);
    // A semântica de `done` não muda: o pane está parado no prompt.
    expect(getAgentSemanticStatus('pane-ds')?.status).toBe('completed');
    expect(isSessionInjectableIdle('pty-ds')).toBe(true);
    expect(isAgentAwaitingOperator('pty-ds')).toBe(false);
  });

  it('ferramenta no turno marca trabalho; o turno seguinte começa sem trabalho', () => {
    const ends: AgentTurnEndEntry[] = [];
    tapAgentTurnEnd((entry) => ends.push(entry));
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: tool });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: tool });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: authFailure });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });

    expect(ends.map(({ sequence, outcome, worked, stopFailure }) => ({
      sequence,
      outcome,
      worked,
      stopFailure,
    }))).toEqual([
      { sequence: 1, outcome: 'error', worked: true, stopFailure: 'auth' },
      { sequence: 2, outcome: 'completed', worked: false, stopFailure: undefined },
    ]);
    expect(getAgentToolActivityCount('pty-1')).toBe(2);
    expect(getAgentLastTurnEnd('pty-1')).not.toHaveProperty('stopFailure');
  });

  it('a saída do PTY apaga os fatos de turno da sessão', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: tool });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });
    resetAgentStatusOnExit('pty-1');
    expect(getAgentToolActivityCount('pty-1')).toBe(0);
    expect(getAgentLastTurnEnd('pty-1')).toBeNull();
  });

  it('tap que lança não derruba o reducer', () => {
    tapAgentTurnEnd(() => {
      throw new Error('boom');
    });
    const result = applyCanonicalHookEvent({ sessionId: 'pty-1', event: authFailure });
    expect(result.applied).toBe(true);
    expect(getAgentLastTurnEnd('pty-1')?.stopFailure).toBe('auth');
  });
});

describe('isSessionInjectableIdle — working velho não trava para sempre (deadlock 18/08)', () => {
  it('working FRESCO com PTY idle segue travando (não colar no meio do turno)', () => {
    harness.agentInfo.mockReturnValue({ paneId: 'pane-1' });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
    harness.state = 'idle';
    expect(isSessionInjectableIdle('pty-1')).toBe(false);
  });

  it('working SEM evento por 10+ min com PTY idle LIBERA — o físico vence o hook morto', () => {
    vi.useFakeTimers();
    try {
      harness.agentInfo.mockReturnValue({ paneId: 'pane-1' });
      applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
      harness.state = 'idle';
      // Evidência do banco: semantic 'working' de 16/08 10:28 segurando
      // handoff de 18/08 13:50 — queued, zero tentativas, chef idle no
      // journal do supervisor no mesmo minuto.
      vi.advanceTimersByTime(10 * 60_000 + 1_000);
      expect(isSessionInjectableIdle('pty-1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('awaiting-input (latch de interação) trava em qualquer idade', () => {
    vi.useFakeTimers();
    try {
      harness.agentInfo.mockReturnValue({ paneId: 'pane-1' });
      applyCanonicalHookEvent({ sessionId: 'pty-1', event: permission });
      harness.state = 'idle';
      vi.advanceTimersByTime(60 * 60_000);
      expect(isSessionInjectableIdle('pty-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tool loop re-pulsa o working: staleness só expira sem eventos novos', () => {
    vi.useFakeTimers();
    try {
      harness.agentInfo.mockReturnValue({ paneId: 'pane-1' });
      applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
      harness.state = 'idle';
      vi.advanceTimersByTime(9 * 60_000);
      applyCanonicalHookEvent({ sessionId: 'pty-1', event: start }); // re-pulso
      vi.advanceTimersByTime(9 * 60_000);
      expect(isSessionInjectableIdle('pty-1')).toBe(false); // ainda fresco
      vi.advanceTimersByTime(2 * 60_000);
      expect(isSessionInjectableIdle('pty-1')).toBe(true); // 11 min do último
    } finally {
      vi.useRealTimers();
    }
  });
});
