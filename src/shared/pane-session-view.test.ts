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
    expect(paneSessionView('busy').chip).toBe('Trabalhando');
    expect(paneSessionView('exited').chip).toBe('Encerrado');
  });

  it('explica uma saída quando há evidência operacional bloqueada ou falha', () => {
    expect(paneSessionView('exited', { outcome: 'blocked' }).chip).toBe(
      'Bloqueado',
    );
    expect(paneSessionView('exited', { outcome: 'failed' }).chip).toBe(
      'Falhou',
    );
    // Agente PARADO nunca herda o desfecho da missão: ele aguarda. "Pronto"
    // ficou reservado à entrega (mission-lifecycle-copy), para a mesma
    // palavra não significar duas coisas na mesma tela.
    expect(paneSessionView('idle', { outcome: 'failed' }).chip).toBe(
      'Aguardando',
    );
  });
});


it('dicas compartilhadas não indicam controles ocultos em missões', () => {
  for (const state of ['exited', 'hibernated'] as const) {
    expect(paneSessionView(state).tip).not.toMatch(/reinici|acordar|☀/i);
  }
});
