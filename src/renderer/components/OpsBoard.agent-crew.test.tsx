/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useSessionStateStore } from '../state/session-state-store';
import { OpsBoard } from './OpsBoard';

vi.mock('./ChosenPetPortrait', () => ({
  ChosenPetPortrait: () => <span data-testid="pet" />,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const initialLayout = useLayoutStore.getState();
const initialOrch = useOrchStore.getState();
const initialSessions = useSessionStateStore.getState();

describe('OpsBoard live agent crew', () => {
  afterEach(() => {
    useLayoutStore.setState(initialLayout);
    useOrchStore.setState(initialOrch);
    useSessionStateStore.setState(initialSessions);
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
  });

  it('renders real pane state and focuses a live agent from its mascot', () => {
    const pane: PaneModel = {
      id: 'pane-maestro',
      kind: 'cli-agent',
      title: 'Maestro',
      adapterId: 'codex',
      role: 'orchestrator',
      agentName: 'Maestro',
    };
    useLayoutStore.setState({
      root: { kind: 'leaf', id: 'leaf-maestro', pane },
      focusedPaneId: null,
    });
    useSessionStateStore.setState({
      paneStates: new Map([[pane.id, 'busy']]),
    });
    useOrchStore.setState({
      boardOpen: true,
      missions: [
        {
          id: 'mission-1',
          title: 'Execução e QA',
          description: '',
          status: 'running',
          squadId: 'squad-1',
          milestones: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      squads: [
        {
          id: 'squad-1',
          name: 'Core',
          createdAt: '1',
          builtin: false,
          orchestratorInstructions: '',
          agents: [
            {
              id: 'orch',
              agentName: 'Maestro',
              category: 'orchestrator',
              cli: 'codex',
            },
          ],
        },
      ],
      paneMissions: { [pane.id]: 'mission-1' },
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        orch: {
          updateMission: vi.fn(),
          removeMission: vi.fn(),
        },
      },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<OpsBoard />));

    expect(host.querySelector('.ops-board__crew-state')?.textContent).toBe(
      '1 trabalhando',
    );
    expect(
      host.querySelector('.agent-avatar')?.getAttribute('aria-label'),
    ).toBe('Maestro, orchestrator, trabalhando');

    act(() => {
      (host.querySelector('.ops-board__agent-focus') as HTMLButtonElement).click();
    });
    expect(useLayoutStore.getState().focusedPaneId).toBe(pane.id);
    expect(useOrchStore.getState().boardOpen).toBe(false);

    act(() => root.unmount());
  });
});
