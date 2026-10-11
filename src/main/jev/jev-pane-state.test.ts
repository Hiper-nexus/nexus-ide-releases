import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JevResult, judge as jevJudge } from './jev-client';
import type { ScreenDetectionRecord } from '../detect/detector';
import {
  classifyPaneTailForDigest,
  getJevPaneHint,
  startJevPaneStateClassifier,
  type JevPaneStateDeps,
} from './jev-pane-state';

vi.mock('./jev-decision-log', () => ({
  recordJevDecision: vi.fn(() => 'id'),
  recordJevOptimization: vi.fn(() => 'id'),
  jevAnswerProbabilities: vi.fn(() => ({})),
  jevAnswerConfidences: vi.fn(() => ({})),
}));

function record(over: Partial<ScreenDetectionRecord> = {}): ScreenDetectionRecord {
  return {
    sessionId: 's1',
    paneId: 'p1',
    adapterId: 'claude',
    manifestId: 'claude',
    manifestVersion: '1',
    state: 'unknown',
    visibleIdle: false,
    visibleBlocker: false,
    visibleWorking: false,
    matchedRuleId: null,
    fallbackReason: null,
    at: Date.now(),
    ...over,
  };
}

function jevResult(choice = 'waiting_for_human', needsHuman = 0.9): JevResult {
  return {
    model: 'jev-1.13.0',
    usage: { input_tokens: 100, output_tokens: 10 },
    answers: {
      state: {
        type: 'choice',
        choice,
        probabilities: { [choice]: 0.9 },
        confidence: 0.9,
      },
      needs_human: { type: 'noul', noul: needsHuman },
    },
  };
}

const disposers: Array<() => void> = [];

function start(deps: JevPaneStateDeps): () => void {
  const dispose = startJevPaneStateClassifier(deps);
  disposers.push(dispose);
  return dispose;
}

function harness(over: Partial<JevPaneStateDeps> = {}) {
  const taps = new Set<(r: ScreenDetectionRecord) => void>();
  const exits = new Set<(s: string) => void>();
  const deps: JevPaneStateDeps = {
    tapDetections: (cb) => {
      taps.add(cb);
      return () => taps.delete(cb);
    },
    tapExit: (cb) => {
      exits.add(cb);
      return () => exits.delete(cb);
    },
    screenText: () => 'screen text',
    enabled: () => true,
    hasKey: () => true,
    broadcast: vi.fn(),
    narrate: vi.fn(),
    paneLabel: () => 'Worker 3',
    ...over,
  };
  const emit = (r: ScreenDetectionRecord) => taps.forEach((cb) => cb(r));
  const exit = (s: string) => exits.forEach((cb) => cb(s));
  return { deps, emit, exit };
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('jev-pane-state classifier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const d of disposers) d();
    disposers.length = 0;
  });

  it('no-op quando o detector não está ativo', () => {
    const dispose = startJevPaneStateClassifier({ tapDetections: () => null });
    expect(dispose).toBeTypeOf('function');
  });

  it('debounce: 15s de silêncio dispara UMA classificação', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => jevResult());
    const { deps, emit } = harness({ judge });
    start(deps);
    emit(record());
    await advance(10_000);
    emit(record());
    await advance(14_999);
    expect(judge).not.toHaveBeenCalled();
    await advance(2);
    expect(judge).toHaveBeenCalledTimes(1);
    const hint = getJevPaneHint('s1');
    expect(hint).toMatchObject({ state: 'waiting_for_human', needsHuman: 0.9 });
    expect(deps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', paneId: 'p1', hint }),
    );
  });

  it('só dispara em unknown ou idle com fallbackReason', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => jevResult());
    const { deps, emit } = harness({ judge });
    start(deps);
    emit(record({ state: 'working' }));
    emit(record({ state: 'blocked' }));
    emit(record({ state: 'idle', fallbackReason: null }));
    await advance(60_000);
    expect(judge).not.toHaveBeenCalled();
    emit(record({ state: 'idle', fallbackReason: 'no-rule' }));
    await advance(15_001);
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('dedupe por hash: mesmo texto não classifica de novo', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => jevResult());
    const { deps, emit } = harness({ judge });
    start(deps);
    emit(record());
    await advance(75_000); // passa o min-interval também
    emit(record());
    await advance(15_001);
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('intervalo mínimo de 60s por sessão', async () => {
    let text = 'v1';
    const judge = vi.fn<typeof jevJudge>(async () => jevResult());
    const { deps, emit } = harness({
      judge,
      screenText: () => text,
    });
    start(deps);
    emit(record());
    await advance(15_001);
    expect(judge).toHaveBeenCalledTimes(1);
    text = 'v2';
    emit(record());
    await advance(15_001); // ~30s desde a chamada
    expect(judge).toHaveBeenCalledTimes(1);
    text = 'v3';
    await advance(30_000); // t≈60s
    emit(record());
    await advance(15_001); // dispara aos ~75s → >60s desde a chamada
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('toggle off ou sem chave: nunca chama o judge', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => jevResult());
    for (const extra of [{ enabled: () => false }, { hasKey: () => false }]) {
      const { deps, emit } = harness({ judge, ...extra });
      start(deps);
      emit(record());
      await advance(20_000);
      expect(judge).not.toHaveBeenCalled();
    }
  });

  it('judge null: sem hint, sem broadcast, sem erro', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => null);
    const { deps, emit } = harness({ judge });
    start(deps);
    emit(record());
    await advance(15_001);
    expect(getJevPaneHint('s1')).toBeNull();
    expect(deps.broadcast).not.toHaveBeenCalled();
  });

  it('choice inválida não gera hint', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => jevResult('bogus'));
    const { deps, emit } = harness({ judge });
    start(deps);
    emit(record());
    await advance(15_001);
    expect(getJevPaneHint('s1')).toBeNull();
  });

  it('exit limpa hint e timer', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => jevResult());
    const { deps, emit, exit } = harness({ judge });
    start(deps);
    emit(record());
    await advance(15_001);
    expect(getJevPaneHint('s1')).not.toBeNull();
    exit('s1');
    expect(getJevPaneHint('s1')).toBeNull();
    emit(record());
    exit('s1');
    await advance(30_000);
    expect(judge).toHaveBeenCalledTimes(1); // timer limpo, não classificou de novo
  });

  it('waiting_for_human + needsHuman ≥ 0.75 narra UMA vez por 10 min', async () => {
    let i = 0;
    const judge = vi.fn<typeof jevJudge>(async () =>
      jevResult('waiting_for_human', 0.9),
    );
    const { deps, emit } = harness({
      judge,
      screenText: () => `texto-v${i++}`, // texto novo a cada chamada
    });
    start(deps);
    emit(record());
    await advance(15_001); // classificação 1 (~t=15s), narrate 1
    expect(deps.narrate).toHaveBeenCalledWith(
      'O pane Worker 3 precisa de você.',
      'p1',
    );
    await advance(45_000);
    emit(record());
    await advance(15_001); // classificação 2 (~t=75s): narrate dentro dos 10min
    expect(judge).toHaveBeenCalledTimes(2);
    expect(deps.narrate).toHaveBeenCalledTimes(1);
    await advance(540_000);
    emit(record());
    await advance(15_001); // classificação 3 (~t=630s): >10min → narra de novo
    expect(deps.narrate).toHaveBeenCalledTimes(2);
  });

  it('needsHuman < 0.75 ou outro estado: não narra', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => jevResult('waiting_for_human', 0.5));
    const { deps, emit } = harness({ judge });
    start(deps);
    emit(record());
    await advance(15_001);
    expect(deps.narrate).not.toHaveBeenCalled();
  });
});

describe('classifyPaneTailForDigest (digest do pane_read)', () => {
  it('does not replay cached state after provider, variant, credential or consent changes', async () => {
    let configuration = 'jev';
    const judge = vi.fn<typeof jevJudge>(async () => jevResult('working', 0));
    const deps = { judge, enabled: () => true, hasKey: () => true, configurationKey: () => configuration };
    await classifyPaneTailForDigest('configuration-switch-tail', deps);
    for (const next of ['clef', 'clef-flash', 'rotated-key']) {
      configuration = next; await classifyPaneTailForDigest('configuration-switch-tail', deps);
    }
    expect(judge).toHaveBeenCalledTimes(4);
    expect(await classifyPaneTailForDigest('configuration-switch-tail', { ...deps, enabled: () => false })).toBeNull();
    expect(await classifyPaneTailForDigest('configuration-switch-tail', { ...deps, hasKey: () => false })).toBeNull();
  });
  const digestDeps = (judge: typeof jevJudge, now = 1_000_000) => ({
    judge,
    enabled: () => true,
    hasKey: () => true,
    now: () => now,
  });

  it('resposta válida do Jev vira estado/confiança/needsHuman', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => jevResult('working', 0.2));
    const result = await classifyPaneTailForDigest('tail text', digestDeps(judge));
    expect(result).toEqual({
      state: 'working',
      confidence: 0.9,
      needsHuman: 0.2,
    });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0]![0]).toMatchObject({
      surface: 'paneState',
      timeoutMs: 4_000,
    });
  });

  it('judge null ou choice inválida → null (fail-open)', async () => {
    expect(
      await classifyPaneTailForDigest('x', digestDeps(
        vi.fn<typeof jevJudge>(async () => null), 2_000_000)),
    ).toBeNull();
    expect(
      await classifyPaneTailForDigest('y', digestDeps(
        vi.fn<typeof jevJudge>(async () => jevResult('bogus')), 3_000_000)),
    ).toBeNull();
    expect(
      await classifyPaneTailForDigest('z', digestDeps(
        vi.fn<typeof jevJudge>(async () => { throw new Error('timeout'); }), 4_000_000)),
    ).toBeNull();
  });

  it('surface off ou sem credencial → null sem chamar o juiz', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => jevResult());
    const base = digestDeps(judge, 5_000_000);
    expect(
      await classifyPaneTailForDigest('a', { ...base, enabled: () => false }),
    ).toBeNull();
    expect(
      await classifyPaneTailForDigest('b', { ...base, hasKey: () => false }),
    ).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it('mesmo texto dentro de 60 s não repete a chamada (cache por hash)', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => jevResult('idle_prompt', 0));
    const deps = digestDeps(judge, 6_000_000);
    const first = await classifyPaneTailForDigest('same tail', deps);
    const second = await classifyPaneTailForDigest('same tail', deps);
    expect(second).toEqual(first);
    expect(judge).toHaveBeenCalledTimes(1);
    // Passados 60 s, o mesmo texto chama de novo.
    expect((await import('./jev-decision-log')).recordJevOptimization).toHaveBeenCalledWith(expect.objectContaining({ model: 'jev-1.13.0' }));
    const later = await classifyPaneTailForDigest('same tail', digestDeps(judge, 6_061_000));
    expect(later).toEqual(first);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('remembers a missing or invalid answer briefly, so an outage costs one call, not one per digest', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => null);
    const deps = (now: number, configurationKey = 'cfg') => ({ ...digestDeps(judge, now), configurationKey: () => configurationKey });
    expect(await classifyPaneTailForDigest('outage tail', deps(8_000_000))).toBeNull();
    expect(await classifyPaneTailForDigest('outage tail', deps(8_019_000))).toBeNull();
    expect(judge).toHaveBeenCalledTimes(1);
    expect(await classifyPaneTailForDigest('outage tail', deps(8_021_000))).toBeNull();
    expect(judge).toHaveBeenCalledTimes(2);
    // A configuration change (new key, provider or consent) never reuses the remembered failure.
    await classifyPaneTailForDigest('outage tail', deps(8_022_000, 'rotated'));
    expect(judge).toHaveBeenCalledTimes(3);
    // The brief memory does not count as a saved billable request.
    const optimization = (await import('./jev-decision-log')).recordJevOptimization;
    vi.mocked(optimization).mockClear();
    await classifyPaneTailForDigest('outage tail', deps(8_023_000, 'rotated'));
    expect(optimization).not.toHaveBeenCalled();
    const invalid = vi.fn<typeof jevJudge>(async () => jevResult('bogus'));
    await classifyPaneTailForDigest('bogus tail', { ...digestDeps(invalid, 9_000_000), configurationKey: () => 'cfg' });
    await classifyPaneTailForDigest('bogus tail', { ...digestDeps(invalid, 9_005_000), configurationKey: () => 'cfg' });
    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it('só os últimos 3.000 chars vão para o juiz', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => jevResult('working', 0));
    const text = `${'x'.repeat(5_000)}FIM`;
    await classifyPaneTailForDigest(text, digestDeps(judge, 7_000_000));
    const screen = (judge.mock.calls[0]![0].state as { screen: string }).screen;
    expect(screen.length).toBe(3_000);
    expect(screen.endsWith('FIM')).toBe(true);
  });
});

describe('F-1164: missionId chega ao judge no paneState', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    for (const d of disposers) d();
    disposers.length = 0;
  });

  it('digest: a missão de quem lê vai ao judge', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => jevResult('working', 0));
    await classifyPaneTailForDigest('mission-tail-propagation', {
      judge, enabled: () => true, hasKey: () => true, configurationKey: () => 'k-mission', missionId: 'm-digest',
    });
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ surface: 'paneState', missionId: 'm-digest' }));
  });

  it('classificador: a missão do pane (registro) vai ao judge com a sessão', async () => {
    const judge = vi.fn<typeof jevJudge>(async () => jevResult());
    const missionOf = vi.fn((sessionId: string) => (sessionId === 's1' ? 'm-pane' : undefined));
    const { deps, emit } = harness({ judge, missionOf, screenText: () => 'mission screen text' });
    start(deps);
    emit(record());
    await advance(15_001);
    expect(missionOf).toHaveBeenCalledWith('s1');
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ surface: 'paneState', sessionId: 's1', missionId: 'm-pane' }));
  });
});

describe('P2-4: recusa por orçamento não envenena o cache do digest', () => {
  it("null por 'budget' não vira falha lembrada para outra missão", async () => {
    const judge = vi.fn<typeof jevJudge>(async (input) => {
      if (input.missionId === 'm-broke') { input.onNoAnswer?.('budget'); return null; }
      return jevResult('working', 0);
    });
    const deps = { judge, enabled: () => true, hasKey: () => true, configurationKey: () => 'k-budget' };
    expect(await classifyPaneTailForDigest('budget-shared-tail', { ...deps, missionId: 'm-broke' })).toBeNull();
    expect(await classifyPaneTailForDigest('budget-shared-tail', { ...deps, missionId: 'm-rich' })).toMatchObject({ state: 'working' });
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('falha de verdade (timeout) continua lembrada', async () => {
    const judge = vi.fn<typeof jevJudge>(async (input) => { input.onNoAnswer?.('timeout'); return null; });
    const deps = { judge, enabled: () => true, hasKey: () => true, configurationKey: () => 'k-timeout' };
    await classifyPaneTailForDigest('timeout-shared-tail', { ...deps, missionId: 'a' });
    await classifyPaneTailForDigest('timeout-shared-tail', { ...deps, missionId: 'b' });
    expect(judge).toHaveBeenCalledTimes(1);
  });
});
