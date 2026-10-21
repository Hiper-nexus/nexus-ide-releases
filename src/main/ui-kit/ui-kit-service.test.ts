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

  it('reports a non-zero exit as not ok', async () => {
    const h = harness({ cli: () => ({ code: 1, stderr: 'boom' }) });

    const result = await runShadcnCommand({ command: { kind: 'info' }, cwd }, h.deps);

    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('boom');
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
    expect(h.cliRuns[0]?.args).toEqual(['add', 'date-picker']);
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

  it('records the Pro tier of a BoardUI item it cached', async () => {
    const h = harness({ mcp: () => ({ text: 'pro source' }) });

    await readItemSource({ kit: 'boardui', slug: 'finance-dashboard', cwd }, h.deps);

    expect(readCachedItem('boardui', 'finance-dashboard', { rootDir: dir })?.tier).toBe('pro');
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

  it('lists @shadcn plus the configured namespaces', () => {
    expect(shadcnSearchNamespaces([PRIVATE_REGISTRY])).toEqual(['@shadcn', '@acme']);
  });

  it('offers the BoardUI catalog offline with tiers', () => {
    const candidates = boardUiCandidates();

    expect(candidates.length).toBeGreaterThan(70);
    expect(candidates.find((entry) => entry.slug === 'button')?.tier).toBe('free');
    expect(candidates.find((entry) => entry.slug === 'finance-dashboard')?.tier).toBe('pro');
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

  it('is a no-op when the mapping already matches', () => {
    writeComponentsJson({ registries: { '@acme': PRIVATE_REGISTRY.url } });

    const result = ensureProjectRegistries(cwd, [PRIVATE_REGISTRY]);

    expect(result.wrote).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });
});
