import type { McpToolDef } from './mcp-protocol';
import { executionScopeFor } from './gate';
import { num, requireStr, str, strArray } from './tool-util';
import { UI_KIT_IDS, type UiKitId } from '../ui-kit/ui-kit-cli';
import {
  classifyShadcnItem,
  SHADCN_BASES,
  SHADCN_MIGRATIONS,
  SHADCN_TEMPLATES,
  type ShadcnBase,
  type ShadcnCommand,
  type ShadcnMigration,
  type ShadcnTemplate,
} from '../ui-kit/shadcn-source';
import { BOARDUI_MCP_TOOLS } from '../ui-kit/boardui-source';
import { defaultShadcnSearchPlan } from '../ui-kit/shadcn-source';
import {
  findUiKitRecipe,
  resolveUiKitRecipe,
  UI_KIT_RECIPES,
} from '../ui-kit/ui-kit-recipes';
import { pickUiKitByHeuristic } from '../ui-kit/ui-kit-pick';
import { listCachedItems, readCachedItem } from '../ui-kit/ui-kit-cache';
import {
  activateEffectiveBoardUiLicense,
  boardUiCandidates,
  readItemSource,
  boardUiLicenseStatus,
  boardUiProSelectable,
  boardUiProUnlockedLocally,
  callBoardUiTool,
  installItems,
  provisionBundledBoardUiLicense,
  readComponentsJson,
  runShadcnCommand,
  shadcnProjectNotReady,
  shadcnSearchNamespaces,
} from '../ui-kit/ui-kit-service';
import { liveCandidates, offlineCandidates } from '../ui-kit/ui-kit-catalog';
import { agentInstallReceipt } from '../ui-kit/ui-kit-install-view';
import {
  installPickReceipt,
  resolveInstallTargetForTask,
} from '../ui-kit/ui-kit-install-target';
import { getOrchSettings } from '../persistence/settings-store';
import { UI_KIT_SETTINGS_PATH } from '../../shared/ui-kit-contract';
import {
  normalizeConfiguredRegistries,
  withOperatorRegistries,
  type UiKitRegistry,
} from '../ui-kit/ui-kit-registry';

/**
 * The UI kit, as tools an agent can actually reach.
 *
 * Six tools cover both vendors' full surface. The shape is deliberate: raw
 * argv never crosses this boundary. A model passes a typed command and the
 * source modules build the argv, so `--cwd`, a path that climbs out of the
 * project, a plain-HTTP registry and a smuggled flag are all impossible by
 * construction rather than by review.
 *
 * Two things are deliberately NOT here:
 *
 * - `shadcn eject` inlines the stylesheet and the vendor documents it as
 *   irreversible. An agent does not get a one-way door; the operator runs it.
 * - A licence key as an argument. The key is the operator's secret: it is
 *   stored through the settings panel and injected from the vault, so a model
 *   neither sees it nor needs it.
 * - A DESTINATION. `--path`, `--dir` and `--output` are gone from this surface
 *   on purpose: three rounds of review found three ways past string checks on
 *   a caller-chosen write path (Windows drive-relative, a symlinked ancestor,
 *   a dangling link that `mkdir -p` then creates outside). Patching a fourth
 *   was not the answer — the option itself buys the class. Both kits already
 *   install where the project says: shadcn follows the `aliases` in
 *   `components.json`, BoardUI the project's source root. The operator
 *   configures that in the project; an agent does not get to aim a write.
 */

function cwdFor(ctx: Parameters<McpToolDef['handler']>[1]): string {
  return executionScopeFor(ctx).rootRealPath;
}

function parseKit(args: Record<string, unknown>, fallback: UiKitId = 'shadcn'): UiKitId {
  const raw = str(args, 'kit');
  if (!raw) return fallback;
  const found = UI_KIT_IDS.find((candidate) => candidate === raw.trim());
  if (!found) {
    throw new Error(
      `unknown kit: ${raw.slice(0, 32)} (expected one of ${UI_KIT_IDS.join(', ')})`,
    );
  }
  return found;
}

/**
 * Refuse an item that is a local path.
 *
 * The CLI accepts `registry/button.json`, and it is a legitimate operator
 * workflow — but from an agent it is the last caller-chosen PATH on this
 * surface, and six rounds of review have been about exactly that. A registry
 * item is supposed to name a thing (`button`, `@acme/auth`), not a place. The
 * capability stays for Main-side callers, where the containment walk guards it.
 */
function assertNamedItems(items: readonly string[]): readonly string[] {
  for (const item of items) {
    let kind: ReturnType<typeof classifyShadcnItem>;
    try {
      kind = classifyShadcnItem(item);
    } catch {
      continue; // The builder makes the shape refusal, with its own message.
    }
    if (kind === 'relative') {
      throw new Error(
        `a local registry file is not installable from here: ${item.slice(0, 64)} ` +
          '— name the item (button) or a namespaced one (@acme/auth)',
      );
    }
  }
  return items;
}

function configuredRegistries(): readonly UiKitRegistry[] {
  try {
    const settings = getOrchSettings() as { uiKitRegistries?: readonly unknown[] };
    // Same rule as the panel's reader: every stored row re-validated, an
    // unusable one dropped — a settings file is data on disk, not a caller.
    return normalizeConfiguredRegistries(settings.uiKitRegistries ?? []);
  } catch {
    return [];
  }
}

const serviceDeps = () => ({ registries: configuredRegistries });

/** Where the project imports shadcn components from, per components.json. */
function shadcnImportAlias(cwd: string): string | undefined {
  const aliases = readComponentsJson(cwd)?.aliases;
  if (!aliases || typeof aliases !== 'object') return undefined;
  const { ui, components } = aliases as { ui?: unknown; components?: unknown };
  if (typeof ui === 'string' && ui.length > 0) return ui;
  return typeof components === 'string' && components.length > 0 ? `${components}/ui` : undefined;
}

type ToolInvocation = Parameters<McpToolDef['handler']>[2];

/**
 * The last check before a vendor process starts: the call was not superseded
 * (a newer mission intent aborts it) and its caller still holds authority.
 */
function assertStillCurrent(invocation: ToolInvocation): void {
  if (invocation?.signal?.aborted) throw new Error('UI-kit call aborted');
  invocation?.assertCurrentAuthority?.();
}

/**
 * The read-only listing NEVER spawns.
 *
 * That is the whole point of `offlineCandidates`: `nexus_ui_kit_catalog` and
 * `nexus_ui_kit_source` are classified read-only, and a read-only lane (a
 * reviewer, a readOnly worker, an unconfirmed voice call) must not be able to
 * cause code execution. Running `npx` would, and in the project's own
 * directory at that: npm reads a `.npmrc` from its cwd, so the REPOSITORY
 * could choose which package gets downloaded and run. `liveCandidates` asks
 * the vendor and is only ever called from an effectful tool.
 */

export function buildUiKitTools(): McpToolDef[] {
  return [
    {
      name: 'nexus_ui_kit_catalog',
      description:
        'Browse the UI kits available to this project: shadcn/ui (free, any ' +
        'registry) and BoardUI (free items plus Pro components and full-page ' +
        'templates, unlocked by the licence that ships with Nexus). OFFLINE ' +
        "and read-only: BoardUI's whole catalog " +
        'ships with Nexus, and for shadcn this lists what has been downloaded ' +
        "— the live registry is nexus_ui_kit_run { command: 'search' }. Also " +
        'lists the ready-made recipes (super admin, dashboard, auth). Pass ' +
        '`task` for a recommendation of which kit and item fit it.',
      inputSchema: {
        type: 'object',
        properties: {
          kit: { type: 'string', enum: [...UI_KIT_IDS], description: 'Default shadcn.' },
          query: { type: 'string', description: 'Filter items by name.' },
          task: {
            type: 'string',
            description:
              'What you are building. Returns a kit/item recommendation for it.',
          },
          cachedOnly: {
            type: 'boolean',
            description: 'Only what is already downloaded into Nexus (offline).',
          },
        },
      },
      handler: async (args) => {
        const kit = parseKit(args);
        const query = str(args, 'query');
        const cached = listCachedItems(kit);
        const cachedSlugs = new Set(cached.map((entry) => entry.slug));
        // `cachedOnly` was declared in the schema and never read, so a caller
        // asking to work offline got BoardUI's whole bundled snapshot back
        // with `cached: false` on most of it.
        const cachedOnly = args.cachedOnly === true;
        const items = offlineCandidates(kit, query).filter(
          (entry) => !cachedOnly || cachedSlugs.has(entry.slug),
        );
        const task = str(args, 'task');

        let recommendation: unknown;
        if (task) {
          // The HEURISTIC, never `pickUiKit`.
          //
          // `pickUiKit` consults the Jev when the surface is on and a
          // credential exists: that is an HTTP request carrying the task text
          // to a third party, plus a write to the local decision log. This
          // tool is classified `read-only`, which is what puts it within
          // reach of a reviewer, a readOnly worker and an UNCONFIRMED voice
          // call — none of which may cause egress or a write. The spawn guard
          // in the tests never saw it, because the Jev travels by fetch.
          //
          // The licence is read from DISK, never asked of the vendor: that
          // would spawn its MCP server. A licence file in place, or the key
          // that ships with Nexus (which the install door provisions), opens
          // the Pro half; otherwise the gate falls back to a free item and
          // reports `needsLicense`.
          const proUnlocked = boardUiProUnlockedLocally();
          const seen = new Set(items.map((entry) => entry.slug));
          const pick = pickUiKitByHeuristic({
            task,
            proLicensed: proUnlocked !== null,
            candidates: [
              ...items,
              // Cross-kit on purpose: asked for a dashboard with kit shadcn,
              // the honest answer may still be a BoardUI item. De-duplicated
              // because for kit boardui `items` already holds the snapshot,
              // and withheld under `cachedOnly`, where recommending something
              // that is not downloaded would not be an answer.
              ...(cachedOnly
                ? []
                : boardUiCandidates().filter((entry) => !seen.has(entry.slug))),
              // No cap: the rule is a local loop, and the 60 that used to be
              // here cut the whole Pro half of the snapshot (it sits last).
            ],
          });
          recommendation = {
            needsKit: pick.needsKit,
            kit: pick.kit,
            item: pick.item?.slug ?? null,
            needsLicense: pick.needsLicense,
            blocked: pick.blockedItem?.slug ?? null,
            decidedBy: pick.source,
            reason: pick.reason,
            // How the Pro half was judged from here: a licence file on disk,
            // the key bundled with Nexus, or not at all.
            licence: proUnlocked ?? 'not-checked',
            // Said plainly: this lane never asks a model, so the answer is the
            // offline rule and nothing left this machine.
            offlineRuleOnly: true,
          };
        }

        return {
          kit,
          items: items.map((entry) => ({
            slug: entry.slug,
            label: entry.label,
            category: entry.category,
            tier: entry.tier,
            cached: cached.some((entry2) => entry2.slug === entry.slug),
          })),
          offline: true,
          cachedOnly,
          cachedSlugs: cached.map((entry) => entry.slug),
          recipes: UI_KIT_RECIPES.map((recipe) => ({
            id: recipe.id,
            label: recipe.label,
            description: recipe.description,
            roles: recipe.roles.map((role) => role.key),
          })),
          hint:
            kit === 'shadcn'
              ? "This is the offline view: BoardUI's catalog ships with Nexus, " +
                'and for shadcn it lists only what has been downloaded. For the ' +
                "live registry run nexus_ui_kit_run { command: 'search' }."
              : "BoardUI's catalog ships with Nexus — free and Pro, read from " +
                'the vendor on 2026-10-22 — and the Pro items are unlocked by ' +
                'the licence that ships with Nexus. For the vendor\'s live list ' +
                "use nexus_ui_kit_boardui { tool: 'list_components' }.",
          ...(recommendation ? { recommendation } : {}),
        };
      },
    },
    {
      name: 'nexus_ui_kit_source',
      description:
        "Read one kit item's source from the local Nexus cache, so looking at " +
        'three components costs no vendor round trip. Read-only and offline: ' +
        'an item that was never downloaded comes back with the effectful call ' +
        'that fetches it, rather than fetching it from here.',
      inputSchema: {
        type: 'object',
        properties: {
          kit: { type: 'string', enum: [...UI_KIT_IDS] },
          slug: { type: 'string', description: 'Item slug, e.g. button, dashboard-01.' },
        },
        required: ['slug'],
      },
      handler: async (args) => {
        const kit = parseKit(args);
        const slug = requireStr(args, 'slug');
        const cached = readCachedItem(kit, slug);
        if (!cached) {
          return {
            kit,
            slug,
            cached: false,
            source: null,
            hint:
              'Not downloaded yet. Fetching it is an effect, not a read: run ' +
              `nexus_ui_kit_run { command: 'view', items: ['${slug}'] } ` +
              '(shadcn) or nexus_ui_kit_boardui ' +
              `{ tool: 'get_component', args: { name: '${slug}' } } (BoardUI), ` +
              'and it lands in the local cache for next time.',
          };
        }
        return {
          kit: cached.kit,
          slug: cached.slug,
          tier: cached.tier,
          cached: true,
          fetchedAt: cached.fetchedAt,
          source: cached.payload.slice(0, 100_000),
        };
      },
    },
    {
      name: 'nexus_ui_kit_add',
      description:
        'Install kit items into this project. Prefer this over writing a ' +
        'component by hand: the vendor item carries the accessibility, the ' +
        'keyboard handling and the states. Style it with the project design ' +
        'contract afterwards instead of shipping vendor defaults. The ' +
        'destination is the project\'s own (shadcn follows the aliases in ' +
        'components.json, BoardUI the source root) and is not selectable here. ' +
        'Pass `items` when you know what you want, or `task` to describe the ' +
        'need and let Nexus choose the kit and the item against the live ' +
        'catalog — the receipt says what it picked and why.',
      inputSchema: {
        type: 'object',
        properties: {
          kit: {
            type: 'string',
            enum: [...UI_KIT_IDS],
            description: 'Optional with `task`: omit it to let Nexus choose the kit.',
          },
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'Slugs, or @namespace/item for another registry.',
          },
          task: {
            type: 'string',
            description:
              'What you are building, when you do not know the item name. ' +
              'Resolved against the live catalog; `items` wins if both are given.',
          },
          overwrite: { type: 'boolean' },
        },
      },
      handler: async (args, ctx, invocation) => {
        const named = assertNamedItems(strArray(args, 'items'));
        const task = str(args, 'task');
        const cwd = cwdFor(ctx);
        // A caller who names a kit keeps it; `parseKit` defaults to shadcn, so
        // the pick only gets to choose when nothing was named.
        const namedKit = str(args, 'kit') ? parseKit(args) : undefined;

        let kit = namedKit ?? parseKit(args);
        let items = named;
        let pick: Record<string, unknown> | null = null;

        // shadcn without components.json stops at an interactive prompt that
        // ignores --yes; answering at once beats a 300 s silent timeout. Also
        // before a task pick that may land on shadcn: the search alone costs
        // seconds, and the agent should choose init or BoardUI knowingly.
        const shadcnInPlay = kit === 'shadcn' && (named.length > 0 || namedKit !== undefined || Boolean(task));
        if (shadcnInPlay) {
          const refused = shadcnProjectNotReady(cwd);
          if (refused) {
            return {
              ...agentInstallReceipt(refused, { kit: 'shadcn', items: named }),
              ...(named.length === 0 && namedKit === undefined
                ? { hint: refused.hint }
                : {}),
            };
          }
        }

        if (named.length === 0) {
          if (!task) {
            throw new Error(
              'name at least one item to install, or describe the need in `task`',
            );
          }
          // THE EFFECTFUL SURFACE is where this decision belongs: it may ask
          // the vendor (so the candidates are the live catalog and the Pro
          // gate sees the real licence), and the call is already gated. The
          // read-only catalog answers with the offline rule instead.
          assertStillCurrent(invocation);
          const resolved = await resolveInstallTargetForTask(
            {
              task,
              kit: namedKit,
              cwd,
              ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
              ...(ctx.missionId ? { missionId: ctx.missionId } : {}),
              ...(invocation?.signal ? { signal: invocation.signal } : {}),
            },
            serviceDeps(),
          );
          if (!resolved.ok) {
            return {
              ok: false,
              installed: [],
              pick: installPickReceipt(resolved.pick),
              hint: !resolved.pick.needsKit
                ? 'That task does not call for a kit component.'
                : resolved.pick.kit
                  ? `No ${resolved.pick.kit} item matches the task's words. Name the ` +
                    'item with `items` (browse nexus_ui_kit_catalog), or write it ' +
                    'with the project design contract.'
                  : 'Neither kit fits that task: write it with the project design contract.',
            };
          }
          kit = resolved.target.kit;
          items = resolved.target.items;
          pick = installPickReceipt(resolved.pick);
        }

        assertStillCurrent(invocation);
        const result = await installItems(
          {
            kit,
            items,
            cwd,
            ...(args.overwrite === true ? { overwrite: true } : {}),
            ...(invocation?.signal ? { signal: invocation.signal } : {}),
          },
          serviceDeps(),
        );
        const importAlias = kit === 'shadcn' ? shadcnImportAlias(cwd) : undefined;
        return {
          ...agentInstallReceipt(result, { kit, items, ...(importAlias ? { importAlias } : {}) }),
          ...(pick ? { pick } : {}),
          // Said outright rather than silently preferring one: naming items
          // and a task at once is over-specified, and `items` is the explicit
          // one.
          ...(pick === null && task ? { taskIgnored: true } : {}),
        };
      },
    },
    {
      name: 'nexus_ui_kit_recipe',
      description:
        'Install a whole ready-made assembly in one call — a super admin ' +
        '(shell, sidebar, overview with charts, data table, auth, settings), ' +
        'a dashboard, or the auth screens. Resolves each role against the ' +
        'live catalog; roles nothing matched come back unresolved rather ' +
        'than guessed. Use `dryRun` to see what it would install.',
      inputSchema: {
        type: 'object',
        properties: {
          recipe: {
            type: 'string',
            enum: UI_KIT_RECIPES.map((entry) => entry.id),
          },
          kit: { type: 'string', enum: [...UI_KIT_IDS] },
          dryRun: { type: 'boolean' },
        },
        required: ['recipe'],
      },
      handler: async (args, ctx, invocation) => {
        const recipeId = requireStr(args, 'recipe');
        const recipe = findUiKitRecipe(recipeId);
        if (!recipe) {
          throw new Error(
            `unknown recipe: ${recipeId.slice(0, 48)} (expected one of ` +
              `${UI_KIT_RECIPES.map((entry) => entry.id).join(', ')})`,
          );
        }
        const kit = parseKit(args);
        const cwd = cwdFor(ctx);
        if (kit === 'shadcn' && args.dryRun !== true) {
          const refused = shadcnProjectNotReady(cwd);
          if (refused) {
            return { recipe: recipe.id, kit, ...agentInstallReceipt(refused, { kit, items: [] }) };
          }
        }
        assertStillCurrent(invocation);
        const proLicensed =
          kit === 'boardui' ? await boardUiProSelectable({ cwd }, serviceDeps()) : false;
        const listed = await liveCandidates(kit, cwd, undefined, serviceDeps());
        const resolved = resolveUiKitRecipe({
          recipe,
          kit,
          candidates: listed.candidates,
          proLicensed,
        });

        const plan = {
          recipe: recipe.id,
          kit,
          install: resolved.install,
          roles: resolved.roles.map((entry) => ({
            role: entry.role.key,
            item: entry.item?.slug ?? null,
            needsLicense: entry.needsLicense,
            blocked: entry.blockedItem?.slug ?? null,
          })),
          unresolved: resolved.unresolved,
          ...(resolved.licensedRoles.length > 0
            ? {
                licensedRoles: resolved.licensedRoles,
                hint:
                  'Those roles only matched BoardUI Pro items and the licence ' +
                  `could not be confirmed on this machine (${UI_KIT_SETTINGS_PATH}); ` +
                  'the free items install without any key.',
              }
            : {}),
        };

        if (args.dryRun === true || resolved.install.length === 0) {
          return { ...plan, installed: false };
        }
        assertStillCurrent(invocation);
        const result = await installItems(
          {
            kit,
            items: resolved.install,
            cwd,
            ...(invocation?.signal ? { signal: invocation.signal } : {}),
          },
          serviceDeps(),
        );
        // Through the same mapper as the direct path: this response used to
        // drop `missingRegistryKeys`, `needsLicense` and `licenseState`, so a
        // recipe whose item needed a token — or a BoardUI item that became
        // gated between resolution and install — failed with the reason only
        // in free-form text.
        const importAlias = kit === 'shadcn' ? shadcnImportAlias(cwd) : undefined;
        const receipt = agentInstallReceipt(result, {
          kit,
          items: resolved.install,
          ...(importAlias ? { importAlias } : {}),
        });
        return {
          ...plan,
          ...receipt,
          // The recipe's own meaning of "installed": the plan ran AND wrote
          // something. Exit code 0 with every file skipped was "installed".
          installed: (receipt.installed as readonly string[]).length > 0,
        };
      },
    },
    {
      name: 'nexus_ui_kit_run',
      description:
        'The rest of the shadcn surface: init a project, apply a theme ' +
        'preset, decode or resolve a preset, view items, search registries, ' +
        'build your own registry, read component docs, report project info, ' +
        'or run a codemod (cn, icons, base-color, rtl, radix).',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: [
              'init',
              'apply',
              'preset-decode',
              'preset-resolve',
              'preset-url',
              'view',
              'search',
              'build',
              'docs',
              'info',
              'migrate',
            ],
          },
          items: { type: 'array', items: { type: 'string' } },
          registries: { type: 'array', items: { type: 'string' } },
          query: { type: 'string' },
          limit: { type: 'number' },
          offset: { type: 'number' },
          template: { type: 'string', enum: [...SHADCN_TEMPLATES] },
          base: { type: 'string', enum: [...SHADCN_BASES] },
          preset: { type: 'string' },
          code: { type: 'string' },
          only: { type: 'string', enum: ['theme', 'font'] },
          migration: { type: 'string', enum: [...SHADCN_MIGRATIONS] },
          from: { type: 'string' },
          to: { type: 'string' },
          component: { type: 'string' },
        },
        required: ['command'],
      },
      handler: async (args, ctx, invocation) => {
        const command = buildRunCommand(args);
        const cwd = cwdFor(ctx);
        assertStillCurrent(invocation);
        // `nexus_ui_kit_source` sends callers here when an item is not cached
        // yet. If this returned the output and cached nothing, the cache would
        // never gain an entry and the offline catalog would stay empty for
        // ever — which is exactly what happened. A single-item `view` goes
        // through the path that fetches AND caches.
        if (command.kind === 'view' && command.items.length === 1) {
          const slug = command.items[0] as string;
          const fetched = await readItemSource(
            { kit: 'shadcn', slug, cwd, refresh: true },
            serviceDeps(),
          );
          return {
            ok: true,
            command: 'view',
            exitCode: 0,
            // What the cache actually accepted, not what we hoped: a refused
            // write used to be reported as cached, sending the caller back
            // for an item that was never there.
            cached: fetched.cached,
            output: fetched.source.slice(0, 40_000),
          };
        }
        const result = await runShadcnCommand(
          { command, cwd, ...(invocation?.signal ? { signal: invocation.signal } : {}) },
          serviceDeps(),
        );
        // What a DEFAULT search could not reach. The CLI takes a bounded
        // number of registries per call, so the default is the first chunk;
        // staying quiet about the rest reads as "those registries have
        // nothing", and the caller cannot name a namespace it was never told
        // about. `nexus_ui_kit_catalog` merges every chunk.
        const omittedRegistries =
          command.kind === 'search' && args.registries === undefined
            ? defaultShadcnSearchPlan(
                shadcnSearchNamespaces(
                  withOperatorRegistries(configuredRegistries()),
                ),
              ).omitted
            : [];
        return {
          ok: result.ok,
          command: command.kind,
          exitCode: result.code,
          output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 40_000),
          ...(result.missingRegistryKeys.length > 0
            ? { missingRegistryKeys: result.missingRegistryKeys }
            : {}),
          ...(omittedRegistries.length > 0 ? { omittedRegistries } : {}),
        };
      },
    },
    {
      name: 'nexus_ui_kit_boardui',
      description:
        "Call one of BoardUI's own tools: get_started, list_components, " +
        'get_component, get_usage_examples, install_components, init_boardui, ' +
        'install_rules, get_skill, install_skill, get_theme, license_status ' +
        'and activate_license (which uses the key already stored, or the one ' +
        'that ships with Nexus). The key is ' +
        "never an argument — it is injected from the operator's vault or ships " +
        'with Nexus — and deactivate_license is the operator\'s own, in ' +
        `${UI_KIT_SETTINGS_PATH}. init_boardui and install_rules write the ` +
        "vendor's agent rules into the project (AGENTS.md / .claude/skills).",
      inputSchema: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: [...BOARDUI_MCP_TOOLS] },
          args: { type: 'object', description: 'Arguments for that tool.' },
        },
        required: ['tool'],
      },
      handler: async (args, ctx, invocation) => {
        const tool = requireStr(args, 'tool');
        if (tool === 'deactivate_license') {
          // Not on this surface, for the same reason as `shadcn eject` and for
          // one more. Releasing the licence spends a vendor activation and
          // wipes a key the operator bought and typed in; nothing an agent
          // does with the kits needs it. Going through the vendor from here
          // would also leave the key in the vault while the vendor had
          // released it — Settings reporting a stored but dead key — because
          // only `deactivateBoardUiLicense` forgets it, and that path is the
          // panel's.
          return {
            ok: false,
            reason: 'operator_action',
            hint:
              `Removing the BoardUI licence is the operator's: ${UI_KIT_SETTINGS_PATH} ` +
              '→ Remover. It releases a vendor activation and clears the ' +
              'stored key together, which this surface cannot do.',
          };
        }
        // After the refusal: resolving the scope is work, and a refusal should
        // not depend on it.
        const cwd = cwdFor(ctx);
        assertStillCurrent(invocation);
        // Never take a key from a model, and never hand one back.
        if (tool === 'license_status') {
          // The bundled licence first, so "is Pro active?" answers for this
          // machine as it will be at install time rather than before boot
          // provisioning caught up.
          provisionBundledBoardUiLicense(serviceDeps());
          return await boardUiLicenseStatus({ cwd }, serviceDeps());
        }
        if (tool === 'activate_license') {
          // The same core as the panel: a typed key activates with the
          // vendor; the key bundled with Nexus is PROVISIONED (no seat). This
          // used to refuse "no licence stored" whenever the vault was empty —
          // i.e. on every machine that runs on the bundled key.
          const activated = await activateEffectiveBoardUiLicense({ cwd }, serviceDeps());
          return {
            ok: activated.ok,
            ...(activated.provisioned ? { provisioned: true } : {}),
            ...(activated.detail ? { detail: activated.detail.slice(0, 400) } : {}),
          };
        }
        // Same reason as the shadcn `view` above: this is where the cache
        // gains BoardUI entries, so `get_component` goes through the caching
        // path instead of returning text nobody keeps.
        if (tool === 'get_component') {
          const raw = args.args;
          const name =
            raw && typeof raw === 'object' && !Array.isArray(raw)
              ? (raw as { name?: unknown }).name
              : undefined;
          if (typeof name === 'string' && name.length > 0) {
            const fetched = await readItemSource(
              { kit: 'boardui', slug: name, cwd, refresh: true },
              serviceDeps(),
            );
            return {
              ok: true,
              cached: fetched.cached,
              tier: fetched.tier,
              text: fetched.source.slice(0, 60_000),
            };
          }
        }
        // The service applies the per-tool argument allowlist (and injects the
        // licence from the vault), so `projectDir` and friends cannot redirect
        // an install out of this pane's execution scope.
        const result = await callBoardUiTool(
          { tool, args: args.args, cwd, ...(invocation?.signal ? { signal: invocation.signal } : {}) },
          serviceDeps(),
        );
        return {
          ok: result.ok,
          text: result.text.slice(0, 60_000),
          ...(result.droppedArgs ? { ignoredArgs: result.droppedArgs } : {}),
          ...(result.needsLicense ? { needsLicense: result.needsLicense } : {}),
          ...(result.licenseState ? { licenseState: result.licenseState } : {}),
        };
      },
    },
  ];
}

function buildRunCommand(args: Record<string, unknown>): ShadcnCommand {
  const command = requireStr(args, 'command');
  const items = assertNamedItems(strArray(args, 'items'));
  const base = str(args, 'base') as ShadcnBase | undefined;
  switch (command) {
    case 'init':
      return {
        kind: 'init',
        // Without a preset `init` opens selects that ignore --yes (measured on
        // shadcn@4.22) and the run hangs until the timeout. `--defaults` is
        // the vendor's own non-interactive answer (next template, base-nova
        // preset) and still detects an existing project.
        ...(str(args, 'preset') ? {} : { defaults: true }),
        ...(items.length > 0 ? { items } : {}),
        ...(str(args, 'template')
          ? { template: requireStr(args, 'template') as ShadcnTemplate }
          : {}),
        ...(base ? { base } : {}),
        ...(str(args, 'preset') ? { preset: requireStr(args, 'preset') } : {}),
      };
    case 'apply':
      return {
        kind: 'apply',
        preset: requireStr(args, 'preset'),
        ...(str(args, 'only') ? { only: requireStr(args, 'only') as 'theme' | 'font' } : {}),
      };
    case 'preset-decode':
      return { kind: 'preset-decode', code: requireStr(args, 'code') };
    case 'preset-resolve':
      return { kind: 'preset-resolve' };
    case 'preset-url':
      return { kind: 'preset-url', code: requireStr(args, 'code') };
    case 'view':
      return { kind: 'view', items };
    case 'search':
      return {
        kind: 'search',
        registries:
          strArray(args, 'registries').length > 0
            ? strArray(args, 'registries')
            : // The default covers the effective list: an agent searching
              // "everything" also sees namespaces a bundled operator token
              // exists for, not just what this machine's settings declare.
              //
              // Capped to what the CLI accepts in ONE search. `liveCandidates`
              // runs a batch per chunk; this surface takes a single command,
              // so with 16 registries configured it used to be refused before
              // spawning. The first chunk carries `@shadcn` and the earliest
              // configured namespaces.
              //
              // What the chunk leaves out is REPORTED (`omittedRegistries`
              // below), because silence here reads as "that registry has
              // nothing": the agent could not name a later namespace it was
              // never told about. `nexus_ui_kit_catalog` merges every chunk.
              [
                ...defaultShadcnSearchPlan(
                  shadcnSearchNamespaces(
                    withOperatorRegistries(configuredRegistries()),
                  ),
                ).registries,
              ],
        ...(str(args, 'query') ? { query: requireStr(args, 'query') } : {}),
        ...(num(args, 'limit') !== undefined ? { limit: num(args, 'limit') } : {}),
        ...(num(args, 'offset') !== undefined ? { offset: num(args, 'offset') } : {}),
      };
    case 'build':
      // No `registry` / `output`: a caller-chosen destination is not part of
      // this surface. The CLI's defaults (`./registry.json` → `./public/r`)
      // are the project's own convention.
      return { kind: 'build' };
    case 'docs':
      return {
        kind: 'docs',
        ...(str(args, 'component')
          ? { component: assertNamedItems([requireStr(args, 'component')])[0] as string }
          : {}),
        ...(base ? { base } : {}),
      };
    case 'info':
      return { kind: 'info' };
    case 'migrate':
      return {
        kind: 'migrate',
        migration: requireStr(args, 'migration') as ShadcnMigration,
        ...(str(args, 'from') ? { from: requireStr(args, 'from') } : {}),
        ...(str(args, 'to') ? { to: requireStr(args, 'to') } : {}),
      };
    case 'eject':
      throw new Error(
        'shadcn eject inlines the stylesheet and the vendor documents it as ' +
          'irreversible: run it yourself from the terminal if you mean it',
      );
    default:
      throw new Error(`unknown shadcn command: ${command.slice(0, 32)}`);
  }
}
