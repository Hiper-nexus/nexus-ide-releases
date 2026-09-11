import { sttProviderTranslates } from '../../shared/voice-config';
import { useVoiceStore } from './voice-store';

/**
 * Modo do ditado (paridade ClockVoice): estado + toggle compartilhados entre o
 * chip da barra superior e o chip do HUD. Persistência OTIMISTA via setConfig;
 * em falha o store fica como está — o rótulo nunca mente.
 */
export type DictationMode = 'english' | 'portuguese';

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

  // O provedor ativo pode ser transcription-only (Gemini 3.5 Transcribe, cujo
  // Interactions API não traduz). Com ele ativo o modo CODE NÃO produz inglês —
  // prometer tradução no tooltip seria o chip mentindo sobre o que vai sair.
  // `stt` também é opcional: mocks e um info parcial não trazem a cadeia, e
  // `info?.stt.active` estourava com stt undefined.
  const activeProvider = info?.stt?.active?.provider;
  const translates = activeProvider
    ? sttProviderTranslates(activeProvider)
    : true;

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
      ? 'Ditado: Code — inglês otimizado p/ execução'
      : 'Ditado: Chat — português literal';
  const caveat = translates
    ? ''
    : ` · ${activeProvider} só transcreve (sem tradução): o texto sai em português`;

  const baseLabel = mode === 'english' ? 'CODE' : 'CHAT';
  // Divulgação MECÂNICA, não só tooltip: quem já está ditando não passa o mouse
  // no chip. Com provedor transcription-only o modo CODE entrega português, e o
  // rótulo precisa dizer isso na cara.
  const label =
    mode === 'english' && !translates ? `${baseLabel}·PT` : baseLabel;

  return {
    mode,
    label,
    title: `${base}${caveat} (clique p/ ${mode === 'english' ? 'Chat' : 'Code'})`,
    toggle,
  };
}
