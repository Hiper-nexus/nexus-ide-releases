import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'VoiceHud.tsx'), 'utf-8');

describe('VoiceHud drag and mute-key copy', () => {
  it('drags from window-level pointer events, not only the pill box', () => {
    expect(source).toContain("window.addEventListener('pointermove'");
    expect(source).toContain("window.addEventListener('pointerup'");
    expect(source).toContain('clampHudDragPosition');
    expect(source).not.toContain('onPointerMove={moveDrag}');
  });

  it('shows a visible missing-key message instead of staying mute', () => {
    expect(source).toContain('realtimeMissingCredentialMessage');
    expect(source).toContain('sem chave');
    expect(source).toContain('Sem chave realtime');
    expect(source).toContain('openSettings()');
  });
});
