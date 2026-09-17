import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JevResult, judge as jevJudge } from './jev-client';
import type { ScreenDetectionRecord } from '../detect/detector';
import {
  getJevPaneHint,
  startJevPaneStateClassifier,
  type JevPaneStateDeps,
} from './jev-pane-state';

vi.mock('./jev-decision-log', () => ({
  recordJevDecision: vi.fn(() => 'id'),
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
