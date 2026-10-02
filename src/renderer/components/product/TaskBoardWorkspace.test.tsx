/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionSummarySnapshot } from '../../../shared/mission-engine-contract';
import { MISSION_OPERATOR_APPROVED_MARKER } from '../../../shared/mission-recovery-policy';
import type { Mission, TodoList, TodoStatus } from '../../../shared/orch-types';
import { useConfirmStore } from '../../state/confirm-store';
import { useMissionSetupStore } from '../../state/mission-setup-store';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useWorkspaceStore } from '../../state/workspace-store';
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
  clearTodoBoard: vi.fn(),
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
  orchBoundary.clearTodoBoard.mockReset();
  orchBoundary.updateMission.mockReset();
  orchBoundary.reopenMission.mockReset();
  orchBoundary.removeMission.mockReset();
  installNexusBoundary();
  useOrchStore.setState({
    missions: [LEGACY_MISSION],
    missionSummaries: [],
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
  useConfirmStore.setState({ pending: null, queue: [] });
  useWorkspaceStore.setState({ current: null });
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'nexus');
  vi.clearAllMocks();
});

describe('TaskBoardWorkspace contracts', () => {
  it('keeps a new mission action visible while the board has work', () => {
    const host = mount(<TaskBoardWorkspace />);
    const action = host.querySelector<HTMLButtonElement>('.task-board-workspace__new');
    expect(action).not.toBeNull();
    act(() => action!.click());
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'mission-setup' });
    expect(orchBoundary.setTodoStatus).not.toHaveBeenCalled();
  });

  it('lets the operator cancel an armed cleanup without changing the board', () => {
    useOrchStore.setState({ todoLists: [TODO_LIST] });
    const host = mount(<TaskBoardWorkspace />);
    act(() => host.querySelector<HTMLButtonElement>('.task-board-workspace__clear')!.click());
    const cancel = host.querySelector<HTMLButtonElement>('[aria-label="Cancelar limpeza"]');
    expect(cancel).not.toBeNull();
    act(() => cancel!.click());
    expect(host.querySelector('.task-board-workspace__clear')?.textContent).toMatch(/Limpar concluídas/);
    expect(orchBoundary.clearTodoBoard).not.toHaveBeenCalled();
    expect(useOrchStore.getState().todoLists).toEqual([TODO_LIST]);
  });

  it('shows a running mission on the board even before any task exists', () => {
    const host = mount(<TaskBoardWorkspace />);

    expect(host.textContent).toContain(LEGACY_MISSION.title);
    const lane = host.querySelector<HTMLElement>(
      '.mission-kanban__lane[data-lane="building"]',
    );
    expect(lane?.querySelector('h2')?.textContent).toBe('Construindo');
    expect(
      lane?.querySelector('.mission-kanban__card-state')?.textContent,
    ).toBe('Trabalhando');
    expect(host.textContent).not.toMatch(/rodando/i);
    expect(host.textContent).not.toMatch(/sem tarefas no fluxo/i);
    expect(host.querySelector('.task-board-workspace__empty')).toBeNull();
  });

  it('opens the running mission from the board card without mutating todos', () => {
    const host = mount(<TaskBoardWorkspace />);
    const open = host.querySelector<HTMLButtonElement>(
      '.mission-kanban__card-open',
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

  it('limpa concluídas com confirmação em dois cliques e projeta o resultado', async () => {
    useOrchStore.setState({ todoLists: [TODO_LIST] });
    const host = mount(<TaskBoardWorkspace />);
    const clearButton = () =>
      host.querySelector<HTMLButtonElement>(
        '.task-board-workspace__clear',
      );
    if (!clearButton()) throw new Error('botão limpar ausente com item done');

    // Primeiro clique ARMA a confirmação; nada é escrito.
    act(() => clearButton()!.click());
    expect(orchBoundary.clearTodoBoard).not.toHaveBeenCalled();
    expect(clearButton()!.textContent).toMatch(/confirmar/i);

    const remaining: TodoList = {
      id: 'release-list',
      updatedAt: 9,
      items: TODO_LIST.items.filter((item) => item.status !== 'done'),
    };
    orchBoundary.clearTodoBoard.mockResolvedValue({
      removedLists: 0,
      removedItems: 1,
      todoLists: [remaining],
    });

    await act(async () => {
      clearButton()!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(orchBoundary.clearTodoBoard).toHaveBeenCalledOnce();
    expect(useOrchStore.getState().todoLists).toEqual([remaining]);
    expect(host.textContent).not.toContain('Publicar notas');
    // Sem itens concluídos restantes, o botão sai do cabeçalho.
    expect(clearButton()).toBeNull();
    expect(orchBoundary.removeMission).not.toHaveBeenCalled();
  });

  it('falha da limpeza mantém o quadro e mostra erro acionável', async () => {
    useOrchStore.setState({ todoLists: [TODO_LIST] });
    const host = mount(<TaskBoardWorkspace />);
    const clearButton = () =>
      host.querySelector<HTMLButtonElement>(
        '.task-board-workspace__clear',
      );

    act(() => clearButton()!.click());
    orchBoundary.clearTodoBoard.mockRejectedValue(new Error('boom'));

    await act(async () => {
      clearButton()!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Não foi possível limpar o quadro');
    expect(host.textContent).toContain('Publicar notas');
    expect(useOrchStore.getState().todoLists).toEqual([TODO_LIST]);
  });

  it('sem itens concluídos o botão de limpar não existe', () => {
    useOrchStore.setState({
      todoLists: [
        {
          id: 'live-list',
          updatedAt: 1,
          items: [
            { id: 'a', name: 'Só em curso', status: 'in_progress', createdAt: 1 },
          ],
        },
      ],
    });
    const host = mount(<TaskBoardWorkspace />);

    expect(
      host.querySelector('.task-board-workspace__clear'),
    ).toBeNull();
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

function summary(
  overrides: Partial<MissionSummarySnapshot> = {},
): MissionSummarySnapshot {
  return {
    id: 'mission-summary',
    title: 'Missão',
    state: 'running',
    progress: { completed: 0, total: 0 },
    needsAttention: false,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function cardTitles(scope: ParentNode | null): string[] {
  return [...(scope?.querySelectorAll('.mission-kanban__card-title') ?? [])].map(
    (node) => node.textContent ?? '',
  );
}

describe('TaskBoardWorkspace — lanes de missão derivadas do snapshot', () => {
  it('projeta cada estado na lane certa, cabeçalho "● nome · contagem" e arquivo recolhido', () => {
    const now = Date.now();
    useOrchStore.setState({
      missions: [
        {
          ...LEGACY_MISSION,
          id: 'done-approved',
          status: 'done',
          description: `Entregue\n${MISSION_OPERATOR_APPROVED_MARKER}`,
        },
        { ...LEGACY_MISSION, id: 'done-pending', status: 'done' },
      ],
      missionSummaries: [
        summary({ id: 'live', title: 'Construindo agora', state: 'running', updatedAt: now }),
        summary({
          id: 'plan',
          title: 'Plano pronto',
          state: 'review_ready',
          updatedAt: now - 5 * 60_000,
        }),
        summary({
          id: 'done-pending',
          title: 'Entrega para revisar',
          state: 'completed',
          updatedAt: now - 2 * 3_600_000,
        }),
        summary({
          id: 'ask',
          title: 'Pergunta aberta',
          state: 'blocked_user',
          needsAttention: true,
          stateReason: { code: 'open-question', label: 'Aguardando sua resposta' },
          updatedAt: now,
        }),
        summary({
          id: 'done-approved',
          title: 'Entrega aceita',
          state: 'completed',
          updatedAt: now - 3 * 86_400_000,
        }),
        summary({
          id: 'broken',
          title: 'Deu ruim',
          state: 'failed',
          needsAttention: true,
          updatedAt: now,
        }),
      ],
      todoLists: [],
    });
    const host = mount(<TaskBoardWorkspace />);

    const lanes = [
      ...host.querySelectorAll<HTMLElement>('.mission-kanban__lane'),
    ];
    expect(lanes.map((lane) => lane.dataset.lane)).toEqual([
      'building',
      'validating',
      'needs_you',
      'ready',
    ]);
    expect(lanes.map((lane) => lane.querySelector('h2')?.textContent)).toEqual([
      'Construindo',
      'Validando',
      'Precisa de você',
      'Pronto',
    ]);
    expect(
      lanes.map(
        (lane) => lane.querySelector('.mission-kanban__lane-count')?.textContent,
      ),
    ).toEqual(['1', '2', '1', '1']);
    expect(
      lanes.every((lane) => lane.querySelector('.mission-kanban__lane-dot')),
    ).toBe(true);
    expect(cardTitles(lanes[0]!)).toEqual(['Construindo agora']);
    expect(cardTitles(lanes[1]!)).toEqual(['Plano pronto', 'Entrega para revisar']);
    expect(cardTitles(lanes[2]!)).toEqual(['Pergunta aberta']);
    expect(cardTitles(lanes[3]!)).toEqual(['Entrega aceita']);
    expect(
      lanes[1]!.querySelectorAll('.mission-kanban__card-state')[1]?.textContent,
    ).toBe('Pronto para revisar');

    // Falha nunca divide coluna com sucesso: mora na gaveta, recolhida.
    const archive = host.querySelector<HTMLDetailsElement>(
      'details.mission-kanban__archive',
    );
    expect(archive).not.toBeNull();
    expect(archive!.open).toBe(false);
    expect(archive!.querySelector('summary')?.textContent).toContain('Arquivo');
    expect(
      archive!.querySelector('.mission-kanban__lane-count')?.textContent,
    ).toBe('1');
    expect(cardTitles(archive!)).toEqual(['Deu ruim']);
    expect(lanes[3]!.textContent).not.toContain('Deu ruim');
    expect(host.textContent).toContain('6 missões no fluxo');
  });

  it('dentro da lane, atenção vem primeiro e depois a mais recente', () => {
    const now = Date.now();
    useOrchStore.setState({
      missions: [],
      missionSummaries: [
        summary({ id: 'old', title: 'Velha', state: 'running', updatedAt: now - 3 * 3_600_000 }),
        summary({ id: 'new', title: 'Nova', state: 'starting', updatedAt: now }),
        summary({
          id: 'repair-quiet',
          title: 'Reparo sem alerta',
          state: 'blocked_technical',
          needsAttention: false,
          updatedAt: now,
        }),
        summary({
          id: 'ask-old',
          title: 'Pergunta antiga',
          state: 'blocked_user',
          needsAttention: true,
          updatedAt: now - 86_400_000,
        }),
      ],
      todoLists: [],
    });
    const host = mount(<TaskBoardWorkspace />);

    expect(
      cardTitles(host.querySelector('.mission-kanban__lane[data-lane="building"]')),
    ).toEqual(['Nova', 'Velha']);
    expect(
      cardTitles(host.querySelector('.mission-kanban__lane[data-lane="needs_you"]')),
    ).toEqual(['Pergunta antiga', 'Reparo sem alerta']);
  });

  it('o card diz título, estado em palavra e idade curta sem segundos — e não se arrasta', () => {
    useOrchStore.setState({
      missions: [],
      missionSummaries: [
        summary({
          id: 'x',
          title: 'Missão X',
          state: 'running',
          updatedAt: Date.now() - 5 * 60_000,
        }),
      ],
      todoLists: [],
    });
    const host = mount(<TaskBoardWorkspace />);
    const card = host.querySelector<HTMLElement>('.mission-kanban__card');

    expect(card?.querySelector('.mission-kanban__card-title')?.textContent).toBe(
      'Missão X',
    );
    expect(card?.querySelector('.mission-kanban__card-state')?.textContent).toBe(
      'Trabalhando',
    );
    const age = card?.querySelector<HTMLTimeElement>('time.mission-kanban__card-age');
    expect(age?.textContent).toBe('5m');
    expect(age?.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(card?.textContent).not.toContain('running');
    expect(host.querySelectorAll('[draggable="true"]')).toHaveLength(0);
  });

  it('o snapshot canônico manda sobre a linha legada do mesmo id, sem duplicar o card', () => {
    useOrchStore.setState({
      missions: [LEGACY_MISSION],
      missionSummaries: [
        summary({
          id: LEGACY_MISSION.id,
          title: LEGACY_MISSION.title,
          state: 'blocked_user',
          needsAttention: true,
          stateReason: { code: 'open-question', label: 'Aguardando sua resposta' },
        }),
      ],
      todoLists: [],
    });
    const host = mount(<TaskBoardWorkspace />);

    expect(host.querySelectorAll('.mission-kanban__card')).toHaveLength(1);
    expect(
      cardTitles(host.querySelector('.mission-kanban__lane[data-lane="needs_you"]')),
    ).toEqual([LEGACY_MISSION.title]);
    expect(host.textContent).toContain('1 missão no fluxo');
  });

  it('abre a missão a partir da gaveta de arquivo sem mutar nada', () => {
    useOrchStore.setState({
      missions: [],
      missionSummaries: [
        summary({ id: 'broken', title: 'Falhou feio', state: 'failed', needsAttention: true }),
      ],
      todoLists: [],
    });
    const host = mount(<TaskBoardWorkspace />);

    expect(
      host.querySelectorAll('.mission-kanban__lane .mission-kanban__card'),
    ).toHaveLength(0);
    const open = host.querySelector<HTMLButtonElement>(
      '.mission-kanban__archive .mission-kanban__card-open',
    );
    if (!open) throw new Error('Card do arquivo não renderizou');
    act(() => open.click());

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'broken',
      surface: 'board',
    });
    expect(orchBoundary.updateMission).not.toHaveBeenCalled();
    expect(orchBoundary.removeMission).not.toHaveBeenCalled();
  });

  it('missão parada fica à vista em Precisa de você e só ela ganha Remover (F-741)', async () => {
    useWorkspaceStore.setState({
      current: { path: '/projeto', name: 'Projeto', lastOpenedAt: 1 },
    });
    orchBoundary.removeMission.mockResolvedValue({ removed: true });
    useOrchStore.setState({
      missions: [],
      missionSummaries: [
        summary({ id: 'live', title: 'Construindo agora', state: 'running' }),
        summary({
          id: 'stopped',
          title: 'Parada pelo operador',
          state: 'blocked_user',
          stateReason: { code: 'runtime-closed', label: 'Parou' },
        }),
      ],
      todoLists: [],
    });
    const host = mount(<TaskBoardWorkspace />);

    const needsYou = host.querySelector('.mission-kanban__lane[data-lane="needs_you"]');
    expect(cardTitles(needsYou)).toEqual(['Parada pelo operador']);
    expect(host.querySelector('details.mission-kanban__archive')).toBeNull();
    const removes = [
      ...host.querySelectorAll<HTMLButtonElement>('.mission-kanban__card-remove'),
    ];
    expect(removes.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Remover a missão Parada pelo operador',
    ]);

    act(() => removes[0]!.click());
    const pending = useConfirmStore.getState().pending;
    expect(pending?.title).toBe('Remover "Parada pelo operador"?');
    expect(pending?.danger).toBe(true);
    expect(orchBoundary.removeMission).not.toHaveBeenCalled();

    await act(async () => {
      useConfirmStore.getState().decide(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(orchBoundary.removeMission).toHaveBeenCalledWith('stopped');
    expect(orchBoundary.updateMission).not.toHaveBeenCalled();
  });

  it('cancelar o Remover não apaga nada', async () => {
    useWorkspaceStore.setState({
      current: { path: '/projeto', name: 'Projeto', lastOpenedAt: 1 },
    });
    useOrchStore.setState({
      missions: [],
      missionSummaries: [
        summary({ id: 'broken', title: 'Falhou feio', state: 'failed', needsAttention: true }),
      ],
      todoLists: [],
    });
    const host = mount(<TaskBoardWorkspace />);
    const remove = host.querySelector<HTMLButtonElement>(
      '.mission-kanban__archive .mission-kanban__card-remove',
    );
    if (!remove) throw new Error('Card do arquivo sem Remover');

    act(() => remove.click());
    await act(async () => {
      useConfirmStore.getState().decide(false);
      await Promise.resolve();
    });
    expect(orchBoundary.removeMission).not.toHaveBeenCalled();
    expect(useConfirmStore.getState().pending).toBeNull();
  });

  it('sem tarefas, as colunas de tarefa saem de cena; com tarefas, voltam rotuladas', () => {
    const host = mount(<TaskBoardWorkspace />);
    expect(host.querySelectorAll('.task-board-workspace__list')).toHaveLength(0);
    expect(host.querySelector('.mission-kanban__archive')).toBeNull();

    act(() => useOrchStore.setState({ todoLists: [TODO_LIST] }));

    expect(host.querySelectorAll('.task-board-workspace__list')).toHaveLength(3);
    expect(
      [...host.querySelectorAll('.task-board-workspace__group-label')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['Missões', 'Tarefas']);
  });
});
