import { handleTrusted } from '../security/trusted-ipc';
import { activeWorkspaceRoot } from '../orch/workspace-path';
import { getOrchSettings, replaceOrchSettings } from '../persistence/settings-store';
import {
  UI_KIT_CHANNELS,
  uiKitCacheClearRequestSchema,
  uiKitCatalogRequestSchema,
  uiKitInstallRequestSchema,
  uiKitLicenseRequestSchema,
  uiKitExternalKeyRequestSchema,
  uiKitRegistryRequestSchema,
  UI_KIT_EXTERNAL_KEYS,
  type UiKitCatalogItemView,
  type UiKitCatalogView,
  type UiKitExternalKeyView,
  type UiKitInstallView,
  type UiKitLicenseView,
  type UiKitStatusView,
} from '../../shared/ui-kit-contract';
import { UI_KIT_IDS, type UiKitId } from './ui-kit-cli';
import {
  boardUiFreeItems,
  boardUiProItems,
  BOARDUI_LICENSE_SECRET,
} from './boardui-source';
import {
  clearUiKitCache,
  listCachedItems,
  uiKitCacheUsage,
  type UiKitCachedTier,
} from './ui-kit-cache';
import { liveCandidates, offlineCandidates } from './ui-kit-catalog';
import { installViewFromPlan, installViewFromRun } from './ui-kit-install-view';
import {
  assertRegistry,
  registrySecretKey,
  KNOWN_UI_KIT_REGISTRIES,
  type UiKitRegistry,
} from './ui-kit-registry';
import {
  findUiKitRecipe,
  resolveUiKitRecipe,
  UI_KIT_RECIPES,
} from './ui-kit-recipes';
import {
  activateBoardUiLicense,
  boardUiLicenseStatus,
  deactivateBoardUiLicense,
  installItems,
} from './ui-kit-service';

/**
 * IPC for the UI kits panel.
 *
 * `handleTrusted` means only the main window's main frame reaches these. Two
 * invariants on top of that:
 *
 * - The renderer never sends a path. The working directory is
 *   `activeWorkspaceRoot()`, resolved here, so the panel cannot aim an install
 *   at a directory outside the open project.
 * - A secret only travels inward. Setting a licence or a registry token takes
 *   the value; every response carries at most a masked tail.
 */

function configuredRegistries(): readonly UiKitRegistry[] {
  const settings = getOrchSettings() as { uiKitRegistries?: readonly UiKitRegistry[] };
  return settings.uiKitRegistries ?? [];
}

function serviceDeps() {
  return { registries: configuredRegistries };
}

function secrets(): typeof import('../persistence/secrets-store') {
  // Lazy: secrets-store touches electron/safeStorage.
  return require('../persistence/secrets-store') as typeof import('../persistence/secrets-store');
}

function workspaceRootOrNull(): string | null {
  try {
    const root = activeWorkspaceRoot();
    return root && root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

function emptyLicense(): UiKitLicenseView {
  return { state: 'unknown', stored: false, masked: null };
}

async function buildStatus(): Promise<UiKitStatusView> {
  const cwd = workspaceRootOrNull();
  const registries = configuredRegistries();
  const vault = secrets();

  let license: UiKitLicenseView = emptyLicense();
  if (cwd) {
    const status = await boardUiLicenseStatus({ cwd }, serviceDeps());
    license = {
      state: status.state,
      stored: status.stored,
      masked: status.masked,
      ...(status.detail ? { detail: status.detail.slice(0, 200) } : {}),
    };
  } else {
    const stored = vault.getSecret(BOARDUI_LICENSE_SECRET);
    license = {
      state: 'unknown',
      stored: Boolean(stored),
      masked: null,
      detail: 'Open a project to check the licence.',
    };
  }

  const cache = Object.fromEntries(
    UI_KIT_IDS.map((kit) => [kit, uiKitCacheUsage(kit)]),
  ) as UiKitStatusView['cache'];

  return {
    workspaceOpen: Boolean(cwd),
    license,
    registries: registries.map((registry) => ({
      namespace: registry.namespace,
      url: registry.url,
      ...(registry.label ? { label: registry.label } : {}),
      requiresToken: Boolean(registry.auth),
      tokenStored: Boolean(
        registry.secretKey && vault.getSecret(registry.secretKey),
      ),
    })),
    knownRegistries: KNOWN_UI_KIT_REGISTRIES.map((entry) => ({
      namespace: entry.namespace,
      label: entry.label,
      url: entry.url,
      site: entry.site,
      note: entry.note,
      configured: registries.some((r) => r.namespace === entry.namespace),
    })),
    recipes: UI_KIT_RECIPES.map((recipe) => ({
      id: recipe.id,
      label: recipe.label,
      description: recipe.description,
      roles: recipe.roles.map((role) => role.key),
    })),
    cache,
    freeItemCount: boardUiFreeItems().length,
    proItemCount: boardUiProItems().length,
  };
}

async function buildCatalog(
  kit: UiKitId,
  query: string | undefined,
  cachedOnly: boolean,
): Promise<UiKitCatalogView> {
  const cached = new Set(listCachedItems(kit).map((entry) => entry.slug));
  const view = (
    candidates: readonly { slug: string; label: string; category: string; tier: UiKitCachedTier }[],
  ): readonly UiKitCatalogItemView[] =>
    candidates
      .filter((entry) => !cachedOnly || cached.has(entry.slug))
      .map((entry) => ({
        slug: entry.slug,
        label: entry.label,
        category: entry.category,
        tier: entry.tier,
        cached: cached.has(entry.slug),
      }));

  const cwd = workspaceRootOrNull();
  // Offline is the honest answer when nothing may run: `cachedOnly` is the
  // operator asking for it, and with no project open there is no directory to
  // run a vendor CLI in.
  if (cachedOnly || !cwd) {
    return {
      kit,
      items: view(offlineCandidates(kit, query)),
      bestEffort: false,
      ...(cwd ? {} : { error: 'no project is open' }),
    };
  }

  try {
    // The LIVE list, through the same function the agent tools and the recipe
    // use. This panel built its own BoardUI list from the bundled snapshot,
    // which deliberately holds no Pro entry — so an operator who had paid for
    // the licence could not see a single thing it bought.
    const live = await liveCandidates(kit, cwd, query, serviceDeps());
    return {
      kit,
      items: view(live.candidates),
      bestEffort: live.bestEffort,
      ...(live.error ? { error: live.error } : {}),
    };
  } catch (error) {
    return {
      kit,
      items: view(offlineCandidates(kit, query)),
      bestEffort: true,
      error: error instanceof Error ? error.message.slice(0, 300) : 'search failed',
    };
  }
}

export function registerUiKitIpc(): void {
  handleTrusted(UI_KIT_CHANNELS.status, async (): Promise<UiKitStatusView> => {
    try {
      return await buildStatus();
    } catch {
      return {
        workspaceOpen: false,
        license: emptyLicense(),
        registries: [],
        knownRegistries: [],
        recipes: [],
        cache: Object.fromEntries(
          UI_KIT_IDS.map((kit) => [kit, { items: 0, bytes: 0 }]),
        ) as UiKitStatusView['cache'],
        freeItemCount: 0,
        proItemCount: 0,
      };
    }
  });

  handleTrusted(
    UI_KIT_CHANNELS.catalog,
    async (_event, raw): Promise<UiKitCatalogView> => {
      const parsed = uiKitCatalogRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return { kit: 'shadcn', items: [], bestEffort: false, error: 'invalid request' };
      }
      return await buildCatalog(
        parsed.data.kit,
        parsed.data.query,
        parsed.data.cachedOnly === true,
      );
    },
  );

  handleTrusted(
    UI_KIT_CHANNELS.install,
    async (_event, raw): Promise<UiKitInstallView> => {
      const parsed = uiKitInstallRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, installed: [], error: 'invalid request' };
      }
      const cwd = workspaceRootOrNull();
      if (!cwd) {
        return { ok: false, installed: [], error: 'no project is open' };
      }
      const { kit, recipe: recipeId, items, dryRun } = parsed.data;

      try {
        if (recipeId) {
          const recipe = findUiKitRecipe(recipeId);
          if (!recipe) {
            return { ok: false, installed: [], error: `unknown recipe: ${recipeId}` };
          }
          const license =
            kit === 'boardui'
              ? await boardUiLicenseStatus({ cwd }, serviceDeps())
              : null;
          const catalog = await buildCatalog(kit, undefined, false);
          const resolved = resolveUiKitRecipe({
            recipe,
            kit,
            candidates: catalog.items.map((entry) => ({
              kit,
              slug: entry.slug,
              label: entry.label,
              category: entry.category,
              tier: entry.tier,
            })),
            proLicensed: license?.state === 'active',
          });
          if (dryRun === true || resolved.install.length === 0) {
            return installViewFromPlan(resolved);
          }
          const run = await installItems(
            { kit, items: resolved.install, cwd },
            serviceDeps(),
          );
          return installViewFromRun(run, {
            requested: resolved.install,
            recipe: resolved,
          });
        }

        const run = await installItems(
          { kit, items: items ?? [], cwd },
          serviceDeps(),
        );
        return installViewFromRun(run, { requested: items ?? [] });
      } catch (error) {
        return {
          ok: false,
          installed: [],
          error: error instanceof Error ? error.message.slice(0, 300) : 'install failed',
        };
      }
    },
  );

  handleTrusted(
    UI_KIT_CHANNELS.license,
    async (_event, raw): Promise<UiKitLicenseView> => {
      const parsed = uiKitLicenseRequestSchema.safeParse(raw);
      if (!parsed.success) return emptyLicense();
      const cwd = workspaceRootOrNull();

      try {
        if (parsed.data.action === 'set') {
          const key = parsed.data.key;
          if (!key) return await buildLicenseView(cwd);
          if (!cwd) {
            // Store it anyway: the key is the operator's, and a closed project
            // is no reason to make them paste it again later.
            const write = secrets().setSecret(BOARDUI_LICENSE_SECRET, key.trim());
            return {
              state: 'unknown',
              stored: write.ok,
              masked: null,
              detail: write.ok
                ? 'Stored. Open a project to activate it.'
                : (write.error ?? 'vault write refused'),
            };
          }
          const result = await activateBoardUiLicense({ key, cwd }, serviceDeps());
          const view = await buildLicenseView(cwd);
          return {
            ...view,
            stored: result.stored,
            ...(result.detail ? { detail: result.detail.slice(0, 200) } : {}),
          };
        }
        if (parsed.data.action === 'remove') {
          if (cwd) await deactivateBoardUiLicense({ cwd }, serviceDeps());
          else secrets().setSecret(BOARDUI_LICENSE_SECRET, '');
          return { state: 'absent', stored: false, masked: null };
        }
        return await buildLicenseView(cwd);
      } catch (error) {
        return {
          state: 'unknown',
          stored: Boolean(secrets().getSecret(BOARDUI_LICENSE_SECRET)),
          masked: null,
          detail: error instanceof Error ? error.message.slice(0, 200) : undefined,
        };
      }
    },
  );

  handleTrusted(
    UI_KIT_CHANNELS.registry,
    async (_event, raw): Promise<UiKitStatusView> => {
      const parsed = uiKitRegistryRequestSchema.safeParse(raw);
      if (!parsed.success) return await buildStatus();
      const current = [...configuredRegistries()];

      try {
        if (parsed.data.action === 'remove') {
          const namespace = parsed.data.namespace;
          if (namespace) {
            const victim = current.find((entry) => entry.namespace === namespace);
            if (victim?.secretKey) secrets().setSecret(victim.secretKey, '');
            replaceOrchSettings({
              uiKitRegistries: current.filter(
                (entry) => entry.namespace !== namespace,
              ),
            } as never);
          }
          return await buildStatus();
        }

        const input = parsed.data.registry;
        if (!input) return await buildStatus();
        // The panel sends namespace + URL + token. The auth CONTRACT (header
        // name and the variable the CLI interpolates) is derived here: the
        // renderer should not have to invent it, and a token with nowhere to
        // go would be stored and never used.
        const auth =
          input.auth ??
          (parsed.data.token
            ? {
                kind: 'header' as const,
                name: 'Authorization',
                envVar: `${input.namespace.replace(/^@/, '').replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}_REGISTRY_TOKEN`,
              }
            : undefined);
        // Validated here, before anything is persisted: https only, `{name}`
        // present, no credentials in the URL, header/env names well formed.
        const registry = assertRegistry({
          ...input,
          ...(auth ? { auth } : {}),
          secretKey: registrySecretKey(input.namespace),
        });
        const next = [
          ...current.filter((entry) => entry.namespace !== registry.namespace),
          registry,
        ];
        replaceOrchSettings({ uiKitRegistries: next } as never);
        if (parsed.data.token && registry.secretKey) {
          secrets().setSecret(registry.secretKey, parsed.data.token.trim());
        }
        return await buildStatus();
      } catch {
        return await buildStatus();
      }
    },
  );

  handleTrusted(
    UI_KIT_CHANNELS.externalKey,
    (_event, raw): UiKitExternalKeyView => {
      const parsed = uiKitExternalKeyRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return { id: 'designmd', stored: false, error: 'invalid request' };
      }
      // Only a name from the allowlist reaches the vault, so this channel can
      // never be used to write over a Main-owned secret.
      const secretName = UI_KIT_EXTERNAL_KEYS[parsed.data.id];
      const value = parsed.data.value.trim();
      const vault = secrets();
      const write = vault.setSecret(secretName, value);
      return {
        id: parsed.data.id,
        stored: value.length > 0 && write.ok,
        ...(write.ok ? {} : { error: write.error ?? 'vault write refused' }),
      };
    },
  );

  handleTrusted(UI_KIT_CHANNELS.cacheClear, async (_event, raw) => {
    const parsed = uiKitCacheClearRequestSchema.safeParse(raw);
    if (parsed.success) {
      try {
        clearUiKitCache(parsed.data.kit);
      } catch {
        // Nothing cached, or a read-only disk: the status below tells the truth.
      }
    }
    return await buildStatus();
  });
}

async function buildLicenseView(cwd: string | null): Promise<UiKitLicenseView> {
  if (!cwd) {
    return {
      state: 'unknown',
      stored: Boolean(secrets().getSecret(BOARDUI_LICENSE_SECRET)),
      masked: null,
      detail: 'Open a project to check the licence.',
    };
  }
  const status = await boardUiLicenseStatus({ cwd }, serviceDeps());
  return {
    state: status.state,
    stored: status.stored,
    masked: status.masked,
    ...(status.detail ? { detail: status.detail.slice(0, 200) } : {}),
  };
}
