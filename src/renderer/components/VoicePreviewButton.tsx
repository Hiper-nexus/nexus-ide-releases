import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelIcon, type PixelIconName } from './PixelIcon';
import { playSpeakResult } from '../voice/voice-playback';
import type { SpeakPreviewProvider } from '../../shared/voice-ipc';

/**
 * Pré-escuta da voz por etapas: um clique toca UMA amostra da voz escolhida, no
 * provider que o rótulo nomeia ("amostra pelo Gemini TTS" ≠ "a voz da Jarvis").
 *
 * Decisões que já custaram arrependimento em selector de voz:
 * - NUNCA toca ao trocar o `<select>`. Voz que fala sozinha no clique alheio é
 *   perturbador e, com o mic aberto, vira transcrição espúria.
 * - Reproduz com as respostas mutadas: o botão foi clicado para ouvir; responder
 *   em silêncio não tem explicação visível.
 * - Uma amostra por vez: o segundo clique durante a reprodução não empilha áudio.
 * - O erro é inline e nomeia o provider, porque "falhou" sem dizer qual dos dois
 *   provedores falhou obriga a pessoa a adivinhar.
 */

export type VoicePreviewState = 'idle' | 'loading' | 'playing' | 'error';

const PROVIDER_LABEL: Record<SpeakPreviewProvider, string> = {
  gemini: 'Gemini TTS',
  openai: 'OpenAI TTS',
};

export function voicePreviewLabel(
  provider: SpeakPreviewProvider,
  state: VoicePreviewState,
): string {
  const name = PROVIDER_LABEL[provider];
  if (state === 'loading') return `Gerando amostra pelo ${name}`;
  if (state === 'playing') return `Tocando amostra do ${name}`;
  if (state === 'error') return `Falha na amostra do ${name}`;
  return `Ouvir amostra pelo ${name}`;
}

export function voicePreviewErrorText(error: string, provider: SpeakPreviewProvider): string {
  // O erro do Main é técnico ("TTS 429: …"). A pessoa precisa do que fazer.
  if (/429|rate|quota/i.test(error)) {
    return `O ${PROVIDER_LABEL[provider]} está com cota esgotada. Tente em instantes.`;
  }
  if (/401|403|unauthorized|chave|api key/i.test(error)) {
    return `O ${PROVIDER_LABEL[provider]} recusou a chave. Confira a credencial desse serviço.`;
  }
  if (/não suportada/i.test(error)) {
    return 'Essa voz não está disponível para amostra agora.';
  }
  return `Não consegui gerar a amostra pelo ${PROVIDER_LABEL[provider]}.`;
}

const ICON_BY_STATE: Record<VoicePreviewState, PixelIconName> = {
  idle: 'volume',
  loading: 'volume',
  playing: 'stop',
  error: 'warn',
};

export function VoicePreviewButton({
  provider,
  voice,
}: {
  provider: SpeakPreviewProvider;
  voice: string;
}) {
  const [state, setState] = useState<VoicePreviewState>('idle');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const preview = useCallback(async () => {
    // Uma amostra por vez: durante a geração ou a reprodução o botão para.
    if (state === 'loading' || state === 'playing') return;
    setError(null);
    setState('loading');
    try {
      const result = await window.nexus.voice.speak({ preview: { provider, voice } });
      if (!mounted.current) return;
      if (!result.ok) {
        setError(voicePreviewErrorText(result.error ?? '', provider));
        setState('error');
        return;
      }
      setState('playing');
      // ignoreMute: quem pediu para ouvir precisa ouvir.
      await playSpeakResult(result, undefined, { ignoreMute: true });
      if (!mounted.current) return;
      setState('idle');
    } catch {
      if (!mounted.current) return;
      setError(`Não consegui gerar a amostra pelo ${PROVIDER_LABEL[provider]}.`);
      setState('error');
    }
  }, [provider, state, voice]);

  const busy = state === 'loading' || state === 'playing';
  const label = voicePreviewLabel(provider, state);

  return (
    <div className="voice-preview">
      <button
        type="button"
        className={`voice-preview__button voice-preview__button--${state}`}
        onClick={() => void preview()}
        disabled={busy}
        aria-label={label}
        title={label}
      >
        <PixelIcon name={ICON_BY_STATE[state]} size={12} />
        <span aria-hidden>{busy ? 'Parar' : 'Ouvir'}</span>
      </button>
      {error ? (
        <p className="voice-preview__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
