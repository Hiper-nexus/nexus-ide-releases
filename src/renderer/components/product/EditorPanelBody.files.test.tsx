/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '../../../shared/files-types';
import { useFilesStore } from '../../state/files-store';
import { EditorPanelBody } from './ProductPanelBodies';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots = new Set<Root>();
const filesApi = {
  list: vi.fn<Window['nexus']['files']['list']>(),
  read: vi.fn<Window['nexus']['files']['read']>(),
  write: vi.fn<Window['nexus']['files']['write']>(),
};

const sourceDirectory: FileNode = {
  name: 'src',
  relPath: 'src',
  kind: 'dir',
};
const sourceFile: FileNode = {
  name: 'index.ts',
  relPath: 'src/index.ts',
  kind: 'file',
};
const readmeFile: FileNode = {
  name: 'README.md',
  relPath: 'README.md',
  kind: 'file',
};

function mount(node: ReactNode): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.add(root);
  act(() => root.render(node));
  return host;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

function accessibleName(button: HTMLButtonElement): string {
  return `${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`.trim();
}

function buttonByName(
  root: ParentNode,
  name: RegExp,
): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      name.test(accessibleName(button)),
    ) ?? null
  );
}

function requiredButton(root: ParentNode, name: RegExp): HTMLButtonElement {
  const button = buttonByName(root, name);
  expect(button, `Expected button matching ${String(name)}`).not.toBeNull();
  return button!;
}

function requiredEditor(root: ParentNode): HTMLTextAreaElement {
  const editor = root.querySelector<HTMLTextAreaElement>('textarea');
  expect(editor, 'Expected the workspace editor textarea').not.toBeNull();
  return editor!;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('Native textarea value setter unavailable');
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function announcementText(root: ParentNode): string {
  return [
    ...root.querySelectorAll<HTMLElement>(
      '[role="alert"], [role="status"], [aria-live]',
    ),
  ]
    .map((node) => node.textContent ?? '')
    .join(' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  filesApi.list.mockImplementation(async (relPath) => ({
    ok: true,
    entries:
      relPath === ''
        ? [sourceDirectory, readmeFile]
        : relPath === 'src'
          ? [sourceFile]
          : [],
  }));
  filesApi.read.mockResolvedValue({
    ok: true,
    content: 'export const ready = false;\n',
  });
  filesApi.write.mockResolvedValue({ ok: true });
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      files: filesApi,
    } as unknown as Window['nexus'],
  });
  useFilesStore.setState({
    children: {},
    expanded: new Set(),
    loadErrors: {},
    loadingDirs: new Set(),
    openFile: null,
    saving: false,
  });
});

afterEach(() => {
  for (const root of [...roots].reverse()) {
    act(() => root.unmount());
    roots.delete(root);
  }
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'nexus');
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('contextual Editor workspace-file capability', () => {
  it('browses the lazy workspace tree, opens a file, edits it, and saves the dirty buffer', async () => {
    const host = mount(<EditorPanelBody />);
    await settle();

    expect(filesApi.list).toHaveBeenCalledWith('');
    expect(buttonByName(host, /^src$/i)).not.toBeNull();
    expect(buttonByName(host, /^README\.md$/i)).not.toBeNull();

    act(() => requiredButton(host, /^src$/i).click());
    await settle();
    expect(filesApi.list).toHaveBeenCalledWith('src');
    expect(buttonByName(host, /^index\.ts$/i)).not.toBeNull();

    act(() => requiredButton(host, /^index\.ts$/i).click());
    await settle();
    expect(filesApi.read).toHaveBeenCalledWith('src/index.ts');
    const editor = requiredEditor(host);
    expect(editor.value).toBe('export const ready = false;\n');

    setTextareaValue(editor, 'export const ready = true;\n');
    const save = requiredButton(host, /Salvar/i);
    expect(save.disabled).toBe(false);
    expect(host.textContent).toMatch(/não salvo|•/i);

    act(() => save.click());
    await settle();
    expect(filesApi.write).toHaveBeenCalledWith(
      'src/index.ts',
      'export const ready = true;\n',
    );
    expect(save.disabled).toBe(true);
    expect(announcementText(host)).toMatch(/Salvo/i);
  });

  it('announces an open failure in place without presenting a false editable file', async () => {
    filesApi.list.mockResolvedValueOnce({
      ok: true,
      entries: [readmeFile],
    });
    filesApi.read.mockResolvedValueOnce({
      ok: false,
      error: 'O arquivo deixou de existir.',
    });
    const host = mount(<EditorPanelBody />);
    await settle();

    act(() => requiredButton(host, /^README\.md$/i).click());
    await settle();

    expect(announcementText(host)).toMatch(/arquivo deixou de existir/i);
    expect(buttonByName(host, /Salvar/i)?.disabled).toBe(true);
  });

  it('keeps a failed save dirty and announces the workspace write error', async () => {
    filesApi.list.mockResolvedValueOnce({
      ok: true,
      entries: [readmeFile],
    });
    filesApi.write.mockResolvedValueOnce({
      ok: false,
      error: 'Sem permissão para gravar neste workspace.',
    });
    const host = mount(<EditorPanelBody />);
    await settle();

    act(() => requiredButton(host, /^README\.md$/i).click());
    await settle();
    const editor = requiredEditor(host);
    setTextareaValue(editor, '# Nexus atualizado\n');
    const save = requiredButton(host, /Salvar/i);
    act(() => save.click());
    await settle();

    expect(announcementText(host)).toMatch(/Sem permissão para gravar/i);
    expect(save.disabled).toBe(false);
    expect(host.textContent).toMatch(/não salvo|•/i);
  });

  it('drops the previous workspace tree and editor buffer when the files domain is reset', async () => {
    useFilesStore.setState({
      children: { '': [readmeFile] },
      expanded: new Set(),
      openFile: {
        relPath: 'README.md',
        content: '# Workspace anterior\n',
        dirty: true,
      },
      saving: false,
    });
    const host = mount(<EditorPanelBody />);
    await settle();

    expect(buttonByName(host, /^README\.md$/i)).not.toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toMatch(
      /Workspace anterior/,
    );

    const nextWorkspaceFile: FileNode = {
      name: 'package.json',
      relPath: 'package.json',
      kind: 'file',
    };
    act(() => {
      useFilesStore.getState().reset();
      useFilesStore.setState({ children: { '': [nextWorkspaceFile] } });
    });

    expect(buttonByName(host, /^README\.md$/i)).toBeNull();
    expect(buttonByName(host, /^package\.json$/i)).not.toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>('textarea')).toBeNull();
    expect(host.textContent).toMatch(/Selecione um arquivo/i);
  });
  it('announces a failed root listing and recovers through an explicit retry', async () => {
    filesApi.list
      .mockResolvedValueOnce({
        ok: false,
        error: 'Não foi possível listar este workspace.',
      })
      .mockResolvedValueOnce({
        ok: true,
        entries: [readmeFile],
      });
    const host = mount(<EditorPanelBody />);
    await settle();

    expect(announcementText(host)).toMatch(/listar este workspace/i);
    expect(host.textContent).not.toMatch(/Carregando arquivos…/i);

    act(() =>
      requiredButton(
        host,
        /Tentar carregar arquivos novamente/i,
      ).click(),
    );
    await settle();

    expect(filesApi.list).toHaveBeenCalledTimes(2);
    expect(filesApi.list).toHaveBeenNthCalledWith(2, '');
    expect(buttonByName(host, /^README\.md$/i)).not.toBeNull();
    expect(announcementText(host)).not.toMatch(/listar este workspace/i);
    expect(host.textContent).not.toMatch(/Carregando arquivos…/i);
  });

  it('ends a failed nested-directory load locally and recovers that directory on retry', async () => {
    filesApi.list
      .mockResolvedValueOnce({
        ok: true,
        entries: [sourceDirectory],
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'Não foi possível listar a pasta src.',
      })
      .mockResolvedValueOnce({
        ok: true,
        entries: [sourceFile],
      });
    const host = mount(<EditorPanelBody />);
    await settle();

    act(() => requiredButton(host, /^src$/i).click());
    await settle();

    expect(announcementText(host)).toMatch(/listar a pasta src/i);
    expect(host.textContent).not.toMatch(/Carregando…/i);

    act(() =>
      requiredButton(host, /Tentar carregar src novamente/i).click(),
    );
    await settle();

    expect(filesApi.list).toHaveBeenCalledTimes(3);
    expect(filesApi.list).toHaveBeenNthCalledWith(3, 'src');
    expect(buttonByName(host, /^index\.ts$/i)).not.toBeNull();
    expect(announcementText(host)).not.toMatch(/listar a pasta src/i);
    expect(host.textContent).not.toMatch(/Carregando…/i);
  });
});
