import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'wake-mic.ts'), 'utf8');

describe('passive wake latency policy', () => {
  it('does not let laptop room noise hold every wake until 4.8 seconds', () => {
    expect(source).toContain('speechHangoverRms: PASSIVE_WAKE_RAW_SPEECH_RMS');
    expect(source).toContain('silenceMs: 650');
    expect(source).toContain('maxMs: 2_600');
    expect(source).toContain('forceEmitMinPeakRms: 0.08');
    expect(source).toContain('PASSIVE_WAKE_PREROLL_MS = 700');
    expect(source).toContain('cooldownMs: 120');
  });
});
