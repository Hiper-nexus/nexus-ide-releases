import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('WakeMic getUserMedia constraints', () => {
  it('keeps Chromium APM disabled for raw wake-word PCM', () => {
    const source = fs.readFileSync(path.join(__dirname, 'wake-mic.ts'), 'utf-8');
    const constraints = source.match(
      /navigator\.mediaDevices\.getUserMedia\(\{\s*audio:\s*\{([\s\S]*?)\n\s*\},\s*\}\)/,
    )?.[1];

    expect(constraints).toMatchInlineSnapshot(`
      "
              channelCount: 1,
              sampleRate: TARGET_SAMPLE_RATE,
              // APM (WebRTC audio processing) DESLIGADO no stream de wake word.
              // openWakeWord/KWS quer PCM limpo; o processamento corrompe as
              // features do modelo. autoGainControl (default true do Chromium
              // quando qualquer constraint é pedida) achata o sinal de mics USB
              // sensíveis (fifine) perto de zero → "SO ouve, app mudo". Wake é
              // pausado (suppressWakeDetection) enquanto a JARVIS fala, então eco
              // não importa aqui.
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,"
    `);
  });
});
