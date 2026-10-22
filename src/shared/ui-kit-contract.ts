import { z } from 'zod';

/**
 * Renderer ⇄ Main contract for the UI kits panel.
 *
 * Two rules shape it:
 *
 * - **No path crosses it.** The renderer never names a directory; Main resolves
 *   the active workspace itself. A panel that could pass a cwd would be a way
 *   to install components anywhere on the machine.
 * - **No secret comes back.** A licence or registry token goes IN and only a
 *   masked tail ever comes out.
 */

export const UI_KIT_CHANNELS = {
  status: 'ui-kit:status',
  catalog: 'ui-kit:catalog',
  install: 'ui-kit:install',
  license: 'ui-kit:license',
  registry: 'ui-kit:registry',
  cacheClear: 'ui-kit:cache-clear',
  externalKey: 'ui-kit:external-key',
} as const;

/**
 * External design credentials the panel may write, by NAME.
 *
 * An allowlist, not a free-form secret name: a channel that accepted any name
 * would let the renderer write over `auth:` or any other Main-owned secret.
 * `designmd-api-key` is here because nothing could set it before — the vault
 * was read for it and never written, so designmd.ai was unreachable in any
 * shipped build.
 */
export const UI_KIT_EXTERNAL_KEYS = {
  designmd: 'external:designmd-api-key',
} as const;
export type UiKitExternalKeyId = keyof typeof UI_KIT_EXTERNAL_KEYS;

export const uiKitExternalKeyRequestSchema = z
  .object({
    id: z.enum(['designmd']),
    /** Empty clears it. Never echoed back. */
    value: z.string().max(4096),
  })
  .strict();
export type UiKitExternalKeyRequest = z.infer<typeof uiKitExternalKeyRequestSchema>;

export interface UiKitExternalKeyView {
  readonly id: UiKitExternalKeyId;
  readonly stored: boolean;
  readonly error?: string;
}

export const uiKitIdSchema = z.enum(['shadcn', 'boardui']);
export type UiKitIdValue = z.infer<typeof uiKitIdSchema>;

export const uiKitCatalogRequestSchema = z
  .object({
    kit: uiKitIdSchema,
    query: z.string().max(128).optional(),
    cachedOnly: z.boolean().optional(),
  })
  .strict();
export type UiKitCatalogRequest = z.infer<typeof uiKitCatalogRequestSchema>;

export const uiKitInstallRequestSchema = z
  .object({
    kit: uiKitIdSchema,
    items: z.array(z.string().min(1).max(256)).max(32).optional(),
    recipe: z.string().min(1).max(64).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.recipe) || (value.items?.length ?? 0) > 0, {
    message: 'name items or a recipe',
  });
export type UiKitInstallRequest = z.infer<typeof uiKitInstallRequestSchema>;

export const uiKitLicenseRequestSchema = z
  .object({
    // `activate` reuses the key already in the vault: a licence stored with
    // no project open was never activated, and the operator should not have to
    // paste it again to finish.
    action: z.enum(['set', 'activate', 'remove', 'refresh']),
    /** Only on `set`. Never echoed back. */
    key: z.string().min(1).max(512).optional(),
  })
  .strict();
export type UiKitLicenseRequest = z.infer<typeof uiKitLicenseRequestSchema>;

export const uiKitRegistryInputSchema = z
  .object({
    namespace: z.string().min(2).max(48),
    url: z.string().min(1).max(512),
    label: z.string().max(64).optional(),
    auth: z
      .object({
        kind: z.enum(['header', 'param']),
        name: z.string().min(1).max(64),
        /**
         * Accepted for compatibility and IGNORED: Main derives the variable
         * from the namespace, because the name selects which credential is
         * read. The panel does not send it.
         */
        envVar: z.string().min(1).max(64).optional(),
        scheme: z.enum(['bearer', 'raw']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type UiKitRegistryInput = z.infer<typeof uiKitRegistryInputSchema>;

export const uiKitRegistryRequestSchema = z
  .object({
    action: z.enum(['set', 'remove']),
    registry: uiKitRegistryInputSchema.optional(),
    namespace: z.string().min(2).max(48).optional(),
    /** Token for this registry. Stored in the vault; never echoed back. */
    token: z.string().min(1).max(4096).optional(),
  })
  .strict();
export type UiKitRegistryRequest = z.infer<typeof uiKitRegistryRequestSchema>;

export const uiKitCacheClearRequestSchema = z
  .object({ kit: uiKitIdSchema })
  .strict();

export interface UiKitCatalogItemView {
  readonly slug: string;
  readonly label: string;
  readonly category: string;
  readonly tier: 'free' | 'pro' | 'unknown';
  readonly cached: boolean;
}

export interface UiKitRegistryView {
  readonly namespace: string;
  readonly url: string;
  readonly label?: string;
  readonly requiresToken: boolean;
  /**
   * The environment variable the CLI interpolates for this registry. The NAME
   * only — it is what goes into the project's components.json, and what an
   * operator exports to provision their own machines without pasting a key.
   */
  readonly envVar?: string;
  /** Whether a token is stored. The value itself never travels. */
  readonly tokenStored: boolean;
  /**
   * True when the token in use is the operator token bundled with Nexus: no
   * copy sits in this machine's vault. The panel must say "token do Nexus",
   * not "sem token" — installs work either way.
   */
  readonly operatorKey?: boolean;
}

export interface UiKitRecipeView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly roles: readonly string[];
}

export interface UiKitLicenseView {
  readonly state: 'active' | 'absent' | 'unknown';
  readonly stored: boolean;
  /** Masked tail only, e.g. `••••1234`. */
  readonly masked: string | null;
  /**
   * True when the licence in use is the operator key bundled with Nexus: no
   * key sits in this machine's vault. Pro works; the panel just must not
   * say "sem chave".
   */
  readonly operatorKey?: boolean;
  readonly detail?: string;
}

export interface UiKitKnownRegistryView {
  readonly namespace: string;
  readonly label: string;
  readonly url: string;
  readonly site: string;
  readonly note: string;
  /** True when this namespace is already configured. */
  readonly configured: boolean;
}

export interface UiKitStatusView {
  /** Absent when no project is open: nothing can be installed. */
  readonly workspaceOpen: boolean;
  readonly license: UiKitLicenseView;
  readonly registries: readonly UiKitRegistryView[];
  /** Vendors whose registry shape ships with Nexus; the token never does. */
  readonly knownRegistries: readonly UiKitKnownRegistryView[];
  readonly recipes: readonly UiKitRecipeView[];
  readonly cache: Readonly<Record<UiKitIdValue, { items: number; bytes: number }>>;
  /** Free item counts, so the panel can say what works with no key. */
  readonly freeItemCount: number;
  readonly proItemCount: number;
  /**
   * Why the registry write just refused, when it did. Transient: it is set on
   * the answer to that write and never by a plain status read, so the panel
   * can name the real cause instead of blaming the URL.
   */
  readonly registryError?: string;
  /**
   * The namespace that was just SAVED, set only where the write actually
   * happened. The panel used to read "this namespace is in the list" as
   * success, which is wrong twice over: an exception in validation or
   * persistence returns the previous list (same namespace still there), and a
   * namespace whose shape ships with Nexus appears in the effective list even
   * when no settings row was written. Presence is not a receipt.
   */
  readonly registrySaved?: string;
}

export interface UiKitCatalogView {
  readonly kit: UiKitIdValue;
  readonly items: readonly UiKitCatalogItemView[];
  /** True when the list came from scraping CLI text, not a typed source. */
  readonly bestEffort: boolean;
  /**
   * Registries configured here that the PROJECT's components.json does not
   * declare. The search cannot reach them and their token is withheld, so the
   * panel names them instead of showing an empty list.
   */
  readonly unmappedRegistries?: readonly string[];
  readonly error?: string;
}

export interface UiKitInstallView {
  readonly ok: boolean;
  readonly installed: readonly string[];
  readonly unresolved?: readonly string[];
  readonly needsLicense?: readonly string[];
  /**
   * How the licence itself read when something needed one: `absent` means no
   * key is stored, `unknown` means the vendor could not be asked. Without
   * this the panel could only say "it failed".
   */
  readonly licenseState?: 'active' | 'absent' | 'unknown';
  readonly missingRegistryKeys?: readonly string[];
  readonly output?: string;
  readonly error?: string;
}
