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

/** `Date Picker` -> `date-picker`. The CLI takes slugs, the site shows names. */
export function boardUiSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The FREE catalogue, taken from `boardui list` on 2026-10-21.
 *
 * It used to be derived from the website's display names, and that was wrong
 * in ways that broke installs: `revenue-chart` instead of `revenue-chart-card`,
 * a `color` item that does not exist, and the Pro templates whose real
 * identifier carries a `template-` prefix. A slug is a vendor identifier — it
 * is READ from the vendor, never spelled from a label.
 *
 * Pro items are deliberately ABSENT: `boardui list` without a licence does not
 * publish them, so any Pro entry here would be invented. `boardUiTierOf`
 * therefore answers `null` for them, and the caller must resolve the tier
 * against the live catalogue (see `resolveBoardUiTier`) rather than assume
 * free — assuming free is how an unlicensed install reaches the vendor and
 * fails with a message nobody can act on.
 */
function item(
  slug: string,
  name: string,
  category: BoardUiCategory,
): BoardUiItem {
  return { slug, name, category, tier: 'free' };
}

export const BOARDUI_CATALOG_SNAPSHOT: readonly BoardUiItem[] = [
  item('tree-view', 'Tree View', 'base'),
  item('button', 'Button', 'base'),
  item('icon-button', 'Icon Button', 'base'),
  item('link-button', 'Link Button', 'base'),
  item('button-group', 'Button Group', 'base'),
  item('close-button', 'Close Button', 'base'),
  item('input', 'Input', 'base'),
  item('textarea', 'Textarea', 'base'),
  item('checkbox', 'Checkbox', 'base'),
  item('checkbox-card', 'Checkbox Card', 'base'),
  item('radio', 'Radio', 'base'),
  item('radio-card', 'Radio Card', 'base'),
  item('switch', 'Switch', 'base'),
  item('switch-card', 'Switch Card', 'base'),
  item('select', 'Select', 'base'),
  item('slider', 'Slider', 'base'),
  item('social-button', 'Social Button', 'base'),
  item('dropdown', 'Dropdown', 'base'),
  item('divider', 'Divider', 'base'),
  item('file-upload', 'File Upload', 'base'),
  item('tabs', 'Tabs', 'base'),
  item('table', 'Table', 'base'),
  item('tooltip', 'Tooltip', 'base'),
  item('badge', 'Badge', 'base'),
  item('chip', 'Chip', 'base'),
  item('status-dot', 'Status Dot', 'base'),
  item('avatar', 'Avatar', 'base'),
  item('breadcrumb', 'Breadcrumb', 'base'),
  item('pagination', 'Pagination', 'base'),
  item('carousel', 'Carousel', 'base'),
  item('input-otp', 'Input OTP', 'base'),
  item('segmented-control', 'Segmented Control', 'base'),
  item('announcement', 'Announcement', 'base'),
  item('notification', 'Notification', 'base'),
  item('kbd', 'Kbd', 'base'),
  item('date-picker', 'Date Picker', 'base'),
  item('date-range-picker', 'Date Range Picker', 'base'),
  item('meeting-scheduler', 'Meeting Scheduler', 'base'),
  item('theme-toggle', 'Theme Toggle', 'block'),
  item('agent-chat', 'Agent Chat', 'block'),
  item('app-shell', 'App Shell', 'block'),
  item('agent-thinking', 'Agent Thinking', 'block'),
  item('agent-log', 'Agent Log', 'block'),
  item('composer-loader', 'Composer Loader', 'block'),
  item('sidebar', 'Sidebar', 'block'),
  item('settings-modal', 'Settings Modal', 'block'),
  item('auth-card', 'Auth Card', 'block'),
  item('notification-center', 'Notification Center', 'block'),
  item('data-grid', 'Data Grid', 'block'),
  item('data-table', 'Data Table', 'block'),
  item('stat-cards', 'Stat Cards', 'block'),
  item('revenue-chart-card', 'Revenue Chart Card', 'block'),
  item('orders-chart-card', 'Orders Chart Card', 'block'),
  item('important-alerts-card', 'Important Alerts Card', 'block'),
  item('patient-info-card', 'Patient Info Card', 'block'),
  item('template-copy', 'Template Copy', 'foundation'),
  item('direction', 'Direction', 'foundation'),
  item('scroll-direction', 'Scroll Direction', 'foundation'),
  item('directional-icon', 'Directional Icon', 'foundation'),
  item('theme', 'Theme', 'foundation'),
  item('typography', 'Typography', 'foundation'),
  item('globals', 'Globals', 'foundation'),
  item('cx', 'cx', 'foundation'),
  item('rules', 'Rules', 'foundation'),
  item('use-dismiss-on-outside-press', 'Use Dismiss On Outside Press', 'foundation'),
  item('use-count-up', 'Use Count Up', 'foundation'),
  item('chevrons', 'Chevrons', 'foundation'),
  item('logo', 'Logo', 'foundation'),
  item('agent-runtime', 'Agent Runtime', 'foundation'),
];

export function boardUiFreeItems(): readonly BoardUiItem[] {
  return BOARDUI_CATALOG_SNAPSHOT.filter((entry) => entry.tier === 'free');
}

/**
 * Deliberately empty: `boardui list` without a licence does not publish the Pro
 * items, so naming any here would be inventing vendor identifiers — which is
 * precisely the defect this snapshot was rebuilt to remove.
 */
export function boardUiProItems(): readonly BoardUiItem[] {
  return [];
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
  // No slash required after the colon: `C:foo` is drive-relative on Windows.
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-z]:/i.test(value)) {
    throw new UiKitCliError('INVALID_PATH', 'target directory must be relative to the project');
  }
  if (value.split(/[\\/]/).includes('..')) {
    throw new UiKitCliError('INVALID_PATH', 'target directory may not climb out of the project');
  }
  return value;
}

export type BoardUiCliCommand =
  | { readonly kind: 'list' }
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
    case 'list':
      return ['list'];
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

/** `init` scaffolds and `add` installs; `list` only reads the catalogue. */
export function boardUiCommandWrites(command: BoardUiCliCommand): boolean {
  return command.kind !== 'list';
}

/**
 * Whether the command needs the project as its working directory.
 *
 * `list` does not: it prints the VENDOR's catalogue and was measured working
 * in an empty scratch directory. That matters because BoardUI has no `--cwd`,
 * so a command that needs the project must be spawned in it — and npm reads a
 * `.npmrc` from its cwd while npx prefers `node_modules/.bin`, which means the
 * repository gets to choose the code that runs. `init` and `add` write into
 * the project and have no way around it; `list` does, and it is the one the
 * catalogue browse path and the tier gate call, so it resolves outside.
 */
export function boardUiCommandNeedsProject(command: BoardUiCliCommand): boolean {
  return command.kind !== 'list';
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
