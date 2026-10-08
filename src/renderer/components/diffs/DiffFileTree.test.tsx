/** @vitest-environment jsdom */
// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: the reveal/no-echo cases of
// apps/web/src/components/diffs/DiffFileTree.test.tsx, driven through real DOM events on the
// Nexus tree (no react-test-renderer, no Pierre model).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitFileChange } from '../../../shared/git-scm';
import { DiffFileTree } from './DiffFileTree';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const FILES: GitFileChange[] = [
  { path: 'src/a/one.ts', status: 'M' },
  { path: 'src/a/two.ts', status: 'A' },
  { path: 'src/b/three.ts', status: 'M' },
  { path: 'README.md', status: 'M' },
];

let root: Root | null = null;
let host: HTMLElement;
const scrollIntoView = vi.fn();
const onSelectFile = vi.fn();
const onStage = vi.fn();

function render(files: GitFileChange[], selectedPath: string | null) {
  act(() =>
    root!.render(
      <DiffFileTree
        files={files}
        selectedPath={selectedPath}
        ariaLabel="Arquivos em Changes"
        onSelectFile={onSelectFile}
        renderFileActions={(file) => (
          <button type="button" aria-label={`Stage ${file.path}`} onClick={() => onStage(file.path)}>
            +
          </button>
        )}
      />,
    ),
  );
}

function item(title: string): HTMLButtonElement {
  const node = host.querySelector<HTMLButtonElement>(`[role="treeitem"][title="${title}"]`);
  if (!node) throw new Error(`treeitem ${title} not rendered`);
  return node;
}

function visibleTitles(): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]')).map(
    (node) => node.title,
  );
}

function press(target: HTMLElement, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  vi.clearAllMocks();
});

describe('DiffFileTree', () => {
  it('reveals a selection once and does not reopen or rescroll on refresh', () => {
    render(FILES, null);
    act(() => item('src/a').click());
    expect(visibleTitles()).not.toContain('src/a/two.ts');

    render(FILES, 'src/a/two.ts');
    expect(item('src/a').getAttribute('aria-expanded')).toBe('true');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(item('src/a/two.ts'));

    // The reader closes the folder again; the 8s poll hands over a fresh array.
    act(() => item('src/a').click());
    render(FILES.map((file) => ({ ...file })), 'src/a/two.ts');
    render([...FILES, { path: 'src/a/four.ts', status: '?' }], 'src/a/two.ts');
    expect(item('src/a').getAttribute('aria-expanded')).toBe('false');
    expect(visibleTitles()).not.toContain('src/a/four.ts');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("selects the reader's own click without scrolling back to it", () => {
    render(FILES, null);
    act(() => item('src/b/three.ts').click());
    expect(onSelectFile).toHaveBeenCalledWith('src/b/three.ts');

    render(FILES, 'src/b/three.ts');
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(item('src/b/three.ts').getAttribute('aria-selected')).toBe('true');
  });

  it('moves focus and opens/closes folders from the keyboard', () => {
    render(FILES, null);
    const first = item('src');
    expect(first.tabIndex).toBe(0);
    act(() => first.focus());

    press(first, 'ArrowDown');
    expect(document.activeElement).toBe(item('src/a'));
    expect(item('src/a').tabIndex).toBe(0);
    expect(first.tabIndex).toBe(-1);

    press(item('src/a'), 'ArrowLeft');
    expect(item('src/a').getAttribute('aria-expanded')).toBe('false');
    expect(visibleTitles()).not.toContain('src/a/one.ts');

    press(item('src/a'), 'ArrowRight');
    expect(item('src/a').getAttribute('aria-expanded')).toBe('true');
    press(item('src/a'), 'ArrowRight');
    expect(document.activeElement).toBe(item('src/a/one.ts'));

    press(item('src/a/one.ts'), 'End');
    expect(document.activeElement).toBe(item('README.md'));
  });

  it('keeps each file row actions (stage/unstage) working', () => {
    render(FILES, null);
    const stage = host.querySelector<HTMLButtonElement>('[aria-label="Stage src/b/three.ts"]');
    act(() => stage!.click());
    expect(onStage).toHaveBeenCalledWith('src/b/three.ts');
    expect(onSelectFile).not.toHaveBeenCalled();
    expect(host.querySelectorAll('[aria-label^="Stage "]')).toHaveLength(FILES.length);
  });
  it('exposes only treeitems under the tree, each file action inside its own row', () => {
    render(FILES, null);
    const tree = host.querySelector('[role="tree"]')!;
    expect(Array.from(tree.children).map((child) => child.getAttribute('role'))).toEqual(
      Array(7).fill('treeitem'),
    );
    const actions = Array.from(tree.querySelectorAll('button'));
    expect(actions).toHaveLength(FILES.length);
    for (const action of actions) {
      expect(action.closest('[role="treeitem"]')?.getAttribute('title')).toBe(
        action.getAttribute('aria-label')!.replace('Stage ', ''),
      );
    }
    // The row's name is its file, not the labels of the buttons inside it.
    expect(item('src/a/one.ts').getAttribute('aria-label')).toBe('one.ts, M');
  });

  it('activates rows with Enter/Space but leaves keys on the row actions alone', () => {
    render(FILES, null);
    press(item('src/b/three.ts'), 'Enter');
    expect(onSelectFile).toHaveBeenCalledWith('src/b/three.ts');

    press(item('src/a'), ' ');
    expect(item('src/a').getAttribute('aria-expanded')).toBe('false');

    onSelectFile.mockClear();
    const stage = host.querySelector<HTMLButtonElement>('[aria-label="Stage README.md"]')!;
    act(() => stage.focus());
    press(stage, 'Enter');
    press(stage, 'ArrowUp');
    expect(onSelectFile).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(stage);
  });
});
