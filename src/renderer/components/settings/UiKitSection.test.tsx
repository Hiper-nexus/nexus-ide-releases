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

it('ignores a catalogue reply for a kit the operator already left', async () => {
  // The reply can take a vendor round trip. Switching kits while one was in
  // flight let the OLDER reply land last: the previous kit's items showed
  // under the new kit's label, and Install then submitted an old slug with
  // the new `kit`.
  const release: Array<() => void> = [];
  const uiKit = api({
    catalog: vi.fn((request: { kit: string }) => {
      const view = {
        kit: request.kit,
        items: [
          {
            slug: request.kit === 'shadcn' ? 'button' : 'stat-cards',
            label: request.kit === 'shadcn' ? 'button' : 'stat-cards',
            category: 'block',
            tier: 'free' as const,
            cached: false,
          },
        ],
        bestEffort: false,
      };
      return new Promise((resolve) => {
        release.push(() => resolve(view));
      });
    }),
  });
  const { host, root } = await mount();
  try {
    const boardui = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'BoardUI',
    );
    await act(async () => boardui!.click());

    expect(uiKit.catalog).toHaveBeenCalledTimes(2);
    // The NEWER request answers first, then the stale one. Order is the point.
    await act(async () => {
      release[1]?.();
      release[0]?.();
    });

    expect(host.textContent).toContain('stat-cards');
    expect(host.textContent).not.toContain('button');
  } finally {
    act(() => root.unmount());
  }
});

it('refreshes the catalogue for the kit selected NOW, not the one installed into', async () => {
  // The install closure captured `kit`, so switching kits during an install
  // started a NEWER request for the OLD kit — and a newer ticket beats the
  // superseded-request guard, repainting the list under the new kit's label.
  let releaseInstall: (() => void) | null = null;
  const uiKit = api({
    catalog: vi.fn(async (request: { kit: string }) => ({
      kit: request.kit,
      items: [
        {
          slug: request.kit === 'shadcn' ? 'button' : 'stat-cards',
          label: request.kit === 'shadcn' ? 'button' : 'stat-cards',
          category: 'block',
          tier: 'free' as const,
          cached: false,
        },
      ],
      bestEffort: false,
    })),
    install: vi.fn(
      () =>
        new Promise((resolve) => {
          releaseInstall = () => resolve({ ok: true, installed: ['sidebar'] });
        }),
    ),
  });
  const { host, root } = await mount();
  try {
    const start = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Instalar em'),
    );
    await act(async () => start!.click());

    // Kit switched while the install is still in flight.
    const boardui = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'BoardUI',
    );
    await act(async () => boardui!.click());
    await act(async () => {
      releaseInstall?.();
    });

    // The install itself went to the kit the operator clicked for.
    expect(uiKit.install).toHaveBeenCalledWith({ kit: 'shadcn', recipe: 'super-admin' });
    // The list did not go back to it.
    expect(uiKit.catalog).toHaveBeenLastCalledWith({ kit: 'boardui' });
    expect(host.textContent).toContain('stat-cards');
    expect(host.textContent).not.toContain('button');
  } finally {
    act(() => root.unmount());
  }
});

it('names a registry the project does not declare, instead of an empty list', async () => {
  api({
    catalog: vi.fn().mockResolvedValue({
      kit: 'shadcn',
      items: [],
      bestEffort: false,
      unmappedRegistries: ['@acme'],
    }),
  });
  const { host, root } = await mount();
  try {
    expect(host.textContent).toContain('ainda não declara @acme');
    expect(host.textContent).toContain('@acme/algum-item');
  } finally {
    act(() => root.unmount());
  }
});

it('finishes a licence that was stored before any project was open', async () => {
  // Saving a key with the project closed only vaulted it; nothing ever
  // activated it, and the UI promised it would activate once a project opened.
  const uiKit = api({
    status: vi.fn().mockResolvedValue(
      status({ license: { state: 'unknown', stored: true, masked: '••••9999' } }),
    ),
  });
  const { host, root } = await mount();
  try {
    const activate = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Ativar a chave guardada'),
    );
    expect(activate).toBeTruthy();
    await act(async () => activate!.click());

    // No key in the call: it reuses the vaulted one.
    expect(uiKit.license).toHaveBeenCalledWith({ action: 'activate' });
  } finally {
    act(() => root.unmount());
  }
});

it('keeps Remover reachable when the vendor still holds the activation', async () => {
  // `stored: false` with `state: 'active'` is the stranded case: hiding the
  // button would leave the paid seat used with no way to release it.
  api({
    status: vi.fn().mockResolvedValue(
      status({ license: { state: 'active', stored: false, masked: null } }),
    ),
  });
  const { host, root } = await mount();
  try {
    expect(
      [...host.querySelectorAll('button')].some(
        (button) => button.textContent === 'Remover',
      ),
    ).toBe(true);
  } finally {
    act(() => root.unmount());
  }
});

it('installs an item by its exact name, which the registry hint points at', async () => {
  // The hint said "install one item by its exact name" and no control did
  // that: the only Instalar lived in the catalogue list, and an unmapped
  // registry produces no catalogue items.
  const uiKit = api({
    catalog: vi.fn().mockResolvedValue({
      kit: 'shadcn',
      items: [],
      bestEffort: false,
      unmappedRegistries: ['@acme'],
    }),
  });
  const { host, root } = await mount();
  try {
    const field = host.querySelector<HTMLInputElement>(
      'input[aria-label="Instalar item pelo nome exato"]',
    );
    expect(field).toBeTruthy();
    await act(async () => typeInto(field!, '@acme/auth'));
    const button = [...host.querySelectorAll('button')].find(
      (entry) => entry.textContent === 'Instalar pelo nome',
    );
    await act(async () => button!.click());

    expect(uiKit.install).toHaveBeenCalledWith({ kit: 'shadcn', items: ['@acme/auth'] });
  } finally {
    act(() => root.unmount());
  }
});

it('shows the real reason a registry write refused, not the URL rule', async () => {
  api({
    registry: vi.fn().mockResolvedValue(
      status({ registryError: 'o cofre recusou o token' }),
    ),
  });
  const { host, root } = await mount();
  try {
    await act(async () =>
      typeInto(
        host.querySelector<HTMLInputElement>('input[aria-label="Namespace do registry"]')!,
        '@acme',
      ),
    );
    await act(async () =>
      typeInto(
        host.querySelector<HTMLInputElement>('input[aria-label="URL do registry"]')!,
        'https://registry.acme.test/r/{name}.json',
      ),
    );
    const add = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Adicionar',
    );
    await act(async () => add!.click());

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'o cofre recusou o token',
    );
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain('https');
  } finally {
    act(() => root.unmount());
  }
});

it('keeps the licence key typed in when the vault refused it', async () => {
  // A purchased key the vault never stored must not be wiped from the field:
  // the operator would have to find and paste it again.
  api({
    license: vi.fn().mockResolvedValue({
      state: 'unknown',
      stored: false,
      masked: null,
      detail: 'vault write refused',
    }),
  });
  const { host, root } = await mount();
  try {
    const field = host.querySelector<HTMLInputElement>(
      'input[aria-label="Chave de licença do BoardUI"]',
    )!;
    await act(async () => typeInto(field, 'BUI-LIVE-KEY-0001'));
    const save = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Salvar e ativar',
    );
    await act(async () => save!.click());

    expect(field.value).toBe('BUI-LIVE-KEY-0001');
  } finally {
    act(() => root.unmount());
  }
});

it('clears the licence field once Main confirms it was stored', async () => {
  api({
    license: vi.fn().mockResolvedValue({
      state: 'active',
      stored: true,
      masked: '••••0001',
    }),
  });
  const { host, root } = await mount();
  try {
    const field = host.querySelector<HTMLInputElement>(
      'input[aria-label="Chave de licença do BoardUI"]',
    )!;
    await act(async () => typeInto(field, 'BUI-LIVE-KEY-0001'));
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Salvar e ativar')!
        .click(),
    );

    expect(field.value).toBe('');
  } finally {
    act(() => root.unmount());
  }
});

it('refuses to install from the list of a kit already left behind', async () => {
  // The rendered list outlives the switch: heading and captured kit change at
  // once while the OLD catalogue stays painted until its replacement lands.
  // The request ticket only discards late replies.
  const release: Array<() => void> = [];
  const uiKit = api({
    catalog: vi.fn((request: { kit: string }) => {
      const view = {
        kit: request.kit,
        items: [
          {
            slug: request.kit === 'shadcn' ? 'button' : 'stat-cards',
            label: request.kit === 'shadcn' ? 'button' : 'stat-cards',
            category: 'block',
            tier: 'free' as const,
            cached: false,
          },
        ],
        bestEffort: false,
      };
      return new Promise((resolve) => release.push(() => resolve(view)));
    }),
  });
  const { host, root } = await mount();
  try {
    await act(async () => release[0]?.());
    const installOf = () =>
      [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Instalar',
      ) as HTMLButtonElement | undefined;
    expect(installOf()?.disabled).toBe(false);

    // Switch kits; the shadcn list is still on screen while BoardUI loads.
    const boardui = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'BoardUI',
    );
    await act(async () => boardui!.click());

    expect(host.textContent).toContain('button');
    expect(installOf()?.disabled).toBe(true);

    await act(async () => release[1]?.());
    expect(host.textContent).toContain('stat-cards');
    expect(installOf()?.disabled).toBe(false);
    // Nothing was installed from the stale list.
    expect(uiKit.install).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});

async function fillRegistryAndSave(host: HTMLElement) {
  await act(async () =>
    typeInto(
      host.querySelector<HTMLInputElement>('input[aria-label="Namespace do registry"]')!,
      '@acme',
    ),
  );
  await act(async () =>
    typeInto(
      host.querySelector<HTMLInputElement>('input[aria-label="URL do registry"]')!,
      'https://registry.acme.test/r/{name}.json',
    ),
  );
  await act(async () =>
    typeInto(
      host.querySelector<HTMLInputElement>('input[aria-label="Token do registry"]')!,
      'tok-typed-by-hand',
    ),
  );
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Adicionar')!
      .click(),
  );
}

it('keeps the inputs when the namespace is merely PRESENT, with no receipt', async () => {
  // Presence was never success: a validation or persistence exception returns
  // the previous list with that namespace still in it, and a namespace whose
  // shape ships with Nexus is in the effective list even when nothing was
  // written. Clearing on presence threw away the token just typed.
  api({
    registry: vi.fn().mockResolvedValue(
      status({
        registries: [
          {
            namespace: '@acme',
            url: 'https://registry.acme.test/r/{name}.json',
            requiresToken: true,
            tokenStored: false,
          },
        ],
      }),
    ),
  });
  const { host, root } = await mount();
  try {
    await fillRegistryAndSave(host);

    expect(
      host.querySelector<HTMLInputElement>('input[aria-label="Token do registry"]')?.value,
    ).toBe('tok-typed-by-hand');
    expect(
      host.querySelector<HTMLInputElement>('input[aria-label="URL do registry"]')?.value,
    ).not.toBe('');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it('clears the inputs only when Main says what it saved', async () => {
  api({
    registry: vi.fn().mockResolvedValue(
      status({
        registrySaved: '@acme',
        registries: [
          {
            namespace: '@acme',
            url: 'https://registry.acme.test/r/{name}.json',
            requiresToken: true,
            tokenStored: true,
          },
        ],
      }),
    ),
  });
  const { host, root } = await mount();
  try {
    await fillRegistryAndSave(host);

    expect(
      host.querySelector<HTMLInputElement>('input[aria-label="Token do registry"]')?.value,
    ).toBe('');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it('says the free half needs no key before it mentions a licence', async () => {
  api();
  const { host, root } = await mount();
  try {
    expect(host.textContent).toContain('shadcn/ui');
    expect(host.textContent).toContain('sem chave');
    // The counts are what tell the operator the feature is not gated.
    expect(host.textContent).toContain('45 itens funcionam sem chave nenhuma');
    expect(host.textContent).toContain('precisam da sua licença');
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

    expect(host.textContent).toContain('Precisa da licença do BoardUI para: charts');
    expect(host.textContent).toContain('guarde a chave acima');
  } finally {
    act(() => root.unmount());
  }
});

it('diz que a licença não pôde ser conferida, em vez de pedir a chave de novo', async () => {
  // O caso do fornecedor fora do ar: a chave pode estar guardada e certa, e
  // mandar "guarde a chave" manda a pessoa mexer no que não está quebrado.
  api({
    install: vi.fn().mockResolvedValue({
      ok: false,
      installed: [],
      needsLicense: ['template-home-dashboard'],
      licenseState: 'unknown',
    }),
  });
  const { host, root } = await mount();
  try {
    const install = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Instalar em'),
    );
    await act(async () => install!.click());

    expect(host.textContent).toContain('não deu para confirmar a chave');
    expect(host.textContent).not.toContain('guarde a chave acima');
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

it('says why a registry would not go away', async () => {
  // The Main keeps the row when the vault refuses to clear the token. The
  // panel used to only repaint the list, so the row simply stayed there with
  // nothing to explain it.
  const configured = [
    {
      namespace: '@acme',
      url: 'https://registry.acme.test/r/{name}.json',
      requiresToken: true,
      tokenStored: true,
    },
  ];
  api({
    // Configured on MOUNT, so the row — and its "Remover" — is on screen.
    status: vi.fn().mockResolvedValue(status({ registries: configured })),
    registry: vi
      .fn()
      .mockResolvedValue(status({ registries: configured, registryError: 'cofre trancado' })),
  });
  const { host, root } = await mount();
  try {
    const remove = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Remover',
    );
    expect(remove).toBeDefined();
    await act(async () => remove!.click());

    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/cofre trancado/);
  } finally {
    act(() => root.unmount());
  }
});

function pick(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    'value',
  )?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

it('submits a non-Bearer contract for a registry that needs one', async () => {
  // A private registry on `X-API-Key` (or a raw value, or a query parameter)
  // could not be configured from Settings at all: the form sent namespace,
  // URL and token only, Main derived `Authorization: Bearer`, and the registry
  // answered 401 forever with no UI able to say otherwise.
  const api_ = api({ registry: vi.fn().mockResolvedValue(status({ registrySaved: '@acme' })) });
  const { host, root } = await mount();
  try {
    await act(async () =>
      typeInto(
        host.querySelector<HTMLInputElement>('input[aria-label="Namespace do registry"]')!,
        '@acme',
      ),
    );
    await act(async () =>
      typeInto(
        host.querySelector<HTMLInputElement>('input[aria-label="URL do registry"]')!,
        'https://registry.acme.test/r/{name}.json',
      ),
    );
    await act(async () =>
      typeInto(
        host.querySelector<HTMLInputElement>(
          'input[aria-label="Nome do cabeçalho ou parâmetro"]',
        )!,
        'X-API-Key',
      ),
    );
    await act(async () =>
      pick(
        host.querySelector<HTMLSelectElement>('select[aria-label="Prefixo do cabeçalho"]')!,
        'raw',
      ),
    );
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Adicionar')!
        .click(),
    );

    expect(api_.registry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'set',
        registry: expect.objectContaining({
          namespace: '@acme',
          auth: { kind: 'header', name: 'X-API-Key', scheme: 'raw' },
        }),
      }),
    );
  } finally {
    act(() => root.unmount());
  }
});

it('sends no contract at all when the operator names none', async () => {
  const api_ = api({ registry: vi.fn().mockResolvedValue(status({ registrySaved: '@acme' })) });
  const { host, root } = await mount();
  try {
    await act(async () =>
      typeInto(
        host.querySelector<HTMLInputElement>('input[aria-label="Namespace do registry"]')!,
        '@acme',
      ),
    );
    await act(async () =>
      typeInto(
        host.querySelector<HTMLInputElement>('input[aria-label="URL do registry"]')!,
        'https://registry.acme.test/r/{name}.json',
      ),
    );
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Adicionar')!
        .click(),
    );

    const call = api_.registry.mock.calls[0]?.[0] as { registry?: { auth?: unknown } };
    expect(call.registry?.auth).toBeUndefined();
  } finally {
    act(() => root.unmount());
  }
});
