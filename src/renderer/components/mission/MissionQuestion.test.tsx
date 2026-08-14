/** @vitest-environment jsdom */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MissionEngineCommand,
  MissionQuestion as MissionQuestionContract,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import { MissionQuestion } from './MissionQuestion';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const QUESTION: MissionQuestionContract = {
  id: 'question-release-strategy',
  prompt: 'Qual estratégia de publicação deve orientar esta missão?',
  detail:
    'A escolha será aplicada ao pacote completo, incluindo o aplicativo desktop e os artefatos de distribuição.',
  targetAgentId: 'release-coordinator',
  options: [
    {
      id: 'staged-rollout',
      label: 'Publicação gradual para grupos controlados',
      description:
        'Libera primeiro para um grupo pequeno e amplia depois da validação das evidências.',
    },
    {
      id: 'single-release',
      label: 'Publicação única para todos os usuários',
      description:
        'Disponibiliza a mesma versão para todos assim que a missão concluir a verificação.',
    },
  ],
  allowFreeText: true,
};

const OPTIONS_ONLY_QUESTION: MissionQuestionContract = {
  ...QUESTION,
  id: 'question-options-only',
  prompt: 'Escolha uma das estratégias aprovadas.',
  allowFreeText: false,
};

function canonicalSnapshot(
  question: MissionQuestionContract | null = QUESTION,
  version = 1,
): MissionSnapshot {
  return {
    id: 'mission-release-desktop',
    title: 'Publicar Nexus Desktop',
    objective: 'Entregar a versão validada do aplicativo desktop.',
    workspaceLabel: 'nexus-ide',
    state: question ? 'blocked_user' : 'running',
    progress: { completed: 2, total: 4 },
    agents: [],
    edges: [],
    units: [],
    ...(question ? { question } : {}),
    allowedActions: question ? ['answer-question', 'stop'] : ['direct', 'stop'],
    version,
    updatedAt: 1_786_089_600_000 + version,
  };
}

interface QuestionAnswerState {
  readonly optionId: string | null;
  readonly text: string;
  readonly pending: boolean;
  readonly error: string | null;
}

const EMPTY_ANSWER: QuestionAnswerState = {
  optionId: null,
  text: '',
  pending: false,
  error: null,
};

type CommandHandler = (
  command: MissionEngineCommand,
) => Promise<MissionSnapshot>;

function SharedQuestionHarness({
  snapshot,
  onCommand,
  onDismiss,
}: {
  readonly snapshot: MissionSnapshot;
  readonly onCommand: CommandHandler;
  readonly onDismiss?: () => Promise<void>;
}) {
  const [state, setState] = useState<QuestionAnswerState>(EMPTY_ANSWER);
  const question = snapshot.question;

  if (!question) return null;

  const props = {
    missionId: snapshot.id,
    question,
    state,
    onStateChange: setState,
    onCommand,
    ...(onDismiss ? { onDismiss } : {}),
  };

  return (
    <>
      <section aria-label="Pergunta no topo da missão">
        <MissionQuestion {...props} />
      </section>
      <section aria-label="Pergunta na conversa">
        <MissionQuestion {...props} />
      </section>
    </>
  );
}

interface MountedView {
  readonly host: HTMLDivElement;
  readonly root: Root;
}

const mountedRoots = new Set<Root>();

function render(node: ReactNode): MountedView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.add(root);
  act(() => root.render(node));
  return { host, root };
}

function rerender(view: MountedView, node: ReactNode): void {
  act(() => view.root.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function region(host: HTMLElement, label: string): HTMLElement {
  const found = Array.from(host.querySelectorAll<HTMLElement>('section')).find(
    (item) => item.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`Region not found: ${label}`);
  return found;
}

function button(scope: HTMLElement, name: string): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find(
    (item) => item.textContent?.trim().includes(name),
  );
  if (!found) throw new Error(`Button not found: ${name}`);
  return found;
}

function fieldByLabel(
  scope: HTMLElement,
  labelText: string,
): HTMLInputElement | HTMLTextAreaElement {
  const label = Array.from(scope.querySelectorAll('label')).find((item) =>
    item.textContent?.includes(labelText),
  );
  const id = label?.htmlFor;
  const candidate = id ? document.getElementById(id) : null;
  if (
    !candidate ||
    !scope.contains(candidate) ||
    !(
      candidate instanceof HTMLInputElement ||
      candidate instanceof HTMLTextAreaElement
    )
  ) {
    throw new Error(`Field not found: ${labelText}`);
  }
  return candidate;
}

function enterText(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(field),
      'value',
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(control: HTMLButtonElement): void {
  act(() => control.click());
}

function expectOptionSelected(
  scope: HTMLElement,
  optionLabel: string,
  selected: boolean,
): void {
  expect(button(scope, optionLabel).getAttribute('aria-pressed')).toBe(
    String(selected),
  );
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
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

afterEach(() => {
  for (const root of mountedRoots) {
    act(() => root.unmount());
  }
  mountedRoots.clear();
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'nexus');
  vi.restoreAllMocks();
});

describe('MissionQuestion', () => {
  it('renders the complete prompt, detail, option labels and descriptions, with free text only when allowed', () => {
    const onCommand = vi.fn<CommandHandler>();
    const view = render(
      <SharedQuestionHarness
        snapshot={canonicalSnapshot()}
        onCommand={onCommand}
      />,
    );

    for (const text of [
      QUESTION.prompt,
      QUESTION.detail,
      QUESTION.options[0].label,
      QUESTION.options[0].description,
      QUESTION.options[1].label,
      QUESTION.options[1].description,
    ]) {
      expect(view.host.textContent).toContain(text);
    }
    expect(
      view.host.querySelectorAll('button').length,
    ).toBeGreaterThanOrEqual(6);
    expect(
      fieldByLabel(
        region(view.host, 'Pergunta no topo da missão'),
        'Resposta livre',
      ),
    ).toBeInstanceOf(HTMLElement);
    expect(
      Array.from(view.host.querySelectorAll('button')).filter(
        (item) => item.textContent?.trim() === 'Responder',
      ),
    ).toHaveLength(2);

    rerender(
      view,
      <SharedQuestionHarness
        snapshot={canonicalSnapshot(OPTIONS_ONLY_QUESTION)}
        onCommand={onCommand}
      />,
    );

    expect(view.host.textContent).toContain(OPTIONS_ONLY_QUESTION.prompt);
    expect(
      Array.from(view.host.querySelectorAll('label')).some((item) =>
        item.textContent?.includes('Resposta livre'),
      ),
    ).toBe(false);
    expect(view.host.querySelectorAll('textarea, input[type="text"]')).toHaveLength(
      0,
    );
  });

  it('shares one mutually exclusive option or free-text answer between both rendered instances', () => {
    const onCommand = vi.fn<CommandHandler>();
    const { host } = render(
      <SharedQuestionHarness
        snapshot={canonicalSnapshot()}
        onCommand={onCommand}
      />,
    );
    const top = region(host, 'Pergunta no topo da missão');
    const conversation = region(host, 'Pergunta na conversa');
    const topText = fieldByLabel(top, 'Resposta livre');
    const conversationText = fieldByLabel(conversation, 'Resposta livre');

    enterText(topText, 'Manter a liberação restrita aos validadores internos.');
    expect(conversationText.value).toBe(
      'Manter a liberação restrita aos validadores internos.',
    );

    click(button(conversation, QUESTION.options[0].label));
    expect(topText.value).toBe('');
    expect(conversationText.value).toBe('');
    expectOptionSelected(top, QUESTION.options[0].label, true);
    expectOptionSelected(conversation, QUESTION.options[0].label, true);
    expectOptionSelected(top, QUESTION.options[1].label, false);

    enterText(
      topText,
      'Publicar apenas depois da auditoria final de acessibilidade.',
    );
    expect(conversationText.value).toBe(
      'Publicar apenas depois da auditoria final de acessibilidade.',
    );
    expectOptionSelected(top, QUESTION.options[0].label, false);
    expectOptionSelected(conversation, QUESTION.options[0].label, false);
  });

  it('submits exact option and free-text answer commands through the explicit Responder action', async () => {
    const snapshot = canonicalSnapshot();
    const onCommand = vi.fn<CommandHandler>().mockResolvedValue(snapshot);
    const { host } = render(
      <SharedQuestionHarness snapshot={snapshot} onCommand={onCommand} />,
    );
    const top = region(host, 'Pergunta no topo da missão');

    click(button(top, QUESTION.options[1].label));
    click(button(top, 'Responder'));
    await flush();

    expect(onCommand).toHaveBeenNthCalledWith(1, {
      kind: 'answer-question',
      missionId: 'mission-release-desktop',
      questionId: 'question-release-strategy',
      optionId: 'single-release',
    });
    expectOptionSelected(top, QUESTION.options[1].label, true);

    enterText(
      fieldByLabel(top, 'Resposta livre'),
      'Responder com o plano de contingência completo.',
    );
    click(button(top, 'Responder'));
    await flush();

    expect(onCommand).toHaveBeenNthCalledWith(2, {
      kind: 'answer-question',
      missionId: 'mission-release-desktop',
      questionId: 'question-release-strategy',
      text: 'Responder com o plano de contingência completo.',
    });
    expect(onCommand).toHaveBeenCalledTimes(2);
  });

  it('submits one answer when both rendered Responder controls activate before the pending render commits', async () => {
    const request = deferred<MissionSnapshot>();
    const missionCommand = vi
      .fn<Window['nexus']['mission']['command']>()
      .mockReturnValue(request.promise);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: { command: missionCommand },
      } as unknown as Window['nexus'],
    });
    const { host } = render(
      <SharedQuestionHarness
        snapshot={canonicalSnapshot()}
        onCommand={window.nexus.mission.command}
      />,
    );
    const top = region(host, 'Pergunta no topo da missão');
    const conversation = region(host, 'Pergunta na conversa');

    click(button(top, QUESTION.options[0].label));
    const topResponder = button(top, 'Responder');
    const conversationResponder = button(conversation, 'Responder');
    expect(topResponder.disabled).toBe(false);
    expect(conversationResponder.disabled).toBe(false);

    act(() => {
      topResponder.click();
      conversationResponder.click();
    });

    expect(missionCommand).toHaveBeenCalledTimes(1);
    expect(missionCommand).toHaveBeenCalledWith({
      kind: 'answer-question',
      missionId: 'mission-release-desktop',
      questionId: 'question-release-strategy',
      optionId: 'staged-rollout',
    });

    await act(async () => {
      request.resolve(canonicalSnapshot(null, 2));
      await request.promise;
      await Promise.resolve();
    });
    expect(missionCommand).toHaveBeenCalledTimes(1);
  });

  it('shows pending response copy and replaces rejected raw diagnostics with action-specific PT-BR recovery', async () => {
    const request = deferred<MissionSnapshot>();
    const onCommand = vi.fn<CommandHandler>().mockReturnValue(request.promise);
    const { host } = render(
      <SharedQuestionHarness
        snapshot={canonicalSnapshot()}
        onCommand={onCommand}
      />,
    );
    const top = region(host, 'Pergunta no topo da missão');
    const conversation = region(host, 'Pergunta na conversa');
    const answer = 'Aguardar a aprovação formal do responsável pela versão.';
    const rawDiagnostic =
      "Error invoking remote method 'mission:command': IPC response failed at /Users/operator/nexus/src/main/mission-engine.ts:73:11\n    at answerQuestion (/Users/operator/nexus/src/main/ipc.ts:27:5)";

    enterText(fieldByLabel(top, 'Resposta livre'), answer);
    click(button(top, 'Responder'));

    expect(onCommand).toHaveBeenCalledTimes(1);
    const controls = Array.from(
      host.querySelectorAll<
        HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
      >('button, input, textarea'),
    );
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((control) => control.disabled)).toBe(true);
    expect(
      Array.from(
        host.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
        (control) => control.textContent?.trim(),
      ),
    ).toEqual(['Enviando resposta…', 'Enviando resposta…']);
    expect(
      Array.from(host.querySelectorAll<HTMLFormElement>('form')).every(
        (form) => form.getAttribute('aria-busy') === 'true',
      ),
    ).toBe(true);

    click(button(conversation, 'Enviando resposta…'));
    expect(onCommand).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.reject(new Error(rawDiagnostic));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fieldByLabel(top, 'Resposta livre').value).toBe(answer);
    expect(fieldByLabel(conversation, 'Resposta livre').value).toBe(answer);
    const alerts = Array.from(host.querySelectorAll<HTMLElement>('[role="alert"]'));
    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert) => alert.textContent?.trim())).toEqual([
      'Não foi possível enviar a resposta. Tente novamente.',
      'Não foi possível enviar a resposta. Tente novamente.',
    ]);
    expect(host.textContent).not.toMatch(
      /Error invoking|IPC|response failed|\/Users\/|mission-engine\.ts|answerQuestion|ipc\.ts/i,
    );
    expect(
      Array.from(
        host.querySelectorAll<
          HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
        >('button, input, textarea'),
      ).every((control) => !control.disabled),
    ).toBe(true);
  });

  it('keeps the question and chosen answer after success until the parent canonical snapshot removes it', async () => {
    const pending = deferred<MissionSnapshot>();
    const onCommand = vi.fn<CommandHandler>().mockReturnValue(pending.promise);
    const view = render(
      <SharedQuestionHarness
        snapshot={canonicalSnapshot()}
        onCommand={onCommand}
      />,
    );
    const top = region(view.host, 'Pergunta no topo da missão');

    click(button(top, QUESTION.options[0].label));
    click(button(top, 'Responder'));
    await act(async () => {
      pending.resolve(canonicalSnapshot(QUESTION, 2));
      await pending.promise;
      await Promise.resolve();
    });

    expect(view.host.textContent).toContain(QUESTION.prompt);
    expectOptionSelected(
      region(view.host, 'Pergunta no topo da missão'),
      QUESTION.options[0].label,
      true,
    );
    expectOptionSelected(
      region(view.host, 'Pergunta na conversa'),
      QUESTION.options[0].label,
      true,
    );

    rerender(
      view,
      <SharedQuestionHarness
        snapshot={canonicalSnapshot(null, 3)}
        onCommand={onCommand}
      />,
    );

    expect(view.host.textContent).not.toContain(QUESTION.prompt);
    expect(view.host.querySelectorAll('button')).toHaveLength(0);
  });

  it('adia com Agora não sem enviar resposta vazia', async () => {
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    const onCommand = vi.fn<CommandHandler>();
    const { host } = render(
      <SharedQuestionHarness
        snapshot={canonicalSnapshot()}
        onCommand={onCommand}
        onDismiss={onDismiss}
      />,
    );
    const top = region(host, 'Pergunta no topo da missão');
    click(button(top, 'Agora não'));
    await flush();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onCommand).not.toHaveBeenCalled();
  });
});
