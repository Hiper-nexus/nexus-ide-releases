import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalJsonString,
  codexHookEventName,
  codexHookIdentityHash,
  codexHookTrustEntries,
  mergeCodexHookTrustState,
  stripCodexHookTrustState,
} from './codex-hook-trust';
import type { HooksConfig } from './installer-utils';

let dir: string;

afterEach(() => {
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeHooksJson(config: HooksConfig): string {
  dir = mkdtempSync(join(tmpdir(), 'nexus-codex-trust-'));
  const codexDir = join(dir, '.codex');
  mkdirSync(codexDir, { recursive: true });
  const hooksJsonPath = join(codexDir, 'hooks.json');
  writeFileSync(hooksJsonPath, JSON.stringify(config), 'utf-8');
  return hooksJsonPath;
}

describe('canonicalJsonString', () => {
  it('sorts object keys recursively, compact, keeps array order', () => {
    expect(
      canonicalJsonString({ b: 1, a: { d: [2, 1], c: 'x' } }),
    ).toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
  });
});

describe('codexHookEventName', () => {
  it('maps PascalCase events to snake_case', () => {
    expect(codexHookEventName('SessionStart')).toBe('session_start');
    expect(codexHookEventName('UserPromptSubmit')).toBe('user_prompt_submit');
    expect(codexHookEventName('PreToolUse')).toBe('pre_tool_use');
    expect(codexHookEventName('PermissionRequest')).toBe('permission_request');
    expect(codexHookEventName('PostToolUse')).toBe('post_tool_use');
    expect(codexHookEventName('Stop')).toBe('stop');
  });
});

// Ground-truth vectors captured live from codex 0.145.0 app-server hooks/list
// (current_hash values). They pin the reproduction of codex-rs
// command_hook_hash + version_for_toml.
describe('codexHookTrustEntries — ground-truth hashes (codex 0.145.0)', () => {
  it('PreToolUse matcher "*" command with timeout', () => {
    const config: HooksConfig = {
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo nexus-pre', timeout: 10 }],
          },
        ],
      },
    };
    const hooksJsonPath = makeHooksJson(config);
    const entries = codexHookTrustEntries(hooksJsonPath, config, 'echo nexus-pre');
    expect(entries).toEqual([
      {
        key: `${realpathSync(hooksJsonPath)}:pre_tool_use:0:0`,
        trustedHash:
          'sha256:a7f9cde256ed94c3ab3cfc82a0f3aab5414f5a83260a0ceb6151a0d6cdd4b9a1',
      },
    ]);
  });

  it('SessionStart with a user group before the managed one (indices)', () => {
    const config: HooksConfig = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'echo user-first', timeout: 5 }] },
          { hooks: [{ type: 'command', command: 'echo nexus-managed', timeout: 10 }] },
        ],
      },
    };
    const hooksJsonPath = makeHooksJson(config);
    const entries = codexHookTrustEntries(
      hooksJsonPath,
      config,
      'echo nexus-managed',
    );
    expect(entries).toEqual([
      {
        key: `${realpathSync(hooksJsonPath)}:session_start:1:0`,
        trustedHash:
          'sha256:30a50cb69786aed4500a249081e2edc9375258f8e9f0004faacbff29f67fce51',
      },
    ]);
    // The user hook hashes to its own ground-truth value too.
    const userEntries = codexHookTrustEntries(
      hooksJsonPath,
      config,
      'echo user-first',
    );
    expect(userEntries).toEqual([
      {
        key: `${realpathSync(hooksJsonPath)}:session_start:0:0`,
        trustedHash:
          'sha256:ed2846acf94b038bcc26bd40aac2054d6ba6195a1bf1b214a922c205dcfce4a2',
      },
    ]);
  });

  it('Stop omits the matcher from the identity', () => {
    const config: HooksConfig = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'echo nexus-stop', timeout: 10 }] },
        ],
      },
    };
    const hooksJsonPath = makeHooksJson(config);
    const entries = codexHookTrustEntries(hooksJsonPath, config, 'echo nexus-stop');
    expect(entries).toEqual([
      {
        key: `${realpathSync(hooksJsonPath)}:stop:0:0`,
        trustedHash:
          'sha256:adaffed609fba1f2146cb13d21a9a45f037dc1539ce133252867ba7608437e4f',
      },
    ]);
  });

  it('matcher on Stop/UserPromptSubmit is ignored (normalized to None)', () => {
    const matcherlessHash = codexHookIdentityHash({
      event_name: 'stop',
      hooks: [{ type: 'command', command: 'echo nexus-stop', timeout: 10, async: false }],
    });
    const config: HooksConfig = {
      hooks: {
        Stop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo nexus-stop', timeout: 10 }],
          },
        ],
      },
    };
    const hooksJsonPath = makeHooksJson(config);
    const [entry] = codexHookTrustEntries(hooksJsonPath, config, 'echo nexus-stop');
    expect(entry!.trustedHash).toBe(matcherlessHash);
    expect(entry!.trustedHash).toBe(
      'sha256:adaffed609fba1f2146cb13d21a9a45f037dc1539ce133252867ba7608437e4f',
    );
  });
});

describe('codexHookTrustEntries — normalization rules', () => {
  it('defaults timeout to 600 when absent', () => {
    const config: HooksConfig = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'echo no-timeout' }] },
        ],
      },
    };
    const hooksJsonPath = makeHooksJson(config);
    const [entry] = codexHookTrustEntries(hooksJsonPath, config, 'echo no-timeout');
    expect(entry!.trustedHash).toBe(
      codexHookIdentityHash({
        event_name: 'session_start',
        hooks: [
          { type: 'command', command: 'echo no-timeout', timeout: 600, async: false },
        ],
      }),
    );
  });

  it('finds the managed handler at a non-zero handlerIndex', () => {
    const config: HooksConfig = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'echo other', timeout: 3 },
              { type: 'command', command: 'echo managed', timeout: 10 },
            ],
          },
        ],
      },
    };
    const hooksJsonPath = makeHooksJson(config);
    const [entry] = codexHookTrustEntries(hooksJsonPath, config, 'echo managed');
    expect(entry!.key).toBe(`${realpathSync(hooksJsonPath)}:stop:0:1`);
  });

  it('returns nothing when the managed command is absent', () => {
    const config: HooksConfig = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo other' }] }] },
    };
    const hooksJsonPath = makeHooksJson(config);
    expect(codexHookTrustEntries(hooksJsonPath, config, 'echo managed')).toEqual([]);
  });
});

describe('mergeCodexHookTrustState', () => {
  const key = '/private/tmp/x/.codex/hooks.json:session_start:1:0';
  const entry = { key, trustedHash: 'sha256:aaa' };

  it('creates sections in an empty config', () => {
    const out = mergeCodexHookTrustState('', [entry]);
    expect(out).toBe(
      `[hooks.state."${key}"]\ntrusted_hash = "sha256:aaa"\n`,
    );
  });

  it('preserves comments and other sections (textual merge)', () => {
    const input = '# my codex config\nmodel = "gpt-5"\n\n[some.other]\nkey = 1\n';
    const out = mergeCodexHookTrustState(input, [entry]);
    expect(out).toBe(
      '# my codex config\nmodel = "gpt-5"\n\n[some.other]\nkey = 1\n\n' +
        `[hooks.state."${key}"]\ntrusted_hash = "sha256:aaa"\n`,
    );
  });

  it('is idempotent', () => {
    const once = mergeCodexHookTrustState('', [entry]);
    expect(mergeCodexHookTrustState(once, [entry])).toBe(once);
  });

  it('replaces an existing trusted_hash inside our section only', () => {
    const input =
      `[hooks.state."${key}"]\ntrusted_hash = "sha256:old"\nenabled = true\n\n` +
      '[hooks.state."other"]\ntrusted_hash = "sha256:keep"\n';
    const out = mergeCodexHookTrustState(input, [entry]);
    expect(out).toContain('trusted_hash = "sha256:aaa"');
    expect(out).not.toContain('sha256:old');
    expect(out).toContain('enabled = true');
    expect(out).toContain('trusted_hash = "sha256:keep"');
  });

  it('escapes quotes and backslashes in the key', () => {
    const weird = { key: 'C:\\weird"path:x', trustedHash: 'sha256:bbb' };
    const out = mergeCodexHookTrustState('', [weird]);
    expect(out).toBe(
      '[hooks.state."C:\\\\weird\\"path:x"]\ntrusted_hash = "sha256:bbb"\n',
    );
    // Round-trips: the escaped form is found again on merge/strip.
    expect(mergeCodexHookTrustState(out, [weird])).toBe(out);
    expect(stripCodexHookTrustState(out, [weird.key])).toBe('');
  });
});

describe('stripCodexHookTrustState', () => {
  const keyA = '/private/tmp/x/.codex/hooks.json:session_start:1:0';
  const keyB = '/private/tmp/x/.codex/hooks.json:stop:0:0';

  it('removes only the requested sections', () => {
    const input =
      '# header\n\n' +
      `[hooks.state."${keyA}"]\ntrusted_hash = "sha256:aaa"\n\n` +
      `[hooks.state."${keyB}"]\ntrusted_hash = "sha256:bbb"\n\n` +
      '[other]\nx = 1\n';
    const out = stripCodexHookTrustState(input, [keyA]);
    expect(out).toBe(
      '# header\n\n' +
        `[hooks.state."${keyB}"]\ntrusted_hash = "sha256:bbb"\n\n` +
        '[other]\nx = 1\n',
    );
  });

  it('removes trailing sections without leaving blank tails', () => {
    const input =
      '[other]\nx = 1\n\n' +
      `[hooks.state."${keyA}"]\ntrusted_hash = "sha256:aaa"\n`;
    expect(stripCodexHookTrustState(input, [keyA])).toBe('[other]\nx = 1\n');
  });

  it('is tolerant to missing keys and returns the input untouched', () => {
    const input = '[other]\nx = 1\n';
    expect(stripCodexHookTrustState(input, [keyA])).toBe(input);
    expect(stripCodexHookTrustState('', [keyA])).toBe('');
  });
});
