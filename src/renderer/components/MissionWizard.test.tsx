/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionWizard } from './MissionWizard';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useOrchStore } from '../state/orch-store';
import type { Squad } from '../../shared/orch-types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const initialWizard = useMissionWizardStore.getState();
const initialOrch = useOrchStore.getState();

const squad: Squad = {
  id: 'squad-1',
  name: 'Test Squad',
  orchestratorInstructions: 'Orch.',
  agents: [
    {
      id: 'orch',
      agentName: 'Orch',
      category: 'orchestrator',
      cli: 'claude',
    },
  ],
  createdAt: '1',
  builtin: false,
};

/** Objetivo que a heurística sugere como lane ops (backup/VPS/subir). */
const OPS_GOAL = 'fazer backup na VPS e subir a landing page';

const submitMissionIntent = vi.fn(async (input: { goal: string }) => ({
  id: 'mission-armed-1',
  title: 'Test',
  description: input.goal,
  status: 'pending' as const,
  milestones: [],
  learnings: '',
  intentState: 'awaiting_approval' as const,
  intentVersion: 1,
  intentContract: {
    version: 1 as const,
    source: 'typed' as const,
    goal: input.goal,
    acceptanceCriteria: [],
    risk: 'normal' as const,
    executionMode: 'assisted' as const,
    contextPolicy: 'on-demand' as const,
    intentVersion: 1,
    budgets: { planningTokens: 100, executionTokens: 100, maxWorkers: 1 },
  },
  createdAt: 1,
  updatedAt: 1,
}));

function mount(element: React.ReactElement): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, root };
}

function typeGoal(host: HTMLElement, value: string): void {
  const textarea = host.querySelector('textarea');
  if (!textarea) throw new Error('goal textarea not rendered');
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('textarea value setter unavailable');
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function clickButton(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`button "${label}" not found`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function submitAndFlush(host: HTMLElement): Promise<void> {
  clickButton(host, 'Começar missão');
  await act(async () => {});
}

describe('MissionWizard lane default (sem restrições)', () => {
  beforeEach(() => {
    submitMissionIntent.mockClear();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        adapters: { list: vi.fn(async () => []) },
        settings: { orchGet: vi.fn(async () => ({})) },
        orch: {
          submitMissionIntent,
          getMissionPromptQueue: vi.fn(async () => null),
        },
      },
    });
    useOrchStore.setState({ squads: [squad], missions: [], paneMissions: {} });
    useMissionWizardStore.getState().openForArmedMission('squad-1', 'mission-armed-1');
  });

  afterEach(() => {
    useMissionWizardStore.setState(initialWizard);
    useOrchStore.setState(initialOrch);
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('submits lane standard for an infra-sounding goal when advanced stays collapsed', async () => {
    const { host } = mount(<MissionWizard />);
    await act(async () => {});

    // Seção avançada colapsada por padrão: sem jargão de lanes na vista.
    expect(host.textContent).toContain('Opções avançadas');
    expect(host.textContent).not.toContain('Sem restrições (recomendado)');
    expect(host.textContent).not.toContain('Sugerido pelo objetivo');

    typeGoal(host, OPS_GOAL);
    await act(async () => {});
    await submitAndFlush(host);

    expect(submitMissionIntent).toHaveBeenCalledOnce();
    expect(submitMissionIntent.mock.calls[0]?.[0]).toMatchObject({
      goal: OPS_GOAL,
      lane: 'standard',
    });
  });

  it('shows the goal suggestion only inside the advanced section', async () => {
    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    typeGoal(host, OPS_GOAL);
    await act(async () => {});

    expect(host.textContent).not.toContain('Sugerido pelo objetivo');

    clickButton(host, 'Opções avançadas');
    await act(async () => {});

    expect(host.textContent).toContain('Sem restrições (recomendado)');
    expect(host.textContent).toContain('Só pesquisar (não muda nada)');
    expect(host.textContent).toContain('Só planejar (escreve apenas o plano)');
    expect(host.textContent).toContain('Só infra (não edita código do projeto)');
    expect(host.textContent).toContain('Sugerido pelo objetivo');
  });

  it('applies the goal suggestion inside advanced, and honors an explicit pick', async () => {
    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    typeGoal(host, OPS_GOAL);
    clickButton(host, 'Opções avançadas');
    await act(async () => {});

    // Sugestão preenche a escolha dentro do avançado (ops para goal de infra).
    await submitAndFlush(host);
    expect(submitMissionIntent.mock.calls[0]?.[0]).toMatchObject({
      lane: 'ops',
    });
  });

  it('submits the explicit restriction the user picked in advanced', async () => {
    const { host } = mount(<MissionWizard />);
    await act(async () => {});
    typeGoal(host, OPS_GOAL);
    clickButton(host, 'Opções avançadas');
    await act(async () => {});

    const consultRadio = [...host.querySelectorAll('label')].find((label) =>
      label.textContent?.includes('Só pesquisar'),
    )?.querySelector('input[type="radio"]');
    if (!consultRadio) throw new Error('consult radio not found');
    act(() => {
      consultRadio.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {});

    await submitAndFlush(host);
    expect(submitMissionIntent.mock.calls[0]?.[0]).toMatchObject({
      lane: 'consult',
    });
  });
});
