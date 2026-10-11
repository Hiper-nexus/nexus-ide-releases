/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownCodeHighlight } from './MarkdownCodeHighlight';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  poolReady: true,
  fileProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('@pierre/diffs/worker/worker.js?worker', () => ({
  default: class {
    constructor() {
      throw new Error('worker blocked');
    }
  },
}));

vi.mock('@pierre/diffs/worker', () => ({
  WorkerPoolManager: class {
    isInitialized() {
      return state.poolReady;
    }
    isWorkingPool() {
      return true;
    }
    initialize() {
      return new Promise<void>(() => {});
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

vi.mock('@pierre/diffs/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pierre/diffs/react')>();
  return {
    ...actual,
    File: (props: Record<string, unknown> & { file: { contents: string; lang?: string } }) => {
      state.fileProps.push(props);
      return (
        <div data-testid="pierre-file" data-lang={props.file.lang}>
          {props.file.contents}
        </div>
      );
    },
  };
});

const roots: Root[] = [];
function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
  state.poolReady = true;
  state.fileProps.length = 0;
});

const FALLBACK = <pre data-testid="plain">plain</pre>;

describe('MarkdownCodeHighlight', () => {
  it('realça pelo File do @pierre/diffs, sem cabeçalho nem numeração, no tema escuro', () => {
    const host = render(<MarkdownCodeHighlight code={'const a = 1;'} lang="typescript" fallback={FALLBACK} />);
    const file = host.querySelector('[data-testid="pierre-file"]');
    expect(file?.getAttribute('data-lang')).toBe('typescript');
    expect(file?.textContent).toBe('const a = 1;');
    expect(host.querySelector('[data-testid="plain"]')).toBeNull();
    const props = state.fileProps.at(-1)!;
    expect(props.className).toBe('markdown-view__highlight');
    expect(props.options).toMatchObject({
      disableLineNumbers: true,
      disableFileHeader: true,
      theme: 'pierre-dark',
      themeType: 'dark',
      preferredHighlighter: 'shiki-js',
    });
    expect(String((props.options as { unsafeCSS?: string }).unsafeCSS)).toContain('--diffs-bg');
  });

  it('segue o tema claro do app', () => {
    document.documentElement.dataset.theme = 'nexus-light';
    render(<MarkdownCodeHighlight code="x" lang="python" fallback={FALLBACK} />);
    expect(state.fileProps.at(-1)!.options).toMatchObject({ theme: 'pierre-light', themeType: 'light' });
  });

  it('mostra o texto puro enquanto o pool de realce não fica pronto', () => {
    state.poolReady = false;
    const host = render(<MarkdownCodeHighlight code="x" lang="python" fallback={FALLBACK} />);
    expect(host.querySelector('[data-testid="plain"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="pierre-file"]')).toBeNull();
    expect(host.textContent).not.toContain('Carregando realce');
  });
});
