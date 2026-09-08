import { useEffect, useRef } from 'react';
import { useVoiceStore } from '../voice/voice-store';

/**
 * Barrinhas de nível do mic durante a captura (ditado Space ou Jarvis).
 *
 * O orb já pulsa com a amplitude real (`--voice-amp`), mas é sutil — o
 * operador segurando Space quer a prova explícita de "está me ouvindo".
 * Atualização IMPERATIVA via subscription do store (mesmo padrão do orb):
 * o nível publica por frame de áudio e re-render por frame derrubaria o
 * terminal. `visible` falso desmonta (sem custo fora da captura).
 */

export const VOICE_LEVEL_BAR_COUNT = 7;
/** Altura mínima visível: barra nunca some enquanto o componente monta. */
const MIN_HEIGHT_PCT = 6;

/** Centro alto, bordas baixas — leitura clássica de VU em 7 barras. */
export function voiceLevelBarHeight(
  level: number,
  index: number,
  count: number = VOICE_LEVEL_BAR_COUNT,
): number {
  const safeLevel = Number.isFinite(level)
    ? Math.max(0, Math.min(1, level))
    : 0;
  const center = (count - 1) / 2;
  const dist = center === 0 ? 0 : Math.abs(index - center) / center;
  const height = safeLevel * 1.7 - 0.55 * dist;
  const clamped = Math.max(0, Math.min(1, height));
  return Math.round(MIN_HEIGHT_PCT + clamped * (100 - MIN_HEIGHT_PCT));
}

export function VoiceLevelBars({ visible }: { visible: boolean }) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    if (!visible) return;
    const paint = (level: number) => {
      const bars = barsRef.current;
      for (let i = 0; i < bars.length; i += 1) {
        const el = bars[i];
        if (el) el.style.height = `${voiceLevelBarHeight(level, i)}%`;
      }
    };
    paint(useVoiceStore.getState().level);
    return useVoiceStore.subscribe((s) => paint(s.level));
  }, [visible]);

  if (!visible) return null;
  return (
    <span
      className="voice-levelbars"
      aria-hidden="true"
      data-testid="voice-level-bars"
    >
      {Array.from({ length: VOICE_LEVEL_BAR_COUNT }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          className="voice-levelbars__bar"
        />
      ))}
    </span>
  );
}
