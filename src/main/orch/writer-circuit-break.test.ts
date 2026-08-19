import { afterEach, describe, expect, it } from 'vitest';
import { firstWaveCanSeat } from '../adapters/seat-auth-readiness';
import {
  WRITER_CIRCUIT_BREAK_FAILURES,
  WRITER_CIRCUIT_BREAK_KIND,
  WriterCircuitRegistry,
  nextAuthedAdapterIds,
  proveWriterConnectedAndWritable,
  writerCircuitBreakEvent,
  writerCircuitBreakMessage,
  writerCircuitBreakers,
  writerIsLive,
  writerIsLiveFromSession,
} from './writer-circuit-break';

afterEach(() => {
  writerCircuitBreakers.reset();
});

const kimiWorker = {
  adapterId: 'kimi',
  role: 'worker',
  missionId: 'mission-1',
} as const;

describe('writerIsLive — connected + stdin writable', () => {
  it('só é vivo com liveness live E stdin writable', () => {
    expect(
      writerIsLive({ sessionLiveness: 'live', stdinWritable: true }),
    ).toBe(true);
    expect(
      writerIsLive({ sessionLiveness: 'live', stdinWritable: false }),
    ).toBe(false);
    expect(
      writerIsLive({ sessionLiveness: 'exited', stdinWritable: true }),
    ).toBe(false);
    expect(
      writerIsLive({ sessionLiveness: 'unverifiable', stdinWritable: true }),
    ).toBe(false);
  });

  it('spawning/idle/busy conectados contam; null não', () => {
    expect(writerIsLiveFromSession('spawning', true)).toBe(true);
    expect(writerIsLiveFromSession('idle', true)).toBe(true);
    expect(writerIsLiveFromSession('busy', false)).toBe(false);
    expect(writerIsLiveFromSession(null, true)).toBe(false);
  });
});

describe('WriterCircuitRegistry — 3 falhas → remint / skip-silent', () => {
  it('abaixo de 3 ainda pode sentar o mesmo adapter', () => {
    const b = new WriterCircuitRegistry();
    b.recordConnectFailure(kimiWorker);
    b.recordConnectFailure(kimiWorker);
    expect(b.canSeat(kimiWorker)).toBe(true);
    expect(b.isTripped(kimiWorker)).toBe(false);
    expect(b.decideAfterFailure(kimiWorker, ['codex'])).toBe('seat');
  });

  it('3 falhas remintam para o próximo adapter autenticado — sem 4º assento', () => {
    const b = new WriterCircuitRegistry();
    b.recordConnectFailure(kimiWorker);
    b.recordConnectFailure(kimiWorker);
    expect(b.recordConnectFailure(kimiWorker)).toBe(3);
    expect(b.isTripped(kimiWorker)).toBe(true);
    expect(b.canSeat(kimiWorker)).toBe(false);
    expect(b.decideAfterFailure(kimiWorker, ['kimi', 'codex', 'glm'])).toBe(
      'remint',
    );
    expect(b.canSeat(kimiWorker)).toBe(false);
  });

  it('3 falhas sem próximo adapter autenticado = skip-silent', () => {
    const b = new WriterCircuitRegistry();
    b.recordConnectFailure(kimiWorker);
    b.recordConnectFailure(kimiWorker);
    b.recordConnectFailure(kimiWorker);
    expect(b.decideAfterFailure(kimiWorker, ['kimi'])).toBe('skip-silent');
    expect(b.decideAfterFailure(kimiWorker, [])).toBe('skip-silent');
  });

  it('prova de vida (connected+writable) zera a contagem', () => {
    const b = new WriterCircuitRegistry();
    b.recordConnectFailure(kimiWorker);
    b.recordConnectFailure(kimiWorker);
    b.recordConnectSuccess(kimiWorker);
    expect(b.failureCount(kimiWorker)).toBe(0);
    expect(b.canSeat(kimiWorker)).toBe(true);
  });

  it('não vaza entre missões nem papéis', () => {
    const b = new WriterCircuitRegistry();
    b.recordConnectFailure(kimiWorker);
    b.recordConnectFailure(kimiWorker);
    b.recordConnectFailure(kimiWorker);
    expect(
      b.canSeat({
        adapterId: 'kimi',
        role: 'worker',
        missionId: 'mission-2',
      }),
    ).toBe(true);
    expect(
      b.canSeat({
        adapterId: 'kimi',
        role: 'orchestrator',
        missionId: 'mission-1',
      }),
    ).toBe(true);
    expect(
      b.canSeat({
        adapterId: 'codex',
        role: 'worker',
        missionId: 'mission-1',
      }),
    ).toBe(true);
  });

  it('registry global recusa o 4º assento após 3 mortes', () => {
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    writerCircuitBreakers.recordConnectFailure(kimiWorker);
    expect(writerCircuitBreakers.canSeat(kimiWorker)).toBe(false);
    expect(WRITER_CIRCUIT_BREAK_FAILURES).toBe(3);
  });
});

describe('writer_circuit_break log + remint roster', () => {
  it('evento de log usa kind writer_circuit_break', () => {
    const event = writerCircuitBreakEvent({
      key: kimiWorker,
      failures: 3,
      action: 'remint',
      sessionId: 'sess-1',
    });
    expect(event.kind).toBe(WRITER_CIRCUIT_BREAK_KIND);
    expect(event.kind).toBe('writer_circuit_break');
    expect(event.adapterId).toBe('kimi');
    expect(event.action).toBe('remint');
    expect(writerCircuitBreakMessage(kimiWorker)).toContain(
      'writer_circuit_break',
    );
    expect(writerCircuitBreakMessage(kimiWorker)).not.toMatch(
      /cole sua api key/i,
    );
  });

  it('nextAuthedAdapterIds só inclui present — remint silencioso', () => {
    expect(
      nextAuthedAdapterIds(
        [
          { adapterId: 'kimi', readiness: 'incomplete' },
          { adapterId: 'longcat', readiness: 'no-credential' },
          { adapterId: 'codex', readiness: 'present' },
          { adapterId: 'glm', readiness: 'missing' },
        ],
        'kimi',
      ),
    ).toEqual(['codex']);
  });
});

describe('proveWriterConnectedAndWritable', () => {
  it('espera até connected+writable', async () => {
    let writable = false;
    const ready = proveWriterConnectedAndWritable('s1', {
      timeoutMs: 200,
      pollMs: 10,
      deps: {
        getState: () => 'spawning',
        isStdinWritable: () => writable,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    });
    setTimeout(() => {
      writable = true;
    }, 30);
    await expect(ready).resolves.toBe(true);
  });

  it('timeout sem stdin writable não conta o writer como vivo', async () => {
    const ready = await proveWriterConnectedAndWritable('s1', {
      timeoutMs: 40,
      pollMs: 10,
      deps: {
        getState: () => 'spawning',
        isStdinWritable: () => false,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    });
    expect(ready).toBe(false);
  });

  it('sessão ausente nunca fica live', async () => {
    const ready = await proveWriterConnectedAndWritable('gone', {
      timeoutMs: 20,
      pollMs: 5,
      deps: {
        getState: () => null,
        isStdinWritable: () => true,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    });
    expect(ready).toBe(false);
  });
});

describe('3 mortes do mesmo adapter não geram 4º assento', () => {
  it('first-wave não re-senta Kimi morta após circuit-break 3', () => {
    const b = new WriterCircuitRegistry();
    const kimiPresent = {
      adapterId: 'kimi',
      authStrategy: 'subscription' as const,
      kimiListReadiness: 'present' as const,
    };
    expect(firstWaveCanSeat(kimiPresent)).toBe(true);
    b.recordConnectFailure(kimiWorker);
    b.recordConnectFailure(kimiWorker);
    b.recordConnectFailure(kimiWorker);
    expect(b.canSeat(kimiWorker)).toBe(false);
    expect(b.decideAfterFailure(kimiWorker, ['codex'])).toBe('remint');
    expect(
      firstWaveCanSeat(kimiPresent) && b.canSeat(kimiWorker),
    ).toBe(false);
  });

  it('decide remint e recusa o 4º seat de Kimi', () => {
    const b = new WriterCircuitRegistry();
    const seats: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      seats.push(b.canSeat(kimiWorker));
      if (b.canSeat(kimiWorker)) b.recordConnectFailure(kimiWorker);
    }
    expect(seats).toEqual([true, true, true, false]);
    expect(b.decideAfterFailure(kimiWorker, ['codex'])).toBe('remint');
    expect(b.canSeat(kimiWorker)).toBe(false);
  });
});
