import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UiKitCliError, type UiKitCliRunRequest } from './ui-kit-cli';
import { BOARDUI_LICENSE_SECRET } from './boardui-source';
import { readCachedItem, writeCachedItem } from './ui-kit-cache';
import type { UiKitRegistry } from './ui-kit-registry';
import { OPERATOR_BOARDUI_LICENSE_KEY, operatorBoardUiLicenseFile } from './ui-kit-operator-keys';
import type { BoardUiLicenseFile } from './boardui-license-file';
import {
  activateBoardUiLicense,
  activateEffectiveBoardUiLicense,
  provisionBundledBoardUiLicense,
  invalidateBoardUiFreeList,
  parseBoardUiListOutput,
  parseShadcnSearch,
  parseShadcnSearchJson,
  planInstallItems,
  readsAsActiveLicense,
  listBoardUiFreeSlugs,
  resetBoardUiFreeListCacheForTests,
  resolveBoardUiTier,
  runBoardUiCommand,
  ensureProjectRegistries,
  readComponentsJson,
  boardUiCandidates,
  boardUiLicenseStatus,
  callBoardUiTool,
  deactivateBoardUiLicense,
  downloadItemsIntoCache,
  installItems,
  parseShadcnSearchOutput,
  readItemSource,
  runShadcnCommand,
  shadcnSearchNamespaces,
  type UiKitServiceDeps,
} from './ui-kit-service';

// The one knob the "no bundled key at all" scenario needs: the constants stay
// real, only the presence flag is flippable per test.
const operatorBundle = { hasKey: true };
vi.mock('./ui-kit-operator-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ui-kit-operator-keys')>();
  return {
    ...actual,
    hasOperatorBoardUiLicenseKey: () => operatorBundle.hasKey,
  };
});

let dir = '';
let cwd = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-ui-kit-svc-'));
  cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetBoardUiFreeListCacheForTests();
  operatorBundle.hasKey = true;
});

/**
 * The licence file every test runs against. The REAL config root holds the
 * operator's own licence on this very Mac — without this fake, a licence
 * test would read (or worse, delete) `~/.config/boardui/license.json`.
 */
interface LicenseFileFake {
  content: BoardUiLicenseFile | null;
  writes: BoardUiLicenseFile[];
  removed: boolean;
}

interface Harness {
  readonly deps: UiKitServiceDeps;
  readonly cliRuns: UiKitCliRunRequest[];
  readonly mcpCalls: Array<{ tool?: string; args?: Record<string, unknown>; writes?: boolean }>;
  readonly vault: Map<string, string>;
  readonly licenseFile: LicenseFileFake;
}

function harness(
  over: {
    cli?: (request: UiKitCliRunRequest) => { stdout?: string; stderr?: string; code?: number };
    mcp?: (
      tool: string | undefined,
      ctx: {
        readonly licenseFile: BoardUiLicenseFile | null;
        readonly vault: Map<string, string>;
      },
    ) => { text: string; isError?: boolean } | Error;
    registries?: readonly UiKitRegistry[];
    vaultWritable?: boolean;
    licenseFile?: {
      content?: BoardUiLicenseFile | null;
      unreadable?: boolean;
      corrupted?: boolean;
      failWrite?: boolean;
      failRemove?: boolean;
    };
  } = {},
): Harness {
  const cliRuns: UiKitCliRunRequest[] = [];
  const mcpCalls: Array<{ tool?: string; args?: Record<string, unknown>; writes?: boolean }> = [];
  const store = new Map<string, string>();
  const licenseFile: LicenseFileFake = {
    content: over.licenseFile?.content ?? null,
    writes: [],
    removed: false,
  };
  const deps: UiKitServiceDeps = {
    runCli: async (request) => {
      cliRuns.push(request);
      const result = over.cli?.(request) ?? {};
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.code ?? 0 };
    },
    callMcp: async (request) => {
      mcpCalls.push({
        ...(request.tool !== undefined ? { tool: request.tool } : {}),
        ...(request.toolArguments ? { args: request.toolArguments as Record<string, unknown> } : {}),
        ...(request.writes !== undefined ? { writes: request.writes } : {}),
      });
      const outcome =
        over.mcp?.(request.tool, { licenseFile: licenseFile.content, vault: store }) ??
        { text: 'ok' };
      if (outcome instanceof Error) throw outcome;
      return { result: {}, text: outcome.text, isError: outcome.isError === true };
    },
    getSecret: (key) => store.get(key) ?? null,
    setSecret: (key, value) => {
      if (over.vaultWritable === false) return { ok: false, error: 'keychain locked' };
      if (value === '') store.delete(key);
      else store.set(key, value);
      return { ok: true };
    },
    registries: () => over.registries ?? [],
    cacheOptions: { rootDir: dir },
    boardUiLicenseFile: {
      // The tagged shape the real ops return: absent / unreadable / parsed
      // (parsed with file null = corrupted, healable by re-provisioning).
      read: () =>
        over.licenseFile?.unreadable
          ? { status: 'unreadable' }
          : licenseFile.content
            ? { status: 'parsed', file: licenseFile.content }
            : over.licenseFile?.corrupted && licenseFile.writes.length === 0
              ? { status: 'parsed', file: null }
              : { status: 'absent' },
      write: (payload) => {
        if (over.licenseFile?.failWrite) {
          return { ok: false, error: 'EACCES: the licence file could not be written' };
        }
        licenseFile.writes.push(payload);
        licenseFile.content = payload;
        return { ok: true };
      },
      remove: () => {
        if (over.licenseFile?.failRemove) {
          return { ok: false, error: 'EPERM: the licence file could not be removed' };
        }
        licenseFile.removed = true;
        licenseFile.content = null;
        return { ok: true };
      },
    },
  };
  return { deps, cliRuns, mcpCalls, vault: store, licenseFile };
}

function writeComponentsJson(value: Record<string, unknown>): void {
  fs.writeFileSync(path.join(cwd, 'components.json'), JSON.stringify(value, null, 2));
}

/** Read one namespace's entry, with "no file at all" as a visible failure. */
function declaredRegistry(namespace: string): unknown {
  const written = readComponentsJson(cwd);
  expect(written).not.toBeNull();
  const registries = written?.registries;
  expect(registries).toBeTypeOf('object');
  return (registries as Record<string, unknown>)[namespace];
}

const PRIVATE_REGISTRY: UiKitRegistry = {
  namespace: '@acme',
  url: 'https://registry.acme.test/r/{name}.json',
  auth: { kind: 'header', name: 'Authorization', envVar: 'ACME_REGISTRY_TOKEN' },
  secretKey: 'external:ui-kit-registry-acme',
};

/**
 * A licence the VENDOR issued: another key and another instanceId, not the
 * operator's provisioned payload. This is what sends "Remover" to the vendor
 * for real — and what the pre-check must protect from being overwritten.
 */
const NATIVE_LICENSE: BoardUiLicenseFile = {
  licenseKey: 'BUI-CLIENT-OWN',
  instanceId: 'server-issued-instance',
  instanceName: 'boardui-cli@client.local',
};

describe('runShadcnCommand', () => {
  it('runs the built argv in the project and marks a write', async () => {
    const h = harness();

    const result = await runShadcnCommand(
      { command: { kind: 'add', items: ['button'] }, cwd },
      h.deps,
    );

    expect(result.ok).toBe(true);
    expect(h.cliRuns[0]?.args).toEqual(['add', '--yes', 'button']);
    expect(h.cliRuns[0]?.writes).toBe(true);
    expect(h.cliRuns[0]?.cwd).toBe(cwd);
  });

  it('resolves the package outside the project and points the CLI back at it', async () => {
    // With the project as cwd, npm reads its `.npmrc` and npx prefers its
    // node_modules/.bin — the repository would choose the code that runs.
    const h = harness();

    await runShadcnCommand({ command: { kind: 'add', items: ['button'] }, cwd }, h.deps);

    expect(h.cliRuns[0]?.resolveIn).toBe('isolated');
    expect(h.cliRuns[0]?.cwdFlag).toBe(true);
    // The project stays the authorized target, so the node_modules guard still
    // applies to it.
    expect(h.cliRuns[0]?.cwd).toBe(cwd);
  });

  it('does not ask for --cwd on the commands that have no such flag', async () => {
    const h = harness();

    await runShadcnCommand({ command: { kind: 'preset-decode', code: 'a2r6bw' }, cwd }, h.deps);
    await runShadcnCommand({ command: { kind: 'preset-url', code: 'a2r6bw' }, cwd }, h.deps);

    expect(h.cliRuns.map((run) => run.cwdFlag)).toEqual([false, false]);
  });

  it('keeps BoardUI resolving in the project, which is the documented limit', async () => {
    // BoardUI has no --cwd; its -d/--dir is the SOURCE root, and aiming it
    // wrong would write components somewhere silently wrong.
    const h = harness();

    await installItems({ kit: 'boardui', items: ['button'], cwd }, h.deps);

    expect(h.cliRuns[0]?.resolveIn).toBeUndefined();
  });

  it('refuses a destination that leaves the project through a REAL symlink', async () => {
    // The whole attack: an untrusted repository ships `components -> <outside>`
    // and the agent passes `--path components`. No `..`, nothing absolute,
    // nothing option-shaped — and the write lands outside the project.
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(cwd, 'components'));
    const h = harness();

    await expect(
      runShadcnCommand(
        { command: { kind: 'add', items: ['button'], path: 'components/ui' }, cwd },
        h.deps,
      ),
    ).rejects.toThrow(/leaves the project through a link/);
    // And nothing ran: the refusal happens before the spawn.
    expect(h.cliRuns).toHaveLength(0);
  });

  it('allows a real directory inside the project', async () => {
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    const h = harness();

    const result = await runShadcnCommand(
      { command: { kind: 'add', items: ['button'], path: 'src/ui' }, cwd },
      h.deps,
    );

    expect(result.ok).toBe(true);
    expect(h.cliRuns[0]?.args).toContain('src/ui');
  });

  it('checks a local registry item as the path it is', async () => {
    const outside = path.join(dir, 'elsewhere');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(cwd, 'registry'));
    const h = harness();

    await expect(
      runShadcnCommand(
        { command: { kind: 'add', items: ['registry/button.json'] }, cwd },
        h.deps,
      ),
    ).rejects.toThrow(/leaves the project through a link/);
  });

  it('refuses a BoardUI --dir behind a symlink too', async () => {
    const outside = path.join(dir, 'boardui-outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(cwd, 'ui'));
    const h = harness();

    await expect(
      installItems({ kit: 'boardui', items: ['button'], cwd, path: 'ui' }, h.deps),
    ).rejects.toThrow(/leaves the project through a link/);
  });

  it('marks a query as non-writing', async () => {
    const h = harness();

    await runShadcnCommand({ command: { kind: 'search', registries: ['@shadcn'] }, cwd }, h.deps);

    expect(h.cliRuns[0]?.writes).toBe(false);
  });

  it('carries a registry token only for a namespace the command names', async () => {
    const h = harness({ registries: [PRIVATE_REGISTRY] });
    h.vault.set('external:ui-kit-registry-acme', 'tok-abc');
    writeComponentsJson({ registries: { '@acme': PRIVATE_REGISTRY.url } });

    const result = await runShadcnCommand(
      { command: { kind: 'add', items: ['@acme/auth'] }, cwd },
      h.deps,
    );

    expect(h.cliRuns[0]?.extraEnv).toEqual({ ACME_REGISTRY_TOKEN: 'tok-abc' });
    expect(result.missingRegistryKeys).toEqual([]);
  });

  it('releases NO token when the run does not touch that registry', async () => {
    // `add button` is a public component: a private registry's credential has
    // no business travelling into the npm child for it.
    const h = harness({ registries: [PRIVATE_REGISTRY] });
    h.vault.set('external:ui-kit-registry-acme', 'tok-abc');
    writeComponentsJson({ registries: { '@acme': PRIVATE_REGISTRY.url } });

    await runShadcnCommand({ command: { kind: 'add', items: ['button'] }, cwd }, h.deps);

    expect(h.cliRuns[0]?.extraEnv).toBeUndefined();
  });

  it('withholds the token when the project points the namespace elsewhere', async () => {
    const h = harness({ registries: [PRIVATE_REGISTRY] });
    h.vault.set('external:ui-kit-registry-acme', 'tok-abc');
    writeComponentsJson({ registries: { '@acme': 'https://evil.test/{name}.json' } });

    const result = await runShadcnCommand(
      { command: { kind: 'add', items: ['@acme/auth'] }, cwd },
      h.deps,
    );

    expect(h.cliRuns[0]?.extraEnv).toBeUndefined();
    expect(result.registryConflicts).toEqual(['@acme']);
  });

  it('names the registry whose key is missing instead of failing blind', async () => {
    const h = harness({ registries: [PRIVATE_REGISTRY] });
    writeComponentsJson({ registries: { '@acme': PRIVATE_REGISTRY.url } });

    const result = await runShadcnCommand(
      { command: { kind: 'add', items: ['@acme/auth'] }, cwd },
      h.deps,
    );

    expect(result.missingRegistryKeys).toEqual(['@acme']);
    expect(h.cliRuns[0]?.extraEnv).toBeUndefined();
  });

  it('declares our namespace in components.json so the token has a legitimate home', async () => {
    const h = harness({ registries: [PRIVATE_REGISTRY] });
    h.vault.set('external:ui-kit-registry-acme', 'tok-abc');
    writeComponentsJson({ style: 'new-york' });

    await runShadcnCommand({ command: { kind: 'add', items: ['@acme/auth'] }, cwd }, h.deps);

    expect(declaredRegistry('@acme')).toMatchObject({ url: PRIVATE_REGISTRY.url });
    expect(h.cliRuns[0]?.extraEnv).toEqual({ ACME_REGISTRY_TOKEN: 'tok-abc' });
  });

  it('a search never writes the project config', async () => {
    // The catalog tool is classified read-only; declaring a namespace writes
    // components.json, so it may only happen on a command that already
    // changes the project.
    const h = harness({ registries: [PRIVATE_REGISTRY] });
    h.vault.set('external:ui-kit-registry-acme', 'tok-abc');

    await runShadcnCommand(
      { command: { kind: 'search', registries: ['@shadcn', '@acme'] }, cwd },
      h.deps,
    );

    expect(fs.existsSync(path.join(cwd, 'components.json'))).toBe(false);
  });

  it('a view never writes the project config either', async () => {
    const h = harness({ registries: [PRIVATE_REGISTRY] });

    await runShadcnCommand({ command: { kind: 'view', items: ['@acme/auth'] }, cwd }, h.deps);

    expect(fs.existsSync(path.join(cwd, 'components.json'))).toBe(false);
  });

  it('leaves components.json untouched when the COMMAND is rejected', async () => {
    // Validation of argv and of every destination happens before the registry
    // mapping is written: config changed by a run that never executed is the
    // worst outcome.
    writeComponentsJson({ style: 'new-york' });
    const before = fs.readFileSync(path.join(cwd, 'components.json'), 'utf8');
    const h = harness({ registries: [PRIVATE_REGISTRY] });

    await expect(
      runShadcnCommand(
        { command: { kind: 'add', items: ['@acme/auth', '--bad'] }, cwd },
        h.deps,
      ),
    ).rejects.toThrow();

    expect(fs.readFileSync(path.join(cwd, 'components.json'), 'utf8')).toBe(before);
    expect(h.cliRuns).toHaveLength(0);
  });

  it('reports a non-zero exit as not ok', async () => {
    const h = harness({ cli: () => ({ code: 1, stderr: 'boom' }) });

    const result = await runShadcnCommand({ command: { kind: 'info' }, cwd }, h.deps);

    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('boom');
  });
});

describe('where the BoardUI CLI is resolved from', () => {
  it('resolves `list` OUTSIDE the project, so browsing cannot run repo code', async () => {
    // BoardUI has no `--cwd`, so a command that needs the project must be
    // spawned in it — and there npm reads the repository's `.npmrc` and npx
    // prefers its `node_modules/.bin`. `list` needs no project (measured: it
    // prints the vendor's catalogue from an empty directory), and it is what
    // the catalogue browse path and the tier gate call.
    const h = harness({ cli: () => ({ stdout: '  button  Primary button.\n' }) });

    await listBoardUiFreeSlugs(cwd, h.deps);

    expect(h.cliRuns[0]?.args).toEqual(['list']);
    expect(h.cliRuns[0]?.resolveIn).toBe('isolated');
    // No `--cwd` to append: the vendor CLI has none.
    expect(h.cliRuns[0]?.cwdFlag).toBeUndefined();
  });

  it('keeps `add` and `init` in the project, where they must write', async () => {
    const h = harness();

    await installItems({ kit: 'boardui', items: ['button'], cwd }, h.deps);
    await runBoardUiCommand({ command: { kind: 'init' }, cwd }, h.deps);

    for (const run of h.cliRuns.filter((entry) => entry.args[0] !== 'list')) {
      expect(run.resolveIn).toBeUndefined();
      expect(run.cwd).toBe(cwd);
    }
  });
});

describe('the cached free list is a function of the licence', () => {
  // A slug the vendor-read snapshot does not list: only those are resolved
  // against the live listing (the snapshot answers for everything it holds).
  const FREE_ONLY = '  button    Primary button.\n';
  const WITH_PRO = `${FREE_ONLY}  shipped-next-month  Pro template.\n`;

  it('forgets the unlicensed listing when a licence is activated', async () => {
    // Without this, activating a key left the Pro items undiscoverable for up
    // to the TTL: every lookup kept answering from the free-only listing.
    let listing = FREE_ONLY;
    const h = harness({
      cli: () => ({ stdout: listing }),
      mcp: () => ({ text: 'license activated' }),
    });

    expect(await resolveBoardUiTier('shipped-next-month', cwd, h.deps)).toBe('pro');
    listing = WITH_PRO;
    await activateBoardUiLicense({ key: 'BUI-TEST-KEY-0001', cwd }, h.deps);

    expect(await resolveBoardUiTier('shipped-next-month', cwd, h.deps)).toBe('free');
  });

  it('forgets the licensed listing when the licence is removed', async () => {
    // The dangerous direction: with a key active the vendor publishes the Pro
    // items in the SAME list, so a stale licensed listing answered "free" for
    // a Pro slug — the gate letting it through after the key was gone.
    let listing = WITH_PRO;
    const h = harness({
      cli: () => ({ stdout: listing }),
      mcp: () => ({ text: 'license released' }),
    });

    expect(await resolveBoardUiTier('shipped-next-month', cwd, h.deps)).toBe('free');
    listing = FREE_ONLY;
    await deactivateBoardUiLicense({ cwd }, h.deps);

    expect(await resolveBoardUiTier('shipped-next-month', cwd, h.deps)).toBe('pro');
  });
});

describe('every door that changes the licence forgets the listing', () => {
  const FREE_ONLY = '  button    Primary button.\n';
  const WITH_PRO = `${FREE_ONLY}  shipped-next-month  Pro template.\n`;

  it('invalidates on the AGENT activation path, not only the service wrapper', async () => {
    // `nexus_ui_kit_boardui { tool: 'activate_license' }` reaches
    // `callBoardUiTool` directly, so the invalidation added to
    // `activateBoardUiLicense` missed it and the free listing stayed
    // authoritative for the whole TTL after a key was added.
    let listing = FREE_ONLY;
    const h = harness({
      cli: () => ({ stdout: listing }),
      mcp: () => ({ text: 'license activated' }),
    });

    // The tool refuses without a stored key, so the vault carries one.
    h.vault.set(BOARDUI_LICENSE_SECRET, 'BUI-TEST-KEY-0001');

    expect(await resolveBoardUiTier('shipped-next-month', cwd, h.deps)).toBe('pro');
    listing = WITH_PRO;
    await callBoardUiTool({ tool: 'activate_license', cwd }, h.deps);

    expect(await resolveBoardUiTier('shipped-next-month', cwd, h.deps)).toBe('free');
  });

  it('discards a listing that STARTED before the licence changed', async () => {
    // Clearing the map only stopped new callers joining the old request; its
    // own closure still finished and repopulated the cache with the
    // pre-change answer.
    // A property, not a `let`: TypeScript narrows a local assigned only inside
    // a callback it cannot see down to `null`.
    const gate: { release?: (stdout: string) => void } = {};
    const pending = new Promise<string>((resolve) => {
      gate.release = resolve;
    });
    const h = harness();
    const slow: UiKitServiceDeps = {
      ...h.deps,
      runCli: async () => ({ stdout: await pending, stderr: '', code: 0 }),
    };

    // A listing goes out while the licence is still active…
    const inFlight = listBoardUiFreeSlugs(cwd, slow);
    invalidateBoardUiFreeList();
    gate.release?.(WITH_PRO);
    // …the caller still gets the answer it asked for,
    expect((await inFlight)?.has('shipped-next-month')).toBe(true);
    // but it must not have been cached across the change.
    const after = harness({ cli: () => ({ stdout: FREE_ONLY }) });
    expect(await resolveBoardUiTier('shipped-next-month', cwd, after.deps)).toBe('pro');
  });
});

describe('planInstallItems', () => {
  it('runs the Pro gate and NEVER the install', async () => {
    // `dryRun` beside named items used to reach `installItems`, so an explicit
    // "show me" modified the project and could pull dependencies.
    const h = harness({
      cli: () => ({ stdout: '  button    Primary button.\n' }),
      mcp: () => ({ text: 'license: inactive' }),
    });

    const plan = await planInstallItems(
      { kit: 'boardui', items: ['button', 'template-home-dashboard'], cwd },
      h.deps,
    );

    expect(plan.install).toEqual(['button']);
    expect(plan.needsLicense).toEqual(['template-home-dashboard']);
    expect(h.cliRuns.map((run) => run.args[0])).not.toContain('add');
    expect(h.cliRuns.every((run) => run.writes !== true)).toBe(true);
  });

  it('asks nothing at all for shadcn, which has no licence', async () => {
    const h = harness();

    const plan = await planInstallItems(
      { kit: 'shadcn', items: ['button', 'card'], cwd },
      h.deps,
    );

    expect(plan).toEqual({ install: ['button', 'card'], needsLicense: [] });
    expect(h.cliRuns).toHaveLength(0);
    expect(h.mcpCalls).toHaveLength(0);
  });
});

describe('installItems', () => {
  it('sends shadcn items to the shadcn CLI', async () => {
    writeComponentsJson({ aliases: { ui: '@/components/ui' } });
    const h = harness();

    await installItems({ kit: 'shadcn', items: ['button'], cwd, path: 'src/ui' }, h.deps);

    expect(h.cliRuns[0]?.kit).toBe('shadcn');
    expect(h.cliRuns[0]?.args).toEqual(['add', '--yes', 'button', '--path', 'src/ui']);
  });

  it('refuses a shadcn add at once when the project has no components.json', async () => {
    // shadcn stops at "You need to create a components.json file… Proceed?",
    // which ignores --yes: the run used to sit there until the 300 s timeout.
    const h = harness();
    const started = Date.now();

    const result = await installItems({ kit: 'shadcn', items: ['button'], cwd }, h.deps);

    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('components_json_missing');
    expect(result.hint).toMatch(/command: 'init'/);
    expect(h.cliRuns).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('warns before a BoardUI install on Tailwind v3, without refusing it', async () => {
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18.3.0' }, devDependencies: { tailwindcss: '^3.4.1' } }),
    );
    const h = harness();

    const result = await installItems({ kit: 'boardui', items: ['button'], cwd }, h.deps);

    expect(result.warning).toMatch(/Tailwind v3/);
    expect(h.cliRuns[0]?.kit).toBe('boardui');
  });

  it('sends BoardUI items to the BoardUI CLI', async () => {
    const h = harness();

    await installItems({ kit: 'boardui', items: ['date-picker'], cwd }, h.deps);

    expect(h.cliRuns[0]?.kit).toBe('boardui');
    expect(h.cliRuns[0]?.args).toEqual(['add', 'date-picker', '--yes']);
    expect(h.cliRuns[0]?.writes).toBe(true);
  });
});

describe('callBoardUiTool', () => {
  it('calls a published tool and flags whether it writes', async () => {
    const h = harness({ mcp: () => ({ text: 'listed' }) });

    const result = await callBoardUiTool({ tool: 'list_components', cwd }, h.deps);

    expect(result.text).toBe('listed');
    expect(h.mcpCalls[0]).toMatchObject({ tool: 'list_components', writes: false });
  });

  it('marks an installing tool as a write', async () => {
    const h = harness();

    await callBoardUiTool({ tool: 'install_components', args: { components: ['button'] }, cwd }, h.deps);

    expect(h.mcpCalls[0]?.writes).toBe(true);
  });

  it('refuses a tool BoardUI does not publish', async () => {
    const h = harness();

    await expect(callBoardUiTool({ tool: 'exec_shell', cwd }, h.deps)).rejects.toThrow(
      /unknown BoardUI tool/,
    );
    expect(h.mcpCalls).toHaveLength(0);
  });
});

describe('the BoardUI licence', () => {
  it('stores the key then activates it, and never puts it in a result', async () => {
    const h = harness({ mcp: () => ({ text: 'License activated' }) });

    const result = await activateBoardUiLicense({ key: 'BUI-SECRET-1234', cwd }, h.deps);

    expect(result.ok).toBe(true);
    expect(result.stored).toBe(true);
    expect(h.vault.get(BOARDUI_LICENSE_SECRET)).toBe('BUI-SECRET-1234');
    expect(h.mcpCalls[0]?.args).toEqual({ licenseKey: 'BUI-SECRET-1234' });
    expect(JSON.stringify(result)).not.toContain('BUI-SECRET-1234');
  });

  it('does not claim a store when the vault refused', async () => {
    const h = harness({ vaultWritable: false });

    const result = await activateBoardUiLicense({ key: 'BUI-1', cwd }, h.deps);

    expect(result.ok).toBe(false);
    expect(result.stored).toBe(false);
    expect(h.mcpCalls).toHaveLength(0);
  });

  it('keeps the stored key when activation itself failed', async () => {
    // A key that is right but could not reach the vendor today must still be
    // there tomorrow — the operator should not paste it twice.
    const h = harness({ mcp: () => new Error('network down') });

    const result = await activateBoardUiLicense({ key: 'BUI-2', cwd }, h.deps);

    expect(result.ok).toBe(false);
    expect(result.stored).toBe(true);
    expect(h.vault.get(BOARDUI_LICENSE_SECRET)).toBe('BUI-2');
  });

  it('refuses a malformed key before anything happens', async () => {
    const h = harness();

    await expect(activateBoardUiLicense({ key: '  ', cwd }, h.deps)).rejects.toThrow(/empty/);
    expect(h.mcpCalls).toHaveLength(0);
  });

  it('reads an active licence and masks the stored key', async () => {
    const h = harness({ mcp: () => ({ text: 'Pro license active (••••1234)' }) });
    h.vault.set(BOARDUI_LICENSE_SECRET, 'BUI-SECRET-1234');

    const status = await boardUiLicenseStatus({ cwd }, h.deps);

    expect(status.state).toBe('active');
    expect(status.stored).toBe(true);
    expect(status.masked).toBe('••••1234');
    expect(status.masked).not.toContain('SECRET');
  });

  it('reads "Invalid license" as NOT active', async () => {
    // `invalid` contains `valid`: a substring test marked an unusable key as
    // active, and the failure only surfaced at install time.
    const h = harness({ mcp: () => ({ text: 'Invalid license key' }) });
    h.vault.set(BOARDUI_LICENSE_SECRET, 'BUI-BAD');

    expect((await boardUiLicenseStatus({ cwd }, h.deps)).state).toBe('absent');
  });

  it('reads an absent licence', async () => {
    const h = harness({ mcp: () => ({ text: 'No license found' }) });

    expect((await boardUiLicenseStatus({ cwd }, h.deps)).state).toBe('absent');
  });

  it('answers unknown — not absent — when the CLI cannot be reached', async () => {
    // Saying "absent" here would tell the operator their key is gone when the
    // only thing that happened is that npx could not run.
    const h = harness({ mcp: () => new Error('spawn failed') });
    h.vault.set(BOARDUI_LICENSE_SECRET, 'BUI-9');

    const status = await boardUiLicenseStatus({ cwd }, h.deps);

    expect(status.state).toBe('unknown');
    expect(status.stored).toBe(true);
  });

  it('forgets the key locally even when the vendor call failed', async () => {
    // A NATIVE licence is on disk (a vendor-issued instance), so the vendor
    // release is attempted — and failing offline must still forget the key.
    const h = harness({ licenseFile: { content: NATIVE_LICENSE }, mcp: () => new Error('offline') });
    h.vault.set(BOARDUI_LICENSE_SECRET, 'BUI-3');

    const result = await deactivateBoardUiLicense({ cwd }, h.deps);

    expect(result.ok).toBe(false);
    expect(h.vault.has(BOARDUI_LICENSE_SECRET)).toBe(false);
  });

  it('releases a NATIVE licence with the vendor, then forgets the key', async () => {
    const h = harness({
      licenseFile: { content: NATIVE_LICENSE },
      mcp: (tool) => (tool === 'deactivate_license' ? { text: 'License deactivated' } : { text: 'ok' }),
    });
    h.vault.set(BOARDUI_LICENSE_SECRET, 'BUI-CLIENT-OWN');

    const result = await deactivateBoardUiLicense({ cwd }, h.deps);

    expect(result.ok).toBe(true);
    expect(h.mcpCalls.map((call) => call.tool)).toContain('deactivate_license');
    // The vendor owns the release of a native seat; we never touch the file.
    expect(h.licenseFile.removed).toBe(false);
    expect(h.vault.has(BOARDUI_LICENSE_SECRET)).toBe(false);
  });

  it('removes a PROVISIONED licence locally — the vendor seat stays with the operator', async () => {
    // The file on this machine is exactly the operator's payload (bundled key,
    // the operator's Mac instanceId): `deactivate_license` would release THE
    // OPERATOR'S seat and kill Pro for the whole fleet. "Remover" is local.
    const h = harness({ licenseFile: { content: operatorBoardUiLicenseFile() } });
    h.vault.set(BOARDUI_LICENSE_SECRET, OPERATOR_BOARDUI_LICENSE_KEY);

    const result = await deactivateBoardUiLicense({ cwd }, h.deps);

    expect(result.ok).toBe(true);
    expect(result.provisioned).toBe(true);
    expect(h.mcpCalls.map((call) => call.tool)).not.toContain('deactivate_license');
    expect(h.licenseFile.content).toBeNull();
    expect(h.licenseFile.removed).toBe(true);
    expect(h.vault.has(BOARDUI_LICENSE_SECRET)).toBe(false);
    expect(result.detail).toMatch(/vendor seat stays with the operator/);
  });

  it('with no licence file at all, removal just forgets the stored key', async () => {
    const h = harness();
    h.vault.set(BOARDUI_LICENSE_SECRET, 'BUI-4');

    const result = await deactivateBoardUiLicense({ cwd }, h.deps);

    expect(result.ok).toBe(true);
    expect(h.mcpCalls).toHaveLength(0);
    expect(h.vault.has(BOARDUI_LICENSE_SECRET)).toBe(false);
    expect(result.detail).toMatch(/stored key was forgotten/);
  });
});

describe('the licence key bundled with Nexus', () => {
  it('activates with the bundled key when the vault is empty — and does not write the vault', async () => {
    // A fresh machine with zero setup: Pro works because the operator's key
    // ships with the app. The vault stays empty so "Remover" keeps meaning
    // "release the vendor seat + clear MY key", not "also delete the Nexus one".
    const h = harness({ mcp: () => ({ text: 'License activated' }) });

    const result = await callBoardUiTool({ tool: 'activate_license', cwd }, h.deps);

    expect(result.ok).toBe(true);
    expect(h.mcpCalls[0]?.args).toEqual({ licenseKey: OPERATOR_BOARDUI_LICENSE_KEY });
    expect(h.vault.has(BOARDUI_LICENSE_SECRET)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(OPERATOR_BOARDUI_LICENSE_KEY);
  });

  it('prefers the vault copy over the bundled one', async () => {
    const h = harness({ mcp: () => ({ text: 'License activated' }) });
    h.vault.set(BOARDUI_LICENSE_SECRET, 'BUI-OWN-KEY');

    await callBoardUiTool({ tool: 'activate_license', cwd }, h.deps);

    expect(h.mcpCalls[0]?.args).toEqual({ licenseKey: 'BUI-OWN-KEY' });
  });

  it('still names the panel when NEITHER a stored key nor a bundle exists', async () => {
    operatorBundle.hasKey = false;
    const h = harness();

    await expect(callBoardUiTool({ tool: 'activate_license', cwd }, h.deps)).rejects.toThrow(
      /no BoardUI licence is stored and none ships with this Nexus/,
    );
    expect(h.mcpCalls).toHaveLength(0);
  });

  it('flags status with operatorKey only when the vault is empty', async () => {
    const absent = harness({ mcp: () => ({ text: 'No license found' }) });
    expect((await boardUiLicenseStatus({ cwd }, absent.deps)).operatorKey).toBe(true);

    const own = harness({ mcp: () => ({ text: 'No license found' }) });
    own.vault.set(BOARDUI_LICENSE_SECRET, 'BUI-OWN-KEY');
    expect((await boardUiLicenseStatus({ cwd }, own.deps)).operatorKey).toBe(false);
  });

  it('provisions the operator licence file when the vault is empty — no vendor seat, no vault write', async () => {
    // Rota B (operator decision 21/10, "opção B"): a fresh machine with zero
    // setup gets the operator's licence FILE, not a vendor activation — the
    // vendor counts seats at activation only, and both are spent. The vault
    // stays empty so the panel keeps offering "Remover" as the local undo.
    const h = harness({
      mcp: (tool, ctx) => {
        if (tool === 'license_status') {
          // The status mirrors the file, like the real vendor does.
          return ctx.licenseFile
            ? { text: 'Pro license valid and active: 4889…636E.' }
            : { text: 'No license found' };
        }
        // A vendor activation here would burn a seat the operator does not have.
        return { text: 'License activated' };
      },
    });

    const result = await activateEffectiveBoardUiLicense({ cwd }, h.deps);

    expect(result.ok).toBe(true);
    expect(result.provisioned).toBe(true);
    expect(result.stored).toBe(false);
    expect(h.licenseFile.writes).toEqual([operatorBoardUiLicenseFile()]);
    expect(h.mcpCalls.map((call) => call.tool)).not.toContain('activate_license');
    expect(h.vault.has(BOARDUI_LICENSE_SECRET)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(OPERATOR_BOARDUI_LICENSE_KEY);
  });

  it('names the write failure when provisioning is refused', async () => {
    const h = harness({
      licenseFile: { failWrite: true },
      mcp: () => ({ text: 'No license found' }),
    });

    const result = await activateEffectiveBoardUiLicense({ cwd }, h.deps);

    expect(result.ok).toBe(false);
    expect(result.provisioned).toBeUndefined();
    expect(result.detail).toMatch(/EACCES/);
    expect(h.vault.has(BOARDUI_LICENSE_SECRET)).toBe(false);
  });

  it('does not re-run activation when the vendor already counts this machine active', async () => {
    // This Mac activated the key before Nexus bundled it, and the vendor
    // answers re-activation with "reached the activation limit" even though
    // Pro works — burned into every install door, that text would read as a
    // failure on a machine the vendor itself calls active. The status call
    // comes first; an active licence never pays the activation call.
    const h = harness({
      // A CLIENT's own licence file: provisioning would overwrite it. The
      // pre-check is what keeps the operator's payload off machines that
      // already hold a licence worth keeping.
      licenseFile: { content: NATIVE_LICENSE },
      mcp: (tool) =>
        tool === 'license_status'
          ? { text: 'Pro license valid and active: BUI-CLIENT-OWN. Seats: 1/5.' }
          : { text: 'This license key has reached the activation limit.' },
    });

    const result = await activateEffectiveBoardUiLicense({ cwd }, h.deps);

    expect(result.ok).toBe(true);
    expect(h.mcpCalls.map((call) => call.tool)).not.toContain('activate_license');
    expect(h.licenseFile.writes).toHaveLength(0);
    expect(result.detail).toMatch(/valid and active/);
  });

  it('keeps a NATIVE licence file that is already on disk — the file is the last word, not the vendor call', async () => {
    // Security review 21/10: provisioning trusted only the vendor status
    // call, and the vendor can be unreachable ('unknown') while a perfectly
    // valid licence sits on disk — and the install doors do not even run the
    // pre-check. Overwriting would destroy a working licence the machine
    // already had. The same predicate the deactivate path uses decides here.
    const h = harness({
      licenseFile: { content: NATIVE_LICENSE },
      mcp: (tool) => (tool === 'license_status' ? new Error('vendor unreachable') : { text: 'ok' }),
    });

    const result = await activateEffectiveBoardUiLicense({ cwd }, h.deps);

    expect(result.ok).toBe(false);
    expect(result.provisioned).toBeUndefined();
    expect(result.detail).toMatch(/its own BoardUI licence file/);
    expect(h.licenseFile.writes).toHaveLength(0);
    expect(h.licenseFile.content).toEqual(NATIVE_LICENSE);
    expect(h.vault.has(BOARDUI_LICENSE_SECRET)).toBe(false);
  });

  it('refuses to provision when the licence file exists but cannot be read — unreadable is not absent', async () => {
    // Security review 21/10 (2nd finding): the read used to answer null for
    // BOTH a missing file and an unreadable one, so "absence" was never
    // positively established — and `writeFileAtomic` renames over the old
    // file with only DIRECTORY write permission, destroying a licence we
    // could not even read. Unreadable now refuses like a native file would.
    const h = harness({
      licenseFile: { unreadable: true },
      mcp: (tool) => (tool === 'license_status' ? new Error('vendor unreachable') : { text: 'ok' }),
    });

    const result = await activateEffectiveBoardUiLicense({ cwd }, h.deps);

    expect(result.ok).toBe(false);
    expect(result.provisioned).toBeUndefined();
    expect(result.detail).toMatch(/could not be read/);
    expect(h.licenseFile.writes).toHaveLength(0);
    expect(h.licenseFile.content).toBeNull();
  });

  it('re-provisions the operator payload idempotently — our own file is the only one ever rewritten', async () => {
    const h = harness({
      licenseFile: { content: operatorBoardUiLicenseFile() },
      mcp: (tool) => (tool === 'license_status' ? new Error('vendor unreachable') : { text: 'ok' }),
    });

    const result = await activateEffectiveBoardUiLicense({ cwd }, h.deps);

    expect(result.provisioned).toBe(true);
    expect(h.licenseFile.writes).toEqual([operatorBoardUiLicenseFile()]);
  });

  it('routes the effective activation through the vault copy when there is one', async () => {
    const h = harness({ mcp: () => ({ text: 'License activated' }) });
    h.vault.set(BOARDUI_LICENSE_SECRET, 'BUI-OWN-KEY');

    const result = await activateEffectiveBoardUiLicense({ cwd }, h.deps);

    expect(result.ok).toBe(true);
    expect(result.stored).toBe(true);
    expect(h.vault.get(BOARDUI_LICENSE_SECRET)).toBe('BUI-OWN-KEY');
  });

  it('refuses the effective activation when there is no key at all', async () => {
    operatorBundle.hasKey = false;
    const h = harness();

    const result = await activateEffectiveBoardUiLicense({ cwd }, h.deps);

    expect(result.ok).toBe(false);
    expect(result.stored).toBe(false);
    expect(result.detail).toMatch(/none ships with this Nexus/);
    expect(h.mcpCalls).toHaveLength(0);
  });
});

describe('provisionBundledBoardUiLicense — the bundled key on every machine', () => {
  // Operator 22/10: "a key BoardUI para ficar disponível para todos PCs …
  // tem que ficar tudo liberado usando a key". This runs at boot and before
  // every door that asks whether Pro is usable, so it must be LOCAL: no
  // vendor process, no network, no seat.

  it('writes the operator licence file on a fresh machine without spawning anything', () => {
    const h = harness();

    const result = provisionBundledBoardUiLicense(h.deps);

    expect(result).toEqual({ status: 'written' });
    expect(h.licenseFile.writes).toEqual([operatorBoardUiLicenseFile()]);
    expect(h.mcpCalls).toHaveLength(0);
    expect(h.cliRuns).toHaveLength(0);
    expect(h.vault.has(BOARDUI_LICENSE_SECRET)).toBe(false);
  });

  it('leaves our own payload alone instead of rewriting it at every boot', () => {
    const h = harness({ licenseFile: { content: operatorBoardUiLicenseFile() } });

    expect(provisionBundledBoardUiLicense(h.deps)).toEqual({ status: 'present' });
    expect(h.licenseFile.writes).toHaveLength(0);
  });

  it('heals a corrupted file — the CLI reads no licence from it either', () => {
    const h = harness({ licenseFile: { corrupted: true } });

    expect(provisionBundledBoardUiLicense(h.deps)).toEqual({ status: 'written' });
    expect(h.licenseFile.writes).toEqual([operatorBoardUiLicenseFile()]);
  });

  it('never touches a machine\'s own licence file', () => {
    const h = harness({ licenseFile: { content: NATIVE_LICENSE } });

    const result = provisionBundledBoardUiLicense(h.deps);

    expect(result).toMatchObject({ status: 'skipped', reason: 'native-file' });
    expect(h.licenseFile.writes).toHaveLength(0);
    expect(h.licenseFile.content).toEqual(NATIVE_LICENSE);
  });

  it('never writes over a file it could not read', () => {
    const h = harness({ licenseFile: { unreadable: true } });

    expect(provisionBundledBoardUiLicense(h.deps)).toMatchObject({
      status: 'skipped',
      reason: 'unreadable-file',
    });
    expect(h.licenseFile.writes).toHaveLength(0);
  });

  it('stands aside when the operator typed their own key — that one activates with the vendor', () => {
    const h = harness();
    h.vault.set(BOARDUI_LICENSE_SECRET, 'BUI-OWN-KEY');

    expect(provisionBundledBoardUiLicense(h.deps)).toMatchObject({
      status: 'skipped',
      reason: 'own-key',
    });
    expect(h.licenseFile.writes).toHaveLength(0);
  });

  it('does nothing in a build that ships no key', () => {
    operatorBundle.hasKey = false;
    const h = harness();

    expect(provisionBundledBoardUiLicense(h.deps)).toMatchObject({
      status: 'skipped',
      reason: 'no-bundled-key',
    });
    expect(h.licenseFile.writes).toHaveLength(0);
  });

  it('reports a refused write instead of throwing', () => {
    const h = harness({ licenseFile: { failWrite: true } });

    const result = provisionBundledBoardUiLicense(h.deps);

    expect(result).toMatchObject({ status: 'skipped', reason: 'write-failed' });
    expect(JSON.stringify(result)).toMatch(/EACCES/);
  });

  it('forgets the cached listing when it writes — the licence changed', async () => {
    const h = harness({ cli: () => ({ stdout: '  button    Primary button.\n' }) });
    await listBoardUiFreeSlugs(cwd, h.deps);
    expect(h.cliRuns).toHaveLength(1);

    provisionBundledBoardUiLicense(h.deps);
    await listBoardUiFreeSlugs(cwd, h.deps);

    expect(h.cliRuns).toHaveLength(2);
  });
});

describe('auto-activation at the install doors', () => {
  /** `boardui list` output shape, as the real CLI prints it. */
  const freeList = '  button    Primary button.\n';

  it('provisions the operator licence on the way in, then installs the Pro item', async () => {
    // Fresh machine, empty vault: the install door heals itself before
    // refusing — the operator asked for "works everywhere with zero setup".
    // Rota B: the healing writes the operator's licence FILE, and the vendor
    // is never asked for a seat the fleet does not have.
    const h = harness({
      cli: () => ({ stdout: freeList }),
      mcp: (tool, ctx) => {
        if (tool === 'license_status') {
          // The status mirrors the file, like the real vendor does.
          return ctx.licenseFile ? { text: 'Pro license active' } : { text: 'No license found' };
        }
        return { text: 'License activated' };
      },
    });

    const result = await installItems(
      { kit: 'boardui', items: ['template-home-dashboard'], cwd },
      h.deps,
    );

    expect(result.ok).toBe(true);
    expect(h.mcpCalls.map((call) => call.tool)).not.toContain('activate_license');
    expect(h.licenseFile.writes).toEqual([operatorBoardUiLicenseFile()]);
    expect(h.vault.has(BOARDUI_LICENSE_SECRET)).toBe(false);
    expect(h.cliRuns.at(-1)?.args).toEqual(['add', 'template-home-dashboard', '--yes']);
  });

  it('says WHY it refused when the automatic provisioning failed', async () => {
    // The disk refuses the licence file: the refusal must name the
    // provisioning failure instead of a generic "no licence".
    const h = harness({
      cli: () => ({ stdout: freeList }),
      licenseFile: { failWrite: true },
      mcp: () => ({ text: 'No license found' }),
    });

    const result = await installItems(
      { kit: 'boardui', items: ['template-home-dashboard'], cwd },
      h.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.needsLicense).toEqual(['template-home-dashboard']);
    expect(result.stderr).toMatch(/automatic activation failed/);
    expect(result.stderr).toMatch(/EACCES/);
  });

  it('auto-provisions on the AGENT install door too (install_components)', async () => {
    const h = harness({
      cli: () => ({ stdout: freeList }),
      mcp: (tool, ctx) => {
        if (tool === 'license_status') {
          return ctx.licenseFile ? { text: 'Pro license active' } : { text: 'No license found' };
        }
        return { text: 'ok' };
      },
    });

    const result = await callBoardUiTool(
      { tool: 'install_components', args: { components: ['template-home-dashboard'] }, cwd },
      h.deps,
    );

    expect(result.ok).toBe(true);
    expect(h.mcpCalls.map((call) => call.tool)).not.toContain('activate_license');
    expect(h.licenseFile.writes).toEqual([operatorBoardUiLicenseFile()]);
  });

  it('does NOT spend a vendor seat from a dry-run plan', async () => {
    const h = harness({
      cli: () => ({ stdout: freeList }),
      mcp: () => ({ text: 'No license found' }),
    });

    const plan = await planInstallItems(
      { kit: 'boardui', items: ['template-home-dashboard'], cwd },
      h.deps,
    );

    expect(plan.needsLicense).toEqual(['template-home-dashboard']);
    expect(h.mcpCalls.map((call) => call.tool)).not.toContain('activate_license');
    // Dry-run spends NOTHING: no seat, no licence file either.
    expect(h.licenseFile.writes).toHaveLength(0);
  });
});

describe('readItemSource', () => {
  it('serves a fresh cache hit without touching the CLI', async () => {
    const h = harness();
    writeCachedItem(
      { kit: 'shadcn', slug: 'button', payload: 'cached source', source: 'shadcn view' },
      { rootDir: dir },
    );

    const result = await readItemSource({ kit: 'shadcn', slug: 'button', cwd }, h.deps);

    expect(result.fromCache).toBe(true);
    expect(result.source).toBe('cached source');
    expect(h.cliRuns).toHaveLength(0);
  });

  it('fetches and caches on a miss', async () => {
    const h = harness({ cli: () => ({ stdout: 'export const Button = 1' }) });

    const result = await readItemSource({ kit: 'shadcn', slug: 'button', cwd }, h.deps);

    expect(result.fromCache).toBe(false);
    expect(h.cliRuns[0]?.args).toEqual(['view', 'button']);
    expect(readCachedItem('shadcn', 'button', { rootDir: dir })?.payload).toBe(
      'export const Button = 1',
    );
  });

  it('refetches when asked to refresh', async () => {
    const h = harness({ cli: () => ({ stdout: 'v2' }) });
    writeCachedItem({ kit: 'shadcn', slug: 'button', payload: 'v1', source: 's' }, { rootDir: dir });

    const result = await readItemSource({ kit: 'shadcn', slug: 'button', cwd, refresh: true }, h.deps);

    expect(result.source).toBe('v2');
    expect(h.cliRuns).toHaveLength(1);
  });

  it('records a free BoardUI tier it can prove, and `unknown` when it cannot', async () => {
    const h = harness({ mcp: () => ({ text: 'source' }) });

    await readItemSource({ kit: 'boardui', slug: 'button', cwd }, h.deps);
    await readItemSource({ kit: 'boardui', slug: 'template-home-dashboard', cwd }, h.deps);
    await readItemSource({ kit: 'boardui', slug: 'shipped-next-month', cwd }, h.deps);

    expect(readCachedItem('boardui', 'button', { rootDir: dir })?.tier).toBe('free');
    // A Pro identifier the vendor published is recorded as Pro.
    expect(
      readCachedItem('boardui', 'template-home-dashboard', { rootDir: dir })?.tier,
    ).toBe('pro');
    // Not 'pro' and not 'free': a slug the snapshot never saw is recorded as
    // not known rather than given an invented tier.
    expect(
      readCachedItem('boardui', 'shipped-next-month', { rootDir: dir })?.tier,
    ).toBe('unknown');
  });

  it('throws a framed error when the vendor refuses', async () => {
    const h = harness({ cli: () => ({ code: 1, stderr: 'not found' }) });

    await expect(readItemSource({ kit: 'shadcn', slug: 'nope', cwd }, h.deps)).rejects.toThrow(
      UiKitCliError,
    );
  });
});

describe('downloadItemsIntoCache', () => {
  it('reports what it cached and what it could not', async () => {
    const h = harness({
      cli: (request) =>
        request.args[1] === 'broken' ? { code: 1, stderr: 'nope' } : { stdout: 'source' },
    });

    const result = await downloadItemsIntoCache(
      { kit: 'shadcn', slugs: ['button', 'broken', 'sidebar'], cwd },
      h.deps,
    );

    expect(result.cached).toEqual(['button', 'sidebar']);
    expect(result.failed.map((entry) => entry.slug)).toEqual(['broken']);
  });
});

describe('catalog helpers', () => {
  it('scrapes namespaced items out of search output, best effort', () => {
    const parsed = parseShadcnSearchOutput(
      '\u001b[32m@shadcn/button\u001b[0m  A button\n  @shadcn/data-table  A table\nnoise line\n',
    );

    expect(parsed.map((entry) => entry.slug)).toEqual(['button', 'data-table']);
  });

  it('keeps the category the real CLI prints', () => {
    // Measured output of `shadcn search @shadcn --query button --limit 5`.
    const parsed = parseShadcnSearchOutput(
      [
        'Found 33 items matching "button" in @shadcn',
        'Showing 1-5 of 33',
        '',
        '- @shadcn/button (ui)',
        '- @shadcn/kbd-button (example)',
        '- @shadcn/button-demo (example)',
        '',
        'More items available. Use --offset 5 to see the next page.',
      ].join('\n'),
    );

    expect(parsed).toEqual([
      { kit: 'shadcn', slug: 'button', label: 'button', category: 'ui', tier: 'free' },
      { kit: 'shadcn', slug: 'kbd-button', label: 'kbd-button', category: 'example', tier: 'free' },
      { kit: 'shadcn', slug: 'button-demo', label: 'button-demo', category: 'example', tier: 'free' },
    ]);
  });

  it('returns nothing rather than guessing from unparseable output', () => {
    expect(parseShadcnSearchOutput('Found 12 items.')).toEqual([]);
  });

  it('keeps the namespace on an item from a configured registry', () => {
    // Installing `auth` instead of `@acme/auth` goes to the PUBLIC registry,
    // and the token for @acme is then withheld because nothing references it.
    const parsed = parseShadcnSearchOutput(
      '- @shadcn/button (ui)\n- @acme/auth (block)\n',
    );

    expect(parsed.map((entry) => entry.slug)).toEqual(['button', '@acme/auth']);
    expect(parsed.map((entry) => entry.label)).toEqual(['button', 'auth']);
  });

  it('lists @shadcn plus the configured namespaces', () => {
    expect(shadcnSearchNamespaces([PRIVATE_REGISTRY])).toEqual(['@shadcn', '@acme']);
  });

  it('offers the whole BoardUI catalog offline, free and Pro', () => {
    const candidates = boardUiCandidates();

    expect(candidates).toHaveLength(109);
    expect(candidates.find((entry) => entry.slug === 'button')?.tier).toBe('free');
    expect(candidates.find((entry) => entry.slug === 'app-shell')?.tier).toBe('free');
    expect(candidates.find((entry) => entry.slug === 'template-finance')?.tier).toBe('pro');
    expect(candidates.filter((entry) => entry.tier === 'free')).toHaveLength(69);
  });
});

describe('ensureProjectRegistries', () => {
  it('reports a missing components.json instead of creating one', () => {
    const result = ensureProjectRegistries(cwd, [PRIVATE_REGISTRY]);

    expect(result.componentsJsonMissing).toBe(true);
    expect(result.wrote).toEqual([]);
    expect(fs.existsSync(path.join(cwd, 'components.json'))).toBe(false);
  });

  it('adds our namespace and leaves the rest of the file alone', () => {
    writeComponentsJson({ style: 'new-york', aliases: { ui: '@/components/ui' } });

    const result = ensureProjectRegistries(cwd, [PRIVATE_REGISTRY]);

    expect(result.wrote).toEqual(['@acme']);
    const written = readComponentsJson(cwd);
    expect(written?.style).toBe('new-york');
    expect(written?.aliases).toEqual({ ui: '@/components/ui' });
  });

  it('never repoints a namespace the project already declares', () => {
    writeComponentsJson({ registries: { '@acme': 'https://theirs.test/{name}.json' } });

    const result = ensureProjectRegistries(cwd, [PRIVATE_REGISTRY]);

    expect(result.wrote).toEqual([]);
    expect(result.conflicts).toEqual(['@acme']);
    expect(declaredRegistry('@acme')).toBe('https://theirs.test/{name}.json');
  });

  it('completes a bare mapping to our host with the token reference', () => {
    // Same host, no `${VAR}`: shadcn sent the request unauthenticated and the
    // registry answered 401, while the token went into the child env anyway.
    writeComponentsJson({ registries: { '@acme': PRIVATE_REGISTRY.url } });

    const result = ensureProjectRegistries(cwd, [PRIVATE_REGISTRY]);

    expect(result.wrote).toEqual(['@acme']);
    expect(result.conflicts).toEqual([]);
    expect(declaredRegistry('@acme')).toEqual({
      url: PRIVATE_REGISTRY.url,
      headers: { Authorization: 'Bearer ${ACME_REGISTRY_TOKEN}' },
    });
  });

  it('is a no-op once the entry already carries the reference', () => {
    writeComponentsJson({
      registries: {
        '@acme': {
          url: PRIVATE_REGISTRY.url,
          headers: { Authorization: 'Bearer ${ACME_REGISTRY_TOKEN}' },
        },
      },
    });

    const result = ensureProjectRegistries(cwd, [PRIVATE_REGISTRY]);

    expect(result.wrote).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("does not overwrite the project's own auth on our namespace", () => {
    // Their header, our host. Replacing it would be the same class of
    // surprise as repointing their URL; the env builder withholds instead.
    const theirs = {
      url: PRIVATE_REGISTRY.url,
      headers: { Authorization: 'Bearer ${THEIR_TOKEN}' },
    };
    writeComponentsJson({ registries: { '@acme': theirs } });

    const result = ensureProjectRegistries(cwd, [PRIVATE_REGISTRY]);

    expect(result.wrote).toEqual([]);
    expect(declaredRegistry('@acme')).toEqual(theirs);
  });
});

describe('readsAsActiveLicense', () => {
  it.each([
    'pro license active',
    'license is valid',
    'licensed to you (••••1234)',
  ])('accepts %s', (text) => {
    expect(readsAsActiveLicense(text)).toBe(true);
  });

  it.each([
    'invalid license key',
    'license not valid',
    'no license found',
    'license inactive',
    'license expired',
    'license revoked',
    'unlicensed',
    'not licensed',
    'license deactivated',
    'license not found',
  ])('refuses %s', (text) => {
    expect(readsAsActiveLicense(text)).toBe(false);
  });

  it('does not accept a word that merely contains the token', () => {
    // `invalidated` / `validation` must not read as active.
    expect(readsAsActiveLicense('license validation failed')).toBe(false);
    expect(readsAsActiveLicense('seat invalidated')).toBe(false);
  });
});

describe('the Pro gate on a direct install', () => {
  /** `boardui list` output shape, as the real CLI prints it. */
  const freeList = '  button    Primary button.\n  sidebar   The sidebar.\n';

  it('refuses a Pro item the live catalogue does not list as free', async () => {
    const h = harness({
      cli: () => ({ stdout: freeList }),
      mcp: () => ({ text: 'No license found' }),
    });

    const result = await installItems(
      { kit: 'boardui', items: ['template-home-dashboard', 'button'], cwd },
      h.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.needsLicense).toEqual(['template-home-dashboard']);
    expect(result.licenseState).toBe('absent');
    expect(result.stderr).toMatch(/Configurações › Biblioteca › Kits de UI/);
    // The snapshot knows it is Pro, so no listing ran — and the install never
    // reached the vendor.
    expect(h.cliRuns).toEqual([]);
  });

  it('installs it once the licence is active', async () => {
    const h = harness({
      cli: () => ({ stdout: freeList }),
      mcp: () => ({ text: 'Pro license active' }),
    });

    const result = await installItems(
      { kit: 'boardui', items: ['template-home-dashboard'], cwd },
      h.deps,
    );

    expect(result.ok).toBe(true);
    expect(h.cliRuns.at(-1)?.args).toEqual(['add', 'template-home-dashboard', '--yes']);
  });

  it('gates an UNKNOWN tier too, when the catalogue cannot be reached', async () => {
    // The snapshot not knowing a slug is not evidence that it is free.
    const h = harness({
      cli: () => ({ code: 1, stderr: 'offline' }),
      mcp: () => ({ text: 'No license found' }),
    });

    const result = await installItems(
      { kit: 'boardui', items: ['something-new'], cwd },
      h.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.needsLicense).toEqual(['something-new']);
  });

  it('never probes the licence for free items', async () => {
    const h = harness();

    await installItems({ kit: 'boardui', items: ['button', 'sidebar'], cwd }, h.deps);

    expect(h.mcpCalls).toHaveLength(0);
    expect(h.cliRuns).toHaveLength(1);
  });
});

describe('the cwd guard runs before the project config is touched', () => {
  it('leaves components.json untouched when the run will be refused', async () => {
    // A checkout whose node_modules is a shared symlink: the install is
    // refused, and editing the project's config for a run that never happens
    // is the worst of both.
    writeComponentsJson({ style: 'new-york' });
    fs.symlinkSync(path.join(dir, 'shared-modules'), path.join(cwd, 'node_modules'));
    fs.mkdirSync(path.join(dir, 'shared-modules'));
    const before = fs.readFileSync(path.join(cwd, 'components.json'), 'utf8');
    const h = harness({ registries: [PRIVATE_REGISTRY] });

    await expect(
      runShadcnCommand({ command: { kind: 'add', items: ['@acme/auth'] }, cwd }, h.deps),
    ).rejects.toThrow(/node_modules is a symlink/);

    expect(fs.readFileSync(path.join(cwd, 'components.json'), 'utf8')).toBe(before);
  });
});

describe('resolveBoardUiTier', () => {
  const freeList = '  button    Primary button.\n  app-shell  The shell.\n';

  it('answers free from the snapshot without asking the vendor', async () => {
    const h = harness();

    expect(await resolveBoardUiTier('button', cwd, h.deps)).toBe('free');
    expect(h.cliRuns).toHaveLength(0);
  });

  it('asks the live catalogue for a slug the snapshot does not know', async () => {
    const h = harness({ cli: () => ({ stdout: freeList }) });

    expect(await resolveBoardUiTier('shipped-next-month', cwd, h.deps)).toBe('pro');
    expect(h.cliRuns[0]?.args).toEqual(['list']);
  });

  it('answers a Pro item the snapshot knows without spawning anything', async () => {
    const h = harness({ cli: () => ({ stdout: freeList }) });

    expect(await resolveBoardUiTier('template-home-dashboard', cwd, h.deps)).toBe('pro');
    expect(h.cliRuns).toEqual([]);
  });

  it('answers unknown — never free — when the vendor cannot be reached', async () => {
    const h = harness({ cli: () => ({ code: 1, stderr: 'offline' }) });

    expect(await resolveBoardUiTier('mystery-item', cwd, h.deps)).toBe('unknown');
  });

  it('spends ONE vendor call on a burst of unknown slugs', async () => {
    // The TTL cache alone did not do this: every call in the Promise.all
    // arrived before the first had populated it, so a 32-item install fired
    // 32 concurrent `npx boardui list`.
    const h = harness({ cli: () => ({ stdout: freeList }) });
    const unknown = Array.from({ length: 12 }, (_, index) => `mystery-${index}`);

    const tiers = await Promise.all(
      unknown.map((slug) => resolveBoardUiTier(slug, cwd, h.deps)),
    );

    expect(tiers).toEqual(unknown.map(() => 'pro'));
    expect(h.cliRuns).toHaveLength(1);
  });

  it('does not keep a failed fetch, so the next burst may still succeed', async () => {
    let reachable = false;
    const h = harness({
      cli: () => (reachable ? { stdout: freeList } : { code: 1, stderr: 'offline' }),
    });

    expect(await resolveBoardUiTier('mystery-item', cwd, h.deps)).toBe('unknown');
    reachable = true;
    expect(await resolveBoardUiTier('mystery-item', cwd, h.deps)).toBe('pro');
    expect(h.cliRuns).toHaveLength(2);
  });
});

describe('parseBoardUiListOutput', () => {
  it('reads the slugs out of the real listing shape', () => {
    const parsed = parseBoardUiListOutput(
      [
        'Base components',
        '  button             Primary, secondary, ghost buttons.',
        '  icon-button        Square icon-only button.',
        '',
        'Add a component with npx boardui add <name>',
      ].join('\n'),
    );

    expect([...parsed].sort()).toEqual(['button', 'icon-button']);
  });

  it('is empty for output it cannot read, rather than guessing', () => {
    expect(parseBoardUiListOutput('Found nothing.').size).toBe(0);
  });
});

describe('parseShadcnSearch', () => {
  /** The real `--json` shape, measured against shadcn@latest on 2026-10-21. */
  const JSON_OUT = JSON.stringify({
    items: [
      { name: 'button', type: 'registry:ui', registry: '@shadcn', addCommandArgument: '@shadcn/button' },
      { name: 'button-demo', type: 'registry:example', registry: '@shadcn' },
      { name: 'auth', type: 'registry:block', registry: '@acme' },
    ],
  });

  it('reads the typed answer and is NOT best-effort', () => {
    const parsed = parseShadcnSearch(JSON_OUT);

    expect(parsed.bestEffort).toBe(false);
    expect(parsed.candidates.map((entry) => entry.slug)).toEqual([
      'button',
      'button-demo',
      '@acme/auth',
    ]);
    // The demo marker comes from the typed field, not from sniffing text:
    // installing `button-demo` instead of `button` looks like success.
    expect(
      parsed.candidates.find((entry) => entry.slug === 'button-demo')?.category,
    ).toBe('example');
  });

  it('keeps the namespace in the identifier for a non-default registry', () => {
    // `auth` instead of `@acme/auth` would install from the public registry
    // and leave the token withheld.
    expect(parseShadcnSearchJson(JSON_OUT)?.find((entry) => entry.label === 'auth')?.slug).toBe(
      '@acme/auth',
    );
  });

  it('falls back to the scrape for an older CLI, and says it did', () => {
    const parsed = parseShadcnSearch('- @shadcn/button (ui)\n- @shadcn/card (ui)\n');

    expect(parsed.bestEffort).toBe(true);
    expect(parsed.candidates.map((entry) => entry.slug)).toEqual(['button', 'card']);
  });

  it('is not fooled by prose that merely contains a brace', () => {
    expect(parseShadcnSearchJson('no json here { but a brace')).toBeNull();
  });
});
