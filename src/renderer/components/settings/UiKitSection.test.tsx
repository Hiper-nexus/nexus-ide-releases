/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { UiKitStatusView } from '../../../shared/ui-kit-contract';
import { UiKitSection } from './UiKitSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function status(over: Partial<UiKitStatusView> = {}): UiKitStatusView {
  return {
    workspaceOpen: true,
    license: { state: 'absent', stored: false, masked: null },
    registries: [],
    knownRegistries: [
      {
        namespace: '@shadcnuikit',
        label: 'Shadcn UI Kit',
        url: 'https://shadcnuikit.com/r/{name}.json',
        site: 'https://shadcnuikit.com',
        note: 'Admin dashboards, blocks and templates.',
        configured: false,
      },
    ],
    recipes: [
      {
        id: 'super-admin',
        label: 'Super admin',
        description: 'Shell, sidebar, overview, table, auth, settings.',
        roles: ['shell', 'overview', 'charts', 'table', 'auth', 'settings'],
      },
    ],
    cache: { shadcn: { items: 2, bytes: 4096 }, boardui: { items: 0, bytes: 0 } },
    freeItemCount: 45,
    proItemCount: 36,
    ...over,
  };
}

function api(over: Record<string, unknown> = {}) {
  const uiKit = {
    status: vi.fn().mockResolvedValue(status()),
    catalog: vi.fn().mockResolvedValue({
      kit: 'shadcn',
      items: [
        { slug: 'button', label: 'button', category: 'registry-item', tier: 'free', cached: false },
      ],
      bestEffort: true,
    }),
    install: vi.fn().mockResolvedValue({ ok: true, installed: ['sidebar'] }),
    license: vi.fn().mockResolvedValue({ state: 'active', stored: true, masked: '••••9999' }),
    registry: vi.fn().mockResolvedValue(status()),
    cacheClear: vi.fn().mockResolvedValue(status()),
    ...over,
  };
  Object.defineProperty(window, 'nexus', { configurable: true, value: { uiKit } });
  return uiKit;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'nexus');
});

/** React tracks its own value setter, so a raw assignment is not seen. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mount() {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => {
    root.render(<UiKitSection />);
  });
  return { host, root };
}

it('says the free half needs no key before it mentions a licence', async () => {
  api();
  const { host, root } = await mount();
  try {
    expect(host.textContent).toContain('shadcn/ui');
    expect(host.textContent).toContain('sem chave');
    // The counts are what tell the operator the feature is not gated.
    expect(host.textContent).toContain('45 itens grátis');
    expect(host.textContent).toContain('36 são Pro');
  } finally {
    act(() => root.unmount());
  }
});

it('stores the licence, clears the field and never renders the key', async () => {
  const active = { state: 'active' as const, stored: true, masked: '••••9999' };
  const uiKit = api({
    // Main answers the refresh with the new state, as the real handler does.
    status: vi
      .fn()
      .mockResolvedValueOnce(status())
      .mockResolvedValue(status({ license: active })),
  });
  const { host, root } = await mount();
  try {
    const input = host.querySelector<HTMLInputElement>('input[type="password"]');
    expect(input).not.toBeNull();
    await act(async () => typeInto(input!, 'BUI-SECRET-9999'));
    const save = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Salvar e ativar'),
    );
    await act(async () => save!.click());

    expect(uiKit.license).toHaveBeenCalledWith({ action: 'set', key: 'BUI-SECRET-9999' });
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe('');
    expect(host.textContent).not.toContain('BUI-SECRET-9999');
    expect(host.textContent).toContain('••••9999');
  } finally {
    act(() => root.unmount());
  }
});

it('installs a whole recipe in one click', async () => {
  const uiKit = api();
  const { host, root } = await mount();
  try {
    expect(host.textContent).toContain('Super admin');
    const install = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Instalar em'),
    );
    await act(async () => install!.click());

    expect(uiKit.install).toHaveBeenCalledWith({ kit: 'shadcn', recipe: 'super-admin' });
    expect(host.textContent).toContain('Instalado: sidebar');
  } finally {
    act(() => root.unmount());
  }
});

it('explains a Pro-only role instead of reporting a bare failure', async () => {
  api({
    install: vi.fn().mockResolvedValue({
      ok: true,
      installed: [],
      unresolved: [],
      needsLicense: ['charts'],
    }),
  });
  const { host, root } = await mount();
  try {
    const install = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Instalar em'),
    );
    await act(async () => install!.click());

    expect(host.textContent).toContain('Só havia item Pro para: charts');
    expect(host.textContent).toContain('guarde a chave do BoardUI');
  } finally {
    act(() => root.unmount());
  }
});

it('blocks installing with no project open but still lets the key be stored', async () => {
  api({ status: vi.fn().mockResolvedValue(status({ workspaceOpen: false })) });
  const { host, root } = await mount();
  try {
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Abra um projeto');
    const install = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Instalar em'),
    );
    expect(install?.disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')?.disabled).toBeFalsy();
  } finally {
    act(() => root.unmount());
  }
});

it('does not read an empty search list as an empty registry', async () => {
  api({
    catalog: vi.fn().mockResolvedValue({ kit: 'shadcn', items: [], bestEffort: true }),
  });
  const { host, root } = await mount();
  try {
    expect(host.textContent).toContain('não prova que o registry está');
  } finally {
    act(() => root.unmount());
  }
});

it('survives a rejected status without leaking transport detail', async () => {
  api({ status: vi.fn().mockRejectedValue(new Error('private transport detail')) });
  const { host, root } = await mount();
  try {
    expect(host.textContent).not.toContain('private transport detail');
    expect(host.textContent).toContain('Kits de UI');
  } finally {
    act(() => root.unmount());
  }
});

it('offers a known paid registry as a prefill, and never a key', async () => {
  // The configuration ships; the token does not. A key embedded in the app
  // would be published to everyone who unpacks it.
  const uiKit = api();
  const { host, root } = await mount();
  try {
    const prefill = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Shadcn UI Kit'),
    );
    expect(prefill).toBeTruthy();
    await act(async () => prefill!.click());

    const inputs = [...host.querySelectorAll('input')];
    expect(inputs.some((i) => i.value === '@shadcnuikit')).toBe(true);
    expect(inputs.some((i) => i.value.includes('shadcnuikit.com/r/'))).toBe(true);
    // Nothing was saved by the prefill alone, and no token was invented.
    expect(uiKit.registry).not.toHaveBeenCalled();
    expect(host.textContent).not.toMatch(/suk-|Bearer /);
  } finally {
    act(() => root.unmount());
  }
});

it('adds a registry with the operator own token', async () => {
  const uiKit = api();
  const { host, root } = await mount();
  try {
    const inputs = [...host.querySelectorAll('input')];
    const ns = inputs.find((i) => i.getAttribute('aria-label') === 'Namespace do registry');
    const url = inputs.find((i) => i.getAttribute('aria-label') === 'URL do registry');
    const token = inputs.find((i) => i.getAttribute('aria-label') === 'Token do registry');
    await act(async () => {
      typeInto(ns!, '@meukit');
      typeInto(url!, 'https://meukit.test/r/{name}.json');
      typeInto(token!, 'tok-do-operador');
    });
    const save = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Adicionar',
    );
    await act(async () => save!.click());

    expect(uiKit.registry).toHaveBeenCalledWith({
      action: 'set',
      registry: { namespace: '@meukit', url: 'https://meukit.test/r/{name}.json' },
      token: 'tok-do-operador',
    });
  } finally {
    act(() => root.unmount());
  }
});
