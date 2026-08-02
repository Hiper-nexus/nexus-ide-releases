/**
 * Tests for the BYOH harness catalog schema.
 *
 * Design distilled from block/buzz buzz-acp (Apache-2.0).
 */

import { describe, expect, test } from 'vitest';

import {
  BUILTIN_HARNESS_IDS,
  PRESET_HARNESSES,
  RESERVED_HARNESS_ENV_KEYS,
  RESERVED_HARNESS_IDS,
  parseHarnessDefinition,
} from './harness-catalog';

const VALID_INPUT = {
  id: 'my-agent',
  label: 'My Agent',
  command: 'my-agent-bin',
  args: ['acp'],
  env: { MY_AGENT_MODE: 'acp' },
  installInstructionsUrl: 'https://example.com/docs',
  installHint: 'Download from example.com',
};

describe('parseHarnessDefinition — happy path', () => {
  test('accepts the documented custom harness JSON shape', () => {
    // Act
    const result = parseHarnessDefinition(VALID_INPUT);

    // Assert
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.harness).toMatchObject({
      id: 'my-agent',
      label: 'My Agent',
      command: 'my-agent-bin',
      args: ['acp'],
      env: { MY_AGENT_MODE: 'acp' },
      tier: 'custom',
      canAutoInstall: false,
      installInstructionsUrl: 'https://example.com/docs',
    });
    expect(result.strippedEnvKeys).toEqual([]);
  });

  test('result is deeply frozen (immutable by construction)', () => {
    const result = parseHarnessDefinition(VALID_INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.harness)).toBe(true);
    expect(Object.isFrozen(result.harness.args)).toBe(true);
    expect(Object.isFrozen(result.harness.env)).toBe(true);
    expect(() => {
      (result.harness as { command: string }).command = 'evil';
    }).toThrow();
  });

  test('label defaults to id and args/env default to empty', () => {
    const result = parseHarnessDefinition({ id: 'bare', command: 'bare-bin' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.harness.label).toBe('bare');
    expect(result.harness.args).toEqual([]);
    expect(result.harness.env).toEqual({});
  });
});

describe('parseHarnessDefinition — reserved env keys are always stripped', () => {
  test('strips every reserved Nexus identity key and reports them', () => {
    // Arrange — a definition trying to override Nexus identity/credentials
    const hostileEnv: Record<string, string> = { SAFE_KEY: 'ok' };
    for (const key of RESERVED_HARNESS_ENV_KEYS) hostileEnv[key] = 'hijacked';

    // Act
    const result = parseHarnessDefinition({
      id: 'sneaky',
      command: 'sneaky-bin',
      env: hostileEnv,
    });

    // Assert — parse succeeds (portability), but no reserved key survives
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.harness.env)).toEqual(['SAFE_KEY']);
    expect([...result.strippedEnvKeys].sort()).toEqual(
      [...RESERVED_HARNESS_ENV_KEYS].sort(),
    );
  });

  test('NEXUS_MCP_TOKEN specifically can never ride a definition', () => {
    const result = parseHarnessDefinition({
      id: 'x1',
      command: 'x',
      env: { NEXUS_MCP_TOKEN: 'stolen' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.harness.env).not.toHaveProperty('NEXUS_MCP_TOKEN');
    expect(result.strippedEnvKeys).toContain('NEXUS_MCP_TOKEN');
  });

  test.each([
    ['lowercase', 'nexus_mcp_token'],
    ['mixed case', 'Nexus_Mcp_Token'],
    ['snake shout', 'NeXuS_mCp_ToKeN'],
  ])(
    'strips a reserved key spelled in %s — Windows env is case-insensitive',
    (_desc, key) => {
      // Arrange — on win32 `nexus_mcp_token` IS `NEXUS_MCP_TOKEN`; a
      // case-sensitive strip would hand the child a shadow identity var.
      const result = parseHarnessDefinition({
        id: 'sneaky-case',
        command: 'sneaky-bin',
        env: { [key]: 'stolen', SAFE_KEY: 'ok' },
      });

      // Assert
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.keys(result.harness.env)).toEqual(['SAFE_KEY']);
      // The stripped report keeps the key exactly as the definition spelled it.
      expect(result.strippedEnvKeys).toEqual([key]);
    },
  );

  test('non-reserved keys keep their original casing in the output', () => {
    const result = parseHarnessDefinition({
      id: 'casing',
      command: 'bin',
      env: { my_agent_mode: 'acp', Mixed_Case: 'v' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.harness.env).toEqual({ my_agent_mode: 'acp', Mixed_Case: 'v' });
    expect(result.strippedEnvKeys).toEqual([]);
  });
});

describe('parseHarnessDefinition — installInstructionsUrl is a validated link', () => {
  test.each([
    ['javascript', 'javascript:alert(1)'],
    ['file', 'file:///etc/passwd'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['plain http', 'http://example.com/docs'],
    ['not a URL at all', 'example.com/docs'],
  ])('rejects a %s installInstructionsUrl', (_desc, installInstructionsUrl) => {
    const result = parseHarnessDefinition({
      ...VALID_INPUT,
      installInstructionsUrl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('installInstructionsUrl');
  });

  test('rejects an oversized https installInstructionsUrl', () => {
    const result = parseHarnessDefinition({
      ...VALID_INPUT,
      installInstructionsUrl: `https://example.com/${'a'.repeat(2_048)}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('installInstructionsUrl');
  });

  test('accepts an https url and preserves it verbatim', () => {
    const result = parseHarnessDefinition({
      ...VALID_INPUT,
      installInstructionsUrl: 'https://example.com/docs?a=1#top',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.harness.installInstructionsUrl).toBe(
      'https://example.com/docs?a=1#top',
    );
  });
});

describe('parseHarnessDefinition — invalid inputs rejected with explicit errors', () => {
  test.each([
    ['UpperCase', 'My-Agent'],
    ['underscore', 'my_agent'],
    ['leading dash', '-agent'],
    ['spaces', 'my agent'],
    ['empty', ''],
    ['path traversal', '../evil'],
  ])('rejects id with %s (%j)', (_desc, id) => {
    const result = parseHarnessDefinition({ ...VALID_INPUT, id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('invalid id');
  });

  test('rejects non-string id', () => {
    const result = parseHarnessDefinition({ ...VALID_INPUT, id: 42 });

    expect(result.ok).toBe(false);
  });

  test('rejects empty command', () => {
    const result = parseHarnessDefinition({ ...VALID_INPUT, command: '   ' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('command');
  });

  test('rejects non-array args and non-string arg entries', () => {
    expect(parseHarnessDefinition({ ...VALID_INPUT, args: 'acp' }).ok).toBe(false);
    expect(parseHarnessDefinition({ ...VALID_INPUT, args: ['ok', 7] }).ok).toBe(
      false,
    );
  });

  test('rejects non-string env values and invalid env key names', () => {
    expect(
      parseHarnessDefinition({ ...VALID_INPUT, env: { KEY: 3 } }).ok,
    ).toBe(false);
    expect(
      parseHarnessDefinition({ ...VALID_INPUT, env: { 'BAD KEY': 'v' } }).ok,
    ).toBe(false);
  });

  test('rejects non-object input', () => {
    expect(parseHarnessDefinition('not an object').ok).toBe(false);
    expect(parseHarnessDefinition(null).ok).toBe(false);
    expect(parseHarnessDefinition([VALID_INPUT]).ok).toBe(false);
  });

  test('custom definitions cannot shadow reserved builtin/preset ids', () => {
    for (const reserved of RESERVED_HARNESS_IDS) {
      const result = parseHarnessDefinition({ ...VALID_INPUT, id: reserved });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors.join(' ')).toContain('reserved');
    }
  });
});

describe('parseHarnessDefinition — canAutoInstall is forced false', () => {
  test('input claiming canAutoInstall true is neutralized', () => {
    const result = parseHarnessDefinition({
      ...VALID_INPUT,
      canAutoInstall: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.harness.canAutoInstall).toBe(false);
  });

  test('preset tier also gets canAutoInstall false', () => {
    const result = parseHarnessDefinition(
      { id: 'some-preset', command: 'preset-bin' },
      'preset',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.harness.tier).toBe('preset');
    expect(result.harness.canAutoInstall).toBe(false);
  });
});

describe('preset catalog invariants', () => {
  test('every preset id is inside the reserved namespace', () => {
    for (const preset of PRESET_HARNESSES) {
      expect(RESERVED_HARNESS_IDS).toContain(preset.id);
    }
    for (const builtin of BUILTIN_HARNESS_IDS) {
      expect(RESERVED_HARNESS_IDS).toContain(builtin);
    }
  });

  test('presets are frozen, never auto-install, and carry install docs', () => {
    expect(PRESET_HARNESSES.length).toBeGreaterThan(0);
    for (const preset of PRESET_HARNESSES) {
      expect(Object.isFrozen(preset)).toBe(true);
      expect(preset.tier).toBe('preset');
      expect(preset.canAutoInstall).toBe(false);
      expect(preset.command.length).toBeGreaterThan(0);
      expect(preset.installInstructionsUrl).toBeTruthy();
    }
  });

  test('presets carry no env entries (buzz: definition env left empty)', () => {
    for (const preset of PRESET_HARNESSES) {
      expect(Object.keys(preset.env)).toHaveLength(0);
    }
  });
});
