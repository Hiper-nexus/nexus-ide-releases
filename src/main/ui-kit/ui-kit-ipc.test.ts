// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UI_KIT_CHANNELS } from '../../shared/ui-kit-contract';
import type { UiKitRegistry } from './ui-kit-registry';

/**
 * The REGISTRY handler itself, not the decisions it delegates.
 *
 * This file carried a comment saying it could not load under test because
 * `handleTrusted` pulls in electron. `settings-store.test.ts` disproves that —
 * the trusted-IPC seam mocks like any other — and the gap mattered: three
 * review rounds in a row found the handler ignoring an answer its pure helpers
 * were already giving (a refused vault delete, a dropped settings write, a
 * token written before a persistence failure). Those are wiring defects, and
 * only the handler can show them.
 *
 * The workspace root is mocked EMPTY on purpose: with no cwd, `buildStatus`
 * takes the vault-only branch and never reaches the BoardUI licence file, so
 * this suite cannot touch the real `license.json` of whoever runs it.
 */
const handlers = vi.hoisted(
  () => new Map<string, (...args: readonly any[]) => any>(),
);
const vault = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  refuseWrites: false,
  writes: [] as { key: string; value: string }[],
}));
const store = vi.hoisted(() => ({ registries: [] as unknown[], refuseWrite: false }));

vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (channel: string, handler: (...args: readonly any[]) => any) => {
    handlers.set(channel, handler);
  },
}));
vi.mock('../orch/workspace-path', () => ({ activeWorkspaceRoot: () => '' }));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: () => ({ uiKitRegistries: store.registries }),
  replaceOrchSettings: (patch: { uiKitRegistries?: unknown[] }) => {
    // The real one answers the PREVIOUS settings when the merged object fails
    // the schema, and throws nothing.
    if (!store.refuseWrite && patch.uiKitRegistries) {
      store.registries = patch.uiKitRegistries;
    }
    return { uiKitRegistries: store.registries };
  },
}));
const fakeVault = {
  getSecret: (key: string) => vault.entries.get(key) ?? null,
  setSecret: (key: string, value: string) => {
    vault.writes.push({ key, value });
    if (vault.refuseWrites) return { ok: false, error: 'cofre trancado' };
    if (value.length === 0) vault.entries.delete(key);
    else vault.entries.set(key, value);
    return { ok: true };
  },
};

const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-ipc-'));
afterAll(() => {
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

const VENDOR: UiKitRegistry = {
  namespace: '@acme',
  url: 'https://registry.acme.test/r/{name}.json',
  auth: { kind: 'header', name: 'Authorization', envVar: 'ACME_REGISTRY_TOKEN' },
};
const TOKEN_KEY = 'external:ui-kit-registry-acme';

async function registryHandler() {
  const ipc = await import('./ui-kit-ipc');
  // The vault goes through the module's own seam: `secrets()` is a lazy
  // `require` (electron/safeStorage) that vitest cannot resolve, so `vi.mock`
  // never sees it.
  ipc.setUiKitVaultProvider(() => fakeVault);
  // The cache root uses the seam the boot uses; under tmp, never userData.
  (await import('./ui-kit-cache')).setUiKitCacheRootResolver(() => cacheRoot);
  ipc.registerUiKitIpc();
  return handlers.get(UI_KIT_CHANNELS.registry)!;
}

beforeEach(() => {
  vi.resetModules();
  handlers.clear();
  vault.entries.clear();
  vault.writes = [];
  vault.refuseWrites = false;
  store.registries = [{ ...VENDOR }];
  store.refuseWrite = false;
  vault.entries.set(TOKEN_KEY, 'tok-old');
});

describe('removing a registry', () => {
  it('drops the row once the vault cleared the token', async () => {
    const handle = await registryHandler();

    const view = await handle(null, { action: 'remove', namespace: '@acme' });

    expect(vault.entries.has(TOKEN_KEY)).toBe(false);
    expect(store.registries).toEqual([]);
    expect(view.registryError).toBeUndefined();
  });

  it('KEEPS the row and says why when the vault refused', async () => {
    vault.refuseWrites = true;
    const handle = await registryHandler();

    const view = await handle(null, { action: 'remove', namespace: '@acme' });

    expect(store.registries).toEqual([{ ...VENDOR }]);
    expect(vault.entries.get(TOKEN_KEY)).toBe('tok-old');
    expect(view.registryError).toMatch(/cofre/i);
  });
});

describe('saving a registry', () => {
  it('stores the token and issues the receipt', async () => {
    const handle = await registryHandler();

    const view = await handle(null, {
      action: 'set',
      registry: { namespace: '@acme', url: VENDOR.url },
      token: 'tok-new',
    });

    expect(view.registrySaved).toBe('@acme');
    expect(view.registryError).toBeUndefined();
    expect(vault.entries.get(TOKEN_KEY)).toBe('tok-new');
  });

  it('ROLLS THE TOKEN BACK when the settings write is dropped', async () => {
    // The dangerous shape: the namespace moves to another host with a fresh
    // token, the vault takes it, and the settings write then fails. The old
    // URL stays configured — with the NEW host's credential behind it — so the
    // next install would have sent that token to the old host.
    store.refuseWrite = true;
    const handle = await registryHandler();

    const view = await handle(null, {
      action: 'set',
      registry: { namespace: '@acme', url: 'https://elsewhere.test/r/{name}.json' },
      token: 'tok-elsewhere',
    });

    expect(view.registrySaved).toBeUndefined();
    expect(view.registryError).toBeTruthy();
    expect(store.registries).toEqual([{ ...VENDOR }]);
    expect(vault.entries.get(TOKEN_KEY)).toBe('tok-old');
  });

  it('never issues a receipt for a namespace that did not land', async () => {
    store.refuseWrite = true;
    const handle = await registryHandler();

    const view = await handle(null, {
      action: 'set',
      registry: { namespace: '@other', url: 'https://other.test/r/{name}.json' },
    });

    expect(view.registrySaved).toBeUndefined();
    expect(view.registryError).toBeTruthy();
  });
});
