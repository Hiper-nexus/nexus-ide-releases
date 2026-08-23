/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Launcher } from './Launcher';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(node));
  return host;
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
});

function renderLauncher() {
  const handlers = {
    onOpenWorkspace: vi.fn(),
    onStartMission: vi.fn(),
    onOpenTaskBoard: vi.fn(),
    onOpenMemory: vi.fn(),
  };
  const host = render(<Launcher {...handlers} />);
  return { host, handlers };
}

describe('Launcher', () => {
  it('offers exactly four plain-language actions with one explanation each', () => {
    const { host } = renderLauncher();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];

    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Missão em equipe',
      'Abrir uma pasta de projeto',
      'Abrir Quadro',
      'Abrir Memória',
    ]);
    expect(host.textContent).toContain(
      'Já tenho arquivos no computador e quero trabalhar em cima deles.',
    );
    expect(host.textContent).toContain(
      'Descreva o que você quer entregar e o Nexus organiza o trabalho.',
    );
    expect(host.textContent).toContain(
      'Acompanhe tarefas e organize o que vem a seguir.',
    );
    expect(host.textContent).toContain(
      'Consulte notas locais, decisões e referências do projeto.',
    );
  });

  it('routes every action through its explicit callback', () => {
    const { host, handlers } = renderLauncher();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];

    for (const button of buttons) {
      act(() => button.click());
    }

    expect(handlers.onOpenWorkspace).toHaveBeenCalledOnce();
    expect(handlers.onStartMission).toHaveBeenCalledOnce();
    expect(handlers.onOpenTaskBoard).toHaveBeenCalledOnce();
    expect(handlers.onOpenMemory).toHaveBeenCalledOnce();
  });

  it('uses native keyboard-focusable buttons and makes the mission action primary', () => {
    const { host } = renderLauncher();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];
    const mission = buttons.find(
      (button) => button.getAttribute('aria-label') === 'Missão em equipe',
    );

    expect(buttons.every((button) => button.tabIndex === 0)).toBe(true);
    mission?.focus();
    expect(document.activeElement).toBe(mission);
    expect(mission?.classList.contains('launcher-action--primary')).toBe(true);
    expect(
      buttons
        .filter((button) => button !== mission)
        .every(
          (button) =>
            !button.classList.contains('launcher-action--primary'),
        ),
    ).toBe(true);
  });

  it('does not expose legacy modes or operational jargon', () => {
    const { host } = renderLauncher();

    expect(host.textContent).not.toMatch(
      /Autopilot|Free|Squad|PRD|orquestrador|worker|provider|modelo|XP|custo|pane/i,
    );
  });
});
