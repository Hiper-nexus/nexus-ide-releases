import path from 'node:path';
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
  assertBoardUiLicenseKey,
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
import {
  installViewFromItemPlan,
  installViewFromPlan,
  installViewFromRun,
} from './ui-kit-install-view';
import {
  assertRegistry,
  normalizeConfiguredRegistries,
  persistableRegistry,
  planRegistryRemoval,
  registrySaveOutcome,
  registryRemovalOutcome,
  registrySecretKey,
  resolveRegistryAuthContract,
  derivedRegistryEnvVar,
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
  activateEffectiveBoardUiLicense,
  boardUiLicenseStatus,
  boardUiProSelectable,
  deactivateBoardUiLicense,
  installItems,
  planInstallItems,
  provisionBundledBoardUiLicense,
} from './ui-kit-service';
import {
  operatorTokenForRegistry,
  withOperatorRegistries,
} from './ui-kit-registry';
import { hasOperatorBoardUiLicenseKey } from './ui-kit-operator-keys';

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
  const settings = getOrchSettings() as { uiKitRegistries?: readonly unknown[] };
  // NORMALIZED on the way in: a settings file is data on disk, not a caller.
  // Each row is re-validated (a derived `secretKey` comes with it), an
  // unusable one is dropped rather than taken on trust — otherwise a stale
  // or hand-edited row could clear ANOTHER registry's token on removal, and
  // settings written here would carry vault names they should not hold.
  return normalizeConfiguredRegistries(settings.uiKitRegistries ?? []);
}

function serviceDeps() {
  return { registries: configuredRegistries };
}

type UiKitVault = Pick<
  typeof import('../persistence/secrets-store'),
  'getSecret' | 'setSecret'
>;

let vaultProvider: (() => UiKitVault) | null = null;

/**
 * The vault seam, same shape as `setUiKitCacheRootResolver`.
 *
 * The require below is lazy because secrets-store touches
 * electron/safeStorage, and under vitest it does not resolve at all — which is
 * what made this handler untestable, and is how three rounds in a row found it
 * ignoring an answer its own helpers had already given (a refused vault
 * delete, a dropped settings write, a token written before a failed persist).
 * Those are wiring defects: only the handler shows them. Production never sets
 * this, so the real vault stays the default.
 */
export function setUiKitVaultProvider(provider: (() => UiKitVault) | null): void {
  vaultProvider = provider;
}

function secrets(): UiKitVault {
  if (vaultProvider) return vaultProvider();
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
  return {
    state: 'unknown',
    stored: false,
    masked: null,
    operatorKey: hasOperatorBoardUiLicenseKey(),
  };
}

async function buildStatus(): Promise<UiKitStatusView> {
  const cwd = workspaceRootOrNull();
  const rawRegistries = configuredRegistries();
  // What the panel SHOWS is the effective list: the operator namespaces a
  // bundled token exists for appear even before anyone configures them. The
  // `configured` badge below still compares against the raw settings list,
  // because that word means "you typed it here".
  const registries = withOperatorRegistries(rawRegistries);
  const vault = secrets();

  const license = await licenseViewFor(cwd);

  const cache = Object.fromEntries(
    UI_KIT_IDS.map((kit) => [kit, uiKitCacheUsage(kit)]),
  ) as UiKitStatusView['cache'];

  return {
    workspaceOpen: Boolean(cwd),
    ...(cwd ? { workspaceName: path.basename(cwd) } : {}),
    license,
    registries: registries.map((registry) => {
      // DERIVED at the point of use: the row's own `secretKey` (settings can
      // carry one, merged operator rows carry one) never selects a secret.
      const tokenStored = Boolean(
        vault.getSecret(registrySecretKey(registry.namespace)),
      );
      return {
        namespace: registry.namespace,
        url: registry.url,
        ...(registry.label ? { label: registry.label } : {}),
        requiresToken: Boolean(registry.auth),
        ...(registry.auth ? { envVar: registry.auth.envVar } : {}),
        tokenStored,
        operatorKey: !tokenStored && operatorTokenForRegistry(registry) !== null,
        // Whether there is a SETTINGS ROW behind this entry. A known registry
        // saved at its preset URL with no vaulted token looked exactly like a
        // synthesized bundle entry, so the panel hid its "Remover" and the
        // operator had no way to delete the row they had just created.
        configured: rawRegistries.some(
          (entry) => entry.namespace === registry.namespace,
        ),
      };
    }),
    knownRegistries: KNOWN_UI_KIT_REGISTRIES.map((entry) => ({
      namespace: entry.namespace,
      label: entry.label,
      url: entry.url,
      site: entry.site,
      note: entry.note,
      configured: rawRegistries.some((r) => r.namespace === entry.namespace),
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
      ...(live.unmappedRegistries && live.unmappedRegistries.length > 0
        ? { unmappedRegistries: live.unmappedRegistries }
        : {}),
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

/**
 * Put the bundled BoardUI licence in place once the app is up.
 *
 * Operator 22/10: Pro unlocked on every machine, with nothing to click. Local
 * (one read, at most one atomic write, no vendor process), never on the boot
 * path itself and never fatal — every door that asks about Pro provisions
 * again on its own, so a failure here only costs the first answer.
 */
function scheduleBundledLicenceProvisioning(): void {
  setImmediate(() => {
    try {
      // Default deps on purpose: the vault is asked by presence only, which
      // never decrypts — a Keychain read on the main thread at boot is what
      // `hasSecret` exists to avoid.
      provisionBundledBoardUiLicense();
    } catch {
      // A machine whose config dir cannot be written keeps the old behaviour.
    }
  });
}

export function registerUiKitIpc(): void {
  scheduleBundledLicenceProvisioning();
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
          const proLicensed =
            kit === 'boardui'
              ? await boardUiProSelectable({ cwd }, serviceDeps())
              : false;
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
            proLicensed,
          });
          if (dryRun === true || resolved.install.length === 0) {
            return { ...installViewFromPlan(resolved), ...(dryRun === true ? { preview: true } : {}) };
          }
          const run = await installItems(
            { kit, items: resolved.install, cwd },
            serviceDeps(),
          );
          return installViewFromRun(run, {
            requested: resolved.install,
            recipe: resolved,
            kit,
          });
        }

        const named = items ?? [];
        if (dryRun === true) {
          return {
            ...installViewFromItemPlan(
              await planInstallItems({ kit, items: named, cwd }, serviceDeps()),
            ),
            preview: true,
          };
        }
        const run = await installItems({ kit, items: named, cwd }, serviceDeps());
        return installViewFromRun(run, { requested: named, kit });
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
          const raw = parsed.data.key;
          if (!raw) return await buildLicenseView(cwd);
          // THE SAME validation the activation does, before the vault write.
          // Storing a malformed key (internal whitespace, say) and reporting
          // success put a value in the vault that outranks the bundled key and
          // that the later "Activate" could only throw on — the promised
          // deferred activation was dead until the operator cleared it by hand.
          const key = assertBoardUiLicenseKey(raw);
          if (!cwd) {
            // Store it anyway: the key is the operator's, and a closed project
            // is no reason to make them paste it again later.
            const write = secrets().setSecret(BOARDUI_LICENSE_SECRET, key);
            return {
              state: 'unknown',
              stored: write.ok,
              masked: null,
              operatorKey: !write.ok && hasOperatorBoardUiLicenseKey(),
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
        if (parsed.data.action === 'activate') {
          // The key is already in the vault — stored before a project was
          // open, so nothing ever activated it. Finishing that must not
          // require pasting it again. With an empty vault the key that
          // ships with Nexus covers the same click (activation only; the
          // vault stays untouched so "Remover" keeps its meaning).
          if (!cwd) {
            return {
              ...(await buildLicenseView(cwd)),
              detail: 'Abra um projeto para ativar a chave.',
            };
          }
          const result = await activateEffectiveBoardUiLicense({ cwd }, serviceDeps());
          const view = await buildLicenseView(cwd);
          return {
            ...view,
            stored: result.stored,
            ...(result.detail ? { detail: result.detail.slice(0, 200) } : {}),
          };
        }
        if (parsed.data.action === 'remove') {
          if (!cwd) {
            // Clearing only the Nexus key would strand the vendor's machine
            // activation: the seat stays used, and with `stored: false` the
            // panel would hide the very control that releases it.
            return {
              ...(await buildLicenseView(cwd)),
              detail:
                'Abra um projeto para remover: sem ele a ativação continuaria ' +
                'presa no fornecedor, gastando um assento.',
            };
          }
          const removed = await deactivateBoardUiLicense({ cwd }, serviceDeps());
          if (!removed.ok) {
            // The vendor's deactivation can fail, and a provisioned licence
            // file can refuse to go. Reporting `absent` anyway told the
            // operator the paid seat was released when it was not.
            return {
              ...(await buildLicenseView(cwd)),
              detail:
                removed.detail ??
                'a licença não pôde ser removida; tente de novo ou remova o ' +
                  'arquivo de licença à mão',
            };
          }
          return {
            state: 'absent',
            stored: false,
            masked: null,
            operatorKey: hasOperatorBoardUiLicenseKey(),
          };
        }
        return await buildLicenseView(cwd);
      } catch (error) {
        return {
          state: 'unknown',
          stored: Boolean(secrets().getSecret(BOARDUI_LICENSE_SECRET)),
          masked: null,
          operatorKey:
            !secrets().getSecret(BOARDUI_LICENSE_SECRET) &&
            hasOperatorBoardUiLicenseKey(),
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
      // Armed only after the vault takes a NEW token, and fired on every path
      // that does not end in a saved registry. Without it, moving a namespace
      // to another host with a fresh token and then failing to persist left
      // the OLD url configured with the NEW host's credential behind it — the
      // next install would have sent that token to the old host.
      let rollbackToken: (() => string | null) | null = null;

      try {
        if (parsed.data.action === 'remove') {
          const namespace = parsed.data.namespace;
          if (namespace) {
            // The DERIVED vault key, not the stored row's `secretKey`: a
            // settings file that carries a foreign name must not clear that
            // secret here — only this namespace's own token ever goes.
            //
            // And the vault's ANSWER decides, in `planRegistryRemoval`: a
            // refused delete used to be ignored, so the row disappeared while
            // the token stayed behind it.
            const key = registrySecretKey(namespace);
            // Read BEFORE clearing: the vault goes first, so a settings write
            // that does not land must be able to put the token back.
            const before = secrets().getSecret(key) ?? '';
            const cleared = secrets().setSecret(key, '');
            const plan = planRegistryRemoval({
              registries: current,
              namespace,
              cleared,
            });
            if (!plan.removed) {
              return { ...(await buildStatus()), registryError: plan.error };
            }
            rollbackToken = () => {
              if (secrets().setSecret(key, before).ok) return null;
              return (
                'o cofre recusou devolver o token; a remoção não foi salva e a ' +
                'chave não está mais lá. Cadastre o registry de novo.'
              );
            };
            const persistedRemoval = replaceOrchSettings({
              uiKitRegistries: plan.registries.map(persistableRegistry),
            } as never);
            const removal = registryRemovalOutcome({
              namespace,
              persisted: persistedRemoval?.uiKitRegistries,
            });
            if (!removal.removed) {
              const undone = rollbackToken();
              return {
                ...(await buildStatus()),
                registryError: undone ? `${removal.error}. ${undone}` : removal.error,
              };
            }
          }
          return await buildStatus();
        }

        const input = parsed.data.registry;
        if (!input) return await buildStatus();
        // The panel sends namespace + URL + token; the auth CONTRACT is
        // resolved in ui-kit-registry, as a pure decision. (The claim that
        // used to be here — that this file cannot load under test — was
        // wrong, and the blind spot it created is where three rounds of review
        // found the handler dropping its helpers' answers. See
        // `ui-kit-ipc.test.ts`.)
        const previous = current.find(
          (entry) => entry.namespace === input.namespace.trim(),
        );
        const auth = resolveRegistryAuthContract({
          namespace: input.namespace,
          // The panel may state the SHAPE (an `X-API-Key` header, a raw
          // scheme, a query parameter) — a private registry that needs one
          // was unconfigurable from Settings and answered 401 forever. The
          // variable NAME stays derived in Main: it selects a credential, and
          // that is never the caller's to choose.
          declared: input.auth
            ? { ...input.auth, envVar: derivedRegistryEnvVar(input.namespace) }
            : undefined,
          stored: previous?.auth,
          storedUrl: previous?.url,
          url: input.url.trim(),
          hasToken: Boolean(parsed.data.token),
        });
        // Nothing is DELETED here on purpose: the stored token stays where it
        // is. Dropping the auth contract above is already enough to close the
        // leak — with no contract on the new entry, `resolveRegistryToken` is
        // never consulted, so the old host's token cannot reach the new one.
        // Clearing the vault would also reach credentials the operator
        // provisions by other means.
        // Validated here, before anything is persisted: https only, `{name}`
        // present, no credentials in the URL, header/env names well formed.
        //
        // THE CALLER'S OWN `auth` IS DROPPED FIRST. Spreading `input` carried
        // it through whenever the gate above answered `undefined`, so sending
        // an `auth` object in the request rebuilt the very contract the gate
        // had just refused — the whole boundary was one spread away from
        // being bypassed. Only the RESOLVED contract may be attached.
        const { auth: _declared, ...withoutDeclaredAuth } = input;
        const registry = assertRegistry({
          ...withoutDeclaredAuth,
          ...(auth ? { auth } : {}),
          secretKey: registrySecretKey(input.namespace),
        });
        // The CREDENTIAL FIRST. A refused vault write used to be ignored
        // after the registry had already been persisted, so the panel saw a
        // saved namespace, cleared the password field, and every later install
        // reported a missing token with the key gone.
        if (parsed.data.token && registry.secretKey) {
          const key = registry.secretKey;
          const before = secrets().getSecret(key) ?? '';
          const write = secrets().setSecret(key, parsed.data.token.trim());
          if (!write.ok) {
            return {
              ...(await buildStatus()),
              registryError:
                write.error ??
                'o cofre recusou o token; o registry não foi salvo e a chave não foi descartada',
            };
          }
          rollbackToken = () => {
            // A REFUSED rollback is the dangerous state: the vault then holds
            // the NEW host's token while settings still name the OLD url, and
            // the next install would send that credential to the old host. So
            // if putting the previous value back fails, clear the key instead
            // — no credential at all is the only fail-closed outcome left,
            // and the operator retypes what they just typed.
            if (secrets().setSecret(key, before).ok) return null;
            const cleared = secrets().setSecret(key, '');
            return cleared.ok
              ? 'o cofre recusou devolver o token anterior; a chave foi apagada ' +
                'para não sobrar credencial do host novo — digite-a de novo'
              : 'o cofre recusou devolver E apagar o token: a chave guardada não ' +
                'corresponde ao registry configurado. Remova o registry e ' +
                'cadastre-o de novo antes de instalar.';
          };
        }
        const next = [
          ...current.filter((entry) => entry.namespace !== registry.namespace),
          registry,
        ];
        // PERSISTED without the derived `secretKey`: settings hold the
        // operator's registry configuration, never vault names.
        const persisted = replaceOrchSettings({
          uiKitRegistries: next.map(persistableRegistry),
        } as never);
        // AND READ BACK: a patch the schema refuses returns the previous
        // settings in silence, so "no exception" never meant "saved".
        const outcome = registrySaveOutcome({
          namespace: registry.namespace,
          url: registry.url,
          persisted: persisted?.uiKitRegistries,
        });
        if (!outcome.saved) {
          // No token typed on this save means nothing to roll back.
          const undone = rollbackToken?.() ?? null;
          return {
            ...(await buildStatus()),
            registryError: undone ? `${outcome.error}. ${undone}` : outcome.error,
          };
        }
        // The receipt, issued only here — after the write actually happened.
        return { ...(await buildStatus()), registrySaved: registry.namespace };
      } catch (error) {
        const undone = rollbackToken?.() ?? null;
        // An exception in validation or persistence returns the PREVIOUS list,
        // which still contains the namespace being edited. Without a reason
        // the panel would read that as success and clear the operator's input.
        const reason =
          error instanceof Error
            ? error.message.slice(0, 200)
            : 'the registry could not be saved';
        return {
          ...(await buildStatus()),
          registryError: undone ? `${reason}. ${undone}` : reason,
        };
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
  // After an action the vendor's fresh answer is the point: never the cache.
  forgetLicenseView();
  return await licenseViewFor(cwd);
}

/** Ten minutes: the panel asked the vendor on EVERY open. */
const LICENSE_VIEW_TTL_MS = 10 * 60_000;
/** Offline, `npx boardui mcp` took ~72 s before the panel could render. */
const LICENSE_STATUS_TIMEOUT_MS = 8_000;
let licenseViewCache: { readonly cwd: string; readonly at: number; readonly view: UiKitLicenseView } | null =
  null;

function forgetLicenseView(): void {
  licenseViewCache = null;
}

/**
 * The licence as the panel shows it, fast.
 *
 * The bundled licence is put in place first, locally. When the file on disk is
 * ours the vendor has nothing to add, so the answer is immediate — asking it
 * cost 3 s warm, 7 s cold and ~72 s offline on every panel open (review
 * 22/10). Only a machine with its own key or its own licence file asks the
 * vendor, cached for ten minutes and cut at eight seconds.
 */
async function licenseViewFor(cwd: string | null): Promise<UiKitLicenseView> {
  const provision = provisionBundledBoardUiLicense(serviceDeps());
  if (provision.status === 'written' || provision.status === 'present') {
    return { state: 'active', stored: false, masked: null, operatorKey: true, source: 'nexus-file' };
  }
  if (!cwd) {
    const stored = secrets().getSecret(BOARDUI_LICENSE_SECRET);
    return {
      state: 'unknown',
      stored: Boolean(stored),
      masked: null,
      operatorKey: !stored && hasOperatorBoardUiLicenseKey(),
    };
  }
  const now = Date.now();
  if (licenseViewCache && licenseViewCache.cwd === cwd && now - licenseViewCache.at < LICENSE_VIEW_TTL_MS) {
    return licenseViewCache.view;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LICENSE_STATUS_TIMEOUT_MS);
    timer.unref?.();
  });
  const status = await Promise.race([boardUiLicenseStatus({ cwd }, serviceDeps()), timedOut]);
  if (timer) clearTimeout(timer);
  if (!status) {
    const stored = secrets().getSecret(BOARDUI_LICENSE_SECRET);
    return {
      state: 'unknown',
      stored: Boolean(stored),
      masked: null,
      operatorKey: !stored && hasOperatorBoardUiLicenseKey(),
      source: 'vendor',
    };
  }
  const view: UiKitLicenseView = {
    state: status.state,
    stored: status.stored,
    masked: status.masked,
    operatorKey: status.operatorKey,
    source: 'vendor',
    ...(status.detail ? { detail: status.detail.slice(0, 200) } : {}),
  };
  // An unreachable vendor is not worth remembering: the next open tries again.
  if (view.state !== 'unknown') licenseViewCache = { cwd, at: now, view };
  return view;
}
