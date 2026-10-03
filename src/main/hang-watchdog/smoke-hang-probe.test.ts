import { describe, expect, it } from 'vitest';
import {
  SMOKE_HANG_PROBE_ENV,
  SMOKE_HANG_PROBE_BLOCK_MS,
  SMOKE_HANG_PROBE_TUNING,
  describeHangRecordForSmoke,
  induceSmokeMainHang,
  isSmokeHangProbeRequested,
} from './smoke-hang-probe';

describe('probe de travamento do smoke empacotado (F-764 A.1)', () => {
  it('só liga no modo smoke COM a env — a env sozinha nunca trava um launch normal', () => {
    expect(isSmokeHangProbeRequested({ smokeTest: true, env: { [SMOKE_HANG_PROBE_ENV]: '1' } })).toBe(true);
    expect(isSmokeHangProbeRequested({ smokeTest: false, env: { [SMOKE_HANG_PROBE_ENV]: '1' } })).toBe(false);
    expect(isSmokeHangProbeRequested({ smokeTest: true, env: {} })).toBe(false);
    expect(isSmokeHangProbeRequested({ smokeTest: true, env: { [SMOKE_HANG_PROBE_ENV]: 'true' } })).toBe(false);
  });

  it('o travamento cabe na detecção + captura com folga', () => {
    expect(SMOKE_HANG_PROBE_BLOCK_MS).toBe(40_000);
    const tuning = SMOKE_HANG_PROBE_TUNING;
    expect((tuning.thresholdMs ?? 0) + (tuning.checkIntervalMs ?? 0) + (tuning.profileDurationMs ?? 0)).toBeLessThan(SMOKE_HANG_PROBE_BLOCK_MS - 1_000);
  });

  it('trava a main de verdade pelo tempo pedido', () => {
    const startedAt = Date.now();
    expect(induceSmokeMainHang(120)).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120);
  });

  it('descreve cada linha do watchdog em uma linha de stdout', () => {
    expect(
      describeHangRecordForSmoke({
        kind: 'main-thread-hang',
        hangDurationMs: 1_750,
        appVersion: '1',
        lastHeartbeatAt: 0,
        detectedAt: 1,
        eventLoop: null,
      }),
    ).toBe('[smoke] hang-probe: travamento detectado (1750 ms sem heartbeat)');
    expect(
      describeHangRecordForSmoke({
        kind: 'main-thread-hang-profile',
        appVersion: '1',
        lastHeartbeatAt: 0,
        capturedAt: 1,
        captureMs: 1,
        profileFile: 'main-hang-x.cpuprofile',
        topFrames: [{ functionName: 'nexusSmokeInducedMainHang', url: '', line: 1, column: 1, selfSamples: 9, selfPercent: 99.9, stack: [] }],
      }),
    ).toBe('[smoke] hang-probe: profile main-hang-x.cpuprofile topo=nexusSmokeInducedMainHang (99.9%)');
    expect(
      describeHangRecordForSmoke({
        kind: 'main-thread-hang-profile',
        appVersion: '1',
        lastHeartbeatAt: 0,
        capturedAt: 1,
        captureMs: 1,
        profilerUnavailable: 'sem inspector',
      }),
    ).toBe('[smoke] hang-probe: profile indisponível: sem inspector');
    expect(
      describeHangRecordForSmoke({
        kind: 'main-thread-hang-recovered',
        appVersion: '1',
        lastHeartbeatAt: 0,
        recoveredAt: 6_000,
        hangDurationMs: 6_000,
      }),
    ).toBe('[smoke] hang-probe: main de volta (6000 ms)');
  });
});
