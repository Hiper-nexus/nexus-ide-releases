import type { McpToolDef } from './mcp-protocol';
import { executionScopeFor } from './gate';
import { num, requireStr, str, strArray } from './tool-util';
import { UI_KIT_IDS, type UiKitId } from '../ui-kit/ui-kit-cli';
import {
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
import { pickUiKit, type UiKitCandidate } from '../ui-kit/ui-kit-pick';
import { listCachedItems } from '../ui-kit/ui-kit-cache';
import {
  boardUiCandidates,
  boardUiLicenseStatus,
  callBoardUiTool,
  installItems,
  parseShadcnSearchOutput,
  readItemSource,
  runShadcnCommand,
  shadcnSearchNamespaces,
} from '../ui-kit/ui-kit-service';
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

function configuredRegistries(): readonly UiKitRegistry[] {
  try {
    const settings = getOrchSettings() as { uiKitRegistries?: readonly UiKitRegistry[] };
    return settings.uiKitRegistries ?? [];
  } catch {
    return [];
  }
}

const serviceDeps = () => ({ registries: configuredRegistries });

/** Live listing for shadcn; the structured snapshot for BoardUI. */
async function candidatesFor(
  kit: UiKitId,
  cwd: string,
  query: string | undefined,
): Promise<{ candidates: readonly UiKitCandidate[]; raw: string; bestEffort: boolean }> {
  if (kit === 'boardui') {
    const all = boardUiCandidates();
    const needle = query?.trim().toLowerCase();
    const filtered = needle
      ? all.filter(
          (entry) =>
            entry.slug.includes(needle) ||
            entry.label.toLowerCase().includes(needle) ||
            entry.category.includes(needle),
        )
      : all;
    return { candidates: filtered, raw: '', bestEffort: false };
  }
  const result = await runShadcnCommand(
    {
      command: {
        kind: 'search',
        registries: shadcnSearchNamespaces(configuredRegistries()),
        ...(query ? { query } : {}),
        limit: 200,
      },
      cwd,
    },
    serviceDeps(),
  );
  return {
    candidates: parseShadcnSearchOutput(result.stdout),
    raw: result.stdout.slice(0, 20_000),
    // The CLI has no --json for search, so the parse is a scrape: an empty
    // list never means "the registry has nothing".
    bestEffort: true,
  };
}

export function buildUiKitTools(): McpToolDef[] {
  return [
    {
      name: 'nexus_ui_kit_catalog',
      description:
        'Browse the UI kits available to this project: shadcn/ui (free, any ' +
        'registry) and BoardUI (free items plus Pro items that need the ' +
        "operator's licence). Lists items, the ready-made recipes (super " +
        'admin, dashboard, auth) and what is already cached locally. Pass ' +
        '`task` to also get a recommendation for which kit and item fit it. ' +
        'Read-only.',
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
      handler: async (args, ctx) => {
        const kit = parseKit(args);
        const cwd = cwdFor(ctx);
        const query = str(args, 'query');
        const cached = listCachedItems(kit);

        if (args.cachedOnly === true) {
          return {
            kit,
            cached: cached.map((entry) => ({
              slug: entry.slug,
              tier: entry.tier,
              bytes: entry.bytes,
              fetchedAt: entry.fetchedAt,
            })),
            recipes: UI_KIT_RECIPES.map((recipe) => recipe.id),
          };
        }

        const listed = await candidatesFor(kit, cwd, query);
        const task = str(args, 'task');
        let recommendation: unknown;
        if (task) {
          const license =
            kit === 'boardui' ? await boardUiLicenseStatus({ cwd }, serviceDeps()) : null;
          const pick = await pickUiKit({
            task,
            candidates: [...listed.candidates, ...boardUiCandidates()].slice(0, 60),
            proLicensed: license?.state === 'active',
          });
          recommendation = {
            needsKit: pick.needsKit,
            kit: pick.kit,
            item: pick.item?.slug ?? null,
            needsLicense: pick.needsLicense,
            blocked: pick.blockedItem?.slug ?? null,
            decidedBy: pick.source,
            reason: pick.reason,
          };
        }

        return {
          kit,
          items: listed.candidates.map((entry) => ({
            slug: entry.slug,
            label: entry.label,
            category: entry.category,
            tier: entry.tier,
          })),
          bestEffortParse: listed.bestEffort,
          ...(listed.raw ? { rawOutput: listed.raw } : {}),
          cachedSlugs: cached.map((entry) => entry.slug),
          recipes: UI_KIT_RECIPES.map((recipe) => ({
            id: recipe.id,
            label: recipe.label,
            description: recipe.description,
            roles: recipe.roles.map((role) => role.key),
          })),
          ...(recommendation ? { recommendation } : {}),
        };
      },
    },
    {
      name: 'nexus_ui_kit_source',
      description:
        "Read one kit item's source before deciding to install it. Served " +
        'from the local Nexus cache when fresh, so looking at three ' +
        'components does not cost three vendor round trips. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          kit: { type: 'string', enum: [...UI_KIT_IDS] },
          slug: { type: 'string', description: 'Item slug, e.g. button, dashboard-01.' },
          refresh: { type: 'boolean', description: 'Ignore the cache and refetch.' },
        },
        required: ['slug'],
      },
      handler: async (args, ctx) => {
        const kit = parseKit(args);
        const result = await readItemSource(
          {
            kit,
            slug: requireStr(args, 'slug'),
            cwd: cwdFor(ctx),
            ...(args.refresh === true ? { refresh: true } : {}),
          },
          serviceDeps(),
        );
        return {
          kit: result.kit,
          slug: result.slug,
          tier: result.tier,
          fromCache: result.fromCache,
          source: result.source.slice(0, 100_000),
        };
      },
    },
    {
      name: 'nexus_ui_kit_add',
      description:
        'Install kit items into this project. Prefer this over writing a ' +
        'component by hand: the vendor item carries the accessibility, the ' +
        'keyboard handling and the states. Style it with the project design ' +
        'contract afterwards instead of shipping vendor defaults.',
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
          path: { type: 'string', description: 'Project-relative destination.' },
        },
        required: ['items'],
      },
      handler: async (args, ctx) => {
        const kit = parseKit(args);
        const items = strArray(args, 'items');
        if (items.length === 0) throw new Error('name at least one item to install');
        const result = await installItems(
          {
            kit,
            items,
            cwd: cwdFor(ctx),
            ...(args.overwrite === true ? { overwrite: true } : {}),
            ...(str(args, 'path') ? { path: requireStr(args, 'path') } : {}),
          },
          serviceDeps(),
        );
        return {
          ok: result.ok,
          kit,
          installed: result.ok ? items : [],
          exitCode: result.code,
          output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 20_000),
          ...(result.missingRegistryKeys.length > 0
            ? {
                missingRegistryKeys: result.missingRegistryKeys,
                hint:
                  'Those registries have no token stored. Settings → UI kits → ' +
                  'registries, or install from a keyless registry.',
              }
            : {}),
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
        const listed = await candidatesFor(kit, cwd, undefined);
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
          registry: { type: 'string' },
          output: { type: 'string' },
        },
        required: ['command'],
      },
      handler: async (args, ctx) => {
        const command = buildRunCommand(args);
        const result = await runShadcnCommand(
          { command, cwd: cwdFor(ctx) },
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
        'install_rules, get_skill, install_skill, get_theme, license_status, ' +
        'activate_license, deactivate_license. The licence key is never an ' +
        "argument — it is injected from the operator's vault.",
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
        const raw = args.args;
        const toolArgs =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? { ...(raw as Record<string, unknown>) }
            : {};
        delete toolArgs.licenseKey;
        delete toolArgs.license_key;
        const result = await callBoardUiTool({ tool, args: toolArgs, cwd }, serviceDeps());
        return { ok: result.ok, text: result.text.slice(0, 60_000) };
      },
    },
  ];
}

function buildRunCommand(args: Record<string, unknown>): ShadcnCommand {
  const command = requireStr(args, 'command');
  const items = strArray(args, 'items');
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
      return {
        kind: 'build',
        ...(str(args, 'registry') ? { registry: requireStr(args, 'registry') } : {}),
        ...(str(args, 'output') ? { output: requireStr(args, 'output') } : {}),
      };
    case 'docs':
      return {
        kind: 'docs',
        ...(str(args, 'component') ? { component: requireStr(args, 'component') } : {}),
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
