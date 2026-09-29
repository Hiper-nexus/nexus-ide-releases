import { beforeEach, describe, expect, it } from 'vitest';
import {
  codexHookTrustBypassArgs,
  parseCodexCliVersion,
  resetCodexCliVersionCacheForTests,
  resolveCodexCliVersion,
  type CodexVersionExec,
  type CodexVersionLaunch,
} from './codex-cli-version';

beforeEach(() => {
  resetCodexCliVersionCacheForTests();
});

const execReturning =
  (output: string): CodexVersionExec =>
  () =>
    output;

const execThrowing: CodexVersionExec = () => {
  throw new Error('spawn codex ENOENT');
};

describe('parseCodexCliVersion', () => {
  it('parses the semver triple out of --version output', () => {
    expect(parseCodexCliVersion('codex-cli 0.145.0\n')).toBe('0.145.0');
    expect(parseCodexCliVersion('0.134.0')).toBe('0.134.0');
    expect(parseCodexCliVersion('codex-cli 1.2.3-alpha.1')).toBe('1.2.3');
    expect(parseCodexCliVersion('no version here')).toBeNull();
  });
});

describe('resolveCodexCliVersion', () => {
  it('memoises the result per bin', () => {
    let calls = 0;
    const exec: CodexVersionExec = () => {
      calls += 1;
      return 'codex-cli 0.145.0\n';
    };
    expect(resolveCodexCliVersion('codex', exec)).toBe('0.145.0');
    expect(resolveCodexCliVersion('codex', exec)).toBe('0.145.0');
    expect(calls).toBe(1);
  });

  it('returns null when the version cannot be determined', () => {
    expect(resolveCodexCliVersion('codex', execThrowing)).toBeNull();
    expect(resolveCodexCliVersion('codex', execReturning('garbage'))).toBeNull();
  });
});

describe('codexHookTrustBypassArgs', () => {
  it('adds the flag for codex >= 0.134.0', () => {
    expect(
      codexHookTrustBypassArgs('codex', execReturning('codex-cli 0.134.0\n')),
    ).toEqual(['--dangerously-bypass-hook-trust']);
    expect(
      codexHookTrustBypassArgs('codex', execReturning('codex-cli 0.145.0\n')),
    ).toEqual(['--dangerously-bypass-hook-trust']);
    expect(
      codexHookTrustBypassArgs('codex', execReturning('codex-cli 1.0.0\n')),
    ).toEqual(['--dangerously-bypass-hook-trust']);
  });

  it('omits the flag for older codex (unknown flag would break the spawn)', () => {
    expect(
      codexHookTrustBypassArgs('codex', execReturning('codex-cli 0.133.9\n')),
    ).toEqual([]);
    expect(
      codexHookTrustBypassArgs('codex', execReturning('codex-cli 0.128.0\n')),
    ).toEqual([]);
  });

  it('omits the flag when the version is undeterminable (fail-safe)', () => {
    expect(codexHookTrustBypassArgs('codex', execThrowing)).toEqual([]);
  });
});

describe('F-687: Windows npm launcher', () => {
  const npmLaunch: CodexVersionLaunch = () => ({
    file: 'C:\Users\op\.local\bin\node.exe',
    argsPrefix: ['C:\Users\op\.local\bin\node_modules\@openai\codex\bin\codex.js'],
  });

  it('reads the version through the verified launcher when the bare bin fails', () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const exec: CodexVersionExec = (bin, args) => {
      calls.push({ bin, args });
      if (bin === 'codex') throw new Error('spawn codex ENOENT');
      return 'codex-cli 0.159.0\n';
    };
    expect(resolveCodexCliVersion('codex', exec, npmLaunch)).toBe('0.159.0');
    expect(calls[1]).toEqual({
      bin: 'C:\Users\op\.local\bin\node.exe',
      args: ['C:\Users\op\.local\bin\node_modules\@openai\codex\bin\codex.js', '--version'],
    });
  });

  it('the Codex pane gets the hook-trust bypass on Windows (no "Hooks need review")', () => {
    const exec: CodexVersionExec = (bin) => {
      if (bin === 'codex') throw new Error('spawn codex ENOENT');
      return 'codex-cli 0.159.0\n';
    };
    expect(codexHookTrustBypassArgs('codex', exec, npmLaunch)).toEqual([
      '--dangerously-bypass-hook-trust',
    ]);
  });

  it('keeps the fail-safe when neither the bin nor the launcher resolve', () => {
    expect(codexHookTrustBypassArgs('codex', execThrowing, () => null)).toEqual([]);
    resetCodexCliVersionCacheForTests();
    expect(codexHookTrustBypassArgs('codex', execThrowing, npmLaunch)).toEqual([]);
  });

  it('does not touch the launcher when the bare bin already answers', () => {
    let launched = 0;
    const launch: CodexVersionLaunch = () => {
      launched += 1;
      return null;
    };
    expect(resolveCodexCliVersion('codex', execReturning('codex-cli 0.145.0\n'), launch)).toBe(
      '0.145.0',
    );
    expect(launched).toBe(0);
  });
});
