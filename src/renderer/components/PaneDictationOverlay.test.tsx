/** @vitest-environment jsdom */
/**
 * F-371 — chip de ditado no pane: feedback in-pane enquanto o STT/polish
 * roda (antes era só um cursor piscando por ~6 s).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaneDictationOverlay } from './PaneDictationOverlay';
import { useVoiceStore } from '../voice/voice-store';
import {
  claimDictationTarget,
  resetDictationTargetForTests,
} from '../voice/dictation-target';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function mount(isFocused: boolean): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<PaneDictationOverlay isFocused={isFocused} />));
  return host;
}

function setPending(mode?: 'english' | 'portuguese'): void {
  act(() => {
    useVoiceStore.setState({
      dictationPending: { startedAt: Date.now(), mode },
      dictationFailed: false,
    } as never);
  });
}

beforeEach(() => {
  resetDictationTargetForTests();
  useVoiceStore.setState({
    dictationPending: null,
    dictationFailed: false,
  } as never);
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
  resetDictationTargetForTests();
  useVoiceStore.setState({
    dictationPending: null,
    dictationFailed: false,
  } as never);
});

describe('PaneDictationOverlay (F-371)', () => {
  it('mostra "Transcrevendo áudio…" no pane focado enquanto o ditado espera', () => {
    setPending('english');
    const host = mount(true);
    const chip = host.querySelector('[role="status"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('aria-live')).toBe('polite');
    expect(host.textContent).toContain('Transcrevendo áudio…');
    expect(host.textContent).toContain(
      'Modo CODE: transcrição e refino do texto',
    );
  });

  it('modo português não anuncia o refino CODE', () => {
    setPending('portuguese');
    const host = mount(true);
    expect(host.textContent).toContain('Transcrevendo áudio…');
    expect(host.textContent).not.toContain('Modo CODE');
  });

  it('some quando o pane não está focado', () => {
    setPending('english');
    expect(mount(false).textContent).toBe('');
  });

  it('some quando a entrega resolve (sucesso) ou o turno é descartado', () => {
    setPending('english');
    const host = mount(true);
    expect(host.textContent).toContain('Transcrevendo áudio…');
    act(() => {
      useVoiceStore.setState({ dictationPending: null } as never);
    });
    expect(host.textContent).toBe('');
  });

  it('variante de falha: "Transcrição falhou — veja Voz"', () => {
    act(() => {
      useVoiceStore.setState({
        dictationPending: null,
        dictationFailed: true,
      } as never);
    });
    const host = mount(true);
    expect(host.textContent).toContain('Transcrição falhou — veja Voz');
    expect(host.textContent).not.toContain('Transcrevendo');
  });

  it('falha também é limpa quando a store desarma o flag', () => {
    act(() => {
      useVoiceStore.setState({ dictationFailed: true } as never);
    });
    const host = mount(true);
    expect(host.textContent).toContain('Transcrição falhou');
    act(() => {
      useVoiceStore.setState({ dictationFailed: false } as never);
    });
    expect(host.textContent).toBe('');
  });

  it('após 2 s mostra os segundos decorridos', () => {
    act(() => {
      useVoiceStore.setState({
        dictationPending: { startedAt: Date.now() - 3_100, mode: 'english' },
      } as never);
    });
    const host = mount(true);
    expect(host.textContent).toContain('3s');
  });

  it('esconde quando uma superfície de UI reivindicou o alvo do ditado', () => {
    const release = claimDictationTarget('mission-wizard', () => {});
    setPending('english');
    expect(mount(true).textContent).toBe('');
    release();
  });
});
