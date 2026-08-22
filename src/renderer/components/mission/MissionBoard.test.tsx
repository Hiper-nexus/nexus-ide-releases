/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  missionSnapshotSchema,
  missionSummarySnapshotSchema,
  type MissionEngineCommand,
  type MissionQuestion as CanonicalMissionQuestion,
  type MissionSnapshot,
  type MissionSummarySnapshot,
} from '../../../shared/mission-engine-contract';
import {
  missionEventSchema,
  type MissionEvent,
} from '../../../shared/mission-events';

interface ControlledQuestionState {
  readonly optionId: string | null;
  readonly text: string;
  readonly pending: boolean;
  readonly error: string | null;
}

class ResizeObserverStub {
  readonly #notify: ResizeObserverCallback;

  constructor(notify: ResizeObserverCallback) {
    this.#notify = notify;
  }

  observe(target: Element): void {
    const contentRect = target.getBoundingClientRect();
    const size = {
      inlineSize: contentRect.width,
      blockSize: contentRect.height,
    };
    this.#notify(
      [
        {
          target,
          contentRect,
          borderBoxSize: [size],
          contentBoxSize: [size],
          devicePixelContentBoxSize: [size],
        },
      ],
      this as unknown as ResizeObserver,
    );
  }

  unobserve(): void {}

  disconnect(): void {}
}

vi.mock('./MissionGraph', () => ({
  MissionGraph: () => <div aria-label="Grafo da missão" />,
}));

vi.mock('./MissionQuestion', () => ({
  MissionQuestion: ({
    missionId,
    question,
    state,
    onStateChange,
    onCommand,
  }: {
    missionId: string;
    question: CanonicalMissionQuestion;
    state: ControlledQuestionState;
    onStateChange: (state: ControlledQuestionState) => void;
    onCommand: (command: MissionEngineCommand) => Promise<MissionSnapshot>;
  }) => (
    <section
      data-testid="mission-question-boundary"
      data-question-id={question.id}
    >
      <strong>{question.prompt}</strong>
      <output data-testid="question-state">
        {state.optionId ?? ''}|{state.text}
      </output>
      <button
        type="button"
        onClick={() =>
          onStateChange({
            ...state,
            optionId: 'option-safe',
            text: '',
          })
        }
      >
        Escolher caminho seguro
      </button>
      <label>
        Resposta livre
        <input
          aria-label="Resposta livre"
          value={state.text}
          onChange={(event) =>
            onStateChange({
              ...state,
              optionId: null,
              text: event.currentTarget.value,
            })
          }
        />
      </label>
      <button
        type="button"
        disabled={state.optionId === null && !state.text.trim()}
        onClick={() =>
          void onCommand(
            state.optionId
              ? {
                  kind: 'answer-question',
                  missionId,
                  questionId: question.id,
                  optionId: state.optionId,
                }
              : {
                  kind: 'answer-question',
                  missionId,
                  questionId: question.id,
                  text: state.text.trim(),
                },
          )
        }
      >
        Responder
      </button>
    </section>
  ),
}));

vi.mock('./MissionInspector', () => ({
  MissionInspector: ({
    snapshot,
    events,
    onCommand,
    question,
  }: {
    snapshot: MissionSnapshot;
    events: MissionEvent[];
    onCommand: (command: MissionEngineCommand) => Promise<MissionSnapshot>;
    question: ReactNode;
  }) => (
    <aside aria-label="Inspetor da missão">
      <div data-testid="journal-events">
        {events.map((event) =>
          typeof event.payload.text === 'string'
            ? event.payload.text
            : event.type,
        )}
      </div>
      <section data-testid="conversation-question">{question}</section>
      <button
        type="button"
        onClick={() =>
          void onCommand({
            kind: 'direct',
            missionId: snapshot.id,
            targetAgentId: null,
            text: 'Direção canônica do inspetor',
          })
        }
      >
        Enviar direção de teste
      </button>
    </aside>
  ),
}));

import { MissionBoard } from './MissionBoard';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

interface ChangeSubscription {
  readonly listener: Parameters<
    Window['nexus']['mission']['onChanged']
  >[0];
  active: boolean;
  readonly unsubscribe: () => void;
}

const api = {
  snapshot: vi.fn<Window['nexus']['mission']['snapshot']>(),
  command: vi.fn<Window['nexus']['mission']['command']>(),
  onChanged: vi.fn<Window['nexus']['mission']['onChanged']>(),
  missionEventsRecent:
    vi.fn<Window['nexus']['orch']['missionEventsRecent']>(),
  missionEventsAck: vi.fn<Window['nexus']['orch']['missionEventsAck']>(),
};

const roots = new Set<Root>();
const subscriptions: ChangeSubscription[] = [];
const HEADER_ACTION_LABELS: Readonly<Partial<Record<string, true>>> = {
  'Tentar início novamente': true,
  Retomar: true,
  Parar: true,
};

function canonicalSnapshot(
  patch: Partial<MissionSnapshot> = {},
): MissionSnapshot {
  return missionSnapshotSchema.parse({
    id: 'mission-alpha',
    title: 'Publicar o Nexus canônico',
    objective: 'Entregar a projeção operacional da missão.',
    workspaceLabel: 'nexus (/projects/nexus)',
    state: 'blocked_technical',
    stateReason: {
      code: 'workspace-lock',
      label: 'Workspace em uso',
      detail: 'A escrita aguarda a liberação do checkout.',
    },
    progress: { completed: 2, total: 5 },
    agents: [
      {
        id: 'coordinator',
        agentName: 'Coordenador principal',
        category: 'orchestrator',
        cli: 'claude',
        model: 'sonnet',
        allowedSkills: [],
        allowedTools: null,
        state: 'working',
        currentUnitId: 'coordinate',
        paneId: 'pane-coordinator',
        detail: 'Mantém a autoridade da missão.',
      },
      {
        id: 'worker',
        agentName: 'Executor de interface',
        category: 'executor',
        cli: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
        allowedSkills: [],
        allowedTools: ['Read', 'Edit'],
        state: 'blocked',
        currentUnitId: 'board',
        paneId: 'pane-worker',
        detail: 'Aguardando o checkout.',
      },
    ],
    edges: [
      {
        id: 'edge-delegation',
        sourceAgentId: 'coordinator',
        targetAgentId: 'worker',
        kind: 'delegation',
        label: 'Implementar quadro',
      },
    ],
    units: [
      {
        id: 'coordinate',
        title: 'Coordenar entrega',
        status: 'running',
        agentId: 'coordinator',
        dependsOn: [],
        evidenceIds: [],
      },
      {
        id: 'board',
        title: 'Implementar quadro',
        status: 'blocked',
        agentId: 'worker',
        dependsOn: ['coordinate'],
        evidenceIds: ['evidence-board-red'],
      },
    ],
    allowedActions: ['retry-kickoff', 'resume', 'stop'],
    version: 7,
    updatedAt: 1_786_080_000_000,
    ...patch,
  });
}

function canonicalSummary(
  patch: Partial<MissionSummarySnapshot> = {},
): MissionSummarySnapshot {
  return missionSummarySnapshotSchema.parse({
    id: 'mission-alpha',
    title: 'Publicar o Nexus canônico',
    state: 'running',
    progress: { completed: 3, total: 5 },
    needsAttention: false,
    updatedAt: 1_786_080_000_100,
    ...patch,
  });
}

function canonicalQuestion(): CanonicalMissionQuestion {
  return {
    id: 'question-path',
    prompt: 'Qual caminho de publicação devemos seguir?',
    detail: 'A escolha altera a ordem das unidades restantes.',
    targetAgentId: 'coordinator',
    options: [
      {
        id: 'option-safe',
        label: 'Publicação gradual',
        description: 'Libera uma etapa por vez.',
      },
      {
        id: 'option-fast',
        label: 'Publicação imediata',
        description: 'Libera todas as etapas juntas.',
      },
    ],
    allowFreeText: true,
  };
}

function canonicalEvent(
  missionId: string,
  text: string,
  sequence = 1,
): MissionEvent {
  return missionEventSchema.parse({
    sequence,
    id: `event-${missionId}-${sequence}`,
    missionId,
    runId: 'operator-direction',
    type: 'custom',
    payload: {
      kind: 'operator_direction',
      targetAgentId: null,
      text,
    },
    idempotencyKey: `operator-direction-${missionId}-${sequence}`,
    occurredAt: 1_786_080_000_000 + sequence,
    origin: 'main',
    deliveryStatus: 'delivered',
  });
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function installNexusApi(): void {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      mission: {
        snapshot: api.snapshot,
        command: api.command,
        onChanged: api.onChanged,
      },
      orch: {
        missionEventsRecent: api.missionEventsRecent,
        missionEventsAck: api.missionEventsAck,
      },
    } as unknown as Window['nexus'],
  });
}

function mount(
  missionId = 'mission-alpha',
  onOpenTerminals = vi.fn<(missionId: string) => void>(),
): {
  readonly host: HTMLDivElement;
  readonly root: Root;
  readonly onOpenTerminals: typeof onOpenTerminals;
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.add(root);
  act(() => {
    root.render(
      <MissionBoard
        missionId={missionId}
        onOpenTerminals={onOpenTerminals}
      />,
    );
  });
  return { host, root, onOpenTerminals };
}

function rerender(
  root: Root,
  missionId: string,
  onOpenTerminals: (missionId: string) => void,
): void {
  act(() => {
    root.render(
      <MissionBoard
        missionId={missionId}
        onOpenTerminals={onOpenTerminals}
      />,
    );
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function normalizedText(node: Element): string {
  return (node.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

function buttonByName(host: ParentNode, name: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find(
    (candidate) => normalizedText(candidate) === name,
  );
  if (!found) throw new Error(`Button not found: ${name}`);
  return found;
}

function actionButtonNames(header: HTMLElement): string[] {
  return Array.from(header.querySelectorAll('button'))
    .map(normalizedText)
    .filter((label) => HEADER_ACTION_LABELS[label] === true);
}

function heading(host: HTMLElement): HTMLElement {
  const found = host.querySelector<HTMLElement>(
    'h1, h2, h3, [role="heading"]',
  );
  if (!found) throw new Error('Mission heading not found');
  return found;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function keyDown(element: HTMLElement, key: string): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function emitChanged(items: MissionSummarySnapshot[]): void {
  const current = [...subscriptions].reverse().find((item) => item.active);
  if (!current) throw new Error('Mission change subscription not registered');
  act(() => current.listener(items));
}

beforeEach(() => {
  subscriptions.length = 0;
  api.snapshot.mockReset();
  api.command.mockReset();
  api.onChanged.mockReset();
  api.missionEventsRecent.mockReset();
  api.missionEventsAck.mockReset();

  api.snapshot.mockResolvedValue(canonicalSnapshot());
  api.command.mockImplementation(async () => canonicalSnapshot());
  api.missionEventsRecent.mockResolvedValue({ events: [] });
  api.missionEventsAck.mockResolvedValue({ ok: true });
  api.onChanged.mockImplementation((listener) => {
    const subscription = {
      listener,
      active: true,
      unsubscribe: vi.fn(),
    };
    subscription.unsubscribe.mockImplementation(() => {
      subscription.active = false;
    });
    subscriptions.push(subscription);
    return subscription.unsubscribe;
  });
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  installNexusApi();
});

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  roots.clear();
  document.body.innerHTML = '';
  Reflect.deleteProperty(window, 'nexus');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MissionBoard canonical controller', () => {
  it('loads through the top-level mission API and renders canonical header facts', async () => {
    const { host } = mount();
    await flush();

    expect(api.snapshot).toHaveBeenCalledTimes(1);
    expect(api.snapshot).toHaveBeenCalledWith('mission-alpha');
    expect(normalizedText(heading(host))).toContain(
      'Publicar o Nexus canônico',
    );

    const header = host.querySelector('header');
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain('nexus (/projects/nexus)');
    expect(header!.textContent).toContain('Precisa de reparo');
    expect(header!.textContent).toMatch(/2\s*\/\s*5/u);
    expect(header!.textContent).toContain('Workspace em uso');
    expect(header!.textContent).toContain(
      'A escrita aguarda a liberação do checkout.',
    );

    const progress = header!.querySelector('progress');
    expect(progress).not.toBeNull();
    expect(progress!.value).toBe(2);
    expect(progress!.max).toBe(5);
  });

  it('header Encerrar/leftover pinta Parou/Dormindo, não Precisa de você', async () => {
    api.snapshot.mockResolvedValue(
      canonicalSnapshot({
        state: 'blocked_user',
        stateReason: { code: 'runtime-closed', label: 'Parou' },
        allowedActions: ['resume'],
      }),
    );
    const { host } = mount();
    await flush();

    const status = host.querySelector('.mission-board__status');
    expect(status?.textContent).toBe('Parou');
    expect(host.querySelector('header')?.textContent).not.toMatch(
      /Precisa de resposta|Precisa de você/,
    );

    api.snapshot.mockResolvedValue(
      canonicalSnapshot({
        state: 'blocked_user',
        stateReason: { code: 'session-sleeping', label: 'Dormindo' },
        allowedActions: ['resume'],
      }),
    );
    const remount = mount();
    await flush();
    expect(remount.host.querySelector('.mission-board__status')?.textContent).toBe(
      'Dormindo',
    );
  });

  it('header pedido humano real é Precisa de você', async () => {
    api.snapshot.mockResolvedValue(
      canonicalSnapshot({
        state: 'blocked_user',
        stateReason: {
          code: 'open-question',
          label: 'Aguardando sua resposta',
        },
        allowedActions: ['answer-question'],
      }),
    );
    const { host } = mount();
    await flush();

    expect(host.querySelector('.mission-board__status')?.textContent).toBe(
      'Precisa de você',
    );
  });

  it('header done persist pinta Pronto mesmo com reason session-dead', async () => {
    api.snapshot.mockResolvedValue(
      canonicalSnapshot({
        state: 'completed',
        stateReason: { code: 'session-dead', label: 'Parou' },
        allowedActions: [],
      }),
    );
    const { host } = mount();
    await flush();

    expect(host.querySelector('.mission-board__status')?.textContent).toBe(
      'Pronto',
    );
    expect(host.querySelector('.mission-board__status')?.textContent).not.toBe(
      'Parou',
    );
  });

  it('exposes a focusable vertical separator that controls the inspector and changes its bounded split from the keyboard', async () => {
    vi.spyOn(
      HTMLElement.prototype,
      'getBoundingClientRect',
    ).mockImplementation(function (this: HTMLElement): DOMRect {
      const width =
        this.classList.contains('mission-board') ||
        this.classList.contains('mission-board__workspace-layout')
          ? 1_200
          : 0;
      return {
        x: 0,
        y: 0,
        width,
        height: 800,
        top: 0,
        right: width,
        bottom: 800,
        left: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });

    api.snapshot.mockResolvedValue(
      canonicalSnapshot({ state: 'running', stateReason: undefined }),
    );

    const { host } = mount();
    await flush();

    const separator = host.querySelector<HTMLElement>('[role="separator"]');
    expect(separator).not.toBeNull();
    if (!separator) return;

    expect(separator.tabIndex).toBe(0);
    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.getAttribute('aria-label')).toMatch(/inspetor/i);

    const controlledId = separator.getAttribute('aria-controls');
    const controlledRegion = controlledId
      ? document.getElementById(controlledId)
      : null;
    const inspector = host.querySelector('[aria-label="Inspetor da missão"]');
    expect(controlledId).toBeTruthy();
    expect(controlledRegion).not.toBeNull();
    expect(
      controlledRegion !== null &&
        inspector !== null &&
        host.contains(controlledRegion) &&
        (controlledRegion === inspector || controlledRegion.contains(inspector)),
    ).toBe(true);

    separator.focus();
    expect(document.activeElement).toBe(separator);

    const minimum = Number(separator.getAttribute('aria-valuemin'));
    const maximum = Number(separator.getAttribute('aria-valuemax'));
    const initial = Number(separator.getAttribute('aria-valuenow'));
    expect(minimum).toBe(320);
    expect(maximum).toBe(600);
    expect(initial).toBe(480);

    keyDown(separator, 'ArrowLeft');
    const afterLeft = Number(separator.getAttribute('aria-valuenow'));
    expect(afterLeft).toBeGreaterThan(initial);
    expect(afterLeft).toBeLessThanOrEqual(maximum);

    keyDown(separator, 'ArrowRight');
    const afterRight = Number(separator.getAttribute('aria-valuenow'));
    expect(afterRight).toBeLessThan(afterLeft);
    expect(afterRight).toBeGreaterThanOrEqual(minimum);

    keyDown(separator, 'Home');
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(minimum);

    keyDown(separator, 'End');
    expect(Number(separator.getAttribute('aria-valuenow'))).toBe(maximum);
  });

  it('refreshes only when onChanged includes the mounted mission id', async () => {
    const initial = canonicalSnapshot({
      title: 'Versão inicial',
      stateReason: undefined,
    });
    const refreshed = canonicalSnapshot({
      title: 'Versão atualizada',
      state: 'running',
      stateReason: undefined,
      progress: { completed: 3, total: 5 },
      version: 8,
      updatedAt: 1_786_080_000_200,
    });
    api.snapshot
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);

    const { host } = mount();
    await flush();

    emitChanged([
      canonicalSummary({
        id: 'mission-other',
        title: 'Outra missão',
      }),
    ]);
    await flush();
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    expect(normalizedText(heading(host))).toContain('Versão inicial');

    emitChanged([canonicalSummary()]);
    await flush();
    expect(api.snapshot).toHaveBeenCalledTimes(2);
    expect(api.snapshot).toHaveBeenLastCalledWith('mission-alpha');
    expect(normalizedText(heading(host))).toContain('Versão atualizada');
  });

  it('keeps the mounted board during matching background refreshes without a generic update row and announces lifecycle progress atomically', async () => {
    const refreshRequest = deferred<MissionSnapshot>();
    api.snapshot
      .mockResolvedValueOnce(
        canonicalSnapshot({
          state: 'running',
          stateReason: undefined,
          progress: { completed: 2, total: 5 },
        }),
      )
      .mockReturnValueOnce(refreshRequest.promise);

    const { host } = mount();
    await flush();

    const mountedBoard = host.querySelector<HTMLElement>('article.mission-board');
    const initialStatus = Array.from(
      host.querySelectorAll<HTMLElement>('[role="status"]'),
    ).find((candidate) => candidate.querySelector('progress') !== null);
    expect(mountedBoard).not.toBeNull();
    expect(initialStatus).toBeDefined();
    expect(initialStatus?.getAttribute('aria-live')).toBe('polite');
    expect(initialStatus?.getAttribute('aria-atomic')).toBe('true');
    expect(normalizedText(initialStatus!)).toContain('Trabalhando');
    expect(normalizedText(initialStatus!)).toMatch(/2\s*\/\s*5/u);

    emitChanged([
      canonicalSummary({
        state: 'recovering',
        progress: { completed: 3, total: 5 },
        updatedAt: 1_786_080_000_250,
      }),
    ]);
    await flush();

    expect(api.snapshot).toHaveBeenCalledTimes(2);
    expect(host.querySelector('article.mission-board')).toBe(mountedBoard);
    expect(host.textContent).not.toContain('Atualizando missão…');

    await act(async () => {
      refreshRequest.resolve(
        canonicalSnapshot({
          state: 'recovering',
          stateReason: undefined,
          progress: { completed: 3, total: 5 },
          version: 8,
          updatedAt: 1_786_080_000_250,
        }),
      );
      await refreshRequest.promise;
      await Promise.resolve();
    });

    const refreshedStatus = Array.from(
      host.querySelectorAll<HTMLElement>('[role="status"]'),
    ).find((candidate) => candidate.querySelector('progress') !== null);
    expect(host.querySelector('article.mission-board')).toBe(mountedBoard);
    expect(refreshedStatus).toBeDefined();
    expect(refreshedStatus?.getAttribute('aria-live')).toBe('polite');
    expect(refreshedStatus?.getAttribute('aria-atomic')).toBe('true');
    expect(normalizedText(refreshedStatus!)).toContain('Recuperando');
    expect(normalizedText(refreshedStatus!)).toMatch(/3\s*\/\s*5/u);
    expect(host.textContent).not.toContain('Atualizando missão…');
  });

  it('unsubscribes on mission switch and ignores stale snapshot and journal responses', async () => {
    const alphaSnapshot = deferred<MissionSnapshot>();
    const betaSnapshot = deferred<MissionSnapshot>();
    const alphaEvents = deferred<{
      events: unknown[];
      enabled?: boolean;
      error?: string;
    }>();
    const betaEvents = deferred<{
      events: unknown[];
      enabled?: boolean;
      error?: string;
    }>();

    api.snapshot.mockImplementation((missionId) =>
      missionId === 'mission-alpha'
        ? alphaSnapshot.promise
        : betaSnapshot.promise,
    );
    api.missionEventsRecent.mockImplementation(({ missionId }) =>
      missionId === 'mission-alpha' ? alphaEvents.promise : betaEvents.promise,
    );

    const terminals = vi.fn<(missionId: string) => void>();
    const { host, root } = mount('mission-alpha', terminals);
    rerender(root, 'mission-beta', terminals);

    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[0]?.unsubscribe).toHaveBeenCalledTimes(1);
    expect(api.snapshot.mock.calls.map(([missionId]) => missionId)).toEqual([
      'mission-alpha',
      'mission-beta',
    ]);

    betaSnapshot.resolve(
      canonicalSnapshot({
        id: 'mission-beta',
        title: 'Missão beta atual',
        stateReason: undefined,
      }),
    );
    betaEvents.resolve({
      events: [canonicalEvent('mission-beta', 'evidência beta atual')],
    });
    await flush();

    expect(normalizedText(heading(host))).toContain('Missão beta atual');
    expect(
      host.querySelector('[data-testid="journal-events"]')?.textContent,
    ).toContain('evidência beta atual');

    alphaSnapshot.resolve(
      canonicalSnapshot({ title: 'Missão alpha obsoleta' }),
    );
    alphaEvents.resolve({
      events: [canonicalEvent('mission-alpha', 'evidência alpha obsoleta')],
    });
    await flush();

    expect(normalizedText(heading(host))).toContain('Missão beta atual');
    expect(host.textContent).not.toContain('Missão alpha obsoleta');
    expect(
      host.querySelector('[data-testid="journal-events"]')?.textContent,
    ).not.toContain('evidência alpha obsoleta');
  });

  it('keeps loading and load failures inline and allows a failed load to recover', async () => {
    const pending = deferred<MissionSnapshot>();
    api.snapshot
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(
        canonicalSnapshot({
          title: 'Missão recuperada',
          stateReason: undefined,
        }),
      );

    const { host } = mount();
    const loading = host.querySelector('[role="status"]');
    expect(loading).not.toBeNull();
    expect(loading!.textContent).toMatch(/carregando/i);

    pending.reject(new Error('snapshot indisponível'));
    await flush();

    const alert = host.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(normalizedText(alert!)).toMatch(/missão|snapshot/i);

    await click(buttonByName(host, 'Tentar novamente'));
    expect(api.snapshot).toHaveBeenCalledTimes(2);
    expect(api.snapshot).toHaveBeenLastCalledWith('mission-alpha');
    expect(normalizedText(heading(host))).toContain('Missão recuperada');
  });

  it('replaces raw snapshot diagnostics with bounded PT-BR recovery copy', async () => {
    const rawSnapshotError =
      'Error invoking remote method mission:snapshot: spawn git ENOENT at /Users/operator/work/nexus command "git status --porcelain"';
    api.snapshot
      .mockRejectedValueOnce(new Error(rawSnapshotError))
      .mockResolvedValueOnce(
        canonicalSnapshot({
          title: 'Missão recuperada sem diagnóstico bruto',
          state: 'running',
          stateReason: undefined,
        }),
      );

    const { host } = mount();
    await flush();

    const alert = host.querySelector<HTMLElement>('[role="alert"]');
    const recoveryCopy = alert?.querySelector('p');
    expect(alert).not.toBeNull();
    expect(recoveryCopy).not.toBeNull();
    expect(normalizedText(recoveryCopy!)).toBe(
      'Não foi possível carregar o estado atual da missão. Tente novamente.',
    );
    expect(host.textContent).not.toContain('spawn git ENOENT');
    expect(host.textContent).not.toContain('/Users/operator/work/nexus');
    expect(host.textContent).not.toContain('git status --porcelain');

    await click(buttonByName(host, 'Tentar novamente'));
    expect(normalizedText(heading(host))).toContain(
      'Missão recuperada sem diagnóstico bruto',
    );
  });

  it('replaces raw command diagnostics with bounded PT-BR recovery copy', async () => {
    const rawCommandError =
      'Command failed: /bin/sh -c "pnpm run worker" at /Users/operator/work/nexus/scripts/start-mission.sh (ENOENT)';
    api.snapshot.mockResolvedValue(
      canonicalSnapshot({
        state: 'recovering',
        stateReason: undefined,
        allowedActions: ['resume', 'stop'],
      }),
    );
    api.command.mockRejectedValueOnce(new Error(rawCommandError));

    const { host } = mount();
    await flush();
    await click(buttonByName(host, 'Retomar'));
    await flush();

    const alert = host.querySelector<HTMLElement>('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(normalizedText(alert!)).toBe(
      'Não foi possível executar esta ação. Tente novamente.',
    );
    expect(host.textContent).not.toContain('Command failed');
    expect(host.textContent).not.toContain('/Users/operator/work/nexus');
    expect(host.textContent).not.toContain('pnpm run worker');
    expect(host.textContent).not.toContain('ENOENT');
  });

  it.each([
    ['retry-kickoff', 'Tentar início novamente'],
    ['resume', 'Retomar'],
    ['stop', 'Parar'],
  ] as const)(
    'shows only the allowed %s action and replaces state with its returned snapshot',
    async (kind, label) => {
      const initial = canonicalSnapshot({
        allowedActions: [kind],
        stateReason: undefined,
      });
      const returned = canonicalSnapshot({
        title: `Snapshot devolvido por ${kind}`,
        state: 'running',
        stateReason: undefined,
        progress: { completed: 4, total: 5 },
        allowedActions: [],
        version: 8,
        updatedAt: 1_786_080_000_300,
      });
      api.snapshot.mockResolvedValue(initial);
      api.command.mockResolvedValue(returned);

      const { host } = mount();
      await flush();

      const header = host.querySelector('header');
      expect(header).not.toBeNull();
      expect(actionButtonNames(header!)).toEqual([label]);

      await click(buttonByName(header!, label));

      expect(api.command).toHaveBeenCalledTimes(1);
      expect(api.command).toHaveBeenCalledWith({
        kind,
        missionId: 'mission-alpha',
      });
      expect(api.snapshot).toHaveBeenCalledTimes(1);
      expect(normalizedText(heading(host))).toContain(
        `Snapshot devolvido por ${kind}`,
      );
      expect(actionButtonNames(host.querySelector('header')!)).toEqual([]);
    },
  );

  it.each([
    ['retry-kickoff', 'Tentar início novamente'],
    ['resume', 'Retomar'],
  ] as const)(
    'keeps %s as the sole primary recovery action and styles Parar as a destructive secondary action',
    async (kind, label) => {
      api.snapshot.mockResolvedValue(
        canonicalSnapshot({
          state: 'recovering',
          stateReason: undefined,
          allowedActions: [kind, 'stop'],
        }),
      );

      const { host } = mount();
      await flush();

      const header = host.querySelector('header');
      expect(header).not.toBeNull();
      const recovery = buttonByName(header!, label);
      const stop = buttonByName(header!, 'Parar');
      const solidPrimaryActions = Array.from(
        header!.querySelectorAll<HTMLButtonElement>(
          '.mission-board__actions .mission-board__button',
        ),
      ).filter(
        (button) =>
          !button.classList.contains('mission-board__button--secondary'),
      );

      expect(solidPrimaryActions.map(normalizedText)).toEqual([label]);
      expect(recovery.classList).not.toContain(
        'mission-board__button--secondary',
      );
      expect(recovery.classList).not.toContain('mission-board__button--danger');
      expect(stop.classList).toContain('mission-board__button--secondary');
      expect(stop.classList).toContain('mission-board__button--danger');
    },
  );

  it('opens Terminais with the exact mounted mission id', async () => {
    // O botão existe em missão viva mesmo sem panes (eles nascem no grid);
    // em terminal/dormindo sem panes ele nem aparece (regra do órfão).
    api.snapshot.mockResolvedValue(canonicalSnapshot({ state: 'running' }));
    const { host, onOpenTerminals } = mount('mission-alpha');
    await flush();

    await click(buttonByName(host, 'Terminais'));

    expect(onOpenTerminals).toHaveBeenCalledTimes(1);
    expect(onOpenTerminals).toHaveBeenCalledWith('mission-alpha');
    expect(api.snapshot).toHaveBeenCalledWith('mission-alpha');
  });

  it('renders the canonical question at the top and in Conversation with one controlled answer state', async () => {
    const question = canonicalQuestion();
    api.snapshot.mockResolvedValue(
      canonicalSnapshot({
        question,
        allowedActions: ['answer-question'],
        stateReason: undefined,
      }),
    );

    const { host } = mount();
    await flush();

    const conversation = host.querySelector(
      '[data-testid="conversation-question"]',
    );
    expect(conversation).not.toBeNull();

    const questions = Array.from(
      host.querySelectorAll<HTMLElement>(
        '[data-testid="mission-question-boundary"]',
      ),
    );
    expect(questions).toHaveLength(2);
    const topQuestion = questions.find(
      (candidate) => !conversation!.contains(candidate),
    );
    const conversationQuestion = conversation!.querySelector<HTMLElement>(
      '[data-testid="mission-question-boundary"]',
    );
    expect(topQuestion).toBeDefined();
    expect(conversationQuestion).not.toBeNull();

    for (const surface of [topQuestion!, conversationQuestion!]) {
      expect(surface.dataset.questionId).toBe('question-path');
      expect(surface.textContent).toContain(
        'Qual caminho de publicação devemos seguir?',
      );
    }

    await click(buttonByName(topQuestion!, 'Escolher caminho seguro'));
    expect(
      Array.from(
        host.querySelectorAll('[data-testid="question-state"]'),
      ).map(normalizedText),
    ).toEqual(['option-safe|', 'option-safe|']);

    const conversationInput = conversationQuestion!.querySelector(
      'input[aria-label="Resposta livre"]',
    ) as HTMLInputElement | null;
    expect(conversationInput).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(conversationInput, 'Contexto adicional integral');
      conversationInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(
      Array.from(
        host.querySelectorAll('[data-testid="question-state"]'),
      ).map(normalizedText),
    ).toEqual([
      '|Contexto adicional integral',
      '|Contexto adicional integral',
    ]);
  });

  it('does not expose an active Responder or dispatch a command without answer-question permission', async () => {
    api.snapshot.mockResolvedValue(
      canonicalSnapshot({
        question: canonicalQuestion(),
        allowedActions: ['stop'],
        state: 'blocked_user',
        stateReason: undefined,
      }),
    );

    const { host } = mount();
    await flush();
    const enabledQuestionControls = Array.from(
      host.querySelectorAll<
        HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
      >(
        '[data-testid="mission-question-boundary"] button, [data-testid="mission-question-boundary"] input, [data-testid="mission-question-boundary"] textarea',
      ),
    ).filter((control) =>
      control instanceof HTMLButtonElement
        ? !control.disabled
        : !control.disabled && !control.readOnly,
    );

    const chooseAnswer = Array.from(host.querySelectorAll('button')).find(
      (candidate) => normalizedText(candidate) === 'Escolher caminho seguro',
    );
    if (chooseAnswer && !chooseAnswer.disabled) {
      await click(chooseAnswer);
    }

    const enabledResponders = Array.from(
      host.querySelectorAll<HTMLButtonElement>('button'),
    ).filter(
      (candidate) =>
        normalizedText(candidate) === 'Responder' && !candidate.disabled,
    );
    for (const responder of enabledResponders) {
      await click(responder);
    }

    expect(api.command).not.toHaveBeenCalled();
    expect(enabledQuestionControls).toHaveLength(0);
    expect(enabledResponders).toHaveLength(0);
  });

  it('replaces the board from a child onCommand result without refetching the snapshot', async () => {
    api.command.mockResolvedValue(
      canonicalSnapshot({
        title: 'Direção aceita pelo processo principal',
        state: 'running',
        stateReason: undefined,
        progress: { completed: 3, total: 5 },
        allowedActions: ['direct', 'stop'],
        version: 8,
        updatedAt: 1_786_080_000_400,
      }),
    );

    const { host } = mount();
    await flush();
    await click(buttonByName(host, 'Enviar direção de teste'));

    expect(api.command).toHaveBeenCalledWith({
      kind: 'direct',
      missionId: 'mission-alpha',
      targetAgentId: null,
      text: 'Direção canônica do inspetor',
    });
    expect(api.snapshot).toHaveBeenCalledTimes(1);
    expect(normalizedText(heading(host))).toContain(
      'Direção aceita pelo processo principal',
    );
  });

  it('renders the newer command snapshot after an overlapping onChanged refresh resolves', async () => {
    const refreshRequest = deferred<MissionSnapshot>();
    const commandRequest = deferred<MissionSnapshot>();
    const initial = canonicalSnapshot({
      title: 'Antes do comando',
      state: 'running',
      stateReason: undefined,
      allowedActions: ['direct', 'stop'],
    });
    const refreshed = canonicalSnapshot({
      title: 'Refresh concorrente',
      state: 'running',
      stateReason: undefined,
      allowedActions: ['direct', 'stop'],
      version: 8,
      updatedAt: 1_786_080_000_500,
    });
    const commanded = canonicalSnapshot({
      title: 'Comando aceito pelo processo principal',
      state: 'running',
      stateReason: undefined,
      allowedActions: ['direct', 'stop'],
      version: 9,
      updatedAt: 1_786_080_000_600,
    });
    api.snapshot
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(refreshRequest.promise);
    api.command.mockReturnValue(commandRequest.promise);

    const { host } = mount();
    await flush();
    await click(buttonByName(host, 'Enviar direção de teste'));

    expect(api.command).toHaveBeenCalledWith({
      kind: 'direct',
      missionId: 'mission-alpha',
      targetAgentId: null,
      text: 'Direção canônica do inspetor',
    });

    emitChanged([
      canonicalSummary({
        state: 'running',
        updatedAt: 1_786_080_000_550,
      }),
    ]);
    expect(api.snapshot).toHaveBeenCalledTimes(2);

    await act(async () => {
      refreshRequest.resolve(refreshed);
      await refreshRequest.promise;
      await Promise.resolve();
    });
    expect(normalizedText(heading(host))).toContain('Refresh concorrente');

    await act(async () => {
      commandRequest.resolve(commanded);
      await commandRequest.promise;
      await Promise.resolve();
    });
    expect(normalizedText(heading(host))).toContain(
      'Comando aceito pelo processo principal',
    );
  });

  it('keeps the canonical board usable when the supplementary journal is unavailable', async () => {
    api.missionEventsRecent.mockRejectedValue(
      new Error('journal temporariamente indisponível'),
    );

    const { host } = mount();
    await flush();

    expect(api.snapshot).toHaveBeenCalledWith('mission-alpha');
    expect(normalizedText(heading(host))).toContain(
      'Publicar o Nexus canônico',
    );
    expect(api.missionEventsAck).not.toHaveBeenCalled();
  });

  it('treats journal reads as supplementary, refreshes after direction and canonical change, and never ACKs', async () => {
    const initial = canonicalSnapshot({
      title: 'Antes da direção',
      state: 'running',
      stateReason: undefined,
      allowedActions: ['direct', 'stop'],
    });
    const directed = canonicalSnapshot({
      title: 'Após a direção',
      state: 'running',
      stateReason: undefined,
      allowedActions: ['direct', 'stop'],
      version: 8,
      updatedAt: 1_786_080_000_500,
    });
    const changed = canonicalSnapshot({
      title: 'Após a mudança canônica',
      state: 'running',
      stateReason: undefined,
      allowedActions: ['direct', 'stop'],
      version: 9,
      updatedAt: 1_786_080_000_600,
    });
    api.snapshot
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed);
    api.command.mockResolvedValue(directed);
    api.missionEventsRecent
      .mockResolvedValueOnce({
        events: [canonicalEvent('mission-alpha', 'direção inicial', 1)],
      })
      .mockResolvedValueOnce({
        events: [canonicalEvent('mission-alpha', 'direção confirmada', 2)],
      })
      .mockResolvedValueOnce({
        events: [canonicalEvent('mission-alpha', 'mudança observada', 3)],
      });

    const { host } = mount();
    await flush();
    expect(api.missionEventsRecent).toHaveBeenCalledTimes(1);
    expect(api.missionEventsRecent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ missionId: 'mission-alpha' }),
    );
    expect(
      host.querySelector('[data-testid="journal-events"]')?.textContent,
    ).toContain('direção inicial');

    await click(buttonByName(host, 'Enviar direção de teste'));
    expect(api.missionEventsRecent).toHaveBeenCalledTimes(2);
    expect(
      host.querySelector('[data-testid="journal-events"]')?.textContent,
    ).toContain('direção confirmada');

    emitChanged([
      canonicalSummary({
        title: 'Após a mudança canônica',
        updatedAt: changed.updatedAt,
      }),
    ]);
    await flush();

    expect(api.snapshot).toHaveBeenCalledTimes(2);
    expect(api.missionEventsRecent).toHaveBeenCalledTimes(3);
    expect(api.missionEventsRecent).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ missionId: 'mission-alpha' }),
    );
    expect(normalizedText(heading(host))).toContain(
      'Após a mudança canônica',
    );
    expect(
      host.querySelector('[data-testid="journal-events"]')?.textContent,
    ).toContain('mudança observada');
    expect(api.missionEventsAck).not.toHaveBeenCalled();
  });
});
