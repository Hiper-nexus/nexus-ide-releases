import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pty = vi.hoisted(() => ({
  adapters: new Map<string, string>(),
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
}));

vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: (sessionId: string) => {
    const adapterId = pty.adapters.get(sessionId);
    return adapterId ? { adapterId } : null;
  },
  tapSessionData: (tap: (sessionId: string, data: string) => void) => {
    pty.dataTaps.push(tap);
    return () => {
      pty.dataTaps.splice(pty.dataTaps.indexOf(tap), 1);
    };
  },
  tapSessionExit: (tap: (sessionId: string) => void) => {
    pty.exitTaps.push(tap);
    return () => {
      pty.exitTaps.splice(pty.exitTaps.indexOf(tap), 1);
    };
  },
}));

vi.mock('../pty/pty-analysis-runtime', async () => {
  const { PtyAnalysisCore } = await import('../pty/pty-analysis-core');
  return { watchPtyAnalysisSession: (_consumer: string, id: string, config: object, callback: (value: unknown) => void) => {
    let seq = 0;
    const core = new PtyAnalysisCore([], (result) => { for (const event of result.events) if (event.consumer === 'paste') callback(event.value); });
    const feed = (body: object) => core.process({ sessionId: id, generation: 1, workerEpoch: 1, eventSeq: ++seq, observedAt: Date.now(), ...body } as Parameters<typeof core.process>[0]);
    feed({ kind: 'bind', binding: { adapterId: pty.adapters.get(id) } });
    feed({ kind: 'arm', consumer: 'paste', registration: 1, config });
    const tap = (sessionId: string, data: string) => { if (sessionId === id) feed({ kind: 'data', data }); };
    pty.dataTaps.push(tap);
    return () => { const index = pty.dataTaps.indexOf(tap); if (index >= 0) pty.dataTaps.splice(index, 1); core.close(); };
  } };
});

import {
  CODEX_LARGE_PASTE_CHARS,
  DEVIN_LARGE_PASTE_LINES,
  DEVIN_PASTE_MARKER,
  PASTE_INGEST_MAX_MS,
  PASTE_QUIESCE_MS,
  pasteIngestCapMs,
  pasteIngestPlan,
  pasteIngestPlanForSession,
  watchPasteIngest,
  type PasteIngestOutcome,
} from './paste-ingest';

const emit = (sessionId: string, data: string) => {
  for (const tap of [...pty.dataTaps]) tap(sessionId, data);
};

/** Brief de `count` linhas curtas, como o do Nexus. */
const linesOf = (count: number) =>
  Array.from({ length: count }, (_, index) => `linha ${index}`).join('\n');

describe('espera pela ingestão da colagem (F-735)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pty.adapters.clear();
    pty.dataTaps.length = 0;
    pty.exitTaps.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('só o Codex com colagem de 1.000+ caracteres espera; o resto mantém o Enter de sempre', () => {
    expect(pasteIngestPlan('codex', 'x'.repeat(CODEX_LARGE_PASTE_CHARS))).not.toBeNull();
    // 950 caracteres passavam com o Enter de 500 ms (medido no Codex 0.160).
    expect(pasteIngestPlan('codex', 'x'.repeat(950))).toBeNull();
    for (const adapterId of ['claude', 'kimi', 'qwen', 'deepseek', undefined]) {
      expect(pasteIngestPlan(adapterId, 'x'.repeat(9_000))).toBeNull();
      expect(pasteIngestPlan(adapterId, linesOf(120))).toBeNull();
    }
    pty.adapters.set('pty-codex', 'codex');
    expect(pasteIngestPlanForSession('pty-codex', 'x'.repeat(4_531))).not.toBeNull();
    expect(pasteIngestPlanForSession('pty-codex', 'x'.repeat(200))).toBeNull();
    expect(pasteIngestPlanForSession('pty-sem-info', 'x'.repeat(4_531))).toBeNull();
  });

  it('F-743: o Devin espera o marcador quando a colagem tem 20+ linhas (medido no 3000.11.1)', () => {
    // 02/10: brief de 117 linhas largado como `[Pasted text #1 +117 lines]`.
    expect(pasteIngestPlan('devin', linesOf(117))?.marker).toBe(DEVIN_PASTE_MARKER);
    expect(pasteIngestPlan('devin', linesOf(DEVIN_LARGE_PASTE_LINES))).not.toBeNull();
    // 3 e 10 linhas, ou uma linha de 3.000 caracteres, nunca viram marcador:
    // esperar por ele só atrasaria o Enter até o teto.
    expect(pasteIngestPlan('devin', linesOf(10))).toBeNull();
    expect(pasteIngestPlan('devin', 'x'.repeat(3_000))).toBeNull();
    pty.adapters.set('pty-devin', 'devin');
    expect(pasteIngestPlanForSession('pty-devin', linesOf(117))).not.toBeNull();
    expect(pasteIngestPlanForSession('pty-devin', linesOf(3))).toBeNull();
  });

  it('o marcador do Devin casa nas duas formas, mesmo com espaços pulados', () => {
    expect(DEVIN_PASTE_MARKER.test('❭ [Pasted text #1 +117 lines]')).toBe(true);
    expect(DEVIN_PASTE_MARKER.test('[Pasted text #2 (3000 chars)]')).toBe(true);
    expect(DEVIN_PASTE_MARKER.test('[Pastedtext#1+117lines]')).toBe(true);
    expect(DEVIN_PASTE_MARKER.test('Ask Devin to build features')).toBe(false);
  });

  it('o teto cresce com o tamanho da colagem e para em 30 s', () => {
    expect(pasteIngestCapMs(1_000)).toBe(3_500);
    // A entrega de handoff do print (4.531 caracteres) espera até ~8,8 s.
    expect(pasteIngestCapMs(4_531)).toBe(8_797);
    expect(pasteIngestCapMs(1_000_000)).toBe(PASTE_INGEST_MAX_MS);
  });

  it('resolve no marcador desenhado com movimento de cursor no lugar dos espaços', async () => {
    const plan = pasteIngestPlan('codex', 'x'.repeat(4_500))!;
    const watch = watchPasteIngest('pty-codex', plan);
    let outcome: PasteIngestOutcome | null = null;
    void watch.done.then((value) => { outcome = value; });

    // Ingestão em andamento: nenhuma saída com o marcador ainda.
    emit('pty-codex', '\x1b[38;5;8m› \x1b[0m');
    emit('pty-outro', '[Pasted Content 4500 chars]');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(outcome).toBeNull();

    // O ratatui pula espaços com CSI C e o marcador ainda chega partido.
    emit('pty-codex', '\x1b[3;5H[Pasted\x1b[1CCon');
    emit('pty-codex', 'tent\x1b[1C4498\x1b[1Cchars]');
    // F-1282: o marcador só libera com a saída quieta — o eco pode ser
    // ingestião que ainda não acabou (2º bloco a caminho).
    await vi.advanceTimersByTimeAsync(PASTE_QUIESCE_MS);
    expect(outcome).toBe('marker');
    // Resolvida, a espera solta os taps.
    expect(pty.dataTaps).toHaveLength(0);
    expect(pty.exitTaps).toHaveLength(0);
  });

  it('F-1282: colagem em 2+ blocos só libera o Enter depois do ÚLTIMO, com a saída quieta', async () => {
    const plan = pasteIngestPlan('devin', linesOf(147))!;
    const watch = watchPasteIngest('pty-devin', plan);
    let outcome: PasteIngestOutcome | null = null;
    void watch.done.then((value) => { outcome = value; });

    // 1º bloco colapsa no marcador — mas o Devin ainda está ingerindo o
    // resto do brief (campo 11/10: "[Pasted text #1 +47 lines]" seguido de
    // "[Pasted text #2 +100 lines]", Enter nunca aplicado).
    emit('pty-devin', '❯ [Pasted text #1 +47 lines]');
    await vi.advanceTimersByTimeAsync(PASTE_QUIESCE_MS - 1);
    expect(outcome).toBeNull();
    // O 2º bloco chega DEPOIS, ainda dentro da janela de quietação: o eco
    // novo empurra o Enter de novo.
    emit('pty-devin', '❯ [Pasted text #2 +100 lines]');
    await vi.advanceTimersByTimeAsync(PASTE_QUIESCE_MS - 1);
    expect(outcome).toBeNull();
    // Saída quieta pelo prazo inteiro: agora sim o marker conta e o Enter sai.
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('marker');
    expect(pty.dataTaps).toHaveLength(0);
    expect(pty.exitTaps).toHaveLength(0);
  });

  it('marcador antigo no composer não conta: só a saída depois do arme', async () => {
    const plan = pasteIngestPlan('codex', 'x'.repeat(4_500))!;
    emit('pty-codex', '[Pasted Content 4531 chars][Pasted Content 4531 chars] #2');
    const watch = watchPasteIngest('pty-codex', plan);
    let outcome: PasteIngestOutcome | null = null;
    void watch.done.then((value) => { outcome = value; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome).toBeNull();
  });

  it('sem marcador, o teto libera o Enter; sessão que sai resolve na hora', async () => {
    const plan = pasteIngestPlan('codex', 'x'.repeat(4_500))!;
    const capped = watchPasteIngest('pty-a', plan);
    let cappedOutcome: PasteIngestOutcome | null = null;
    void capped.done.then((value) => { cappedOutcome = value; });
    await vi.advanceTimersByTimeAsync(plan.capMs - 1);
    expect(cappedOutcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(cappedOutcome).toBe('cap');

    const exited = watchPasteIngest('pty-b', plan);
    let exitedOutcome: PasteIngestOutcome | null = null;
    void exited.done.then((value) => { exitedOutcome = value; });
    for (const tap of [...pty.exitTaps]) tap('pty-b');
    await vi.advanceTimersByTimeAsync(0);
    expect(exitedOutcome).toBe('exit');
  });

  it('cancelar desarma os taps e o teto sem resolver', async () => {
    const plan = pasteIngestPlan('codex', 'x'.repeat(4_500))!;
    const watch = watchPasteIngest('pty-codex', plan);
    let outcome: PasteIngestOutcome | null = null;
    void watch.done.then((value) => { outcome = value; });
    watch.cancel();
    expect(pty.dataTaps).toHaveLength(0);
    expect(pty.exitTaps).toHaveLength(0);
    emit('pty-codex', '[Pasted Content 4500 chars]');
    await vi.advanceTimersByTimeAsync(PASTE_INGEST_MAX_MS);
    expect(outcome).toBeNull();
  });
});
