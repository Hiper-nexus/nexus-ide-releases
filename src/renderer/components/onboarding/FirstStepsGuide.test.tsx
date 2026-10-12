/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirstStepsGuide } from './FirstStepsGuide';
import { useOnboardingStore } from '../../state/onboarding-store';
import { useProviderStore } from '../../state/provider-store';
import { useAccountStore } from '../../state/account-store';
import { useWorkspaceStore } from '../../state/workspace-store';
import { useOrchStore } from '../../state/orch-store';

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

describe('FirstStepsGuide activation facts', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useOnboardingStore.getState().reset();
    useProviderStore.setState({ providers: [] });
    useAccountStore.setState({ accounts: [] });
    useWorkspaceStore.setState({ current: null });
    useOrchStore.setState({ missions: [] });
  });

  it('marks connectedAccount from a live session without a key', () => {
    useProviderStore.setState({
      providers: [
        {
          adapterId: 'claude',
          label: 'Claude',
          hasKey: false,
          authState: 'ok',
          enabled: true,
        } as never,
      ],
    });
    render(<FirstStepsGuide />);
    expect(useOnboardingStore.getState().state.checklist.connectedAccount).toBe(
      true,
    );
    expect(useOnboardingStore.getState().state.checklist.openedProject).toBe(
      false,
    );
    expect(useOnboardingStore.getState().state.checklist.createdMission).toBe(
      false,
    );
  });

  it('does not mark createdMission just because the guide is mounted', () => {
    render(<FirstStepsGuide />);
    expect(useOnboardingStore.getState().state.checklist.createdMission).toBe(
      false,
    );
    expect(useOnboardingStore.getState().state.checklist.openedPlusPane).toBe(
      false,
    );
    expect(useOnboardingStore.getState().state.checklist.dictatedWithSpace).toBe(
      false,
    );
  });

  it('marks openedProject and createdMission only from live facts', () => {
    useWorkspaceStore.setState({
      current: { path: '/tmp/proj', name: 'proj' } as never,
    });
    useOrchStore.setState({
      missions: [{ id: 'm1', title: 'x' } as never],
    });
    render(<FirstStepsGuide />);
    expect(useOnboardingStore.getState().state.checklist.openedProject).toBe(
      true,
    );
    expect(useOnboardingStore.getState().state.checklist.createdMission).toBe(
      true,
    );
  });
});
