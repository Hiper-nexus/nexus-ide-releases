/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MISSION_PREP_MESSAGE_INTERVAL_MS,
  MISSION_PREP_SHOW_DELAY_MS,
  MissionPrepOverlay,
} from './MissionPrepOverlay';

/**
 * Focused tests do overlay “preparando missão”: entrada atrasada (anti-flicker),
 * rotação de mensagens por fase real, estado de erro com tentar de novo e
 * cancelamento (Esc/botão). Contrato visual (motion só transform/opacity,
 * reduced-motion, tokens) fica no guard de estilo da folha.
 */

interface Props {
  open?: boolean;
  phase?: 'prepare' | 'start' | null;
  error?: string | null;
  onDismiss?: () => void;
  onRetry?: () => void;
}

const roots: Root[] = [];

interface Handle {
  rerender(props: Props): void;
}

function renderOverlay(props: Props): Handle {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const paint = (next: Props) => {
    act(() => {
      root.render(
        <MissionPrepOverlay
          open={next.open ?? true}
          phase={next.phase ?? null}
          error={next.error ?? null}
          onDismiss={next.onDismiss ?? (() => {})}
          onRetry={next.onRetry ?? (() => {})}
        />,
      );
    });
  };
  paint(props);
  return { rerender: paint };
}

const dialog = () => document.querySelector('[role="dialog"]');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    act(() => root?.unmount());
  }
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('MissionPrepOverlay: montagem e entrada', () => {
  it('não renderiza nada fechado', () => {
    renderOverlay({ open: false });
    expect(dialog()).toBeNull();
    expect(document.querySelector('.mission-prep-overlay')).toBeNull();
  });

  it('loading espera o atraso anti-flicker antes de acender', () => {
    renderOverlay({ open: true });
    expect(dialog()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(MISSION_PREP_SHOW_DELAY_MS - 1);
    });
    expect(dialog()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(dialog()).not.toBeNull();
  });

  it('erro acende imediatamente, sem atraso', () => {
    renderOverlay({ open: true, error: 'O coordenador não subiu.' });
    expect(dialog()).not.toBeNull();
  });

  it('abre de novo depois de fechar (reset do atraso)', () => {
    const { rerender } = renderOverlay({ open: true });
    act(() => {
      vi.advanceTimersByTime(MISSION_PREP_SHOW_DELAY_MS);
    });
    expect(dialog()).not.toBeNull();
    rerender({ open: false });
    expect(dialog()).toBeNull();
    rerender({ open: true });
    expect(dialog()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(MISSION_PREP_SHOW_DELAY_MS);
    });
    expect(dialog()).not.toBeNull();
  });
});

describe('MissionPrepOverlay: mensagens rotativas por fase', () => {
  it('expõe a primeira mensagem genérica em região polite', () => {
    renderOverlay({ open: true, phase: null });
    act(() => {
      vi.advanceTimersByTime(MISSION_PREP_SHOW_DELAY_MS);
    });
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('preparando o código…');
    expect(dialog()?.getAttribute('aria-busy')).toBe('true');
  });

  it('fase start mostra o catálogo do start', () => {
    renderOverlay({ open: true, phase: 'start' });
    act(() => {
      vi.advanceTimersByTime(MISSION_PREP_SHOW_DELAY_MS);
    });
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain(
      'acordando o coordenador…',
    );
  });

  it('rotaciona mensagens no intervalo da casa', () => {
    renderOverlay({ open: true, phase: null });
    act(() => {
      vi.advanceTimersByTime(MISSION_PREP_SHOW_DELAY_MS);
    });
    const live = () =>
      document.querySelector('[aria-live="polite"]')?.textContent ?? '';
    expect(live()).toContain('preparando o código…');
    act(() => {
      vi.advanceTimersByTime(MISSION_PREP_MESSAGE_INTERVAL_MS);
    });
    expect(live()).toContain('compilando ideias…');
  });

  it('troca de fase recomeça a rotação do começo', () => {
    const { rerender } = renderOverlay({ open: true, phase: 'prepare' });
    act(() => {
      vi.advanceTimersByTime(MISSION_PREP_SHOW_DELAY_MS);
    });
    act(() => {
      vi.advanceTimersByTime(MISSION_PREP_MESSAGE_INTERVAL_MS);
    });
    const live = () =>
      document.querySelector('[aria-live="polite"]')?.textContent ?? '';
    expect(live()).not.toContain('carimbando a revisão segura…');
    rerender({ open: true, phase: 'start' });
    act(() => {
      vi.advanceTimersByTime(MISSION_PREP_SHOW_DELAY_MS);
    });
    expect(live()).toContain('acordando o coordenador…');
  });
});

describe('MissionPrepOverlay: erro, retry e cancelamento', () => {
  it('erro vira alert com tentar de novo e voltar', () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    renderOverlay({
      open: true,
      error: 'A ferramenta não respondeu.',
      onRetry,
      onDismiss,
    });
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('A ferramenta não respondeu.');
    expect(
      document.querySelector('[aria-live="polite"] .mission-prep-overlay__message'),
    ).toBeNull();
    const buttons = [...document.querySelectorAll('button')];
    const retry = buttons.find((b) => b.textContent === 'Tentar de novo');
    const back = buttons.find((b) => b.textContent === 'Voltar');
    expect(retry).toBeDefined();
    expect(back).toBeDefined();
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() => back?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('loading oferece continuar em segundo plano e Esc dispensa', () => {
    const onDismiss = vi.fn();
    renderOverlay({ open: true, onDismiss });
    act(() => {
      vi.advanceTimersByTime(MISSION_PREP_SHOW_DELAY_MS);
    });
    const background = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Continuar em segundo plano',
    );
    expect(background).toBeDefined();
    const panel = dialog();
    expect(panel).not.toBeNull();
    act(() => {
      panel?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
        }),
      );
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    act(() => background?.click());
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
