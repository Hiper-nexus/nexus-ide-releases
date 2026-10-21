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
import {
  findUiKitRecipe,
  resolveUiKitRecipe,
  UI_KIT_RECIPES,
} from '../ui-kit/ui-kit-recipes';
import { pickUiKitByHeuristic } from '../ui-kit/ui-kit-pick';
import { listCachedItems, readCachedItem } from '../ui-kit/ui-kit-cache';
import {
  boardUiCandidates,
  readItemSource,
  boardUiLicenseStatus,
  callBoardUiTool,
  installItems,
  runShadcnCommand,
  shadcnSearchNamespaces,
} from '../ui-kit/ui-kit-service';
import { liveCandidates, offlineCandidates } from '../ui-kit/ui-kit-catalog';
import { agentInstallReceipt } from '../ui-kit/ui-kit-install-view';
import { getOrchSettings } from '../persistence/settings-store';
import type { UiKitRegistry } from '../ui-kit/ui-kit-registry';

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
    const settings = getOrchSettings() as { uiKitRegistries?: readonly UiKitRegistry[] };
    return settings.uiKitRegistries ?? [];
  } catch {
    return [];
  }
}

const serviceDeps = () => ({ registries: configuredRegistries });

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
        'registry) and BoardUI (free items plus Pro items that need the ' +
        "operator's licence). OFFLINE and read-only: BoardUI's whole catalog " +
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
          // `proLicensed` is left false for the same reason the list is
          // offline: asking the vendor would spawn its MCP server. The Pro
          // gate then falls back to a free item and reports `needsLicense`,
          // which is the honest answer from a read-only lane.
          const seen = new Set(items.map((entry) => entry.slug));
          const pick = pickUiKitByHeuristic({
            task,
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
            ].slice(0, 60),
          });
          recommendation = {
            needsKit: pick.needsKit,
            kit: pick.kit,
            item: pick.item?.slug ?? null,
            needsLicense: pick.needsLicense,
            blocked: pick.blockedItem?.slug ?? null,
            decidedBy: pick.source,
            reason: pick.reason,
            licenceNotChecked: true,
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
              : "BoardUI's catalog ships with Nexus, so this list is complete. " +
                "For the vendor's live list use nexus_ui_kit_boardui " +
                "{ tool: 'list_components' }.",
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
        'components.json, BoardUI the source root) and is not selectable here.',
      inputSchema: {
        type: 'object',
        properties: {
          kit: { type: 'string', enum: [...UI_KIT_IDS] },
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'Slugs, or @namespace/item for another registry.',
          },
          overwrite: { type: 'boolean' },
        },
        required: ['items'],
      },
      handler: async (args, ctx) => {
        const kit = parseKit(args);
        const items = assertNamedItems(strArray(args, 'items'));
        if (items.length === 0) throw new Error('name at least one item to install');
        const result = await installItems(
          {
            kit,
            items,
            cwd: cwdFor(ctx),
            ...(args.overwrite === true ? { overwrite: true } : {}),
          },
          serviceDeps(),
        );
        return agentInstallReceipt(result, { kit, items });
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
      handler: async (args, ctx) => {
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
        const license =
          kit === 'boardui' ? await boardUiLicenseStatus({ cwd }, serviceDeps()) : null;
        const listed = await liveCandidates(kit, cwd, undefined, serviceDeps());
        const resolved = resolveUiKitRecipe({
          recipe,
          kit,
          candidates: listed.candidates,
          proLicensed: license?.state === 'active',
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
                  'Those roles only matched BoardUI Pro items. Store the ' +
                  'licence in Settings → UI kits to use them; the free items ' +
                  'install without any key.',
              }
            : {}),
        };

        if (args.dryRun === true || resolved.install.length === 0) {
          return { ...plan, installed: false };
        }
        const result = await installItems(
          { kit, items: resolved.install, cwd },
          serviceDeps(),
        );
        return {
          ...plan,
          installed: result.ok,
          exitCode: result.code,
          output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 20_000),
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
      handler: async (args, ctx) => {
        const command = buildRunCommand(args);
        const cwd = cwdFor(ctx);
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
          { command, cwd },
          serviceDeps(),
        );
        return {
          ok: result.ok,
          command: command.kind,
          exitCode: result.code,
          output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 40_000),
          ...(result.missingRegistryKeys.length > 0
            ? { missingRegistryKeys: result.missingRegistryKeys }
            : {}),
        };
      },
    },
    {
      name: 'nexus_ui_kit_boardui',
      description:
        "Call one of BoardUI's own tools: get_started, list_components, " +
        'get_component, get_usage_examples, install_components, init_boardui, ' +
        'install_rules, get_skill, install_skill, get_theme, license_status ' +
        'and activate_license (which uses the key already stored). The key is ' +
        "never an argument — it is injected from the operator's vault — and " +
        'deactivate_license is the operator\'s own, in Settings.',
      inputSchema: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: [...BOARDUI_MCP_TOOLS] },
          args: { type: 'object', description: 'Arguments for that tool.' },
        },
        required: ['tool'],
      },
      handler: async (args, ctx) => {
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
              'Removing the BoardUI licence is the operator\'s: Settings → UI ' +
              'kits → Remover. It releases a vendor activation and clears the ' +
              'stored key together, which this surface cannot do.',
          };
        }
        // After the refusal: resolving the scope is work, and a refusal should
        // not depend on it.
        const cwd = cwdFor(ctx);
        if (tool === 'activate_license' || tool === 'license_status') {
          // Never take a key from a model, and never hand one back.
          const status = await boardUiLicenseStatus({ cwd }, serviceDeps());
          if (tool === 'license_status') return status;
          if (!status.stored) {
            return {
              ok: false,
              reason: 'no_license_stored',
              hint:
                'Store the BoardUI licence in Settings → UI kits first. The ' +
                'free items need no key.',
            };
          }
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
          { tool, args: args.args, cwd },
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
            : [...shadcnSearchNamespaces(configuredRegistries())],
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
