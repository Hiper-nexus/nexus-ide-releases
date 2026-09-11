/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { VoiceRuntimeInfo } from '../../shared/voice-ipc';
import { useDictationMode } from './use-dictation-mode';
import { useVoiceStore } from './voice-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  document.body.innerHTML = '';
  useVoiceStore.setState({ info: null });
});

/** Monta o hook e devolve leitores do title e do label atuais. */
function mountTitle(): { title: () => string; label: () => string } {
  let title = '';
  let label = '';
  function Probe(): null {
    const control = useDictationMode();
    title = control.title;
    label = control.label;
    return null;
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<Probe />));
  return { title: () => title, label: () => label };
}

function infoWith(provider: string): VoiceRuntimeInfo {
  return {
    stt: {
      active: { provider, kind: 'cloud', available: true, reason: 'ready' },
      chain: [],
    },
  } as unknown as VoiceRuntimeInfo;
}

describe('useDictationMode', () => {
  it('avisa que o provedor só transcreve quando ele não traduz', () => {
    const { title } = mountTitle();
    act(() => useVoiceStore.setState({ info: infoWith('gemini') }));

    // No modo CODE o texto sai em português mesmo — o chip não pode prometer
    // inglês quando o provedor ativo não tem endpoint de tradução.
    expect(title()).toContain('só transcreve');
    expect(title()).toContain('português');
  });

  it('o RÓTULO denuncia a troca — tooltip não avisa quem já está ditando', () => {
    const { label } = mountTitle();
    act(() => useVoiceStore.setState({ info: infoWith('gemini') }));

    expect(label()).toBe('CODE·PT');
  });

  it('rótulo fica normal quando o provedor traduz', () => {
    const { label } = mountTitle();
    act(() => useVoiceStore.setState({ info: infoWith('groq') }));

    expect(label()).toBe('CODE');
  });

  it('não avisa nada quando o provedor traduz', () => {
    const { title } = mountTitle();
    act(() => useVoiceStore.setState({ info: infoWith('groq') }));

    expect(title()).not.toContain('só transcreve');
    expect(title()).toContain('inglês');
  });

  it('sem info ainda promete o caminho normal (nada de aviso especulativo)', () => {
    const { title } = mountTitle();
    expect(title()).not.toContain('só transcreve');
  });
});
