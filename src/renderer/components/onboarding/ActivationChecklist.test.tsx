/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivationChecklist, type ActivationChecklistHandlers } from './ActivationChecklist';
import { useOnboardingStore } from '../../state/onboarding-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.includes(label),
  );
  expect(found, label).toBeDefined();
  return found!;
}

function setup() {
  const handlers: ActivationChecklistHandlers = {
    onOpenApiKeys: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onExplainDictation: vi.fn(),
    onOpenPane: vi.fn(),
    onStartMission: vi.fn(),
  };
  const host = render(<ActivationChecklist {...handlers} />);
  return { host, handlers };
}

describe('ActivationChecklist', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useOnboardingStore.getState().reset();
  });

  it('lists the five activation steps and runs the keys shortcut', () => {
    const { host, handlers } = setup();
    expect(host.textContent).toContain('Primeiros passos');
    expect(host.textContent).toContain('Conecte uma IA ou chave');
    expect(host.textContent).toContain('Dite com Space');
    expect(host.textContent).toContain('Abra um + Pane');
    expect(host.textContent).toContain('Crie a primeira missão');
    act(() => button(host, 'Chaves de API').click());
    expect(handlers.onOpenApiKeys).toHaveBeenCalledOnce();
  });

  it('marks manual steps and hides when complete or dismissed', () => {
    const { host } = setup();
    act(() => button(host, 'Marcar').click());
    expect(host.textContent).toContain('Feito');

    act(() => button(host, 'Entendi, não mostrar de novo').click());
    expect(host.querySelector('.activation-checklist')).toBeNull();
  });

  it('hides when every activation fact is already true', () => {
    useOnboardingStore.setState({
      state: {
        ...useOnboardingStore.getState().state,
        checklist: {
          connectedAccount: true,
          openedProject: true,
          dictatedWithSpace: true,
          openedPlusPane: true,
          createdMission: true,
          dismissed: false,
        },
      },
    });
    const { host } = setup();
    expect(host.querySelector('.activation-checklist')).toBeNull();
  });
});
