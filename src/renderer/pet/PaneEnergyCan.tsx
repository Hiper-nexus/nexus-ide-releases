import { useEffect, useRef, useState } from 'react';
import { fmt } from '../components/operator-sprite-data';
import { useGamificationStore, xpGain } from '../state/gamification-store';
import { CoffeeSpillCorner, type SpillCornerPhase } from './CoffeeCup';

/**
 * A lata do pane focado. Ao ganhar foco ela abre com estalo; quando o XP do
 * perfil sobe (turno entregue, handoff aceito…) ela reaparece e dá um gole
 * com o "+N XP". Cada cena é CSS finito; no fim o SVG sai do DOM — sem rAF,
 * sem intervalo, sem re-render do pane (o estado mora só aqui).
 *
 * Gole só com o pane visível, a janela visível e fora do modo sóbrio, e no
 * máximo um por SIP_COOLDOWN_MS: rajadas de turnos não viram metralhadora.
 */

export const SIP_COOLDOWN_MS = 6_000;

interface CanScene {
  readonly phase: SpillCornerPhase | 'rest';
  readonly key: number;
  readonly xp: number | null;
}

interface PaneEnergyCanProps {
  /** O pane está na viewport (IntersectionObserver do PaneLeaf). */
  visible?: boolean;
  /** Relógio injetável (testes); padrão Date.now. */
  now?: () => number;
}

export function PaneEnergyCan({ visible = true, now = Date.now }: PaneEnergyCanProps) {
  const [scene, setScene] = useState<CanScene>({ phase: 'open', key: 0, xp: null });
  const visibleRef = useRef(visible);
  const lastSceneAt = useRef(0);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    // A abertura conta como cena: o primeiro gole espera o resfriamento.
    lastSceneAt.current = now();
    return useGamificationStore.subscribe((state, previous) => {
      if (state.sober || state.snapshot === previous.snapshot) return;
      const gained = xpGain(previous.snapshot, state.snapshot);
      if (!gained) return;
      if (!visibleRef.current || document.visibilityState === 'hidden') return;
      const at = now();
      if (at - lastSceneAt.current < SIP_COOLDOWN_MS) return;
      lastSceneAt.current = at;
      setScene((current) => ({ phase: 'sip', key: current.key + 1, xp: gained }));
    });
  }, [now]);

  if (scene.phase === 'rest') return null;
  return (
    <CoffeeSpillCorner
      key={scene.key}
      className="spill-corner--live"
      phase={scene.phase}
      xpLabel={scene.xp ? `+${fmt(scene.xp)} XP` : null}
      onDone={() => setScene((current) => ({ ...current, phase: 'rest' }))}
    />
  );
}
