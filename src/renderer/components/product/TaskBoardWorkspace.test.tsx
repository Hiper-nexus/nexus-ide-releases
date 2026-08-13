/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, TodoList, TodoStatus } from '../../../shared/orch-types';
import { useMissionSetupStore } from '../../state/mission-setup-store';
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
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}


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

function dispatchStatus(
  control: HTMLSelectElement,
  status: TodoStatus,
): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('HTMLSelectElement value setter unavailable');
  setter.call(control, status);
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

async function chooseStatus(
  control: HTMLSelectElement,
  status: TodoStatus,
): Promise<void> {
  await act(async () => {
    dispatchStatus(control, status);
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
    workspaceEpoch: 0,
    boundWorkspacePath: null,
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
  it('shows a running mission on the board even before any task exists', () => {
    const host = mount(<TaskBoardWorkspace />);

    expect(host.textContent).toContain(LEGACY_MISSION.title);
    expect(host.textContent).toMatch(/missão.*rodando/i);
    expect(host.textContent).not.toMatch(/sem tarefas no fluxo/i);
    expect(host.querySelector('.task-board-workspace__empty')).toBeNull();
  });

  it('opens the running mission from the board card without mutating todos', () => {
    const host = mount(<TaskBoardWorkspace />);
    const open = host.querySelector<HTMLButtonElement>(
      '.task-board-workspace__mission-open',
    );
    if (!open) throw new Error('Mission card was not rendered');

    act(() => open.click());

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: LEGACY_MISSION.id,
      surface: 'board',
    });
    expect(orchBoundary.setTodoStatus).not.toHaveBeenCalled();
    expect(orchBoundary.updateMission).not.toHaveBeenCalled();
  });

  it('renders canonical todoLists alongside mission cards', () => {
    useOrchStore.setState({ todoLists: [TODO_LIST] });
    const host = mount(<TaskBoardWorkspace />);

    expect(host.textContent).toContain('Preparar release');
    expect(host.textContent).toContain('Publicar notas');
    expect(host.textContent).toContain(LEGACY_MISSION.title);
    expect(host.textContent).not.toMatch(/Remover missão/i);

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

  it('keeps a newer same-key todo write latched when an older workspace write settles late', async () => {
    const oldWrite = createDeferred<TodoList>();
    const newWrite = createDeferred<TodoList>();
    orchBoundary.setTodoStatus
      .mockReturnValueOnce(oldWrite.promise)
      .mockReturnValueOnce(newWrite.promise);
    useOrchStore.setState({
      todoLists: [TODO_LIST],
      workspaceEpoch: 1,
      boundWorkspacePath: '/workspace/old',
    });
    const host = mount(<TaskBoardWorkspace />);

    act(() => {
      dispatchStatus(statusControl(host, 'Preparar release'), 'in_progress');
    });
    expect(orchBoundary.setTodoStatus).toHaveBeenCalledTimes(1);
    expect(statusControl(host, 'Preparar release').disabled).toBe(true);

    const nextWorkspaceList: TodoList = {
      ...TODO_LIST,
      updatedAt: 20,
      items: TODO_LIST.items.map((item) => ({ ...item, status: item.status })),
    };
    act(() => {
      useOrchStore.setState({
        todoLists: [nextWorkspaceList],
        workspaceEpoch: 2,
        boundWorkspacePath: '/workspace/new',
      });
    });
    expect(statusControl(host, 'Preparar release').disabled).toBe(false);

    act(() => {
      dispatchStatus(statusControl(host, 'Preparar release'), 'done');
    });
    expect(orchBoundary.setTodoStatus).toHaveBeenCalledTimes(2);
    expect(statusControl(host, 'Preparar release').disabled).toBe(true);

    await act(async () => {
      oldWrite.resolve({
        ...TODO_LIST,
        updatedAt: 10,
        items: TODO_LIST.items.map((item) =>
          item.id === 'prepare-release'
            ? { ...item, status: 'in_progress' }
            : item,
        ),
      });
      await oldWrite.promise;
      await Promise.resolve();
    });

    const stillPending = statusControl(host, 'Preparar release');
    expect(stillPending.disabled).toBe(true);
    stillPending.disabled = false;
    act(() => dispatchStatus(stillPending, 'in_progress'));
    expect(orchBoundary.setTodoStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      newWrite.resolve({
        ...nextWorkspaceList,
        updatedAt: 21,
        items: nextWorkspaceList.items.map((item) =>
          item.id === 'prepare-release' ? { ...item, status: 'done' } : item,
        ),
      });
      await newWrite.promise;
      await Promise.resolve();
    });
    expect(statusControl(host, 'Preparar release').disabled).toBe(false);
  });

  it('groups tasks into deterministic PT-BR status columns without exposing canonical list ids', () => {
    const internalIds = ['mission-019f-private', 'global'];
    useOrchStore.setState({
      todoLists: [
        {
          id: internalIds[0]!,
          updatedAt: 1,
          items: [
            {
              id: 'first-item',
              name: 'Revisar o primeiro fluxo',
              status: 'todo',
              createdAt: 1,
            },
          ],
        },
        {
          id: internalIds[1]!,
          updatedAt: 2,
          items: [
            {
              id: 'second-item',
              name: 'Revisar o segundo fluxo',
              status: 'done',
              createdAt: 2,
            },
          ],
        },
      ],
    });
    const host = mount(<TaskBoardWorkspace />);
    const lists = [
      ...host.querySelectorAll<HTMLElement>('.task-board-workspace__list'),
    ];

    expect(lists).toHaveLength(3);
    expect(lists.map((list) => list.querySelector('h2')?.textContent)).toEqual([
      'A fazer',
      'Em andamento',
      'Concluída',
    ]);
    expect(lists.map((list) => list.getAttribute('aria-label'))).toEqual([
      'Tarefas: A fazer',
      'Tarefas: Em andamento',
      'Tarefas: Concluída',
    ]);
    // The 'done' item lands in the 'Concluída' column, not in a list bucket.
    expect(
      lists[2]?.querySelector('.task-board-workspace__item-name')?.textContent,
    ).toBe('Revisar o segundo fluxo');
    for (const id of internalIds) {
      expect(host.textContent).not.toContain(id);
      expect(
        lists.some((list) => list.getAttribute('aria-label')?.includes(id)),
      ).toBe(false);
    }
  });

  it('shows one useful empty-state CTA that opens mission creation', () => {
    useOrchStore.setState({
      missions: [],
      todoLists: [{ id: 'empty-list', items: [], updatedAt: 1 }],
    });
    useMissionSetupStore.setState({
      entryContext: { kind: 'pet-studio', revision: 1 },
    } as never);
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
    expect(
      Reflect.get(useMissionSetupStore.getState(), 'entryContext'),
    ).toBeNull();
    expect(orchBoundary.updateMission).not.toHaveBeenCalled();
    expect(orchBoundary.reopenMission).not.toHaveBeenCalled();
    expect(orchBoundary.removeMission).not.toHaveBeenCalled();
  });
});
