/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { orphanSealedPlanMessage } from '../../shared/mission-plan-orphan';
import { setActiveWorkspacePath } from '../state/active-workspace';
import { useOrchStore } from '../state/orch-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { MissionRail } from './MissionRail';
import { OrchestrationPanel } from './OrchestrationPanel';

/**
 * "Não mostra a causa do erro, não consigo entender, resolver, ajustar — ou
 * seja, nexus não opera." O rail e o painel diziam apenas "bloqueada" /
 * "Clique para retomar". A razão já estava gravada na descrição da missão.
 */

vi.mock('../orch/mission-reopen', () => ({
  livePaneIdsForMission: vi.fn(() => []),
}));

vi.mock('../orch/confirm-reopen-mission', () => ({
  confirmAndReopenMission: vi.fn(async () => ({ ok: true })),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const initialOrch = useOrchStore.getState();
const initialWorkspace = useWorkspaceStore.getState();

function blockedMission(description: string): Mission {
  return {
    id: 'mission-blocked-cause',
    title: 'Execução + QA',
    description,
    status: 'blocked',
    intentState: 'blocked_user',
    milestones: [],
    learnings: '',
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

let currentMission: Mission = blockedMission('objetivo do operador');

function installNexusApi(): void {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      integrations: {
        hasGithubToken: vi.fn(async () => false),
        hasLinearKey: vi.fn(async () => false),
      },
      orch: {
        listMissions: vi.fn(async () => [currentMission]),
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

function mount(element: React.ReactElement): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return { host, root };
}

async function renderWith(description: string): Promise<{
  text: string;
  root: Root;
}> {
  currentMission = blockedMission(description);
  installNexusApi();
  // O painel de missão precisa estar aberto na aba de missões.
  useOrchStore.setState({ panelOpen: true, panelTab: 'missions' });
  await act(async () => {
    await useOrchStore.getState().hydrate('/ws/nexus');
  });
  const { host, root } = mount(
    <>
      <MissionRail />
      <OrchestrationPanel />
    </>,
  );
  // O rail agrupa missões bloqueadas numa seção recolhida; a causa precisa
  // estar no card assim que a seção abre.
  for (const label of ['Encerradas', 'Em progresso', 'Na fila']) {
    const section = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(label),
    );
    if (section) {
      act(() => {
        section.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }
  }
  return { text: host.textContent ?? '', root };
}

describe('a causa do bloqueio chega ao rail e ao painel de missão', () => {
  beforeEach(() => {
    localStorage.clear();
    setActiveWorkspacePath('/ws/nexus');
    useWorkspaceStore.setState({
      current: { path: '/ws/nexus', name: 'nexus', lastOpenedAt: 1 },
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

  it('falha de despacho aparece com o próximo passo', async () => {
    const { text, root } = await renderWith(
      'objetivo\n\n[NEXUS_TASK_DISPATCH_BLOCKED]\n## Worker bloqueado\nO despacho abortou.\n',
    );

    expect(text).toContain(
      'O despacho da tarefa abortou antes de o worker começar.',
    );
    expect(text).toContain(
      'Abra o diagnóstico da missão e clique em Retomar missão.',
    );
    act(() => root.unmount());
  });

  it('plano órfão aparece nomeado, com a saída', async () => {
    const { text, root } = await renderWith(
      `objetivo\n\n## Plano\n${orphanSealedPlanMessage({
        missionIntentVersion: 2,
        sealedIntentVersions: [1],
      })}\n`,
    );

    expect(text).toContain(
      'O plano selado ficou numa versão anterior da intenção.',
    );
    expect(text).toContain(
      'Retome a missão para re-selar o plano na versão atual.',
    );
    act(() => root.unmount());
  });

  it('sem razão gravada, admite em vez de inventar "aguardando decisão"', async () => {
    const { text, root } = await renderWith('quero testar o nexus ao extremo');

    expect(text).toContain('Motivo não registrado');
    expect(text).toContain(
      'Abra o diagnóstico da missão para ver o que aconteceu.',
    );
    expect(text).not.toContain('travada aguardando decisão');
    act(() => root.unmount());
  });

  it('nenhuma superfície vaza caminho absoluto do worktree', async () => {
    const { text, root } = await renderWith(
      'objetivo\n\n[NEXUS_INTERRUPTED_WORKTREE_RESERVATION]\n' +
        '## Worker bloqueado\nworktree /Users/alguem/dev/nexus-ide/.worktrees/task-1 reservado\n',
    );

    expect(text).toContain(
      'Outra tarefa já reservou os mesmos arquivos desta missão.',
    );
    expect(text).not.toContain('/Users/alguem');
    act(() => root.unmount());
  });
});
