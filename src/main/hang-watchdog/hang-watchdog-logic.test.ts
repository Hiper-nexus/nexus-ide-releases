import { describe, expect, it } from 'vitest';
import {
  HANG_WATCHDOG_HEARTBEAT_MS,
  HANG_WATCHDOG_THRESHOLD_MS,
  buildHangMarker,
  shouldMarkHang,
} from './hang-watchdog-logic';

describe('shouldMarkHang (campanha 0.50, C7 — família keychain)', () => {
  it('gap abaixo do limiar não marca', () => {
    expect(
      shouldMarkHang({ lastHeartbeatAt: 1_000, now: 1_000 + HANG_WATCHDOG_HEARTBEAT_MS }),
    ).toBe(false);
  });

  it('gap acima do limiar marca', () => {
    expect(
      shouldMarkHang({
        lastHeartbeatAt: 1_000,
        now: 1_000 + HANG_WATCHDOG_THRESHOLD_MS + 1,
      }),
    ).toBe(true);
  });

  it('sem heartbeat ainda (boot) não marca', () => {
    expect(shouldMarkHang({ lastHeartbeatAt: null, now: 60_000 })).toBe(false);
  });
});

describe('buildHangMarker', () => {
  it('carrega duração, versão e é JSON serializável', () => {
    const marker = buildHangMarker({
      hangDurationMs: 45_000,
      version: '0.50.0',
      lastHeartbeatAt: 123,
    });
    expect(marker).toMatchObject({
      kind: 'main-thread-hang',
      hangDurationMs: 45_000,
      appVersion: '0.50.0',
    });
    expect(() => JSON.stringify(marker)).not.toThrow();
  });
});
