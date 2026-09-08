/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  VOICE_LEVEL_BAR_COUNT,
  VoiceLevelBars,
  voiceLevelBarHeight,
} from './VoiceLevelBars';
import { useVoiceStore } from '../voice/voice-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  document.body.innerHTML = '';
  useVoiceStore.getState().setLevel(0);
});

function mount(visible: boolean): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(<VoiceLevelBars visible={visible} />);
  });
  return host;
}

function barHeights(host: HTMLElement): number[] {
  return [...host.querySelectorAll('.voice-levelbars__bar')].map((el) =>
    Number.parseFloat((el as HTMLElement).style.height),
  );
}

describe('voiceLevelBarHeight', () => {
  it('silêncio zera todas, teto enche todas', () => {
    const zeros = Array.from(
      { length: VOICE_LEVEL_BAR_COUNT },
      (_, i) => voiceLevelBarHeight(0, i),
    );
    expect(Math.max(...zeros)).toBeLessThanOrEqual(6);
    const full = Array.from(
      { length: VOICE_LEVEL_BAR_COUNT },
      (_, i) => voiceLevelBarHeight(1, i),
    );
    expect(Math.min(...full)).toBe(100);
  });

  it('centro mais alto que as bordas em nível médio', () => {
    const mid = 0.5;
    const center = voiceLevelBarHeight(mid, 3);
    expect(center).toBeGreaterThan(voiceLevelBarHeight(mid, 0));
    expect(center).toBeGreaterThan(voiceLevelBarHeight(mid, 6));
  });

  it('tolerante a NaN', () => {
    expect(voiceLevelBarHeight(Number.NaN, 3)).toBeLessThanOrEqual(6);
  });
});

describe('VoiceLevelBars', () => {
  it('não renderiza nada fora da captura', () => {
    const host = mount(false);
    expect(
      host.querySelector('[data-testid="voice-level-bars"]'),
    ).toBeNull();
  });

  it('pinta as barras do nível do store sem re-render', () => {
    const host = mount(true);
    expect(
      host.querySelectorAll('.voice-levelbars__bar').length,
    ).toBe(VOICE_LEVEL_BAR_COUNT);
    act(() => {
      useVoiceStore.getState().setLevel(0.9);
    });
    const heights = barHeights(host);
    expect(Math.max(...heights)).toBe(100);
    expect(Math.min(...heights)).toBeGreaterThan(6);
  });

  it('acompanha o nível em tempo real (fala → silêncio)', () => {
    const host = mount(true);
    act(() => {
      useVoiceStore.getState().setLevel(0.7);
    });
    const speaking = barHeights(host);
    act(() => {
      useVoiceStore.getState().setLevel(0);
    });
    const silent = barHeights(host);
    expect(Math.max(...speaking)).toBeGreaterThan(Math.max(...silent));
  });
});
