/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceRuntimeInfo } from '../../shared/voice-ipc';
import { useDictationMode } from './use-dictation-mode';
import { useVoiceStore } from './voice-store';

// vi.mock é içado e vale para o arquivo INTEIRO — a factory preserva o
// comportamento real (todo provedor traduz) exceto o id usado para exercitar
// o mecanismo ·PT do chip, que hoje não tem representante real.
vi.mock('../../shared/voice-config', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../shared/voice-config')>();
  return {
    ...actual,
    sttProviderTranslates: (id: string) => id !== 'stub-literal',
  };
});

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
  it('avisa qual API vai atender o ditado (F-524)', () => {
    const { title } = mountTitle();
    act(() => useVoiceStore.setState({ info: infoWith('gemini') }));

    expect(title()).toContain('via Gemini');
  });

  it('o RÓTULO denuncia a troca quando o provedor não traduz (mecanismo ·PT)', () => {
    // O Gemini agora traduz (generateContent) — o mecanismo do sufixo segue
    // valendo para futuros provedores transcription-only, coberto via mock.
    const { label } = mountTitle();
    act(() => useVoiceStore.setState({ info: infoWith('stub-literal') }));

    expect(label()).toBe('CODE·PT');
  });

  it('gemini deixa de ser CODE·PT — a rota generativa entrega inglês', () => {
    const { label } = mountTitle();
    act(() => useVoiceStore.setState({ info: infoWith('gemini') }));

    expect(label()).toBe('CODE');
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
