import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('WakeMic getUserMedia constraints', () => {
  it('keeps Chromium APM disabled and resolves device without forcing mono', () => {
    const source = fs.readFileSync(path.join(__dirname, 'wake-mic.ts'), 'utf-8');
    expect(source).toContain('echoCancellation: false');
    expect(source).toContain('noiseSuppression: false');
    expect(source).toContain('autoGainControl: false');
    expect(source).not.toContain('channelCount: 1');
    expect(source).toContain('downmixChannelsToMono');
    expect(source).toContain('resolveAudioConstraints');
  });
});
