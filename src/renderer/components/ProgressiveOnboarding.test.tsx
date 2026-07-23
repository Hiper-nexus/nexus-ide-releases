/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgressiveOnboarding } from './ProgressiveOnboarding';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('ProgressiveOnboarding mission-first', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('recomenda missão, lança esse contrato por padrão e mantém terminal explícito', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onLaunch = vi.fn();
    act(() => {
      root.render(
        <ProgressiveOnboarding
          onLaunch={onLaunch}
          onSkip={vi.fn()}
          onOpenTerminalOnly={vi.fn()}
        />,
      );
    });

    const featured = [
      ...host.querySelectorAll<HTMLButtonElement>('.prog-onb__feature-card'),
    ];
    expect(featured[0]?.textContent).toContain('Missão Nexus');
    expect(featured[0]?.textContent).toContain('Recomendado');
    expect(featured[1]?.textContent).toContain('Nexus Squad');
    expect(host.textContent).toContain('Abrir um terminal só');

    for (let step = 0; step < 3; step += 1) {
      const next = host.querySelector<HTMLButtonElement>(
        '.prog-onb__actions .prog-onb__primary',
      );
      act(() => next?.click());
    }
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="launch-primary"]')
        ?.click();
    });

    expect(onLaunch).toHaveBeenCalledWith({
      mode: 'missions',
      paneCount: 1,
      agentDistribution: 'one-of-each',
      openWithoutAi: false,
    });
    act(() => root.unmount());
  });
});
