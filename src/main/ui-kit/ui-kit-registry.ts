import { UiKitCliError } from './ui-kit-cli';

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
  // The env var name is validated by the runner's credential-shape allowlist
  // when the value actually travels; shape-check it here so a bad config fails
  // at configuration time instead of at install time.
  if (!/^[A-Z][A-Z0-9_]*$/.test(auth.envVar) || auth.envVar.length > 64) {
    throw new UiKitCliError(
      'INVALID_AUTH_ENV',
      `a registry token env var is UPPER_SNAKE_CASE, got: ${auth.envVar.slice(0, 48)}`,
    );
  }
  return { ...auth, name, scheme: auth.scheme ?? 'bearer' };
}

export function assertRegistry(registry: UiKitRegistry): UiKitRegistry {
  const normalized: UiKitRegistry = {
    ...registry,
    namespace: assertRegistryNamespace(registry.namespace),
    url: assertRegistryUrl(registry.url),
    ...(registry.auth ? { auth: assertAuth(registry.auth) } : {}),
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

/** The vault key for a registry's token, derived from its namespace. */
export function registrySecretKey(namespace: string): string {
  const normalized = assertRegistryNamespace(namespace);
  return `external:ui-kit-registry-${normalized.slice(1)}`;
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

export interface ScopedRegistryEnvInput {
  readonly registries: readonly UiKitRegistry[];
  /** Namespaces the command actually references. */
  readonly referenced: readonly string[];
  /** What the project's components.json maps today. */
  readonly projectUrls: ReadonlyMap<string, string>;
  readonly lookupSecret: (secretKey: string) => string | null | undefined;
}

export interface ScopedRegistryEnvResult extends RegistryEnvResult {
  /** Namespaces the project maps to a DIFFERENT host than the one configured. */
  readonly conflicts: readonly string[];
  /** Configured and referenced, but the project does not declare them. */
  readonly unmapped: readonly string[];
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

  for (const registry of assertRegistries(input.registries)) {
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
    const token = registry.secretKey ? input.lookupSecret(registry.secretKey) : null;
    if (typeof token === 'string' && token.trim().length > 0) {
      env[registry.auth.envVar] = token.trim();
    } else {
      missing.push(registry.namespace);
    }
  }

  return { env, missing, conflicts, unmapped };
}
