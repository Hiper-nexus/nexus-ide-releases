/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitPanelBody } from './GitPanelBody';
import { useGitScmStore } from '../state/git-scm-store';
import * as agentAttach from '../lib/agent-attach';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(node));
  return host;
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('GitPanelBody', () => {
  beforeEach(() => {
    useGitScmStore.setState({
      branch: 'main',
      unstaged: [
        { path: 'src/app.ts', status: 'M' },
      ],
      staged: [],
      diffText: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@\n-const old = 1;\n+const newConst = 2;\n const keep = 3;\n',
      selected: { path: 'src/app.ts', section: 'unstaged' },
      loading: false,
      error: null,
      refresh: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn(),
    });
  });

  function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  }

  it('renders diff lines and allows drafting inline comments', async () => {
    const host = render(<GitPanelBody />);
    expect(host.querySelector('.git-scm__diff')).not.toBeNull();

    // Click on a clickable line to open editor
    const clickableLine = host.querySelector<HTMLDivElement>('.git-scm__diff-line.is-clickable');
    expect(clickableLine).not.toBeNull();

    act(() => clickableLine!.click());

    // Editor should be open
    const textarea = host.querySelector<HTMLTextAreaElement>('.git-scm__diff-comment-input');
    expect(textarea).not.toBeNull();

    // Type a comment
    setTextareaValue(textarea!, 'Refatorar este nome');

    // Click Guardar rascunho
    const draftButton = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Guardar rascunho'),
    );
    expect(draftButton).toBeDefined();
    act(() => draftButton!.click());

    // Review bar should appear with 1 draft
    expect(host.querySelector('.git-scm__diff-review-bar')).not.toBeNull();
    expect(host.textContent).toContain('1 revisão em rascunho');
    expect(host.querySelector('.git-scm__diff-inline-comment')).not.toBeNull();
  });

  it('sends drafted annotations to the agent when clicking Enviar todas', async () => {
    const sendSpy = vi.spyOn(agentAttach, 'sendAnnotationsToAgent').mockResolvedValue(true);
    const host = render(<GitPanelBody />);

    const clickableLine = host.querySelector<HTMLDivElement>('.git-scm__diff-line.is-clickable');
    act(() => clickableLine!.click());

    const textarea = host.querySelector<HTMLTextAreaElement>('.git-scm__diff-comment-input');
    setTextareaValue(textarea!, 'Ajustar tipo aqui');

    const draftButton = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Guardar rascunho'),
    );
    act(() => draftButton!.click());

    const sendAllButton = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Enviar todas ao agente'),
    );
    expect(sendAllButton).toBeDefined();

    await act(async () => {
      sendAllButton!.click();
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith([
      expect.objectContaining({
        path: 'src/app.ts',
        body: expect.stringContaining('Ajustar tipo aqui'),
      }),
    ]);
  });
  const DIFF_APP =
    '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@\n-const old = 1;\n+const newConst = 2;\n const keep = 3;\n';
  const DIFF_OTHER =
    '--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1,2 +1,2 @@\n-let a = 1;\n+let a = 2;\n let b = 3;\n';

  function button(host: HTMLElement, label: string): HTMLButtonElement {
    const found = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(label),
    );
    if (!found) throw new Error(`button ${label} not found`);
    return found;
  }

  function draftFirstLine(host: HTMLElement, text: string) {
    act(() => host.querySelector<HTMLDivElement>('.git-scm__diff-line.is-clickable')!.click());
    setTextareaValue(host.querySelector<HTMLTextAreaElement>('.git-scm__diff-comment-input')!, text);
    act(() => button(host, 'Guardar rascunho').click());
  }

  function select(path: string, diffText: string) {
    act(() => useGitScmStore.setState({ selected: { path, section: 'unstaged' }, diffText }));
  }

  it('keeps a draft with its own file: another file hides it and sending uses its path', async () => {
    const sendSpy = vi.spyOn(agentAttach, 'sendAnnotationsToAgent').mockResolvedValue(true);
    useGitScmStore.setState({
      unstaged: [
        { path: 'src/app.ts', status: 'M' },
        { path: 'src/other.ts', status: 'M' },
      ],
    });
    const host = render(<GitPanelBody />);
    draftFirstLine(host, 'Refatorar A');

    select('src/other.ts', DIFF_OTHER);
    expect(host.querySelector('.git-scm__diff-inline-comment')).toBeNull();
    expect(host.textContent).toContain('1 revisão em rascunho');

    await act(async () => {
      button(host, 'Enviar todas ao agente').click();
    });
    expect(sendSpy).toHaveBeenCalledWith([
      { path: 'src/app.ts', line: 1, body: 'Refatorar A\n\n> const old = 1;' },
    ]);
  });

  it('survives a cleared selection and "Enviar agora" sends only its own comment', async () => {
    const sendSpy = vi.spyOn(agentAttach, 'sendAnnotationsToAgent').mockResolvedValue(true);
    useGitScmStore.setState({
      unstaged: [
        { path: 'src/app.ts', status: 'M' },
        { path: 'src/other.ts', status: 'M' },
      ],
    });
    const host = render(<GitPanelBody />);
    draftFirstLine(host, 'Refatorar A');

    // A refresh can drop the selection (the file moved section); the draft must not go with it.
    act(() => useGitScmStore.setState({ selected: null, diffText: '' }));
    select('src/other.ts', DIFF_OTHER);
    expect(host.textContent).toContain('1 revisão em rascunho');

    act(() => host.querySelector<HTMLDivElement>('.git-scm__diff-line.is-clickable')!.click());
    setTextareaValue(host.querySelector<HTMLTextAreaElement>('.git-scm__diff-comment-input')!, 'Ajustar B');
    await act(async () => {
      button(host, 'Enviar agora').click();
    });
    expect(sendSpy).toHaveBeenLastCalledWith([
      { path: 'src/other.ts', line: 1, body: 'Ajustar B\n\n> let a = 1;' },
    ]);
    expect(host.textContent).toContain('1 revisão em rascunho');

    select('src/app.ts', DIFF_APP);
    expect(host.querySelector('.git-scm__diff-inline-comment')?.textContent).toContain(
      'Linha 1: Refatorar A',
    );
  });
});
