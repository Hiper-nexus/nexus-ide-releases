/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  VoicePreviewButton,
  voicePreviewErrorText,
  voicePreviewLabel,
} from './VoicePreviewButton';

vi.mock('../voice/voice-playback', () => ({
  playSpeakResult: vi.fn(async () => 900),
  stopPreviewPlayback: vi.fn(),
}));

const { playSpeakResult, stopPreviewPlayback } = await import('../voice/voice-playback');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
document.body.append(host);
let root = createRoot(host);

beforeEach(() => {
  vi.mocked(playSpeakResult).mockReset();
  vi.mocked(playSpeakResult).mockImplementation(async () => 900);
  vi.mocked(stopPreviewPlayback).mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  root = createRoot(host);
  document.body.innerHTML = '';
  document.body.append(host);
});

function speakResult(ok: boolean, error?: string) {
  return ok
    ? ({
        ok: true as const,
        provider: 'gemini',
        mode: 'audio' as const,
        format: 'wav',
        audioBase64: 'AAAA',
      })
    : ({ ok: false as const, error: error ?? 'falhou' });
}

function render(provider: 'gemini' | 'openai', voice = 'Charon') {
  return act(async () => {
    root.render(<VoicePreviewButton provider={provider} voice={voice} />);
  });
}

function button(): HTMLButtonElement {
  return host.querySelector('.voice-preview__button') as HTMLButtonElement;
}

it('não fala sozinho: só o clique pede a amostra', async () => {
  const speak = vi.fn(async () => speakResult(true));
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { voice: { speak } },
  });
  await render('gemini');

  expect(speak).not.toHaveBeenCalled();
  expect(playSpeakResult).not.toHaveBeenCalled();
});

it('o clique pede a amostra do provider e da voz escolhidos, e toca', async () => {
  const speak = vi.fn(async () => speakResult(true));
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { voice: { speak } },
  });
  await render('openai', 'ash');

  await act(async () => {
    button().click();
  });

  expect(speak).toHaveBeenCalledWith({
    preview: { provider: 'openai', voice: 'ash' },
  });
  // Amostra toca com as respostas mutadas: quem clicou quer ouvir.
  expect(playSpeakResult).toHaveBeenCalledWith(
    expect.objectContaining({ ok: true }),
    undefined,
    { ignoreMute: true, preview: true },
  );
  // Volta ao repouso depois de tocar, sem erro na tela.
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('aria-label muda com o estado e diz o provider real', async () => {
  let release: (() => void) | null = null;
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      voice: {
        speak: vi.fn(
          () =>
            new Promise((resolve) => {
              release = () => resolve(speakResult(true));
            }),
        ),
      },
    },
  });
  await render('gemini');

  expect(button().getAttribute('aria-label')).toBe('Ouvir amostra pelo Gemini TTS');

  let pending: Promise<void> | null = null;
  act(() => {
    pending = button().click() as unknown as Promise<void>;
  });
  await act(async () => {
    await Promise.resolve();
  });
  // Durante a geração o botão é Parar (clicável), não um rótulo desabilitado.
  expect(button().getAttribute('aria-label')).toBe('Parar amostra do Gemini TTS');
  expect(button().disabled).toBe(false);

  await act(async () => {
    release?.();
    await pending;
  });
});

it('uma amostra por vez: segundo clique durante a reprodução não empilha', async () => {
  let release: (() => void) | null = null;
  const speak = vi.fn(
    () =>
      new Promise((resolve) => {
        release = () => resolve(speakResult(true));
      }),
  );
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { voice: { speak } },
  });
  await render('gemini');

  act(() => {
    button().click();
  });
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    button().click();
  });
  expect(speak).toHaveBeenCalledTimes(1);

  await act(async () => {
    release?.();
    await Promise.resolve();
  });
});

it('falha da amostra vira alert inline em PT-BR, nomeando o provider', async () => {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      voice: { speak: vi.fn(async () => speakResult(false, 'TTS 429: quota')) },
    },
  });
  await render('gemini');

  await act(async () => {
    button().click();
  });

  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('Gemini TTS');
  expect(alert?.textContent).toContain('cota');
  // O erro técnico do Main não vaza para a tela.
  expect(alert?.textContent).not.toContain('429');
});

it('traduz recusa de chave e voz fora da lista', () => {
  expect(voicePreviewErrorText('TTS 401: unauthorized', 'openai')).toContain(
    'OpenAI TTS',
  );
  expect(voicePreviewErrorText('voz não suportada: X', 'gemini')).toContain(
    'não está disponível',
  );
  expect(voicePreviewErrorText('ECONNRESET', 'gemini')).toContain('Gemini TTS');
});

it('o rótulo honesto nomeia o provider em todos os estados', () => {
  expect(voicePreviewLabel('openai', 'idle')).toBe('Ouvir amostra pelo OpenAI TTS');
  expect(voicePreviewLabel('openai', 'playing')).toBe('Tocando amostra do OpenAI TTS');
  expect(voicePreviewLabel('gemini', 'error')).toBe('Falha na amostra do Gemini TTS');
});

it('Parar durante a geração descarta a resposta pendente', async () => {
  let release: (() => void) | null = null;
  const speak = vi.fn(
    () =>
      new Promise((resolve) => {
        release = () => resolve(speakResult(true));
      }),
  );
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { voice: { speak } },
  });
  await render('gemini');

  act(() => {
    button().click();
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(button().getAttribute('aria-label')).toBe('Parar amostra do Gemini TTS');
  expect(button().disabled).toBe(false);

  // O mesmo botão agora é Parar: cancela antes de a resposta chegar.
  act(() => {
    button().click();
  });
  expect(stopPreviewPlayback).toHaveBeenCalled();
  expect(button().getAttribute('aria-label')).toBe('Ouvir amostra pelo Gemini TTS');

  await act(async () => {
    release?.();
    await Promise.resolve();
  });
  expect(playSpeakResult).not.toHaveBeenCalled();
});

it('Parar durante a reprodução para a fonte da amostra', async () => {
  let releasePlay: (() => void) | null = null;
  vi.mocked(playSpeakResult).mockImplementation(
    () =>
      new Promise<number>((resolve) => {
        releasePlay = () => resolve(900);
      }),
  );
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { voice: { speak: vi.fn(async () => speakResult(true)) } },
  });
  await render('gemini');

  act(() => {
    button().click();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(playSpeakResult).toHaveBeenCalledTimes(1);
  expect(button().getAttribute('aria-label')).toBe('Parar amostra do Gemini TTS');

  act(() => {
    button().click();
  });
  expect(stopPreviewPlayback).toHaveBeenCalled();
  expect(button().getAttribute('aria-label')).toBe('Ouvir amostra pelo Gemini TTS');

  await act(async () => {
    releasePlay?.();
    await Promise.resolve();
  });
});

it('trocar a voz durante a geração invalida a resposta anterior', async () => {
  let release: (() => void) | null = null;
  const speak = vi.fn(
    () =>
      new Promise((resolve) => {
        release = () => resolve(speakResult(true));
      }),
  );
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { voice: { speak } },
  });
  await render('gemini', 'Charon');

  act(() => {
    button().click();
  });
  await act(async () => {
    await Promise.resolve();
  });

  // A voz muda com a geração em voo: a resposta é da voz antiga, não toca.
  await render('gemini', 'Kore');
  await act(async () => {
    release?.();
    await Promise.resolve();
  });

  expect(playSpeakResult).not.toHaveBeenCalled();
  expect(button().getAttribute('aria-label')).toBe('Ouvir amostra pelo Gemini TTS');
});

it('desmontar durante a reprodução para a fonte', async () => {
  const playRelease: Array<() => void> = [];
  vi.mocked(playSpeakResult).mockImplementation(
    () =>
      new Promise<number>((resolve) => {
        playRelease.push(() => resolve(900));
      }),
  );
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { voice: { speak: vi.fn(async () => speakResult(true)) } },
  });
  await render('gemini');

  act(() => {
    button().click();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(playSpeakResult).toHaveBeenCalledTimes(1);

  act(() => root.unmount());
  expect(stopPreviewPlayback).toHaveBeenCalled();
  playRelease[0]?.();
  root = createRoot(host);
});

it('duas amostras na tela: iniciar uma para a outra', async () => {
  const playReleases: Array<() => void> = [];
  vi.mocked(playSpeakResult).mockImplementation(
    () =>
      new Promise<number>((resolve) => {
        playReleases.push(() => resolve(900));
      }),
  );
  const speak = vi.fn(async () => speakResult(true));
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: { voice: { speak } },
  });
  await act(async () => {
    root.render(
      <>
        <VoicePreviewButton provider="gemini" voice="Charon" />
        <VoicePreviewButton provider="openai" voice="ash" />
      </>,
    );
  });
  const buttons = () =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('.voice-preview__button'));

  act(() => {
    buttons()[0].click();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(buttons()[0].getAttribute('aria-label')).toBe('Parar amostra do Gemini TTS');

  act(() => {
    buttons()[1].click();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  // A primeira foi parada; só a segunda segue tocando.
  expect(stopPreviewPlayback).toHaveBeenCalled();
  expect(buttons()[0].getAttribute('aria-label')).toBe('Ouvir amostra pelo Gemini TTS');
  expect(buttons()[1].getAttribute('aria-label')).toBe('Parar amostra do OpenAI TTS');
  expect(speak).toHaveBeenLastCalledWith({
    preview: { provider: 'openai', voice: 'ash' },
  });

  await act(async () => {
    for (const release of playReleases) release();
    await Promise.resolve();
  });
});

it('desmontar no meio da geração não escreve na tela', async () => {
  let release: (() => void) | null = null;
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      voice: {
        speak: vi.fn(
          () =>
            new Promise((resolve) => {
              release = () => resolve(speakResult(false, 'TTS 500'));
            }),
        ),
      },
    },
  });
  await render('gemini');

  act(() => {
    button().click();
  });
  await act(async () => {
    await Promise.resolve();
  });

  act(() => root.unmount());
  expect(() => {
    release?.();
  }).not.toThrow();
  // Nenhum nó órfão com alert depois do unmount.
  expect(document.querySelector('[role="alert"]')).toBeNull();
  root = createRoot(host);
});
