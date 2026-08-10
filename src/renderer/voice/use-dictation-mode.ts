import { useVoiceStore } from './voice-store';

/**
 * Modo do ditado (paridade ClockVoice): estado + toggle compartilhados entre o
 * chip da barra superior e o chip do HUD. Persistência OTIMISTA via setConfig;
 * em falha o store fica como está — o rótulo nunca mente.
 */
export type DictationMode = 'english' | 'portuguese';

export interface DictationModeControl {
  mode: DictationMode;
  /** Rótulo curto do chip. */
  label: 'CODE' | 'CHAT';
  /** Tooltip com o estado atual e o destino do clique. */
  title: string;
  toggle: () => Promise<void>;
}

export function useDictationMode(): DictationModeControl {
  const info = useVoiceStore((s) => s.info);
  const setInfo = useVoiceStore((s) => s.setInfo);
  const mode: DictationMode =
    info?.dictationOutputMode === 'portuguese' ? 'portuguese' : 'english';

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

  return {
    mode,
    label: mode === 'english' ? 'CODE' : 'CHAT',
    title:
      mode === 'english'
        ? 'Ditado: Code — inglês otimizado p/ execução (clique p/ Chat)'
        : 'Ditado: Chat — português literal (clique p/ Code)',
    toggle,
  };
}
