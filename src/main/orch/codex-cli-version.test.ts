import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetPathResolverForTests } from '../path-resolver';
import {
  codexHookTrustBypassArgs,
  codexNoDaemonArgs,
  parseCodexCliVersion,
  resetCodexCliVersionCacheForTests,
  resolveCodexCliVersion,
  warmCodexCliVersion,
  type CodexVersionExec,
  type CodexVersionLaunch,
} from './codex-cli-version';

beforeEach(() => {
  resetCodexCliVersionCacheForTests();
  __resetPathResolverForTests();
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
  it.skipIf(process.platform === 'win32')('F-790: the real version cache refreshes after an in-place CLI update', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-codex-version-'));
    const bin = path.join(dir, 'codex');
    try {
      fs.writeFileSync(bin, '#!/bin/sh\necho codex-cli 0.133.0\n', { mode: 0o755 });
      await expect(warmCodexCliVersion(bin)).resolves.toBe('0.133.0');
      expect(resolveCodexCliVersion(bin)).toBe('0.133.0');
      expect(codexHookTrustBypassArgs(bin)).toEqual([]);
      fs.writeFileSync(bin, '#!/bin/sh\necho codex-cli 0.160.0\n', { mode: 0o755 });
      const later = new Date(Date.now() + 10_000); fs.utimesSync(bin, later, later);
      await warmCodexCliVersion(bin);
      expect(resolveCodexCliVersion(bin)).toBe('0.160.0');
      expect(codexHookTrustBypassArgs(bin)).toEqual(['--dangerously-bypass-hook-trust']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === 'win32')('F-764: versão ainda não sondada é desconhecida — o gate não bloqueia e a próxima chamada já sabe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-codex-cold-'));
    const bin = path.join(dir, 'codex');
    try {
      fs.writeFileSync(bin, '#!/bin/sh\necho codex-cli 0.160.0\n', { mode: 0o755 });
      // Cache frio: comportamento de versão desconhecida (sem a flag), sem
      // esperar o subprocesso; a sonda sai em segundo plano.
      expect(resolveCodexCliVersion(bin)).toBeNull();
      expect(codexHookTrustBypassArgs(bin)).toEqual([]);
      await warmCodexCliVersion(bin);
      expect(codexHookTrustBypassArgs(bin)).toEqual(['--dangerously-bypass-hook-trust']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

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

describe('F-689: Codex no Windows sem o servidor compartilhado', () => {
  const help =
    (withFlag: boolean): CodexVersionExec =>
    (_bin, args) => {
      if (args[args.length - 1] !== '--help') throw new Error('unexpected probe');
      return withFlag
        ? 'Options:\n      --no-daemon\n          Run without the shared background server\n'
        : 'Options:\n      --model <MODEL>\n';
    };

  it('pede --no-daemon no Windows quando o Codex instalado anuncia a flag', () => {
    expect(
      codexNoDaemonArgs('codex', { platform: 'win32', execImpl: help(true), launchImpl: () => null }),
    ).toEqual(['--no-daemon']);
  });

  it('não inventa a flag em Codex antigo nem fora do Windows', () => {
    expect(
      codexNoDaemonArgs('codex-old', { platform: 'win32', execImpl: help(false), launchImpl: () => null }),
    ).toEqual([]);
    expect(
      codexNoDaemonArgs('codex-mac', { platform: 'darwin', execImpl: help(true), launchImpl: () => null }),
    ).toEqual([]);
    expect(
      codexNoDaemonArgs('codex-none', { platform: 'win32', execImpl: execThrowing, launchImpl: () => null }),
    ).toEqual([]);
  });

  it('lê o --help pelo lançador verificado quando o nome nu falha (.cmd do npm)', () => {
    const entry = 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
    const exec: CodexVersionExec = (bin, args) => {
      if (bin === 'codex') throw new Error('spawn codex ENOENT');
      expect(args).toEqual([entry, '--help']);
      return '      --no-daemon\n';
    };
    expect(
      codexNoDaemonArgs('codex', {
        platform: 'win32',
        execImpl: exec,
        launchImpl: () => ({ file: 'C:\\npm\\node.exe', argsPrefix: [entry] }),
      }),
    ).toEqual(['--no-daemon']);
  });

  it('não confunde outra flag que só começa igual', () => {
    const exec: CodexVersionExec = () => '      --no-daemon-restart\n';
    expect(
      codexNoDaemonArgs('codex-prefix', { platform: 'win32', execImpl: exec, launchImpl: () => null }),
    ).toEqual([]);
  });
});

