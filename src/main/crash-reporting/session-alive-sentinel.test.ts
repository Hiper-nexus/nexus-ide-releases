import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bucketRssMb,
  readSessionAliveMarker,
  writeSessionAliveMarker,
  SessionAliveSentinel,
  type SessionAliveMarker,
} from './session-alive-sentinel';

describe('session-alive-sentinel', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sentinel-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('buckets RSS memory to nearest 10 MB', () => {
    expect(bucketRssMb(1024 * 1024 * 42)).toBe(40);
    expect(bucketRssMb(1024 * 1024 * 47)).toBe(50);
    expect(bucketRssMb(1024 * 1024 * 2)).toBe(10); // minimum 10
  });

  it('detects ungraceful exit from prior session', () => {
    const priorMarker: SessionAliveMarker = {
      schemeVersion: 1,
      pid: 12345,
      startTime: Date.now() - 60_000,
      lastPulse: Date.now() - 1_000,
      rssMb: 120,
      activePanes: 3,
      expectedExit: false,
    };
    writeSessionAliveMarker(tempDir, priorMarker);

    let reportedCrash: SessionAliveMarker | undefined;
    const sentinel = new SessionAliveSentinel({
      userDataPath: tempDir,
      intervalMs: 100,
      onPriorCrashDetected: (p) => {
        reportedCrash = p;
      },
    });

    const { priorCrash } = sentinel.start();
    expect(priorCrash).not.toBeNull();
    expect(priorCrash?.pid).toBe(12345);
    expect(reportedCrash).toBeDefined();
    expect(reportedCrash?.activePanes).toBe(3);

    sentinel.dispose();
  });

  it('onPriorCrashDetected callback receives prior crash PID and activePane count when expectedExit is false', () => {
    const priorMarker: SessionAliveMarker = {
      schemeVersion: 1,
      pid: 99999,
      startTime: Date.now() - 120_000,
      lastPulse: Date.now() - 5_000,
      rssMb: 256,
      activePanes: 7,
      expectedExit: false,
    };
    writeSessionAliveMarker(tempDir, priorMarker);

    let capturedMarker: SessionAliveMarker | undefined;
    const sentinel = new SessionAliveSentinel({
      userDataPath: tempDir,
      intervalMs: 100,
      onPriorCrashDetected: (marker) => {
        capturedMarker = marker;
      },
    });

    sentinel.start();
    expect(capturedMarker).toBeDefined();
    expect(capturedMarker!.pid).toBe(99999);
    expect(capturedMarker!.activePanes).toBe(7);
    expect(capturedMarker!.rssMb).toBe(256);
    sentinel.dispose();
  });

  it('onPriorCrashDetected does NOT fire when expectedExit is true (clean shutdown)', () => {
    const cleanMarker: SessionAliveMarker = {
      schemeVersion: 1,
      pid: 11111,
      startTime: Date.now() - 60_000,
      lastPulse: Date.now() - 1_000,
      rssMb: 100,
      activePanes: 2,
      expectedExit: true,
    };
    writeSessionAliveMarker(tempDir, cleanMarker);

    let fired = false;
    const sentinel = new SessionAliveSentinel({
      userDataPath: tempDir,
      intervalMs: 100,
      onPriorCrashDetected: () => {
        fired = true;
      },
    });

    const { priorCrash } = sentinel.start();
    expect(priorCrash).toBeNull();
    expect(fired).toBe(false);
    sentinel.dispose();
  });

  it('marks expectedExit after any asynchronous pulse on graceful shutdown', async () => {
    const sentinel = new SessionAliveSentinel({
      userDataPath: tempDir,
      intervalMs: 100,
      getActivePanes: () => 2,
    });

    sentinel.start();
    let current = readSessionAliveMarker(tempDir);
    expect(current?.expectedExit).toBe(false);

    const pulse = sentinel.pulseAsync().catch(() => undefined);
    await sentinel.markExpectedExit();
    await pulse;
    current = readSessionAliveMarker(tempDir);
    expect(current?.expectedExit).toBe(true);

    sentinel.dispose();
  });
});
