/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionWizard } from './MissionWizard';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useOrchStore } from '../state/orch-store';
import type { Mission, Squad } from '../../shared/orch-types';

const reopenMocks = vi.hoisted(() => ({
  confirmAndReopenMission: vi.fn(async () => ({ ok: true, panes: 2 })),
}));

vi.mock('../orch/confirm-reopen-mission', () => ({
  confirmAndReopenMission: reopenMocks.confirmAndReopenMission,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const squad: Squad = {
  id: 'squad-1',
  name: 'Time',
  orchestratorInstructions: 'Orch.',
  agents: [
    { id: 'orch', agentName: 'Orch', category: 'orchestrator', cli: 'claude' },
  ],
  createdAt: '1',
  builtin: false,
};

const armedMission: Mission = {
  id: 'mission-armed-1',
  title: 'quero continuar codando nosso sistema completo',
  description: '',
  status: 'pending',
  intentState: 'ready_to_start',
  squadId: 'squad-1',
  milestones: [],
  learnings: '',
  createdAt: 1,
  updatedAt: 2,
};

const initialWizard = useMissionWizardStore.getState();
const initialOrch = useOrchStore.getState();
const roots = new Set<Root>();

function mount(): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.add(root);
  act(() => root.render(<MissionWizard />));
  return host;
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes(label),
    ) ?? null
  );
}

describe('MissionWizard — volta aos panes', () => {
  beforeEach(() => {
    reopenMocks.confirmAndReopenMission.mockClear();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        adapters: { list: vi.fn(async () => []) },
        settings: { orchGet: vi.fn(async () => ({})) },
        orch: {
          submitMissionIntent: vi.fn(),
          getMissionPromptQueue: vi.fn(async () => null),
        },
      },
    });
    useOrchStore.setState({
      squads: [squad],
      missions: [armedMission],
      paneMissions: {},
    });
  });

  afterEach(() => {
    act(() => {
      for (const root of roots) root.unmount();
    });
    roots.clear();
    document.body.innerHTML = '';
    useMissionWizardStore.setState(initialWizard);
    useOrchStore.setState(initialOrch);
    Reflect.deleteProperty(window, 'nexus');
    vi.restoreAllMocks();
  });

  it('oferece a volta aos panes quando o assistente abre sobre uma missão', async () => {
    useMissionWizardStore
      .getState()
      .openForArmedMission('squad-1', 'mission-armed-1');
    const host = mount();
    await act(async () => {});

    const back = findButton(host, 'Voltar aos panes');
    expect(back).not.toBeNull();

    await act(async () => {
      back?.click();
    });

    // Fecha o assistente E devolve o operador aos panes daquela missão.
    expect(useMissionWizardStore.getState().open).toBe(false);
    expect(reopenMocks.confirmAndReopenMission).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'mission-armed-1' }),
    );
  });

  it('não oferece volta quando o assistente é uma missão nova de verdade', async () => {
    useMissionWizardStore.getState().open;
    act(() => {
      useMissionWizardStore.setState({ open: true, armedMissionId: null });
    });
    const host = mount();
    await act(async () => {});

    expect(findButton(host, 'Voltar aos panes')).toBeNull();
  });
});
