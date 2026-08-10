/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLeaf, createPane } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { useMissionSetupStore } from '../../state/mission-setup-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useSessionStateStore } from '../../state/session-state-store';
import { ProjectOverview } from './ProjectOverview';

vi.mock('../../terminal/pane-close-guard', () => ({
  requestPaneClose: vi.fn(),
}));

import { requestPaneClose } from '../../terminal/pane-close-guard';

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

function setTextAreaValue(el: HTMLTextAreaElement, value: string): void {
  const tracker = (
    el as HTMLTextAreaElement & {
      _valueTracker?: { setValue: (v: string) => void };
    }
  )._valueTracker;
  const proto = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  );
  proto?.set?.call(el, value);
  tracker?.setValue('');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ProjectOverview', () => {
  beforeEach(() => {
    useProductNavigationStore.setState({
      destination: { kind: 'project' },
      settingsReturnDestination: null,
    });
    useMissionSetupStore.getState().setObjective('');
    useMissionSetupStore.getState().setWorkspace(null);
    const pane = createPane('cli-agent', undefined, 'claude');
    useLayoutStore.setState({
      root: createLeaf(pane),
      focusedPaneId: pane.id,
    });
    useSessionStateStore.setState({
      paneStates: new Map([[pane.id, 'busy']]),
      displayStates: new Map([[pane.id, 'busy']]),
    });
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.replaceChildren();
    vi.mocked(requestPaneClose).mockReset();
  });

  it('lists panes with status and focuses on click', () => {
    const host = render(
      <ProjectOverview workspaceName="Demo" workspacePath="/tmp/demo" />,
    );
    expect(host.textContent).toContain('Demo');
    expect(host.textContent).toContain('Trabalhando');
    const session = host.querySelector(
      'button.project-overview__session',
    ) as HTMLButtonElement;
    act(() => session.click());
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'terminal',
    });
  });

  it('hands the goal box to mission setup', () => {
    const host = render(
      <ProjectOverview workspaceName="Demo" workspacePath="/tmp/demo" />,
    );
    const input = host.querySelector('#project-goal') as HTMLTextAreaElement;
    const form = host.querySelector('form') as HTMLFormElement;
    act(() => {
      setTextAreaValue(input, 'Corrigir o login');
    });
    act(() => {
      form.requestSubmit();
    });
    expect(useMissionSetupStore.getState().draft.objective).toBe(
      'Corrigir o login',
    );
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
  });

  it('closes a session from the flock strip', () => {
    const host = render(
      <ProjectOverview workspaceName="Demo" workspacePath="/tmp/demo" />,
    );
    const close = host.querySelector(
      'button.project-overview__close',
    ) as HTMLButtonElement;
    act(() => close.click());
    expect(requestPaneClose).toHaveBeenCalled();
  });
});
