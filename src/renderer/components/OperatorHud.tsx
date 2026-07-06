import { useEffect, useRef, useState } from 'react';
import { GAMIFICATION_COPY } from '../../shared/gamification-types';
import { useGamificationStore } from '../state/gamification-store';
import { OperatorSprite, type OperatorMood } from './OperatorSprite';
import { fmt } from './operator-sprite-data';

/**
 * HUD do Operador (WorkspaceBar): mascote 24px + power level + barra até o
 * próximo tier. Compacto por padrão (densidade calma), expande no hover.
 * Reage em tempo real: power "conta" subindo e o mascote celebra por 3s ao
 * entregar. Respeita prefers-reduced-motion e o modo sóbrio (some, XP segue).
 */

const CELEBRATE_MS = 3_000;
const COUNT_MS = 600;

const TIER_ORDER = Object.keys(GAMIFICATION_COPY.tiers);

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Conta do valor anterior ao novo em ~600ms (direto com reduced-motion). */
function useCountUp(target: number): number {
  const [shown, setShown] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    fromRef.current = target;
    if (from === target || reducedMotion()) {
      setShown(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_MS);
      const eased = 1 - (1 - t) ** 3;
      setShown(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

export function OperatorHud() {
  const snapshot = useGamificationStore((s) => s.snapshot);
  const sober = useGamificationStore((s) => s.sober);
  const openProfile = useGamificationStore((s) => s.openProfile);

  const [mood, setMood] = useState<OperatorMood>('idle');
  const prevPower = useRef(snapshot.powerLevel);
  useEffect(() => {
    if (snapshot.powerLevel > prevPower.current) {
      prevPower.current = snapshot.powerLevel;
      setMood('celebrating');
      const id = setTimeout(() => setMood('idle'), CELEBRATE_MS);
      return () => clearTimeout(id);
    }
    prevPower.current = snapshot.powerLevel;
    return undefined;
  }, [snapshot.powerLevel]);

  const shownPower = useCountUp(snapshot.powerLevel);
  if (sober) return null;

  const level = TIER_ORDER.indexOf(snapshot.tier) + 1;
  const progress = snapshot.nextTierAt
    ? Math.min(1, snapshot.powerLevel / snapshot.nextTierAt)
    : 1;
  const stars = snapshot.prestige > 0 ? '★'.repeat(Math.min(snapshot.prestige, 5)) : '';

  return (
    <button
      type="button"
      className="operator-hud"
      onClick={openProfile}
      title="Perfil de Operador"
      aria-label={`Perfil de Operador — nível ${level}, ${GAMIFICATION_COPY.tiers[snapshot.tier]}, poder ${snapshot.powerLevel}`}
    >
      <OperatorSprite
        size={24}
        tier={snapshot.tier}
        branch={snapshot.branch}
        skin={snapshot.selectedSkin}
        mood={mood}
      />
      <span className="operator-hud__power">{fmt(shownPower)}</span>
      <span className="operator-hud__detail">
        LV {level} · {GAMIFICATION_COPY.tiers[snapshot.tier]}
        {stars && <span className="operator-hud__stars">{stars}</span>}
      </span>
      <span className="operator-hud__bar" aria-hidden="true">
        <span
          className="operator-hud__bar-fill"
          style={{ transform: `scaleX(${progress})` }}
        />
      </span>
    </button>
  );
}
