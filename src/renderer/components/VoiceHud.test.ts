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

  it('keeps activation separate from the expanded-panel drag grip', () => {
    expect(source).toContain('className={`voice-figure');
    expect(source).toContain('onClick={onActivate}');
    expect(source).toContain('onActivate={activateHud}');
    expect(source).toContain('onPointerDown={beginDrag}');
  });

  it('does not keep CSS for the old DOM particles: the body is a canvas now', () => {
    const css = fs.readFileSync(path.join(__dirname, '../styles/voice-hud.css'), 'utf-8');
    // Os seletores/variáveis das partículas por DOM não têm mais elemento no
    // TSX; o `var(--particle-*)` órfão invalidava a suíte de tokens.
    expect(css).not.toContain('voice-figure__particle');
    expect(css).not.toContain('voice-figure__field');
    expect(css).not.toContain('voice-figure-assemble');
    expect(css).not.toContain('--particle-');
    expect(source).not.toContain('voice-figure__particle');
    // O que sobra do corpo: o botão, a linha de chão e o foco de teclado.
    expect(css).toContain('.voice-figure__ground');
    expect(css).toContain('.voice-figure:focus-visible');
  });

  it('shows a visible missing-key message instead of staying mute', () => {
    expect(source).toContain('realtimeMissingCredentialMessage');
    expect(source).toContain('sem chave');
    expect(source).toContain('Sem chave realtime');
    expect(source).toContain('openSettings()');
  });
});
