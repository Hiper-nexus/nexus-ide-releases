/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, TodoList, TodoStatus } from '../../../shared/orch-types';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { TaskBoardWorkspace } from './TaskBoardWorkspace';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const TODO_LIST: TodoList = {
  id: 'release-list',
  updatedAt: 2,
  items: [
    {
      id: 'prepare-release',
      name: 'Preparar release',
      status: 'todo',
      createdAt: 1,
    },
    {
      id: 'publish-notes',
      name: 'Publicar notas',
      status: 'done',
      createdAt: 2,
    },
  ],
};

const LEGACY_MISSION: Mission = {
  id: 'mission-must-stay-untouched',
  title: 'Missão que não pertence ao Quadro',
  description: '',
  status: 'running',
  milestones: [],
  learnings: '',
  createdAt: 1,
  updatedAt: 2,
};

const orchBoundary = {
  setTodoStatus: vi.fn(),
  updateMission: vi.fn(),
  reopenMission: vi.fn(),
  removeMission: vi.fn(),
};

const mountedRoots: Array<{ host: HTMLDivElement; root: Root }> = [];

function mount(node: ReactNode): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push({ host, root });
  act(() => root.render(node));
  return host;
}

function installNexusBoundary(): void {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      orch: orchBoundary,
    },
  });
}

function statusControl(
  host: HTMLElement,
  itemName: string,
): HTMLSelectElement {
  const control = [...host.querySelectorAll<HTMLSelectElement>('select')].find(
    (candidate) => {
      const context =
        candidate.getAttribute('aria-label') ??
        candidate.closest('li, article, [role="row"]')?.textContent ??
        '';
      return context.toLocaleLowerCase('pt-BR').includes(
        itemName.toLocaleLowerCase('pt-BR'),
      );
    },
  );
  if (!control) {
    throw new Error(`No status control found for ${itemName}`);
  }
  return control;
}

async function chooseStatus(
  control: HTMLSelectElement,
  status: TodoStatus,
): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('HTMLSelectElement value setter unavailable');

  await act(async () => {
    setter.call(control, status);
    control.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  orchBoundary.setTodoStatus.mockReset();
  orchBoundary.updateMission.mockReset();
  orchBoundary.reopenMission.mockReset();
  orchBoundary.removeMission.mockReset();
  installNexusBoundary();
  useOrchStore.setState({
    missions: [LEGACY_MISSION],
    todoLists: [],
    selectedMissionId: null,
    boardOpen: false,
  });
  useProductNavigationStore.setState({
    destination: { kind: 'task-board' },
    settingsReturnDestination: null,
  });
});

afterEach(() => {
  for (const { root } of mountedRoots.splice(0).reverse()) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'nexus');
  vi.clearAllMocks();
});

describe('TaskBoardWorkspace contracts', () => {
  it('renders only canonical todoLists from useOrchStore and never mission pipeline records', () => {
    useOrchStore.setState({ todoLists: [TODO_LIST] });
    const host = mount(<TaskBoardWorkspace />);

    expect(host.textContent).toContain('Preparar release');
    expect(host.textContent).toContain('Publicar notas');
    expect(host.textContent).not.toContain(LEGACY_MISSION.title);
    expect(host.textContent).not.toMatch(/Retomar missão|Bloquear missão|Remover missão/i);

    const replacement: TodoList = {
      id: 'next-list',
      updatedAt: 3,
      items: [
        {
          id: 'verify-package',
          name: 'Verificar pacote local',
          status: 'in_progress',
          createdAt: 3,
        },
      ],
    };
    act(() => useOrchStore.setState({ todoLists: [replacement] }));

    expect(host.textContent).toContain('Verificar pacote local');
    expect(host.textContent).not.toContain('Preparar release');
  });

  it('persists an exact canonical status through todo IPC, updates the projected list, and performs no mission mutation', async () => {
    const updatedList: TodoList = {
      ...TODO_LIST,
      updatedAt: 3,
      items: TODO_LIST.items.map((item) =>
        item.id === 'prepare-release'
          ? { ...item, status: 'in_progress' }
          : item,
      ),
    };
    orchBoundary.setTodoStatus.mockResolvedValue(updatedList);
    useOrchStore.setState({ todoLists: [TODO_LIST] });
    const host = mount(<TaskBoardWorkspace />);
    const control = statusControl(host, 'Preparar release');

    expect([...control.options].map((option) => option.value)).toEqual([
      'todo',
      'in_progress',
      'done',
    ]);

    await chooseStatus(control, 'in_progress');

    expect(orchBoundary.setTodoStatus).toHaveBeenCalledOnce();
    expect(orchBoundary.setTodoStatus).toHaveBeenCalledWith(
      'release-list',
      'prepare-release',
      'in_progress',
    );
    expect(useOrchStore.getState().todoLists).toEqual([updatedList]);
    expect(statusControl(host, 'Preparar release').value).toBe('in_progress');
    expect(useOrchStore.getState().missions).toEqual([LEGACY_MISSION]);
    expect(orchBoundary.updateMission).not.toHaveBeenCalled();
    expect(orchBoundary.reopenMission).not.toHaveBeenCalled();
    expect(orchBoundary.removeMission).not.toHaveBeenCalled();
  });

  it('shows one useful empty-state CTA that opens mission creation', () => {
    useOrchStore.setState({
      todoLists: [{ id: 'empty-list', items: [], updatedAt: 1 }],
    });
    const host = mount(<TaskBoardWorkspace />);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];

    expect(host.textContent).toMatch(/sem tarefas|nenhuma tarefa/i);
    expect(buttons).toHaveLength(1);
    expect(
      buttons[0]!.getAttribute('aria-label') ?? buttons[0]!.textContent ?? '',
    ).toMatch(/criar.*missão|nova missão/i);

    act(() => buttons[0]!.click());

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });
    expect(orchBoundary.updateMission).not.toHaveBeenCalled();
    expect(orchBoundary.reopenMission).not.toHaveBeenCalled();
    expect(orchBoundary.removeMission).not.toHaveBeenCalled();
  });
});
