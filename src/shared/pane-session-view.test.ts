import { describe, expect, it } from 'vitest';
import { paneSessionView } from './pane-session-view';

describe('paneSessionView', () => {
  it('mapeia todos os estados para chip + tip', () => {
    for (const state of [
      'idle',
      'busy',
      'spawning',
      'exited',
      'hibernated',
    ] as const) {
      const view = paneSessionView(state);
      expect(view.chip.length).toBeGreaterThan(1);
      expect(view.tip.length).toBeGreaterThan(4);
      expect(view.mod).toBe(state);
    }
  });

  it('usa palavras humanas (não glifos)', () => {
    expect(paneSessionView('busy').chip).toBe('Trabalho');
    expect(paneSessionView('exited').chip).toBe('Encerrado');
  });

  it('explica uma saída quando há evidência operacional bloqueada ou falha', () => {
    expect(paneSessionView('exited', { outcome: 'blocked' }).chip).toBe(
      'Bloqueado',
    );
    expect(paneSessionView('exited', { outcome: 'failed' }).chip).toBe(
      'Falhou',
    );
    expect(paneSessionView('idle', { outcome: 'failed' }).chip).toBe('Pronto');
  });
});
