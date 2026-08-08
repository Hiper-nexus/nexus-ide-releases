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

const mountedRoots: Array<{ host: HTMLDivElement; root: Root }> = [];

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
  it('teaches the empty state and focuses the first-note form from its primary CTA', async () => {
    memoryBoundary.memoryList.mockResolvedValue([]);
    const host = mount(<MemoryWorkspace />);
    await settleMemoryEffects();

    expect(host.textContent).toMatch(/nenhuma memória ainda/i);
    expect(host.textContent).toMatch(/primeira memória|registre|guarde/i);

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
      body: 'Manter a projeção local como fonte de leitura.',
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
      findButton(host, /^lembrar$/i).click();
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
