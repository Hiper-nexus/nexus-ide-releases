import {
  runUiKitCli,
  UiKitCliError,
  type UiKitCliRunner,
  type UiKitId,
} from './ui-kit-cli';
import { callMcpToolOnce } from './ui-kit-mcp-call';
import {
  buildShadcnArgs,
  shadcnCommandWrites,
  type ShadcnCommand,
} from './shadcn-source';
import {
  assertBoardUiItems,
  assertBoardUiLicenseKey,
  assertBoardUiTool,
  boardUiCommandWrites,
  boardUiToolWrites,
  boardUiTierOf,
  buildBoardUiArgs,
  maskBoardUiLicenseKey,
  BOARDUI_CATALOG_SNAPSHOT,
  BOARDUI_LICENSE_SECRET,
  type BoardUiCliCommand,
  type BoardUiMcpTool,
} from './boardui-source';
import {
  buildRegistryEnv,
  SHADCN_DEFAULT_NAMESPACE,
  type UiKitRegistry,
} from './ui-kit-registry';
import {
  cachedItemIsStale,
  readCachedItem,
  writeCachedItem,
  type UiKitCacheOptions,
  type UiKitCachedTier,
} from './ui-kit-cache';
import type { UiKitCandidate } from './ui-kit-pick';

/**
 * The one place the rest of Nexus talks to a UI kit.
 *
 * Both the MCP tools and the settings panel come through here, so the rules
 * live in one spot: registry tokens resolved from the vault, the cache checked
 * before a network round trip, the licence key read from the vault and never
 * returned, and a missing credential reported as a named condition instead of
 * a vendor error nobody can read.
 */

export interface UiKitServiceDeps {
  readonly runCli?: UiKitCliRunner;
  readonly callMcp?: typeof callMcpToolOnce;
  readonly getSecret?: (key: string) => string | null;
  readonly setSecret?: (key: string, value: string) => { ok: boolean; error?: string };
  readonly registries?: () => readonly UiKitRegistry[];
  readonly cacheOptions?: UiKitCacheOptions;
}

function vault(deps: UiKitServiceDeps): {
  get: (key: string) => string | null;
  set: (key: string, value: string) => { ok: boolean; error?: string };
} {
  if (deps.getSecret && deps.setSecret) {
    return { get: deps.getSecret, set: deps.setSecret };
  }
  // Lazy require: secrets-store touches electron/safeStorage and must not be
  // pulled in at module load (the same reason designmd-api-client does this).
  const secrets =
    require('../persistence/secrets-store') as typeof import('../persistence/secrets-store');
  return {
    get: deps.getSecret ?? ((key) => secrets.getSecret(key)),
    set: deps.setSecret ?? ((key, value) => secrets.setSecret(key, value)),
  };
}

export interface UiKitRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  /** Namespaces whose token is configured but absent from the vault. */
  readonly missingRegistryKeys: readonly string[];
}

/** Run any shadcn command. The full documented surface goes through here. */
export async function runShadcnCommand(
  input: {
    readonly command: ShadcnCommand;
    readonly cwd: string;
    readonly signal?: AbortSignal;
  },
  deps: UiKitServiceDeps = {},
): Promise<UiKitRunResult> {
  const registries = deps.registries?.() ?? [];
  const { get } = vault(deps);
  const { env, missing } = buildRegistryEnv(registries, get);
  const run = deps.runCli ?? runUiKitCli;
  const result = await run({
    kit: 'shadcn',
    args: buildShadcnArgs(input.command),
    cwd: input.cwd,
    writes: shadcnCommandWrites(input.command),
    ...(Object.keys(env).length > 0 ? { extraEnv: env } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    missingRegistryKeys: missing,
  };
}

/** Run the BoardUI CLI (`init` / `add`). Everything else is an MCP tool. */
export async function runBoardUiCommand(
  input: {
    readonly command: BoardUiCliCommand;
    readonly cwd: string;
    readonly signal?: AbortSignal;
  },
  deps: UiKitServiceDeps = {},
): Promise<UiKitRunResult> {
  const run = deps.runCli ?? runUiKitCli;
  const result = await run({
    kit: 'boardui',
    args: buildBoardUiArgs(input.command),
    cwd: input.cwd,
    writes: boardUiCommandWrites(input.command),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    missingRegistryKeys: [],
  };
}

export interface BoardUiToolResult {
  readonly ok: boolean;
  readonly text: string;
  readonly isError: boolean;
}

/**
 * Call one of BoardUI's thirteen MCP tools.
 *
 * The licence key is injected here for the tools that need it, read from the
 * vault, so no caller ever has to hold it. It never comes back out.
 */
export async function callBoardUiTool(
  input: {
    readonly tool: string;
    readonly args?: Readonly<Record<string, unknown>>;
    readonly cwd: string;
    readonly signal?: AbortSignal;
  },
  deps: UiKitServiceDeps = {},
): Promise<BoardUiToolResult> {
  const tool = assertBoardUiTool(input.tool);
  const call = deps.callMcp ?? callMcpToolOnce;
  const result = await call({
    kit: 'boardui',
    cwd: input.cwd,
    writes: boardUiToolWrites(tool),
    method: 'tools/call',
    tool,
    toolArguments: input.args ?? {},
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { ok: !result.isError, text: result.text, isError: result.isError };
}

export type BoardUiLicenseState = 'active' | 'absent' | 'unknown';

export interface BoardUiLicenseStatus {
  readonly state: BoardUiLicenseState;
  /** Masked tail only — never the key. */
  readonly masked: string | null;
  /** True when a key is stored in the Nexus vault, active or not. */
  readonly stored: boolean;
  readonly detail?: string;
}

/**
 * Whether BoardUI Pro is usable right now.
 *
 * `unknown` is a real answer: the CLI may be unreachable, and reporting
 * `absent` then would tell the operator their key is gone when it is not.
 */
export async function boardUiLicenseStatus(
  input: { readonly cwd: string; readonly signal?: AbortSignal },
  deps: UiKitServiceDeps = {},
): Promise<BoardUiLicenseStatus> {
  const { get } = vault(deps);
  const stored = get(BOARDUI_LICENSE_SECRET);
  const masked = stored ? maskBoardUiLicenseKey(stored) : null;
  try {
    const result = await callBoardUiTool(
      { tool: 'license_status', cwd: input.cwd, ...(input.signal ? { signal: input.signal } : {}) },
      deps,
    );
    const text = result.text.toLowerCase();
    const active =
      !result.isError &&
      (text.includes('active') || text.includes('valid') || text.includes('licensed')) &&
      !text.includes('not active') &&
      !text.includes('no license') &&
      !text.includes('inactive');
    return {
      state: active ? 'active' : 'absent',
      masked,
      stored: Boolean(stored),
      detail: result.text.slice(0, 400),
    };
  } catch (error) {
    return {
      state: 'unknown',
      masked,
      stored: Boolean(stored),
      detail: error instanceof Error ? error.message.slice(0, 400) : undefined,
    };
  }
}

export interface ActivateLicenseResult {
  readonly ok: boolean;
  readonly stored: boolean;
  readonly detail?: string;
}

/**
 * Store the key in the vault and activate it on this machine.
 *
 * Storing happens first and independently of activation: a key that is correct
 * but could not reach the vendor today must still be there tomorrow, and the
 * operator should not have to paste it twice.
 */
export async function activateBoardUiLicense(
  input: { readonly key: string; readonly cwd: string; readonly signal?: AbortSignal },
  deps: UiKitServiceDeps = {},
): Promise<ActivateLicenseResult> {
  const key = assertBoardUiLicenseKey(input.key);
  const { set } = vault(deps);
  const write = set(BOARDUI_LICENSE_SECRET, key);
  if (!write.ok) {
    return { ok: false, stored: false, detail: write.error ?? 'vault write refused' };
  }
  try {
    const result = await callBoardUiTool(
      {
        tool: 'activate_license',
        args: { licenseKey: key },
        cwd: input.cwd,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      deps,
    );
    return { ok: result.ok, stored: true, detail: result.text.slice(0, 400) };
  } catch (error) {
    return {
      ok: false,
      stored: true,
      detail: error instanceof Error ? error.message.slice(0, 400) : 'activation failed',
    };
  }
}

/** Release this machine's Pro seat and forget the stored key. */
export async function deactivateBoardUiLicense(
  input: { readonly cwd: string; readonly signal?: AbortSignal },
  deps: UiKitServiceDeps = {},
): Promise<ActivateLicenseResult> {
  const { set } = vault(deps);
  let detail: string | undefined;
  let ok = false;
  try {
    const result = await callBoardUiTool(
      { tool: 'deactivate_license', cwd: input.cwd, ...(input.signal ? { signal: input.signal } : {}) },
      deps,
    );
    ok = result.ok;
    detail = result.text.slice(0, 400);
  } catch (error) {
    detail = error instanceof Error ? error.message.slice(0, 400) : 'deactivation failed';
  }
  // Forget it locally either way: leaving a key behind that the vendor has
  // released is the state that confuses the next activation.
  set(BOARDUI_LICENSE_SECRET, '');
  return { ok, stored: false, detail };
}

/** `@shadcn` plus every configured namespace. */
export function shadcnSearchNamespaces(
  registries: readonly UiKitRegistry[],
): readonly string[] {
  const names = [SHADCN_DEFAULT_NAMESPACE];
  for (const registry of registries) {
    if (!names.includes(registry.namespace)) names.push(registry.namespace);
  }
  return names;
}

/**
 * Best-effort parse of `shadcn search` output.
 *
 * The CLI has no `--json` for search, so this scrapes its text. It is reported
 * as best-effort precisely because of that: the raw text travels alongside, and
 * an empty parse never means "the registry has nothing".
 */
export function parseShadcnSearchOutput(
  output: string,
): readonly UiKitCandidate[] {
  const found = new Map<string, UiKitCandidate>();
  const tokenPattern = /@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*/gi;
  for (const line of output.split('\n')) {
    const stripped = line.replace(/\u001b\[[0-9;]*m/g, '');
    for (const match of stripped.matchAll(tokenPattern)) {
      const token = match[0];
      const slug = token.slice(token.indexOf('/') + 1);
      if (found.has(token)) continue;
      found.set(token, {
        kit: 'shadcn',
        slug,
        label: slug,
        category: 'registry-item',
        tier: 'free',
      });
    }
  }
  return [...found.values()];
}

/** BoardUI candidates from the offline snapshot, labelled with their tier. */
export function boardUiCandidates(): readonly UiKitCandidate[] {
  return BOARDUI_CATALOG_SNAPSHOT.map((entry) => ({
    kit: 'boardui' as const,
    slug: entry.slug,
    label: entry.name,
    category: entry.category,
    tier: entry.tier as UiKitCachedTier,
  }));
}

export interface ItemSourceResult {
  readonly kit: UiKitId;
  readonly slug: string;
  readonly source: string;
  readonly fromCache: boolean;
  readonly tier: UiKitCachedTier;
}

/**
 * Read one item's source, cache first.
 *
 * This is the call an agent makes before deciding; paying an npx boot for each
 * look is what made reading three components before choosing one expensive.
 */
export async function readItemSource(
  input: {
    readonly kit: UiKitId;
    readonly slug: string;
    readonly cwd: string;
    readonly refresh?: boolean;
    readonly signal?: AbortSignal;
  },
  deps: UiKitServiceDeps = {},
): Promise<ItemSourceResult> {
  const cacheOptions = deps.cacheOptions ?? {};
  if (!input.refresh) {
    const cached = readCachedItem(input.kit, input.slug, cacheOptions);
    if (cached && !cachedItemIsStale(cached)) {
      return {
        kit: input.kit,
        slug: cached.slug,
        source: cached.payload,
        fromCache: true,
        tier: cached.tier,
      };
    }
  }

  let text: string;
  let origin: string;
  if (input.kit === 'shadcn') {
    const result = await runShadcnCommand(
      {
        command: { kind: 'view', items: [input.slug] },
        cwd: input.cwd,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      deps,
    );
    if (!result.ok) {
      throw new UiKitCliError(
        'VIEW_FAILED',
        `shadcn view ${input.slug} failed: ${(result.stderr || result.stdout).slice(0, 400)}`,
      );
    }
    text = result.stdout;
    origin = 'shadcn view';
  } else {
    const [slug] = assertBoardUiItems([input.slug]);
    const result = await callBoardUiTool(
      {
        tool: 'get_component',
        args: { name: slug },
        cwd: input.cwd,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      deps,
    );
    if (!result.ok) {
      throw new UiKitCliError(
        'VIEW_FAILED',
        `boardui get_component ${slug} failed: ${result.text.slice(0, 400)}`,
      );
    }
    text = result.text;
    origin = 'boardui get_component';
  }

  const tier: UiKitCachedTier =
    input.kit === 'boardui' ? (boardUiTierOf(input.slug) ?? 'unknown') : 'free';
  if (text.trim().length > 0) {
    try {
      writeCachedItem(
        { kit: input.kit, slug: input.slug, payload: text, source: origin, tier },
        cacheOptions,
      );
    } catch {
      // A cache that refuses the write (cap, read-only disk) must not fail the
      // read the caller actually asked for.
    }
  }
  return { kit: input.kit, slug: input.slug, source: text, fromCache: false, tier };
}

export interface DownloadResult {
  readonly cached: readonly string[];
  readonly failed: readonly { readonly slug: string; readonly reason: string }[];
}

/** Pull several items into the local cache so the kit works offline. */
export async function downloadItemsIntoCache(
  input: {
    readonly kit: UiKitId;
    readonly slugs: readonly string[];
    readonly cwd: string;
    readonly signal?: AbortSignal;
  },
  deps: UiKitServiceDeps = {},
): Promise<DownloadResult> {
  const cached: string[] = [];
  const failed: { slug: string; reason: string }[] = [];
  for (const slug of input.slugs) {
    try {
      await readItemSource(
        {
          kit: input.kit,
          slug,
          cwd: input.cwd,
          refresh: true,
          ...(input.signal ? { signal: input.signal } : {}),
        },
        deps,
      );
      cached.push(slug);
    } catch (error) {
      failed.push({
        slug,
        reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
    }
  }
  return { cached, failed };
}

/** Install items into the project. The one call that changes the user's code. */
export async function installItems(
  input: {
    readonly kit: UiKitId;
    readonly items: readonly string[];
    readonly cwd: string;
    readonly overwrite?: boolean;
    readonly path?: string;
    readonly signal?: AbortSignal;
  },
  deps: UiKitServiceDeps = {},
): Promise<UiKitRunResult> {
  if (input.kit === 'boardui') {
    return await runBoardUiCommand(
      {
        command: { kind: 'add', items: input.items },
        cwd: input.cwd,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      deps,
    );
  }
  return await runShadcnCommand(
    {
      command: {
        kind: 'add',
        items: input.items,
        ...(input.overwrite ? { overwrite: true } : {}),
        ...(input.path ? { path: input.path } : {}),
      },
      cwd: input.cwd,
      ...(input.signal ? { signal: input.signal } : {}),
    },
    deps,
  );
}

export type { BoardUiMcpTool };
