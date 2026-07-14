import { ChosenPetPortrait } from './ChosenPetPortrait';
import type { OperatorMood } from './OperatorSprite';
import { useGamificationStore } from '../state/gamification-store';

/**
 * Presença viva — pet + kicker. O "hit" visual de companhia nas superfícies
 * de produto (Launch, Home). Não compete com PTY/telemetry.
 */

export function EndorphinPresence({
  kicker,
  mood = 'idle',
  size = 52,
  className = '',
}: {
  kicker?: string;
  mood?: OperatorMood;
  size?: number;
  className?: string;
}) {
  const snapshot = useGamificationStore((s) => s.snapshot);
  return (
    <div className={`endorphin-presence ${className}`.trim()}>
      <ChosenPetPortrait
        size={size}
        mood={mood}
        fallbackTier={snapshot.tier}
        fallbackBranch={snapshot.branch}
        fallbackSkin={snapshot.selectedSkin}
        className="endorphin-presence__pet"
      />
      {kicker ? (
        <span className="endorphin-presence__kicker">{kicker}</span>
      ) : null}
    </div>
  );
}
