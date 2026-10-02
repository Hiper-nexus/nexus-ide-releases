import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseRestartSmokeArguments, runPackagedRestartSmoke } from './smoke-packaged-restart.mjs';

describe('restart smoke command contract', () => {
  it('requires an explicit version and preserves the existing packaged target', () => {
    expect(parseRestartSmokeArguments(['--app', '/tmp/nexus-ide', '--verify-restart', '--expected-version', '0.76.166']))
      .toEqual({ app: path.resolve('/tmp/nexus-ide'), expectedVersion: '0.76.166' });
    expect(parseRestartSmokeArguments(['--expected-version', '0.76.166', '--verify-restart']))
      .toEqual({ app: null, expectedVersion: '0.76.166' });
  });
  it.each([
    [], ['--verify-restart'], ['--expected-version', '0.76.166'],
    ['--verify-restart', '--expected-version', 'garbage'],
    ['--verify-restart', '--expected-version', '0.76.166-preview'],
    ['--verify-restart', '--expected-version', '--app'],
    ['--verify-restart', '--expected-version', '0.76.166', '--verify-restart'],
    ['--verify-restart', '--expected-version', '0.76.166', '--expected-version', '0.76.166'],
  ])('rejects ambiguous or incomplete arguments %j', args => {
    expect(() => parseRestartSmokeArguments(args)).toThrow();
  });
});

describe('two-launch restart gate', () => {
  function successfulPhase(proof) {
    return { runtimeProof: proof, treeProof: { ok: true }, processTreeProof: { orphans: [] } };
  }

  it('reuses the same private profile/HOME and completes write before read', async () => {
    const calls = [];
    const probe = vi.fn(async (child, options) => {
      calls.push({ ...options, pid: child.pid });
      const file = path.join(options.userData, 'home', 'preference-fixture.json');
      if (options.phase === 'write') fs.writeFileSync(file, JSON.stringify({ pixelMode: true }));
      else expect(JSON.parse(fs.readFileSync(file, 'utf8')).pixelMode).toBe(true);
      return { phase: options.phase, pid: child.pid, appVersion: '0.76.166', packaged: true, pixelMode: true };
    });
    let nextPid = 1;
    const runSmoke = vi.fn(async (_target, options) => {
      expect(options.remoteDebugging).toBe(true);
      return successfulPhase(await options.runtimeProbe({ pid: nextPid++ }, { userData: options.smokeSession.userData }));
    });
    const result = await runPackagedRestartSmoke('/fixture/packaged-app', { expectedVersion: '0.76.166', runSmoke, probeImpl: probe });
    expect(calls.map(c => c.phase)).toEqual(['write', 'read']);
    expect(new Set(calls.map(c => c.userData)).size).toBe(1);
    expect(result.launches.map(p => p.pid)).toEqual([1, 2]);
    expect(result.preference).toBe('pixelMode');
    expect(fs.existsSync(calls[0].userData)).toBe(false);
  });

  it('fails and disposes the shared profile when the second IPC read rejects', async () => {
    let userData;
    let pid = 1;
    const probe = async (child, options) => {
      if (options.phase === 'read') throw new Error('persisted preference missing');
      return { phase: options.phase, pid: child.pid, appVersion: '0.76.166', packaged: true, pixelMode: true };
    };
    const runSmoke = async (_target, options) => {
      userData = options.smokeSession.userData;
      return successfulPhase(await options.runtimeProbe({ pid: pid++ }, { userData }));
    };
    await expect(runPackagedRestartSmoke('/fixture/packaged-app', { expectedVersion: '0.76.166', runSmoke, probeImpl: probe }))
      .rejects.toThrow('persisted preference missing');
    expect(fs.existsSync(userData)).toBe(false);
  });

  it('rejects a reused process identity and a missing physical shutdown proof', async () => {
    const proof = phase => ({ phase, pid: 1, appVersion: '0.76.166', packaged: true, pixelMode: true });
    let phaseIndex = 0;
    await expect(runPackagedRestartSmoke('/fixture/packaged-app', {
      expectedVersion: '0.76.166', probeImpl: vi.fn(),
      runSmoke: async () => successfulPhase(proof(['write', 'read'][phaseIndex++])),
    })).rejects.toThrow('distinct application processes');
    await expect(runPackagedRestartSmoke('/fixture/packaged-app', {
      expectedVersion: '0.76.166', probeImpl: vi.fn(),
      runSmoke: async () => ({ runtimeProof: proof('write'), treeProof: { ok: false }, processTreeProof: { orphans: [9] } }),
    })).rejects.toThrow('clean process exit');
  });
});
