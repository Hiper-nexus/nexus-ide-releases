import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertBusyBannerProof, parseBusyBannerArguments, runPackagedBusyBannerProbe, waitForBusyBannerProof,
} from './smoke-packaged-busy-banner.mjs';

const nonce = '11111111-1111-4111-8111-111111111111';
const profileFile = 'main-hang-fixture.cpuprofile';
function fixture() {
  return {
    pid: 4321, expectedVersion: '0.76.191',
    receipt: {
      schema: 'nexus.busy-banner-smoke/v1', pid: 4321, appVersion: '0.76.191', packaged: true,
      main: { nonce, startedAt: 1000, recoveredAt: 41_000 },
      renderer: { nonce, armedAt: 900, shownAt: 12_000, visibleAt: 12_016, clearedAt: 41_100,
        title: 'Nexus ocupado — capturando diagnóstico',
        rect: { x: 30, y: 8, width: 480, height: 28, viewportWidth: 1000, viewportHeight: 700 } },
    },
    records: [
      { kind: 'main-thread-hang', appVersion: '0.76.191', lastHeartbeatAt: 900, detectedAt: 2600 },
      { kind: 'main-thread-hang-profile', appVersion: '0.76.191', lastHeartbeatAt: 900, capturedAt: 4200,
        profileFile, sampleCount: 3,
        topFrames: [{ functionName: 'nexusSmokeInducedMainHang', selfPercent: 100, url: 'file:///app.asar/main.js', line: 1, column: 78 }] },
      { kind: 'main-thread-hang-recovered', appVersion: '0.76.191', lastHeartbeatAt: 900, recoveredAt: 41_050, hangDurationMs: 40_150 },
    ],
    profile: { nodes: [{ id: 1, callFrame: { functionName: 'nexusSmokeInducedMainHang', url: 'file:///app.asar/main.js', lineNumber: 0, columnNumber: 77 } }], samples: [1, 1, 1] },
  };
}
const cleanup = [];
afterEach(async () => { while (cleanup.length) await fs.rm(cleanup.pop(), { recursive: true, force: true }); });
async function diskFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-busy-banner-test-'));
  cleanup.push(root);
  const userData = path.join(root, 'profile');
  const logs = path.join(userData, 'logs');
  await fs.mkdir(logs, { recursive: true });
  const f = fixture();
  await fs.writeFile(path.join(logs, 'busy-banner-smoke.json'), JSON.stringify(f.receipt));
  await fs.writeFile(path.join(logs, 'main-hang.ndjson'), f.records.map(r => JSON.stringify(r)).join('\n'));
  await fs.writeFile(path.join(logs, profileFile), JSON.stringify(f.profile));
  return { ...f, root, userData, evidenceDir: path.join(root, 'evidence') };
}

describe('packaged busy banner acceptance', () => {
  it('requires explicit mode, expected version and a new artifact destination', () => {
    expect(parseBusyBannerArguments(['--verify-busy-banner-probe', '--expected-version', '0.76.191', '--evidence-dir', '/tmp/evidence'])).toEqual({ app: null, expectedVersion: '0.76.191', evidenceDir: '/tmp/evidence' });
    for (const args of [[], ['--verify-busy-banner-probe'], ['--verify-busy-banner-probe', '--expected-version', 'bad', '--evidence-dir', '/tmp/evidence']]) expect(() => parseBusyBannerArguments(args)).toThrow();
  });

  it('joins the visible renderer frames to the actual Main and watchdog episode', () => {
    expect(assertBusyBannerProof(fixture())).toMatchObject({ schema: 'nexus.busy-banner-acceptance/v1', appVersion: '0.76.191', requiredDurationMs: 40_000, mainDurationMs: 40_000, banner: { onsetMs: 11_000, clearedAfterRecoveryMs: 100 }, watchdog: { profileFile, top: { functionName: 'nexusSmokeInducedMainHang', line: 1, column: 78 } } });
  });

  it.each([
    f => { f.receipt.main.recoveredAt = 6000; },
    f => { f.receipt.renderer.visibleAt = 41_001; },
    f => { f.receipt.renderer.clearedAt = 40_999; },
    f => { f.receipt.renderer.rect.width = 0; },
    f => { f.receipt.pid = 9999; },
    f => { f.records[1].capturedAt = 500; },
    f => { f.records[2].lastHeartbeatAt = 800; },
    f => { f.profile.nodes.push({ id: 2, callFrame: { functionName: 'other' } }); f.profile.samples = [2, 2, 1]; },
    f => { f.profile.nodes[0].callFrame.columnNumber = -1; },
  ])('fails closed on short, stale, invisible or inconsistent evidence', mutate => {
    const f = fixture(); mutate(f); expect(() => assertBusyBannerProof(f)).toThrow();
  });

  it('reads the independent profile and preserves raw evidence outside the private profile', async () => {
    const f = await diskFixture(); await fs.mkdir(f.evidenceDir, { mode: 0o700 });
    const proof = await waitForBusyBannerProof(f.userData, { pid: f.pid, expectedVersion: f.expectedVersion, evidenceDir: f.evidenceDir });
    expect(proof.watchdog.profileFile).toBe(profileFile);
    expect(JSON.parse(await fs.readFile(path.join(f.evidenceDir, profileFile), 'utf8'))).toEqual(f.profile);
  });

  it('runs functional smoke after recovery and emits acceptance only after a clean exit', async () => {
    const f = await diskFixture();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const runSmoke = async (_app, options) => {
        expect(options.env.NEXUS_SMOKE_BUSY_BANNER_PROBE).toBe('1');
        expect(options.env.NEXUS_SMOKE_HANG_PROBE).toBe('0');
        const runtimeProof = await options.runtimeProbe({ pid: 4321 }, { userData: f.userData, signal: new AbortController().signal });
        return { code: 0, runtimeProof, treeProof: { ok: true }, processTreeProof: { orphans: [] }, shutdownMode: 'graceful', output: '[smoke] busy-banner: visible frames and automatic recovery proven\n[smoke] functional-ready: probes\n[smoke] shutdown-complete: physical PTY inventory proven' };
      };
      const proof = await runPackagedBusyBannerProbe('/fixture/NexusIDE.app', { expectedVersion: f.expectedVersion, evidenceDir: f.evidenceDir, runSmoke, env: { NEXUS_SMOKE_HANG_PROBE: '1' } });
      expect(proof.functionalSmokeAfterRecovery).toBe(true);
      expect(JSON.parse(await fs.readFile(path.join(f.evidenceDir, 'acceptance.json'), 'utf8'))).toEqual(proof);
    } finally { stdout.mockRestore(); }
  });

  it('never overwrites old acceptance artifacts', async () => {
    const f = await diskFixture(); await fs.mkdir(f.evidenceDir);
    await expect(runPackagedBusyBannerProbe('/fixture/NexusIDE.app', { expectedVersion: f.expectedVersion, evidenceDir: f.evidenceDir, runSmoke: async () => { throw new Error('must not launch'); } })).rejects.toThrow(/exist/);
  });
});
