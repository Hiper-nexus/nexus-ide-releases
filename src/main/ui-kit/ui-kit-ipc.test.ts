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
  /** Refuse from the Nth write on, to break a ROLLBACK and nothing else. */
  refuseWritesFrom: Number.POSITIVE_INFINITY,
  writes: [] as { key: string; value: string }[],
}));
const store = vi.hoisted(() => ({ registries: [] as unknown[], refuseWrite: false }));

vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (channel: string, handler: (...args: readonly any[]) => any) => {
    handlers.set(channel, handler);
  },
}));
const workspace = vi.hoisted(() => ({ root: '' }));
vi.mock('../orch/workspace-path', () => ({ activeWorkspaceRoot: () => workspace.root }));

/**
 * The licence FUNCTIONS are stubbed, the rest of the service stays real: with
 * a cwd set, `buildStatus` would otherwise reach the BoardUI licence file of
 * whoever runs this suite.
 */
const license = vi.hoisted(() => ({
  deactivate: vi.fn<
    () => Promise<{ ok: boolean; stored: boolean; detail?: string }>
  >(async () => ({ ok: true, stored: false })),
  status: vi.fn(async () => ({ state: 'active' as const, stored: true, masked: '••••9999' })),
}));
vi.mock('./ui-kit-service', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    deactivateBoardUiLicense: license.deactivate,
    boardUiLicenseStatus: license.status,
  };
});
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
    if (vault.refuseWrites || vault.writes.length >= vault.refuseWritesFrom) {
      return { ok: false, error: 'cofre trancado' };
    }
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
  vault.refuseWritesFrom = Number.POSITIVE_INFINITY;
  workspace.root = '';
  license.deactivate.mockReset();
  license.deactivate.mockResolvedValue({ ok: true, stored: false });
  license.status.mockReset();
  license.status.mockResolvedValue({ state: 'active', stored: true, masked: '••••9999' });
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

describe('the removal does not destroy the token it could not remove', () => {
  it('puts the token back when the settings write is dropped', async () => {
    // The vault is cleared FIRST, so a list write that does not land used to
    // leave the row on screen with its credential already gone — every later
    // install failed until the operator typed it again.
    store.refuseWrite = true;
    const handle = await registryHandler();

    const view = await handle(null, { action: 'remove', namespace: '@acme' });

    expect(view.registryError).toBeTruthy();
    expect(store.registries).toEqual([{ ...VENDOR }]);
    expect(vault.entries.get(TOKEN_KEY)).toBe('tok-old');
  });
});

describe('the caller cannot smuggle an auth contract past the gate', () => {
  it('saves NO contract when the gate refused one', async () => {
    // `{...input}` carried the caller's own `auth` through, so sending one
    // rebuilt exactly the contract the host/preset gate had just refused —
    // and the contract is what releases the vaulted token.
    const handle = await registryHandler();

    const view = await handle(null, {
      action: 'set',
      registry: {
        namespace: '@acme',
        url: 'https://elsewhere.test/r/{name}.json',
        auth: { kind: 'header', name: 'Authorization' },
      },
    });

    expect(view.registrySaved).toBe('@acme');
    const saved = store.registries[0] as { namespace: string; auth?: unknown };
    expect(saved.namespace).toBe('@acme');
    expect(saved.auth).toBeUndefined();
  });

  it('keeps the SHAPE the panel stated when the gate allows a contract', async () => {
    const handle = await registryHandler();

    await handle(null, {
      action: 'set',
      registry: {
        namespace: '@acme',
        url: 'https://registry.acme.test/r/{name}.json',
        auth: { kind: 'header', name: 'X-API-Key', scheme: 'raw' },
      },
      token: 'tok-api-key',
    });

    const saved = store.registries[0] as {
      auth?: { kind: string; name: string; scheme?: string; envVar: string };
    };
    expect(saved.auth?.name).toBe('X-API-Key');
    expect(saved.auth?.scheme).toBe('raw');
    // The VARIABLE stays derived in Main: it selects a credential.
    expect(saved.auth?.envVar).toBe('ACME_REGISTRY_TOKEN');
  });
});

describe('a licence key is validated before it reaches the vault', () => {
  it('refuses a malformed key with no project open, and stores nothing', async () => {
    const ipc = await import('./ui-kit-ipc');
    ipc.setUiKitVaultProvider(() => fakeVault);
    ipc.registerUiKitIpc();
    const handle = handlers.get(UI_KIT_CHANNELS.license)!;

    const view = await handle(null, { action: 'set', key: 'suk live key' });

    expect(view.stored).toBe(false);
    expect(view.detail).toMatch(/whitespace|espaço|branco/i);
    expect([...vault.entries.keys()].some((key) => key.includes('license'))).toBe(false);
  });

  it('stores a well-formed key with no project open', async () => {
    const ipc = await import('./ui-kit-ipc');
    ipc.setUiKitVaultProvider(() => fakeVault);
    ipc.registerUiKitIpc();
    const handle = handlers.get(UI_KIT_CHANNELS.license)!;

    const view = await handle(null, { action: 'set', key: '  suk-well-formed-key  ' });

    expect(view.stored).toBe(true);
    expect([...vault.entries.values()]).toContain('suk-well-formed-key');
  });
});

describe('a rollback that is itself refused is said out loud', () => {
  it('clears the key when the previous value cannot go back', async () => {
    // The dangerous state: the vault holds the NEW host's token while the
    // settings still name the OLD url, so the next install would send that
    // credential to the old host. With no way to put the old value back, no
    // credential at all is the only fail-closed outcome left.
    store.refuseWrite = true;
    vault.refuseWritesFrom = 2; // the token write lands; the rollback does not
    const handle = await registryHandler();

    const view = await handle(null, {
      action: 'set',
      registry: { namespace: '@acme', url: 'https://elsewhere.test/r/{name}.json' },
      token: 'tok-elsewhere',
    });

    expect(view.registrySaved).toBeUndefined();
    expect(view.registryError).toMatch(/apagada|não corresponde/);
    // Both the restore AND the clear were attempted.
    expect(vault.writes.filter((write) => write.key === TOKEN_KEY)).toHaveLength(3);
  });
});

describe('a licence removal that failed is not reported as removed', () => {
  async function licenseHandler() {
    const ipc = await import('./ui-kit-ipc');
    ipc.setUiKitVaultProvider(() => fakeVault);
    (await import('./ui-kit-cache')).setUiKitCacheRootResolver(() => cacheRoot);
    ipc.registerUiKitIpc();
    return handlers.get(UI_KIT_CHANNELS.license)!;
  }

  it('answers the vendor/file reason instead of manufacturing "absent"', async () => {
    // The vendor's deactivation can fail and a provisioned licence file can
    // refuse to go. Reporting `absent` told the operator the paid seat had
    // been released when it had not.
    workspace.root = '/tmp/nexus-ui-kit-ipc-project';
    license.deactivate.mockResolvedValue({
      ok: false,
      stored: true,
      detail: 'o fornecedor recusou a desativação',
    });
    const handle = await licenseHandler();

    const view = await handle(null, { action: 'remove' });

    expect(view.state).not.toBe('absent');
    expect(view.detail).toMatch(/recusou a desativação/);
  });

  it('reports absent when the removal did go through', async () => {
    workspace.root = '/tmp/nexus-ui-kit-ipc-project';
    const handle = await licenseHandler();

    const view = await handle(null, { action: 'remove' });

    expect(view.state).toBe('absent');
    expect(view.stored).toBe(false);
  });
});
