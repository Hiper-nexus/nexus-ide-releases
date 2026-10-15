/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MissionAgentSnapshot,
  MissionEngineCommand,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import { DirectionComposer } from './DirectionComposer';
import type { QuoteDraft } from '../../lib/quote-reference';
import { tiptapJsonToMarkdown } from '../ComposerTiptapEditor';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const MISSION_ID = 'mission-direction-boundaries';
const AGENTS: MissionAgentSnapshot[] = [
  {
    id: 'interface-executor',
    agentName: 'Implementar interface',
    category: 'executor',
    cli: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
    allowedSkills: [],
    allowedTools: ['Read', 'Edit'],
    state: 'working',
  },
  {
    id: 'result-reviewer',
    agentName: 'Verificar resultado',
    category: 'reviewer',
    cli: 'claude',
    model: 'claude-opus-4-1',
    effort: 'high',
    allowedSkills: [],
    allowedTools: ['Read'],
    state: 'waiting',
  },
];

const RETURNED_SNAPSHOT: MissionSnapshot = {
  id: MISSION_ID,
  title: 'Direcionamento canônico',
  objective: 'Validar o limite observável do comando direct.',
  workspaceLabel: 'nexus (/projects/nexus)',
  state: 'running',
  progress: { completed: 1, total: 3 },
  agents: AGENTS,
  edges: [],
  units: [],
  allowedActions: ['direct', 'stop'],
  version: 2,
  updatedAt: 1_786_060_800_000,
};

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

const mountedRoots = new Set<Root>();
const geometry = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  // F-1170: o rascunho é o editor Tiptap real; o jsdom só não tem geometria.
  for (const [name, value] of [['getClientRects', () => []], ['getBoundingClientRect', () => new DOMRect()]] as const) {
    geometry.set(name, Object.getOwnPropertyDescriptor(Range.prototype, name));
    Object.defineProperty(Range.prototype, name, { configurable: true, value });
  }
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots) root.unmount();
  });
  mountedRoots.clear();
  document.body.innerHTML = '';
  for (const [name, original] of geometry) {
    if (original) Object.defineProperty(Range.prototype, name, original);
    else Reflect.deleteProperty(Range.prototype, name);
  }
  geometry.clear();
});

/** F-1170: o rascunho é a superfície do editor rich-text (role=textbox). */
type DraftSurface = HTMLElement & { editor: Editor };

function mountComposer(
  onCommand: (command: MissionEngineCommand) => Promise<MissionSnapshot>,
  disabled = false,
): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.add(root);

  act(() => {
    root.render(
      <DirectionComposer
        missionId={MISSION_ID}
        agents={AGENTS}
        disabled={disabled}
        onCommand={onCommand}
      />,
    );
  });

  return host;
}

function composerControls(host: HTMLElement): {
  target: HTMLSelectElement;
  draft: DraftSurface;
  submit: HTMLButtonElement;
} {
  const target = host.querySelector<HTMLSelectElement>('select');
  const draft = host.querySelector<DraftSurface>('[role="textbox"]');
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!target || !draft || !submit) {
    throw new Error('DirectionComposer must expose target, draft, and submit controls');
  }
  return { target, draft, submit };
}

/** Digitação do operador: troca o documento inteiro por texto literal, cursor no fim. */
function setDraft(draft: DraftSurface, value: string): void {
  const { editor } = draft;
  act(() => {
    const { schema } = editor.state;
    const paragraphs = value
      .split('\n')
      .map((line) => schema.nodes.paragraph!.create(null, line ? schema.text(line) : null));
    const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, paragraphs);
    editor.view.dispatch(tr.setSelection(Selection.atEnd(tr.doc)));
  });
}

/** Valor do rascunho: o markdown canônico do editor (o que o envio lê). */
function draftValue(draft: DraftSurface): string {
  return tiptapJsonToMarkdown(draft.editor.getJSON());
}

function isDraftDisabled(draft: DraftSurface): boolean {
  return (
    draft.getAttribute('contenteditable') === 'false' &&
    draft.getAttribute('aria-disabled') === 'true' &&
    !draft.editor.isEditable
  );
}

function selectTarget(target: HTMLSelectElement, value: string): void {
  act(() => {
    target.value = value;
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function pressEnter(
  draft: HTMLElement,
  shiftKey = false,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'Enter',
    shiftKey,
  });
  act(() => {
    draft.dispatchEvent(event);
  });
  return event;
}

function successfulCommand() {
  return vi.fn(async (_command: MissionEngineCommand) => RETURNED_SNAPSHOT);
}

describe('DirectionComposer', () => {
  it('maps the default @todos target to null at the exact direct command boundary', async () => {
    const onCommand = successfulCommand();
    const host = mountComposer(onCommand);
    const { target, draft, submit } = composerControls(host);

    expect(target.selectedOptions[0]?.textContent).toContain('@todos');
    setDraft(draft, '  Alinhe todos com a decisão registrada.  ');
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith({
      kind: 'direct',
      missionId: MISSION_ID,
      targetAgentId: null,
      text: 'Alinhe todos com a decisão registrada.',
    });
  });

  it('submits a selected agent by its exact stable id rather than its label or position', async () => {
    const onCommand = successfulCommand();
    const host = mountComposer(onCommand);
    const { target, draft } = composerControls(host);

    expect([...target.options].map((option) => option.value)).toEqual([
      expect.any(String),
      'interface-executor',
      'result-reviewer',
    ]);
    expect(
      [...target.options].find(
        (option) => option.value === 'result-reviewer',
      )?.textContent,
    ).toContain('Verificar resultado');

    selectTarget(target, 'result-reviewer');
    setDraft(draft, 'Revise a evidência final.');
    pressEnter(draft);
    await act(async () => {
      await Promise.resolve();
    });

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith({
      kind: 'direct',
      missionId: MISSION_ID,
      targetAgentId: 'result-reviewer',
      text: 'Revise a evidência final.',
    });
  });

  it('suppresses click and Enter submission for an empty or whitespace-only draft', () => {
    const onCommand = successfulCommand();
    const host = mountComposer(onCommand);
    const { draft, submit } = composerControls(host);

    setDraft(draft, '  \n\t  ');
    act(() => submit.click());
    pressEnter(draft);

    expect(onCommand).not.toHaveBeenCalled();
  });

  it('keeps Shift+Enter as a newline gesture and plain Enter submits once', async () => {
    const onCommand = successfulCommand();
    const host = mountComposer(onCommand);
    const { draft } = composerControls(host);

    setDraft(draft, 'Primeira linha');
    pressEnter(draft, true);

    // F-1170: no editor o ProseMirror insere a quebra ele mesmo (por isso o
    // default do Shift+Enter é dele) — a prova é a linha nova no rascunho.
    expect(draftValue(draft)).toBe('Primeira linha\n');
    expect(onCommand).not.toHaveBeenCalled();

    act(() => {
      draft.editor.view.dispatch(draft.editor.state.tr.insertText('Segunda linha'));
    });
    expect(draftValue(draft)).toBe('Primeira linha\nSegunda linha');
    const enter = pressEnter(draft);
    await act(async () => {
      await Promise.resolve();
    });

    expect(enter.defaultPrevented).toBe(true);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith({
      kind: 'direct',
      missionId: MISSION_ID,
      targetAgentId: null,
      text: 'Primeira linha\nSegunda linha',
    });
  });

  it('ignores Enter while an IME composition is active and sends once after it commits', async () => {
    const onCommand = successfulCommand();
    const host = mountComposer(onCommand);
    const { target, draft } = composerControls(host);
    const appKeydown = vi.fn();
    document.addEventListener('keydown', appKeydown);

    selectTarget(target, 'interface-executor');
    setDraft(draft, 'Revise a função de ação');
    const composing = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      isComposing: true,
    });
    // WebKit/Electron antigos sinalizam a composição só pelo keyCode 229.
    const legacyComposing = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
    });
    Object.defineProperty(legacyComposing, 'keyCode', { value: 229 });
    act(() => {
      draft.dispatchEvent(composing);
      draft.dispatchEvent(legacyComposing);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onCommand).not.toHaveBeenCalled();
    // O IME precisa do default para confirmar o texto; atalhos da app não veem a tecla.
    expect(composing.defaultPrevented).toBe(false);
    expect(legacyComposing.defaultPrevented).toBe(false);
    expect(appKeydown).not.toHaveBeenCalled();

    const enter = pressEnter(draft);
    await act(async () => {
      await Promise.resolve();
    });
    document.removeEventListener('keydown', appKeydown);

    expect(enter.defaultPrevented).toBe(true);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith({
      kind: 'direct',
      missionId: MISSION_ID,
      targetAgentId: 'interface-executor',
      text: 'Revise a função de ação',
    });
  });

  it('allows only one submission while pending, disables every control, and clears only after success', async () => {
    const pending = deferred<MissionSnapshot>();
    const onCommand = vi.fn(
      async (_command: MissionEngineCommand) => pending.promise,
    );
    const host = mountComposer(onCommand);
    const { target, draft, submit } = composerControls(host);

    selectTarget(target, 'interface-executor');
    setDraft(draft, 'Mantenha este rascunho até a confirmação.');
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(target.disabled).toBe(true);
    expect(isDraftDisabled(draft)).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(draftValue(draft)).toBe('Mantenha este rascunho até a confirmação.');

    act(() => {
      submit.click();
      draft.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
        }),
      );
    });
    expect(onCommand).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(RETURNED_SNAPSHOT);
      await pending.promise;
    });

    expect(draftValue(draft)).toBe('');
    expect(target.disabled).toBe(false);
    expect(isDraftDisabled(draft)).toBe(false);
    expect(draft.editor.isEditable).toBe(true);
    expect(submit.disabled).toBe(true);
  });

  it('replaces rejected raw diagnostics with action-specific PT-BR recovery while retaining the draft and target', async () => {
    const rawDiagnostic =
      "Error invoking remote method 'mission:command': IPC request failed at /Users/operator/nexus/src/main/mission-engine.ts:42:7\n    at dispatchCommand (/Users/operator/nexus/src/main/ipc.ts:18:3)";
    const onCommand = vi.fn(async (_command: MissionEngineCommand) => {
      throw new Error(rawDiagnostic);
    });
    const host = mountComposer(onCommand);
    const { target, draft, submit } = composerControls(host);
    const longDraft = `Contexto completo:\n${'evidência detalhada sem truncamento; '.repeat(300)}\nFim.`;

    selectTarget(target, 'result-reviewer');
    setDraft(draft, longDraft);
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });

    const alert = host.querySelector<HTMLElement>('[role="alert"]');
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(draftValue(draft)).toBe(longDraft);
    expect(target.value).toBe('result-reviewer');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toBe(
      'Não foi possível enviar a orientação. Tente novamente.',
    );
    expect(alert?.textContent).not.toMatch(
      /Error invoking|IPC|request failed|\/Users\/|mission-engine\.ts|dispatchCommand|ipc\.ts/i,
    );
    expect(alert && host.contains(alert)).toBe(true);
  });

  it('shows the mapped PT-BR copy for a rejected mission-direct target', async () => {
    const onCommand = vi.fn(async (_command: MissionEngineCommand) => {
      throw new Error('mission direct target is not an agent of this mission');
    });
    const host = mountComposer(onCommand);
    const { draft, submit } = composerControls(host);

    setDraft(draft, 'Refaça a revisão.');
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });

    const alert = host.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toBe(
      'O agente escolhido não faz parte desta missão. Envie para @todos.',
    );
    expect(alert?.textContent).not.toMatch(/mission direct|not an agent/i);
  });

  it('is hidden or fully disabled when direct is unavailable and never reports a delivery', () => {
    const onCommand = successfulCommand();
    const host = mountComposer(onCommand, true);
    const target = host.querySelector<HTMLSelectElement>('select');
    const draft = host.querySelector<DraftSurface>('[role="textbox"]');
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
    const hidden = !target && !draft && !submit;

    if (hidden) {
      expect(host.querySelector('form')).toBeNull();
    } else {
      expect(target).not.toBeNull();
      expect(draft).not.toBeNull();
      expect(submit).not.toBeNull();
      expect(target?.disabled).toBe(true);
      expect(draft && isDraftDisabled(draft)).toBe(true);
      expect(submit?.disabled).toBe(true);

      act(() => {
        submit?.click();
        draft?.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Enter',
          }),
        );
      });
    }

    expect(onCommand).not.toHaveBeenCalled();
  });
});

describe('DirectionComposer — editor rich-text (F-1170)', () => {
  it('o rascunho é nomeado pelo rótulo visível, descrito pela dica e marca aria-invalid no erro', async () => {
    const onCommand = vi.fn(async (_command: MissionEngineCommand) => {
      throw new Error('falha');
    });
    const host = mountComposer(onCommand);
    const { draft, submit } = composerControls(host);
    const labelId = draft.getAttribute('aria-labelledby');
    expect(labelId && document.getElementById(labelId)?.textContent).toBe('Orientação');
    const hintId = draft.getAttribute('aria-describedby')!;
    expect(document.getElementById(hintId)?.textContent).toContain('Enter envia');
    expect(draft.getAttribute('aria-invalid')).toBe('false');
    expect(draft.getAttribute('aria-placeholder')).toBe('Escreva uma orientação para a equipe');

    setDraft(draft, 'Refaça');
    await act(async () => {
      submit.click();
      await Promise.resolve();
    });
    const alert = host.querySelector<HTMLElement>('[role="alert"]')!;
    expect(draft.getAttribute('aria-invalid')).toBe('true');
    expect(draft.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
  });

  it('envia o texto como foi escrito, sem escapes, e a formatação sai como markdown', async () => {
    const onCommand = successfulCommand();
    const host = mountComposer(onCommand);
    const { draft } = composerControls(host);
    setDraft(draft, 'Renomeie my_file.ts; 2*3 = 6 ');
    act(() => {
      draft.editor.view.dispatch(draft.editor.state.tr.insertText('agora'));
    });
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
    act(() => {
      const end = draft.editor.state.doc.content.size - 1;
      draft.editor.commands.setTextSelection({ from: end - 5, to: end });
      draft.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'b', keyCode: 66, ...mod }),
      );
    });
    pressEnter(draft);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onCommand).toHaveBeenCalledWith({
      kind: 'direct',
      missionId: MISSION_ID,
      targetAgentId: null,
      text: 'Renomeie my_file.ts; 2*3 = 6 **agora**',
    });
  });
});

describe('DirectionComposer — foco depois do envio (D4)', () => {
  // Durante o envio o editor vira contenteditable=false sem tabindex e o Chromium joga o foco
  // no body (focus fixup). O jsdom não faz isso: os testes reproduzem o navegador com blur().
  function browserDropsFocus(draft: DraftSurface): void {
    expect(isDraftDisabled(draft)).toBe(true);
    act(() => draft.blur());
    expect(document.activeElement).toBe(document.body);
  }

  async function settle(request: Deferred<MissionSnapshot>, outcome: 'ok' | 'fail'): Promise<void> {
    await act(async () => {
      if (outcome === 'ok') request.resolve(RETURNED_SNAPSHOT);
      else request.reject(new Error('falha'));
      await request.promise.catch(() => undefined);
      await Promise.resolve();
    });
  }

  it.each(['ok', 'fail'] as const)(
    'devolve o foco ao editor quando o envio por Enter termina (%s)',
    async (outcome) => {
      const request = deferred<MissionSnapshot>();
      const host = mountComposer(vi.fn(async () => request.promise));
      const { draft } = composerControls(host);
      setDraft(draft, 'Revise a evidência final.');
      act(() => draft.focus());
      expect(document.activeElement).toBe(draft);

      pressEnter(draft);
      await act(async () => {
        await Promise.resolve();
      });
      browserDropsFocus(draft);
      await settle(request, outcome);

      expect(isDraftDisabled(draft)).toBe(false);
      expect(document.activeElement).toBe(draft);
    },
  );

  it('quem envia pelo botão (foco dentro do compositor) também volta a digitar no editor', async () => {
    const request = deferred<MissionSnapshot>();
    const host = mountComposer(vi.fn(async () => request.promise));
    const { draft, submit } = composerControls(host);
    setDraft(draft, 'Mais uma orientação.');
    act(() => submit.focus());
    expect(document.activeElement).toBe(submit);

    await act(async () => {
      submit.click();
      await Promise.resolve();
    });
    // O botão também fica disabled durante o envio (e, vazio o rascunho, depois dele):
    // o foco que estava nele não serve a quem digita.
    expect(submit.disabled).toBe(true);
    await settle(request, 'ok');

    expect(document.activeElement).toBe(draft);
  });

  it('não rouba o foco de quem foi para outro campo durante o envio', async () => {
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    const request = deferred<MissionSnapshot>();
    const host = mountComposer(vi.fn(async () => request.promise));
    const { draft } = composerControls(host);
    setDraft(draft, 'Orientação em andamento.');
    act(() => draft.focus());

    pressEnter(draft);
    await act(async () => {
      await Promise.resolve();
    });
    browserDropsFocus(draft);
    act(() => outside.focus());
    await settle(request, 'ok');

    expect(document.activeElement).toBe(outside);
  });

  it('não puxa o foco nem ao montar nem quando o envio não nasceu no compositor', async () => {
    const request = deferred<MissionSnapshot>();
    const host = mountComposer(vi.fn(async () => request.promise));
    const { draft, submit } = composerControls(host);
    // Montar a tela não leva o foco ao editor.
    expect(document.activeElement).toBe(document.body);

    setDraft(draft, 'Enviada sem o foco no compositor.');
    await act(async () => {
      submit.click(); // click() programático não move o foco: ele segue no body
      await Promise.resolve();
    });
    await settle(request, 'ok');

    expect(document.activeElement).toBe(document.body);
  });
});

describe('DirectionComposer — citação da atividade (WEB-17)', () => {
  const QUOTE: QuoteDraft = {
    origin: {
      missionId: MISSION_ID,
      eventId: 'evt-3',
      sequence: 3,
      paneId: 'pane-7',
      agentName: 'Implementar interface',
    },
    text: '> Implementar interface · evento #3 · Shell\n> 18 tests passed\n[origem: missao=mission-direction-boundaries evento=evt-3 seq=3 pane=pane-7]',
    nonce: 1,
  };

  function mountWithQuote(
    onCommand: (command: MissionEngineCommand) => Promise<MissionSnapshot>,
    quote: QuoteDraft | null,
    onQuoteConsumed = vi.fn(),
  ) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    mountedRoots.add(root);
    const renderWith = (next: QuoteDraft | null) =>
      act(() => {
        root.render(
          <DirectionComposer
            missionId={MISSION_ID}
            agents={AGENTS}
            onCommand={onCommand}
            quote={next}
            onQuoteConsumed={onQuoteConsumed}
          />,
        );
      });
    renderWith(quote);
    return { host, renderWith, onQuoteConsumed };
  }

  it('entra no rascunho uma vez, com foco no fim e aviso da origem', () => {
    const { host, renderWith, onQuoteConsumed } = mountWithQuote(vi.fn(), QUOTE);
    const { draft } = composerControls(host);

    expect(draftValue(draft)).toBe(`${QUOTE.text}\n\n`);
    expect(document.activeElement).toBe(draft);
    // Cursor no fim: seleção vazia no último ponto do documento.
    expect(draft.editor.state.selection.empty).toBe(true);
    expect(draft.editor.state.selection.from).toBe(Selection.atEnd(draft.editor.state.doc).from);
    expect(onQuoteConsumed).toHaveBeenCalledWith(1);
    const notice = host.querySelector('[role="status"]')!;
    expect(notice.textContent).toContain('Citação de Implementar interface (evento #3) adicionada');
    expect(draft.getAttribute('aria-describedby')).toContain(notice.id);
    expect(host.querySelector('form')?.hasAttribute('data-multiline')).toBe(true);

    // Re-render com a mesma citação (o pai ainda não limpou) não duplica.
    renderWith(QUOTE);
    expect(draftValue(draft)).toBe(`${QUOTE.text}\n\n`);
  });

  it('preserva o que já foi escrito e envia o texto com a marca de origem', async () => {
    const onCommand = vi.fn(async () => RETURNED_SNAPSHOT);
    const { host, renderWith } = mountWithQuote(onCommand, null);
    const { draft, submit } = composerControls(host);
    setDraft(draft, 'Corrija o teste abaixo');

    renderWith(QUOTE);
    expect(draftValue(draft)).toBe(`Corrija o teste abaixo\n\n${QUOTE.text}\n\n`);

    await act(async () => {
      submit.click();
    });
    expect(onCommand).toHaveBeenCalledWith({
      kind: 'direct',
      missionId: MISSION_ID,
      targetAgentId: null,
      text: `Corrija o teste abaixo\n\n${QUOTE.text}`,
    });
    expect(draftValue(draft)).toBe('');
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('citação de outra missão não entra', () => {
    const other: QuoteDraft = { ...QUOTE, origin: { ...QUOTE.origin, missionId: 'outra' } };
    const { host, onQuoteConsumed } = mountWithQuote(vi.fn(), other);
    expect(draftValue(composerControls(host).draft)).toBe('');
    expect(onQuoteConsumed).not.toHaveBeenCalled();
  });

  it('durante um envio a citação espera; entra quando o envio termina', async () => {
    const delivery = deferred<MissionSnapshot>();
    const onCommand = vi.fn(() => delivery.promise);
    const { host, renderWith, onQuoteConsumed } = mountWithQuote(onCommand, null);
    const { draft, submit } = composerControls(host);
    setDraft(draft, 'primeira');
    act(() => submit.click());

    renderWith(QUOTE);
    expect(onQuoteConsumed).not.toHaveBeenCalled();

    await act(async () => {
      delivery.resolve(RETURNED_SNAPSHOT);
      await delivery.promise;
    });
    expect(onQuoteConsumed).toHaveBeenCalledWith(1);
    expect(draftValue(draft)).toBe(`${QUOTE.text}\n\n`);
  });
});
