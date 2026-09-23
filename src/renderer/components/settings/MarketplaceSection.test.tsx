/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogEntryInfo } from '../../../shared/types';
import { MARKETPLACE_PAGE_SIZE, MarketplaceSection } from './MarketplaceSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function agent(index: number, category: string): CatalogEntryInfo {
  return {
    kind: 'agent',
    name: `agente-${String(index).padStart(3, '0')}`,
    slug: `${category}/agente-${index}`,
    category,
  } as CatalogEntryInfo;
}

// 30 de "dev" + 5 de "ops": total 35, mais que duas páginas.
const AGENTS = [
  ...Array.from({ length: 30 }, (_, index) => agent(index, 'dev')),
  ...Array.from({ length: 5 }, (_, index) => agent(100 + index, 'ops')),
];

let root: Root | null = null;

async function mount(): Promise<HTMLDivElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<MarketplaceSection />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

function rows(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.mkt-item .settings-list__title')].map(
    (node) => node.textContent ?? '',
  );
}

function moreButton(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    /^Mostrar mais/.test(button.textContent ?? ''),
  );
}

function type(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

describe('MarketplaceSection paging', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        orch: {
          getCatalogIndex: vi.fn(async () => ({ ok: true, index: { agents: AGENTS, skills: [] } })),
          listInstalledCatalog: vi.fn(async () => []),
          installCatalogItem: vi.fn(async () => ({ ok: true })),
        },
      },
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    Reflect.deleteProperty(window, 'nexus');
    document.body.replaceChildren();
  });

  it('mostra só a primeira página e revela mais a cada clique em "Mostrar mais"', async () => {
    const host = await mount();
    expect(rows(host)).toHaveLength(MARKETPLACE_PAGE_SIZE);
    expect(moreButton(host)?.textContent).toBe(`Mostrar mais (${AGENTS.length - MARKETPLACE_PAGE_SIZE})`);

    act(() => moreButton(host)!.click());
    expect(rows(host)).toHaveLength(MARKETPLACE_PAGE_SIZE * 2);

    act(() => moreButton(host)!.click());
    expect(rows(host)).toHaveLength(AGENTS.length);
    expect(moreButton(host)).toBeUndefined();
  });

  it('busca no catálogo inteiro, inclusive itens fora da primeira página', async () => {
    const host = await mount();
    expect(rows(host)).not.toContain('agente-029');

    const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    type(search, 'agente-029');
    expect(rows(host)).toEqual(['agente-029']);
    expect(moreButton(host)).toBeUndefined();
  });

  it('volta à primeira página quando a categoria muda', async () => {
    const host = await mount();
    act(() => moreButton(host)!.click());
    expect(rows(host)).toHaveLength(MARKETPLACE_PAGE_SIZE * 2);

    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Categoria"]')!;
    type(select, 'ops');
    expect(rows(host)).toHaveLength(5);
    type(select, 'dev');
    expect(rows(host)).toHaveLength(MARKETPLACE_PAGE_SIZE);
    expect(moreButton(host)?.textContent).toBe(`Mostrar mais (${30 - MARKETPLACE_PAGE_SIZE})`);
  });
});
