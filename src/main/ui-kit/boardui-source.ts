import { UiKitCliError } from './ui-kit-cli';

/**
 * BoardUI — the React/Tailwind design system half of the kit.
 *
 * Two surfaces, and they are not interchangeable:
 *
 * - The CLI (`npx boardui@latest`) has `init` and `add`. That is all it has.
 * - The MCP server (`npx -y boardui@latest mcp`) has the rest: the catalog,
 *   per-item source, usage examples, theme tokens, the agent design rules, the
 *   agent skill, and the whole Pro licence lifecycle.
 *
 * So BoardUI's full functionality is only reachable through BOTH, which is why
 * this module speaks CLI argv and MCP tool names side by side.
 *
 * Verified against https://www.boardui.com/getting-started, /installation,
 * /mcp and /components on 2026-10-21.
 */

/** Every tool the BoardUI MCP server exposes. */
export const BOARDUI_MCP_TOOLS = [
  'get_started',
  'list_components',
  'get_component',
  'get_usage_examples',
  'install_components',
  'init_boardui',
  'install_rules',
  'get_skill',
  'install_skill',
  'get_theme',
  'activate_license',
  'license_status',
  'deactivate_license',
] as const;
export type BoardUiMcpTool = (typeof BOARDUI_MCP_TOOLS)[number];

/** Tools that write into the project or change machine licence state. */
const BOARDUI_WRITING_TOOLS = new Set<BoardUiMcpTool>([
  'install_components',
  'init_boardui',
  'install_rules',
  'install_skill',
  'activate_license',
  'deactivate_license',
]);

export function boardUiToolWrites(tool: BoardUiMcpTool): boolean {
  return BOARDUI_WRITING_TOOLS.has(tool);
}

export function assertBoardUiTool(raw: string): BoardUiMcpTool {
  const found = BOARDUI_MCP_TOOLS.find((candidate) => candidate === raw.trim());
  if (!found) {
    throw new UiKitCliError(
      'UNKNOWN_BOARDUI_TOOL',
      `unknown BoardUI tool: ${raw.slice(0, 48)} ` +
        `(expected one of ${BOARDUI_MCP_TOOLS.join(', ')})`,
    );
  }
  return found;
}

export const BOARDUI_CATEGORIES = [
  'foundation',
  'base',
  'block',
  'chart',
  'template',
] as const;
export type BoardUiCategory = (typeof BOARDUI_CATEGORIES)[number];

export type BoardUiTier = 'free' | 'pro';

export interface BoardUiItem {
  /** Install slug, e.g. `date-picker`. */
  readonly slug: string;
  readonly name: string;
  readonly category: BoardUiCategory;
  readonly tier: BoardUiTier;
}

function item(
  name: string,
  category: BoardUiCategory,
  tier: BoardUiTier,
): BoardUiItem {
  return { slug: boardUiSlug(name), name, category, tier };
}

/** `Date Picker` -> `date-picker`. The CLI takes slugs, the site shows names. */
export function boardUiSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Offline snapshot of the published catalog, taken 2026-10-21.
 *
 * It exists so the settings panel can show what the kit contains — and which
 * half needs a licence — with no network and no key. It is NOT authoritative:
 * `list_components` on the MCP server is, and callers are told when they are
 * looking at the snapshot so a missing item never reads as "does not exist".
 * The slugs are derived from the published display names, not confirmed
 * one-by-one against the registry.
 */
export const BOARDUI_CATALOG_SNAPSHOT: readonly BoardUiItem[] = [
  item('Color', 'foundation', 'free'),
  item('Typography', 'foundation', 'free'),

  item('Announcement', 'base', 'free'),
  item('Avatar', 'base', 'free'),
  item('Badge', 'base', 'free'),
  item('Breadcrumb', 'base', 'free'),
  item('Button', 'base', 'free'),
  item('Button Group', 'base', 'free'),
  item('Carousel', 'base', 'free'),
  item('Checkbox', 'base', 'free'),
  item('Chip', 'base', 'free'),
  item('Close Button', 'base', 'free'),
  item('Date Picker', 'base', 'free'),
  item('Divider', 'base', 'free'),
  item('Dropdown', 'base', 'free'),
  item('File Upload', 'base', 'free'),
  item('Icon Button', 'base', 'free'),
  item('Input', 'base', 'free'),
  item('Input OTP', 'base', 'free'),
  item('Link Button', 'base', 'free'),
  item('Notification', 'base', 'free'),
  item('Pagination', 'base', 'free'),
  item('Radio', 'base', 'free'),
  item('Segmented Control', 'base', 'free'),
  item('Select', 'base', 'free'),
  item('Slider', 'base', 'free'),
  item('Social Button', 'base', 'free'),
  item('Switch', 'base', 'free'),
  item('Table', 'base', 'free'),
  item('Tabs', 'base', 'free'),
  item('Textarea', 'base', 'free'),
  item('Tooltip', 'base', 'free'),
  item('Tree View', 'base', 'free'),

  item('Agent Thinking', 'block', 'free'),
  item('Auth Card', 'block', 'free'),
  item('Composer Loader', 'block', 'free'),
  item('Data Grid', 'block', 'free'),
  item('Data Table', 'block', 'free'),
  item('Notification Center', 'block', 'free'),
  item('Settings Modal', 'block', 'free'),
  item('Sidebar', 'block', 'free'),
  item('Stat Cards', 'block', 'free'),
  item('Agent Creator', 'block', 'pro'),
  item('Agent Limits', 'block', 'pro'),
  item('Agent Progress', 'block', 'pro'),
  item('Calendar', 'block', 'pro'),
  item('Composer', 'block', 'pro'),
  item('Composer Attachments', 'block', 'pro'),
  item('Composer Panel', 'block', 'pro'),
  item('Questionnaire', 'block', 'pro'),
  item('Task List', 'block', 'pro'),
  item('Web Search', 'block', 'pro'),

  item('Orders Chart', 'chart', 'free'),
  item('Revenue Chart', 'chart', 'free'),
  item('Activity Rings', 'chart', 'pro'),
  item('Area Chart', 'chart', 'pro'),
  item('Bar List', 'chart', 'pro'),
  item('Combo Chart', 'chart', 'pro'),
  item('Contributions', 'chart', 'pro'),
  item('Earnings Chart', 'chart', 'pro'),
  item('Funnel Chart', 'chart', 'pro'),
  item('Heatmap Chart', 'chart', 'pro'),
  item('Line Chart', 'chart', 'pro'),
  item('Most Active Days', 'chart', 'pro'),
  item('Radar Chart', 'chart', 'pro'),
  item('Radial Chart', 'chart', 'pro'),
  item('Sankey Chart', 'chart', 'pro'),
  item('Scatter Chart', 'chart', 'pro'),
  item('Sleep Score', 'chart', 'pro'),
  item('Stage Bars', 'chart', 'pro'),
  item('Steps Chart', 'chart', 'pro'),

  item('Chat Starter', 'template', 'free'),
  item('AI Chat', 'template', 'pro'),
  item('AI Image Generation', 'template', 'pro'),
  item('AI Profile', 'template', 'pro'),
  item('Finance Dashboard', 'template', 'pro'),
  item('Home Dashboard', 'template', 'pro'),
  item('Marketing Dashboard', 'template', 'pro'),
  item('Medical Profile', 'template', 'pro'),
  item('Multi-agent Chat', 'template', 'pro'),
  item('Project Board', 'template', 'pro'),
];

export function boardUiFreeItems(): readonly BoardUiItem[] {
  return BOARDUI_CATALOG_SNAPSHOT.filter((entry) => entry.tier === 'free');
}

export function boardUiProItems(): readonly BoardUiItem[] {
  return BOARDUI_CATALOG_SNAPSHOT.filter((entry) => entry.tier === 'pro');
}

/**
 * Whether an item needs a Pro licence, per the snapshot.
 *
 * `null` means "the snapshot does not know this slug" — never "free". A caller
 * must treat the unknown case as "ask the live catalog", because answering
 * "free" for a Pro item is how an unlicensed install turns into a failed run
 * the operator cannot explain.
 */
export function boardUiTierOf(slug: string): BoardUiTier | null {
  const normalized = boardUiSlug(slug);
  const found = BOARDUI_CATALOG_SNAPSHOT.find(
    (entry) => entry.slug === normalized,
  );
  return found ? found.tier : null;
}

export const BOARDUI_MAX_ITEMS = 32;
/** Install slug: lowercase, digits and dashes. No path, no flag, no shell. */
export const BOARDUI_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function assertBoardUiItems(
  items: readonly string[],
): readonly string[] {
  if (items.length === 0) {
    throw new UiKitCliError('NO_ITEMS', 'name at least one BoardUI item');
  }
  if (items.length > BOARDUI_MAX_ITEMS) {
    throw new UiKitCliError(
      'TOO_MANY_ITEMS',
      `at most ${BOARDUI_MAX_ITEMS} BoardUI items per run`,
    );
  }
  return items.map((raw) => {
    const value = raw.trim().toLowerCase();
    if (!BOARDUI_SLUG_PATTERN.test(value) || value.length > 64) {
      throw new UiKitCliError(
        'INVALID_ITEM',
        `a BoardUI item is a slug like date-picker, got: ${raw.slice(0, 48)}`,
      );
    }
    return value;
  });
}

/**
 * A project-relative directory for `--path` / `--dir`.
 *
 * Same rules as the shadcn destination: no absolute path, no `..`, and never
 * something commander would read as an option.
 */
export function assertBoardUiDir(raw: string): string {
  const value = raw.trim();
  if (value.length === 0 || value.length > 256) {
    throw new UiKitCliError('INVALID_PATH', 'empty or oversized target directory');
  }
  if (/[\0\r\n]/.test(value) || value.startsWith('-')) {
    throw new UiKitCliError(
      'INVALID_PATH',
      'a target directory may not start with "-" or contain a control character',
    );
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-z]:[\\/]/i.test(value)) {
    throw new UiKitCliError('INVALID_PATH', 'target directory must be relative to the project');
  }
  if (value.split(/[\\/]/).includes('..')) {
    throw new UiKitCliError('INVALID_PATH', 'target directory may not climb out of the project');
  }
  return value;
}

export type BoardUiCliCommand =
  | {
      readonly kind: 'init';
      readonly overwrite?: boolean;
      readonly dir?: string;
      /** Also install the deps the Pro components use (recharts, motion, …). */
      readonly pro?: boolean;
    }
  | {
      readonly kind: 'add';
      readonly items: readonly string[];
      readonly all?: boolean;
      readonly path?: string;
      readonly dir?: string;
      readonly overwrite?: boolean;
    };

/**
 * Build the argv. Flags verified against `boardui --help` / `add --help` /
 * `init --help` on 2026-10-21.
 *
 * `--yes` is NOT optional for us: both commands prompt without it, and a
 * headless spawn with no stdin would sit there until the runner's deadline
 * killed it — a hang that reads as "the kit is broken".
 */
export function buildBoardUiArgs(
  command: BoardUiCliCommand,
): readonly string[] {
  switch (command.kind) {
    case 'init': {
      const args = ['init', '--yes'];
      if (command.overwrite) args.push('--overwrite');
      if (command.dir) args.push('--dir', assertBoardUiDir(command.dir));
      if (command.pro) args.push('--pro');
      return args;
    }
    case 'add': {
      const args = ['add'];
      if (command.all) args.push('--all');
      else args.push(...assertBoardUiItems(command.items));
      args.push('--yes');
      if (command.path) args.push('--path', assertBoardUiDir(command.path));
      if (command.dir) args.push('--dir', assertBoardUiDir(command.dir));
      if (command.overwrite) args.push('--overwrite');
      return args;
    }
  }
}

/** Every BoardUI CLI command writes: `init` scaffolds, `add` installs. */
export function boardUiCommandWrites(_command: BoardUiCliCommand): boolean {
  return true;
}

export const BOARDUI_LICENSE_SECRET = 'external:boardui-license-key';
export const BOARDUI_MAX_LICENSE_CHARS = 512;

/**
 * Shape-check the licence key before it travels.
 *
 * The value is a secret: it is never echoed into the error, never logged, and
 * never placed in argv (see ui-kit-mcp-call.ts for why).
 */
export function assertBoardUiLicenseKey(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) {
    throw new UiKitCliError('EMPTY_LICENSE', 'the BoardUI licence key is empty');
  }
  if (value.length > BOARDUI_MAX_LICENSE_CHARS) {
    throw new UiKitCliError(
      'INVALID_LICENSE',
      `a BoardUI licence key stays under ${BOARDUI_MAX_LICENSE_CHARS} characters`,
    );
  }
  if (/[\s\0]/.test(value)) {
    throw new UiKitCliError(
      'INVALID_LICENSE',
      'the BoardUI licence key contains whitespace or a control character',
    );
  }
  return value;
}

/** Last 4 characters only, for a status line that proves nothing secret. */
export function maskBoardUiLicenseKey(raw: string): string {
  const value = raw.trim();
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

/**
 * Per-tool argument allowlist for the BoardUI MCP tools.
 *
 * This is not tidiness. BoardUI documents `projectDir` as an argument ("for
 * MCP, pass the package's absolute path as projectDir"), so forwarding a
 * model's `args` object would let it install components into any directory on
 * the machine — straight out of the pane's execution scope. Only the fields
 * below survive; the working directory comes from the scope and nowhere else.
 */
const BOARDUI_TOOL_ARGS: Record<BoardUiMcpTool, readonly string[]> = {
  get_started: [],
  list_components: ['type'],
  get_component: ['name'],
  get_usage_examples: ['name'],
  install_components: ['components'],
  init_boardui: [],
  install_rules: [],
  get_skill: [],
  install_skill: [],
  get_theme: [],
  // The key is injected from the vault after sanitizing, never accepted here.
  activate_license: [],
  license_status: [],
  deactivate_license: [],
};

export interface SanitizedBoardUiArgs {
  readonly args: Readonly<Record<string, unknown>>;
  /** Keys that were refused, so a caller can say what it ignored. */
  readonly dropped: readonly string[];
}

const BOARDUI_TYPE_PATTERN = /^[a-z][a-z-]{0,31}$/;

export function sanitizeBoardUiToolArgs(
  tool: BoardUiMcpTool,
  raw: unknown,
): SanitizedBoardUiArgs {
  const allowed = BOARDUI_TOOL_ARGS[tool];
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { args: out, dropped };
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      dropped.push(key);
      continue;
    }
    if (key === 'name') {
      const [slug] = assertBoardUiItems([String(value)]);
      out.name = slug;
      continue;
    }
    if (key === 'components') {
      const list = Array.isArray(value) ? value.map((entry) => String(entry)) : [String(value)];
      out.components = [...assertBoardUiItems(list)];
      continue;
    }
    if (key === 'type') {
      const type = String(value).trim().toLowerCase();
      if (!BOARDUI_TYPE_PATTERN.test(type)) {
        throw new UiKitCliError(
          'INVALID_ITEM',
          `a BoardUI item type is a short slug, got: ${String(value).slice(0, 32)}`,
        );
      }
      out.type = type;
      continue;
    }
    dropped.push(key);
  }
  return { args: out, dropped };
}
