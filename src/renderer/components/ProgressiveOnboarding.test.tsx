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

  it('abre a missão guiada em um clique e mantém terminal e avançado explícitos', () => {
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

    expect(host.textContent).toContain('Começar uma missão');
    expect(host.textContent).toContain('Abrir só o terminal');
    expect(host.textContent).toContain('Configuração avançada');
    expect(host.textContent).not.toContain('Layout do terminal');
    expect(host.textContent).not.toContain('Agentes (opcional)');

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

  it('continua num workspace recente direto para o mesmo contrato agentic', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onLaunch = vi.fn();
    act(() => {
      root.render(
        <ProgressiveOnboarding
          recents={[{ path: '/repo/nexus', label: 'Nexus' }]}
          onLaunch={onLaunch}
          onSkip={vi.fn()}
          onOpenTerminalOnly={vi.fn()}
        />,
      );
    });

    const recent = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Nexus'),
    );
    act(() => recent?.click());
    expect(onLaunch).toHaveBeenCalledWith({
      mode: 'missions',
      paneCount: 1,
      agentDistribution: 'one-of-each',
      openWithoutAi: false,
      recentWorkspacePath: '/repo/nexus',
    });
    act(() => root.unmount());
  });
});
