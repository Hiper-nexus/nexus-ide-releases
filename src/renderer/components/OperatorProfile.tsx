import { useEffect, useState } from 'react';
import {
  GAMIFICATION_COPY,
  type GamificationSnapshot,
} from '../../shared/gamification-types';
import { useGamificationStore } from '../state/gamification-store';
import { OperatorSprite } from './OperatorSprite';
import { fmt } from './operator-sprite-data';

/**
 * Perfil de Operador — overlay (padrão SettingsDrawer): identidade do mascote,
 * power/tier/prestígio, breakdown de XP por entrega, eficiência, streak,
 * grid de conquistas, skins e export/import + modo sóbrio. Esc/backdrop fecham.
 */

const XP_BREAKDOWN_COPY: Array<[string, string]> = [
  ['mission_green', 'missões verdes (verificadas)'],
  ['mission_done', 'missões concluídas'],
  ['handoff_green', 'handoffs verificados'],
  ['handoff_success', 'handoffs entregues'],
  ['task_done', 'tasks concluídas'],
  ['media_generated', 'mídias geradas'],
  ['jarvis_action', 'ações da Jarvis no IDE'],
];

const DEFAULT_SKIN_LABEL = 'padrão';

function receive(snapshot: GamificationSnapshot): void {
  useGamificationStore.getState().receive(snapshot);
}

export function OperatorProfile() {
  const open = useGamificationStore((s) => s.profileOpen);
  const close = useGamificationStore((s) => s.closeProfile);
  const snapshot = useGamificationStore((s) => s.snapshot);
  const sober = useGamificationStore((s) => s.sober);
  const setSober = useGamificationStore((s) => s.setSober);
  const [confirmPrestige, setConfirmPrestige] = useState(false);
  const [ioMessage, setIoMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  useEffect(() => {
    if (!open) {
      setConfirmPrestige(false);
      setIoMessage(null);
    }
  }, [open]);

  if (!open) return null;

  const progress = snapshot.nextTierAt
    ? Math.min(1, snapshot.powerLevel / snapshot.nextTierAt)
    : 1;
  const stars = '★'.repeat(Math.min(snapshot.prestige, 5));
  const efficient = snapshot.counters.efficient_mission ?? 0;
  const emptyProfile =
    snapshot.powerLevel === 0 &&
    Object.values(snapshot.counters).every((value) => value === 0);

  const handleExport = async () => {
    const res = await window.nexus.gamification.exportProfile();
    if (res.ok) setIoMessage(`Perfil exportado: ${res.path ?? ''}`);
    else if (res.error) setIoMessage(res.error);
  };

  const handleImport = async () => {
    const res = await window.nexus.gamification.importProfile();
    if (res.ok) setIoMessage('Perfil importado.');
    else if (res.error) setIoMessage(res.error);
  };

  const handlePrestige = async () => {
    receive(await window.nexus.gamification.prestige());
    setConfirmPrestige(false);
  };

  const handleSkin = async (skin: string | null) => {
    receive(await window.nexus.gamification.selectSkin(skin));
  };

  const handleSober = async (value: boolean) => {
    setSober(value);
    await window.nexus.settings.orchSet({ soberMode: value });
  };

  return (
    <div className="operator-profile__backdrop" onClick={close}>
      <section
        className="operator-profile"
        role="dialog"
        aria-modal="true"
        aria-label="Perfil de Operador"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="operator-profile__header">
          <OperatorSprite
            size={96}
            tier={snapshot.tier}
            branch={snapshot.branch}
            skin={snapshot.selectedSkin}
            mood="idle"
          />
          <div className="operator-profile__identity">
            <span className="operator-profile__branch">
              {GAMIFICATION_COPY.branches[snapshot.branch]}
              {stars && (
                <span className="operator-profile__stars" title={`Transcendência ${snapshot.prestige}`}>
                  {stars}
                </span>
              )}
            </span>
            <span className="operator-profile__tier">
              {GAMIFICATION_COPY.tiers[snapshot.tier]}
            </span>
            <span
              className="operator-profile__power"
              title={`${snapshot.powerLevel.toLocaleString('pt-BR')} de poder`}
            >
              {fmt(snapshot.powerLevel)}
            </span>
            <span className="operator-profile__bar" aria-hidden="true">
              <span
                className="operator-profile__bar-fill"
                style={{ transform: `scaleX(${progress})` }}
              />
            </span>
            <span className="operator-profile__next">
              {snapshot.nextTierAt
                ? `próximo marco em ${fmt(snapshot.nextTierAt)}`
                : 'jornada no topo'}
            </span>
          </div>
          <button
            type="button"
            className="operator-profile__close"
            onClick={close}
            aria-label="Fechar perfil"
          >
            ✕
          </button>
        </header>

        {snapshot.prestigeReady && (
          <div className="operator-profile__prestige">
            {confirmPrestige ? (
              <>
                <span>
                  Transcender reinicia a jornada de poder e grava uma estrela
                  permanente. Continuar?
                </span>
                <button
                  type="button"
                  className="operator-profile__btn operator-profile__btn--primary"
                  onClick={handlePrestige}
                >
                  Transcender agora
                </button>
                <button
                  type="button"
                  className="operator-profile__btn"
                  onClick={() => setConfirmPrestige(false)}
                >
                  Cancelar
                </button>
              </>
            ) : (
              <button
                type="button"
                className="operator-profile__btn operator-profile__btn--primary"
                onClick={() => setConfirmPrestige(true)}
              >
                ★ Transcender
              </button>
            )}
          </div>
        )}

        {emptyProfile && (
          <div className="operator-profile__empty" role="status">
            Ainda não há entregas pontuadas. O XP entra quando uma missão ou
            task é concluída, um handoff é entregue com sucesso, ou uma mídia é
            gerada dentro do fluxo.
          </div>
        )}

        <div className="operator-profile__grid">
          <section className="operator-profile__section" aria-label="Breakdown de XP">
            <h3>Entregas</h3>
            <ul className="operator-profile__list">
              {XP_BREAKDOWN_COPY.map(([kind, label]) => (
                <li key={kind}>
                  <span className="operator-profile__count">
                    {snapshot.counters[kind] ?? 0}
                  </span>{' '}
                  {label}
                </li>
              ))}
            </ul>
          </section>

          <section className="operator-profile__section" aria-label="Ritmo e eficiência">
            <h3>Ritmo</h3>
            <ul className="operator-profile__list">
              <li>
                <span className="operator-profile__count">{snapshot.streakDays}</span>{' '}
                dias úteis de streak
              </li>
              <li>
                <span className="operator-profile__count">{snapshot.shieldsLeft}</span>{' '}
                escudos restantes no mês
              </li>
              <li>
                <span className="operator-profile__count">{efficient}</span>{' '}
                missões na banda eficiente
              </li>
            </ul>
          </section>
        </div>

        <section className="operator-profile__section" aria-label="Conquistas">
          <h3>Conquistas</h3>
          <div className="operator-profile__achievements">
            {Object.entries(GAMIFICATION_COPY.achievements).map(([id, copy]) => {
              const unlocked = snapshot.achievements.includes(id);
              return (
                <div
                  key={id}
                  className={
                    unlocked
                      ? 'operator-profile__achievement'
                      : 'operator-profile__achievement operator-profile__achievement--locked'
                  }
                >
                  <span className="operator-profile__achievement-title">
                    {copy.title}
                  </span>
                  <span className="operator-profile__achievement-desc">
                    {unlocked ? copy.description : 'Bloqueada'}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="operator-profile__section" aria-label="Skins">
          <h3>Skins</h3>
          <div className="operator-profile__skins">
            <button
              type="button"
              className={
                snapshot.selectedSkin === null
                  ? 'operator-profile__skin operator-profile__skin--active'
                  : 'operator-profile__skin'
              }
              onClick={() => void handleSkin(null)}
            >
              {DEFAULT_SKIN_LABEL}
            </button>
            {snapshot.skins.map((skin) => (
              <button
                key={skin}
                type="button"
                className={
                  snapshot.selectedSkin === skin
                    ? 'operator-profile__skin operator-profile__skin--active'
                    : 'operator-profile__skin'
                }
                onClick={() => void handleSkin(skin)}
              >
                {skin}
              </button>
            ))}
          </div>
        </section>

        <footer className="operator-profile__footer">
          <button type="button" className="operator-profile__btn" onClick={() => void handleExport()}>
            Exportar perfil
          </button>
          <button type="button" className="operator-profile__btn" onClick={() => void handleImport()}>
            Importar perfil
          </button>
          <label className="operator-profile__sober">
            <input
              type="checkbox"
              checked={sober}
              onChange={(e) => void handleSober(e.target.checked)}
            />
            Modo sóbrio (oculta HUD e celebrações; o XP continua)
          </label>
          <span className="operator-profile__hint">
            Reabra este perfil a qualquer momento com ⌘⇧O (Ctrl+Shift+O).
          </span>
          {ioMessage && (
            <span className="operator-profile__io" role="status">
              {ioMessage}
            </span>
          )}
        </footer>
      </section>
    </div>
  );
}
