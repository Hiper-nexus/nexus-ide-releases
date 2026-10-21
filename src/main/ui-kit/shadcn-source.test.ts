import { describe, expect, it } from 'vitest';
import { UiKitCliError } from './ui-kit-cli';
import {
  buildShadcnArgs,
  classifyShadcnItem,
  referencedShadcnNamespaces,
  shadcnCommandWrites,
  type ShadcnCommand,
} from './shadcn-source';

const EVERY_KIND: readonly ShadcnCommand[] = [
  { kind: 'init', template: 'next', base: 'radix', preset: 'nova' },
  { kind: 'add', items: ['button'] },
  { kind: 'apply', preset: 'a2r6bw', only: 'theme' },
  { kind: 'preset-decode', code: 'a2r6bw' },
  { kind: 'preset-resolve' },
  { kind: 'preset-url', code: 'a2r6bw' },
  { kind: 'view', items: ['@shadcn/button'] },
  { kind: 'search', registries: ['@shadcn'], query: 'button' },
  { kind: 'build' },
  { kind: 'docs', component: 'button' },
  { kind: 'info' },
  { kind: 'migrate', migration: 'icons', from: 'lucide', to: 'phosphor' },
  { kind: 'eject' },
];

describe('buildShadcnArgs — the full documented surface', () => {
  it.each(EVERY_KIND)('builds argv for $kind without --cwd or --silent', (command) => {
    const args = buildShadcnArgs(command);

    expect(args.length).toBeGreaterThan(0);
    expect(args).not.toContain('--cwd');
    expect(args).not.toContain('-c');
    expect(args).not.toContain('--silent');
    expect(args[0]).toBe(
      command.kind.startsWith('preset-') ? 'preset' : command.kind,
    );
  });

  it('adds items with --yes', () => {
    expect(buildShadcnArgs({ kind: 'add', items: ['button', 'dashboard-01'] })).toEqual([
      'add',
      '--yes',
      'button',
      'dashboard-01',
    ]);
  });

  it('uses --all instead of item names', () => {
    expect(buildShadcnArgs({ kind: 'add', items: [], all: true })).toEqual([
      'add',
      '--yes',
      '--all',
    ]);
  });

  it('passes overwrite, path and dry-run through', () => {
    expect(
      buildShadcnArgs({
        kind: 'add',
        items: ['button'],
        overwrite: true,
        path: 'src/components/ui',
        dryRun: true,
      }),
    ).toEqual([
      'add',
      '--yes',
      'button',
      '--overwrite',
      '--path',
      'src/components/ui',
      '--dry-run',
    ]);
  });

  it('searches several namespaced registries at once', () => {
    expect(
      buildShadcnArgs({
        kind: 'search',
        registries: ['@shadcn', '@v0'],
        query: 'sidebar',
        limit: 25,
        offset: 50,
      }),
    ).toEqual([
      'search',
      '@shadcn',
      '@v0',
      '--query',
      'sidebar',
      '--limit',
      '25',
      '--offset',
      '50',
    ]);
  });

  it('negates boolean init flags explicitly', () => {
    const args = buildShadcnArgs({ kind: 'init', cssVariables: false, monorepo: true, rtl: false });

    expect(args).toContain('--no-css-variables');
    expect(args).toContain('--monorepo');
    expect(args).toContain('--no-rtl');
  });
});

describe('shadcnCommandWrites', () => {
  it('marks the mutating commands', () => {
    expect(shadcnCommandWrites({ kind: 'add', items: ['button'] })).toBe(true);
    expect(shadcnCommandWrites({ kind: 'init' })).toBe(true);
    expect(shadcnCommandWrites({ kind: 'eject' })).toBe(true);
    expect(shadcnCommandWrites({ kind: 'migrate', migration: 'rtl' })).toBe(true);
  });

  it('treats a dry-run add and every query as read-only', () => {
    expect(shadcnCommandWrites({ kind: 'add', items: ['button'], dryRun: true })).toBe(false);
    expect(shadcnCommandWrites({ kind: 'search', registries: ['@shadcn'] })).toBe(false);
    expect(shadcnCommandWrites({ kind: 'view', items: ['button'] })).toBe(false);
    expect(shadcnCommandWrites({ kind: 'info' })).toBe(false);
  });
});

describe('classifyShadcnItem', () => {
  it('accepts plain, namespaced and https items', () => {
    expect(classifyShadcnItem('button')).toBe('plain');
    expect(classifyShadcnItem('dashboard-01')).toBe('plain');
    expect(classifyShadcnItem('@acme/auth')).toBe('namespaced');
    expect(classifyShadcnItem('@shadcn')).toBe('namespaced');
    expect(classifyShadcnItem('https://registry.example.com/r/button.json')).toBe('url');
    expect(classifyShadcnItem('registry/button.json')).toBe('relative');
  });

  it('refuses plain http for a registry item', () => {
    expect(() => classifyShadcnItem('http://registry.example.com/button.json')).toThrow(
      /must be https/,
    );
  });

  it('refuses an absolute path or a parent-directory hop', () => {
    expect(() => classifyShadcnItem('/etc/passwd.json')).toThrow(/relative to the project/);
    expect(() => classifyShadcnItem('../../secrets.json')).toThrow(/climb out/);
  });

  it('refuses whitespace smuggled into an item', () => {
    expect(() => classifyShadcnItem('button --cwd /tmp')).toThrow(UiKitCliError);
  });
});

describe('path and option guards', () => {
  it('refuses an add --path that escapes the project', () => {
    expect(() =>
      buildShadcnArgs({ kind: 'add', items: ['button'], path: '../../../tmp' }),
    ).toThrow(/climb out/);
    expect(() =>
      buildShadcnArgs({ kind: 'add', items: ['button'], path: '/tmp/evil' }),
    ).toThrow(/relative to the project/);
  });

  it('refuses an unknown template, base, migration or apply part', () => {
    expect(() =>
      buildShadcnArgs({ kind: 'init', template: 'svelte' as never }),
    ).toThrow(/must be one of/);
    expect(() =>
      buildShadcnArgs({ kind: 'migrate', migration: 'drop-tables' as never }),
    ).toThrow(/must be one of/);
    expect(() =>
      buildShadcnArgs({ kind: 'apply', preset: 'nova', only: 'everything' as never }),
    ).toThrow(/must be one of/);
  });

  it('bounds the search limit', () => {
    expect(() =>
      buildShadcnArgs({ kind: 'search', registries: ['@shadcn'], limit: 10_000 }),
    ).toThrow(/between 0 and/);
  });

  it('refuses a registry that is not a namespace', () => {
    expect(() =>
      buildShadcnArgs({ kind: 'search', registries: ['https://evil.test'] }),
    ).toThrow(/namespace like @shadcn/);
  });

  it('caps the item count', () => {
    const many = Array.from({ length: 33 }, (_, i) => `item-${i}`);
    expect(() => buildShadcnArgs({ kind: 'add', items: many })).toThrow(/at most/);
  });
});

describe('option injection', () => {
  it('refuses an item that starts with "-" even when it looks like a path', () => {
    // This was the hole: the `.json` branch ran BEFORE the pattern test, so
    // `-x.json` was classified as a local registry path and handed to
    // commander as an option.
    expect(() => classifyShadcnItem('-x.json')).toThrow(/may not start with "-"/);
    expect(() => classifyShadcnItem('--overwrite.json')).toThrow(/may not start with "-"/);
    expect(() => classifyShadcnItem('-button')).toThrow(/may not start with "-"/);
  });

  it('refuses an option-shaped destination path', () => {
    expect(() =>
      buildShadcnArgs({ kind: 'add', items: ['button'], path: '-rf' }),
    ).toThrow(/may not start with "-"/);
  });

  it('refuses an option-shaped search query', () => {
    expect(() =>
      buildShadcnArgs({ kind: 'search', registries: ['@shadcn'], query: '--all' }),
    ).toThrow(/may not start with "-"/);
  });
});

describe('referencedShadcnNamespaces — credential scope', () => {
  it('names only the namespaces the command touches', () => {
    expect(referencedShadcnNamespaces({ kind: 'add', items: ['@acme/auth', 'button'] }))
      .toEqual(['@acme']);
    expect(referencedShadcnNamespaces({ kind: 'view', items: ['@v0/dashboard'] }))
      .toEqual(['@v0']);
    expect(referencedShadcnNamespaces({ kind: 'search', registries: ['@shadcn', '@acme'] }))
      .toEqual(['@shadcn', '@acme']);
  });

  it('names nothing for a public item, a URL or a local path', () => {
    expect(referencedShadcnNamespaces({ kind: 'add', items: ['button'] })).toEqual([]);
    expect(
      referencedShadcnNamespaces({
        kind: 'add',
        items: ['https://registry.example.com/r/button.json'],
      }),
    ).toEqual([]);
    expect(referencedShadcnNamespaces({ kind: 'add', items: ['registry/button.json'] }))
      .toEqual([]);
  });

  it('names nothing for a command with no items at all', () => {
    expect(referencedShadcnNamespaces({ kind: 'info' })).toEqual([]);
    expect(referencedShadcnNamespaces({ kind: 'add', items: [], all: true })).toEqual([]);
  });
});
