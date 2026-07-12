import { useEffect, useRef, useState } from 'react';
import {
  GAMIFICATION_COPY,
  type GamificationSnapshot,
  type GamificationTier,
} from '../../shared/gamification-types';
import { useGamificationStore } from '../state/gamification-store';
import { ChosenPetPortrait } from './ChosenPetPortrait';
import { fmt } from './operator-sprite-data';

/**
 * Camada de efeitos do Operador — a "suculência" da gamificação. Reage aos
 * deltas do snapshot (o backend continua a fonte de verdade) e injeta:
 *  - toasts "+XP" que sobem e desaparecem a cada ganho de poder;
 *  - um burst de TIER UP / TRANSCENDÊNCIA (anéis, partículas, glitch, sprite
 *    evoluindo) por ~2.6s;
 *  - toasts de CONQUISTA deslizando pela direita.
 * Overlay fixo, `pointer-events:none` — inclusive o véu do burst: um clique
 * durante a celebração cai no terminal, não aqui. Só o núcleo do burst aceita
 * clique (abre o perfil).
 * Respeita prefers-reduced-motion (degrada para um selo estático curto) e o
 * modo sóbrio (não renderiza nada — o XP segue sendo contabilizado).
 */

const TIER_ORDER: GamificationTier[] = [
  'RECRUTA',
  'INICIADO',
  'VETERANO',
  'ELITE',
  'MAESTRO',
  'LENDA',
];

const XP_TOAST_MS = 1_500;
const ACHIEVEMENT_TOAST_MS = 5_200;
const BURST_MS = 2_600;
const PARTICLES = 18;

let fxSeq = 0;
function nextId(): number {
  fxSeq += 1;
  return fxSeq;
}

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface XpToast {
  id: number;
  amount: number;
}

interface AchievementToast {
  id: number;
  title: string;
}

type Burst =
  | { id: number; kind: 'tier'; label: string; tier: GamificationTier }
  | { id: number; kind: 'prestige'; label: string; tier: GamificationTier };

export function OperatorFx() {
  const snapshot = useGamificationStore((s) => s.snapshot);
  const sober = useGamificationStore((s) => s.sober);
  const openProfile = useGamificationStore((s) => s.openProfile);

  const [xpToasts, setXpToasts] = useState<XpToast[]>([]);
  const [achievementToasts, setAchievementToasts] = useState<AchievementToast[]>([]);
  const [burst, setBurst] = useState<Burst | null>(null);

  // Baseline dos deltas. Iniciado no primeiro snapshot para que o hydrate não
  // dispare uma chuva de efeitos ao abrir o app.
  const prev = useRef<GamificationSnapshot | null>(null);

  useEffect(() => {
    const before = prev.current;
    prev.current = snapshot;
    if (!before || sober) return;
    // Troca de workspace (reset→hydrate ou outro projeto) re-sincroniza o
    // baseline SEM efeitos — senão o salto de 0 para o poder real dispararia
    // uma celebração falsa. Só comparamos deltas dentro do mesmo escopo.
    if (before.rootRealPath !== snapshot.rootRealPath) return;

    // Poder subiu → toast "+N".
    const gained = snapshot.powerLevel - before.powerLevel;
    if (gained > 0) {
      const id = nextId();
      setXpToasts((list) => [...list, { id, amount: gained }]);
      window.setTimeout(
        () => setXpToasts((list) => list.filter((t) => t.id !== id)),
        XP_TOAST_MS,
      );
    }

    // Novas conquistas → toast(s) deslizando.
    const fresh = snapshot.achievements.filter(
      (a) => !before.achievements.includes(a),
    );
    for (const achievementId of fresh) {
      const copy = GAMIFICATION_COPY.achievements[achievementId];
      if (!copy) continue;
      const id = nextId();
      setAchievementToasts((list) => [...list, { id, title: copy.title }]);
      window.setTimeout(
        () => setAchievementToasts((list) => list.filter((t) => t.id !== id)),
        ACHIEVEMENT_TOAST_MS,
      );
    }

    // Transcendência (prestígio) tem prioridade sobre tier-up.
    if (snapshot.prestige > before.prestige) {
      const id = nextId();
      setBurst({
        id,
        kind: 'prestige',
        label: GAMIFICATION_COPY.prestigeUp(snapshot.prestige),
        tier: snapshot.tier,
      });
      window.setTimeout(() => setBurst((b) => (b?.id === id ? null : b)), BURST_MS);
      return;
    }

    // Tier subiu → burst.
    const tierUp =
      TIER_ORDER.indexOf(snapshot.tier) > TIER_ORDER.indexOf(before.tier);
    if (tierUp) {
      const id = nextId();
      setBurst({
        id,
        kind: 'tier',
        label: GAMIFICATION_COPY.tiers[snapshot.tier],
        tier: snapshot.tier,
      });
      window.setTimeout(() => setBurst((b) => (b?.id === id ? null : b)), BURST_MS);
    }
  }, [snapshot, sober]);

  if (sober) return null;

  const still = reducedMotion();

  return (
    <div className="operator-fx" aria-hidden="true">
      {(xpToasts.length > 0 || achievementToasts.length > 0) && (
        <div className="operator-fx__stack">
          {xpToasts.map((toast) => (
            <span
              key={toast.id}
              className={`operator-fx__xp${still ? ' operator-fx__xp--still' : ''}`}
            >
              +{fmt(toast.amount)} <em>XP</em>
            </span>
          ))}
          {achievementToasts.map((toast) => (
            <span
              key={toast.id}
              className={`operator-fx__ach${still ? ' operator-fx__ach--still' : ''}`}
            >
              <span className="operator-fx__ach-glyph">▚</span>
              <span className="operator-fx__ach-body">
                <span className="operator-fx__ach-kicker">CONQUISTA</span>
                <span className="operator-fx__ach-title">{toast.title}</span>
              </span>
            </span>
          ))}
        </div>
      )}

      {burst && (
        <div
          className={`operator-fx__burst operator-fx__burst--${burst.kind}${
            still ? ' operator-fx__burst--still' : ''
          }`}
          role="status"
          onClick={() => {
            openProfile();
            setBurst(null);
          }}
        >
          <div className="operator-fx__burst-core">
            <span className="operator-fx__ring operator-fx__ring--1" />
            <span className="operator-fx__ring operator-fx__ring--2" />
            <span className="operator-fx__ring operator-fx__ring--3" />
            {!still && (
              <span className="operator-fx__particles">
                {Array.from({ length: PARTICLES }, (_, i) => (
                  <span
                    key={i}
                    className="operator-fx__particle"
                    style={{
                      // Ângulos distribuídos + leve variação por índice.
                      ['--a' as string]: `${(360 / PARTICLES) * i}deg`,
                      ['--d' as string]: `${90 + (i % 4) * 26}px`,
                      ['--t' as string]: `${40 + (i % 5) * 18}ms`,
                    }}
                  />
                ))}
              </span>
            )}
            <span className="operator-fx__burst-sprite">
              <ChosenPetPortrait
                size={96}
                mood="evolving"
                fallbackTier={burst.tier}
                fallbackBranch={snapshot.branch}
                fallbackSkin={snapshot.selectedSkin}
              />
            </span>
          </div>
          <span className="operator-fx__burst-kicker">
            {burst.kind === 'prestige' ? 'TRANSCENDÊNCIA' : 'TIER DESBLOQUEADO'}
          </span>
          <span className="operator-fx__burst-label" data-text={burst.label}>
            {burst.kind === 'prestige' ? '★ ' : '// '}
            {burst.label}
          </span>
          <span className="operator-fx__burst-power">
            {fmt(snapshot.powerLevel)} <em>PWR</em>
          </span>
        </div>
      )}
    </div>
  );
}
