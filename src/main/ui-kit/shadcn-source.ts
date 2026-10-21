import { UiKitCliError } from './ui-kit-cli';

/**
 * The whole `shadcn` CLI surface, as typed commands.
 *
 * Nothing here takes raw argv from a caller. A model (or the settings panel)
 * passes a typed command and THIS module builds the argv, which is what keeps
 * two things true no matter who calls:
 *
 * - `--cwd` is never settable. The runner decides the directory from the pane's
 *   authorized execution scope; a caller that could pass `--cwd` would write
 *   components into any folder on the machine.
 * - every flag is one we chose. A free-form argv would let `add` reach
 *   `--path ../../..` or a flag a future CLI version gives a new meaning.
 *
 * Command set verified against https://ui.shadcn.com/docs/cli (2026-10-21):
 * init, add, apply, preset (decode|resolve|url|open), view, search/list,
 * build, docs, info, migrate, eject.
 */

export const SHADCN_TEMPLATES = [
  'next',
  'vite',
  'start',
  'react-router',
  'laravel',
  'astro',
] as const;
export type ShadcnTemplate = (typeof SHADCN_TEMPLATES)[number];

export const SHADCN_BASES = ['base', 'radix', 'aria'] as const;
export type ShadcnBase = (typeof SHADCN_BASES)[number];

export const SHADCN_MIGRATIONS = [
  'cn',
  'icons',
  'base-color',
  'rtl',
  'radix',
] as const;
export type ShadcnMigration = (typeof SHADCN_MIGRATIONS)[number];

export const SHADCN_APPLY_PARTS = ['theme', 'font'] as const;
export type ShadcnApplyPart = (typeof SHADCN_APPLY_PARTS)[number];

export const SHADCN_MAX_ITEMS = 32;
export const SHADCN_MAX_REGISTRIES = 16;
export const SHADCN_MAX_QUERY_CHARS = 128;
export const SHADCN_MAX_LIMIT = 200;

/** `button`, `dashboard-01`, `sidebar/app-sidebar`. No `..`, no absolute path. */
const PLAIN_ITEM_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;
/** `@acme/auth`, `@v0/dashboard`, and a bare namespace `@shadcn`. */
const NAMESPACED_ITEM_PATTERN =
  /^@[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*)?$/i;
/** A bare namespace, which is what `search`/`list` take. */
const NAMESPACE_PATTERN = /^@[a-z0-9][a-z0-9-]*$/i;

export type ShadcnItemKind = 'plain' | 'namespaced' | 'url' | 'relative';

export function classifyShadcnItem(raw: string): ShadcnItemKind {
  const item = raw.trim();
  if (item.length === 0 || item.length > 256) {
    throw new UiKitCliError('INVALID_ITEM', 'empty or oversized registry item');
  }
  if (/[\0\r\n\s]/.test(item)) {
    throw new UiKitCliError(
      'INVALID_ITEM',
      `registry item contains whitespace or a control character: ${item.slice(0, 64)}`,
    );
  }
  // Before ANY branch. `-x.json` used to reach the `.json` check and be
  // classified as a local registry path, which handed commander an option.
  if (item.startsWith('-')) {
    throw new UiKitCliError(
      'OPTION_LIKE_ITEM',
      `a registry item may not start with "-": ${item.slice(0, 64)}`,
    );
  }
  if (/^https?:\/\//i.test(item)) {
    let parsed: URL;
    try {
      parsed = new URL(item);
    } catch {
      throw new UiKitCliError('INVALID_ITEM', `unparseable registry URL: ${item.slice(0, 64)}`);
    }
    if (parsed.protocol !== 'https:') {
      // A registry item is code that lands in the user's project. Plain HTTP
      // would let anyone on the path choose that code.
      throw new UiKitCliError(
        'INSECURE_REGISTRY_URL',
        'a registry URL must be https',
      );
    }
    return 'url';
  }
  if (item.startsWith('@')) {
    if (!NAMESPACED_ITEM_PATTERN.test(item)) {
      throw new UiKitCliError(
        'INVALID_ITEM',
        `malformed namespaced item: ${item.slice(0, 64)}`,
      );
    }
    return 'namespaced';
  }
  // A local registry file is legitimate (the CLI documents "name, url or local
  // path"), but only inside the project: an absolute path or a `..` hop would
  // read a registry definition from anywhere on the machine.
  if (item.startsWith('/') || item.startsWith('\\') || /^[a-z]:/i.test(item)) {
    throw new UiKitCliError(
      'ABSOLUTE_ITEM_PATH',
      'a local registry path must be relative to the project',
    );
  }
  if (item.split(/[\\/]/).includes('..')) {
    throw new UiKitCliError(
      'ESCAPING_ITEM_PATH',
      'a local registry path may not climb out of the project',
    );
  }
  if (item.endsWith('.json')) return 'relative';
  if (!PLAIN_ITEM_PATTERN.test(item)) {
    throw new UiKitCliError(
      'INVALID_ITEM',
      `malformed registry item: ${item.slice(0, 64)}`,
    );
  }
  return 'plain';
}

export function assertShadcnItems(items: readonly string[]): readonly string[] {
  if (items.length === 0) {
    throw new UiKitCliError('NO_ITEMS', 'name at least one registry item');
  }
  if (items.length > SHADCN_MAX_ITEMS) {
    throw new UiKitCliError(
      'TOO_MANY_ITEMS',
      `at most ${SHADCN_MAX_ITEMS} items per run`,
    );
  }
  return items.map((item) => {
    classifyShadcnItem(item);
    return item.trim();
  });
}

export function assertShadcnRegistries(
  registries: readonly string[],
): readonly string[] {
  if (registries.length === 0) {
    throw new UiKitCliError('NO_REGISTRY', 'name at least one registry, e.g. @shadcn');
  }
  if (registries.length > SHADCN_MAX_REGISTRIES) {
    throw new UiKitCliError(
      'TOO_MANY_REGISTRIES',
      `at most ${SHADCN_MAX_REGISTRIES} registries per search`,
    );
  }
  return registries.map((raw) => {
    const value = raw.trim();
    if (!NAMESPACE_PATTERN.test(value)) {
      throw new UiKitCliError(
        'INVALID_REGISTRY',
        `a registry is a namespace like @shadcn, got: ${value.slice(0, 64)}`,
      );
    }
    return value;
  });
}

/** A project-relative destination for `add --path`. */
export function assertRelativeProjectPath(raw: string): string {
  const value = raw.trim();
  if (value.length === 0 || value.length > 256) {
    throw new UiKitCliError('INVALID_PATH', 'empty or oversized target path');
  }
  if (/[\0\r\n]/.test(value)) {
    throw new UiKitCliError('INVALID_PATH', 'target path contains a control character');
  }
  if (value.startsWith('-')) {
    throw new UiKitCliError(
      'OPTION_LIKE_PATH',
      'a target path may not start with "-"',
    );
  }
  // `/^[a-z]:/i` with no slash on purpose: on Windows `C:foo` is
  // DRIVE-RELATIVE and resolves against drive C's current directory, not this
  // project, so requiring a slash after the colon let it through.
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-z]:/i.test(value)) {
    throw new UiKitCliError(
      'INVALID_PATH',
      'target path must be relative to the project',
    );
  }
  if (value.split(/[\\/]/).includes('..')) {
    throw new UiKitCliError(
      'INVALID_PATH',
      'target path may not climb out of the project',
    );
  }
  return value;
}

function assertPresetCode(raw: string): string {
  const value = raw.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(value)) {
    throw new UiKitCliError(
      'INVALID_PRESET',
      `a preset code is alphanumeric, got: ${value.slice(0, 64)}`,
    );
  }
  return value;
}

export type ShadcnCommand =
  | {
      readonly kind: 'init';
      readonly items?: readonly string[];
      readonly template?: ShadcnTemplate;
      readonly base?: ShadcnBase;
      readonly preset?: string;
      readonly name?: string;
      readonly defaults?: boolean;
      readonly force?: boolean;
      readonly cssVariables?: boolean;
      readonly monorepo?: boolean;
      readonly rtl?: boolean;
      readonly reinstall?: boolean;
    }
  | {
      readonly kind: 'add';
      readonly items: readonly string[];
      readonly all?: boolean;
      readonly overwrite?: boolean;
      readonly path?: string;
      readonly dryRun?: boolean;
    }
  | {
      readonly kind: 'apply';
      readonly preset: string;
      readonly only?: ShadcnApplyPart;
    }
  | { readonly kind: 'preset-decode'; readonly code: string }
  | { readonly kind: 'preset-resolve' }
  | { readonly kind: 'preset-url'; readonly code: string }
  | { readonly kind: 'view'; readonly items: readonly string[] }
  | {
      readonly kind: 'search';
      readonly registries: readonly string[];
      readonly query?: string;
      readonly limit?: number;
      readonly offset?: number;
    }
  | { readonly kind: 'build'; readonly registry?: string; readonly output?: string }
  | { readonly kind: 'docs'; readonly component?: string; readonly base?: ShadcnBase }
  | { readonly kind: 'info' }
  | {
      readonly kind: 'migrate';
      readonly migration: ShadcnMigration;
      readonly from?: string;
      readonly to?: string;
    }
  | { readonly kind: 'eject' };

export type ShadcnCommandKind = ShadcnCommand['kind'];

/** Commands that write files or install dependencies into the project. */
const WRITING_KINDS = new Set<ShadcnCommandKind>([
  'init',
  'add',
  'apply',
  'build',
  'migrate',
  'eject',
]);

export function shadcnCommandWrites(command: ShadcnCommand): boolean {
  // A dry run reports what WOULD change and touches nothing.
  if (command.kind === 'add' && command.dryRun === true) return false;
  return WRITING_KINDS.has(command.kind);
}

/**
 * Commands whose result is only meaningful as text for a human/agent to read,
 * so callers can render them without guessing.
 */
export function shadcnCommandIsQuery(command: ShadcnCommand): boolean {
  return !shadcnCommandWrites(command);
}

/**
 * Whether the command takes `-c, --cwd`.
 *
 * This is what lets the package be RESOLVED outside the project while the
 * command still operates on it. `preset decode` and `preset url` are pure
 * string operations and document no cwd flag, so they simply run wherever the
 * runner put them.
 */
export function shadcnCommandAcceptsCwd(command: ShadcnCommand): boolean {
  return command.kind !== 'preset-decode' && command.kind !== 'preset-url';
}

function enumArg<T extends string>(
  label: string,
  value: string,
  allowed: readonly T[],
): T {
  const found = allowed.find((candidate) => candidate === value);
  if (!found) {
    throw new UiKitCliError(
      'INVALID_OPTION',
      `${label} must be one of ${allowed.join(', ')}, got: ${value.slice(0, 32)}`,
    );
  }
  return found;
}

function boundedInt(label: string, value: number, max: number): string {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new UiKitCliError(
      'INVALID_OPTION',
      `${label} must be an integer between 0 and ${max}`,
    );
  }
  return String(value);
}

/**
 * Build the argv for a typed command. `--silent` is never added: the output is
 * the only thing the caller gets back, and a silent run would report nothing.
 */
export function buildShadcnArgs(command: ShadcnCommand): readonly string[] {
  switch (command.kind) {
    case 'init': {
      const args = ['init', '--yes'];
      if (command.items && command.items.length > 0) {
        args.push(...assertShadcnItems(command.items));
      }
      if (command.template) {
        args.push('--template', enumArg('template', command.template, SHADCN_TEMPLATES));
      }
      if (command.base) {
        args.push('--base', enumArg('base', command.base, SHADCN_BASES));
      }
      if (command.preset) args.push('--preset', assertPresetCode(command.preset));
      if (command.name) args.push('--name', assertProjectName(command.name));
      if (command.defaults) args.push('--defaults');
      if (command.force) args.push('--force');
      if (command.cssVariables === true) args.push('--css-variables');
      if (command.cssVariables === false) args.push('--no-css-variables');
      if (command.monorepo === true) args.push('--monorepo');
      if (command.monorepo === false) args.push('--no-monorepo');
      if (command.rtl === true) args.push('--rtl');
      if (command.rtl === false) args.push('--no-rtl');
      if (command.reinstall === true) args.push('--reinstall');
      return args;
    }
    case 'add': {
      const args = ['add', '--yes'];
      if (command.all) args.push('--all');
      else args.push(...assertShadcnItems(command.items));
      if (command.overwrite) args.push('--overwrite');
      if (command.path) args.push('--path', assertRelativeProjectPath(command.path));
      if (command.dryRun) args.push('--dry-run');
      return args;
    }
    case 'apply': {
      const args = ['apply', assertPresetCode(command.preset), '--yes'];
      if (command.only) {
        args.push('--only', enumArg('only', command.only, SHADCN_APPLY_PARTS));
      }
      return args;
    }
    case 'preset-decode':
      return ['preset', 'decode', assertPresetCode(command.code), '--json'];
    case 'preset-resolve':
      return ['preset', 'resolve', '--json'];
    case 'preset-url':
      return ['preset', 'url', assertPresetCode(command.code)];
    case 'view':
      return ['view', ...assertShadcnItems(command.items)];
    case 'search': {
      const args = ['search', ...assertShadcnRegistries(command.registries)];
      if (command.query !== undefined) {
        const query = command.query.trim();
        if (query.length > SHADCN_MAX_QUERY_CHARS) {
          throw new UiKitCliError(
            'INVALID_OPTION',
            `query exceeds ${SHADCN_MAX_QUERY_CHARS} characters`,
          );
        }
        if (/[\0\r\n]/.test(query)) {
          throw new UiKitCliError('INVALID_OPTION', 'query contains a control character');
        }
        if (query.startsWith('-')) {
          throw new UiKitCliError(
            'INVALID_OPTION',
            'a search query may not start with "-"',
          );
        }
        if (query.length > 0) args.push('--query', query);
      }
      if (command.limit !== undefined) {
        args.push('--limit', boundedInt('limit', command.limit, SHADCN_MAX_LIMIT));
      }
      if (command.offset !== undefined) {
        args.push('--offset', boundedInt('offset', command.offset, 100_000));
      }
      return args;
    }
    case 'build': {
      const args = ['build'];
      if (command.registry) args.push(assertRelativeProjectPath(command.registry));
      if (command.output) args.push('--output', assertRelativeProjectPath(command.output));
      return args;
    }
    case 'docs': {
      const args = ['docs'];
      if (command.component) {
        classifyShadcnItem(command.component);
        args.push(command.component.trim());
      }
      if (command.base) {
        args.push('--base', enumArg('base', command.base, SHADCN_BASES));
      }
      args.push('--json');
      return args;
    }
    case 'info':
      return ['info', '--json'];
    case 'migrate': {
      const args = [
        'migrate',
        enumArg('migration', command.migration, SHADCN_MIGRATIONS),
        '--yes',
      ];
      if (command.from) args.push('--from', assertMigrationName(command.from));
      if (command.to) args.push('--to', assertMigrationName(command.to));
      return args;
    }
    case 'eject':
      return ['eject', '--yes'];
  }
}

/**
 * The registry namespaces a command actually references.
 *
 * This drives credential scope: handing every configured token to every run
 * means `shadcn add button` — a public component — carries a private
 * registry's token into an untrusted npm child for no reason.
 *
 * A URL or local-path item references no namespace, so it gets nothing.
 */
export function referencedShadcnNamespaces(
  command: ShadcnCommand,
): readonly string[] {
  const namespaces = new Set<string>();
  const addFromItems = (items: readonly string[]): void => {
    for (const raw of items) {
      const item = raw.trim();
      if (!item.startsWith('@')) continue;
      const slash = item.indexOf('/');
      namespaces.add(slash > 0 ? item.slice(0, slash) : item);
    }
  };
  switch (command.kind) {
    case 'add':
      if (!command.all) addFromItems(command.items);
      break;
    case 'view':
      addFromItems(command.items);
      break;
    case 'init':
      if (command.items) addFromItems(command.items);
      break;
    case 'search':
      for (const registry of command.registries) namespaces.add(registry.trim());
      break;
    default:
      break;
  }
  return [...namespaces];
}

function assertProjectName(raw: string): string {
  const value = raw.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value)) {
    throw new UiKitCliError(
      'INVALID_OPTION',
      `project name is alphanumeric, got: ${value.slice(0, 32)}`,
    );
  }
  return value;
}

function assertMigrationName(raw: string): string {
  const value = raw.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/i.test(value)) {
    throw new UiKitCliError(
      'INVALID_OPTION',
      `migration name is alphanumeric, got: ${value.slice(0, 32)}`,
    );
  }
  return value;
}
