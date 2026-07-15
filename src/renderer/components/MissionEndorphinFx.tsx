import { useCallback, useEffect, useRef, useState } from 'react';
import type { MissionStatus } from '../../shared/orch-types';
import {
  handoffEndorphin,
  missionEndorphinForTransition,
  type MissionEndorphinKind,
} from '../../shared/mission-endorphin';
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
  kind: MissionEndorphinKind;
  kicker: string;
  label: string;
}

const CELEBRATING_KINDS: ReadonlySet<MissionEndorphinKind> = new Set([
  'green',
  'launched',
  'milestone',
  'handoff',
]);

let seq = 0;

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function MissionEndorphinFx() {
  const missions = useOrchStore((s) => s.missions);
  const handoffs = useOrchStore((s) => s.handoffs);
  const sober = useGamificationStore((s) => s.sober);
  const snapshot = useGamificationStore((s) => s.snapshot);
  const pushToast = useToastStore((s) => s.push);
  const prev = useRef<Map<string, MissionStatus>>(new Map());
  const seenHandoffs = useRef<Set<string> | null>(null);
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

  const fireBurst = useCallback(
    (kind: MissionEndorphinKind, kicker: string, label: string) => {
      if (sober || kind === 'failed') return;
      const id = ++seq;
      setBurst({ id, kind, kicker, label });
      if (dismissRef.current !== null) window.clearTimeout(dismissRef.current);
      dismissRef.current = window.setTimeout(
        () => setBurst((b) => (b?.id === id ? null : b)),
        BURST_MS,
      );
    },
    [sober],
  );

  useEffect(() => {
    const before = prev.current;
    const next = new Map<string, MissionStatus>();
    for (const m of missions) {
      next.set(m.id, m.status);
      const prior = before.get(m.id);
      const hit = missionEndorphinForTransition(prior, m);
      if (!hit) continue;
      pushToast(hit.kind === 'failed' ? 'warn' : 'success', hit.kicker, hit.label);
      fireBurst(hit.kind, hit.kicker, hit.label);
    }
    prev.current = next;
  }, [missions, pushToast, fireBurst]);

  useEffect(() => {
    // First render just seeds the baseline — never celebrate the backlog.
    if (seenHandoffs.current === null) {
      seenHandoffs.current = new Set(handoffs.map((h) => h.id));
      return;
    }
    const seen = seenHandoffs.current;
    for (const h of handoffs) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      const hit = handoffEndorphin({
        status: h.status,
        agentName: h.fromAgent ?? 'worker',
        summary: h.summary,
      });
      if (!hit) continue;
      pushToast('success', hit.kicker, hit.label);
      fireBurst(hit.kind, hit.kicker, hit.label);
    }
  }, [handoffs, pushToast, fireBurst]);

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
          mood={CELEBRATING_KINDS.has(burst.kind) ? 'celebrating' : 'idle'}
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
