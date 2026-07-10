import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'voice-run-jarvis-turn.ts'), 'utf-8');

describe('Live action narration fallback', () => {
  it('uses Classic TTS when liveSay fails instead of completing silently', () => {
    expect(source).toContain('jarvis.liveSpeakDegraded');
    expect(source).toContain('Live não falou — Classic TTS assume');
    expect(source).not.toContain('jarvis.liveSpeakMissed');
  });

  it('waits for Live evidence and quiesces the socket before Classic owns audio', () => {
    const toolsSource = fs.readFileSync(
      path.join(__dirname, 'voice-realtime-tools.ts'),
      'utf-8',
    );
    expect(toolsSource).toContain('waitForLiveSpeakEvidence');
    expect(toolsSource).toContain("quiesceLiveForClassic('live-say-no-evidence')");
  });
});
