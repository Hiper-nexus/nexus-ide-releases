import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPathResolverForTests } from '../path-resolver';
import {
  codexHookTrustBypassArgs,
  codexNoDaemonArgs,
  parseCodexCliVersion,
  peekCodexCliVersion,
  resetCodexCliVersionCacheForTests,
  resolveCodexCliVersion,
  settleCodexCliVersionForSpawn,
  warmCodexCliVersion,
  type CodexSpawnVersionAdapter,
  type CodexVersionExec,
  type CodexVersionLaunch,
} from './codex-cli-version';

// Espiões de passagem: a sonda real roda, e o teste prova qual API ela usou.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    execFileSync: vi.fn(actual.execFileSync),
  };
});

beforeEach(() => {
  resetCodexCliVersionCacheForTests();
  __resetPathResolverForTests();
  vi.mocked(execFile).mockClear();
  vi.mocked(execFileSync).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe.skipIf(process.platform === 'win32')('F-790/F-764: o spawn do Codex espera a sonda de versão (teto curto)', () => {
  let dir: string;
  let bin: string;
  let probes: string;

  /** CLI falsa: conta cada `--version` e demora `delaySeconds` antes de responder. */
  const installFakeCodex = (version: string, delaySeconds = 0): void => {
    fs.writeFileSync(
      bin,
      `#!/bin/sh\necho probe >> '${probes}'\n` +
        (delaySeconds > 0 ? `sleep ${delaySeconds}\n` : '') +
        `echo codex-cli ${version}\n`,
      { mode: 0o755 },
    );
  };
  const probeCount = (): number =>
    fs.existsSync(probes) ? fs.readFileSync(probes, 'utf8').trim().split('\n').length : 0;
  const codexAdapter = (): CodexSpawnVersionAdapter => ({
    id: 'codex',
    bin,
    quirks: { nexusMcp: 'codex' },
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-codex-settle-'));
    bin = path.join(dir, 'codex');
    probes = path.join(dir, 'probes');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('(a) aquecimento ainda pendente: o spawn espera a sonda e o gate já devolve a flag', async () => {
    installFakeCodex('0.160.0', 0.3);
    // O aquecimento do boot está em voo, ainda sem versão no cache.
    const bootWarm = warmCodexCliVersion(bin);
    expect(peekCodexCliVersion(bin)).toBeNull();

    const settling = settleCodexCliVersionForSpawn(codexAdapter(), 2_000);
    expect(settling).not.toBeNull();
    await settling;

    // Concluiu dentro do teto: a decisão do spawn enxerga a versão.
    expect(codexHookTrustBypassArgs(bin)).toEqual(['--dangerously-bypass-hook-trust']);
    expect(peekCodexCliVersion(bin)).toBe('0.160.0');
    // A espera compartilhou a sonda do aquecimento: uma só execução da CLI.
    await bootWarm;
    expect(probeCount()).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it('(a) sem aquecimento nenhum: o spawn dispara a sonda assíncrona e espera por ela', async () => {
    installFakeCodex('0.160.0');
    const settling = settleCodexCliVersionForSpawn(codexAdapter(), 2_000);
    expect(settling).not.toBeNull();
    await settling;
    expect(codexHookTrustBypassArgs(bin)).toEqual(['--dangerously-bypass-hook-trust']);
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it('(b) estourou o teto: segue como hoje (versão desconhecida, sem a flag) e a sonda alimenta o cache depois', async () => {
    installFakeCodex('0.160.0', 1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const started = Date.now();
    await settleCodexCliVersionForSpawn(codexAdapter(), 60);
    // Não esperou a sonda inteira.
    expect(Date.now() - started).toBeLessThan(800);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('segue sem a flag'));
    // Comportamento de hoje com versão desconhecida: sem a flag, spawn livre.
    expect(codexHookTrustBypassArgs(bin)).toEqual([]);
    // A sonda segue em segundo plano e a próxima decisão já sabe.
    await warmCodexCliVersion(bin);
    expect(codexHookTrustBypassArgs(bin)).toEqual(['--dangerously-bypass-hook-trust']);
    expect(probeCount()).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it('(c) outras CLIs não esperam, nem com uma sonda do Codex em voo', async () => {
    installFakeCodex('0.160.0', 0.3);
    const bootWarm = warmCodexCliVersion(bin);
    const others: CodexSpawnVersionAdapter[] = [
      { id: 'claude', bin: 'claude', quirks: { nexusMcp: 'autoload' } },
      { id: 'grok', bin: 'grok', quirks: { nexusMcp: 'grok' } },
      { id: 'kimi', bin: 'kimi', quirks: {} },
      { id: 'sem-quirks', bin: 'x' },
    ];
    for (const adapter of others) {
      expect(settleCodexCliVersionForSpawn(adapter)).toBeNull();
    }
    // Nenhuma outra sonda além da do aquecimento do Codex.
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    await bootWarm;
  });

  it('(c) Codex com a versão já em cache e nenhuma sonda em voo não espera nada', async () => {
    installFakeCodex('0.160.0');
    await warmCodexCliVersion(bin);
    vi.mocked(execFile).mockClear();
    expect(settleCodexCliVersionForSpawn(codexAdapter())).toBeNull();
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });

  it('(d) nenhum execFileSync no caminho do spawn: peek, gate, telemetria e espera só leem cache ou sondam assíncrono', async () => {
    installFakeCodex('0.160.0', 0.1);
    // Cache frio: leitura de telemetria devolve null sem subprocesso nenhum.
    expect(peekCodexCliVersion(bin)).toBeNull();
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    // O gate com os padrões de produção também não executa a CLI de forma síncrona.
    expect(resolveCodexCliVersion(bin)).toBeNull();
    expect(codexHookTrustBypassArgs(bin)).toEqual([]);
    await settleCodexCliVersionForSpawn(codexAdapter(), 2_000);
    expect(codexHookTrustBypassArgs(bin)).toEqual(['--dangerously-bypass-hook-trust']);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
  });

  it('(d) a telemetria do spawn em tools-panes só lê o cache (peek), nunca o gate com sonda', () => {
    const source = fs.readFileSync(path.join(__dirname, 'tools-panes.ts'), 'utf8');
    expect(source).toContain('peekCodexCliVersion()');
    expect(source).not.toContain('resolveCodexCliVersion');
  });
});
