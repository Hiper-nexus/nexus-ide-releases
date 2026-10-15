import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelIcon, type PixelIconName } from './PixelIcon';
import { playSpeakResult, stopPreviewPlayback } from '../voice/voice-playback';
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
 * - Uma amostra por vez, na tela inteira: iniciar uma para a outra (registro
 *   `activePreview` abaixo), sem empilhar áudio nem tocar a fala da Jarvis.
 * - O botão ocupado é Parar de verdade: na geração descarta a resposta
 *   pendente; na reprodução para a fonte pelo canal de amostra do playback.
 * - A amostra é do provider+voz do clique: trocar no meio invalida a resposta
 *   antiga (token de geração) e desmontar para e descarta.
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
  loading: 'stop',
  playing: 'stop',
  error: 'warn',
};

/** A amostra ativa da tela: uma por vez entre todos os botões montados. */
let activePreview: { owner: object; stop: () => void } | null = null;

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
  const generation = useRef(0);
  const owner = useRef({});

  const stop = useCallback(() => {
    generation.current += 1;
    if (activePreview?.owner === owner.current) {
      activePreview = null;
      stopPreviewPlayback();
    }
    if (mounted.current) setState('idle');
  }, []);

  // Desmontar para e descarta: nenhuma fonte tocando sem botão na tela.
  useEffect(
    () => () => {
      mounted.current = false;
      generation.current += 1;
      if (activePreview?.owner === owner.current) {
        activePreview = null;
        stopPreviewPlayback();
      }
    },
    [],
  );

  // Trocar provider/voz invalida a amostra em voo: ela é da escolha antiga.
  useEffect(() => {
    generation.current += 1;
    if (activePreview?.owner === owner.current) {
      activePreview = null;
      stopPreviewPlayback();
    }
    setError(null);
    setState('idle');
  }, [provider, voice]);

  const preview = useCallback(async () => {
    const gen = (generation.current += 1);
    if (activePreview && activePreview.owner !== owner.current) activePreview.stop();
    activePreview = { owner: owner.current, stop };
    setError(null);
    setState('loading');
    try {
      const result = await window.nexus.voice.speak({ preview: { provider, voice } });
      if (!mounted.current || gen !== generation.current) return;
      if (!result.ok) {
        setError(voicePreviewErrorText(result.error ?? '', provider));
        setState('error');
        return;
      }
      setState('playing');
      // ignoreMute: quem pediu para ouvir precisa ouvir. preview: canal
      // próprio, que o Parar corta sem tocar a fala da Jarvis.
      await playSpeakResult(result, undefined, { ignoreMute: true, preview: true });
      if (!mounted.current || gen !== generation.current) return;
      setState('idle');
    } catch {
      if (!mounted.current || gen !== generation.current) return;
      setError(`Não consegui gerar a amostra pelo ${PROVIDER_LABEL[provider]}.`);
      setState('error');
    } finally {
      if (activePreview?.owner === owner.current && gen === generation.current) {
        activePreview = null;
      }
    }
  }, [provider, stop, voice]);

  const busy = state === 'loading' || state === 'playing';
  const label = busy
    ? `Parar amostra do ${PROVIDER_LABEL[provider]}`
    : voicePreviewLabel(provider, state);

  return (
    <div className="voice-preview">
      <button
        type="button"
        className={`voice-preview__button voice-preview__button--${state}`}
        onClick={() => (busy ? stop() : void preview())}
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
