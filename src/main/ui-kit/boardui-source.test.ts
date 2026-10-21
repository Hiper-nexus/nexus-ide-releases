import { describe, expect, it } from 'vitest';
import { UiKitCliError } from './ui-kit-cli';
import {
  assertBoardUiLicenseKey,
  assertBoardUiItems,
  assertBoardUiTool,
  boardUiFreeItems,
  boardUiProItems,
  boardUiSlug,
  boardUiTierOf,
  boardUiToolWrites,
  buildBoardUiArgs,
  maskBoardUiLicenseKey,
  sanitizeBoardUiToolArgs,
  BOARDUI_CATALOG_SNAPSHOT,
  BOARDUI_MCP_TOOLS,
} from './boardui-source';

describe('boardUiSlug', () => {
  it('turns a display name into an install slug', () => {
    expect(boardUiSlug('Date Picker')).toBe('date-picker');
    expect(boardUiSlug('Input OTP')).toBe('input-otp');
    expect(boardUiSlug('Multi-agent Chat')).toBe('multi-agent-chat');
  });
});

describe('the catalog snapshot', () => {
  it('has free and Pro items in both halves of the kit', () => {
    expect(boardUiFreeItems().length).toBeGreaterThan(40);
    expect(boardUiProItems().length).toBeGreaterThan(25);
  });

  it('keeps every slug unique', () => {
    const slugs = BOARDUI_CATALOG_SNAPSHOT.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('puts the dashboards behind Pro and the primitives in free', () => {
    expect(boardUiTierOf('finance-dashboard')).toBe('pro');
    expect(boardUiTierOf('home-dashboard')).toBe('pro');
    expect(boardUiTierOf('line-chart')).toBe('pro');
    expect(boardUiTierOf('button')).toBe('free');
    expect(boardUiTierOf('data-table')).toBe('free');
    expect(boardUiTierOf('sidebar')).toBe('free');
  });

  it('answers null — never "free" — for a slug it does not know', () => {
    // Answering "free" for an unknown item is how an unlicensed install turns
    // into a failure the operator cannot explain.
    expect(boardUiTierOf('some-item-shipped-next-month')).toBeNull();
  });

  it('accepts a display name as well as a slug', () => {
    expect(boardUiTierOf('Date Picker')).toBe('free');
  });
});

describe('assertBoardUiItems', () => {
  it('normalizes slugs', () => {
    expect(assertBoardUiItems(['Button', ' date-picker '])).toEqual([
      'button',
      'date-picker',
    ]);
  });

  it('refuses a flag, a path or whitespace smuggled into an item', () => {
    expect(() => assertBoardUiItems(['--help'])).toThrow(UiKitCliError);
    expect(() => assertBoardUiItems(['../etc/passwd'])).toThrow(UiKitCliError);
    expect(() => assertBoardUiItems(['button select'])).toThrow(UiKitCliError);
  });

  it('needs at least one item', () => {
    expect(() => assertBoardUiItems([])).toThrow(/at least one/);
  });
});

describe('buildBoardUiArgs', () => {
  it('always passes --yes, because without it a headless spawn hangs on a prompt', () => {
    // Verified against `boardui add --help`: `-y, --yes  skip prompts`.
    expect(buildBoardUiArgs({ kind: 'init' })).toEqual(['init', '--yes']);
    expect(buildBoardUiArgs({ kind: 'add', items: ['button', 'select'] })).toEqual([
      'add',
      'button',
      'select',
      '--yes',
    ]);
  });

  it('carries the measured flags', () => {
    expect(
      buildBoardUiArgs({ kind: 'init', overwrite: true, dir: 'src', pro: true }),
    ).toEqual(['init', '--yes', '--overwrite', '--dir', 'src', '--pro']);
    expect(
      buildBoardUiArgs({
        kind: 'add',
        items: [],
        all: true,
        path: 'src/components/ui',
        overwrite: true,
      }),
    ).toEqual([
      'add',
      '--all',
      '--yes',
      '--path',
      'src/components/ui',
      '--overwrite',
    ]);
  });

  it('refuses a directory that escapes the project or looks like an option', () => {
    expect(() => buildBoardUiArgs({ kind: 'init', dir: '../../etc' })).toThrow(/climb out/);
    expect(() => buildBoardUiArgs({ kind: 'init', dir: '/abs' })).toThrow(/relative/);
    expect(() => buildBoardUiArgs({ kind: 'add', items: ['button'], path: '-rf' })).toThrow(
      /may not start with "-"/,
    );
  });
});

describe('the MCP tool surface', () => {
  it('covers all thirteen published tools', () => {
    expect(BOARDUI_MCP_TOOLS).toHaveLength(13);
    expect(BOARDUI_MCP_TOOLS).toContain('activate_license');
    expect(BOARDUI_MCP_TOOLS).toContain('get_usage_examples');
    expect(BOARDUI_MCP_TOOLS).toContain('install_skill');
  });

  it('separates reading tools from writing ones', () => {
    expect(boardUiToolWrites('list_components')).toBe(false);
    expect(boardUiToolWrites('get_component')).toBe(false);
    expect(boardUiToolWrites('install_components')).toBe(true);
    expect(boardUiToolWrites('activate_license')).toBe(true);
  });

  it('refuses a tool name it does not publish', () => {
    expect(() => assertBoardUiTool('rm_rf')).toThrow(/unknown BoardUI tool/);
    expect(assertBoardUiTool(' get_theme ')).toBe('get_theme');
  });
});

describe('the licence key', () => {
  it('accepts a plausible key', () => {
    expect(assertBoardUiLicenseKey(' BUI-1234-ABCD ')).toBe('BUI-1234-ABCD');
  });

  it('refuses an empty or malformed key', () => {
    expect(() => assertBoardUiLicenseKey('   ')).toThrow(/empty/);
    expect(() => assertBoardUiLicenseKey('key with space')).toThrow(/whitespace/);
  });

  it('never echoes the key into the error message', () => {
    try {
      assertBoardUiLicenseKey('BUI SECRET VALUE');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain('SECRET');
    }
  });

  it('masks all but the last four characters', () => {
    expect(maskBoardUiLicenseKey('BUI-1234-WXYZ')).toBe('••••WXYZ');
    expect(maskBoardUiLicenseKey('abc')).toBe('••••');
  });
});

describe('sanitizeBoardUiToolArgs', () => {
  it('drops a projectDir that would escape the execution scope', () => {
    // BoardUI documents projectDir as an argument, so forwarding a model's
    // args would let it install into any directory on the machine.
    const result = sanitizeBoardUiToolArgs('install_components', {
      components: ['button'],
      projectDir: '/Users/someone/other-project',
      cwd: '/tmp',
      root: '/',
    });

    expect(result.args).toEqual({ components: ['button'] });
    expect([...result.dropped].sort()).toEqual(['cwd', 'projectDir', 'root']);
  });

  it('never accepts a licence key as an argument', () => {
    const result = sanitizeBoardUiToolArgs('activate_license', { licenseKey: 'BUI-X' });

    expect(result.args).toEqual({});
    expect(result.dropped).toEqual(['licenseKey']);
  });

  it('validates an item name and a component list', () => {
    expect(sanitizeBoardUiToolArgs('get_component', { name: 'Date-Picker' }).args)
      .toEqual({ name: 'date-picker' });
    expect(() => sanitizeBoardUiToolArgs('get_component', { name: '../secrets' }))
      .toThrow(UiKitCliError);
    expect(() => sanitizeBoardUiToolArgs('install_components', { components: ['--help'] }))
      .toThrow(UiKitCliError);
  });

  it('refuses a display name rather than quietly rewriting it', () => {
    // The catalog tool hands back `slug`, so a space means the caller sent
    // something else. A "cleaned" value is the one that gets through.
    expect(() => sanitizeBoardUiToolArgs('get_component', { name: 'Date Picker' }))
      .toThrow(/slug like date-picker/);
  });

  it('validates the listing type and refuses junk', () => {
    expect(sanitizeBoardUiToolArgs('list_components', { type: 'block' }).args)
      .toEqual({ type: 'block' });
    expect(() => sanitizeBoardUiToolArgs('list_components', { type: '../../etc' }))
      .toThrow(/short slug/);
  });

  it('accepts nothing at all for a tool that takes nothing', () => {
    expect(sanitizeBoardUiToolArgs('get_theme', { anything: 1 }).dropped).toEqual(['anything']);
    expect(sanitizeBoardUiToolArgs('get_theme', undefined).args).toEqual({});
  });
});
