/** @vitest-environment jsdom */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MissionEngineCommand,
  MissionQuestion as MissionQuestionContract,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import { MissionQuestion } from './MissionQuestion';
import { tiptapJsonToMarkdown } from '../ComposerTiptapEditor';

const mermaidApi = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string) => ({ svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}"><text>d</text></svg>` })),
}));
vi.mock('mermaid', () => ({ default: mermaidApi }));

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

/** F-1170: a resposta livre é o editor rich-text (role=textbox, contenteditable). */
type AnswerField = HTMLElement & { editor: Editor };

function fieldByLabel(scope: HTMLElement, labelText: string): AnswerField {
  const label = Array.from(scope.querySelectorAll('label')).find((item) =>
    item.textContent?.includes(labelText),
  );
  const candidate = label?.id
    ? scope.querySelector<AnswerField>(`[role="textbox"][aria-labelledby="${label.id}"]`)
    : null;
  if (!candidate?.editor || candidate.id !== label?.htmlFor) {
    throw new Error(`Field not found: ${labelText}`);
  }
  return candidate;
}

/** Valor do campo: o markdown canônico do editor (o que a resposta envia). */
function fieldValue(field: AnswerField): string {
  return tiptapJsonToMarkdown(field.editor.getJSON());
}

/** Digitação do operador: troca o documento inteiro por texto literal, cursor no fim. */
function enterText(field: AnswerField, value: string): void {
  const { editor } = field;
  act(() => {
    const { schema } = editor.state;
    const paragraphs = value
      .split('\n')
      .map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null));
    const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, paragraphs);
    editor.view.dispatch(tr.setSelection(Selection.atEnd(tr.doc)));
  });
}

const CONTROLS = 'button, input, textarea, [role="textbox"]';

function isControlDisabled(control: HTMLElement): boolean {
  if (
    control instanceof HTMLButtonElement ||
    control instanceof HTMLInputElement ||
    control instanceof HTMLTextAreaElement
  ) {
    return control.disabled;
  }
  return (
    control.getAttribute('contenteditable') === 'false' &&
    control.getAttribute('aria-disabled') === 'true'
  );
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

const geometry = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  // F-1170: editor Tiptap real; o jsdom só não tem geometria.
  for (const [name, value] of [['getClientRects', () => []], ['getBoundingClientRect', () => new DOMRect()]] as const) {
    geometry.set(name, Object.getOwnPropertyDescriptor(Range.prototype, name));
    Object.defineProperty(Range.prototype, name, { configurable: true, value });
  }
});

afterEach(() => {
  for (const [name, original] of geometry) {
    if (original) Object.defineProperty(Range.prototype, name, original);
    else Reflect.deleteProperty(Range.prototype, name);
  }
  geometry.clear();
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
    expect(view.host.querySelectorAll('textarea, input[type="text"], [role="textbox"]')).toHaveLength(
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
    expect(fieldValue(conversationText)).toBe(
      'Manter a liberação restrita aos validadores internos.',
    );

    click(button(conversation, QUESTION.options[0].label));
    expect(fieldValue(topText)).toBe('');
    expect(fieldValue(conversationText)).toBe('');
    expectOptionSelected(top, QUESTION.options[0].label, true);
    expectOptionSelected(conversation, QUESTION.options[0].label, true);
    expectOptionSelected(top, QUESTION.options[1].label, false);

    enterText(
      topText,
      'Publicar apenas depois da auditoria final de acessibilidade.',
    );
    expect(fieldValue(conversationText)).toBe(
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
    const controls = Array.from(host.querySelectorAll<HTMLElement>(CONTROLS));
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.filter((control) => control.getAttribute('role') === 'textbox')).toHaveLength(2);
    expect(controls.every(isControlDisabled)).toBe(true);
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

    expect(fieldValue(fieldByLabel(top, 'Resposta livre'))).toBe(answer);
    expect(fieldValue(fieldByLabel(conversation, 'Resposta livre'))).toBe(answer);
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
      Array.from(host.querySelectorAll<HTMLElement>(CONTROLS)).every(
        (control) => !isControlDisabled(control),
      ),
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

describe('MissionQuestion — resposta livre no editor rich-text (F-1170)', () => {
  it('Enter quebra linha como no textarea (não envia) e a resposta sai como markdown, sem escapes', async () => {
    const snapshot = canonicalSnapshot();
    const onCommand = vi.fn<CommandHandler>().mockResolvedValue(snapshot);
    const { host } = render(
      <SharedQuestionHarness snapshot={snapshot} onCommand={onCommand} />,
    );
    const top = region(host, 'Pergunta no topo da missão');
    const field = fieldByLabel(top, 'Resposta livre');
    enterText(field, 'Use o arquivo release_notes.md');
    act(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
      field.editor.view.dispatch(field.editor.state.tr.insertText('e publique'));
    });
    expect(onCommand).not.toHaveBeenCalled();
    expect(fieldValue(field)).toBe('Use o arquivo release_notes.md\ne publique');

    click(button(top, 'Responder'));
    await flush();
    expect(onCommand).toHaveBeenCalledWith({
      kind: 'answer-question',
      missionId: 'mission-release-desktop',
      questionId: 'question-release-strategy',
      text: 'Use o arquivo release_notes.md\ne publique',
    });
  });

  it('erro marca aria-invalid e liga o alerta pela descrição do campo', async () => {
    const onCommand = vi.fn<CommandHandler>().mockRejectedValue(new Error('falha'));
    const { host } = render(
      <SharedQuestionHarness snapshot={canonicalSnapshot()} onCommand={onCommand} />,
    );
    const top = region(host, 'Pergunta no topo da missão');
    const field = fieldByLabel(top, 'Resposta livre');
    expect(field.getAttribute('aria-invalid')).toBe('false');
    enterText(field, 'Resposta');
    click(button(top, 'Responder'));
    await flush();
    const alert = top.querySelector<HTMLElement>('[role="alert"]')!;
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(alert.id);
  });
});

describe('MissionQuestion — detalhe do agente em markdown (F-1169)', () => {
  it('o detalhe sai formatado, com diagrama, descreve o formulário e não executa HTML', async () => {
    const question: MissionQuestionContract = {
      ...QUESTION,
      detail: '**Atenção**: duas opções\n\n- `staged`\n- `single`\n\n```mermaid\ngraph LR; A-->B\n```\n\n<img src=x onerror="window.__pwned = 1">',
    };
    const view = render(
      <SharedQuestionHarness snapshot={canonicalSnapshot(question)} onCommand={vi.fn<CommandHandler>()} />,
    );
    await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const form = region(view.host, 'Pergunta no topo da missão').querySelector('form')!;
    const detail = form.querySelector('.mission-board__question-detail')!;
    expect(detail).not.toBeNull();
    expect(form.getAttribute('aria-describedby')).toContain(detail.id);
    expect(detail.querySelector('strong')?.textContent).toBe('Atenção');
    expect(detail.querySelectorAll('ul li code')).toHaveLength(2);
    expect(detail.querySelector('figure.markdown-with-mermaid__diagram')).not.toBeNull();
    expect(detail.querySelector('img, script')).toBeNull();
    expect(detail.textContent).toContain('<img src=x onerror="window.__pwned = 1">');
  });
});
