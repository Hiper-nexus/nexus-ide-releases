/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../state/toast-store';
import { Toasts } from './Toasts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function clearToasts(): void {
  for (const toast of useToastStore.getState().toasts) {
    useToastStore.getState().dismiss(toast.id);
  }
}

describe('Toasts', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    clearToasts();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    clearToasts();
    host.remove();
    vi.useRealTimers();
  });

  it('announces blocking alerts assertively with a specific close label', () => {
    useToastStore.getState().push(
      'error',
      'Não deu pra iniciar a execução',
      "Error invoking remote method 'orch:missions.approvalIntent': Error: " +
        'guided_plan_preflight_blocked: guided_plan_unborn_with_files',
    );

    act(() => root.render(<Toasts />));

    const region = host.querySelector('[role="region"]');
    const alert = host.querySelector('[role="alert"]');
    expect(region?.getAttribute('aria-label')).toBe('Notificações');
    expect(alert?.getAttribute('aria-live')).toBe('assertive');
    expect(alert?.textContent).toContain(
      'Esta pasta já tem arquivos sem histórico. Faça o primeiro commit e tente novamente.',
    );
    expect(
      host.querySelector(
        'button[aria-label="Fechar aviso: Não deu pra iniciar a execução"]',
      ),
    ).not.toBeNull();
  });

  it('dismisses the selected alert without muting the notification region', () => {
    useToastStore.getState().push('success', 'Missão concluída', 'Tudo validado.');
    act(() => root.render(<Toasts />));

    const status = host.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toContain('Tudo validado.');

    act(() => {
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Fechar aviso: Missão concluída"]',
        )
        ?.click();
    });

    expect(host.querySelector('[role="region"]')).toBeNull();
  });
});
