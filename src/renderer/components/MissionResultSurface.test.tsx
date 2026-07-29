/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIOR_MISSION_MEMORY_SEPARATOR } from '../../shared/mission-result-format';
import type { Mission } from '../../shared/orch-types';
import { setActiveWorkspacePath } from '../state/active-workspace';
import { useOrchStore } from '../state/orch-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { MissionRail } from './MissionRail';
import { OrchestrationPanel } from './OrchestrationPanel';

const { confirmAndReopenMissionMock } = vi.hoisted(() => ({
  confirmAndReopenMissionMock: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../orch/mission-reopen', () => ({
  livePaneIdsForMission: vi.fn(() => []),
}));

vi.mock('../orch/confirm-reopen-mission', () => ({
  confirmAndReopenMission: confirmAndReopenMissionMock,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const initialOrch = useOrchStore.getState();
const initialWorkspace = useWorkspaceStore.getState();

const finalSynthesis = 'SÍNTESE-FINAL-PRESERVADA-DEPOIS-DO-RESTART';
const finalOutputPrefix = [
  '## Especialistas',
  'Execução e QA entregaram suas perspectivas completas.',
  '',
].join('\n');
const finalOutputSuffix = [
  '',
  '## Maestro',
  'A missão foi concluída com retomada segura e sem panes fantasmas.',
  '- Codex e Claude autenticados.',
  '- Teardown físico confirmado pelo Main.',
  '',
  finalSynthesis,
].join('\n');
const priorMemoryTail =
  '## Padrões anteriores\nDecisão antiga preservada sem ocultar a entrega.';
const resultPadding = 'x'.repeat(
  65_536 -
    finalOutputPrefix.length -
    finalOutputSuffix.length -
    PRIOR_MISSION_MEMORY_SEPARATOR.length -
    priorMemoryTail.length,
);
const nearLimitFinalOutput =
  `${finalOutputPrefix}${resultPadding}${finalOutputSuffix}` +
  `${PRIOR_MISSION_MEMORY_SEPARATOR}${priorMemoryTail}`;

const completedMission: Mission = {
  id: 'mission-durable-result',
  title: 'Corrigir autenticação das CLIs',
  description: 'Validar panes, retomada e autenticação.',
  status: 'done',
  intentState: 'done',
  milestones: [],
  learnings: nearLimitFinalOutput,
  createdAt: 1_000,
  updatedAt: 2_000,
};

function installNexusApi(): void {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      integrations: {
        hasGithubToken: vi.fn(async () => false),
        hasLinearKey: vi.fn(async () => false),
      },
      orch: {
        listMissions: vi.fn(async () => [completedMission]),
        listHandoffs: vi.fn(async () => []),
        getTodos: vi.fn(async () => []),
        listSquads: vi.fn(async () => []),
        getMcpInfo: vi.fn(async () => ({
          running: true,
          url: 'http://127.0.0.1',
          toolCount: 71,
        })),
        removeMission: vi.fn(async () => ({ removed: true })),
      },
    },
  });
}

function mount(element: React.ReactElement): {
  host: HTMLDivElement;
  root: Root;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, root };
}

describe('durable mission result surface', () => {
  beforeEach(() => {
    localStorage.clear();
    installNexusApi();
    confirmAndReopenMissionMock.mockClear();
    setActiveWorkspacePath('/ws/nexus');
    useWorkspaceStore.setState({
      current: {
        path: '/ws/nexus',
        name: 'nexus',
        lastOpenedAt: 1,
      },
      hydrated: true,
    });
    useOrchStore.getState().resetProjectState();
  });

  afterEach(() => {
    useOrchStore.setState(initialOrch);
    useWorkspaceStore.setState(initialWorkspace);
    setActiveWorkspacePath(null);
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('opens the persisted final result after restart without recreating a pane', async () => {
    expect(completedMission.learnings).toHaveLength(65_536);
    await act(async () => {
      await useOrchStore.getState().hydrate('/ws/nexus');
    });
    expect(useOrchStore.getState().paneMissions).toEqual({});
    expect(useOrchStore.getState().missions).toEqual([completedMission]);

    const { host, root } = mount(
      <>
        <MissionRail />
        <OrchestrationPanel />
      </>,
    );
    const completedSection = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.includes('Concluídas'),
    );
    act(() => {
      completedSection?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    const missionButton = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(completedMission.title),
    );
    expect(host.textContent).toContain(completedMission.title);
    expect(missionButton).toBeDefined();

    act(() => {
      missionButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    const result = host.querySelector('[data-testid="mission-result-detail"]');
    const output = host.querySelector('[data-testid="mission-result-output"]');
    expect(result?.textContent).toContain('Resultado final');
    expect(output?.textContent).toContain('## Maestro');
    expect(output?.textContent).toContain('## Especialistas');
    expect(output?.textContent).toContain(
      'A missão foi concluída com retomada segura',
    );
    expect(output?.textContent).toContain(finalSynthesis);
    expect(output?.textContent).not.toContain('## Padrões anteriores');
    expect(result?.textContent).toContain('## Padrões anteriores');
    expect(result?.textContent).toContain(
      'O relatório atingiu o limite de 64 KiB',
    );
    expect(confirmAndReopenMissionMock).not.toHaveBeenCalled();
    expect(useOrchStore.getState().paneMissions).toEqual({});

    act(() => root.unmount());
  });
});
