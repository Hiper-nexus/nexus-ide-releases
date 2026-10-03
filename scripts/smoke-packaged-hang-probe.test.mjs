import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HANG_PROBE_ENV,
  HANG_PROBE_FUNCTION,
  HANG_PROBE_BLOCK_MS,
  assertHangProbeProof,
  parseHangProbeArguments,
  readHangRecords,
  runPackagedHangProbe,
  waitForHangProof,
} from './smoke-packaged-hang-probe.mjs';
import {
  SMOKE_HANG_PROBE_ENV,
  SMOKE_HANG_PROBE_FUNCTION,
  SMOKE_HANG_PROBE_BLOCK_MS,
} from '../src/main/hang-watchdog/smoke-hang-probe.ts';

const PROFILE_FILE = 'main-hang-2026-10-03T11-41-37-000Z.cpuprofile';

function proofFixture(overrides = {}) {
  const records = [
    { kind: 'main-thread-hang', lastHeartbeatAt: 100, hangDurationMs: 1_750, appVersion: '0.76.191' },
    {
      kind: 'main-thread-hang-profile',
      profileFile: PROFILE_FILE,
      sampleCount: 1_400,
      lastHeartbeatAt: 100,
      topFrames: [{ functionName: HANG_PROBE_FUNCTION, selfPercent: 99.7, url: 'file:///app.asar/main.js', line: 1, column: 77 }],
      ...overrides,
    },
    { kind: 'main-thread-hang-recovered', lastHeartbeatAt: 100, recoveredAt: 40_200, hangDurationMs: 40_100 },
  ];
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)' }, children: [2] },
      { id: 2, callFrame: { functionName: HANG_PROBE_FUNCTION } },
    ],
    samples: [2, 2, 2],
  };
  return { records, profile };
}

const tempDirs = [];
function tempUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hang-probe-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'logs'));
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('contrato do hang probe (F-764 A.1)', () => {
  it('o harness e o app falam a mesma env e o mesmo nome de função', () => {
    expect(HANG_PROBE_ENV).toBe(SMOKE_HANG_PROBE_ENV);
    expect(HANG_PROBE_FUNCTION).toBe(SMOKE_HANG_PROBE_FUNCTION);
    expect(HANG_PROBE_BLOCK_MS).toBe(SMOKE_HANG_PROBE_BLOCK_MS);
  });

  it('aceita só --verify-hang-probe com --app opcional', () => {
    expect(parseHangProbeArguments(['--verify-hang-probe'])).toEqual({ app: null });
    expect(parseHangProbeArguments(['--app', '/tmp/NexusIDE.app', '--verify-hang-probe'])).toEqual({
      app: path.resolve('/tmp/NexusIDE.app'),
    });
    for (const args of [[], ['--app', '/x'], ['--verify-hang-probe', '--app'], ['--verify-hang-probe', '--verify-hang-probe'], ['--verify-hang-probe', '--expected-version', '1.0.0']]) {
      expect(() => parseHangProbeArguments(args)).toThrow();
    }
  });

  it('lê o ndjson tolerando linha truncada', () => {
    expect(readHangRecords('{"kind":"a"}\n{"kind":\n\n{"kind":"b"}\n').map((r) => r.kind)).toEqual(['a', 'b']);
  });
});

describe('assertHangProbeProof', () => {
  it('passa com profile gravado e o laço do probe no topo', () => {
    expect(assertHangProbeProof(proofFixture())).toEqual({
      schema: 'nexus.hang-probe/v2',
      requiredDurationMs: 40_000,
      hangDurationMs: 40_100,
      profileFile: PROFILE_FILE,
      sampleCount: 1_400,
      top: { functionName: HANG_PROBE_FUNCTION, selfPercent: 99.7, url: 'file:///app.asar/main.js', line: 1, column: 77 },
    });
  });

  it('falha com o motivo quando o inspector não funcionou no binário de release', () => {
    expect(() => assertHangProbeProof(proofFixture({ profilerUnavailable: 'connectToMainThread: indisponível' }))).toThrow(
      /inspector indisponível no app empacotado: connectToMainThread: indisponível/,
    );
  });

  it('refuses short, missing or unrelated recovery instead of accepting an early profile', () => {
    const fixture = proofFixture();
    fixture.records[2].hangDurationMs = 6000;
    expect(() => assertHangProbeProof(fixture)).toThrow(/40/);
    const missing = proofFixture(); missing.records.pop();
    expect(() => assertHangProbeProof(missing)).toThrow(/recuperação/);
    const unrelated = proofFixture(); unrelated.records[2].lastHeartbeatAt = 200;
    expect(() => assertHangProbeProof(unrelated)).toThrow(/recuperação/);
  });

  it('falha quando o topo não é o laço, o arquivo não existe ou o profile é inválido', () => {
    expect(() =>
      assertHangProbeProof(proofFixture({ topFrames: [{ functionName: 'Xr' }] })),
    ).toThrow(/topo do profile é Xr/);
    expect(() => assertHangProbeProof(proofFixture({ profileFile: null }))).toThrow(/não foi gravado/);
    expect(() => assertHangProbeProof({ ...proofFixture(), profile: { nodes: [], samples: [] } })).toThrow(/não é um .cpuprofile/);
    expect(() => assertHangProbeProof({ records: [], profile: null })).toThrow(/não marcou/);
  });
});

describe('waitForHangProof', () => {
  it('espera o watchdog gravar e valida o arquivo de verdade', async () => {
    const userData = tempUserData();
    const { records, profile } = proofFixture();
    let polls = 0;
    const proof = await waitForHangProof(userData, {
      pollMs: 1,
      sleep: async () => {
        polls += 1;
        if (polls === 2) {
          fs.writeFileSync(path.join(userData, 'logs', PROFILE_FILE), JSON.stringify(profile));
          fs.writeFileSync(
            path.join(userData, 'logs', 'main-hang.ndjson'),
            records.map((r) => JSON.stringify(r)).join('\n') + '\n',
          );
        }
      },
    });
    expect(proof.top.functionName).toBe(HANG_PROBE_FUNCTION);
    expect(polls).toBe(2);
  });

  it('desiste no prazo com o diretório na mensagem', async () => {
    const userData = tempUserData();
    await expect(waitForHangProof(userData, { timeoutMs: 0, sleep: async () => {} })).rejects.toThrow(
      /nenhum profile em .*logs após 0 ms/,
    );
  });

  it('waits for recovery even if the profile was captured earlier during the hang', async () => {
    const userData = tempUserData(); const { records, profile } = proofFixture();
    fs.writeFileSync(path.join(userData, 'logs', PROFILE_FILE), JSON.stringify(profile));
    fs.writeFileSync(path.join(userData, 'logs', 'main-hang.ndjson'), records.slice(0, 2).map(r => JSON.stringify(r)).join('\n'));
    let polls = 0;
    const proof = await waitForHangProof(userData, { pollMs: 1, sleep: async () => {
      polls++; fs.appendFileSync(path.join(userData, 'logs', 'main-hang.ndjson'), '\n' + JSON.stringify(records[2]));
    } });
    expect(polls).toBe(1); expect(proof.hangDurationMs).toBeGreaterThanOrEqual(40_000);
  });
});

describe('runPackagedHangProbe', () => {
  it('liga o probe pela env do smoke e devolve a prova do runtimeProbe', async () => {
    const userData = tempUserData();
    const { records, profile } = proofFixture();
    fs.writeFileSync(path.join(userData, 'logs', PROFILE_FILE), JSON.stringify(profile));
    fs.writeFileSync(path.join(userData, 'logs', 'main-hang.ndjson'), records.map((r) => JSON.stringify(r)).join('\n'));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runSmoke = vi.fn(async (_target, options) => {
      expect(options.env[HANG_PROBE_ENV]).toBe('1');
      expect(options.env.PATH).toBe('/usr/bin');
      return { runtimeProof: await options.runtimeProbe({ pid: 1 }, { userData, signal: new AbortController().signal }) };
    });
    try {
      const proof = await runPackagedHangProbe('/fixture/NexusIDE.app', { runSmoke, env: { PATH: '/usr/bin' } });
      expect(proof.profileFile).toBe(PROFILE_FILE);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('[smoke] hangProbeProof'));
    } finally {
      write.mockRestore();
    }
  });

  it('smoke sem prova de profile reprova', async () => {
    await expect(
      runPackagedHangProbe('/fixture/NexusIDE.app', { runSmoke: async () => ({ runtimeProof: null }), env: {} }),
    ).rejects.toThrow(/did not return its proof/);
  });
});
