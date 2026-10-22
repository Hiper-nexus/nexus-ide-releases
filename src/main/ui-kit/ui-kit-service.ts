import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../util/atomic-write';
import {
  assertPathStaysInProject,
  assertSafeUiKitCwd,
  runUiKitCli,
  UiKitCliError,
  type UiKitCliRunner,
  type UiKitId,
} from './ui-kit-cli';
import { callMcpToolOnce } from './ui-kit-mcp-call';
import {
  buildShadcnArgs,
  classifyShadcnItem,
  referencedShadcnNamespaces,
  shadcnCommandAcceptsCwd,
  shadcnCommandWrites,
  type ShadcnCommand,
} from './shadcn-source';
import {
  assertBoardUiItems,
  assertBoardUiLicenseKey,
  assertBoardUiTool,
  boardUiCommandNeedsProject,
  boardUiCommandWrites,
  boardUiToolWrites,
  boardUiTierOf,
  buildBoardUiArgs,
  sanitizeBoardUiToolArgs,
  maskBoardUiLicenseKey,
  BOARDUI_CATALOG_SNAPSHOT,
  BOARDUI_LICENSE_SECRET,
  type BoardUiCliCommand,
  type BoardUiMcpTool,
} from './boardui-source';
import {
  buildScopedRegistryEnv,
  envVarReferences,
  mergeRegistriesIntoComponentsJson,
  projectRegistryEntries,
  projectRegistryUrls,
  registryEntryNeedsAuth,
  SHADCN_DEFAULT_NAMESPACE,
  withOperatorRegistries,
  type UiKitRegistry,
} from './ui-kit-registry';
import {
  OPERATOR_BOARDUI_LICENSE_KEY,
  hasOperatorBoardUiLicenseKey,
  operatorBoardUiLicenseFile,
} from './ui-kit-operator-keys';
import {
  isProvisionedBoardUiLicense,
  realBoardUiLicenseFileOps,
  type BoardUiLicenseFileOps,
} from './boardui-license-file';
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
  /** Licence-file access; the default touches the real config root. */
  readonly boardUiLicenseFile?: BoardUiLicenseFileOps;
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

/**
 * The registries this machine actually resolves against: what the operator
 * configured, plus the namespaces the operator bundles a token for (decision
 * 21/10 — `ui-kit-operator-keys.ts`). Merged HERE, at the resolution point,
 * so every door (panel, MCP tools, search, install) sees the same set
 * without each caller remembering to merge.
 */
function activeRegistries(deps: UiKitServiceDeps): readonly UiKitRegistry[] {
  return withOperatorRegistries(deps.registries?.() ?? []);
}

/**
 * The BoardUI licence key in effect on this machine: the operator's vault
 * copy first, then the key bundled with Nexus. Last resort by design, so a
 * key typed in Settings (a newer one, say) always wins.
 */
function effectiveBoardUiLicenseKey(deps: UiKitServiceDeps): string | null {
  const stored = vault(deps).get(BOARDUI_LICENSE_SECRET);
  if (stored && stored.trim().length > 0) return stored.trim();
  return hasOperatorBoardUiLicenseKey() ? OPERATOR_BOARDUI_LICENSE_KEY.trim() : null;
}

/**
 * True when the licence in use is the operator key bundled with Nexus: no key
 * in this machine's vault. The panel says so instead of "sem chave", because
 * Pro items DO work — the key is just not this machine's own.
 */
function boardUiLicenseUsesOperatorKey(deps: UiKitServiceDeps): boolean {
  const stored = vault(deps).get(BOARDUI_LICENSE_SECRET);
  return !(stored && stored.trim().length > 0) && hasOperatorBoardUiLicenseKey();
}

/**
 * Every path in a command, as the STRING THAT WILL REACH ARGV.
 *
 * Two review findings shaped this. It used to return the raw field while the
 * builder ran `raw.trim()`, so `" components"` was checked and `"components"`
 * was run — a check of a path that is not the one used. And it enumerated
 * three kinds by hand, so `view` and `docs` (which also take a local path)
 * were never checked and a new kind would silently skip.
 *
 * Now it is an exhaustive switch — a new command kind fails to compile until
 * it says what its paths are — and items go through `classifyShadcnItem`, so
 * only a genuine local path is treated as one.
 */
function relativeItems(items: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    try {
      if (classifyShadcnItem(item) === 'relative') out.push(item);
    } catch {
      // Malformed items are the builder's refusal to make, not ours.
    }
  }
  return out;
}

function destinationsIn(command: ShadcnCommand): readonly string[] {
  switch (command.kind) {
    case 'init':
      return command.items ? relativeItems(command.items) : [];
    case 'add':
      return [
        ...(command.all ? [] : relativeItems(command.items)),
        ...(command.path ? [command.path.trim()] : []),
      ];
    case 'view':
      return relativeItems(command.items);
    case 'docs':
      return command.component ? relativeItems([command.component]) : [];
    case 'build':
      return [
        ...(command.registry ? [command.registry.trim()] : []),
        ...(command.output ? [command.output.trim()] : []),
      ];
    case 'apply':
    case 'preset-decode':
    case 'preset-resolve':
    case 'preset-url':
    case 'search':
    case 'info':
    case 'migrate':
    case 'eject':
      return [];
    default: {
      const exhaustive: never = command;
      throw new UiKitCliError(
        'UNKNOWN_COMMAND',
        `no destination policy for command: ${JSON.stringify(exhaustive).slice(0, 64)}`,
      );
    }
  }
}

function boardUiDestinationsIn(command: BoardUiCliCommand): readonly string[] {
  switch (command.kind) {
    case 'list':
      return [];
    case 'init':
      return command.dir ? [command.dir.trim()] : [];
    case 'add':
      return [
        ...(command.path ? [command.path.trim()] : []),
        ...(command.dir ? [command.dir.trim()] : []),
      ];
    default: {
      const exhaustive: never = command;
      throw new UiKitCliError(
        'UNKNOWN_COMMAND',
        `no destination policy for command: ${JSON.stringify(exhaustive).slice(0, 64)}`,
      );
    }
  }
}

export interface UiKitRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  /** Namespaces whose token is configured but absent from the vault. */
  readonly missingRegistryKeys: readonly string[];
  /**
   * Namespaces the project's components.json points at a different host than
   * the one configured here. No token was released for them.
   */
  readonly registryConflicts?: readonly string[];
  /** Configured and referenced, but not declared by the project. */
  readonly unmappedRegistries?: readonly string[];
  /**
   * No token was released: the run touches a namespace we cannot vouch for, or
   * another entry in the project's file references the token's variable.
   */
  readonly withheldRegistries?: readonly string[];
  /** BoardUI Pro items the run refused because no licence is active. */
  readonly needsLicense?: readonly string[];
  readonly licenseState?: BoardUiLicenseState;
}

export const COMPONENTS_JSON = 'components.json';

/** Read the project's components.json. Absent or unparseable reads as null. */
export function readComponentsJson(
  cwd: string,
  deps: { readonly readFile?: (file: string) => string } = {},
): Record<string, unknown> | null {
  const read = deps.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'));
  try {
    const parsed = JSON.parse(read(path.join(cwd, COMPONENTS_JSON))) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface EnsureRegistriesResult {
  readonly wrote: readonly string[];
  readonly conflicts: readonly string[];
  readonly componentsJsonMissing: boolean;
}

/**
 * Make sure the project declares the namespaces we manage, so shadcn can
 * resolve them and the token has somewhere legitimate to go.
 *
 * A namespace the project already points elsewhere is NOT overwritten: that
 * mapping is the project's, and silently repointing it would be the same class
 * of surprise as leaking the token to it. It comes back as a conflict.
 */
export function ensureProjectRegistries(
  cwd: string,
  registries: readonly UiKitRegistry[],
  deps: {
    readonly readFile?: (file: string) => string;
    readonly writeFile?: (file: string, value: string) => void;
  } = {},
): EnsureRegistriesResult {
  const existing = readComponentsJson(cwd, deps);
  if (!existing) {
    return { wrote: [], conflicts: [], componentsJsonMissing: true };
  }
  const declared = projectRegistryUrls(existing);
  const entries = projectRegistryEntries(existing);
  const mine = registries.filter((registry) => {
    const current = declared.get(registry.namespace);
    if (current === undefined) return true;
    // Already pointing at OUR host but interpolating nothing — a bare URL
    // string, say. Left alone, shadcn sends the request unauthenticated and
    // the registry answers 401, so the entry gets completed with the
    // `${VAR}` reference. A mapping to another host is a conflict, below, and
    // an entry with the project's own headers is never touched.
    return (
      current === registry.url &&
      registryEntryNeedsAuth(registry, entries.get(registry.namespace))
    );
  });
  const conflicts = registries
    .filter((registry) => {
      const current = declared.get(registry.namespace);
      return current !== undefined && current !== registry.url;
    })
    .map((registry) => registry.namespace);

  if (mine.length === 0) {
    return { wrote: [], conflicts, componentsJsonMissing: false };
  }
  const merged = mergeRegistriesIntoComponentsJson(existing, mine);
  const write =
    deps.writeFile ??
    // components.json is project configuration, not a secret: 0644.
    ((file: string, value: string) => writeFileAtomic(file, value, 0o644));
  write(path.join(cwd, COMPONENTS_JSON), `${JSON.stringify(merged, null, 2)}\n`);
  return {
    wrote: mine.map((registry) => registry.namespace),
    conflicts,
    componentsJsonMissing: false,
  };
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
  const registries = activeRegistries(deps);
  const { get } = vault(deps);
  // EVERYTHING that can refuse this run happens before the project's config is
  // touched: argv validation (a malformed or option-shaped item) and path
  // containment. A registry mapping written for a run that is then rejected
  // leaves the project changed by something that never executed.
  const args = buildShadcnArgs(input.command);
  for (const destination of destinationsIn(input.command)) {
    assertPathStaysInProject(input.cwd, destination);
  }
  // Credential scope: only the namespaces THIS command names, and only when
  // the project points them at the host configured here.
  const referenced = referencedShadcnNamespaces(input.command);
  const needed = registries.filter((registry) =>
    referenced.includes(registry.namespace),
  );
  // Declaring our namespaces writes the project's components.json, so it only
  // happens for a command that was already going to change the project. A
  // SEARCH that quietly edited project config would not be a read, and the
  // catalog tool is classified read-only precisely because it is one: an
  // undeclared namespace comes back in `unmappedRegistries` instead.
  if (needed.length > 0 && shadcnCommandWrites(input.command)) {
    // The cwd guard BEFORE the write. `runUiKitCli` checks it too, but only
    // after this point: in a checkout whose node_modules is a shared symlink
    // the run is refused, and leaving the project's components.json edited by
    // a run that never happened is the worst of both.
    assertSafeUiKitCwd(input.cwd, { writes: true });
    ensureProjectRegistries(input.cwd, needed);
  }
  const components = readComponentsJson(input.cwd);
  const { env, missing, conflicts, unmapped, hijacked, unreferenced } = buildScopedRegistryEnv({
    registries,
    referenced,
    projectUrls: projectRegistryUrls(components),
    envReferences: envVarReferences(components),
    lookupSecret: get,
  });
  const run = deps.runCli ?? runUiKitCli;
  const result = await run({
    kit: 'shadcn',
    args,
    cwd: input.cwd,
    writes: shadcnCommandWrites(input.command),
    // Resolve the package outside the project and point the CLI back at it:
    // npm reads a `.npmrc` from its cwd and npx prefers a binary from the
    // cwd's node_modules, so with the project as cwd the REPOSITORY chose
    // which code ran. Measured: it went to the registry the repo named.
    resolveIn: 'isolated',
    cwdFlag: shadcnCommandAcceptsCwd(input.command),
    ...(Object.keys(env).length > 0 ? { extraEnv: env } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    missingRegistryKeys: missing,
    ...(conflicts.length > 0 ? { registryConflicts: conflicts } : {}),
    ...(unmapped.length > 0 ? { unmappedRegistries: unmapped } : {}),
    ...(hijacked.length > 0 || unreferenced.length > 0
      ? { withheldRegistries: [...hijacked, ...unreferenced] }
      : {}),
  };
}

/**
 * Run the BoardUI CLI (`init` / `add`).
 *
 * KNOWN LIMIT, written down rather than papered over: unlike shadcn this runs
 * with the project as cwd, because BoardUI has no `--cwd`. Its `-d, --dir` is
 * documented as "target directory (defaults to the project source root)" —
 * source root, not project root — and pointing it wrong would write components
 * somewhere silently wrong, which is worse than the residue. So the env pins
 * (registry, proxy, CA, strict-ssl) are what protect this path, and they are
 * measured to beat a hostile project `.npmrc`. What remains is a repository
 * that commits `node_modules/.bin/boardui`: npx would prefer it. Closing that
 * needs `--dir` or the MCP `projectDir` verified against a real install first.
 */
export async function runBoardUiCommand(
  input: {
    readonly command: BoardUiCliCommand;
    readonly cwd: string;
    readonly signal?: AbortSignal;
  },
  deps: UiKitServiceDeps = {},
): Promise<UiKitRunResult> {
  for (const destination of boardUiDestinationsIn(input.command)) {
    assertPathStaysInProject(input.cwd, destination);
  }
  const run = deps.runCli ?? runUiKitCli;
  const needsProject = boardUiCommandNeedsProject(input.command);
  const result = await run({
    kit: 'boardui',
    args: buildBoardUiArgs(input.command),
    cwd: input.cwd,
    writes: boardUiCommandWrites(input.command),
    // `list` resolves OUTSIDE the project (no `--cwd` needed: it prints the
    // vendor's catalogue and was measured working in an empty directory), so
    // browsing the catalogue cannot run a `node_modules/.bin/boardui` the
    // repository committed. `init` and `add` write into the project and have
    // no such escape — that limit is documented above.
    ...(needsProject ? {} : { resolveIn: 'isolated' as const }),
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
  /** Argument keys the allowlist refused (e.g. a projectDir override). */
  readonly droppedArgs?: readonly string[];
  /** Items the Pro gate refused, same shape the CLI path reports. */
  readonly needsLicense?: readonly string[];
  readonly licenseState?: BoardUiLicenseState;
}

/**
 * The Pro gate, in ONE place so both install doors use it: the CLI
 * (`installItems`) and the MCP tool (`install_components`).
 *
 * `autoActivate` is opt-in and only the INSTALL doors set it: when a key is in
 * effect on this machine (vault or operator bundle) but the licence is not
 * active, the gate activates it before deciding. A dry-run plan keeps the
 * default (false) — planning must not spend a vendor seat.
 */
async function gatedBoardUiItems(
  items: readonly string[],
  cwd: string,
  deps: UiKitServiceDeps,
  signal?: AbortSignal,
  options?: { readonly autoActivate?: boolean },
): Promise<{
  blocked: readonly string[];
  licenseState: BoardUiLicenseState;
  /** Set when auto-activation ran and did not reach an active licence. */
  readonly activationDetail?: string;
}> {
  const tiers = await Promise.all(
    items.map(async (item) => ({
      item,
      tier: await resolveBoardUiTier(item, cwd, deps),
    })),
  );
  // `unknown` is gated too: the snapshot not knowing a slug is not evidence
  // that it is free.
  const candidates = tiers
    .filter((entry) => entry.tier !== 'free')
    .map((entry) => entry.item);
  if (candidates.length === 0) {
    return { blocked: [], licenseState: 'unknown' };
  }
  let license = await boardUiLicenseStatus(
    { cwd, ...(signal ? { signal } : {}) },
    deps,
  );
  let activationDetail: string | undefined;
  if (
    license.state !== 'active' &&
    (options?.autoActivate ?? false) &&
    effectiveBoardUiLicenseKey(deps)
  ) {
    // Self-heal, once: a key exists here (the operator's, vault or bundle) but
    // this machine never activated it. A vault key ACTIVATES with the vendor;
    // the bundled one is PROVISIONED as a licence file — the same rule every
    // door uses, so seats are spent only where a human typed the key.
    try {
      const activated = await ensureActiveBoardUiLicense(
        { cwd, ...(signal ? { signal } : {}) },
        deps,
        // The status this gate just read IS the pre-check.
        { skipStatusPrecheck: true },
      );
      if (!activated.ok) {
        activationDetail = (activated.detail ?? 'activation failed').slice(0, 200);
      }
    } catch (error) {
      activationDetail =
        error instanceof Error ? error.message.slice(0, 200) : 'activation failed';
    }
    license = await boardUiLicenseStatus(
      { cwd, ...(signal ? { signal } : {}) },
      deps,
    );
  }
  return {
    blocked: license.state === 'active' ? [] : candidates,
    licenseState: license.state,
    ...(activationDetail ? { activationDetail } : {}),
  };
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
    /** Untrusted by design: the allowlist below is what makes it safe. */
    readonly args?: unknown;
    readonly cwd: string;
    readonly signal?: AbortSignal;
  },
  deps: UiKitServiceDeps = {},
): Promise<BoardUiToolResult> {
  const tool = assertBoardUiTool(input.tool);
  // Every path — tools and panel alike — goes through the allowlist, so a
  // `projectDir` can never redirect an install out of the execution scope.
  //
  // And `install_components` is an INSTALL: gating only the CLI path left a
  // second door, where a Pro or unknown-tier item reached the vendor and came
  // back with a generic failure instead of a named refusal.
  const sanitized = sanitizeBoardUiToolArgs(tool, input.args);
  const toolArguments: Record<string, unknown> = { ...sanitized.args };
  if (tool === 'activate_license') {
    const key = effectiveBoardUiLicenseKey(deps);
    if (!key) {
      throw new UiKitCliError(
        'NO_LICENSE_STORED',
        'no BoardUI licence is stored and none ships with this Nexus; add it in Settings first',
      );
    }
    toolArguments.licenseKey = assertBoardUiLicenseKey(key);
  }
  if (tool === 'install_components') {
    const requested = Array.isArray(toolArguments.components)
      ? (toolArguments.components as string[])
      : [];
    const gated = await gatedBoardUiItems(
      requested,
      input.cwd,
      deps,
      input.signal,
      { autoActivate: true },
    );
    if (gated.blocked.length > 0) {
      return {
        ok: false,
        isError: true,
        text:
          `BoardUI Pro licence required for: ${gated.blocked.join(', ')}. ` +
          'Store it in Settings → UI kits; the free items need no key.' +
          (gated.activationDetail
            ? ` (automatic activation failed: ${gated.activationDetail})`
            : ''),
        needsLicense: gated.blocked,
        licenseState: gated.licenseState,
        ...(sanitized.dropped.length > 0 ? { droppedArgs: sanitized.dropped } : {}),
      };
    }
  }
  if (tool === 'activate_license' || tool === 'deactivate_license') {
    // HERE, not only in the service wrappers. The agent surface reaches
    // `activate_license` through this function directly, so the invalidation
    // added to `activateBoardUiLicense` missed it entirely — and the free
    // listing stayed authoritative for the whole TTL after a key was added.
    // Putting it on the one call every door goes through closes the class
    // rather than the instance.
    invalidateBoardUiFreeList();
  }
  const call = deps.callMcp ?? callMcpToolOnce;
  const result = await call({
    kit: 'boardui',
    cwd: input.cwd,
    writes: boardUiToolWrites(tool),
    method: 'tools/call',
    tool,
    toolArguments,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    ok: !result.isError,
    text: result.text,
    isError: result.isError,
    ...(sanitized.dropped.length > 0 ? { droppedArgs: sanitized.dropped } : {}),
  };
}

/**
 * Negative states FIRST, and the positive token only on a word boundary.
 *
 * `'Invalid license'` contains `valid`, so a substring test read an unusable
 * key as ACTIVE — and a Pro recipe was then selected with it, moving the
 * failure to install time where nobody could explain it.
 */
const LICENSE_NEGATIVE_PHRASES = [
  'invalid',
  'not valid',
  'no valid',
  'not active',
  'inactive',
  'no license',
  'no licence',
  'not licensed',
  'unlicensed',
  'expired',
  'revoked',
  'deactivated',
  'not found',
] as const;

const LICENSE_POSITIVE_PATTERN = /\b(active|valid|licensed|licenced)\b/;

export function readsAsActiveLicense(lowercaseText: string): boolean {
  for (const phrase of LICENSE_NEGATIVE_PHRASES) {
    if (lowercaseText.includes(phrase)) return false;
  }
  return LICENSE_POSITIVE_PATTERN.test(lowercaseText);
}

export type BoardUiLicenseState = 'active' | 'absent' | 'unknown';

export interface BoardUiLicenseStatus {
  readonly state: BoardUiLicenseState;
  /** Masked tail only — never the key. */
  readonly masked: string | null;
  /** True when a key is stored in the Nexus vault, active or not. */
  readonly stored: boolean;
  /**
   * True when the licence in use is the operator key bundled with Nexus (no
   * key in this machine's vault). Pro works; the panel just must not say
   * "sem chave".
   */
  readonly operatorKey: boolean;
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
  const operatorKey = boardUiLicenseUsesOperatorKey(deps);
  try {
    const result = await callBoardUiTool(
      { tool: 'license_status', cwd: input.cwd, ...(input.signal ? { signal: input.signal } : {}) },
      deps,
    );
    const active = !result.isError && readsAsActiveLicense(result.text.toLowerCase());
    return {
      state: active ? 'active' : 'absent',
      masked,
      stored: Boolean(stored),
      operatorKey,
      detail: result.text.slice(0, 400),
    };
  } catch (error) {
    return {
      state: 'unknown',
      masked,
      stored: Boolean(stored),
      operatorKey,
      detail: error instanceof Error ? error.message.slice(0, 400) : undefined,
    };
  }
}

export interface ActivateLicenseResult {
  readonly ok: boolean;
  readonly stored: boolean;
  /**
   * True when the operator's licence file was PROVISIONED here (bundled key,
   * empty vault) instead of activated with the vendor. A provisioned
   * machine's "Remover" is local: the vendor seat belongs to the operator.
   */
  readonly provisioned?: boolean;
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
  // Before the vendor call, not after: whatever the activation answers, the
  // cached catalogue was read under the OLD licence state.
  invalidateBoardUiFreeList();
  try {
    const result = await callBoardUiTool(
      {
        tool: 'activate_license',
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

/**
 * Licence-file access for this run: injected by tests, the real config root
 * (the one the spawned MCP child resolves) otherwise.
 */
function boardUiLicenseFileOps(deps: UiKitServiceDeps): BoardUiLicenseFileOps {
  return deps.boardUiLicenseFile ?? realBoardUiLicenseFileOps();
}

/**
 * Activate whichever key this machine actually has: the vault copy when there
 * is one, otherwise the operator key bundled with Nexus.
 *
 * The bundled path does NOT call `activate_license` — it PROVISIONS the
 * operator's licence file instead (operator decision 21/10, "opção B"). The
 * vendor counts seats at activation only and both are used, so a third
 * activation would be refused outright; a provisioned file validates and
 * downloads Pro without consuming a seat (measured 21/10 on an isolated
 * HOME). Nothing is written to the vault either, so "Remover" stays honest —
 * on a provisioned machine it removes the file locally and never releases the
 * operator's own seat. Only an explicit 'set' in the panel persists a key.
 */
export async function activateEffectiveBoardUiLicense(
  input: { readonly cwd: string; readonly signal?: AbortSignal },
  deps: UiKitServiceDeps = {},
): Promise<ActivateLicenseResult> {
  return await ensureActiveBoardUiLicense(input, deps, {});
}

/**
 * The shared activation core, so the panel door and the install doors cannot
 * drift apart. A vault key ACTIVATES with the vendor (a real seat, the
 * operator's own typed key); the bundled key is PROVISIONED as a licence file.
 */
async function ensureActiveBoardUiLicense(
  input: { readonly cwd: string; readonly signal?: AbortSignal },
  deps: UiKitServiceDeps,
  options: { readonly skipStatusPrecheck?: boolean },
): Promise<ActivateLicenseResult> {
  const stored = vault(deps).get(BOARDUI_LICENSE_SECRET);
  if (stored && stored.trim().length > 0) {
    return activateBoardUiLicense(
      { key: stored, cwd: input.cwd, ...(input.signal ? { signal: input.signal } : {}) },
      deps,
    );
  }
  const bundled = effectiveBoardUiLicenseKey(deps);
  if (!bundled) {
    return {
      ok: false,
      stored: false,
      detail:
        'no BoardUI licence is stored and none ships with this Nexus; add it in Settings first',
    };
  }
  // A machine the vendor already counts as active (this Mac activated the key
  // before Nexus bundled it; a client that kept its own seat) has a licence
  // file worth protecting — provisioning would overwrite it. Ask the vendor
  // first; the install doors skip this only right after running it themselves.
  if (!options.skipStatusPrecheck) {
    const current = await boardUiLicenseStatus(
      { cwd: input.cwd, ...(input.signal ? { signal: input.signal } : {}) },
      deps,
    );
    if (current.state === 'active') {
      return {
        ok: true,
        stored: false,
        detail: current.detail ?? 'licence already active on this machine',
      };
    }
  }
  // THE FILE ITSELF DECIDES, not the vendor's verdict.
  //
  // The pre-check above asks the vendor, and a vendor that cannot be reached
  // answers `unknown` — on which the old code went ahead and overwrote. The
  // install doors are worse: they pass `skipStatusPrecheck` and never asked
  // at all. So a machine with its OWN licence file (this Mac before the key
  // was bundled; a client that paid for its own seat) could have that file
  // replaced by the operator's payload, destroying its instance identity and
  // stranding its paid activation.
  //
  // Reading the file is local: it cannot be `unknown`. Absence has to be
  // POSITIVELY established before anything is written, and a file that is not
  // already our payload is left exactly as it is.
  const ops = boardUiLicenseFileOps(deps);
  const existing = ops.read();
  if (existing && !isProvisionedBoardUiLicense(existing, operatorBoardUiLicenseFile())) {
    return {
      ok: false,
      stored: false,
      detail:
        'this machine has its own BoardUI licence file; Nexus did not touch it. ' +
        'Remove it yourself if you want the operator licence provisioned here.',
    };
  }
  invalidateBoardUiFreeList();
  // PROVISION, don't activate: writing the operator's licence file where the
  // CLI reads it is the whole trick — `validate` and every Pro download accept
  // key + instanceId from this machine, and no vendor seat is spent. The
  // vendor's own verdict follows; it does not count seats either.
  const write = ops.write(operatorBoardUiLicenseFile());
  if (!write.ok) {
    return {
      ok: false,
      stored: false,
      detail: write.error ?? 'could not provision the operator licence file',
    };
  }
  const after = await boardUiLicenseStatus(
    { cwd: input.cwd, ...(input.signal ? { signal: input.signal } : {}) },
    deps,
  );
  return {
    ok: after.state === 'active',
    stored: false,
    provisioned: true,
    detail:
      after.state === 'active'
        ? after.detail ?? 'operator licence provisioned on this machine'
        : after.detail ??
          'operator licence file provisioned; the vendor could not be reached to confirm it',
  };
}

/**
 * Release this machine's Pro seat and forget the stored key.
 *
 * A PROVISIONED machine has no seat of its own: its licence file is the
 * operator's payload, and `deactivate_license` would release the OPERATOR's
 * seat (their Mac), killing Pro for the whole fleet. There, "Remover" is
 * local — the file goes, the vendor is not called.
 */
export async function deactivateBoardUiLicense(
  input: { readonly cwd: string; readonly signal?: AbortSignal },
  deps: UiKitServiceDeps = {},
): Promise<ActivateLicenseResult> {
  const { set } = vault(deps);
  const ops = boardUiLicenseFileOps(deps);
  const file = ops.read();
  invalidateBoardUiFreeList();
  if (isProvisionedBoardUiLicense(file, operatorBoardUiLicenseFile())) {
    const removed = ops.remove();
    set(BOARDUI_LICENSE_SECRET, '');
    return {
      ok: removed.ok,
      stored: false,
      provisioned: true,
      detail: removed.ok
        ? 'operator licence removed from this machine; the vendor seat stays with the operator'
        : removed.error ?? 'could not remove the BoardUI licence file',
    };
  }
  if (!file) {
    // Nothing on disk to release with the vendor; the CLI would only answer
    // "no licence stored". Forget the key and stay honest.
    set(BOARDUI_LICENSE_SECRET, '');
    return {
      ok: true,
      stored: false,
      detail: 'no BoardUI licence file on this machine; the stored key was forgotten',
    };
  }
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
 * The TYPED parse of `shadcn search --json`, with the old scrape behind it.
 *
 * The CLI does have `--json` — `search --help` lists it and it answers
 * `{ items: [{ name, type, registry, addCommandArgument }] }` (measured
 * 2026-10-21 against shadcn@latest). This function used to scrape the text
 * output and report every search as best-effort because of a belief that it
 * did not. The scrape stays as a fallback for an older CLI, and only that
 * path is best-effort now.
 *
 * `type` is what keeps a recipe honest: `registry:example` items are demos,
 * and installing `button-demo` instead of `button` looks like success and is
 * wrong. Reading it from a typed field beats sniffing a trailing `(ui)`.
 */
export const SHADCN_DEMO_CATEGORY = 'example';

export interface ShadcnSearchParse {
  readonly candidates: readonly UiKitCandidate[];
  /** True when the list came from the text scrape rather than `--json`. */
  readonly bestEffort: boolean;
}

/** `registry:ui` → `ui`, so the demo check reads one typed field. */
function categoryFromType(type: unknown): string {
  if (typeof type !== 'string') return 'registry-item';
  const bare = type.includes(':') ? type.slice(type.indexOf(':') + 1) : type;
  return bare.trim().toLowerCase() || 'registry-item';
}

function candidateFromJsonItem(entry: unknown): UiKitCandidate | null {
  if (!entry || typeof entry !== 'object') return null;
  const row = entry as { name?: unknown; registry?: unknown; type?: unknown };
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (name.length === 0) return null;
  const registry =
    typeof row.registry === 'string' && row.registry.trim().startsWith('@')
      ? row.registry.trim()
      : SHADCN_DEFAULT_NAMESPACE;
  // The namespace is part of the IDENTIFIER for anything but the default
  // registry: installing `auth` instead of `@acme/auth` goes to the public
  // registry, and `referencedShadcnNamespaces` then sees no `@acme` and
  // withholds its token.
  const namespaced = registry !== SHADCN_DEFAULT_NAMESPACE;
  return {
    kit: 'shadcn',
    slug: namespaced ? `${registry}/${name}` : name,
    label: name,
    category: categoryFromType(row.type),
    tier: 'free',
  };
}

/** The typed answer, or `null` when this output is not `--json`'s. */
export function parseShadcnSearchJson(output: string): readonly UiKitCandidate[] | null {
  const start = output.indexOf('{');
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start));
  } catch {
    return null;
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) return null;
  const found = new Map<string, UiKitCandidate>();
  for (const entry of items) {
    const candidate = candidateFromJsonItem(entry);
    if (candidate && !found.has(candidate.slug)) found.set(candidate.slug, candidate);
  }
  return [...found.values()];
}

/** JSON first, the scrape behind it. */
export function parseShadcnSearch(output: string): ShadcnSearchParse {
  const typed = parseShadcnSearchJson(output);
  if (typed) return { candidates: typed, bestEffort: false };
  return { candidates: parseShadcnSearchOutput(output), bestEffort: true };
}

export function parseShadcnSearchOutput(
  output: string,
): readonly UiKitCandidate[] {
  const found = new Map<string, UiKitCandidate>();
  const linePattern =
    /(@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*)(?:\s*\(([a-z0-9:-]+)\))?/gi;
  for (const line of output.split('\n')) {
    const stripped = line.replace(/\u001b\[[0-9;]*m/g, '');
    for (const match of stripped.matchAll(linePattern)) {
      const token = match[1];
      if (!token || found.has(token)) continue;
      const bare = token.slice(token.indexOf('/') + 1);
      // The namespace is part of the IDENTIFIER for anything but the default
      // registry: installing `auth` instead of `@acme/auth` goes to the public
      // registry, and `referencedShadcnNamespaces` then sees no `@acme` and
      // withholds its token.
      const namespaced = !token.startsWith(`${SHADCN_DEFAULT_NAMESPACE}/`);
      found.set(token, {
        kit: 'shadcn',
        slug: namespaced ? token : bare,
        label: bare,
        category: match[2]?.toLowerCase() ?? 'registry-item',
        tier: 'free',
      });
    }
  }
  return [...found.values()];
}

/** BoardUI candidates from the offline snapshot, labelled with their tier. */
/** Parse `boardui list`: two-space-indented `slug   description` lines. */
export function parseBoardUiListOutput(output: string): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const line of output.replace(/\u001b\[[0-9;]*m/g, '').split('\n')) {
    const match = /^ {2}([a-z0-9][a-z0-9-]*)\s{2,}\S/.exec(line);
    if (match?.[1]) slugs.add(match[1]);
  }
  return slugs;
}

const BOARDUI_FREE_LIST_TTL_MS = 10 * 60 * 1000;
/**
 * The vendor's free catalogue, shared across projects.
 *
 * Shared is only safe because the single command that fills it (`list`) is
 * resolved and spawned OUTSIDE any project — see `boardUiCommandNeedsProject`.
 * Were it run in the project, one repository's output would be deciding tier
 * gating for every other project opened in this Nexus, and a repository that
 * commits `node_modules/.bin/boardui` chooses that output.
 */
let boardUiFreeListCache: { at: number; slugs: ReadonlySet<string> } | null = null;
/**
 * The fetch already in flight, keyed by the directory it runs in.
 *
 * The TTL cache alone does not collapse a burst: resolving the tier of 32
 * items runs `Promise.all`, so all 32 calls arrive before the first one has
 * populated anything, every one misses the empty cache, and the install
 * spawns 32 concurrent `npx boardui list`. Sharing the pending promise makes
 * a burst cost one vendor call.
 */
const boardUiFreeListInFlight = new Map<string, Promise<ReadonlySet<string> | null>>();
/**
 * Bumped by every invalidation. A listing that STARTED before the licence
 * changed must not be written after it: clearing the map only stopped new
 * callers from joining the old request, while its own closure still finished
 * and repopulated the cache with the pre-change answer — a late licensed
 * listing classifying Pro slugs as free for the whole TTL.
 */
let boardUiFreeListGeneration = 0;
/** Which attempt owns each cwd's slot, so a stale one cannot clear it. */
const boardUiFreeListAttempt = new Map<string, symbol>();

/** The live free catalogue. `null` when the vendor could not be reached. */
export async function listBoardUiFreeSlugs(
  cwd: string,
  deps: UiKitServiceDeps = {},
  now: number = Date.now(),
): Promise<ReadonlySet<string> | null> {
  if (boardUiFreeListCache && now - boardUiFreeListCache.at < BOARDUI_FREE_LIST_TTL_MS) {
    return boardUiFreeListCache.slugs;
  }
  const pending = boardUiFreeListInFlight.get(cwd);
  if (pending) return pending;
  const generation = boardUiFreeListGeneration;
  const attempt = Symbol('boardui-list');
  boardUiFreeListAttempt.set(cwd, attempt);
  const fetching = (async () => {
    try {
      const result = await runBoardUiCommand({ command: { kind: 'list' }, cwd }, deps);
      if (!result.ok) return null;
      const slugs = parseBoardUiListOutput(result.stdout);
      if (slugs.size === 0) return null;
      // The answer still goes back to whoever asked — it was true when the
      // request was made — but it is not CACHED across a licence change.
      if (generation === boardUiFreeListGeneration) {
        boardUiFreeListCache = { at: now, slugs };
      }
      return slugs;
    } catch {
      return null;
    } finally {
      // Only the attempt that still owns the slot clears it: a stale one
      // would otherwise delete the entry a newer request had just put there.
      if (boardUiFreeListAttempt.get(cwd) === attempt) {
        boardUiFreeListInFlight.delete(cwd);
        boardUiFreeListAttempt.delete(cwd);
      }
    }
  })();
  boardUiFreeListInFlight.set(cwd, fetching);
  return fetching;
}

/**
 * Drop the cached catalogue.
 *
 * The free list is a function of the LICENCE, not only of the vendor: with a
 * key active `boardui list` publishes the Pro items too. So a list captured
 * while unlicensed hid the items an activation had just unlocked (for up to
 * the TTL), and — the dangerous direction — a list captured while licensed
 * kept answering "free" for Pro slugs after the key was removed, which is the
 * gate letting a Pro item through. Both mutations therefore forget it.
 *
 * A key that lapses at the VENDOR is not observable from here; the TTL is what
 * bounds that case.
 */
export function invalidateBoardUiFreeList(): void {
  boardUiFreeListCache = null;
  boardUiFreeListInFlight.clear();
  boardUiFreeListAttempt.clear();
  boardUiFreeListGeneration += 1;
}

export function resetBoardUiFreeListCacheForTests(): void {
  invalidateBoardUiFreeList();
}

/**
 * The tier of one item, with the live catalogue as the authority.
 *
 * `boardUiTierOf` answers `null` for anything the snapshot does not list, and
 * its own contract says that must NOT be read as free: a Pro identifier the
 * snapshot never had (`template-home-dashboard`, say) would otherwise sail
 * past the licence gate and fail at the vendor. So an unknown slug is checked
 * against the live FREE list — absent from it means Pro, and an unreachable
 * vendor means `unknown`, which the gate treats as needing a licence rather
 * than as free.
 */
export async function resolveBoardUiTier(
  slug: string,
  cwd: string,
  deps: UiKitServiceDeps = {},
): Promise<'free' | 'pro' | 'unknown'> {
  if (boardUiTierOf(slug) === 'free') return 'free';
  const free = await listBoardUiFreeSlugs(cwd, deps);
  if (!free) return 'unknown';
  // Present in the listing reads as FREE. That is only sound because the
  // listing is dropped whenever the licence changes: with a key active the
  // vendor publishes the Pro items in the SAME list, so a stale licensed
  // listing would answer "free" for a Pro slug — the gate letting it through.
  return free.has(slug.trim().toLowerCase()) ? 'free' : 'pro';
}

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
  /** Whether the item is in the cache NOW — reported, never assumed. */
  readonly cached: boolean;
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
        cached: true,
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
  let cached = false;
  if (text.trim().length > 0) {
    try {
      writeCachedItem(
        { kit: input.kit, slug: input.slug, payload: text, source: origin, tier },
        cacheOptions,
      );
      cached = true;
    } catch {
      // A cache that refuses the write (cap, read-only disk) must not fail the
      // read the caller asked for — but it must not be reported as cached
      // either: saying so sent callers back for an item that was not there.
    }
  }
  return { kit: input.kit, slug: input.slug, source: text, fromCache: false, tier, cached };
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

export interface InstallPlan {
  /** What would be installed. */
  readonly install: readonly string[];
  /** Named items the licence would refuse. */
  readonly needsLicense: readonly string[];
  readonly licenseState?: BoardUiLicenseState;
}

/**
 * What installing these items WOULD do, writing nothing.
 *
 * The IPC accepted `dryRun` beside named items and then installed them: only
 * the recipe branch honoured the flag, so an explicit "show me" modified the
 * project and could pull dependencies. Everything here is a read — the Pro
 * gate asks the vendor for its free list and the licence status, neither of
 * which touches the project.
 */
export async function planInstallItems(
  input: {
    readonly kit: UiKitId;
    readonly items: readonly string[];
    readonly cwd: string;
    readonly signal?: AbortSignal;
  },
  deps: UiKitServiceDeps = {},
): Promise<InstallPlan> {
  if (input.kit !== 'boardui') {
    // shadcn has no licence; there is nothing to gate and nothing to ask.
    return { install: [...input.items], needsLicense: [] };
  }
  const gated = await gatedBoardUiItems(input.items, input.cwd, deps, input.signal);
  const blocked = new Set(gated.blocked);
  return {
    install: input.items.filter((item) => !blocked.has(item)),
    needsLicense: gated.blocked,
    licenseState: gated.licenseState,
  };
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
    // The Pro gate on the DIRECT path. It used to live only in the
    // recommendation and the recipe, so `nexus_ui_kit_add` with
    // `finance-dashboard` and no licence went straight to the vendor and came
    // back with a generic failure: no named item, no `needsLicense`.
    //
    // A direct install NAMES its items, so this refuses instead of
    // substituting — swapping an item the caller asked for by name would be
    // the surprise. Substitution belongs to the recipe, which picks for you.
    const gated = await gatedBoardUiItems(
      input.items,
      input.cwd,
      deps,
      input.signal,
      { autoActivate: true },
    );
    if (gated.blocked.length > 0) {
      return {
        ok: false,
        stdout: '',
        stderr:
          `BoardUI Pro licence required for: ${gated.blocked.join(', ')}. ` +
          'Store it in Settings → UI kits; the free items need no key.' +
          (gated.activationDetail
            ? ` (automatic activation failed: ${gated.activationDetail})`
            : ''),
        code: null,
        missingRegistryKeys: [],
        needsLicense: gated.blocked,
        licenseState: gated.licenseState,
      };
    }
    return await runBoardUiCommand(
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
