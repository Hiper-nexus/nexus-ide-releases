import { describe, expect, it, vi } from 'vitest';
import {
  PTY_TAP_BUDGET,
  PtyDataTapDispatcher,
  type PtyTapBudgetConfig,
} from './pty-tap-dispatcher';

/** Relógio e timers manuais: o teste decide quando o tempo passa. */
function harness(config: Partial<PtyTapBudgetConfig> = {}) {
  let clock = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const traces: Array<Record<string, unknown>> = [];
  const warn = vi.fn();
  const dispatcher = new PtyDataTapDispatcher(
    {
      now: () => clock,
      setTimer: (run, ms) => {
        const id = nextId++;
        timers.set(id, { at: clock + ms, run });
        return id;
      },
      clearTimer: (handle) => {
        timers.delete(handle as number);
      },
      trace: (event) => traces.push(event),
      warn,
    },
    config,
  );
  const advance = (ms: number) => {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = Math.max(clock, due[1].at);
      due[1].run();
    }
    // Um timer que "gastou" tempo (tick) não faz o relógio voltar.
    clock = Math.max(clock, until);
  };
  return {
    dispatcher,
    traces,
    warn,
    advance,
    tick: (ms: number) => {
      clock += ms;
    },
    pendingTimers: () => timers.size,
  };
}

function recorder() {
  const calls: Array<[string, string]> = [];
  const tap = (sessionId: string, data: string) => {
    calls.push([sessionId, data]);
  };
  return { calls, tap };
}

describe('PtyDataTapDispatcher — lote por sessão (F-764 C.1)', () => {
  it('junta os chunks de cada sessão e entrega o texto concatenado, na ordem', () => {
    const h = harness();
    const rec = recorder();
    h.dispatcher.register(rec.tap, { name: 'rec' });
    h.dispatcher.push('a', 'um ');
    h.dispatcher.push('b', 'outro');
    h.dispatcher.push('a', 'dois ');
    h.dispatcher.push('a', 'três');
    expect(rec.calls).toEqual([]);
    h.advance(PTY_TAP_BUDGET.flushMs);
    expect(rec.calls).toEqual([
      ['a', 'um dois três'],
      ['b', 'outro'],
    ]);
    expect(h.pendingTimers()).toBe(0);
  });

  it('lote que passa do teto sai na hora, sem esperar o timer', () => {
    const h = harness({ maxBatchChars: 10 });
    const rec = recorder();
    h.dispatcher.register(rec.tap);
    h.dispatcher.push('s', '12345');
    expect(rec.calls).toEqual([]);
    h.dispatcher.push('s', '67890');
    expect(rec.calls).toEqual([['s', '1234567890']]);
  });

  it('flush entrega o lote de uma sessão na hora; flushAll, de todas', () => {
    const h = harness();
    const rec = recorder();
    h.dispatcher.register(rec.tap);
    h.dispatcher.push('a', 'x');
    h.dispatcher.push('b', 'y');
    h.dispatcher.flush('a');
    expect(rec.calls).toEqual([['a', 'x']]);
    h.dispatcher.flushAll();
    expect(rec.calls).toEqual([
      ['a', 'x'],
      ['b', 'y'],
    ]);
    h.advance(100);
    expect(rec.calls).toHaveLength(2);
  });

  it('tap novo só vê a saída que chega depois do registro', () => {
    const h = harness();
    const old = recorder();
    const late = recorder();
    h.dispatcher.register(old.tap);
    h.dispatcher.push('s', 'antes');
    h.dispatcher.register(late.tap);
    // O registro esvaziou o lote para quem já estava lá.
    expect(old.calls).toEqual([['s', 'antes']]);
    h.dispatcher.push('s', 'depois');
    h.advance(PTY_TAP_BUDGET.flushMs);
    expect(late.calls).toEqual([['s', 'depois']]);
    expect(old.calls).toEqual([
      ['s', 'antes'],
      ['s', 'depois'],
    ]);
  });

  it('tap removido ainda recebe a saída que chegou antes da remoção', () => {
    const h = harness();
    const rec = recorder();
    const dispose = h.dispatcher.register(rec.tap);
    h.dispatcher.push('s', 'pendente');
    dispose();
    expect(rec.calls).toEqual([['s', 'pendente']]);
    h.dispatcher.push('s', 'tarde');
    h.advance(100);
    expect(rec.calls).toEqual([['s', 'pendente']]);
  });

  it('tap que se desliga no meio da entrega não derruba os outros nem recebe de novo', () => {
    const h = harness();
    const seen: string[] = [];
    let dispose: () => void = () => {};
    const selfRemoving = (_s: string, data: string) => {
      seen.push(`a:${data}`);
      dispose();
    };
    dispose = h.dispatcher.register(selfRemoving);
    h.dispatcher.register((_s, data) => seen.push(`b:${data}`));
    h.dispatcher.push('s', 'x');
    h.advance(PTY_TAP_BUDGET.flushMs);
    h.dispatcher.push('s', 'y');
    h.advance(PTY_TAP_BUDGET.flushMs);
    expect(seen).toEqual(['a:x', 'b:x', 'b:y']);
  });

  it('tap que lança vira aviso e o próximo tap roda', () => {
    const h = harness();
    const rec = recorder();
    h.dispatcher.register(() => {
      throw new Error('quebrou');
    });
    h.dispatcher.register(rec.tap);
    h.dispatcher.push('s', 'x');
    h.advance(PTY_TAP_BUDGET.flushMs);
    expect(rec.calls).toEqual([['s', 'x']]);
    expect(h.warn).toHaveBeenCalledWith(
      '[pty-manager] orchestration tap threw:',
      expect.any(Error),
    );
  });

  it('o mesmo callback registrado duas vezes é um registro só', () => {
    const h = harness();
    const rec = recorder();
    h.dispatcher.register(rec.tap);
    const second = h.dispatcher.register(rec.tap);
    h.dispatcher.push('s', 'x');
    h.advance(PTY_TAP_BUDGET.flushMs);
    expect(rec.calls).toEqual([['s', 'x']]);
    second();
    h.dispatcher.push('s', 'y');
    h.advance(PTY_TAP_BUDGET.flushMs);
    expect(rec.calls).toEqual([['s', 'x']]);
  });

  it('tap immediate recebe cada chunk na chegada, antes do lote', () => {
    const h = harness();
    const order: string[] = [];
    h.dispatcher.register((_s, data) => order.push(`lote:${data}`), { name: 'lote' });
    h.dispatcher.register((_s, data) => order.push(`já:${data}`), {
      name: 'portão',
      delivery: 'immediate',
    });
    h.dispatcher.push('s', 'a');
    h.dispatcher.push('s', 'b');
    expect(order).toEqual(['já:a', 'já:b']);
    h.advance(PTY_TAP_BUDGET.flushMs);
    expect(order).toEqual(['já:a', 'já:b', 'lote:ab']);
  });

  it('sem taps em lote nada fica guardado', () => {
    const h = harness();
    h.dispatcher.register(() => {}, { delivery: 'immediate' });
    h.dispatcher.push('s', 'x');
    expect(h.dispatcher.pendingChars('s')).toBe(0);
    expect(h.pendingTimers()).toBe(0);
  });

  it('drop descarta o lote sem entregar', () => {
    const h = harness();
    const rec = recorder();
    h.dispatcher.register(rec.tap);
    h.dispatcher.push('s', 'x');
    h.dispatcher.drop('s');
    h.advance(100);
    expect(rec.calls).toEqual([]);
  });

  it('tick longo cede o main e entrega o resto no tick seguinte', () => {
    const h = harness({ sliceBudgetMs: 50 });
    const delivered: string[] = [];
    h.dispatcher.register((sessionId) => {
      delivered.push(sessionId);
      h.tick(30); // cada entrega "custa" 30 ms
    });
    h.dispatcher.push('a', '1');
    h.dispatcher.push('b', '2');
    h.dispatcher.push('c', '3');
    h.advance(PTY_TAP_BUDGET.flushMs);
    // a + b passam de 50 ms: o tick cede e c fica para o timer seguinte.
    expect(delivered).toEqual(['a', 'b']);
    expect(h.pendingTimers()).toBe(1);
    h.advance(0);
    expect(delivered).toEqual(['a', 'b', 'c']);
    expect(h.pendingTimers()).toBe(0);
  });
});

describe('PtyDataTapDispatcher — tempo por tap (F-764 A.3)', () => {
  it('tap acima de 50 ms vira trace com o nome registrado, com teto de frequência', () => {
    const h = harness();
    let cost = 60;
    h.dispatcher.register(() => h.tick(cost), { name: 'lento' });
    h.dispatcher.push('s', 'abc');
    h.advance(PTY_TAP_BUDGET.flushMs);
    expect(h.traces).toEqual([
      expect.objectContaining({
        kind: 'pty-tap-slow',
        tapKind: 'data',
        tap: 'lento',
        sessionId: 's',
        ms: 60,
        chars: 3,
      }),
    ]);
    // Dentro de 10 s: suprimido e contado.
    cost = 70;
    h.dispatcher.push('s', 'd');
    h.advance(PTY_TAP_BUDGET.flushMs);
    expect(h.traces).toHaveLength(1);
    h.advance(PTY_TAP_BUDGET.slowTraceEveryMs);
    cost = 55;
    h.dispatcher.push('s', 'e');
    h.advance(PTY_TAP_BUDGET.flushMs);
    expect(h.traces.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'pty-tap-slow',
        tap: 'lento',
        ms: 55,
        suppressed: 1,
        maxSuppressedMs: 70,
      }),
    );
  });

  it('entrega acima de 100 ms vira pty-tap-batch-slow com o tap mais lento', () => {
    const h = harness();
    h.dispatcher.register(() => h.tick(40), { name: 'a' });
    h.dispatcher.register(() => h.tick(45), { name: 'b' });
    h.dispatcher.register(() => h.tick(30), { name: 'c' });
    h.dispatcher.push('s', 'x');
    h.dispatcher.push('s', 'y');
    h.advance(PTY_TAP_BUDGET.flushMs);
    expect(h.traces).toEqual([
      expect.objectContaining({
        kind: 'pty-tap-batch-slow',
        tapKind: 'data',
        sessionId: 's',
        ms: 115,
        chars: 2,
        chunks: 2,
        taps: 3,
        slowestTap: 'b',
        slowestMs: 45,
      }),
    ]);
  });

  it('o cronômetro também cobre os taps de outros tipos (estado, saída)', () => {
    const h = harness();
    h.dispatcher.budget.call('state', 'trava', 's', 0, () => h.tick(51));
    expect(h.traces).toEqual([
      expect.objectContaining({ kind: 'pty-tap-slow', tapKind: 'state', tap: 'trava' }),
    ]);
  });
});

describe('PtyDataTapDispatcher — inundação (F-764 C.2)', () => {
  const KB = 1024;
  const line = (index: number, size: number) =>
    `${String(index).padStart(8, '0')} ${'x'.repeat(size - 10)}\n`;

  /** Despeja `charsPerSec` em chunks de `size` por `seconds` de relógio. */
  function stream(
    h: ReturnType<typeof harness>,
    sessionId: string,
    seconds: number,
    charsPerSec: number,
    size = KB,
  ): string[] {
    const intervalMs = (size / charsPerSec) * 1_000;
    const count = Math.round((seconds * 1_000) / intervalMs);
    const sent: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const chunk = line(index, size);
      sent.push(chunk);
      h.dispatcher.push(sessionId, chunk);
      h.advance(intervalMs);
    }
    return sent;
  }

  function taps(h: ReturnType<typeof harness>) {
    const analysis: string[] = [];
    const complete: string[] = [];
    h.dispatcher.register((_s, data) => analysis.push(data), { name: 'análise' });
    h.dispatcher.register((_s, data) => complete.push(data), {
      name: 'anel',
      delivery: 'complete',
    });
    return { analysis, complete };
  }

  it('5 MB/s: análise recebe só o tail limitado; complete recebe tudo; trace pty-flood', () => {
    const h = harness();
    const { analysis, complete } = taps(h);
    // 1 s para a janela de vazão detectar a inundação (rajada inicial).
    const warmup = stream(h, 's', 1, 5 * KB * KB);
    expect(h.dispatcher.isFlooding('s')).toBe(true);
    const analysisBefore = analysis.length;
    const sent = stream(h, 's', 2, 5 * KB * KB);
    h.dispatcher.flush('s');
    const total = sent.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(total).toBeGreaterThanOrEqual(10 * KB * KB - KB);
    // O anel do pane (complete) não perde um byte.
    expect(complete.join('')).toBe([...warmup, ...sent].join(''));
    // Em regime, a análise vê no máximo 16 KB a cada 250 ms: ~8 entregas em
    // 2 s (+1 do flush final), ~128 KB para 10 MB despejados.
    const steady = analysis.slice(analysisBefore);
    const steadyChars = steady.reduce((sum, data) => sum + data.length, 0);
    expect(steady.length).toBeLessThanOrEqual(2_000 / PTY_TAP_BUDGET.floodAnalysisMs + 2);
    expect(Math.max(...steady.map((data) => data.length))).toBeLessThanOrEqual(
      PTY_TAP_BUDGET.floodTailChars,
    );
    expect(steadyChars).toBeLessThanOrEqual(
      (2_000 / PTY_TAP_BUDGET.floodAnalysisMs + 2) * PTY_TAP_BUDGET.floodTailChars,
    );
    // A rajada de detecção também é limitada: ~a vazão de entrada de 1 s.
    const burstChars = analysis
      .slice(0, analysisBefore)
      .reduce((sum, data) => sum + data.length, 0);
    expect(burstChars).toBeLessThanOrEqual(
      PTY_TAP_BUDGET.floodEnterCharsPerSec + 6 * PTY_TAP_BUDGET.floodTailChars,
    );
    // A última entrega termina no fim do fluxo e começa numa linha inteira.
    const last = steady.at(-1)!;
    expect(sent.join('').endsWith(last)).toBe(true);
    expect(last).toMatch(/^\d{8} x/);
    expect(h.traces.filter((event) => event.kind === 'pty-flood')).toEqual([
      expect.objectContaining({
        kind: 'pty-flood',
        sessionId: 's',
        tailChars: PTY_TAP_BUDGET.floodTailChars,
        analysisEveryMs: PTY_TAP_BUDGET.floodAnalysisMs,
      }),
    ]);
    const flood = h.traces.find((event) => event.kind === 'pty-flood')!;
    expect(flood.charsPerSec as number).toBeGreaterThan(PTY_TAP_BUDGET.floodEnterCharsPerSec);
  });

  it('a inundação acaba com a vazão baixa: pty-flood-end e análise volta ao lote inteiro', () => {
    const h = harness();
    const { analysis } = taps(h);
    stream(h, 's', 1, 5 * KB * KB);
    h.advance(2_000);
    analysis.length = 0;
    h.dispatcher.push('s', 'calmo\n');
    h.advance(PTY_TAP_BUDGET.flushMs);
    expect(h.dispatcher.isFlooding('s')).toBe(false);
    expect(analysis.join('')).toContain('calmo\n');
    const end = h.traces.find((event) => event.kind === 'pty-flood-end');
    expect(end).toEqual(
      expect.objectContaining({ kind: 'pty-flood-end', sessionId: 's', reason: 'rate' }),
    );
    expect(end!.droppedChars as number).toBeGreaterThan(4 * KB * KB);
  });

  it('abaixo de 512 K/s nada é podado', () => {
    const h = harness();
    const { analysis, complete } = taps(h);
    const sent = stream(h, 's', 2, 400 * KB);
    h.dispatcher.flush('s');
    expect(analysis.join('')).toBe(sent.join(''));
    expect(complete.join('')).toBe(sent.join(''));
    expect(h.traces.some((event) => event.kind === 'pty-flood')).toBe(false);
  });

  it('histerese: entre 256 K e 512 K/s a inundação continua', () => {
    const h = harness();
    taps(h);
    stream(h, 's', 1, 2 * KB * KB);
    expect(h.dispatcher.isFlooding('s')).toBe(true);
    stream(h, 's', 2, 384 * KB);
    expect(h.dispatcher.isFlooding('s')).toBe(true);
    stream(h, 's', 2, 128 * KB);
    expect(h.dispatcher.isFlooding('s')).toBe(false);
  });

  it('evento do Main (flush) entrega o tail na hora, fora da cadência', () => {
    const h = harness();
    const { analysis } = taps(h);
    stream(h, 's', 1, 5 * KB * KB);
    const before = analysis.length;
    h.dispatcher.push('s', 'antes-da-escrita\n');
    h.dispatcher.flush('s');
    expect(analysis.length).toBe(before + 1);
    expect(analysis.at(-1)!.endsWith('antes-da-escrita\n')).toBe(true);
  });

  it('trace pty-flood no máximo um por sessão por minuto, com os suprimidos contados', () => {
    const h = harness();
    taps(h);
    const floodThenCalm = () => {
      stream(h, 's', 1, 5 * KB * KB);
      h.advance(3_000);
      h.dispatcher.push('s', 'calmo\n');
      h.advance(PTY_TAP_BUDGET.flushMs);
    };
    floodThenCalm();
    floodThenCalm();
    expect(h.traces.filter((event) => event.kind === 'pty-flood')).toHaveLength(1);
    h.advance(PTY_TAP_BUDGET.floodTraceEveryMs);
    floodThenCalm();
    const floods = h.traces.filter((event) => event.kind === 'pty-flood');
    expect(floods).toHaveLength(2);
    expect(floods[1]).toEqual(expect.objectContaining({ suppressedFloods: 1 }));
  });

  it('sessão que sai inundando fecha o episódio com reason exit', () => {
    const h = harness();
    taps(h);
    stream(h, 's', 1, 5 * KB * KB);
    h.dispatcher.flush('s');
    h.dispatcher.drop('s');
    expect(h.traces.at(-1)).toEqual(
      expect.objectContaining({ kind: 'pty-flood-end', sessionId: 's', reason: 'exit' }),
    );
  });

  it('o tail cortado começa numa linha inteira', () => {
    const h = harness({ floodTailChars: 100 });
    const { analysis } = taps(h);
    stream(h, 's', 1, 5 * KB * KB, 64);
    expect(h.dispatcher.isFlooding('s')).toBe(true);
    analysis.length = 0;
    stream(h, 's', 1, 5 * KB * KB, 64);
    h.dispatcher.flush('s');
    expect(analysis.length).toBeGreaterThan(0);
    for (const data of analysis) {
      expect(data.length).toBeLessThanOrEqual(100);
      expect(data).toMatch(/^\d{8} /);
    }
  });
});
