/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitPanelBody } from './GitPanelBody';
import { useGitScmStore } from '../state/git-scm-store';
import * as agentAttach from '../lib/agent-attach';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * Pierre's CodeView needs real layout (ResizeObserver, Shadow DOM geometry) that jsdom does not
 * have. The fake keeps the contract this panel relies on: it receives items/options, renders
 * each item's annotations through `renderAnnotation`, and counts mounts.
 */
const viewer = vi.hoisted(() => ({
  props: [] as Array<Record<string, any>>,
  mounts: 0,
}));

vi.mock('@pierre/diffs/worker/worker.js?worker', () => ({ default: class FakeWorker {} }));

vi.mock('@pierre/diffs/worker', () => ({
  WorkerPoolManager: class {
    isInitialized() {
      return true;
    }
    isWorkingPool() {
      return true;
    }
    initialize() {
      return Promise.resolve();
    }
    getDiffRenderOptions() {
      return { theme: 'pierre-dark' };
    }
    setRenderOptions() {
      return Promise.resolve();
    }
    terminate() {}
  },
}));

vi.mock('@pierre/diffs/react', async () => {
  const React = await import('react');
  const WorkerPoolContext = React.createContext<unknown>(undefined);
  function CodeView(props: Record<string, any>) {
    React.useEffect(() => {
      viewer.mounts += 1;
    }, []);
    viewer.props.push(props);
    return (
      <div data-testid="pierre-code-view" className={props.className}>
        {props.items.flatMap((item: any) =>
          (item.annotations ?? []).map((annotation: any) => (
            <div
              key={`${item.id}:${annotation.side}:${annotation.lineNumber}`}
              data-annotation={`${annotation.side}:${annotation.lineNumber}`}
            >
              {props.renderAnnotation(annotation, item) as ReactNode}
            </div>
          )),
        )}
      </div>
    );
  }
  return {
    CodeView,
    WorkerPoolContext,
    useWorkerPool: () => React.useContext(WorkerPoolContext),
  };
});

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  '-const old = 1;',
  '+const newConst = 2;',
  ' const keep = 3;',
  ' const tail = 4;',
  '',
].join('\n');

const mountedRoots: Root[] = [];

/**
 * Mounts the panel. With `viewer`, waits for the observable condition — the lazy viewer
 * committed — instead of a fixed number of ticks: a fixed budget raced the first import of the
 * viewer chunk and lost under a loaded full-suite run.
 */
async function render({ viewer: expectViewer = true } = {}): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(<GitPanelBody />));
  if (expectViewer) {
    await vi.waitFor(
      async () => {
        await act(async () => {});
        if (viewer.props.length === 0) throw new Error('highlighted viewer not mounted yet');
      },
      { timeout: 10_000, interval: 5 },
    );
  }
  return host;
}

function lastProps(): Record<string, any> {
  const props = viewer.props.at(-1);
  if (!props) throw new Error('highlighted viewer did not render');
  return props;
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(label),
  );
  if (!button) throw new Error(`button ${label} not found`);
  return button;
}

function clickButton(host: HTMLElement, label: string) {
  const button = findButton(host, label);
  act(() => button.click());
}

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function beginComment(range: Record<string, unknown>) {
  const props = lastProps();
  act(() => props.options.onGutterUtilityClick(range, { item: props.items[0] }));
}

beforeAll(async () => {
  // The viewer is a React.lazy chunk (Pierre + Shiki + the worker provider). Loading its module
  // graph once here keeps transform time out of every test; React.lazy then resolves from the
  // module cache in microtasks.
  await import('./diffs/AnnotatableCodeView');
}, 120_000);

beforeEach(() => {
  viewer.props.length = 0;
  viewer.mounts = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useGitScmStore.setState({
    branch: 'main',
    clean: false,
    unstaged: [{ path: 'src/app.ts', status: 'M' }],
    staged: [{ path: 'src/lib/x.ts', status: 'M' }],
    untracked: [],
    diffText: PATCH,
    selected: { path: 'src/app.ts', section: 'unstaged' },
    loading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  });
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GitPanelBody highlighted diff', () => {
  it('renders the patch through the Pierre viewer without fetching files itself', async () => {
    const host = await render();
    const props = lastProps();
    expect(props.items).toHaveLength(1);
    expect(props.items[0].fileDiff.name).toBe('src/app.ts');
    expect(props.options).toMatchObject({
      diffStyle: 'unified',
      theme: 'pierre-dark',
      preferredHighlighter: 'shiki-js',
      enableGutterUtility: true,
    });
    // Full-file loading would read through the global workspace cwd, not the mission's scope.
    expect(props.options.loadDiffFiles).toBeUndefined();
    expect(host.querySelector('.git-scm__diff-line')).toBeNull();
  });

  it('comments on a selected range and sends it in the agent annotation shape', async () => {
    const sendSpy = vi.spyOn(agentAttach, 'sendAnnotationsToAgent').mockResolvedValue(true);
    const host = await render();

    beginComment({ start: 1, side: 'additions', end: 2, endSide: 'additions' });
    const editor = host.querySelector('[data-annotation="additions:2"]');
    expect(editor?.textContent).toContain('Anotação para linhas 1 a 2:');
    expect(lastProps().options.enableGutterUtility).toBe(false);

    setTextareaValue(
      editor!.querySelector<HTMLTextAreaElement>('.git-scm__diff-comment-input')!,
      'Renomear e manter',
    );
    clickButton(host, 'Guardar rascunho');
    expect(host.textContent).toContain('1 revisão(ões) em rascunho');
    expect(host.querySelector('[data-annotation="additions:2"]')?.textContent).toContain(
      'Linhas 1 a 2: Renomear e manter',
    );

    const send = findButton(host, 'Enviar todas ao agente');
    await act(async () => {
      send.click();
    });
    expect(sendSpy).toHaveBeenCalledWith([
      {
        path: 'src/app.ts',
        line: 1,
        body: 'Renomear e manter\n\n> const newConst = 2;\n> const keep = 3;',
      },
    ]);
  });

  it('sends a deleted line against the old file line', async () => {
    const sendSpy = vi.spyOn(agentAttach, 'sendAnnotationsToAgent').mockResolvedValue(true);
    const host = await render();

    beginComment({ start: 1, side: 'deletions', end: 1 });
    const editor = host.querySelector('[data-annotation="deletions:1"]');
    setTextareaValue(
      editor!.querySelector<HTMLTextAreaElement>('.git-scm__diff-comment-input')!,
      'Por que remover?',
    );
    const send = findButton(host, 'Enviar agora');
    await act(async () => {
      send.click();
    });
    expect(sendSpy).toHaveBeenCalledWith([
      { path: 'src/app.ts', line: 1, body: 'Por que remover?\n\n> const old = 1;' },
    ]);
  });

  it('keeps a range draft on its own file and sends it with that path from another file', async () => {
    const sendSpy = vi.spyOn(agentAttach, 'sendAnnotationsToAgent').mockResolvedValue(true);
    useGitScmStore.setState({
      unstaged: [
        { path: 'src/app.ts', status: 'M' },
        { path: 'src/other.ts', status: 'M' },
      ],
    });
    const host = await render();
    beginComment({ start: 1, side: 'additions', end: 2, endSide: 'additions' });
    setTextareaValue(
      host.querySelector<HTMLTextAreaElement>('.git-scm__diff-comment-input')!,
      'Renomear',
    );
    clickButton(host, 'Guardar rascunho');

    act(() =>
      useGitScmStore.setState({
        selected: { path: 'src/other.ts', section: 'unstaged' },
        diffText: PATCH.replaceAll('src/app.ts', 'src/other.ts'),
      }),
    );
    expect(lastProps().items[0].fileDiff.name).toBe('src/other.ts');
    expect(lastProps().items[0].annotations).toEqual([]);
    expect(host.textContent).toContain('1 revisão(ões) em rascunho');

    const send = findButton(host, 'Enviar todas ao agente');
    await act(async () => {
      send.click();
    });
    expect(sendSpy).toHaveBeenCalledWith([
      {
        path: 'src/app.ts',
        line: 1,
        body: 'Renomear\n\n> const newConst = 2;\n> const keep = 3;',
      },
    ]);
  });

  it('keeps the open comment on its line across layout switches and resizes', async () => {
    const host = await render();
    beginComment({ start: 2, side: 'additions', end: 2 });
    setTextareaValue(
      host.querySelector<HTMLTextAreaElement>('.git-scm__diff-comment-input')!,
      'rascunho em curso',
    );

    clickButton(host, 'Lado a lado');
    expect(lastProps().options.diffStyle).toBe('split');
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(viewer.mounts).toBe(1);
    const annotation = host.querySelector('[data-annotation="additions:2"]');
    expect(annotation?.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(
      'rascunho em curso',
    );
    expect(lastProps().items[0].annotations).toEqual([
      expect.objectContaining({ side: 'additions', lineNumber: 2 }),
    ]);
  });

  it('falls back to text rows for a binary diff', async () => {
    useGitScmStore.setState({
      diffText:
        'diff --git a/logo.png b/logo.png\nindex 1111111..2222222 100644\nBinary files a/logo.png and b/logo.png differ\n',
    });
    const host = await render({ viewer: false });
    // The fallback never mounts the lazy viewer; flush anything pending before asserting so.
    await act(async () => {});
    expect(viewer.props).toHaveLength(0);
    expect(host.querySelector('.git-scm__diff-notice')?.textContent).toContain('binário');
    expect(host.querySelector('.git-scm__diff-lines')).not.toBeNull();
  });

  it('keeps stage, unstage and discard on the tree rows', async () => {
    const stage = vi.fn().mockResolvedValue(undefined);
    const unstage = vi.fn().mockResolvedValue(undefined);
    const discard = vi.fn().mockResolvedValue(true);
    useGitScmStore.setState({ stage, unstage, discard });
    const host = await render();

    const button = (label: string) => {
      const node = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
      if (!node) throw new Error(`${label} not rendered`);
      return node;
    };
    act(() => button('Stage src/app.ts').click());
    act(() => button('Unstage src/lib/x.ts').click());
    act(() => button('Descartar alterações em src/app.ts').click());

    expect(stage).toHaveBeenCalledWith(['src/app.ts']);
    expect(unstage).toHaveBeenCalledWith(['src/lib/x.ts']);
    expect(discard).toHaveBeenCalledWith(['src/app.ts']);
    expect(host.querySelector('[role="tree"][aria-label="Arquivos em Staged"]')).not.toBeNull();
  });
});
