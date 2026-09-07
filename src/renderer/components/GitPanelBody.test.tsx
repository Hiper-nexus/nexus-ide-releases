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
    expect(host.textContent).toContain('1 revisão(ões) em rascunho');
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
});
