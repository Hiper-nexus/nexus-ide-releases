import { useEffect, useState } from 'react';
import { GAMIFICATION_COPY } from '../../shared/gamification-types';
import { tierProgress } from '../../shared/gamification-progress';
import { useGamificationStore, xpGain } from '../state/gamification-store';
import { fmt } from './operator-sprite-data';

/**
 * HUD do Operador no rail: nível, poder, barra DENTRO do tier, XP de hoje e
 * o que falta para o próximo tier. Clica para o perfil. Some antes do primeiro
 * snapshot do main e em modo sóbrio (o XP continua contando).
 *
 * Barato de propósito — fica na tela o dia todo: sem sprite do pet (roda
 * setInterval), sem contagem por rAF. O ganho aparece como um "+N" que sobe
 * e se apaga em CSS, uma vez por broadcast do main.
 */

const TIER_ORDER = Object.keys(GAMIFICATION_COPY.tiers);

interface Gain {
  readonly key: number;
  readonly amount: number;
}

export function OperatorHud() {
  const snapshot = useGamificationStore((s) => s.snapshot);
  const sober = useGamificationStore((s) => s.sober);
  const openProfile = useGamificationStore((s) => s.openProfile);
  const [gain, setGain] = useState<Gain | null>(null);

  useEffect(
    () =>
      useGamificationStore.subscribe((state, previous) => {
        if (state.snapshot === previous.snapshot) return;
        const delta = xpGain(previous.snapshot, state.snapshot);
        if (delta === null) {
          setGain(null);
          return;
        }
        if (delta <= 0) return;
        setGain((current) => ({ key: (current?.key ?? 0) + 1, amount: delta }));
      }),
    [],
  );

  if (sober || !snapshot.projectId) return null;

  const level = TIER_ORDER.indexOf(snapshot.tier) + 1;
  const tierName = GAMIFICATION_COPY.tiers[snapshot.tier];
  const progress = tierProgress(snapshot);
  const todayXp = snapshot.todayXp ?? 0;
  const nextName = progress.nextTier
    ? GAMIFICATION_COPY.tiers[progress.nextTier]
    : 'transcender';
  const left =
    progress.remaining === null
      ? 'topo da jornada'
      : `${fmt(progress.remaining)} p/ ${nextName}`;
  const today = todayXp > 0 ? `+${fmt(todayXp)} hoje` : 'sem XP hoje';

  return (
    <button
      type="button"
      className="operator-hud operator-hud--rail"
      onClick={openProfile}
      title="Perfil de Operador"
      aria-label={`Perfil de Operador — nível ${level}, ${tierName}, poder ${snapshot.powerLevel}, ${today}, ${
        progress.remaining === null ? left : `faltam ${left}`
      }`}
    >
      <span className="operator-hud__head">
        <span className="operator-hud__level" aria-hidden="true">
          Lv {level}
        </span>
        <span className="operator-hud__tier">{tierName}</span>
        <span
          key={`power-${gain?.key ?? 0}`}
          className={
            gain
              ? 'operator-hud__power operator-hud__power--bump'
              : 'operator-hud__power'
          }
        >
          {fmt(snapshot.powerLevel)}
        </span>
        {gain && (
          <span key={gain.key} className="operator-hud__gain" aria-hidden="true">
            +{fmt(gain.amount)}
          </span>
        )}
      </span>
      <span className="operator-hud__bar" aria-hidden="true">
        <span
          className="operator-hud__bar-fill"
          style={{ transform: `scaleX(${progress.ratio})` }}
        />
      </span>
      <span className="operator-hud__meta">
        <span
          className={
            todayXp > 0
              ? 'operator-hud__today operator-hud__today--live'
              : 'operator-hud__today'
          }
        >
          {today}
        </span>
        <span className="operator-hud__left">{left}</span>
      </span>
    </button>
  );
}
