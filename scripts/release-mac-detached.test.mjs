import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertNoReleaseRunning,
  assertReleaseNode,
  buildLaunchdPlist,
  parseReleaseMacArgs,
  releaseSteps,
  runDetachedRelease,
  runReleaseSteps,
  stepEnvironment,
} from './release-mac-detached.mjs';

describe('parseReleaseMacArgs', () => {
  it('padrão: build, gate e publicação', () => {
    expect(parseReleaseMacArgs([])).toEqual({ from: 'build', publish: true });
  });

  it('--from candidate pula o build; --no-publish para no gate', () => {
    expect(parseReleaseMacArgs(['--from', 'candidate', '--no-publish'])).toEqual({
      from: 'candidate',
      publish: false,
    });
  });

  it('recusa etapa desconhecida e flag solta', () => {
    expect(() => parseReleaseMacArgs(['--from', 'publish'])).toThrow(/--from/);
    expect(() => parseReleaseMacArgs(['--yolo'])).toThrow(/--yolo/);
  });
});

describe('releaseSteps', () => {
  it('ordem fixa, respeitando --from e --no-publish', () => {
    expect(releaseSteps({ from: 'build', publish: true })).toEqual(['build', 'candidate', 'publish']);
    expect(releaseSteps({ from: 'candidate', publish: true })).toEqual(['candidate', 'publish']);
    expect(releaseSteps({ from: 'candidate', publish: false })).toEqual(['candidate']);
  });
});

describe('runReleaseSteps', () => {
  it('publica só depois do gate verde e sempre restaura o ABI do Node', () => {
    const ran = [];
    const out = runReleaseSteps(['candidate', 'publish'], (step) => {
      ran.push(step);
      return 0;
    });
    expect(ran).toEqual(['candidate', 'publish', 'rebuild']);
    expect(out.exitCode).toBe(0);
  });

  it('gate vermelho: não publica, restaura o ABI e devolve o código da etapa que falhou', () => {
    const ran = [];
    const out = runReleaseSteps(['candidate', 'publish'], (step) => {
      ran.push(step);
      return step === 'candidate' ? 7 : 0;
    });
    expect(ran).toEqual(['candidate', 'rebuild']);
    expect(out.exitCode).toBe(7);
    expect(out.results).toEqual([
      { step: 'candidate', exitCode: 7 },
      { step: 'rebuild', exitCode: 0 },
    ]);
  });

  it('rebuild vermelho com etapas verdes também falha o comando', () => {
    const out = runReleaseSteps(['candidate'], (step) => (step === 'rebuild' ? 3 : 0));
    expect(out.exitCode).toBe(3);
  });
});

describe('assertReleaseNode', () => {
  it('aceita só a versão fixada e explica como resolver', () => {
    expect(() => assertReleaseNode({ actual: 'v22.23.2', expected: '22.23.2' })).not.toThrow();
    expect(() => assertReleaseNode({ actual: 'v22.22.3', expected: '22.23.2' })).toThrow(
      /22\.23\.2.*v22\.22\.3.*NEXUS_RELEASE_NODE/s,
    );
  });
});

describe('assertNoReleaseRunning', () => {
  it('recusa job de release carregado ou processo de release vivo', () => {
    expect(() => assertNoReleaseRunning({ launchdList: '-\t0\tcom.apple.x\n', processes: '' })).not.toThrow();
    expect(() =>
      assertNoReleaseRunning({ launchdList: '123\t0\tcom.nexuside.release.0.76.99.abcd\n', processes: '' }),
    ).toThrow(/com\.nexuside\.release\.0\.76\.99\.abcd/);
    expect(() =>
      assertNoReleaseRunning({ launchdList: '', processes: '4242 node scripts/release-candidate-gate.mjs\n' }),
    ).toThrow(/release-candidate-gate/);
  });
});

describe('stepEnvironment', () => {
  const base = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/op',
    APPLE_ID: 'x@y',
    APPLE_APP_SPECIFIC_PASSWORD: 'secret',
    APPLE_TEAM_ID: '35P5XL3JN6',
  };

  it('nunca repassa credenciais Apple e põe o Node da release na frente', () => {
    const env = stepEnvironment('candidate', base, { nodeDir: '/opt/node22/bin', repoRoot: '/repo' });
    expect(env.APPLE_ID).toBeUndefined();
    expect(env.APPLE_APP_SPECIFIC_PASSWORD).toBeUndefined();
    expect(env.NEXUS_MAC_PUBLISH_RELEASE).toBe('1');
    expect(env.APPLE_TEAM_ID).toBe('35P5XL3JN6');
    expect(env.APPLE_KEYCHAIN_PROFILE).toBe('nexus-notary');
    expect(env.PATH.startsWith('/opt/node22/bin:')).toBe(true);
  });

  it('build usa o wrapper de codesign; rebuild roda sem as variáveis de publicação', () => {
    const build = stepEnvironment('build', base, { nodeDir: '/n', repoRoot: '/repo' });
    expect(build.PATH.startsWith('/repo/scripts/codesign-retry-bin:/n:')).toBe(true);
    const rebuild = stepEnvironment('rebuild', base, { nodeDir: '/n', repoRoot: '/repo' });
    expect(rebuild.APPLE_TEAM_ID).toBeUndefined();
    expect(rebuild.NEXUS_MAC_PUBLISH_RELEASE).toBeUndefined();
    expect(rebuild.APPLE_KEYCHAIN_PROFILE).toBeUndefined();
  });
});

describe('buildLaunchdPlist', () => {
  it('job de uma execução: sem KeepAlive, HOME real e sem credenciais Apple', () => {
    const plist = buildLaunchdPlist({
      label: 'com.nexuside.release.0.76.99.abcd',
      programArguments: ['/bin/zsh', '-lc', 'exec "/n/node" "/repo/scripts/x.mjs" --runner'],
      workingDirectory: '/repo',
      logPath: '/tmp/r/release.log',
      environment: { HOME: '/Users/op', NEXUS_RELEASE_NODE: '/n/node' },
    });
    expect(plist).toContain('<key>KeepAlive</key>\n  <false/>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<string>com.nexuside.release.0.76.99.abcd</string>');
    expect(plist).toContain('<key>HOME</key>\n    <string>/Users/op</string>');
    expect(plist).toContain('exec &quot;/n/node&quot;');
    expect(plist).not.toContain('APPLE_ID');
  });
});

describe('runDetachedRelease', () => {
  const tempDirs = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function fakeDeps({ jobExitCode = 0, listOutput = '' } = {}) {
    const calls = [];
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-mac-test-'));
    tempDirs.push(workDir);
    const deps = {
      platform: 'darwin',
      uid: 501,
      realHome: '/Users/op',
      repoRoot: '/repo',
      version: '0.76.99',
      nodePath: '/n/node',
      nodeVersion: 'v22.23.2',
      expectedNodeVersion: '22.23.2',
      makeWorkDir: () => workDir,
      nonce: () => 'abcd',
      launchdList: () => listOutput,
      releaseProcesses: () => '',
      launchctl: (args) => {
        calls.push(args);
        if (args[0] === 'bootstrap') {
          // O job "roda": escreve log e estado como o runner faria.
          fs.writeFileSync(path.join(workDir, 'release.log'), 'passo 1\n');
          fs.writeFileSync(
            path.join(workDir, 'state.json'),
            JSON.stringify({ exitCode: jobExitCode, results: [] }),
          );
        }
        return { status: 0, stderr: '' };
      },
      write: () => {},
      sleep: async () => {},
    };
    return { deps, calls, workDir };
  }

  it('sobe o job, espera o estado, sempre faz bootout e devolve o código do job', async () => {
    const { deps, calls } = fakeDeps({ jobExitCode: 0 });
    const code = await runDetachedRelease({ from: 'candidate', publish: false }, deps);
    expect(code).toBe(0);
    expect(calls[0].slice(0, 2)).toEqual(['bootstrap', 'gui/501']);
    expect(calls.at(-1)).toEqual(['bootout', 'gui/501/com.nexuside.release.0.76.99.abcd']);
  });

  it('job vermelho: bootout mesmo assim e o código volta', async () => {
    const { deps, calls } = fakeDeps({ jobExitCode: 7 });
    expect(await runDetachedRelease({ from: 'candidate', publish: true }, deps)).toBe(7);
    expect(calls.at(-1)[0]).toBe('bootout');
  });

  it('recusa fora do macOS, com Node errado ou com outra release rodando, sem subir job', async () => {
    for (const override of [
      { platform: 'linux' },
      { nodeVersion: 'v22.22.3' },
      { launchdList: () => '1\t0\tcom.nexuside.release.0.76.98.ffff\n' },
    ]) {
      const { deps, calls } = fakeDeps();
      await expect(runDetachedRelease({ from: 'build', publish: true }, { ...deps, ...override })).rejects.toThrow();
      expect(calls).toEqual([]);
    }
  });
});
