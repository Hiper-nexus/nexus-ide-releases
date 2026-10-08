import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRemotePaneActivityFeed,
  type RemotePaneActivityEntry,
} from './remote-pane-activity';

const LIMITS = { coalesceMs: 100, maxPerWindow: 3, windowMs: 1_000 };

function feedWith(listening = true) {
  const delivered: RemotePaneActivityEntry[] = [];
  const state = { listening };
  const feed = createRemotePaneActivityFeed({
    sink: () => ({
      hasListeners: () => state.listening,
      deliver: (entry) => delivered.push(entry),
    }),
    limits: () => LIMITS,
  });
  return { feed, delivered, state };
}

describe('atividade dos panes para o celular (MOB-05)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('deriva trabalhando / pede você / parado / encerrado dos sinais do desktop', () => {
    const { feed } = feedWith();
    feed.sessionState('s1', 'spawning');
    expect(feed.list()).toEqual([{ sessionId: 's1', activity: 'working', at: 1_000_000 }]);
    // Qualquer um dos dois planos de hook basta; os dois precisam soltar (regra OU).
    feed.waiting('s1', 'semantic', 'awaiting-input');
    feed.waiting('s1', 'orca', 'blocked');
    feed.waiting('s1', 'semantic', 'working');
    expect(feed.list()[0]!.activity).toBe('waiting');
    feed.waiting('s1', 'orca', 'working');
    expect(feed.list()[0]!.activity).toBe('working');
    feed.sessionState('s1', 'idle');
    expect(feed.list()[0]!.activity).toBe('idle');
    feed.waiting('s1', 'orca', 'waiting');
    feed.sessionExit('s1');
    expect(feed.list()[0]!.activity).toBe('exited');
  });

  it('agrupa o vai-e-volta em um push só, com o estado final', () => {
    const { feed, delivered } = feedWith();
    for (let i = 0; i < 20; i += 1) {
      feed.sessionState('s1', i % 2 === 0 ? 'busy' : 'idle');
    }
    feed.sessionState('s1', 'busy');
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(LIMITS.coalesceMs);
    expect(delivered).toEqual([{ sessionId: 's1', activity: 'working', at: 1_000_000 }]);
    // Reafirmar o mesmo estado não gera push.
    feed.sessionState('s1', 'busy');
    vi.advanceTimersByTime(LIMITS.coalesceMs * 5);
    expect(delivered).toHaveLength(1);
  });

  it('limita os pushes por janela e entrega o estado final quando a janela abre', () => {
    const { feed, delivered } = feedWith();
    for (let i = 0; i < 8; i += 1) {
      feed.sessionState('s1', i % 2 === 0 ? 'busy' : 'idle');
      vi.advanceTimersByTime(LIMITS.coalesceMs + 1);
    }
    expect(delivered.map((entry) => entry.activity)).toEqual(['working', 'idle', 'working']);
    vi.advanceTimersByTime(LIMITS.windowMs);
    expect(delivered.at(-1)!.activity).toBe('idle');
    expect(delivered).toHaveLength(4);
    // Cada sessão tem o próprio limite.
    feed.sessionState('s2', 'busy');
    vi.advanceTimersByTime(LIMITS.coalesceMs);
    expect(delivered.at(-1)).toMatchObject({ sessionId: 's2', activity: 'working' });
  });

  it('sem aparelho ouvindo só guarda o estado (nada é empurrado depois)', () => {
    const { feed, delivered, state } = feedWith(false);
    feed.sessionState('s1', 'busy');
    vi.advanceTimersByTime(LIMITS.windowMs);
    expect(delivered).toEqual([]);
    state.listening = true;
    vi.advanceTimersByTime(LIMITS.windowMs);
    expect(delivered).toEqual([]);
    expect(feed.list()).toEqual([{ sessionId: 's1', activity: 'working', at: 1_000_000 }]);
    feed.sessionState('s1', 'idle');
    vi.advanceTimersByTime(LIMITS.coalesceMs);
    expect(delivered.map((entry) => entry.activity)).toEqual(['idle']);
  });

  it('ignora sessão inválida e sinal sem estado de pane', () => {
    const { feed } = feedWith();
    feed.sessionState('', 'busy');
    feed.sessionState('x'.repeat(129), 'busy');
    feed.waiting('s1', 'orca', 'working');
    expect(feed.list()).toEqual([]);
  });
});
