import { describe, expect, it, vi } from 'vitest';
import {
  createMortalityReconciler,
  type MortalityCandidate,
} from './session-mortality-reconciler';

function harness(overrides: {
  candidates?: MortalityCandidate[];
  live?: ReadonlySet<string> | null;
  graceMs?: number;
  strikesToCondemn?: number;
  nowMs?: number;
}) {
  const condemned: string[] = [];
  let candidates = overrides.candidates ?? [];
  let live = overrides.live === undefined ? new Set<string>() : overrides.live;
  let nowMs = overrides.nowMs ?? 100_000;
  const probe = vi.fn(async () => live);
  const reconciler = createMortalityReconciler(
    {
      listCandidates: () => candidates,
      probeLiveness: probe,
      condemn: (sessionId) => condemned.push(sessionId),
      log: () => {},
      now: () => nowMs,
    },
    {
      graceMs: overrides.graceMs ?? 10_000,
      strikesToCondemn: overrides.strikesToCondemn ?? 2,
    },
  );
  return {
    reconciler,
    condemned,
    probe,
    setLive: (value: ReadonlySet<string> | null) => (live = value),
    setCandidates: (value: MortalityCandidate[]) => (candidates = value),
    setNow: (value: number) => (nowMs = value),
  };
}

const GHOST: MortalityCandidate = { sessionId: 'pty-ghost-1', spawnedAtMs: 0 };
const ALIVE: MortalityCandidate = { sessionId: 'pty-alive-2', spawnedAtMs: 0 };

describe('createMortalityReconciler', () => {
  it('condena sessão ausente do host após N strikes consecutivos', async () => {
    const h = harness({ candidates: [GHOST], live: new Set() });
    await h.reconciler.tick();
    expect(h.condemned).toEqual([]); // strike 1 — ainda não
    await h.reconciler.tick();
    expect(h.condemned).toEqual(['pty-ghost-1']); // strike 2 — exit sintetizado
  });

  it('sessão viva no host zera os strikes', async () => {
    const h = harness({ candidates: [GHOST], live: new Set() });
    await h.reconciler.tick(); // strike 1
    h.setLive(new Set(['pty-ghost-1']));
    await h.reconciler.tick(); // viva — zera
    h.setLive(new Set());
    await h.reconciler.tick(); // strike 1 de novo
    expect(h.condemned).toEqual([]);
  });

  it('host mudo (null) é unverifiable — nunca condena nem acumula', async () => {
    const h = harness({ candidates: [GHOST], live: null });
    await h.reconciler.tick();
    await h.reconciler.tick();
    await h.reconciler.tick();
    expect(h.condemned).toEqual([]);
  });

  it('período de graça protege spawn em trânsito', async () => {
    const h = harness({
      candidates: [{ sessionId: 'pty-novo', spawnedAtMs: 95_000 }],
      live: new Set(),
      graceMs: 10_000,
      nowMs: 100_000, // idade 5s < graça 10s
    });
    await h.reconciler.tick();
    expect(h.probe).not.toHaveBeenCalled();
    h.setNow(106_000); // idade 11s
    await h.reconciler.tick();
    await h.reconciler.tick();
    expect(h.condemned).toEqual(['pty-novo']);
  });

  it('sessão que sai da lista de candidatas perde os strikes acumulados', async () => {
    const h = harness({ candidates: [GHOST], live: new Set() });
    await h.reconciler.tick(); // strike 1
    h.setCandidates([]); // finalizada pela via normal
    await h.reconciler.tick();
    h.setCandidates([GHOST]); // id reusado / voltou
    await h.reconciler.tick(); // strike 1 de novo, não 2
    expect(h.condemned).toEqual([]);
  });

  it('só a ausente é condenada quando há mistura', async () => {
    const h = harness({
      candidates: [GHOST, ALIVE],
      live: new Set(['pty-alive-2']),
    });
    await h.reconciler.tick();
    await h.reconciler.tick();
    expect(h.condemned).toEqual(['pty-ghost-1']);
  });

  it('forget limpa strikes de sessão finalizada por outra via', async () => {
    const h = harness({ candidates: [GHOST], live: new Set() });
    await h.reconciler.tick(); // strike 1
    h.reconciler.forget('pty-ghost-1');
    await h.reconciler.tick(); // strike 1 de novo
    expect(h.condemned).toEqual([]);
  });
});
