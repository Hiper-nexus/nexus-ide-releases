/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryWorkspace } from './MemoryWorkspace';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

type LocalMemoryNote = {
  id: string;
  title: string;
  body: string;
  kind: 'note';
};

const memoryBoundary = {
  memoryList: vi.fn(),
  memoryRemember: vi.fn(),
};

const agenticMemoryBoundary = {
  forget: vi.fn(),
};

const mountedRoots: Array<{ host: HTMLDivElement; root: Root }> = [];
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}


function mount(node: ReactNode): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push({ host, root });
  act(() => root.render(node));
  return host;
}

async function settleMemoryEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function installNexusBoundary(): void {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      product: memoryBoundary,
      memory: agenticMemoryBoundary,
    },
  });
}

function setFieldValue(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Form field value setter unavailable');

  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function findButton(host: HTMLElement, name: RegExp): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) =>
      name.test(button.getAttribute('aria-label') ?? button.textContent ?? ''),
  );
  if (!match) throw new Error(`No button matched ${String(name)}`);
  return match;
}

beforeEach(() => {
  memoryBoundary.memoryList.mockReset();
  memoryBoundary.memoryRemember.mockReset();
  agenticMemoryBoundary.forget.mockReset();
  installNexusBoundary();
});

afterEach(() => {
  for (const { root } of mountedRoots.splice(0).reverse()) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'nexus');
  vi.clearAllMocks();
});

describe('MemoryWorkspace contracts', () => {
  it('separates the note composer from the saved-memory area in the full page', async () => {
    memoryBoundary.memoryList.mockResolvedValue([]);
    const host = mount(<MemoryWorkspace />);
    await settleMemoryEffects();
    expect(host.querySelector('.product-pane__form h2')?.textContent).toBe('Nova memória');
    const collection = host.querySelector('.product-pane__entries');
    expect(collection?.querySelector('h2')?.textContent).toContain('Memórias salvas');
    expect(collection?.querySelector('.memory-workspace__empty')).not.toBeNull();
  });

  it('teaches the empty state and focuses the first-note form from its primary CTA', async () => {
    memoryBoundary.memoryList.mockResolvedValue([]);
    const host = mount(<MemoryWorkspace />);
    await settleMemoryEffects();

    expect(host.textContent).toMatch(/nenhuma memória ainda/i);
    expect(host.textContent).toMatch(/título e o texto|salvar/i);
    expect(host.textContent).toMatch(/dados do app|não.*repositório|não.*git/i);
    expect(host.textContent).toMatch(/missões e agentes|agentes podem/i);
    expect(host.textContent).not.toMatch(/proje[cç][aã]o/i);

    const action = findButton(host, /escrever.*primeira memória/i);
    const title = host.querySelector<HTMLInputElement>(
      'input[aria-label="Título da memória"]',
    );
    expect(title).not.toBeNull();

    act(() => action.click());

    expect(document.activeElement).toBe(title);
  });

  it('remembers through the local product API, reloads, and renders the canonical note', async () => {
    const note: LocalMemoryNote = {
      id: 'memory-local-1',
      title: 'Decisão de arquitetura',
      body: 'Manter uma única camada de domínio.',
      kind: 'note',
    };
    memoryBoundary.memoryList
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([note]);
    memoryBoundary.memoryRemember.mockResolvedValue(note);
    const host = mount(<MemoryWorkspace />);
    await settleMemoryEffects();

    const title = host.querySelector<HTMLInputElement>(
      'input[aria-label="Título da memória"]',
    );
    const body = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Corpo da memória"]',
    );
    if (!title || !body) throw new Error('Memory form is unavailable');
    setFieldValue(title, note.title);
    setFieldValue(body, note.body);

    await act(async () => {
      findButton(host, /^salvar$/i).click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(memoryBoundary.memoryRemember).toHaveBeenCalledOnce();
    expect(memoryBoundary.memoryRemember).toHaveBeenCalledWith({
      title: note.title,
      body: note.body,
      kind: 'note',
    });
    expect(memoryBoundary.memoryList).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain(note.title);
    expect(host.textContent).toContain(note.body);
  });

  it('keeps a successful remember distinct from a failed post-save reload', async () => {
    const saved: LocalMemoryNote = {
      id: 'memory-saved-before-reload-failed',
      title: 'Decisão já guardada',
      body: 'Este rascunho foi persistido antes da falha de leitura.',
      kind: 'note',
    };
    memoryBoundary.memoryList
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('reload unavailable'));
    memoryBoundary.memoryRemember.mockResolvedValue(saved);
    const host = mount(<MemoryWorkspace />);
    await settleMemoryEffects();
    const title = host.querySelector<HTMLInputElement>(
      'input[aria-label="Título da memória"]',
    );
    const body = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Corpo da memória"]',
    );
    if (!title || !body) throw new Error('Memory form is unavailable');
    setFieldValue(title, saved.title);
    setFieldValue(body, saved.body);

    await act(async () => {
      findButton(host, /^salvar$/i).click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const message =
      host.querySelector<HTMLElement>('[role="alert"]')?.textContent?.trim() ??
      '';
    expect(memoryBoundary.memoryRemember).toHaveBeenCalledOnce();
    expect(memoryBoundary.memoryList).toHaveBeenCalledTimes(2);
    expect(title.value).toBe('');
    expect(body.value).toBe('');
    expect(message).toMatch(
      /guardada.*(?:recarregar|atualizar)|(?:recarregar|atualizar).*guardada/i,
    );
    expect(message).not.toMatch(/não foi possível (?:guardar|salvar)/i);
  });

  it.each(['response', 'error'] as const)(
    'keeps the newest memory reload authoritative when an older %s settles late',
    async (oldOutcome) => {
      const oldReload = createDeferred<LocalMemoryNote[]>();
      const newReload = createDeferred<LocalMemoryNote[]>();
      const fresh: LocalMemoryNote = {
        id: 'memory-fresh',
        title: 'Nota mais recente',
        body: 'Resposta da recarga mais nova.',
        kind: 'note',
      };
      const stale: LocalMemoryNote = {
        id: 'memory-stale',
        title: 'Nota obsoleta',
        body: 'Resposta atrasada da recarga antiga.',
        kind: 'note',
      };
      memoryBoundary.memoryList
        .mockReturnValueOnce(oldReload.promise)
        .mockReturnValueOnce(newReload.promise);
      memoryBoundary.memoryRemember.mockResolvedValue(fresh);
      const host = mount(<MemoryWorkspace />);
      const title = host.querySelector<HTMLInputElement>(
        'input[aria-label="Título da memória"]',
      );
      if (!title) throw new Error('Memory title field is unavailable');
      setFieldValue(title, 'Disparar recarga mais nova');

      await act(async () => {
        findButton(host, /^salvar$/i).click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(memoryBoundary.memoryList).toHaveBeenCalledTimes(2);

      await act(async () => {
        newReload.resolve([fresh]);
        await newReload.promise;
        await Promise.resolve();
      });
      expect(host.textContent).toContain(fresh.title);
      expect(host.querySelector('.product-pane__loading')).toBeNull();
      expect(host.querySelector('[role="alert"]')).toBeNull();

      await act(async () => {
        if (oldOutcome === 'response') {
          oldReload.resolve([stale]);
          await oldReload.promise;
        } else {
          oldReload.reject(new Error('old reload failed'));
          await oldReload.promise.catch(() => undefined);
        }
        await Promise.resolve();
      });

      expect(host.textContent).toContain(fresh.title);
      expect(host.textContent).not.toContain(stale.title);
      expect(host.querySelector('.product-pane__loading')).toBeNull();
      expect(host.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it('bounds process failures behind a concise PT-BR error surface', async () => {
    const rawFailure = `SQLITE_BUSY_INTERNAL ${'x'.repeat(600)}`;
    memoryBoundary.memoryList.mockRejectedValue(new Error(rawFailure));
    const host = mount(<MemoryWorkspace />);
    await settleMemoryEffects();

    const alert = host.querySelector<HTMLElement>('[role="alert"]');
    const message = alert?.textContent?.trim() ?? '';
    expect(alert).not.toBeNull();
    expect(message).toMatch(/não foi possível|indisponível|tente novamente/i);
    expect(message.length).toBeLessThanOrEqual(180);
    expect(message).not.toContain('SQLITE_BUSY_INTERNAL');
  });

  it('makes a note body beyond the compact snippet fully available through direct text or native disclosure', async () => {
    const longBody =
      `${'Contexto completo para a decisão. '.repeat(12)}` +
      'Encerramento que precisa continuar acessível pelo teclado.';
    const note: LocalMemoryNote = {
      id: 'memory-long-body',
      title: 'Memória extensa',
      body: longBody,
      kind: 'note',
    };
    memoryBoundary.memoryList.mockResolvedValue([note]);
    const host = mount(<MemoryWorkspace />);
    await settleMemoryEffects();
    const item = [...host.querySelectorAll<HTMLLIElement>('li')].find((entry) =>
      entry.textContent?.includes(note.title),
    );
    if (!item) throw new Error('Long memory note was not rendered');
    const directBody =
      item.querySelector('.product-pane__snip')?.textContent === longBody;
    const nativeDisclosure = item.querySelector('details > summary');

    expect(directBody || nativeDisclosure !== null).toBe(true);
    expect(item.textContent).toContain(longBody);
  });

  it('forgets a saved note through the workspace memory API and reloads the list', async () => {
    const note: LocalMemoryNote = {
      id: 'memory-to-forget',
      title: 'Regra antiga',
      body: 'Esta nota deve sair da lista depois de apagar.',
      kind: 'note',
    };
    memoryBoundary.memoryList
      .mockResolvedValueOnce([note])
      .mockResolvedValueOnce([]);
    agenticMemoryBoundary.forget.mockResolvedValue({
      enabled: true,
      forgotten: true,
    });
    const host = mount(<MemoryWorkspace />);
    await settleMemoryEffects();

    await act(async () => {
      findButton(host, /apagar memória regra antiga/i).click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(agenticMemoryBoundary.forget).toHaveBeenCalledOnce();
    expect(agenticMemoryBoundary.forget).toHaveBeenCalledWith(note.id);
    expect(memoryBoundary.memoryList).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain(note.title);
    expect(host.textContent).toMatch(/nenhuma memória ainda/i);
  });

  it('is an in-flow workspace page rather than a floating or dialog surface', async () => {
    memoryBoundary.memoryList.mockResolvedValue([]);
    const host = mount(<MemoryWorkspace />);
    await settleMemoryEffects();

    expect(
      host.querySelector('section[aria-label="Memória do workspace"]'),
    ).not.toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[aria-modal="true"]')).toBeNull();
    expect(host.querySelector('.memory-panel')).toBeNull();
  });
});
