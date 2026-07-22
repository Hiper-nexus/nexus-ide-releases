import { beforeEach, describe, expect, it } from 'vitest';
import {
  codexHookTrustBypassArgs,
  parseCodexCliVersion,
  resetCodexCliVersionCacheForTests,
  resolveCodexCliVersion,
  type CodexVersionExec,
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
