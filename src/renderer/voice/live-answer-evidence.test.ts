import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROVIDER_ANSWER_POLL_MS,
  PROVIDER_ANSWER_TRANSCRIPT_GRACE_MS,
  waitForTranscriptOrProviderAnswer,
  type WaitForTranscriptOrAnswerOptions,
} from './live-answer-evidence';
import type { LiveRescueSnapshot } from './live-mute-rescue';
import { RealtimeTranscriptWaiter } from './realtime-transcript-waiter';

const WINDOW_MS = 4_800;

function harness() {
  // Waiter REAL com os timers do vitest: o settleEarly é exercitado de ponta a
  // ponta, não contra um dublê que concordaria com a implementação.
  const waiter = new RealtimeTranscriptWaiter();
  let snapshot: LiveRescueSnapshot = {
    turnToken: 7,
    playedAudioChunks: 2,
    heldAudioChunks: 0,
    toolInFlight: 0,
    lastToolAt: 0,
  };
  const read = vi.fn(() => snapshot);
  const settleEarly = vi.fn(() => {
    waiter.settleEarly('7');
  });
  const run = (extra: Partial<WaitForTranscriptOrAnswerOptions> = {}) =>
    waitForTranscriptOrProviderAnswer({
      enabled: true,
      wait: () => waiter.wait(WINDOW_MS, '7'),
      settleEarly,
      read,
      turnToken: 7,
      startedAt: 1_000,
      playedBaseline: 2,
      heldBaseline: 0,
      ...extra,
    });
  return {
    waiter,
    read,
    settleEarly,
    run,
    set: (patch: Partial<LiveRescueSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForTranscriptOrProviderAnswer', () => {
  it('mantém a carência curta e a sondagem barata (orçamento interativo)', () => {
    expect(PROVIDER_ANSWER_POLL_MS).toBe(50);
    expect(PROVIDER_ANSWER_TRANSCRIPT_GRACE_MS).toBe(450);
    expect(PROVIDER_ANSWER_TRANSCRIPT_GRACE_MS).toBeLessThan(WINDOW_MS / 5);
  });

  it('tool nativa em curso encerra a espera na primeira sondagem, sem esgotar a janela', async () => {
    const h = harness();
    h.set({ toolInFlight: 1 });
    const outcome = h.run();

    await vi.advanceTimersByTimeAsync(PROVIDER_ANSWER_POLL_MS);

    await expect(outcome).resolves.toEqual({
      text: null,
      superseded: false,
      early: 'tool',
    });
    expect(h.settleEarly).toHaveBeenCalledTimes(1);
    // O slot do waiter foi liberado: nenhum timer de 4,8 s sobra pendurado.
    expect(h.waiter.hasPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tool que já terminou mas ainda é dona do turno também encerra na hora', async () => {
    const h = harness();
    h.set({ toolOwnsTurn: true });
    const outcome = h.run();

    await vi.advanceTimersByTimeAsync(PROVIDER_ANSWER_POLL_MS);

    await expect(outcome).resolves.toMatchObject({ early: 'tool' });
  });

  it('tool disparada depois do início da espera (lastToolAt >= startedAt) encerra', async () => {
    const h = harness();
    const outcome = h.run();
    await vi.advanceTimersByTimeAsync(120);
    h.set({ lastToolAt: 1_500 });
    await vi.advanceTimersByTimeAsync(PROVIDER_ANSWER_POLL_MS);

    await expect(outcome).resolves.toMatchObject({ early: 'tool' });
  });

  it('áudio do provider dá uma carência ao transcript e só então encerra', async () => {
    const h = harness();
    h.set({ playedAudioChunks: 3 }); // base = 2: o provider respondeu NESTE turno
    let settled = false;
    const outcome = h.run().then((value) => {
      settled = true;
      return value;
    });

    // Primeira prova na sondagem de 50 ms; a carência corre a partir dela.
    await vi.advanceTimersByTimeAsync(
      PROVIDER_ANSWER_POLL_MS + PROVIDER_ANSWER_TRANSCRIPT_GRACE_MS - 30,
    );
    expect(settled).toBe(false);
    expect(h.settleEarly).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    await expect(outcome).resolves.toEqual({
      text: null,
      superseded: false,
      early: 'audio',
    });
    expect(h.settleEarly).toHaveBeenCalledTimes(1);
    // Muito antes da janela de 4,8 s do wake.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('áudio retido (held) também conta como resposta do provider', async () => {
    const h = harness();
    h.set({ heldAudioChunks: 1 });
    const outcome = h.run();

    await vi.advanceTimersByTimeAsync(
      PROVIDER_ANSWER_POLL_MS + PROVIDER_ANSWER_TRANSCRIPT_GRACE_MS + PROVIDER_ANSWER_POLL_MS,
    );

    await expect(outcome).resolves.toMatchObject({ early: 'audio' });
  });

  it('transcript que chega durante a carência vence a saída antecipada', async () => {
    const h = harness();
    h.set({ playedAudioChunks: 4 });
    const outcome = h.run();

    await vi.advanceTimersByTimeAsync(PROVIDER_ANSWER_POLL_MS * 3);
    expect(h.waiter.deliver('abre o terminal', '7')).toBe(true);

    await expect(outcome).resolves.toEqual({
      text: 'abre o terminal',
      superseded: false,
    });
    expect(h.settleEarly).not.toHaveBeenCalled();
  });

  it('sem nenhuma evidência a janela inteira corre e o mute segue sendo timeout', async () => {
    const h = harness();
    const outcome = h.run();

    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(h.waiter.hasPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(2);

    await expect(outcome).resolves.toEqual({ text: null, superseded: false });
    expect(h.read.mock.calls.length).toBeGreaterThan(10); // sondou o tempo todo
    expect(h.settleEarly).not.toHaveBeenCalled();
  });

  it('áudio que NÃO passou da base do turno não é evidência', async () => {
    const h = harness();
    h.set({ playedAudioChunks: 2, heldAudioChunks: 0 }); // iguais à base
    const outcome = h.run();

    await vi.advanceTimersByTimeAsync(WINDOW_MS + 10);

    await expect(outcome).resolves.toEqual({ text: null, superseded: false });
  });

  it('wait superseded por novo turno passa direto, mesmo com evidência', async () => {
    const h = harness();
    h.set({ toolInFlight: 1 });
    const outcome = h.run();
    h.waiter.supersede(); // novo "Hey Jarvis" antes da primeira sondagem

    await expect(outcome).resolves.toEqual({ text: null, superseded: true });
    expect(h.settleEarly).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PROVIDER_ANSWER_POLL_MS * 2);
    expect(h.settleEarly).not.toHaveBeenCalled();
  });

  it('turno trocado no meio: nunca encerra o wait de OUTRO turno', async () => {
    const h = harness();
    h.set({ turnToken: 8, toolInFlight: 1 }); // outro turno já abriu
    const outcome = h.run();

    await vi.advanceTimersByTimeAsync(PROVIDER_ANSWER_POLL_MS * 6);
    expect(h.settleEarly).not.toHaveBeenCalled();
    expect(h.waiter.hasPending()).toBe(true);

    h.waiter.supersede(); // o waiter do turno novo é quem resolve o antigo
    await expect(outcome).resolves.toEqual({ text: null, superseded: true });
  });

  it('desligada (Classic pode falar) vira o wait puro: nem sonda o provider', async () => {
    const h = harness();
    h.set({ toolInFlight: 1, playedAudioChunks: 9 });
    const outcome = h.run({ enabled: false });

    await vi.advanceTimersByTimeAsync(WINDOW_MS + 10);

    await expect(outcome).resolves.toEqual({ text: null, superseded: false });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.settleEarly).not.toHaveBeenCalled();
  });

  it('leitura de estado que lança é tratada como "sem prova", nunca derruba o turno', async () => {
    const h = harness();
    h.read.mockImplementation(() => {
      throw new Error('store indisponível');
    });
    const outcome = h.run();

    await vi.advanceTimersByTimeAsync(WINDOW_MS + 10);

    await expect(outcome).resolves.toEqual({ text: null, superseded: false });
  });

  it('relógio e atraso injetáveis: a carência conta pelo relógio recebido', async () => {
    vi.useRealTimers();
    const waiter = new RealtimeTranscriptWaiter();
    let clock = 1_000;
    const settle = vi.fn(() => {
      waiter.settleEarly('7');
    });
    const outcome = await waitForTranscriptOrProviderAnswer({
      enabled: true,
      wait: () => waiter.wait(60_000, '7'),
      settleEarly: settle,
      read: () => ({
        turnToken: 7,
        playedAudioChunks: 5,
        heldAudioChunks: 0,
        toolInFlight: 0,
        lastToolAt: 0,
      }),
      turnToken: 7,
      startedAt: 1_000,
      playedBaseline: 0,
      heldBaseline: 0,
      graceMs: 200,
      pollMs: 100,
      now: () => clock,
      delay: async (ms) => {
        clock += ms;
      },
    });

    expect(outcome).toMatchObject({ text: null, superseded: false, early: 'audio' });
    // 1ª sondagem em +100 ms (prova), encerra em +300 ms: 100 + carência de 200.
    expect(clock).toBe(1_300);
    expect(settle).toHaveBeenCalledTimes(1);
  });
});
