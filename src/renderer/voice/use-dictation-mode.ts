import { sttProviderTranslates } from '../../shared/voice-config';
import { sttProviderLabel } from './stt-failure-help';
import { useVoiceStore } from './voice-store';

/**
 * Modo do ditado (paridade ClockVoice): estado + toggle compartilhados entre o
 * chip da barra superior e o chip do HUD. Persistência OTIMISTA via setConfig;
 * em falha o store fica como está — o rótulo nunca mente.
 */
export type DictationMode = 'english' | 'portuguese';

/** Chaves que atendem a reescrita do ditado CODE (main/voice/code-prompt-polish). */
const CODE_POLISH_KEY_ENV_VARS: ReadonlySet<string> = new Set([
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
]);

export interface DictationModeControl {
  mode: DictationMode;
  /**
   * Rótulo curto do chip. Ganha o sufixo `·PT` quando o provedor ativo não
   * traduz e o modo pede inglês — ver `label` abaixo.
   */
  label: string;
  /** Tooltip com o estado atual e o destino do clique. */
  title: string;
  toggle: () => Promise<void>;
}

export function useDictationMode(): DictationModeControl {
  const info = useVoiceStore((s) => s.info);
  const setInfo = useVoiceStore((s) => s.setInfo);
  const mode: DictationMode =
    info?.dictationOutputMode === 'portuguese' ? 'portuguese' : 'english';

  // O provedor ativo pode ser transcription-only (sem rota de tradução). O
  // Gemini deixou de ser (0.76.24: modo english via generateContent), mas o
  // mecanismo do sufixo segue valendo para futuros provedores — prometer
  // tradução no tooltip com provedor que não traduz seria o chip mentindo.
  // `stt` também é opcional: mocks e um info parcial não trazem a cadeia, e
  // `info?.stt.active` estourava com stt undefined.
  const activeProvider = info?.stt?.active?.provider;
  const sttTranslates = activeProvider
    ? sttProviderTranslates(activeProvider)
    : true;
  // O main reescreve o ditado CODE em inglês por um modelo de texto (cérebro
  // Gemini/OpenAI/Groq ou Grok pela chave do xAI). Com qualquer uma dessas
  // chaves, até uma STT que só transcreve entrega inglês.
  const polishAvailable = (info?.keys ?? []).some(
    (key) =>
      CODE_POLISH_KEY_ENV_VARS.has(key.envVar) &&
      (key.hasEnv || key.hasStoredKey),
  );
  const translates = sttTranslates || polishAvailable;

  const toggle = async () => {
    const next: DictationMode = mode === 'english' ? 'portuguese' : 'english';
    try {
      const updated = await window.nexus.voice.setConfig({
        dictationOutputMode: next,
      });
      setInfo(updated);
    } catch {
      // Sem toast: o chip reflete o store — se não salvou, não muda.
    }
  };

  const base =
    mode === 'english'
      ? 'Ditado: Code — vira prompt em inglês para o agente'
      : 'Ditado: Chat — português literal';
  // F-524: o operador precisa saber QUAL API vai atender o ditado sem abrir
  // configuração nenhuma — o provider ativo viaja no tooltip do chip.
  const via = activeProvider
    ? ` · via ${sttProviderLabel(activeProvider)}`
    : '';
  const caveat = translates
    ? ''
    : ` · ${activeProvider} só transcreve e não há chave de modelo de texto (Gemini, OpenAI, Groq ou xAI): o texto sai em português`;

  const baseLabel = mode === 'english' ? 'CODE' : 'CHAT';
  // Divulgação MECÂNICA, não só tooltip: quem já está ditando não passa o mouse
  // no chip. Com provedor transcription-only o modo CODE entrega português, e o
  // rótulo precisa dizer isso na cara.
  const label =
    mode === 'english' && !translates ? `${baseLabel}·PT` : baseLabel;

  return {
    mode,
    label,
    title: `${base}${via}${caveat} (clique p/ ${mode === 'english' ? 'Chat' : 'Code'})`,
    toggle,
  };
}
