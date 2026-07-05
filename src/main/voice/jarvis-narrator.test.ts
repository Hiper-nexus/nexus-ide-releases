import { afterEach, describe, expect, it, vi } from 'vitest';
import { initHandoffStore, submitHandoff } from '../orch/handoff-store';
import { initJarvisNarrator, shutdownJarvisNarrator } from './jarvis-narrator';

// O narrador lê a config de voz (default routing 'jarvis') e o handoff-store.
vi.mock('./voice-config-store', () => ({
  getVoiceConfig: () => ({ routing: 'jarvis' }),
}));

afterEach(() => {
  shutdownJarvisNarrator();
  initHandoffStore(null); // limpa o store em memória
  vi.useRealTimers();
});

describe('jarvis-narrator — baseline não é falado', () => {
  it('NÃO narra histórico que hidrata após o init (o bug do boot)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    initHandoffStore(null);
    const spoken: string[] = [];
    // Narrador liga com a store vazia (ordem real do bootstrap). startedAt=5000.
    initJarvisNarrator((_ch, payload) => spoken.push((payload as { text: string }).text));

    // Histórico hidrata DEPOIS, com createdAt no PASSADO (relógio recuado).
    vi.setSystemTime(1000);
    submitHandoff({ status: 'success', summary: 'Old worker result from history one', fromAgent: 'w1' });
    submitHandoff({ status: 'success', summary: 'Old worker result from history two', fromAgent: 'w2' });
    vi.setSystemTime(5000);
    vi.advanceTimersByTime(2000);

    expect(spoken).toEqual([]); // história nunca é falada
  });

  it('narra handoffs criados DEPOIS de o narrador ligar', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    initHandoffStore(null);
    const spoken: string[] = [];
    initJarvisNarrator((_ch, payload) => spoken.push((payload as { text: string }).text));

    // Histórico no passado → silêncio.
    vi.setSystemTime(1000);
    submitHandoff({ status: 'success', summary: 'History item that must stay silent', fromAgent: 'w1' });
    vi.setSystemTime(5000);
    vi.advanceTimersByTime(2000);
    expect(spoken).toEqual([]);

    // Entrega nova, já FORA da graça de boot (init em 5000 + 6000 = 11000).
    vi.setSystemTime(12000);
    submitHandoff({ status: 'success', summary: 'Fresh delivery the user should hear about', fromAgent: 'builder' });
    vi.advanceTimersByTime(2000);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain('builder');
  });
});
