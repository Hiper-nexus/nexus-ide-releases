/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaStudioPanel } from './MediaStudioPanel';
import { useMediaStudioStore } from '../state/media-studio-store';
import { useProductNavigationStore } from '../state/product-navigation-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const originalNexusDescriptor = Object.getOwnPropertyDescriptor(window, 'nexus');

function MediaHarness() {
  const open = useMediaStudioStore((state) => state.open);
  const show = useMediaStudioStore((state) => state.show);
  const hide = useMediaStudioStore((state) => state.hide);
  return (
    <>
      <button type="button" onClick={show}>
        Abrir Estúdio de Mídia
      </button>
      <MediaStudioPanel open={open} onClose={hide} />
    </>
  );
}

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

function renderHarness(): HTMLButtonElement {
  const host = render(<MediaHarness />);
  const invoker = host.querySelector<HTMLButtonElement>('button');
  if (!invoker) throw new Error('Media Studio invoker was not rendered');
  return invoker;
}

async function openFrom(invoker: HTMLButtonElement): Promise<HTMLElement> {
  act(() => {
    invoker.focus();
    invoker.click();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const dialog = document.querySelector<HTMLElement>(
    '[role="dialog"][aria-modal="true"]',
  );
  if (!dialog) throw new Error('Media Studio dialog was not rendered');
  return dialog;
}

function referencedText(element: HTMLElement, attribute: string): string {
  return (element.getAttribute(attribute) ?? '')
    .split(/\s+/u)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

function enabledFocusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
}

function keydown(target: EventTarget, key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  act(() => target.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    writable: true,
    value: {
      media: {
        listProviders: vi.fn(async () => []),
        listArtifacts: vi.fn(async () => []),
        readArtifactDataUrl: vi.fn(async () => ({ ok: false })),
        generate: vi.fn(),
        cancelGenerate: vi.fn(),
        revealArtifact: vi.fn(),
      },
    },
  });
  useMediaStudioStore.setState({ open: false });
  useProductNavigationStore.setState({
    destination: { kind: 'terminal' },
    settingsReturnDestination: null,
  });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  if (originalNexusDescriptor) {
    Object.defineProperty(window, 'nexus', originalNexusDescriptor);
  } else {
    Reflect.deleteProperty(window, 'nexus');
  }
});

describe('MediaStudioPanel: revelar arquivo por sistema (F-1579)', () => {
  it('no Windows a galeria mostra no Explorador de Arquivos, nunca no Finder', async () => {
    const nexus = window.nexus as unknown as {
      platform?: string;
      media: { listArtifacts: ReturnType<typeof vi.fn> };
    };
    nexus.platform = 'win32';
    nexus.media.listArtifacts.mockResolvedValue([
      { id: 'a1', kind: 'image', storageKey: 'media/foto.png', costUsd: null, createdAt: 1 },
    ]);
    const dialog = await openFrom(renderHarness());
    const card = dialog.querySelector<HTMLButtonElement>('.ms-card');
    expect(card?.title).toBe('Mostrar no Explorador de Arquivos');
    expect(dialog.textContent).not.toContain('Finder');
  });
});

describe('MediaStudioPanel: Vídeos do projeto (F-1596)', () => {
  it('a terceira aba mostra os projetos de vídeo sem trocar o tipo de geração', async () => {
    const listProjects = vi.fn(async () => ({ ok: true, projects: [] }));
    (window.nexus as unknown as Record<string, unknown>).videoStudio = {
      listProjects,
      onProgress: () => () => undefined,
    };
    const dialog = await openFrom(renderHarness());
    const tab = [...dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent === 'Vídeos do projeto');
    expect(tab?.getAttribute('aria-selected')).toBe('false');
    await act(async () => {
      tab?.click();
    });
    expect(tab?.getAttribute('aria-selected')).toBe('true');
    expect(listProjects).toHaveBeenCalled();
    expect(dialog.textContent).toContain('Novo vídeo de apresentação');
    expect(dialog.querySelector('textarea.ms-prompt')).toBeNull();
    const image = [...dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent === 'Imagem');
    await act(async () => {
      image?.click();
    });
    expect(image?.getAttribute('aria-selected')).toBe('true');
    expect(dialog.textContent).not.toContain('Novo vídeo de apresentação');
  });
});

describe('MediaStudioPanel behavioral contract', () => {
  it('uses its rendered title and description for the dialog name and moves initial focus inside', async () => {
    const invoker = renderHarness();

    const dialog = await openFrom(invoker);

    expect(referencedText(dialog, 'aria-labelledby')).toBe('Estúdio de Mídia');
    expect(referencedText(dialog, 'aria-describedby')).toContain(
      'Crie imagens e vídeos com IA.',
    );
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(invoker);
  });

  it('traps Tab and Shift+Tab through every enabled control in DOM order', async () => {
    const dialog = await openFrom(renderHarness());
    const focusables = enabledFocusables(dialog);
    expect(focusables.length).toBeGreaterThan(2);

    for (const [index, element] of focusables.entries()) {
      element.focus();
      keydown(element, 'Tab');
      expect(document.activeElement).toBe(
        focusables[(index + 1) % focusables.length],
      );
    }

    for (const [index, element] of focusables.entries()) {
      element.focus();
      keydown(element, 'Tab', true);
      expect(document.activeElement).toBe(
        focusables[(index - 1 + focusables.length) % focusables.length],
      );
    }
  });

  it('closes before deep-linking the empty-provider action to canonical Settings media', async () => {
    const dialog = await openFrom(renderHarness());
    const configure = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Configurar API key'));
    if (!configure) throw new Error('Configure API key action was not rendered');

    act(() => configure.click());

    expect(useMediaStudioStore.getState().open).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'settings',
      section: 'media',
    });
  });

  it('cancels with Escape or backdrop press and restores focus to the invoking action', async () => {
    const invoker = renderHarness();

    let dialog = await openFrom(invoker);
    keydown(document.activeElement ?? dialog, 'Escape');
    expect(useMediaStudioStore.getState().open).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(invoker);

    dialog = await openFrom(invoker);
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error('Media Studio backdrop was not rendered');
    act(() =>
      backdrop.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
      ),
    );
    expect(useMediaStudioStore.getState().open).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(invoker);
  });
});
