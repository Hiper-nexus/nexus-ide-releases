import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UiKitCliError, type UiKitCliRunRequest } from './ui-kit-cli';
import { BOARDUI_LICENSE_SECRET } from './boardui-source';
import { readCachedItem, writeCachedItem } from './ui-kit-cache';
import type { UiKitRegistry } from './ui-kit-registry';
import {
  activateBoardUiLicense,
  parseBoardUiListOutput,
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
});

interface Harness {
  readonly deps: UiKitServiceDeps;
  readonly cliRuns: UiKitCliRunRequest[];
  readonly mcpCalls: Array<{ tool?: string; args?: Record<string, unknown>; writes?: boolean }>;
  readonly vault: Map<string, string>;
}

function harness(
  over: {
    cli?: (request: UiKitCliRunRequest) => { stdout?: string; stderr?: string; code?: number };
    mcp?: (tool: string | undefined) => { text: string; isError?: boolean } | Error;
    registries?: readonly UiKitRegistry[];
    vaultWritable?: boolean;
  } = {},
): Harness {
  const cliRuns: UiKitCliRunRequest[] = [];
  const mcpCalls: Array<{ tool?: string; args?: Record<string, unknown>; writes?: boolean }> = [];
  const store = new Map<string, string>();
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
      const outcome = over.mcp?.(request.tool) ?? { text: 'ok' };
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
  };
  return { deps, cliRuns, mcpCalls, vault: store };
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
    const h = harness();

    await installItems({ kit: 'shadcn', items: ['button'], cwd, path: 'src/ui' }, h.deps);

    expect(h.cliRuns[0]?.kit).toBe('shadcn');
    expect(h.cliRuns[0]?.args).toEqual(['add', '--yes', 'button', '--path', 'src/ui']);
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
    const h = harness({ mcp: () => new Error('offline') });
    h.vault.set(BOARDUI_LICENSE_SECRET, 'BUI-3');

    const result = await deactivateBoardUiLicense({ cwd }, h.deps);

    expect(result.ok).toBe(false);
    expect(h.vault.has(BOARDUI_LICENSE_SECRET)).toBe(false);
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

    expect(readCachedItem('boardui', 'button', { rootDir: dir })?.tier).toBe('free');
    // Not 'pro' and not 'free': the snapshot cannot see Pro items, so the
    // cache records that it does not know rather than inventing a tier.
    expect(
      readCachedItem('boardui', 'template-home-dashboard', { rootDir: dir })?.tier,
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

  it('offers the free BoardUI catalog offline', () => {
    const candidates = boardUiCandidates();

    expect(candidates).toHaveLength(69);
    expect(candidates.find((entry) => entry.slug === 'button')?.tier).toBe('free');
    expect(candidates.find((entry) => entry.slug === 'app-shell')?.tier).toBe('free');
    expect(candidates.every((entry) => entry.tier === 'free')).toBe(true);
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
    expect(result.stderr).toMatch(/Settings → UI kits/);
    // Only the catalogue listing ran; the install never reached the vendor.
    expect(h.cliRuns.map((run) => run.args[0])).toEqual(['list']);
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

    expect(await resolveBoardUiTier('template-home-dashboard', cwd, h.deps)).toBe('pro');
    expect(h.cliRuns[0]?.args).toEqual(['list']);
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
