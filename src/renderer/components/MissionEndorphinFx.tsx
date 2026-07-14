import { useEffect, useRef, useState } from 'react';
import type { MissionStatus } from '../../shared/orch-types';
import { missionEndorphinForTransition } from '../../shared/mission-endorphin';
import { useOrchStore } from '../state/orch-store';
import { useGamificationStore } from '../state/gamification-store';
import { useToastStore } from '../state/toast-store';
import { ChosenPetPortrait } from './ChosenPetPortrait';

/**
 * Celebração de missão no path feliz — Luz Verde / concluída / falha.
 * Overlay leve; respeita modo sóbrio e prefers-reduced-motion.
 */

const BURST_MS = 2_400;

interface Burst {
  id: number;
  kind: 'green' | 'done' | 'failed';
  kicker: string;
  label: string;
}

let seq = 0;

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function MissionEndorphinFx() {
  const missions = useOrchStore((s) => s.missions);
  const sober = useGamificationStore((s) => s.sober);
  const snapshot = useGamificationStore((s) => s.snapshot);
  const pushToast = useToastStore((s) => s.push);
  const prev = useRef<Map<string, MissionStatus>>(new Map());
  // DOM timer id is `number` — not NodeJS.Timeout (tsc DOM vs @types/node).
  const dismissRef = useRef<number | null>(null);
  const [burst, setBurst] = useState<Burst | null>(null);

  useEffect(() => {
    return () => {
      if (dismissRef.current !== null) {
        window.clearTimeout(dismissRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const before = prev.current;
    const next = new Map<string, MissionStatus>();
    for (const m of missions) {
      next.set(m.id, m.status);
      const prior = before.get(m.id);
      const hit = missionEndorphinForTransition(prior, m);
      if (!hit) continue;

      if (hit.kind === 'failed') {
        pushToast('warn', hit.kicker, hit.label);
      } else {
        pushToast('success', hit.kicker, hit.label);
      }

      if (!sober && hit.kind !== 'failed') {
        const id = ++seq;
        setBurst({
          id,
          kind: hit.kind,
          kicker: hit.kicker,
          label: hit.label,
        });
        if (dismissRef.current !== null) {
          window.clearTimeout(dismissRef.current);
        }
        dismissRef.current = window.setTimeout(
          () => setBurst((b) => (b?.id === id ? null : b)),
          BURST_MS,
        );
      }
    }
    prev.current = next;
  }, [missions, sober, pushToast]);

  if (sober || !burst) return null;

  const still = reducedMotion();

  return (
    <div
      className={`mission-fx mission-fx--${burst.kind}${
        still ? ' mission-fx--still' : ''
      }`}
      role="status"
      aria-live="polite"
    >
      <span className="mission-fx__pet" aria-hidden="true">
        <ChosenPetPortrait
          size={72}
          mood={burst.kind === 'green' ? 'celebrating' : 'idle'}
          fallbackTier={snapshot.tier}
          fallbackBranch={snapshot.branch}
          fallbackSkin={snapshot.selectedSkin}
        />
      </span>
      <span className="mission-fx__copy">
        <span className="mission-fx__kicker">{burst.kicker}</span>
        <span className="mission-fx__label">{burst.label}</span>
      </span>
    </div>
  );
}
