import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WINDOWS_USER_ENV_KEY,
  defaultWindowsRegExe,
  expandWindowsEnvValue,
  isBlockedWindowsUserEnvKey,
  mergeWindowsUserEnvironment,
  parseWindowsUserEnvQuery,
  readWindowsUserEnvironment,
  refreshWindowsUserEnvironment,
  resetWindowsUserEnvCacheForTests,
  type WindowsUserEnvDeps,
} from './windows-user-env';

afterEach(() => {
  resetWindowsUserEnvCacheForTests();
  vi.unstubAllEnvs();
});

/** Saída real de `reg query HKCU\Environment` (separadores de 4 espaços). */
const REG_OUTPUT = [
  'HKEY_CURRENT_USER\\Environment',
  '    Path    REG_EXPAND_SZ    C:\\Users\\op\\bin;%ProgramFiles%\\tools',
  '    MARGEM_MCP_READ_URL    REG_SZ    https://margem.example/mcp',
  '    MARGEM_MCP_READ_TOKEN    REG_SZ    tok-123',
  '    JAVA_HOME    REG_SZ    C:\\Java',
  '    COUNTER    REG_DWORD    0x2a',
  '    MULTI    REG_MULTI_SZ    a\\0b',
  '    DYLD_INSERT_LIBRARIES    REG_SZ    /tmp/evil.dylib',
  '    LD_PRELOAD    REG_SZ    /tmp/evil.so',
  '    NODE_OPTIONS    REG_SZ    --require /tmp/evil.js',
  '    ELECTRON_RUN_AS_NODE    REG_SZ    1',
  '    NEXUS_MCP_TOKEN    REG_SZ    stolen',
  '    USERPROFILE    REG_SZ    C:\\Users\\attacker',
  '    SystemRoot    REG_SZ    C:\\evil',
  '',
].join('\r\n');

function winDeps(
  stdout: string,
  patch: Partial<WindowsUserEnvDeps> = {},
): WindowsUserEnvDeps & { calls: Array<[string, readonly string[]]> } {
  const calls: Array<[string, readonly string[]]> = [];
  return {
    calls,
    platform: 'win32',
    regExe: 'C:\\Windows\\System32\\reg.exe',
    expandBase: { ProgramFiles: 'C:\\Program Files' },
    execFile: (file, args) => {
      calls.push([file, args]);
      return stdout;
    },
    ...patch,
  };
}

describe('parseWindowsUserEnvQuery', () => {
  it('keeps REG_SZ and REG_EXPAND_SZ rows and drops every other type', () => {
    const entries = parseWindowsUserEnvQuery(REG_OUTPUT);
    expect(entries.map((entry) => entry.name)).toEqual([
      'Path',
      'MARGEM_MCP_READ_URL',
      'MARGEM_MCP_READ_TOKEN',
      'JAVA_HOME',
      'DYLD_INSERT_LIBRARIES',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE',
      'NEXUS_MCP_TOKEN',
      'USERPROFILE',
      'SystemRoot',
    ]);
    expect(entries[0]).toEqual({
      name: 'Path',
      type: 'REG_EXPAND_SZ',
      value: 'C:\\Users\\op\\bin;%ProgramFiles%\\tools',
    });
    expect(entries[1]?.type).toBe('REG_SZ');
  });

  it('ignores the key header, junk lines and implausible names', () => {
    const entries = parseWindowsUserEnvQuery(
      [
        'HKEY_CURRENT_USER\\Environment',
        '    BAD=NAME    REG_SZ    x',
        '    OK    REG_SZ    y',
        'not a reg row at all',
      ].join('\n'),
    );
    expect(entries).toEqual([{ name: 'OK', type: 'REG_SZ', value: 'y' }]);
  });

  it('tolerates an empty value and trailing spaces', () => {
    const entries = parseWindowsUserEnvQuery('    EMPTY    REG_SZ    \n');
    expect(entries).toEqual([{ name: 'EMPTY', type: 'REG_SZ', value: '' }]);
  });
});

describe('expandWindowsEnvValue', () => {
  const lookup = (name: string): string | undefined =>
    ({
      PROGRAMFILES: 'C:\\Program Files',
      A: '%B%',
      B: '%A%',
      NESTED: 'x',
      SELF: '%SELF%',
    })[name.toUpperCase()];

  it('expands against the lookup', () => {
    expect(expandWindowsEnvValue('%PROGRAMFILES%\\tools', lookup)).toBe(
      'C:\\Program Files\\tools',
    );
  });

  it('leaves an unknown variable literal instead of blanking it', () => {
    expect(expandWindowsEnvValue('%UNKNOWN%\\x', lookup)).toBe('%UNKNOWN%\\x');
  });

  it('does not loop on a mutual reference', () => {
    expect(expandWindowsEnvValue('%A%', lookup)).toBe('%A%');
    expect(expandWindowsEnvValue('%SELF%', lookup)).toBe('%SELF%');
  });

  it('stops at the depth ceiling', () => {
    expect(expandWindowsEnvValue('%NESTED%', lookup)).toBe('x');
  });
});

describe('isBlockedWindowsUserEnvKey', () => {
  it.each([
    'DYLD_INSERT_LIBRARIES',
    'LD_PRELOAD',
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'NEXUS_MCP_TOKEN',
    'nexus_pane_id',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
  ])('blocks %s', (key) => {
    expect(isBlockedWindowsUserEnvKey(key)).toBe(true);
  });

  it.each(['MARGEM_MCP_READ_URL', 'MARGEM_MCP_READ_TOKEN', 'JAVA_HOME', 'Path'])(
    'admits %s',
    (key) => {
      expect(isBlockedWindowsUserEnvKey(key)).toBe(false);
    },
  );
});

describe('readWindowsUserEnvironment', () => {
  it('is a no-op off Windows and never touches the registry', () => {
    const execFile = vi.fn(() => REG_OUTPUT);
    expect(
      readWindowsUserEnvironment({ platform: 'darwin', execFile }),
    ).toEqual({});
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns the user variables a pane needs, expanded', () => {
    const env = readWindowsUserEnvironment(winDeps(REG_OUTPUT));
    expect(env.MARGEM_MCP_READ_URL).toBe('https://margem.example/mcp');
    expect(env.MARGEM_MCP_READ_TOKEN).toBe('tok-123');
    expect(env.JAVA_HOME).toBe('C:\\Java');
    expect(env.Path).toBe('C:\\Users\\op\\bin;C:\\Program Files\\tools');
  });

  it('drops dangerous and identity keys from the registry', () => {
    const env = readWindowsUserEnvironment(winDeps(REG_OUTPUT));
    for (const key of [
      'DYLD_INSERT_LIBRARIES',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE',
      'NEXUS_MCP_TOKEN',
      'USERPROFILE',
      'SystemRoot',
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('queries the absolute System32 reg.exe with a fixed argv', () => {
    const deps = winDeps(REG_OUTPUT);
    readWindowsUserEnvironment(deps);
    expect(deps.calls).toEqual([
      ['C:\\Windows\\System32\\reg.exe', ['query', WINDOWS_USER_ENV_KEY]],
    ]);
  });

  it('defaults reg.exe to %SystemRoot%\\System32', () => {
    vi.stubEnv('SystemRoot', 'D:\\Win');
    expect(defaultWindowsRegExe()).toBe('D:\\Win\\System32\\reg.exe');
  });

  it('degrades to empty when the registry read fails', () => {
    const env = readWindowsUserEnvironment(
      winDeps('', {
        execFile: () => {
          throw new Error('reg.exe denied');
        },
      }),
    );
    expect(env).toEqual({});
  });
});

describe('mergeWindowsUserEnvironment', () => {
  it('fills gaps without overwriting what the caller already had', () => {
    const target: Record<string, string | undefined> = {
      JAVA_HOME: 'C:\\from-process-env',
      PATH: 'C:\\Windows',
    };
    mergeWindowsUserEnvironment(target, winDeps(REG_OUTPUT));
    expect(target.JAVA_HOME).toBe('C:\\from-process-env');
    expect(target.MARGEM_MCP_READ_TOKEN).toBe('tok-123');
  });

  it('matches an existing key case-insensitively (Windows names are)', () => {
    const target: Record<string, string | undefined> = {
      margem_mcp_read_token: 'from-process-env',
    };
    mergeWindowsUserEnvironment(target, winDeps(REG_OUTPUT));
    expect(target.margem_mcp_read_token).toBe('from-process-env');
    expect(target.MARGEM_MCP_READ_TOKEN).toBeUndefined();
  });

  it('merges Path additively, without duplicating or reordering', () => {
    const target: Record<string, string | undefined> = {
      Path: 'C:\\Windows;C:\\Users\\op\\bin\\',
    };
    mergeWindowsUserEnvironment(target, winDeps(REG_OUTPUT));
    expect(target.Path).toBe(
      'C:\\Windows;C:\\Users\\op\\bin\\;C:\\Program Files\\tools',
    );
    // A grafia herdada é preservada: nenhuma chave `PATH` nova aparece.
    expect(target.PATH).toBeUndefined();
  });

  it('creates the path key when the target had none', () => {
    const target: Record<string, string | undefined> = {};
    mergeWindowsUserEnvironment(target, winDeps(REG_OUTPUT));
    expect(target.Path).toBe('C:\\Users\\op\\bin;C:\\Program Files\\tools');
  });

  it('never merges on a non-Windows host', () => {
    const target: Record<string, string | undefined> = { PATH: '/usr/bin' };
    mergeWindowsUserEnvironment(target, {
      platform: 'linux',
      execFile: () => REG_OUTPUT,
    });
    expect(target).toEqual({ PATH: '/usr/bin' });
  });
});

describe('cache', () => {
  it('reuses one read inside the TTL and re-reads after it', () => {
    let now = 1_000;
    let reads = 0;
    const deps: WindowsUserEnvDeps = {
      platform: 'win32',
      now: () => now,
      execFile: () => {
        reads += 1;
        return REG_OUTPUT;
      },
    };
    readWindowsUserEnvironment(deps);
    readWindowsUserEnvironment({ ...deps, now: () => now + 1_000 });
    expect(reads).toBe(1);
    now += 6_000;
    readWindowsUserEnvironment({ ...deps, now: () => now });
    expect(reads).toBe(2);
  });

  it('refreshWindowsUserEnvironment forces the next read', () => {
    let reads = 0;
    const deps: WindowsUserEnvDeps = {
      platform: 'win32',
      execFile: () => {
        reads += 1;
        return REG_OUTPUT;
      },
    };
    readWindowsUserEnvironment(deps);
    refreshWindowsUserEnvironment();
    readWindowsUserEnvironment(deps);
    expect(reads).toBe(2);
  });

  it('serves a newly created user variable on the next spawn', () => {
    let stdout = 'HKEY_CURRENT_USER\\Environment\n';
    const deps: WindowsUserEnvDeps = {
      platform: 'win32',
      execFile: () => stdout,
    };
    expect(readWindowsUserEnvironment(deps).MARGEM_MCP_READ_TOKEN).toBeUndefined();
    stdout += '    MARGEM_MCP_READ_TOKEN    REG_SZ    tok-live\n';
    refreshWindowsUserEnvironment();
    expect(readWindowsUserEnvironment(deps).MARGEM_MCP_READ_TOKEN).toBe('tok-live');
  });
});
