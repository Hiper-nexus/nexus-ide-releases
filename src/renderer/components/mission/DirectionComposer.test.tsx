/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MissionAgentSnapshot,
  MissionEngineCommand,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import { DirectionComposer } from './DirectionComposer';

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

afterEach(() => {
  act(() => {
    for (const root of mountedRoots) root.unmount();
  });
  mountedRoots.clear();
  document.body.innerHTML = '';
});

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
  draft: HTMLTextAreaElement;
  submit: HTMLButtonElement;
} {
  const target = host.querySelector<HTMLSelectElement>('select');
  const draft = host.querySelector<HTMLTextAreaElement>('textarea');
  const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!target || !draft || !submit) {
    throw new Error('DirectionComposer must expose target, draft, and submit controls');
  }
  return { target, draft, submit };
}

function setDraft(draft: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('textarea value setter unavailable');

  act(() => {
    setter.call(draft, value);
    draft.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function selectTarget(target: HTMLSelectElement, value: string): void {
  act(() => {
    target.value = value;
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function pressEnter(
  draft: HTMLTextAreaElement,
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
    const shiftEnter = pressEnter(draft, true);

    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(onCommand).not.toHaveBeenCalled();

    // jsdom does not perform the native textarea insertion after keydown.
    setDraft(draft, 'Primeira linha\nSegunda linha');
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
    expect(draft.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(draft.value).toBe('Mantenha este rascunho até a confirmação.');

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

    expect(draft.value).toBe('');
    expect(target.disabled).toBe(false);
    expect(draft.disabled).toBe(false);
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
    expect(draft.value).toBe(longDraft);
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

  it('is hidden or fully disabled when direct is unavailable and never reports a delivery', () => {
    const onCommand = successfulCommand();
    const host = mountComposer(onCommand, true);
    const target = host.querySelector<HTMLSelectElement>('select');
    const draft = host.querySelector<HTMLTextAreaElement>('textarea');
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]');
    const hidden = !target && !draft && !submit;

    if (hidden) {
      expect(host.querySelector('form')).toBeNull();
    } else {
      expect(target).not.toBeNull();
      expect(draft).not.toBeNull();
      expect(submit).not.toBeNull();
      expect(target?.disabled).toBe(true);
      expect(draft?.disabled).toBe(true);
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
